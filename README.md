# EVSE-Control

Diplomarbeitsprojekt zur **Steuerung und Überwachung einer Elektrofahrzeug-
Ladestation** mit Raspberry Pi, ESP32 und RFID-basierter Diebstahlsicherung.

Der Raspberry Pi liest eine ABB Terra AC über Modbus RTU aus. Der ESP32
übernimmt RFID und einen separaten Servo als Modell der Diebstahlsicherung.
Geplant sind Ladeautomatisierung, Zustandsspeicherung und Bedienung über
Home Assistant sowie ein Weboverlay.

> **Entwicklungsstand:** Der Wallbox-Dienst ist ausschließlich lesend.
> MQTT, reale Ladesteuerung, Datenbank und Bedienoberflächen sind noch nicht
> implementiert. Ein Docker-Einmaltest mit FC03 an der realen Wallbox wurde
> bestätigt; Dauerbetrieb und weitere Hardwarevalidierung stehen noch aus.

## Projektziele

- Ladezustand durch zyklische Abfragen erkennen („Repeating Request“).
- Laden starten/stoppen und nach verfügbarem Strom sowie Dringlichkeit regeln.
- System- und Ladezustände in einer Datenbank speichern.
- Home-Assistant-Integration und Weboverlay mit AN/AUS, verfügbarem Strom,
  Ladestrom, Fahrzeuganschluss und tatsächlichem Ladestatus bereitstellen.
- Weboverlay um eine modulare Einrichtung mit Wallbox-Befehlseingabe erweitern.
- Übergeordnete Softwarekommunikation über MQTT mit **einem gemeinsamen Broker**.
- Pi-Dienste modular und ausschließlich über Docker Compose betreiben.

## Was bereits implementiert ist

| Komponente | Aktueller Umfang |
|---|---|
| ESP32-Firmware | MFRC522-RFID, Servo, UART-Befehle und Zustandsmeldungen |
| Diebstahlsicherung | RFID-Tap toggelt 0°/90°, startet entriegelt; unabhängig vom Laden |
| UART-Testbrücke | Interaktive Python-Brücke im Docker-Container |
| Wallbox-Reader | C++17/libmodbus, zyklische FC03-Abfragen, dekodierte Messwerte als JSON |
| Fehlerbehandlung | Timeouts, erneute Verbindung, ungültige Messwerte als `null`, sauberer Shutdown |
| Softwaretests | Decoder-/JSON-Tests und simulierte RTU-Kommunikation einschließlich Fehlerfällen |
| Containerbetrieb | Dockerfiles, Compose-Konfigurationen und Startanleitungen vorhanden |

Die Softwaretests bestanden zuvor unter Linux/WSL mit libmodbus 3.1.6 und
3.1.11. Beim Wallbox-Image-Build werden sie automatisch im Container ausgeführt.
Das ersetzt keinen Test mit der tatsächlichen Wallbox-Firmware.

**Wichtige Abgrenzungen:**

- `CMD:CHARGE:ON/OFF` an den ESP32 ändert aktuell nur seinen gespiegelten
  Ladezustand, nicht den realen Ladevorgang.
- Jede lesbare RFID-Karte kann derzeit den Servo toggeln; eine UID-Whitelist fehlt.
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
        +-- MQTT-Gateway --> gemeinsamer Message Broker [geplant]
                              |-- Home Assistant
                              |-- Weboverlay
                              +-- Datenbankdienst

Remote-Zugriff: Rechner --> WireGuard --> Pi (SSH; später Weboverlay)
```

Der Pi ist Modbus-Master; **Adresse 9 gehört zur Wallbox**. UART bleibt die
direkte ESP32-Pi-Verbindung, ohne WiFi. Der geplante Pi-Gateway-Dienst übersetzt
UART-/Modbus-Daten auf MQTT; MQTT ersetzt nicht die physischen Hardwareleitungen.

## Schnellstart: Wallbox lesen

Voraussetzung: Repository, Docker/Compose und angeschlossene Wallbox auf dem Pi.
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

## Repositorystruktur

```text
esp32/                   PlatformIO-Firmware: RFID, Servo, UART
rasppi/src/              Interaktive UART-Testbrücke
rasppi/compose.yaml      Docker-Start der UART-Testbrücke
rasppi/wallbox/           Lesender libmodbus-Dienst, Tests, Docker Compose
docs/                    Setup, Pinbelegung, Protokolle und Hardwarehandbücher
AGENTS.md                Gepflegter Projektkontext und Entwicklungsregeln
CHANGELOG.md             Änderungsverlauf
```

## Dokumentation und nächste Schritte

- [Installation, Hardware und Wiederinbetriebnahme](docs/installation.md)
- [Pinbelegung](docs/pin-connection.md)
- [ESP32-Pi-UART-Protokoll](docs/uart-protocol.md)
- [Wallbox-Dienst und Docker-Betrieb](rasppi/wallbox/README.md)
- [Wallbox-Handbücher und Registerreferenzen](docs/wallbox/)
- [DTSU666-Handbuch](docs/smartmeter/)
- [Projektkontext für Agents](AGENTS.md) und [Changelog](CHANGELOG.md)

Nächster Meilenstein ist die Dauerbetriebsprüfung mit weiteren Zustands- und
Messwertvergleichen an der realen Wallbox. Danach folgen MQTT-Gateway/Broker, abgesicherte Ladesteuerung,
Energiezähler, Zustandsspeicherung, Bedienoberflächen und Automationen.

**Sicherheit:** Widersprüchliche Register-/Steuernotizen nicht ungeprüft
übernehmen. Der Reader sendet keine Modbus-Schreibbefehle. Arbeiten an
Netzspannung und der Zählerinstallation gehören in die Hände qualifizierter
Fachkräfte; keine SSH-/WireGuard-/Netzwerkänderungen für die Tests erforderlich.
