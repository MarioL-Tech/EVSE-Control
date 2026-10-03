# Arbeitskontext für Agents: EVSE-Control

Stand: 2026-10-03. Diese Datei beschreibt den geprüften Repositoryzustand und
die vom Projektinhaber genannten Ziele. Geplante Funktionen sind **nicht** als
bereits implementiert zu behandeln. Mit Mario auf Deutsch kommunizieren.

## Projekt und Ziele

EVSE-Control ist eine Diplomarbeit zur Steuerung und Überwachung einer
Elektrofahrzeug-Ladestation mit RFID-basierter Diebstahlsicherung.
Repository: https://github.com/MarioL-Tech/EVSE-Control

Geplant sind Ladefreigabe und Ladestatus, Erkennung eines angeschlossenen
Fahrzeugs, Energie- und Strommesswerte, Regelung nach verfügbarer Leistung und
Dringlichkeit, Datenbank, Weboverlay sowie eine eigene Home-Assistant-Integration.
Das System soll modular aufgebaut werden; Docker Compose ist eine Option,
aber noch keine getroffene Entscheidung.

## Repository und Quellen

- `esp32/src/main.cpp`: ESP32-Firmware (Arduino/PlatformIO).
- `esp32/include/config.h`: Pins, UART-Baudrate und Servo-/RFID-Konfiguration.
- `esp32/platformio.ini`: ESP32 DevKit, MFRC522 und ESP32Servo als Abhängigkeiten.
- `rasppi/src/main.py`: derzeit interaktive UART-Brücke, kein zentraler Backenddienst.
- `rasppi/requirements.txt`: derzeit nur `pyserial`.
- `docs/setup.md`, `docs/pin-connection.md`, `docs/uart-protocol.md`:
  Aufbau, Verdrahtung und vorhandenes UART-Protokoll.
- `docs/wallbox/`: ABB-Terra-AC-Modbus-Dokumentation und Befehlsreferenz.
- `docs/smartmeter/`: DTSU666-Handbuch.
- `docs/schematic/` und Pinout-Bilder: Hardware-Referenzen.
- `CHANGELOG.md`: Änderungen mit Zeitstempel (Europe/Vienna).

Code beschreibt die aktuelle Implementierung; Hardwarehandbücher beschreiben
Geräteanforderungen. Widersprüche offen benennen. Die Feature-Liste in
`README.md` beschreibt teilweise Visionen (z. B. dynamische Preise,
Solarprognose, Batterieoptimierung, Dashboard), keine fertigen Funktionen.

## Festgelegte Architektur

```text
ESP32 <-> UART <-> Raspberry Pi <-> USB-RS485 / Modbus RTU <-> ABB Terra AC
                         |
                         +-- MQTT <-> Home Assistant / Weboverlay / Dienste (geplant)
                         +-- DTSU666-Messwerterfassung (geplant)
```

- Der Pi ist die zentrale Steuerungsplattform und Modbus-Master.
- Die Wallbox-Schnittstelle ist bereits entschieden: ABB Terra AC über
  USB-RS485, `/dev/ttyUSBEVSEcontrol`, **57600 Baud, 8E1, Slave-ID 9**.
  Die ID 9 gehört zur Wallbox, nicht zum Pi als Master.
- Direkte ESP32-Pi-Kommunikation bleibt kabelgebunden über UART,
  **115200 Baud, 8N1**, Pi-Gerät `/dev/serial0`.
- Für diese direkte Verbindung ist kein WiFi gewünscht; Ethernet-Hardware
  und geeignete zusätzliche Leitungen sind derzeit nicht vorgesehen.
- MQTT ist für die übergeordnete Softwarekommunikation geplant; der Pi soll
  als UART-MQTT-Gateway dienen. UART ist kein MQTT-/TCP/IP-Transport ohne
  zusätzliche Protokollschichten. Ob der Lehrer MQTT auch auf der direkten
  Geräteverbindung verlangt, muss noch geklärt werden.

## Tatsächlich implementiert

### ESP32

- MFRC522 über SPI: SS GPIO5, SCK GPIO18, MOSI GPIO23, MISO GPIO19,
  RST GPIO22; Reader mit 3,3 V versorgen.
