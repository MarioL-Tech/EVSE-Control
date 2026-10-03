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
Der modulare Aufbau mit Docker-Compose-Komponenten ist ein erklärtes Projektziel.
Die konkrete Aufteilung der Dienste und Compose-Dateien ist noch festzulegen.

### Konkretisierte Anforderungen (Umsetzungsstand siehe unten)

- Laden identifizieren durch wiederholte Zustandsabfragen („Repeating Request“)
  und den Ladevorgang steuern. Abfrageintervalle und Fehlerbehandlung sind noch
  festzulegen; die Modbus-Timeout-Grenzen beachten.
- System- und Ladezustände in einer Datenbank sichern.
- Home-Assistant-Integration und Weboverlay zur Bedienung bereitstellen.
- Übergeordnete Softwarekommunikation über MQTT mit **demselben Message Broker**
  für alle beteiligten Dienste; Hardwareanbindungen siehe Architekturabschnitt.
- Dienste modular mit Docker Compose betreiben.
- **Strikte Docker-only-Regel auf dem Pi:** Projektsoftware, Build, Tests und
  Abhängigkeiten ausschließlich in Containern. Keine Host-Installation von
  Compiler, CMake, Python-/pip-Paketen, libmodbus, mbpoll oder Mosquitto empfehlen
  oder durchführen. Docker Engine und Compose sind bestehende Voraussetzungen.

Home Assistant und Weboverlay sollen folgende Funktionen anbieten:

- **Bedienung:** AN-/AUS-Button für die Ladefreigabe.
- **Anzeigen:** vorhandener/verfügbarer Strom, tatsächlicher Ladestrom,
  Fahrzeug angeschlossen („Plugged in“), Ladevorgang aktiv („Laden?“).
  Ladefreigabe und tatsächliches Laden als getrennte Zustände behandeln.
- **Automationen:** Laden abhängig vom verfügbaren Strom sowie von einer
  festgelegten Dringlichkeit. Messpunkt/Einheiten des verfügbaren Stroms und
  Definition der Dringlichkeit sind noch zu präzisieren.

Zusätzlich soll das Weboverlay eine **modulare Einrichtungsfunktion mit
Befehlseingabe für Wallboxbefehle** anbieten. Befehlsformat, Validierung und
zulässige Operationen sind noch festzulegen; Gerätegrenzen nicht umgehen.

## Repository und Quellen

- `esp32/src/main.cpp`: ESP32-Firmware (Arduino/PlatformIO).
- `esp32/include/config.h`: Pins, UART-Baudrate und Servo-/RFID-Konfiguration.
- `esp32/platformio.ini`: ESP32 DevKit, MFRC522 und ESP32Servo als Abhängigkeiten.
- `rasppi/src/main.py`: derzeit interaktive UART-Brücke, kein zentraler Backenddienst.
- `rasppi/requirements.txt`: derzeit nur `pyserial`.
- `rasppi/Dockerfile.uart` und `rasppi/compose.yaml`: interaktive UART-Testbrücke
  mit Python/pyserial ausschließlich im Container, Hardwaregerät durchgereicht.
- `rasppi/wallbox/`: rein lesender C++17-libmodbus-Dienst, Decoder-/JSON-Tests,
  simulierte RTU-Tests, CMake sowie Dockerfile/Compose und Pi-Startanleitung.
- `docs/pin-connection.md`, `docs/uart-protocol.md`: Pinreferenz und UART-Protokoll.
- `docs/installation.md`: zentrale Anleitung für Installation, Hardware und
  Wiederinbetriebnahme; vereint die frühere Setup-Datei mit dem Docker-only-Ablauf
  inklusive Broker, Netzwerk, Tests und bekannten Einrichtungsgrenzen.
  Die separate `docs/setup.md` wurde entfernt; keine zweite Anleitung parallel pflegen.
  **Jeden neuen Installations-/Konfigurationsschritt dort ebenfalls dokumentieren**;
  Mario muss die Einrichtung später reproduzieren können.
- `docs/wallbox/`: ABB-Terra-AC-Modbus-Dokumentation und Befehlsreferenz.
- `docs/wallbox/modbusRegisters.txt`: ergänzte Register-/Testnotizen mit Verweis
  auf Handbuch v1.11; das entsprechende PDF liegt derzeit nicht im Repository.
  Die Notizen enthalten Widersprüche, siehe unten; nicht ungeprüft übernehmen.
