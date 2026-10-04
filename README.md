# EVSE-Control

Diplomarbeitsprojekt zur **Steuerung und Überwachung einer Elektrofahrzeug-
Ladestation** mit Raspberry Pi, ESP32 und RFID-basierter Diebstahlsicherung.

Der Raspberry Pi liest eine ABB Terra AC über Modbus RTU aus. Der ESP32
übernimmt RFID und einen separaten Servo als Modell der Diebstahlsicherung.
Geplant sind Ladeautomatisierung und Bedienung über Home Assistant. Ein lesendes
Weboverlay und MQTT-Wallbox-Zustandsspeicherung für MariaDB sind implementiert.

> **Entwicklungsstand:** Der Wallbox-Dienst ist ausschließlich lesend.
> MQTT-Empfang echter Wallboxdaten am Pi ist bestätigt. Das neue lesende
> Weboverlay ist implementiert; Pi-Browser-/Deploymenttest steht noch aus.
> MariaDB-Speicherdienst implementiert und Docker-getestet; Pi-Konfiguration offen.
> Reale Ladesteuerung und bedienende Funktionen fehlen noch.
> ESP32-Whitelist und persistierter Startmodus ersetzen den bisherigen
> UART-Kommunikationstest; neue Firmware noch ungeflasht und hardwareunverifiziert.
> Ein Docker-Einmaltest mit FC03 an der realen Wallbox wurde
> bestätigt; Dauerbetrieb und weitere Hardwarevalidierung stehen noch aus.

## Projektziele

- Ladezustand durch zyklische Abfragen erkennen („Repeating Request“).
- Laden starten/stoppen und nach verfügbarem Strom sowie Dringlichkeit regeln.
- System- und Ladezustände in einer Datenbank speichern.
- Home-Assistant-Integration und Weboverlay mit AN/AUS, verfügbarem Strom,
  Ladestrom, Fahrzeuganschluss und tatsächlichem Ladestatus bereitstellen.
- Weboverlay um eine modulare Einrichtung mit Wallbox-Befehlseingabe erweitern.
- Übergeordnete Softwarekommunikation über MQTT mit **einem gemeinsamen Broker**.
- Pi-Dienste modular und ausschließlich über Docker Compose betreiben;
  später ein gemeinsamer Start-/Stop-Befehl für mehrere spezialisierte Container.

## Was bereits implementiert ist

| Komponente | Aktueller Umfang |
|---|---|
| ESP32-Firmware | MFRC522-RFID, Servo, UART-Befehle und Zustandsmeldungen |
| Diebstahlsicherungsmodell | Erlaubte RFID-UID toggelt 0°/90°; NVS-Allowlist und Bootpolicy; neuer Erststart verriegelt, Hardwareprüfung offen |
| UART-Testbrücke | Interaktive Python-Brücke im Docker-Container |
| Wallbox-Reader | C++17/libmodbus, zyklische FC03-Abfragen, dekodierte Messwerte als JSON |
| MQTT-Publisher | retained State und Verfügbarkeit mit libmosquitto; vorhandener Broker wird wiederverwendet |
| Weboverlay | Lesende MQTT-Anzeige mit wählbaren Messwerten und Browser-Zeitverläufen; Frischeprüfung |
| Zustandsspeicherung | Separater MQTT-Collector für vorhandene MariaDB; Schema/Migration und typisierte Wallbox-Historie |
| Fehlerbehandlung | Timeouts, erneute Verbindung, ungültige Messwerte als `null`, sauberer Shutdown |
| Softwaretests | Decoder-/JSON-Tests und simulierte RTU-Kommunikation einschließlich Fehlerfällen |
| Containerbetrieb | Dockerfiles, Compose-Konfigurationen und Startanleitungen vorhanden |

Die Softwaretests bestanden zuvor unter Linux/WSL mit libmodbus 3.1.6 und
3.1.11. Beim Wallbox-Image-Build werden sie automatisch im Container ausgeführt.
Das ersetzt keinen Test mit der tatsächlichen Wallbox-Firmware.