- UART RX GPIO16 (vom Pi TX GPIO14, Pin 8), TX GPIO17
  (zum Pi RX GPIO15, Pin 10), gemeinsame Masse (z. B. Pi Pin 6).
  Beide Seiten haben 3,3-V-Logik; keine 5 V an GPIOs anlegen.
- Servo-Signal GPIO13; Versorgung mit 5 V und gemeinsamer Masse,
  nicht über die 3,3-V-Schiene des ESP32.
- Die Diebstahlsicherung startet **inaktiv/entriegelt bei 0°**.
  RFID-Taps toggeln unabhängig vom Laden zwischen 90° (aktiv) und 0°.
- Jede lesbare RFID-Karte kann derzeit toggeln. Es gibt **keine UID-Whitelist**.
  MFRC522 verwendet 13,56-MHz-Karten, keine 125-kHz-Tags.
- Laut Projektinhaber wurde eine Reader-Firmwarekennung `0x82` beobachtet.
  Das ist ein SPI-Diagnosehinweis, kein Nachweis vollständiger RFID-Funktion.
- Ladezustand startet OFF und wird durch Pi-UART-Befehle gespiegelt.
  `applyChargingState()` ist bereits implementiert, steuert aber **keine reale
  Wallbox**. Keine neue ESP32-Wallbox-Schnittstelle als offene Architekturentscheidung
  darstellen: die reale Steuerung soll über den Pi und Modbus erfolgen.

### UART und Pi

Zeilenbasiertes ASCII-Protokoll mit Newline; dokumentiert in
`docs/uart-protocol.md`:

- `CMD:CHARGE:ON`, `CMD:CHARGE:OFF`, `CMD:STATUS`.
- `EVSE:STATUS:CHARGING:ON|OFF:SRC:<quelle>`.
- `EVSE:STATUS:ANTITHEFT:ACTIVE|INACTIVE:SRC:<quelle>`.
- `EVSE:RFID:CARD:UID:<uid>`.
- `EVSE:ERROR:UNKNOWN_CMD:<befehl>`.

Die Schreibweise mit `|` oben bezeichnet Alternativen, keine wörtlichen Nachrichten.
`CMD:STATUS` meldet beide Zustände. Zustandsänderungen und Bootzustände werden
gemeldet. Das Pi-Skript druckt empfangene Zeilen und übersetzt interaktive
Eingaben `on`, `off`, `status`; andere Eingaben werden unverändert gesendet.
Diese Befehle schalten derzeit **nur den ESP32-Zustand**, nicht die Wallbox.

## Geplant / noch nicht implementiert

- Pi-Modbus-Steuerung der ABB Terra AC und zuverlässige Statusauswertung.
- DTSU666-Messwerterfassung und Berechnung verfügbarer Ladeleistung.
- UART-MQTT-Gateway, verbindliche MQTT-Topics und Payloads.
- Home-Assistant-Integration, Weboverlay und Datenbankmodell.
- Ladeautomatisierung nach verfügbarer Leistung und Dringlichkeit.
- Dienst-/Containerstruktur und Entscheidung zu Docker Compose.
- RFID-Berechtigungsliste und weitere Hardware-/Fehlerfalltests.
- Anforderungen mit dem Lehrer sowie Diplomarbeitsanmeldung abstimmen.

Es gibt derzeit keine implementierten Projekttests; `esp32/test/README` ist
ein PlatformIO-Platzhalter. Vorhandene Verdrahtung und berichtete frühere Tests
nicht mit aktuell durchgeführten Hardwaretests gleichsetzen.

## Wichtige Modbus- und Sicherheitsgrenzen

- ABB-Registerwerte und Registerbreiten im Handbuch prüfen. Viele Werte
  belegen zwei 16-Bit-Register; Stromlimit `0x4100` ebenfalls.
- Sessionsteuerung `0x4105`: 0 = Start, 1 = Stop.
  Wallbox-Socket-Lock `0x4103`: 0 = Unlock, 1 = Lock.
  Dieser Wallbox-Lock ist nicht der separate ESP32-Servo.
