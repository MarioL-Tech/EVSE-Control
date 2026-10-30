# UART-Protokoll — ESP32 ↔ Raspberry Pi

Kabelgebundenes ASCII-Protokoll: **115200 Baud, 8N1**, unveränderte
[Pins](pin-connection.md). Die frühere Firmware war ein UART-Kommunikationstest.
Die neue Whitelist-/Persistenzimplementierung ist noch **ungeflasht und nicht am
realen ESP32 verifiziert**. Einrichtung: [Installationsguide](installation.md#6-optionale-esp32-uart-testbrücke).

## Rahmen und Vertrauensgrenze

- Maximal 192 druckbare ASCII-Bytes Nutzzeile; Abschluss LF oder CRLF.
  Befehle sind exakt und groß-/kleinschreibungssensitiv, ohne Zusatzleerzeichen.
- Absolute Frist: 2 s ab erstem Framebyte, nicht durch weitere Bytes verlängerbar.
  Ungültige, zu lange oder abgelaufene Frames werden bis einschließlich nächstem
  LF verworfen; danach beginnt ein neuer Frame.
- Management ist ausschließlich für den **vertrauenswürdigen Pi am physischen
  UART** vorgesehen. Keine Protokollauthentifizierung/Verschlüsselung; ein
  kompromittierter Pi kann Karten aufnehmen oder die Bootpolicy ändern.
- Die Python-Testbrücke bleibt unverändert: `status`, `on`, `off` werden
  übersetzt, sonstige Eingaben als rohe Zeilen weitergereicht.
  UART-MQTT-Gateway und Webbedienung bleiben geplant; ein eigenes
  Home-Assistant-Modul ist nicht vorgesehen.
  Keine Weiterleitung über anonyme MQTT-Befehlstopics oder das aktuell rein
  lesende HTTP-Weboverlay; spätere Routen benötigen Authentifizierung und
  geschützte, autorisierte Befehlsweiterleitung.

## Pi → ESP32

| Exakter Befehl | Wirkung |
|---|---|
| `CMD:STATUS` | Ladezustand, angeforderte Servoposition und Security-Status abfragen |
| `CMD:CHARGE:ON` / `CMD:CHARGE:OFF` | Nur lokalen Ladezustand spiegeln; keine reale Wallboxsteuerung |
| `CMD:RFID:ENROLL:START` | 30-s-Fenster für genau eine frisch präsentierte Karte öffnen |
| `CMD:RFID:ENROLL:CANCEL` | Aufnahmefenster schließen |
| `CMD:RFID:REVOKE:<uid>` | Genau diese UID aus der Allowlist entfernen |
| `CMD:ANTITHEFT:BOOT:RESTORE` | Beim nächsten Neustart letzten gespeicherten angeforderten Servozielwert verwenden |
| `CMD:ANTITHEFT:BOOT:LOCKED` | Beim nächsten Neustart immer verriegelt starten |
| `CMD:ANTITHEFT:BOOT:UNLOCKED` | Beim nächsten Neustart immer entriegelt starten |

`<uid>` ist ein **Platzhalter**, keine wörtliche Eingabe: 4, 7 oder 10 Bytes,
je zwei Hexzeichen pro Byte, mit Doppelpunkten getrennt. Hexeingabe akzeptiert
Groß-/Kleinbuchstaben; Ausgabe verwendet Großbuchstaben. Keine echten UIDs in
Git, Beispielen, Scripts oder geteilten Screenshots/Logs speichern.
Legacy-Befehle enthalten keinen direkten Servo-Setzbefehl; der neue, unten
beschriebene Gatewayvertrag erlaubt explizites Setzen. Die Änderung der
Bootpolicy bewegt ihn weiterhin nicht sofort, sondern gilt erst beim nächsten Neustart.

## Gateway-RPC Version 2 (Firmware vorbereitet, Pi-Gateway separat)

Manuelles `LOCK`/`UNLOCK` ist jetzt autorisiert: **expliziter persistierter
Zielwert**, kein Toggle, unabhängig vom Laden. GPIOs, 188-Byte-NVS-Format,
Karten, Bootpolicy und RFID-Präsentationsregeln bleiben unverändert. Kein
MQTT-Stack auf dem ESP32. Die Website-/MQTT-/Pi-Implementierung ist nicht Teil
dieser Firmwareänderung; reale Hardware/Flash/SSH wurden nicht ausgeführt.

`<id>`, `<session>` und `<lease>` bestehen jeweils aus exakt **32 kleinen
Hexzeichen**. IDs sind pro Anfrage neu zu wählen, nicht wiederzuverwenden.
`<uid>` bleibt das oben beschriebene Format. Exakte Zeilen (Alternativen mit `|`):

```text
CMD:GATEWAY:HELLO:<id>
EVSE:GATEWAY:HELLO:<id>:<session>:2

CMD:GATEWAY:<id>:<session>:STATUS
EVSE:STATUS:CHARGING:ON|OFF|UNKNOWN:SRC:query
EVSE:STATUS:ANTITHEFT:ACTIVE|INACTIVE:SRC:query
EVSE:STATUS:SECURITY:... (unverändertes vollständiges Format unten)
EVSE:GATEWAY:RESULT:<id>:<session>:STATUS:OK:<lease>:8

CMD:GATEWAY:<id>:<session>:<lease>:LOCK
CMD:GATEWAY:<id>:<session>:<lease>:UNLOCK
CMD:GATEWAY:<id>:<session>:<lease>:ENROLL
CMD:GATEWAY:<id>:<session>:<lease>:CANCEL
CMD:GATEWAY:<id>:<session>:<lease>:REVOKE:<uid>
CMD:GATEWAY:<id>:<session>:<lease>:MIRROR:ON|OFF|UNKNOWN
EVSE:GATEWAY:RESULT:<id>:<session>:<OP>:<FIXED_RESULT>
```

- `STATUS` braucht keine Lease. Es gibt zuerst alle drei Legacy-Statuszeilen
  aus, danach die korrelierte ACK mit einer **einmaligen 8-s-Lease**. Das ist ein
  synchroner Firmwarezustand, keine neue Wallboxmessung und keine physische
  Servobestätigung. Ereignisse können außerhalb dieses Dreierblocks auftreten;
  ein RPC-Duplikat gibt nur die gecachte ACK zurück, **keinen neuen Snapshot**.
- Maximal acht Leases und acht Cacheeinträge, ausschließlich statische Puffer.
  Volle Kapazität ergibt `BUSY`; lebende Einträge werden nie verdrängt. HELLO
  und STATUS belegen ebenfalls Cacheplätze. Eine gültige Lease wird **vor**
  Argumentprüfung, Kapazitätsprüfung und Ausführungsversuch verbraucht, auch
  bei Fehlern. Falsche Bootsession und erkannte ID-Duplikate führen dagegen
  niemals zu einem neuen Ausführungsversuch/Leaseverbrauch.
- Die Lease ist ein bootlokaler, monotoner 64-Bit-Zähler als 32-Hex-Feld
  (führende Nullen), ausschließlich zusammen mit der zufälligen Bootsession
  gültig. Keine Wiederverwendung nach Ablauf/Verbrauch/Cachebereinigung;
  Zählererschöpfung liefert `BUSY`, keinen Wrap. Bei `Alter >= 8000 ms` ungültig.
  IDs und Leases sind **keine Authentifizierung** des physischen Pi.
- Cache: maximal acht vollständige Request-/ACK-Paare, Ablauf nach 10 s ab
  Aufnahme. Mutationseinträge bleiben damit mindestens bis Leaseablauf + 2 s.
  Nur abgelaufene Einträge werden freigegeben. Gleiche ID + bytegleiche Anfrage
  liefert die identische ACK, ohne NVS/Servo/Enroll-/Mirror-Timer erneut zu ändern.
  Andere Anfrage mit noch gecachter ID: `DUPLICATE_MISMATCH`. Eine gecachte
  STATUS-ACK verlängert ihre Lease nicht. Eine alte Lease bleibt nach
  Cacheablauf ungültig. Bei vollem Cache kann die ablehnende BUSY-Antwort nicht
  selbst gecacht werden; ebenso werden Header-/Sessionfehler vor Admission
  nicht aufgenommen. Solche Ablehnungen führen nie zu einer Mutation.
  Das Pi-Gateway darf **nicht automatisch wiederholen**:
  bei ungewissem Ergebnis neu STATUS lesen, keine neue Mutation erfinden.
- `LOCK`/`UNLOCK`: schließen das Aufnahmefenster, fordern erneut Kartenentfernung,
  speichern einen geänderten Zielwert **vor** Servoausgabe/ACK. Bereits gleicher
  Zielwert ist idempotent, ohne NVS-Schreiben. Speicher-/PWM-Fehler verweigern
  die Aktion; Speicherfehler verlangen wie bisher LOCKED, ohne Persistenzzusage.
  `ENROLL` startet nur bei bereitem Store/Reader/PWM; wiederholtes aktives ENROLL
  verlängert weder Fenster noch verändert es das Gate. `CANCEL` und `REVOKE`
  bewegen den Servo nicht (ausgenommen bestehendes Speicherfehler-Fallback).
- Keine neue RPC-Antwort enthält eine UID; gatewaygestartete Kartenaufnahme
  liefert auch beim späteren Kartenereignis keine UID. Nur bewusst **legacy**
  gestartete Aufnahme darf weiterhin die bisherige UART-UID-Zeile senden.
  Der künftige Pi-Gateway muss solche Legacy-UID-Zeilen immer verwerfen, niemals
  nach USB/MQTT/HTTP weiterleiten. USB enthält auch bisher keine UID.
- `<OP>` ist `HELLO`, `STATUS`, `LOCK`, `UNLOCK`, `ENROLL`, `CANCEL`, `REVOKE`,
  `MIRROR` oder bei unbekannter Operation das feste `INVALID`, niemals Eingabeecho.
  Gemeinsame RPC-Fehler: `INVALID_ARGUMENT`, `INVALID_LEASE`, `SESSION_MISMATCH`,
  `DUPLICATE_MISMATCH`, `BUSY`, `GATEWAY_UNAVAILABLE`.
  LOCK/UNLOCK: `LOCKED`/`UNLOCKED`, `NOT_READY`, `STORAGE_ERROR`.
  ENROLL: `ENROLL_STARTED`, `ENROLL_ACTIVE`, `FULL`, `NOT_READY`.
  CANCEL: `ENROLL_CANCELLED`, `ENROLL_INACTIVE`, `NOT_READY`.
  REVOKE: `REVOKED`, `NOT_FOUND`, `NOT_READY`, `STORAGE_ERROR`. MIRROR: `OK`.
  Nicht korrelierbare/ungültige Header liefern `EVSE:ERROR:INVALID_ARGUMENT`;
  HELLO bei deaktiviertem Gateway `EVSE:ERROR:GATEWAY_UNAVAILABLE`.

### Bootsession und Entropiegrenze

Beim Start **vor** NVS-/SPI-/PWM-/UART-Initialisierung aktiviert der Adapter
`bootloader_random_enable()` (ESP-IDF 4.4/Arduino 2, `bootloader_random.h`),
liest einmal 16 Bytes mit `esp_fill_random()` (`esp_system.h`) und deaktiviert
die Quelle mit `bootloader_random_disable()`. Das aktiviert laut ESP-IDF die
interne SAR-ADC-Entropiequelle auch ohne WiFi/Bluetooth; kein Zeitseed,
Software-PRNG oder stiller Fallback. ADC/I2S/WiFi dürfen währenddessen nicht
konkurrierend verwendet werden. Diese Firmware startet sie dort nicht.

Die APIs liefern **keinen Fehler-/Entropiegütenachweis**. Der Adapter verlässt
sich auf den dokumentierten Hardwarepfad, nicht auf eine erfundene
Erfolgsgarantie. Der reine Kern kann explizit fehlende Entropie ablehnen;
konstante 16-Byte-Ausgaben werden zusätzlich verweigert. Das ist lediglich eine
Plausibilitätsprüfung, **kein statistischer Entropietest** und keine Garantie
gegen Hardwaredefekte oder Sessionkollisionen. Bei verweigerter Initialisierung
bleibt RPC bis zum Neustart deaktiviert, Legacy/RFID und fehlersicherer Boot
bleiben erhalten. Kein nachträgliches Neuseeden. Targetcompile und simulierte
Adapterprüfungen sind in Docker vorgesehen; kein realer Entropie-/Hardwarebeleg.

### Ladezustand ist ein veraltbarer Telemetriespiegel

Initial **UNKNOWN**, niemals erfundenes OFF. `MIRROR` setzt ausschließlich
`ON`/`OFF`/`UNKNOWN`, ohne Servo-, NVS- oder Wallboxwirkung. `CMD:CHARGE:ON/OFF`
bleibt kompatibel und aktualisiert denselben Spiegel. Jeder **neu ausgeführte**
Mirror-/Legacy-Charge-Befehl erneuert den 10-s-Watchdog, auch bei gleichem Wert;
Duplikate und STATUS tun dies nicht. Bei Alter **>= 10 s** wird ein bekannter
Wert einmalig UNKNOWN mit `SRC:watchdog`. Explizites UNKNOWN löscht den bekannten
Wert sofort. `SRC:pi` bleibt für Updates, `query` für Abfragen, `boot` für Start.
Der Pi darf nur tatsächlich frische Wallboxmessungen spiegeln und muss bei
Ausfall UNKNOWN senden; die Lease beweist nur UART-Aktualität, keine Messfrische.
Ladefreigabe darf niemals mit tatsächlichem Laden verwechselt werden.

## ESP32 → Pi

In den folgenden Mustern bedeutet `|` Alternativen, nicht wörtliche Zeichen.

```text
EVSE:STATUS:CHARGING:ON|OFF|UNKNOWN:SRC:boot|pi|query|watchdog
EVSE:STATUS:ANTITHEFT:ACTIVE|INACTIVE:SRC:boot|rfid|pi|query|storage_fault
EVSE:STATUS:SECURITY:STORE:READY|FAULT:FAULT:NONE|UNAVAILABLE|CORRUPT|WRITE:BOOT:RESTORE|LOCKED|UNLOCKED:CARDS:<n>:ENROLL:ON|OFF:READER:SPI_OK|FAULT:SERVO:PWM_OK|FAULT
EVSE:RESULT:<action>:<result>
```

- `CHARGING` ist der lokale Spiegel, keine Bestätigung realen Ladens.
  Boot startet diesen Spiegel mit `UNKNOWN`; unveränderte Ladebefehle erneuern
  nur die Frist, erzeugen aber keine erneute Zustandsänderungsmeldung.
- `ANTITHEFT:ACTIVE` bedeutet **angefordert 90°**, `INACTIVE` **angefordert 0°**.
  Kein mechanischer Positionssensor; eine Statusmeldung bestätigt keine
  tatsächliche Verriegelung. Servo und Wallbox-Laden sind unabhängig.
- `SPI_OK` bestätigt nur SPI-Diagnose, nicht vollständige RFID-Funktion;
  `PWM_OK` bestätigt keine Bewegung oder mechanische Position.
- `<n>` ist die Anzahl gespeicherter Karten (0–16). Bei Storefehlern sind diese
  Angaben nicht als erfolgreich geladene/persistierte Konfiguration zu deuten.
- Aktionen: `ENROLL`, `REVOKE`, `BOOT`, `RFID`. Ergebnisnamen entsprechen
  `resultName()` in `esp32/src/security.cpp`:

| Aktion / Kontext | Ergebniscodes |
|---|---|
| Aufnahmefenster | `ENROLL_STARTED`, `ENROLL_ACTIVE`, `ENROLL_CANCELLED`, `ENROLL_INACTIVE`, `ENROLL_EXPIRED` |
| Kartenaufnahme | `ENROLLED`, `ALREADY_ALLOWED`, `FULL` |
| Entfernen | `REVOKED`, `NOT_FOUND` |
| Bootpolicy | `MODE_CHANGED`, `OK` (bereits eingestellt) |
| Normale Kartenaktion | `LOCKED`, `UNLOCKED`, `DENIED`, `DEBOUNCED` |
| Fehler / gemeinsame Ergebnisse | `NOT_READY`, `STORAGE_ERROR`, `INVALID_UID`, `INVALID_ARGUMENT` |

Nur erfolgreiche Aufnahmeantworten `EVSE:RESULT:ENROLL:ENROLLED` und
`EVSE:RESULT:ENROLL:ALREADY_ALLOWED` enthalten auf dem **Pi-UART** den Zusatz
`:UID:<uid>`. USB-Diagnose redigiert die UID. Normale RFID-Aktionen und
Ablehnungen senden **keine UID**. Die frühere Nachricht
`EVSE:RFID:CARD:UID:<uid>` wurde bewusst entfernt; alte Empfänger anpassen.

Generische Fehler (ohne Echo möglicherweise sensitiver Eingaben):

```text
EVSE:ERROR:UNKNOWN_CMD
EVSE:ERROR:INVALID_ARGUMENT
EVSE:ERROR:NOT_READY
EVSE:ERROR:UART:TOO_LONG
EVSE:ERROR:UART:INVALID
EVSE:ERROR:UART:TIMEOUT
EVSE:ERROR:READER:SPI_FAULT
EVSE:ERROR:RFID:READ
```

## Karten, Persistenz und Fehlerverhalten

- Allowlist: maximal 16 UIDs. Nicht erlaubte und widerrufene Karten werden im
  normalen Betrieb abgelehnt. UIDs sind **keine kryptografische Authentifizierung**
  und können geklont werden.
- Aufnahme dauert maximal 30 s. Bei echtem `ENROLL_STARTED` wird das Presence-Gate
  auf erneutes Entfernen gesetzt: **nach START** mindestens 500 ms sauberes
  leeres Lesefeld beobachten lassen (praktisch: Karte entfernen, bestätigtes
  START abwarten, 1 s leer warten, dann auflegen). Bereits gehaltene Karten
  werden durch START niemals Aufnahme-Kandidaten. Wiederholtes `START` bei
  aktivem Fenster verändert weder Frist noch Gate. Cancel/Ablauf schließen es;
  eine bereits erlaubte Karte schließt es ebenfalls. **Keine Aufnahme toggelt
  den Servo.**
- Vor jeder frischen Präsentation muss die Karte entfernt werden: mindestens
  500 ms saubere Beobachtungen ohne Karte, auch für beim Boot gehaltene Karten.
  Fehlgeschlagene Selektion, Kollision oder SPI-Fehler gelten nicht als Entfernen.
  Nur Chip-TimerIRQ ohne passende Fehlerbits zählt als Abwesenheitsindiz;
  ein Softwarewatchdog-Timeout zählt nicht. Durchgängige Funkerreichbarkeit
  unterdrückt Wiederholungen, gestörte Kopplung kann physisches Entfernen
  jedoch imitieren. Nicht jedes Mehrkartenfeld ist sicher erkennbar; erkannte
  Kollisionen werden blockiert. Zusätzlich gilt eine native
  800-ms-Aktionssperre zwischen erfolgreichen Toggles; der erste Tap nach Start
  hat keine künstliche 800-ms-Wartezeit.
- Ein NVS-Blob in Namespace `evse-lock`, Schlüssel `state`, speichert Allowlist,
  Bootpolicy und angeforderten Zielwert; Version und CRC werden geprüft. Direkte
  ESP-IDF-NVS-API in eigener Partition `evse_nvs` (Offset `0x290000`, Größe
  `0x6000`, 4-MB-Board), nicht Preferences/Arduino-Default-NVS. Nur exaktes
  `ESP_ERR_NVS_NOT_FOUND` gilt als fehlender Eintrag; Init-/Open-/Korruptionsfehler
  dürfen kein Erase auslösen.
  **NVS wird nicht als verschlüsselt zugesichert.** Kein automatisches Löschen
  oder Factoryreset bei Fehlern.
- Erster Start mit leerem NVS: verriegelt (90°), keine Karten, `RESTORE`.
  `RESTORE` lädt den zuletzt gespeicherten **angeforderten** Zielwert;
  `LOCKED`/`UNLOCKED` erzwingen beim Start ihren jeweiligen Zielwert.
- Nicht verfügbarer/defekter Store oder Schreibfehler beim Start: verriegelt,
  Management-/Kartenänderungen verweigert. Schreibfehler im Betrieb:
  **LOCKED/90° wird angefordert**, Aufnahme abgebrochen und
  Fehlerstatus bis Neustart gesetzt. Dieses Fallback kann bei Schreibfehler
  nicht gespeichert werden: nächster RESTORE-Start liest den tatsächlich letzten
  gültigen dauerhaften Blob, dessen Zielwert abweichen kann. Persistieren erfolgt
  **vor** Erfolgsmeldung/normalem Servotoggle. Ein ungewisser Schreibausgang kann
  nach Neustart dennoch angewendet werden.
- Keine Zusicherung physischer Diebstahl- oder Stromausfallsicherheit: ein
  SG90-Modellservo ist keine zertifizierte Diebstahlsicherung.

## Wallbox-Abgrenzung

ABB Terra AC hängt am **Pi**, über USB-RS485, `/dev/ttyUSBEVSEcontrol`, 57600
Baud, 8E1, Slave-ID 9. Der Pi ist Modbus-Master. Der aktuelle Reader liest nur;
Start/Stop und Stromlimitänderungen bleiben geplant. Kein UART-Stromlimitbefehl
ist Teil dieses Vertrags. Der Wallbox-Socket-Lock ist nicht der ESP32-Servo.
