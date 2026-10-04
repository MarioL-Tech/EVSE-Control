# ESP32: RFID-Allowlist und Modellverriegelung

Die neue Firmware ersetzt den bisherigen **UART-Kommunikationstest** durch
Whitelist-gesteuerte RFID-Toggles und konfigurierten persistierten Start.
**Noch ungeflasht und nicht am realen ESP32 geprüft. ESP32-CI-Erfolg offen.**
Wallboxsteuerung, UART-MQTT-Gateway, HA und GUI-Bedienung werden dadurch nicht
implementiert; die Python-UART-Brücke bleibt unverändert.

## Verhalten

- MFRC522 über SPI, Servo GPIO13, Pi-UART 115200/8N1 mit unveränderten
  [Pins](../docs/pin-connection.md). Servo unabhängig vom Laden:
  0° entriegelt/inaktiv, 90° verriegelt/aktiv, jeweils **angeforderte Position**.
- Maximal 16 erlaubte UIDs mit 4/7/10 Bytes. Unbekannte oder widerrufene Karten
  werden abgelehnt. Aufnahme per vertrauenswürdigem Pi-UART, für genau eine
  Karte in 30 s; Aufnahme bewegt den Servo nie.
- Bei bestätigtem `ENROLL_STARTED` verlangt das Presence-Gate erneut Entfernen:
  Karte entfernen, **nach START 1 s leeres Lesefeld abwarten**, dann bewusst
  auflegen. Mindestens 500 ms saubere Abwesenheitsbeobachtungen sind nötig.
  Eine gehaltene Karte wird durch START nicht Kandidat; wiederholtes START bei
  aktivem Fenster verändert weder Gate noch Frist. Cancel/Ablauf oder eine
  bereits erlaubte Karte schließen das Fenster.
- Auch im Normalbetrieb und beim Boot gehaltene Karten müssen erst entfernt
  werden. Keine Entfernungsannahme aus Selectfehlern, Kollisionen oder SPI-Fehlern.
  Durchgängige Funkerreichbarkeit verhindert erneutes Togglen; eine gestörte
  Funkkopplung kann ohne physischen Sensor Entfernung imitieren. Zusätzlich
  800 ms native Aktionssperre zwischen
  erfolgreichen Toggles, keine künstliche Sperre für den ersten Tap beim Start.

## Persistenz und Bootpolicy

Ein version-/CRC-geprüfter NVS-Blob (`evse-lock` / `state`) speichert Allowlist,
Bootpolicy und zuletzt angeforderten Zielwert. Keine echten UIDs in Git oder
Beispielen. **Keine zugesicherte NVS-Verschlüsselung**, kein automatisches Erase
oder Factoryreset.
Direkte ESP-IDF-NVS-API statt Preferences: eigene Partition `evse_nvs` bei
`0x290000`, Größe `0x6000`, gemäß `partitions.csv` für **4-MB-Boards**. Nur
`ESP_ERR_NVS_NOT_FOUND` zählt als fehlender Eintrag; Init-/Open-/Korruptionsfehler
führen nicht zum Löschen. Arduino-Default-NVS-Autoerase darf keine Credentials
betreffen. Keine SPIFFS-Nutzung: die Stock-Default-SPIFFS-Region überlappt die
neue Securitypartition. Partitionstabelle beim Upgrade aktualisieren, nie
erase-all; Details und Flashkonsistenz im Installationsguide.

| Bootpolicy | Verhalten beim nächsten Neustart |
|---|---|
| `RESTORE` (Default) | Letzten gespeicherten angeforderten Zielwert verwenden |
| `LOCKED` | Immer 90° anfordern |
| `UNLOCKED` | Immer 0° anfordern |

Erster Start mit leerem NVS: **90°, keine Karten, RESTORE**. Policyänderungen
gelten nur beim nächsten Neustart und bewegen den Servo nicht jetzt.
Startup-Storefehler (`UNAVAILABLE`, `CORRUPT`, `WRITE`) fordern verriegelt an
und verweigern Management-/Kartenänderungen. Runtime-Schreibfehler
fordern **LOCKED/90°** an, brechen Enrollment ab und sperren weitere Änderungen
bis zum Neustart. Das Fallback kann bei Schreibfehler nicht gespeichert werden;
ein folgender RESTORE-Start liest den letzten tatsächlich gültigen dauerhaften
Blob und kann ein anderes Ziel laden. Speicherung erfolgt vor Erfolgsmeldung
und normalem Servotoggle. Ein ungewisser Schreibausgang kann nach Neustart
trotzdem angewendet werden.

## Sicherheitsgrenzen

UIDs sind klonbar und keine kryptografische Authentifizierung. Ein SG90 ist ein
Modellservo, keine zertifizierte physische Diebstahlsicherung. Es gibt keinen
mechanischen Positionssensor und keine Zusage von Sicherheit bei Stromverlust.
`SPI_OK`/`PWM_OK` sind Diagnosen, keine Bestätigung von RFID-/Mechanikfunktion.

Der physische UART vertraut dem Pi: ein bösartiger Pi kann aufnehmen oder die
Bootpolicy ändern. Management nicht an anonyme MQTT-Topics oder das derzeit
lesende HTTP-Weboverlay anschließen; spätere Weiterleitung muss geschützt,
authentifiziert und autorisiert sein. `CMD:CHARGE:ON/OFF` spiegelt nur den
ESP32-Zustand, keine reale ABB-Ladefreigabe. Kein direkter Servo-Unlock-Befehl.
Normale RFID-Aktionen enthalten keine UID; nur erfolgreiche Enrollmentantworten
geben sie am Pi-UART aus, USB redigiert sie. Der alte allgemeine UID-Event entfällt.

## Build, Flash und Prüfung

Gepinnte Toolchain: `espressif32@6.9.0`, Framework `3.20017.0` (Arduino 2.0.17),
MFRC522 `1.4.11`. Keine ESP32Servo-Abhängigkeit: native Arduino-2-LEDC-PWM.
Kalibrierungsbaseline: 544 µs bei 0°, 1472 µs bei 90°, Bereich 544–2400 µs
(Referenz: ESP32Servo 1.1.2 Defaultmapping, keine Hardwarekalibrierung).
Timer/Duty werden **vor GPIO-Anbindung** gesetzt; mechanische Freigängigkeit
und reale Position müssen vor Ort geprüft werden. `PWM_OK` ist kein Nachweis
dieser Position. Ein Write-before-attach über die entfernte Servo-Bibliothek
wäre kein wirksamer Startschutz gewesen.

Reproduzierbare Befehle und Upgrade-/Hardwaretestablauf stehen zentral im
[Installationsguide](../docs/installation.md#esp32-bauen-und-flashen).
Der vorgesehene Docker-Image-Build führt native Tests und den vollständigen
PlatformIO-Zielcompile aus; Ergebnis/CI sind noch zu bestätigen.
Das finale Image enthält nur Artefakte, **keinen PlatformIO-Flashruntime**.
Der gesonderte opt-in Docker-Target `flash` benötigt lokalen, eindeutig
identifizierten ESP32-USB-Zugang; Befehle und Grenzen stehen im Guide.
Flashen mit vorhandenem VS Code/PlatformIO auf dem Entwicklungsrechner benötigt
USB-Zugang vor Ort; kein bestätigter Agent-/Remote-Flashzugang. Kein PlatformIO
oder andere Projektpakete auf dem Pi installieren.

- [Vollständiger UART-Vertrag](../docs/uart-protocol.md)
- [Tests und Aussagegrenzen](test/README)