- Wallbox-Polling-Timeout standardmäßig 60 s: sicher darunter pollen oder
  Timeout passend konfigurieren. Die dokumentierte Empfehlung 30–90 s
  widerspricht am oberen Ende diesem Standardwert; nicht ungeprüft übernehmen.
- Stromlimits unter 6 A pausieren das Laden. Tatsächliches Limit kann wegen
  internem Lastmanagement abweichen; Rückleseregister `0x400E` beachten.
- Socket-Unlock nur ohne laufende Session; Handbuchbedingungen beachten.
- DTSU666 hat eigene Parameter: Handbuch beschreibt u. a. Modbus-Adresse 1,
  9600 Baud, 8N1. Gerätevariante und physische Konfiguration vor Nutzung prüfen;
  nicht mit den Wallbox-Parametern verwechseln. RS485: Klemme 24=A, 25=B.
- Zähler-Messwerte sind laut Handbuch zweiregistrige IEEE754-Floats in ABCD-
  Reihenfolge; Wandlerverhältnisse/Skalierung berücksichtigen.
- Unterschiedliche serielle Geräteeinstellungen nicht ungeprüft auf einen
  gemeinsamen Bus legen. Chint ist nicht in ABBs dokumentierter Liste
  kompatibler Zähler enthalten; geplante Erfassung erfolgt durch den Pi.
- Arbeiten an Netzspannung/Zählerinstallation nur durch qualifiziertes Personal.
  CP/PP-Ladesignale sind keine direkt anschließbaren ESP32-GPIO-Signale.

## Entwicklungsablauf

1. Zuerst `AGENTS.md`, relevante Quellen und `git status` lesen.
2. Vor Änderungen Remote-Stand synchronisieren/prüfen, ohne fremde lokale
   Änderungen zu überschreiben. Keine destruktiven Git-Befehle verwenden.
3. Änderungen auf einem Feature-Branch, nicht direkt auf `main`, durchführen.
4. Nur beabsichtigte Dateien committen; keine Secrets, generierten Dateien
   oder fremden Änderungen aufnehmen.
5. Relevante Tests/Builds und Dokumentation prüfen; nicht ausgeführte oder
   hardwareabhängige Prüfungen ausdrücklich benennen.
6. Bei jeder Code-, Dokumentations- oder Infrastrukturänderung `CHANGELOG.md`
   mit aktuellem Europe/Vienna-Zeitstempel ergänzen, neueste Einträge oben.
7. Pull Request erstellen, sofern im Auftrag vorgesehen und Zugriff vorhanden.
   **Mario führt den Merge selbst durch**, außer er erteilt ausdrücklich eine
   Ausnahme. Commit/Push/PR-Status wahrheitsgemäß berichten.

Historische Commit-/Branch-Angaben aus älteren Zusammenfassungen immer mit Git
prüfen. Ebenso war ein PlatformIO-Build auf NixOS durch die dynamisch gelinkte
Xtensa-Toolchain blockiert; Lösungsoptionen waren `nix-ld`, `patchelf` oder FHS.
Das ist kein bestätigter aktueller Windows-Buildfehler. Betriebssystem und
verfügbare Toolchain jeweils prüfen; ohne Buildlauf keinen Build-Erfolg behaupten.

## Diese Datei regelmäßig aktualisieren

**`AGENTS.md` ist aktiv zu pflegen, kein einmaliger Übergabetext.**

- Bei Änderungen an Architektur, Protokollen, Hardware/Pins, Verhalten,
  Anforderungen, Arbeitsregeln oder bekannten Blockern im selben Arbeitsgang
  den betroffenen Abschnitt aktualisieren.
- Nach abgeschlossenen Entwicklungsabschnitten und vor einer Übergabe den
  gesamten Kontext mit Code und Dokumentation abgleichen.
- Neue Funktionen erst nach tatsächlicher Implementierung von „geplant“ nach
  „implementiert“ verschieben. Veraltete Aussagen entfernen oder klar als
  historisch markieren; keine bloßen Absichten als Tatsachen dokumentieren.
- Das Standdatum bei inhaltlichen Aktualisierungen erneuern und die Änderung
  in `CHANGELOG.md` vermerken. Keine Secrets oder unnötigen lokalen Details
  in dieser Datei speichern.
