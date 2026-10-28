# EVSE-Control

Diplomarbeitsprojekt zur **Steuerung und Überwachung einer Elektrofahrzeug-
Ladestation** mit Raspberry Pi, ESP32 und RFID-basierter Diebstahlsicherung.

Der Raspberry Pi liest eine ABB Terra AC über Modbus RTU aus. Der ESP32
übernimmt RFID und einen separaten Servo als Modell der Diebstahlsicherung.
Geplant sind Ladeautomatisierung und Bedienung über die Website. Ein lesendes
Weboverlay und MQTT-Wallbox-Zustandsspeicherung für MariaDB sind implementiert.
Ein eigenes Home-Assistant-Modul wird nicht entwickelt. Die Website soll später
umgebaut werden; anschließend ist eine Smartphone-WebApp geplant. Umfang,
Gestaltung und WebApp-Umsetzung sind noch offen. Das Websitebackend ist separat
auf PHP 8.4/Apache mit einem PHP-MQTT-Worker umgestellt;
bestehende Wallbox-Anzeigen und Diagramme bleiben erhalten. Separat ergänzt sind
kompakte Theme-/Einstellungszugriffe und die optionale Haus-Smartmeter-Anzeige.

> **Entwicklungsstand:** Der Wallbox-Dienst ist ausschließlich lesend.
> MQTT-Empfang echter Wallboxdaten am Pi ist bestätigt. Das neue lesende
> PHP-Weboverlay ist implementiert und Docker-getestet;
> Pi-Start und Live-Übersicht am 26.10.2026 vom Projektinhaber bestätigt;
> Websitezugriff danach erneut bestätigt. Neue Symbolschalter und Haus-Smartmeter
> sind implementiert und Docker-getestet; deren Pi-Prüfung bleibt offen.
> MariaDB-Speicherdienst auf dem Pi bestätigt: Schema 1 in `energyControl`,
> 207 gespeicherte Wallbox-Samples am 2026-10-27. Kein Langzeit-/Ausfallnachweis.
> Reale Ladesteuerung und bedienende Webfunktionen fehlen noch.
> Theme „Compact / Dense“ in Hell/Dunkel umgesetzt; weitergehender Websiteumbau
> und Smartphone-WebApp bleiben offen.
> ESP32-Whitelist und persistierter Startmodus ersetzen den bisherigen
> UART-Kommunikationstest; neue Firmware noch ungeflasht und hardwareunverifiziert.
> Ein Docker-Einmaltest mit FC03 an der realen Wallbox wurde
> bestätigt; Dauerbetrieb und weitere Hardwarevalidierung stehen noch aus.

## Projektziele

- Ladezustand durch zyklische Abfragen erkennen („Repeating Request“).
- Laden starten/stoppen und nach verfügbarem Strom sowie Dringlichkeit regeln.
- System- und Ladezustände in einer Datenbank speichern.
- Website mit AN/AUS, verfügbarem Strom,
  Ladestrom, Fahrzeuganschluss und tatsächlichem Ladestatus bereitstellen.
- Weboverlay um eine modulare Einrichtung mit Wallbox-Befehlseingabe erweitern.
- Website später umbauen und anschließend eine Smartphone-WebApp entwickeln;
  Details noch festzulegen. Die bestehende mobile Browseransicht ist nicht
  bereits die geplante WebApp.
- Übergeordnete Softwarekommunikation über MQTT mit **einem gemeinsamen Broker**.
- Pi-Dienste modular und ausschließlich über Docker Compose betreiben;
  später ein gemeinsamer Start-/Stop-Befehl für mehrere spezialisierte Container.

### Geplante Lademodi

Die spätere Ladesteuerung soll drei Modi anbieten (**noch nicht implementiert**):

1. **Laden wenn Solarstrom** – abhängig von verfügbarem Solarstrom.
2. **Laden ohne Solarstrom** – Laden auch ohne verfügbaren Solarstrom ermöglichen.
3. **Benutzerdefiniert** – Laden nach noch festzulegenden eigenen Vorgaben.

Solar-Messquelle, mögliche Beschränkung auf PV-Überschuss, Schwellwerte,
Ausfallverhalten und benutzerdefinierte Regeln sind noch offen. Es gibt dafür
noch keine Modusauswahl oder Einrichtung; Geräte-/Sicherheitsgrenzen gelten weiter.

## Was bereits implementiert ist