- `docs/smartmeter/`: DTSU666-Handbuch.
- `docs/schematic/` und Pinout-Bilder: Hardware-Referenzen.
- `CHANGELOG.md`: Änderungen mit Zeitstempel (Europe/Vienna).

Code beschreibt die aktuelle Implementierung; Hardwarehandbücher beschreiben
Geräteanforderungen. Widersprüche offen benennen. `README.md` ist der deutsche
Projekteinstieg mit getrennten Zielen/Implementierungsstand, Architektur und
Docker-only-Schnellstart. Startabschnitte kurz halten; ausführliche Wallbox-
Konfiguration und Betriebshinweise sind in der Dienst-README einklappbar.
Die frühere SmartCharge-Marketingbeschreibung mit
unbelegten Feature-Versprechen wurde entfernt. README bei Änderungen konsistent
halten; laufende Hardwaretests erst nach bestätigten Ergebnissen dokumentieren.

## Festgelegte Architektur

```text
ESP32 <-> UART <-> Raspberry Pi <-> USB-RS485 / Modbus RTU <-> ABB Terra AC
                         |
                         +-- Wallbox-MQTT -> vorhandener Broker
                         |                   -> HA / Weboverlay / Dienste (geplant)
                         +-- UART-MQTT-Gateway (geplant)
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
- MQTT ist für die übergeordnete Softwarekommunikation über einen gemeinsamen
  Message Broker vorgesehen; der Pi soll als UART-MQTT-Gateway dienen.
  UART ist kein MQTT-/TCP/IP-Transport ohne
  zusätzliche Protokollschichten. Ob der Lehrer MQTT auch auf der direkten
  Geräteverbindung verlangt, muss noch geklärt werden.

## Betrieb und Remote-Zugriff

- Mario hat keinen direkten physischen Zugang zu Pi oder Wallbox. Zugriff auf
  den Pi erfolgt über WireGuard; SSH-Zugriff ist laut Mario bereits möglich.
  Das bedeutet nicht, dass ein Agent automatisch SSH-Zugang hat.
- Das Programm soll auf den **Raspberry Pi übertragen und dort ausgeführt**
  werden. Der Pi greift lokal auf USB-RS485/Modbus und ESP32-UART zu; diese
  Hardwareverbindungen werden nicht über WireGuard ersetzt.
- Entwicklung kann lokal erfolgen; Build, Tests und Ausführung der Pi-Dienste
  laufen im Docker-Container. Image-Build auf dem Pi erzeugt passende ARM-Binaries.
  OS-/Hardwarekonfiguration ist davon getrennt und rechtfertigt keine Installation
  von Projektpaketen auf dem Host. Keine Docker-/Netzwerkinstallation ohne Auftrag.
- Verwaltung zunächst über SSH und Logs; später Zugriff auf die auf dem Pi
  bereitgestellte Bedienoberfläche über WireGuard. Der Wallbox-Dienst soll
  unabhängig von einer offenen SSH-Sitzung laufen; Docker Compose bleibt das
  Ziel für den modularen Betrieb.
- Hardwaretests als Remote-Tests planen, zunächst nur lesen. Physische Fehler
  lassen sich remote nur eingeschränkt prüfen. Keine Änderungen an WireGuard,
  SSH oder Netzwerkfreigaben ohne ausdrücklichen Auftrag; keine Zugangsdaten
  im Repository speichern. Hardwarezugriff/Deployment nicht ohne tatsächliche
  Ausführung als erfolgreich melden.

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

### Lesender Pi-Wallbox-Dienst

- `rasppi/wallbox/` implementiert zyklische FC03-Abfragen des Blocks
  `0x4008..0x401F` (24 Rohregister), standardmäßig alle 2 Sekunden.
- Konfigurierbare Geräteadresse, Baudrate, Parität, Slave-ID, Intervall und
  vollständiger Antworttimeout; `--once` für einen einzelnen Test.
- 32-Bit-Big-Endian-Dekodierung, Strom-/Spannungsskalierung und getrennte
  Anschluss-/Ladezustände. Unbekannte Zustände liefern `null` statt „Nein“.
- JSON-Zeilen mit UTC-Zeitstempel und letztem erfolgreichen Messzeitpunkt.
  Kommunikationsfehler liefern `values=null`, der Dienst versucht erneut zu
  verbinden; SIGINT/SIGTERM schließen den Port. Ownership-basierte Freigabe
  stellt auch bei Ausnahmen Port-Einstellungen wieder her und schließt den Port.
  JSON-Ausgabe auf stdout ist unterbrechbar und bei vollen Pipes auf 1 s
  begrenzt; Ausgabefehler beenden den Dienst. Keine Schreibfunktionen.
- CMake-Build und beide Tests bestanden unter Debian/WSL (GCC 14.2,
  libmodbus 3.1.6 und 3.1.11): Decoder/JSON sowie simulierte RTU-Kommunikation über PTY.
  Fehlerfall-, CLI- und Shutdown-Prüfungen sind hardwareunabhängig, einschließlich
  Teilantwort-Timeout, Shutdown während einer Abfrage und blockierter Ausgabe.
- Mario hat am 2026-10-03 einen erfolgreichen Docker-Einmaltest am realen
  Pi/Wallbox per Screenshot bestätigt: FC03, Slave 9, Block `0x4008..0x401F`,
  `status=ok`, Fehlercode 0, Zustand 1/B1, angeschlossen, nicht ladend,
  Stromlimit 16 A; Spannungen 237,6/234,6/237,2 V. Damit ist FC03 für diesen
  Block an der getesteten Wallbox bestätigt; FC04-Unterstützung anderer Register
  oder die Korrektheit aller Zustände/Messwerte ist dadurch nicht nachgewiesen.
  Langzeitbetrieb, gezielte Fehlerfalltests und Messwertvergleich bleiben offen.
- Mario hat einen kurzen zyklischen Docker-Betrieb protokolliert: 13 Abfragen
  über etwa 25 s, davon 12 erfolgreich und 1 Timeout; beim folgenden Read
  Recovery ohne Eingriff. Stromlimit dort 6 A, Messströme/Leistung 0. Der Reader
  setzt keine Limits; Wechsel von zuvor 16 A wurde nicht vom Reader verursacht,
  seine Ursache ist ungeklärt (z. B. interne Wallbox-Logik oder andere Steuerung).
  Diese Beobachtung nicht als Langzeitstabilität oder unabhängige Messvalidierung ausgeben.
- Mario ordnet die anfänglich fehlende Ausgabe/fehlerhafte Exitcode-Abfrage
  einem Windows-Problem beim Befehlsaufruf zu, nicht der Wallbox-Kommunikation.
  Die genaue Windows-Ursache wurde hier nicht unabhängig untersucht.
- Einmaltests mit `docker compose run --rm --no-deps -T --interactive=false
  wallbox-reader --once` ausführen. So werden keine nachfolgenden eingefügten
  Shellzeilen als Containereingabe übernommen. Exitcode-Abfrage bei Bedarf auf
  derselben Shellzeile ausführen; `"$?"` nicht als eigenen Befehl eingeben.
- Docker-only-Anleitungen ersetzen die früheren nativen Host-Build-Schritte.
  Tests laufen automatisch im Multi-Stage-Image-Build. Ein Entrypoint übernimmt
  dieselben Compose-Umgebungsparameter für `--once` und Dauerbetrieb; `WALLBOX_DEVICE`
  ist der Host-Pfad, `/dev/ttyWallbox` der Container-Pfad.
- Nur ein Prozess darf den RS485-Port verwenden; parallel laufendes `mbpoll`
  oder andere Master vermeiden. Die Python-UART-Logik bleibt unverändert,
  ihr unterstützter Startweg ist jetzt `docker compose -f rasppi/compose.yaml
  run --rm --build uart-bridge` aus dem Repository-Hauptverzeichnis.
- Keine Ladefreigabe, Datenbank oder Bedienoberfläche. Der neue MQTT-Publisher
  ist implementiert, aber noch nicht als auf dem Pi getestetes Feature bestätigt.

### MQTT-Publisher im Reader

- `src/mqtt.cpp` verwendet libmosquitto; Netzwerk-/Reconnect-Arbeit läuft getrennt
  von Modbus. Bei Brokerausfall bleiben Reads und JSON-Ausgabe aktiv.
- Topics standardmäßig `evse/wallbox/state` (identische JSON-Samples) und
  `evse/wallbox/availability` (`online`/`offline`), beide retained und QoS 1.
  `online` bedeutet frischer erfolgreicher Read, nicht fehlerfreie Wallbox.
  Readfehler, veraltete Samples, Shutdown und Last Will melden offline.
- Es wird nur der letzte Sample vorgehalten; höchstens eine Zweiergruppe von
  Nachrichten ist ausstehend. Fehlende ACKs führen zum Neuaufbau der Verbindung.
- Compose aktiviert MQTT und bindet ausschließlich das externe `evse-mqtt`
  ein, Alias/Host `mqtt-broker`; Netzwerk und vorhandener Broker müssen vorbereitet sein.
- Konfiguration über `MQTT_ENABLED/HOST/PORT/TOPIC_PREFIX/CLIENT_ID/USERNAME`;
  Passwort optional über `MQTT_PASSWORD` oder bevorzugt `MQTT_PASSWORD_FILE`
  mit `compose.auth.yaml`. Keine Secrets committen; `.env` bleibt lokal.
- Docker-Build enthält isolierte Broker-/PTY-Integrationstests; Tests kontaktieren
  nie den Produktionsbroker. GitHub-Docker-CI mit allen drei Tests inklusive
  Datei-Authentifizierung, abgelehnten Credentials, fehlenden PUBACKs und
  Runtime-Smoke-Test erfolgreich (Run `37153110560`, Commit `1b6f868`).
- Vertrag: `docs/mqtt-protocol.md`; Installationsguide enthält externes Netzwerk
  als Startvoraussetzung, Update-/Subscriber-Test und optionale Passwortdatei.
- Bei aktivem MQTT ist stderr best-effort/nichtblockierend; volle Logpipes
  dürfen den Callback-/Sample-Mutex und damit Modbus nicht blockieren.
  DNS kann Shutdown dennoch verzögern; siehe dokumentierte Fristgrenze im Vertrag.
- UART-MQTT-Bridge, Steuerbefehle und Weboverlay bleiben geplant.

### Vorhandener MQTT-Broker und bestätigte Vorbereitung

- Auf dem Pi läuft bereits `elastic_lumiere`, Image `eclipse-mosquitto:alpine`,
  Port 1883 an allen Host-Schnittstellen; ursprünglich Netzwerk `bridge`.
  Reader war beim bisherigen Pi-Test in `wallbox_default`; die neue Compose-
  Version nutzt `evse-mqtt`. Containername ist deploymentabhängig.
- **Diesen Broker wiederverwenden, keinen zweiten starten.** Grafana und MariaDB
  laufen ebenfalls bereits; keine bestehende Infrastruktur ersetzen.
- Mario hat `evse-mqtt` angelegt und den Broker mit Alias `mqtt-broker` verbunden.
  Docker-Testclient über dieses Netzwerk bestätigt `CONNACK (0)` und QoS-1-
  `PUBACK RC:0` für `evse/test` ohne Zugangsdaten. Das bestätigt weder alle ACLs
  noch Subscriber-Zustellung; Authentifizierung/Port-Erreichbarkeit prüfen.
- Netzwerkzuordnung übersteht Neustart desselben Containers, nicht automatisch
  dessen Neuerstellung. Ursprüngliche Broker-Compose-/Config-/Volume-Einrichtung
  ist noch nicht bekannt; keine vollständige Broker-Neuinstallation vortäuschen.
- Reader-Publisher und Compose-Anbindung sind jetzt implementiert, Deployment-
  und Empfangstest am Pi aber noch offen. Der frühere Broker-Test allein
  bestätigt keine Veröffentlichung von Wallboxdaten durch die neue Version.

## Geplant / noch nicht implementiert

- Dauerbetriebs-/Fehlerfallprüfung und weitere Hardwarevalidierung der ABB-Abfragen sowie
  anschließende Pi-Modbus-Steuerung der ABB Terra AC.
- DTSU666-Messwerterfassung und Berechnung verfügbarer Ladeleistung.
- UART-MQTT-Gateway und dessen Topic-/Payload-Vertrag. Wallbox-Telemetrie ist definiert.
- Home-Assistant-Integration, Weboverlay (inklusive modularer Wallbox-
  Einrichtungsfunktion) und Datenbankmodell zur Zustandsspeicherung.
- Ladeautomatisierung nach verfügbarer Leistung und Dringlichkeit.
- Vollständige modulare Dienst-/Containerstruktur; Reader-Compose nutzt den
  bereits vorhandenen gemeinsamen MQTT-Broker, Gesamtsystem noch offen.
- RFID-Berechtigungsliste und weitere Hardware-/Fehlerfalltests.
- Anforderungen mit dem Lehrer sowie Diplomarbeitsanmeldung abstimmen.

Wallbox-Decoder-/Simulationstests stehen unter `rasppi/wallbox/tests/`;
`esp32/test/README` bleibt ein PlatformIO-Platzhalter. Vorhandene Verdrahtung und
berichtete frühere Tests nicht mit aktuell durchgeführten Hardwaretests gleichsetzen.

## Wichtige Modbus- und Sicherheitsgrenzen

- `mbpoll` bleibt Diagnosewerkzeug. Der neue Reader verwendet die C-Bibliothek
  libmodbus (https://libmodbus.org/) direkt aus C++; das bestehende
  Python-UART-Skript wurde nicht ersetzt. Kein Parsen von mbpoll-Textausgaben.
- Laut ABB-Handbuch v1.7 werden Holding Registers mit Funktionscode 03 gelesen:
  libmodbus `modbus_read_registers()`, bei `mbpoll` Typ `-t 4`.
  Vorhandene Beispiele verwenden teilweise `-t 3` (Input Registers/FC04).
  Tatsächliche Geräte-/Firmwareunterstützung prüfen; Typnummer und Funktionscode
  nicht gleichsetzen. Zum Prüfen zunächst 16-Bit-Rohregister auslesen.
- ABB-Registerwerte und Registerbreiten im Handbuch prüfen. Viele Werte
  belegen zwei 16-Bit-Register; Stromlimit `0x4100` ebenfalls.
- Sessionsteuerung `0x4105`: 0 = Start, 1 = Stop.
  Wallbox-Socket-Lock `0x4103`: 0 = Unlock, 1 = Lock.
  Dieser Wallbox-Lock ist nicht der separate ESP32-Servo.
- Achtung: `modbusRegisters.txt` bestätigt oben 0=Start/1=Stop, dreht diese
  Werte unten aber um. Bis zur Klärung am passenden Herstellerhandbuch keine
  Steuerlogik aus der widersprüchlichen Passage ableiten. Ebenso behauptet die
  Datei Entriegelung unabhängig vom Ladezustand; Sicherheitsbedingungen des
  Herstellerhandbuchs weiter beachten.
- Neue Notizen führen `0x4022` als per Modbus gesetztes Stromlimit auf,
  `0x4024` als Fallback-Limit und `0x4109` zum Setzen des Fallback-Limits.
  Unterstützung anhand Firmware/v1.11-Handbuch prüfen. Der spätere Verweis auf
  `0x4020` als Modbus-Stromlimit widerspricht der Tabelle: `0x4020` ist Timeout.
- Eine Registergröße von 1 bedeutet ein 16-Bit-Wort, nicht ein Byte.
  Ladezustand aus Byte 1, Bits 0–6 des 32-Bit-Wertes dekodieren
  (`(raw >> 8) & 0x7F`); Bit 7 separat behandeln. Zustand 5 („Others“) ist keine
  verlässliche Aussage „Fahrzeug angeschlossen, lädt nicht“.
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
- Alle für Betrieb/Wiederinstallation nötigen Befehle, Voraussetzungen,
  Netzwerk-/Gerätezuordnungen und Änderungen im Installationsguide pflegen.
- Neue Funktionen erst nach tatsächlicher Implementierung von „geplant“ nach
  „implementiert“ verschieben. Veraltete Aussagen entfernen oder klar als
  historisch markieren; keine bloßen Absichten als Tatsachen dokumentieren.
- Das Standdatum bei inhaltlichen Aktualisierungen erneuern und die Änderung
  in `CHANGELOG.md` vermerken. Keine Secrets oder unnötigen lokalen Details
  in dieser Datei speichern.
