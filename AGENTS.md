# Arbeitskontext für Agents: EVSE-Control

Stand: 2026-10-04. Diese Datei beschreibt den geprüften Repositoryzustand und
die vom Projektinhaber genannten Ziele. Geplante Funktionen sind **nicht** als
bereits implementiert zu behandeln. Auf Deutsch kommunizieren.

## Projekt und Ziele

EVSE-Control ist eine Diplomarbeit zur Steuerung und Überwachung einer
Elektrofahrzeug-Ladestation mit RFID-basierter Diebstahlsicherung.
Repository: https://github.com/MarioL-Tech/EVSE-Control

Geplant sind Ladefreigabe und Ladestatus, Erkennung eines angeschlossenen
Fahrzeugs, Energie- und Strommesswerte, Regelung nach verfügbarer Leistung und
Dringlichkeit, Datenbank, Weboverlay sowie eine eigene Home-Assistant-Integration.
Der modulare Aufbau mit Docker-Compose-Komponenten ist ein erklärtes Projektziel.
Festgelegt ist ein gemeinsamer Compose-Einstieg für mehrere spezialisierte
Container. Detailaufteilung und Zusammenführung der heutigen Compose-Dateien
sind noch umzusetzen; diese Umstellung ist ausdrücklich erst später gewünscht.

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
- `esp32/platformio.ini`: ESP32 DevKit (4 MB), gepinnte Arduino-2-/MFRC522-Toolchain;
  Servo über nativen LEDC-Adapter statt ESP32Servo. `esp32/Dockerfile` baut native
  Tests mit Sanitizern und die komplette Firmware; opt-in Flash-Target separat.
- `rasppi/src/main.py`: derzeit interaktive UART-Brücke, kein zentraler Backenddienst.
- `rasppi/requirements.txt`: derzeit nur `pyserial`.
- `rasppi/Dockerfile.uart` und `rasppi/compose.yaml`: interaktive UART-Testbrücke
  mit Python/pyserial ausschließlich im Container, Hardwaregerät durchgereicht.
- `rasppi/wallbox/`: rein lesender C++17-libmodbus-Dienst, Decoder-/JSON-Tests,
  simulierte RTU-Tests, CMake sowie Dockerfile/Compose und Pi-Startanleitung.
- `rasppi/weboverlay/`: lesendes Flask-/Paho-Backend, Browseroberfläche, isolierte
  MQTT-/HTTP- und Frontendtests, Docker/Compose; kein direkter Hardwarezugriff.
- `rasppi/storage/`: MQTT-Collector für vorhandene MariaDB, Schema/Migration,
  typisierte Wallbox-Historie, Docker-only-Tests; keine Steuerung/Hardwareports.
- `docs/pin-connection.md`, `docs/uart-protocol.md`: Pinreferenz und UART-Protokoll.
- `docs/installation.md`: zentrale Anleitung für Installation, Hardware und
  Wiederinbetriebnahme; vereint die frühere Setup-Datei mit dem Docker-only-Ablauf
  inklusive Broker, Netzwerk, Tests und bekannten Einrichtungsgrenzen.
  Die separate `docs/setup.md` wurde entfernt; keine zweite Anleitung parallel pflegen.
  **Jeden neuen Installations-/Konfigurationsschritt dort ebenfalls dokumentieren**;
  Die Einrichtung muss später ohne persönliche Angaben reproduzierbar sein.
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
                         |                   -> Weboverlay (lesend)
                         |                   -> Speichercollector -> vorhandene MariaDB
                         |                   -> HA / weitere Dienste (geplant)
                         +-- UART-MQTT-Gateway (geplant)
                         +-- DTSU666-Messwerterfassung (geplant)