| Komponente | Aktueller Umfang |
|---|---|
| ESP32-Firmware | MFRC522-RFID, Servo, UART-Befehle und Zustandsmeldungen |
| Diebstahlsicherungsmodell | Erlaubte RFID-UID toggelt 0°/90°; NVS-Allowlist und Bootpolicy; neuer Erststart verriegelt, Hardwareprüfung offen |
| UART-Testbrücke | Interaktive Python-Brücke im Docker-Container |
| Wallbox-Reader | C++17/libmodbus, zyklische FC03-Abfragen, dekodierte Messwerte als JSON |
| MQTT-Publisher | retained State und Verfügbarkeit mit libmosquitto; vorhandener Broker wird wiederverwendet |
| Weboverlay | PHP-/Apache-Backend mit MQTT-Worker; lesende Anzeige, Frischeprüfung und Browser-Zeitverläufe; Docker-getestet |
| Haus-Smartmeter | Optionaler separater PHP-HTTP-Worker: Wert 7 als Netzleistung mit Vorzeichen und eigenem Datenstatus; Docker-getestet, Pi-Prüfung offen |
| Zustandsspeicherung | MQTT-Collector für vorhandene MariaDB; Schema 1 und gespeicherte Wallbox-Telemetrie am Pi bestätigt |
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
  Die HTTP-Hausmessung zeigt Netzbezug/Einspeisung in W, keinen verfügbaren
  Ladestrom in A. DTSU666-Erfassung und Ladeleistungsberechnung bleiben geplant.

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
        +-- Haus-Smartmeter HTTP(S) --> Weboverlay      [optional, lesend]
        |
        +-- Wallbox-MQTT --> vorhandener gemeinsamer Message Broker
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
PHP/Composer und Abhängigkeiten werden ausschließlich im Docker-Build verwendet,
nicht auf dem Host installiert. Netzwerk, Broker, Compose und SSH-Tunnel bleiben
unverändert; Reader, UART-Brücke und Speichercollector werden nicht ersetzt.

**Übersicht** zeigt aktuelle Werte; **Diagramme** ist eine eigene Seite
(`/diagramme`). Default: bis zu 15 Minuten seit Öffnen der Diagrammseite im RAM;
optional lädt SQL diese Rohhistorie nach Neuladen nach. Zusätzlich implementiert:
Kalenderarchiv für Stunde, Tag, ISO-Woche,
Monat, Jahr und eigenen Zeitraum bis ein Jahr, mit additiver Speicherverdichtung.
„Anzeige auswählen“ gilt auf beiden Seiten; nur Präferenzen werden lokal gespeichert.
Docker-CI 40678971209 erfolgreich; Kalender auf dem Pi noch nicht aktiviert.

Das Theme folgt Entwurf Nr. 8 „Compact / Dense“: dunkle Graphitflächen, feine
blau-graue Rahmen, dezente Verläufe/Schatten, cyanfarbene Leistung und gefüllte
mintfarbene Live-Badges. Hell entsprechend neutral-kühl; Design-CI 40499228102
für acce554 erfolgreich, simulierte Desktop-/Mobilansichten geprüft.
Das bestehende Layout bleibt unverändert. **Schiebeschalter links unten** mit
Sonne/Mond wechselt Hell/Dunkel. **Settings mit Zahnrad** steht links unter
„Diagramme“ und öffnet die Platzhalterseite `/einstellungen`.
Dort stellt „Systemdarstellung verwenden“ die automatische Browserpräferenz wieder her.
Die Theme-Wahl bleibt browserlokal, ohne Messwerte oder Zugangsdaten.
Die Vorlagen bestimmen nur den Stil, nicht Inhalt oder Anordnung der Website.

Wiederholte Hilfstexte sind reduziert; die reine Infokarte „Leistungsrahmen“
entfällt. „Unter Sollstrom“ bleibt in der Diagnose, alle Messwerte/Frischewarnungen
bleiben erhalten. Schiebeschalter-/Textbereinigungs-CI 40491901055 für 13b8a20
erfolgreich; Desktop-/Mobilbilder mit simulierten Daten geprüft, neuer Pi-Test offen.

Optional zeigt **Netzleistung Haus** den siebten HTTP-Smartmeterwert:
positiv Netzbezug, negativ Einspeisung. Die private Quelle nur lokal über
`SMARTMETER_URL` konfigurieren; ohne URL bleibt sie deaktiviert.
[Einrichtung und Ausfallverhalten](docs/installation.md#haus-smartmeter-optional-einrichten).
Kein verfügbarer Ladestrom, keine Ladeautomation und kein Hauszählerverlauf.

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

Nächster Meilenstein sind weitere Pi-Browser-/Ausfallprüfungen sowie
Dauerbetriebs-/Zustands- und Messwertvergleiche. Danach folgen UART-MQTT-Gateway,
abgesicherte Ladesteuerung, Energiezähler und Automationen. Die separat beauftragte
lesende SQL-Historie ist als opt-in für die bestehenden Diagramme implementiert;
der Projektinhaber meldet nach Aktivierung am 2026-10-27 „funktioniert“.
Gezielte API-/Reload-/Ausfallprüfungen bleiben offen. Vorübergehend ist `smart`
ausdrücklich freigegeben, weil der `smartReader`-Login ungeklärt ist. Live-MQTT bleibt
unabhängig; [Einrichtung und Grenzen](docs/installation.md#sql-verlauf-optional-einrichten).

**Sicherheit:** Widersprüchliche Register-/Steuernotizen nicht ungeprüft
übernehmen. Der Reader sendet keine Modbus-Schreibbefehle. Arbeiten an
Netzspannung und der Zählerinstallation gehören in die Hände qualifizierter
Fachkräfte; keine SSH-/WireGuard-/Netzwerkänderungen für die Tests erforderlich.