**Wichtige Abgrenzungen:**

- `CMD:CHARGE:ON/OFF` an den ESP32 ändert aktuell nur seinen gespiegelten
  Ladezustand, nicht den realen Ladevorgang.
- Nur aufgenommene UIDs dürfen den Modellservo toggeln. Erststart mit leerem NVS:
  90°, leere Allowlist, Bootpolicy `RESTORE`. UIDs sind klonbar, kein
  kryptografischer Berechtigungsnachweis; kein mechanischer Positionssensor
  oder zugesicherter Schutz bei Stromausfall. SG90 ist keine zertifizierte
  physische Diebstahlsicherung. Details: [ESP32](esp32/README.md).
- Das ausgelesene Wallbox-Stromlimit ist nicht der im Gebäude verfügbare Strom.
  Die DTSU666-Erfassung und Berechnung sind noch geplant.

## Architektur

```text
ESP32 (RFID + Servo)
        |
        | UART: 115200 Baud, 8N1
        v
Raspberry Pi — lokale Hardwareanbindung, Dienste in Docker
        |
        +-- USB-RS485 / Modbus RTU --> ABB Terra AC
        |   57600 Baud, 8E1, Slave-ID 9
        |
        +-- DTSU666-Messwerterfassung                    [geplant]
        |
        +-- Wallbox-MQTT --> vorhandener gemeinsamer Message Broker
                              |-- Home Assistant      [geplant]
                              |-- Weboverlay          [lesend]
                              +-- Speicherdienst --> vorhandene MariaDB
        +-- ESP32-UART-MQTT-Gateway                    [geplant]

Remote-Zugriff: Rechner --> WireGuard/SSH-Tunnel --> Pi-Weboverlay
```

Der Pi ist Modbus-Master; **Adresse 9 gehört zur Wallbox**. UART bleibt die
direkte ESP32-Pi-Verbindung, ohne WiFi. Der Reader veröffentlicht Modbus-Daten
auf MQTT, die UART-MQTT-Bridge folgt. MQTT ersetzt keine Hardwareleitungen.

**Späteres Betriebsziel, noch nicht umgesetzt:** eine gemeinsame Compose-Datei
für die getrennten Pi-Projektdienste, kein All-in-one- oder Verwaltungscontainer.
Docker/Compose startet/stoppt die Container; ein geplanter Ladecontroller regelt
das Laden über MQTT. Vorhandener Broker und MariaDB bleiben externe Infrastruktur.
Bis zur späteren Zusammenführung gelten die heutigen dienstweisen Startbefehle.

## Schnellstart: Wallbox lesen