```

- Der Pi ist die zentrale Steuerungsplattform und Modbus-Master.
- Später eine gemeinsame Docker-Compose-Datei für die Pi-Projektdienste:
  ein Start-/Stop-Befehl für mehrere getrennte Container, kein All-in-one-
  Container und kein zusätzlicher Container, der andere Container verwaltet.
  Docker/Compose übernimmt den Containerlebenszyklus; ein geplanter Ladecontroller
  übernimmt ausschließlich die fachliche Ladeautomatisierung über MQTT.
- Vorhandener MQTT-Broker und MariaDB werden weiterhin extern wiederverwendet,
  nicht ersetzt oder beim Stoppen des Projektstacks mit heruntergefahren.
  Aktuell bleiben die einzelnen Dienst-Compose-Dateien unverändert; keine
  Zusammenführung oder Laufzeitumstellung ohne späteren ausdrücklichen Auftrag.
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

- Der Projektinhaber hat keinen direkten physischen Zugang zu Pi oder Wallbox.
  Zugriff auf den Pi erfolgt über WireGuard; SSH-Zugriff ist laut Projektinhaber bereits möglich.
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
- Die frühere Firmware war ein UART-Kommunikationstest (beliebige Karte,
  Start 0°). Neue Firmware: maximal 16 freigegebene UIDs (4/7/10 Bytes) toggeln
  unabhängig vom Laden zwischen 90°/0°. Unbekannte/widerrufene Karten abweisen.
  MFRC522 verwendet 13,56-MHz-Karten, keine 125-kHz-Tags. UIDs sind klonbar;
  Whitelist ist kein kryptografischer Berechtigungsnachweis.
- Startmodus `RESTORE` (Default), `LOCKED`, `UNLOCKED` über vertrauenswürdigen
  Pi-UART konfigurierbar, gilt erst beim nächsten ESP32-Neustart. Neuer leerer
  Store: verriegelt/90°, keine Karten. `RESTORE` lädt letzten gespeicherten
  **angeforderten** Servozielwert. Keine mechanische Rückmeldung, kein zugesicherter
  Schutz bei Stromausfall; Modellservo, keine zertifizierte Diebstahlsicherung.
- Version-/CRC-/semantikgeprüfter 188-Byte-Blob speichert Karten, Policy und Ziel
  zusammen: direkte ESP-IDF-NVS-API, Partition `evse_nvs` (0x290000/0x6000),
  Namespace `evse-lock`, Key `state`. Eigene 4-MB-Partitionstabelle isoliert den
  Store vom Arduino-Default-NVS-Autoerase. Kein automatisches Löschen, kein
  Factoryreset, keine zugesicherte Verschlüsselung. Nur exaktes NOT_FOUND
  initialisiert einen neuen Store; Korruptions-/Lesefehler nicht als Leere behandeln.
- Startup-Storefehler fordern verriegelt an; Laufzeit-Schreibfehler ebenfalls
  LOCKED, beenden Anlernen und sperren Änderungen bis Neustart. Normale Aktionen
  erst nach erfolgreicher Speicherung bestätigen/ausgeben. Fehler-Fallback ist
  nicht sicher persistierbar: nächster RESTORE-Start liest tatsächlich letzten
  gültigen Blob (kann abweichendes Ziel/ungewissen Commitausgang enthalten).
- Anlernen: bewusster START über Pi-UART, 30 s/eine Karte, kein Toggle bei Aufnahme;
  Duplikat schließt Fenster ohne Bewegung, Cancel/Ablauf/Widerruf beendet es.
  Wiederholtes aktives START verlängert nicht und setzt Gate nicht zurück. Nach
  START erneut mindestens 500 ms saubere Leere verlangen, erst dann auflegen.
  Boot-/gehaltene Karten und UID-Wechsel ohne Leere erzeugen keine frische
  Präsentation. WUPA/Selektieren/HALT statt falscher REQA-Entfernungserkennung;
  nur Chip-TimerIRQ ohne Fehler zählt als Abwesenheitsindiz. Poll-Lücken >250 ms,
  Kollisionen/Select-/SPI-/Softwaretimeoutfehler brechen die Serie ab. Funkkopplungs-
  verlust kann physisches Entfernen imitieren; keine Hardware-Anwesenheitsgarantie.
  Zusätzlich 800 ms Aktionssperre, kein künstlicher Startaufschub.
- Native LEDC-PWM auf GPIO13: Defaultmapping-Referenz ESP32Servo 1.1.2,
  544..2400 µs (0°=544, 90°=1472); Zielduty vor GPIO-Anbindung. Pulsform,
  Mechanik/Kalibrierung und tatsächlicher NVS-/Powerloss-Betrieb noch hardwareoffen.
  Firmware aktuell ungeflasht; Docker-CI 37235418853 für 8f98c41 bestätigt
  41 native Sanitizer-Fälle, fünf simulierte Firmwareadapter-Suiten, kompletten
  Xtensa-Targetcompile und Artefakt-/Flash-CLI-Smoke ohne USB/Upload. Prüfhost
  Linux-amd64, keine echte NVS-/SPI-/Servo-/Pi-ARM64-Prüfung. Unabhängige
  Codeprüfung ohne weitere belegte Defekte. Kein Agent-
  Hardwarezugang. Erstupgrade verändert Boot0° auf90° und Partitionstabelle;
  vor Ort sicher koordinieren, kein Erase-All/Stock-SPIFFS-Zugriff.
- Laut Projektinhaber wurde eine Reader-Firmwarekennung `0x82` beobachtet.
  Das ist ein SPI-Diagnosehinweis, kein Nachweis vollständiger RFID-Funktion.
- Ladezustand startet OFF und wird durch Pi-UART-Befehle gespiegelt, steuert
  **keine reale Wallbox**. Keine neue ESP32-Wallbox-Schnittstelle als offene Architekturentscheidung
  darstellen: die reale Steuerung soll über den Pi und Modbus erfolgen.

### UART und Pi

Zeilenbasiertes ASCII-Protokoll mit Newline; dokumentiert in
`docs/uart-protocol.md`:

- `CMD:CHARGE:ON`, `CMD:CHARGE:OFF`, `CMD:STATUS`.
- `CMD:RFID:ENROLL:START`, `CMD:RFID:ENROLL:CANCEL`, `CMD:RFID:REVOKE:<uid>`.
- `CMD:ANTITHEFT:BOOT:RESTORE|LOCKED|UNLOCKED`; kein direkter Servo-Unlock-Befehl.
- `EVSE:STATUS:CHARGING:ON|OFF:SRC:<quelle>`.
- `EVSE:STATUS:ANTITHEFT:ACTIVE|INACTIVE:SRC:<quelle>`.
- `EVSE:STATUS:SECURITY:...` meldet Storefehler, Bootpolicy, Kartenanzahl,
  Anlernfenster sowie SPI-/PWM-Diagnosen (keine mechanische Bestätigung).
- `EVSE:RESULT:<aktion>:<ergebnis>`; UID-Zusatz nur bei erfolgreicher bewusster
  Aufnahme am Pi-UART, nicht in USB-Diagnosen oder gewöhnlichen RFID-Ereignissen.
- Generische `EVSE:ERROR:UNKNOWN_CMD`/`INVALID_ARGUMENT`/`UART:...` ohne Eingabeecho;
  alte allgemeine UID-Nachricht bewusst entfernt. Vertragsdetails im UART-Dokument.

ASCII-Frames maximal 192 Bytes, LF/CRLF, absolute 2-s-Frist; ungültige/abgelaufene
Frames bis LF verwerfen, pro Loop maximal 64 Bytes/ein Befehl. Keine Protokoll-
authentifizierung: physischer UART vertraut dem Pi. Kein anonymes MQTT-/HTTP-
Management; spätere Gateway/HA/Overlay-Bedienung separat geschützt implementieren.
Die Schreibweise mit `|` oben bezeichnet Alternativen, keine wörtlichen Nachrichten.
`CMD:STATUS` meldet drei Statuszeilen. Zustandsänderungen und Bootzustände werden
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
- Der Projektinhaber hat am 2026-10-03 einen erfolgreichen Docker-Einmaltest am realen
  Pi/Wallbox per Screenshot bestätigt: FC03, Slave 9, Block `0x4008..0x401F`,
  `status=ok`, Fehlercode 0, Zustand 1/B1, angeschlossen, nicht ladend,
  Stromlimit 16 A; Spannungen 237,6/234,6/237,2 V. Damit ist FC03 für diesen
  Block an der getesteten Wallbox bestätigt; FC04-Unterstützung anderer Register
  oder die Korrektheit aller Zustände/Messwerte ist dadurch nicht nachgewiesen.
  Langzeitbetrieb, gezielte Fehlerfalltests und Messwertvergleich bleiben offen.
- Der Projektinhaber hat einen kurzen zyklischen Docker-Betrieb protokolliert: 13 Abfragen
  über etwa 25 s, davon 12 erfolgreich und 1 Timeout; beim folgenden Read
  Recovery ohne Eingriff. Stromlimit dort 6 A, Messströme/Leistung 0. Der Reader
  setzt keine Limits; Wechsel von zuvor 16 A wurde nicht vom Reader verursacht,
  seine Ursache ist ungeklärt (z. B. interne Wallbox-Logik oder andere Steuerung).
  Diese Beobachtung nicht als Langzeitstabilität oder unabhängige Messvalidierung ausgeben.
- Der Projektinhaber ordnet die anfänglich fehlende Ausgabe/fehlerhafte Exitcode-Abfrage
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
- Keine Ladefreigabe oder SQL-Anbindung im Reader. MQTT-Empfang am Pi bestätigt; lesende
  Browseroberfläche implementiert, deren Pi-Deploymenttest steht noch aus.

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
- UART-MQTT-Bridge und Steuerbefehle bleiben geplant; Weboverlay abonniert lesend.

### Vorhandener MQTT-Broker und bestätigte Vorbereitung

- Auf dem Pi läuft bereits `elastic_lumiere`, Image `eclipse-mosquitto:alpine`,
  Port 1883 an allen Host-Schnittstellen; ursprünglich Netzwerk `bridge`.
  Reader war beim bisherigen Pi-Test in `wallbox_default`; die neue Compose-
  Version nutzt `evse-mqtt`. Containername ist deploymentabhängig.
- **Diesen Broker wiederverwenden, keinen zweiten starten.** Grafana und MariaDB
  laufen ebenfalls bereits; keine bestehende Infrastruktur ersetzen.
- Der Projektinhaber hat `evse-mqtt` angelegt und den Broker mit Alias `mqtt-broker` verbunden.
  Docker-Testclient über dieses Netzwerk bestätigt `CONNACK (0)` und QoS-1-
  `PUBACK RC:0` für `evse/test` ohne Zugangsdaten. Das bestätigt weder alle ACLs
  noch Subscriber-Zustellung; Authentifizierung/Port-Erreichbarkeit prüfen.
- Netzwerkzuordnung übersteht Neustart desselben Containers, nicht automatisch
  dessen Neuerstellung. Ursprüngliche Broker-Compose-/Config-/Volume-Einrichtung
  ist noch nicht bekannt; keine vollständige Broker-Neuinstallation vortäuschen.
- Der Projektinhaber hat am 2026-10-03 den tatsächlichen Subscriber-Empfang bestätigt:
  15 erfolgreiche Samples von 21:03:18 bis 21:03:46 UTC (23:03:18–23:03:46 Wien),
  alle 2 s, jeweils `availability online`. Zustand B1/angeschlossen/nicht ladend,
  Fehlercode 0, Limit 6 A, Ströme/Leistung 0, Spannungen etwa 233–236 V.
  Bestätigt Wallbox → Reader → vorhandener Broker → Subscriber, nicht
  Langzeitstabilität, gezielte Ausfälle oder unabhängige Messwertvalidierung.

### Rein lesendes Weboverlay

- `rasppi/weboverlay/overlay/`: Flask-API mit Paho-Subscribe-only-Client,
  Gunicorn mit genau einem Worker/vier Threads und mutexgeschütztem Snapshot.
  Kein MQTT-Publish, keine seriellen Geräte oder Start-/Stop-/Limitbefehle.
- Deutsche statische Oberfläche, keine CDN-/Browser-MQTT-Abhängigkeiten.
  Unterscheidet Anschluss, tatsächliches Laden, Wallbox-Limit und noch nicht
  erfassten Gebäudestrom. Unknown/null bleibt unbekannt, nicht „Nein“.
- Dashboard `/` und eigene Diagrammseite `/diagramme` mit gemeinsamer echter
  Navigation, responsivem Layout und automatischem hell/dunklem Farbschema.
  Vier kompakte Übersichtskarten, Phasen/Leistungsrahmen, einklappbare Diagnose.
  Diagramme: vier elektrische Gruppen plus fünf einklappbare Zustands-/Rohwert-
  Gruppen. Status, Frische, Messzeit und aktive Fehlerwarnung bleiben sichtbar.
- `/api/state` liefert Messwerte nur bei verbundenem Broker, gültigem Sample,
  `availability online` und Frische (default 10 s). Ungültige/alte/zu weit
  zukünftige Payloads, Readfehler und Offline blenden Werte aus. Browser lässt
  Werte auch ohne weitere API-Antworten ablaufen. Kein serverseitiger Verlauf/keine Datenbank.
- `/healthz` ist HTTP-Liveness, nicht MQTT-Readiness. Brokerausfall startet
  den Webserver nicht neu. Reconnect verwirft alte Availability/Samples.
- Compose nutzt bestehenden `evse-mqtt`/`mqtt-broker`, Client-ID `evse-weboverlay`
  muss sich vom Reader unterscheiden. Container non-root UID 10001, readonly,
  keine Capabilities. Hostport nur `127.0.0.1:8080`; Zugang via vorhandenem
  SSH-Tunnel über WireGuard, keine Firewall-/SSH-/Netzwerkänderungen.
- Kein HTTP-Login/TLS; nicht öffentlich freigeben. MQTT-Credentials nur Backend,
  optional Passwortdatei mit `compose.auth.yaml`, für UID 10001 lesbar.
- Build/Tests ausschließlich in Docker. CI `37200290345` für `cf7184f` erfolgreich:
  21 Python-/MQTT-/HTTP-Tests, 13 Frontend-Unit- und Chromium-Browsertests,
  gehärtetes Runtime-Image ohne Broker. Desktop-/Mobil-Screenshots mit simulierten
  Werten geprüft; tatsächlicher Pi-Browser-/Deploymenttest bleibt offen.
- Der Projektinhaber hat den Prototyp als `80f2808` auf `main` committed/gepusht. Erster
  Weboverlay-CI-Lauf `37154800334` scheiterte an einer nicht abgeschlossenen
  CSP-Zeichenkette in `overlay/app.py`; Syntax korrigiert und CI erfolgreich.
- Erweiterte Tests prüfen UTF-8-Payloads, API-Feld-Whitelist und parallele HTTP-
  Leser. OS-DNS kann geordneten MQTT-Shutdown verzögern; Prozessfristen gelten,
  es werden dabei keine Hardwareports oder MQTT-Publisher beeinflusst.
- Browser-Codeprüfung: unveränderte Live-Region-Texte werden nicht mehr ständig
  ersetzt; zusätzliche Browser-Regressionen für Timeout/Spätantworten, Visibility/
  Pageshow, Request-Parallelität und Live-Region-Mutationen; erweiterte CI erfolgreich.
- `static/charts.js`: dependency-freie SVG-Zeitverläufe für die 16 Telemetriewerte,
  gruppiert nach Einheit, Bool-/Codewerte als Stufen. Nur auf der Diagrammseite
  erfasste Werte im RAM, maximal 15 Minuten/1200 Messzeitpunkte; Zeitfenster 1/5/15
  Minuten. Kein DB-/MQTT-Verlauf; Neuladen/Seitenwechsel und Wiederherstellung
  aus dem Browser-Seitencache verwerfen Daten. Übersicht sammelt keinen Verlauf.
- Wiederholte API-Samples werden nicht mehrfach gezählt. Bei gleicher Sekunden-
  Zeitmarke werden geänderte Werte nur ohne Ausfall durch den letzten Wert ersetzt.
  Offline/Fehler/Unknown erzeugen Lücken, Pausen >10 s werden nicht verbunden;
  rückwärts springende Browserzeit löscht den Verlauf. Historische Kurven bleiben
  bei Offline sichtbar und sind ausdrücklich nicht als Live-Anzeige bezeichnet.
- „Anzeige auswählen“ schaltet Werte und zugehörige Kurven einzeln; Einstellungen
  lokal im Browser (`evse-display-v1`), keine Messwerte/Credentials im localStorage.
  Nicht verfügbarer Speicher fällt auf aktuelle Sitzung zurück. Status, Messzeit
  und aktive Wallbox-Fehlerwarnung bleiben unabhängig von Auswahl sichtbar.
- Seitenrendering toleriert fehlende seitenspezifische Felder; Auswahl wird
  auf beiden Seiten unter demselben Schlüssel verwendet. Keine neuen MQTT-
  Clients, SQL-Abfragen, Hardwarebefehle oder Netzwerk-/Portänderungen.
- Abschließende Dashboard-CI `37220843434` für `154e7f2` und PR-CI `37221004357`
  erfolgreich: 21 Python-/MQTT-/HTTP-
  und 28 JS-Tests plus drei Chromium-Suiten (beide Seiten, Navigation/Fokus,
  Auswahl/Frische/Warnings, 320/390/768/1440 px, hell/dunkel, blockierter Speicher).
  Desktop-/Mobilbilder mit simulierten Werten geprüft, keine Pi-Bestätigung.
  Codeprüfung ergänzt getestetes Präferenz-Neuladen bei Seitencache-Rückkehr;
  temporäre Auswahl ohne lesbaren Speicher bleibt erhalten. Der Projektinhaber hat PR #33
  als `863c66c` gemergt; echtes Pi-Deployment/Browserprüfung weiterhin offen.
- Erste Diagramm-Docker-CI `37203503188` für `4edb64f` erfolgreich. Codeprüfung
  ergänzt pro Kurve konservative Same-Second-Unknown-Unterbrechungen (beide
  Nachbarsegmente); erweiterte CI `37203627509` erfolgreich. Isolierte Samples
  bekommen sichtbare Punktmarker; kleine Skalen werden nicht auf 0/0 gerundet.
  Abschließende CI `37204010318` für `70b21d7` erfolgreich: 21 Python-Tests,
  27 JS-Tests und beide Chromium-Browsersuiten. Desktop-/Mobil-Diagramme mit
  simulierten Daten geprüft, echte Pi-Anzeige weiterhin offen. Lokale MCP-
  Artefakte bleiben außerhalb Git und werden nicht als Projektdaten behandelt.

### MQTT-Speichercollector / MariaDB

- `rasppi/storage/`: Subscribe-only Paho + PyMySQL, eigener Client `evse-storage`,
  bestehendes `evse-mqtt`. Produktions-Compose enthält nur Collector und expliziten
  Migrations-Client; vorhandene MariaDB extern über konfigurierbares `DB_NETWORK`
  (Default `evse-data`), kein zweiter DB-Server/Broker, keine Hostports/Hardware.
- Schema 1: `evse_wallbox_samples` (typisierte A/V/W/Wh, Nullable-Flags, Readfehler,
  Mess-/Empfangszeit UTC, bereinigtes JSON, erstes Retained-Flag) und
  `evse_ingest_events` (Availability, Verbindungs-/Startup-/Shutdowngrenzen, Gaps).
  Source-Präfix exakt UTF-8 als VARBINARY, Hash-Deduplizierung pro Source.
  Gleiche UTC-Zeit mit geändertem Inhalt bleibt erhalten; Duplikate überschreiben
  weder Empfangszeit noch Werte. Events haben unveränderte UUIDs bei Commit-Retry.
- Kein SQL im MQTT-Callback. Bounded RAM-Queue 256 + ausstehender Record/Gap-Zähler,
  manuelle ACKs erst nach Commit/bestätigtem Duplikat. Generation + Delivery-Version
  schützen auch gegen MID-Wiederverwendung in derselben Verbindung. Ungültige
  Payloads werden bewusst verworfen, Überlauf/DB-Ausfall pausiert nur Collector-MQTT.
- Explizites `--migrate` mit CREATE/SELECT/INSERT-Account; Runtime SELECT/INSERT,
  keine automatische DDL/Löschung. Secrets per Datei, Runtime non-root 10001,
  readonly/cap-drop/tmpfs, Readiness ohne Webserver. SIGTERM versucht 8 s zu drainen;
  Query/DNS kann darüber hinaus verzögern, Compose-Stop 20 s bleibt Prozessgrenze.
- Alte/zukünftige valide Samples werden als Archiv gespeichert, nicht als live
  angeboten. Keine lückenlose Aufzeichnung: retained ist kein Replay, RAM geht
  bei Crash/Restart verloren. Startup-/Gap-Ereignisse markieren unbekannte Abdeckung.
  Keine automatische Aufbewahrungs-/Backup-Policy, RFID/UART/DTSU666 oder SQL-
  Diagrammanbindung. Der Browserverlauf bleibt unverändert im Tab-RAM.
- Docker-CI `37209898185` für `50794db` erfolgreich: 32 Unit- und 7 isolierte
  MariaDB-10.11-/MQTT-Integrationstests sowie non-root/readonly Runtime-Smoke ohne DB.
  Prüft auch defekte bereits registrierte Schemas, eingeschränkte Runtime-Grants,
  Retained/Restart-Deduplizierung, DB-Recovery, ACK-MID-Eigentum und fail-closed
  Secretdateien. Gap-`dropped` zählt Records inklusive Collectorereignisse, nicht
  die Zahl fehlender Hardwaremessungen. Echte Pi-Einrichtung/DB-Empfang offen.
  Vor Deployment konkrete DB-Version, Netzwerke, Accounts/Grants, TLS-Anforderungen
  und vorhandene Backups klären.
- Der Projektinhaber bestätigt am 2026-10-04 per `docker ps`-Screenshot den laufenden MariaDB-
  Container `maria_uno`, Image `mariadb:lts`, Hostport 3306 an IPv4/IPv6 allen
  Schnittstellen. `lts` ist keine konkrete Serverversion; Volume,
  Accounts und tatsächliche Port-Erreichbarkeit/Firewall sind dadurch nicht bestätigt.
  Vorhandenen Container/Volumes beibehalten, keine Port-/Netzwerkänderung ausgeführt.
  Ebenso sind `grafana`, `elastic_lumiere`, Reader und Weboverlay-Container gelistet;
  letzterer bindet 127.0.0.1:8080. Das beweist Containerbetrieb, nicht HTTP-/MQTT-
  Readiness oder korrekte Browserwerte. `deb-mbpoll` ist ebenfalls gelistet; daraus
  keinen tatsächlich laufenden Modbus-Master ableiten, Parallelzugriff weiter vermeiden.
- Zweiter Screenshot: MariaDB ist nur im Standardnetz `bridge`, keine Aliases;
  kein bestätigter DB-Netzzugang für den Collector. `mariadb -u root -p -e
  'SELECT VERSION();'` wurde mit 1045 (`root@localhost`, Passwort verwendet)
  abgewiesen. Ursache/Adminzugang nicht bekannt, kein Reset/Containerneustart.
  Installierte Server-Binary-Version ersetzt nicht den Nachweis erfolgreichen DB-Zugangs.
- Dritter Screenshot: `mariadbd --version` meldet **11.8.8-MariaDB-ubu2404, aarch64**;
  Docker-Volume mit langem generiert wirkendem Namen, Driver `local`, RW nach
  `/var/lib/mysql`. Das ist persistente Datenhaltung, kein Backup-/Restore-Nachweis.
  Volume/Container nicht löschen oder neu initialisieren. Vorhandene Start-/Compose-
  Definition weiter unbekannt. CI `37212624186` für `d30f00f` bestätigt je
  39 Tests + Runtime für 10.11.19, exakt 11.8.8 und 11.8.9 (rollender 11.8-Tag).
  CI ist amd64, kein Pi-ARM64-/Adminzugangs-/Deploymentnachweis;
  keine Änderung am Produktionsserver. Loginfreie Version nicht mit `SELECT VERSION()`
  oder bestätigter Admin-Authentifizierung gleichsetzen.
- Der Projektinhaber meldet am 2026-10-04 **keinen DB-Adminzugang**. Pi-Provisionierung/Migration
  bleibt blockiert; vorhandenen berechtigten Betreiber bzw. ursprüngliche lokale
  Compose-/Env-/Secret-Einrichtung klären. Root-Passwort muss nicht an Projektinhaber/Agent
  gegeben werden: Betreiber kann eigenes EVSE-Schema/least-privilege Accounts
  bereitstellen. Keine weiteren Passwortversuche, Secret-Ausgaben, neue Produktions-
  DB oder Reset ohne separaten Auftrag; gesichertes Recovery wäre eigener Abschnitt.
- Der Projektinhaber hat MariaDB **nicht selbst eingerichtet**. Bestehenden Einrichter/
  berechtigten Betreiber um eigenes EVSE-Schema und passende Accounts bitten,
  nicht selbst fremde Credentials auslesen oder Server-Authentifizierung ändern.
  Root ist kein Pflichtaccount: Provisionierung braucht einen DB-Login mit
  CREATE USER/entsprechendem GRANT-Recht, Migration CREATE/SELECT/INSERT nur im
  eigenen Schema, laufender Collector SELECT/INSERT. SSH-/Dockerzugang allein
  ersetzt SQL-Rechte nicht. Entwicklung/isolierte Tests können unabhängig weitergehen.

## Geplant / noch nicht implementiert

- Dauerbetriebs-/Fehlerfallprüfung und weitere Hardwarevalidierung der ABB-Abfragen sowie
  anschließende Pi-Modbus-Steuerung der ABB Terra AC.
- DTSU666-Messwerterfassung und Berechnung verfügbarer Ladeleistung.
- UART-MQTT-Gateway und dessen Topic-/Payload-Vertrag. Wallbox-Telemetrie ist definiert.
- Home-Assistant-Integration, bedienendes Weboverlay (inklusive modularer Wallbox-
  Einrichtungsfunktion), SQL-Historienabfrage/-Diagrammanbindung und weitere
  Datenmodelle für Ladesessions, UART/RFID und Zählerdaten.
- Ladeautomatisierung nach verfügbarer Leistung und Dringlichkeit.
- Gemeinsamer Compose-Einstieg für getrennte modulare Pi-Projektdienste,
  erst später umzusetzen. Konkrete Dienste/Startabhängigkeiten und kontrollierte
  Migration der bisherigen Einzel-Stacks noch offen; bestehende Infrastruktur
  bleibt extern. Kein Container-Orchestrator im Projekt und kein Docker-Socket-
  Zugriff für den fachlichen Ladecontroller.
- Tatsächliches ESP32-Flashen und Hardware-/Fehlerfallprüfung der neuen
  RFID-Allowlist/Persistenz/LEDC-Startreihenfolge; geschützte HA-/Overlay-Konfiguration
  über das weiterhin geplante UART-MQTT-Gateway.
- Anforderungen mit dem Lehrer sowie Diplomarbeitsanmeldung abstimmen.

Wallbox-Decoder-/Simulationstests stehen unter `rasppi/wallbox/tests/`;
`esp32/tests/` enthält native Core-/UART-Tests und simulierte Firmwareadaptertests,
`esp32/test/README` verweist auf Docker-Test-/Flashablauf. Vorhandene Verdrahtung und
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
   **Der Projektinhaber führt den Merge selbst durch**, außer er erteilt ausdrücklich eine
   Ausnahme. Commit/Push/PR-Status wahrheitsgemäß berichten.

Historische Commit-/Branch-Angaben aus älteren Zusammenfassungen immer mit Git
prüfen. Ebenso war ein PlatformIO-Build auf NixOS durch die dynamisch gelinkte
Xtensa-Toolchain blockiert; Lösungsoptionen waren `nix-ld`, `patchelf` oder FHS.
Das ist kein bestätigter aktueller Windows-Buildfehler. Betriebssystem und
verfügbare Toolchain jeweils prüfen; ohne Buildlauf keinen Build-Erfolg behaupten.

## Diese Datei regelmäßig aktualisieren

### Datenschutz bei Dokumentation und Änderungen

- Keine persönlichen Namen, SSH-Ziele oder Benutzer-Homepfade in neue Beispiele,
  Changelog-Einträge oder Berichte übernehmen; Rollen und Platzhalter verwenden.
- Funktionsrelevante personenbezogene Angaben zuerst melden, nicht ungefragt
  entfernen/ersetzen. Der persönliche Compilerpfad in
  `esp32/.vscode/settings.json` bleibt bis zu einer gesonderten Entscheidung
  unverändert; er betrifft die lokale Editorintegration, nicht die Firmwarelaufzeit.
- Git-Autor-/Committerdaten, historische Dateien und öffentliche Repository-/CI-
  Referenzen sind nicht durch eine Bereinigung des aktuellen Dateistands entfernt.
  Keine Historienumschreibung, Änderung bestehender Commitidentitäten,
  Secretrotation oder Anpassung von Deployment-/Zugangsdaten ohne gesonderten
  Auftrag. Neue Bereinigungscommits ohne persönliche Autorenfelder erstellen,
  ohne globale Git-Konfiguration zu ändern. RFID-UID-Ausgabe erfolgt nur zur
  bewussten Aufnahme am Pi-UART, USB redigiert. Keine echte UID in Code, Chat,
  CI oder Repository hinterlegen; nur private lokale Notiz für Widerruf.
- Herstellerreferenzen/Urheberhinweise nicht mit privaten Projektdaten verwechseln.

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