Voraussetzung: Repository, Docker/Compose, Wallbox und das vorbereitete
Netzwerk `evse-mqtt` mit Broker-Alias `mqtt-broker` ([Anleitung](docs/installation.md#5-vorhandenen-mqtt-broker-wiederverwenden)).
**Nur Docker verwenden; andere Prozesse am RS485-Port vorher stoppen.**

```bash
cd rasppi/wallbox
docker compose build
docker compose stop wallbox-reader
docker compose run --rm --no-deps -T --interactive=false wallbox-reader --once && docker compose up -d
docker compose logs --tail 20 -f wallbox-reader
```

Standard: `/dev/ttyUSBEVSEcontrol`, 57600 Baud, 8E1, ID 9. Anderer Gerätepfad:
vorher z. B. `export WALLBOX_DEVICE=/dev/ttyUSB0` setzen.
`Ctrl+C` beendet nur die Logansicht; `docker compose down` stoppt den Dienst.
Details: [Wallbox-Anleitung](rasppi/wallbox/README.md).

## Schnellstart: Weboverlay

Bei laufendem Reader und vorhandenem Broker, aus dem Repository-Verzeichnis:

```bash
cd rasppi/weboverlay
docker compose up -d --build
```

Auf deinem Rechner: `ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8080:127.0.0.1:8080 'BENUTZER@PI-ADRESSE'`
(`BENUTZER@PI-ADRESSE` durch dein vorhandenes SSH-Ziel oder deinen SSH-Alias ersetzen),
dann **http://127.0.0.1:8080** öffnen.
Pi-Port bleibt nur lokal gebunden. Keine Start-/Stop- oder Limitänderung enthalten.
[Konfiguration und Diagnose](docs/installation.md#9-lesendes-weboverlay).

**Übersicht** zeigt aktuelle Werte; **Diagramme** ist eine eigene Seite
(`/diagramme`) mit bis zu 15 Minuten **seit Öffnen der Diagrammseite**, kein
Datenbankarchiv. „Anzeige auswählen“ gilt auf beiden Seiten. Auswahl bleibt
lokal gespeichert; Neuladen oder Seitenwechsel leert die Messwerthistorie.

## ESP32-UART-Verbindung testen

Die geflashte ESP32-Firmware, UART-Verdrahtung und verfügbare Gerätedatei werden
vorausgesetzt. Aus dem Repository-Hauptverzeichnis auf dem Pi:

```bash
docker compose -f rasppi/compose.yaml run --rm --build uart-bridge
```

Die interaktive Brücke verwendet `/dev/serial0` und nimmt `status`, `on`, `off`
oder rohe UART-Nachrichten entgegen. Nur ein Prozess darf den UART-Port verwenden.
`Ctrl+C` beendet die Brücke. Verdrahtung und erwartete Meldungen stehen im
[Installationsguide](docs/installation.md#6-optionale-esp32-uart-testbrücke).
**Vor dem Firmwareupgrade:** Erststart wechselt von früher 0° auf 90°;
Flashen und sicheren Bewegungsraum vor Ort koordinieren. Aufnahme/Bootpolicy
nur über vertrauenswürdigen Pi-UART, nicht über anonymes MQTT oder lesendes HTTP.

## Repositorystruktur

```text
esp32/                   PlatformIO-Firmware: RFID, Servo, UART
rasppi/src/              Interaktive UART-Testbrücke
rasppi/compose.yaml      Docker-Start der UART-Testbrücke
rasppi/wallbox/           Lesender libmodbus-Dienst, Tests, Docker Compose
rasppi/weboverlay/        Lesendes MQTT-Webdashboard, API, Tests, Docker Compose
docs/                    Setup, Pinbelegung, Protokolle und Hardwarehandbücher
AGENTS.md                Gepflegter Projektkontext und Entwicklungsregeln
CHANGELOG.md             Änderungsverlauf
```

## Dokumentation und nächste Schritte

- [Installation, Hardware und Wiederinbetriebnahme](docs/installation.md)
- [Pinbelegung](docs/pin-connection.md)
- [ESP32-Pi-UART-Protokoll](docs/uart-protocol.md)
- [ESP32-Firmware, Persistenz und Prüfgrenzen](esp32/README.md)
- [MQTT-Topics, Payloads und Verfügbarkeit](docs/mqtt-protocol.md)
- [Wallbox-Dienst und Docker-Betrieb](rasppi/wallbox/README.md)
- [Lesendes Weboverlay](rasppi/weboverlay/README.md)
- [MQTT-MariaDB-Speicherung](rasppi/storage/README.md)
- [Wallbox-Handbücher und Registerreferenzen](docs/wallbox/)
- [DTSU666-Handbuch](docs/smartmeter/)
- [Projektkontext für Agents](AGENTS.md) und [Changelog](CHANGELOG.md)

Nächster Meilenstein ist die Pi-Browserprüfung des Weboverlays sowie weitere
Dauerbetriebs-/Zustands- und Messwertvergleiche. Danach folgen UART-MQTT-Gateway,
abgesicherte Ladesteuerung, Energiezähler, SQL-Historienabfragen und Automationen.

**Sicherheit:** Widersprüchliche Register-/Steuernotizen nicht ungeprüft
übernehmen. Der Reader sendet keine Modbus-Schreibbefehle. Arbeiten an
Netzspannung und der Zählerinstallation gehören in die Hände qualifizierter
Fachkräfte; keine SSH-/WireGuard-/Netzwerkänderungen für die Tests erforderlich.
