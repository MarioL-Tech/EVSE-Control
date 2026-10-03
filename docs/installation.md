# Installation und Wiederinbetriebnahme auf dem Raspberry Pi

Diese Anleitung dokumentiert den **aktuellen, nachvollziehbaren Ablauf** für
EVSE-Control. Neue Einrichtungsschritte werden hier ergänzt, sobald sie umgesetzt
werden. Sie setzt einen vorbereiteten Pi voraus; sie ist keine Anleitung zum
Neuinstallieren des Betriebssystems oder der bestehenden Broker-Infrastruktur.

**Stand:** 2026-10-03. Wallbox-Reader läuft in Docker. Einmal-Lesen und ein kurzer
zyklischer Betrieb wurden von Mario bestätigt. Der vorhandene MQTT-Broker ist
erreichbar; **der Reader veröffentlicht noch keine MQTT-Nachrichten**.

## 1. Voraussetzungen und Regeln

- Raspberry Pi mit bestehendem Docker Engine-/Compose-Zugriff.
- SSH-Zugriff, im aktuellen Aufbau über WireGuard. Kein direkter Hardwarezugang
  erforderlich, sofern Geräte und Verdrahtung bereits eingerichtet sind.
- Repositoryzugriff über vorhandenes Git oder Übertragung vom Entwicklungsrechner.
- USB-RS485-Gerät und Wallbox: 57600 Baud, 8E1, Slave-ID 9.
- Für den Image-Build Netzwerkzugriff auf Image-/Paketquellen.
- Für Abschnitt 5 ein bereits eingerichteter Mosquitto-Container.

**Alles an Projektsoftware bleibt in Docker:** keine Compiler, libmodbus,
Python-/pip-Pakete, mbpoll oder Mosquitto auf dem Pi-Host installieren.
Dockerfiles installieren Pakete nur innerhalb der Images.

**Ein Prozess pro Hardwareport:** Reader und mbpoll dürfen nicht gleichzeitig
Modbus-Anfragen über denselben Adapter senden. UART hat einen eigenen Port.
Keine Netzspannungsarbeiten, Netzwerk-/WireGuard-Änderungen oder Reboots für
diese Schritte durchführen. Hardwaredetails: [Setup](setup.md) und
[Pinbelegung](pin-connection.md).

### Befehle korrekt eingeben

Alle folgenden Befehle laufen **in der SSH-Shell auf dem Pi**, nicht in einem
Windows-Terminal ohne SSH. Befehle einzeln einfügen; sichtbarer Zeilenumbruch
im Terminal darf nicht als zusätzliches Enter übernommen werden. Es gab beim
Test ein von Mario Windows zugeordnetes Aufrufproblem.

## 2. Repository bereitstellen und Stand notieren

Für eine neue Arbeitskopie mit bereits vorhandenem Git:

```bash
git clone https://github.com/MarioL-Tech/EVSE-Control.git
cd EVSE-Control
```

Für eine bestehende Arbeitskopie zuerst lokale Änderungen und Branch prüfen:

```bash
git status -sb
git branch --show-current
```

Nur auf dem gewünschten Branch und mit geklärten lokalen Änderungen aktualisieren:

```bash
git pull --ff-only
git rev-parse HEAD
```

Commit-ID im eigenen Installationsprotokoll notieren. Bei einem noch nicht
gemergten Feature dessen Branch verwenden, statt neue Funktionen auf `main`
vorauszusetzen. Keine lokalen Änderungen mit Reset/Force überschreiben.

## 3. Wallbox-Reader bauen und einmal testen

Vom Repository-Hauptverzeichnis:

```bash
cd rasppi/wallbox
```

Standardgerät ist `/dev/ttyUSBEVSEcontrol`. Falls der eingerichtete Host-Pfad
abweicht, vor allen folgenden Starts setzen, beispielsweise:

```bash
export WALLBOX_DEVICE=/dev/ttyUSB0
```

Weitere nicht geheime Parameter bei Abweichungen: `WALLBOX_BAUD`,
`WALLBOX_PARITY`, `WALLBOX_SLAVE`, `WALLBOX_INTERVAL_MS`, `WALLBOX_TIMEOUT_MS`.
Defaults: 57600, E, 9, 2000 ms, 1000 ms. Die Einstellungen für spätere Sitzungen
im persönlichen Installationsprotokoll festhalten; ein `export` gilt nur für
die aktuelle Shell. Nicht standardmäßig eine unbekannte Gerätekonfiguration ändern.

```bash
docker compose build
docker compose stop wallbox-reader
```

Der Build kompiliert und testet im Container. Bei Buildfehlern nicht mit einem
alten Image fortfahren. Vor dem Read zusätzlich andere Master/mbpoll-Prozesse
am selben Port stoppen. Ein vorhandener Diagnosecontainer ist nicht automatisch
ein aktiver Master; entscheidend sind seine laufenden Programme.

```bash
docker compose run --rm --no-deps -T --interactive=false wallbox-reader --once
```

`-T --interactive=false` deaktiviert TTY und Containereingabe. Die Startmeldung
allein ist kein erfolgreicher Read: Es muss eine JSON-Zeile folgen.

- `status="ok"`: Register wurden gelesen; `values` enthält Messwerte.
- `values.error_code=0`: Zusätzlich meldet die Wallbox keinen Fehlercode.
- `status="error"`, `values=null`: Keine aktuellen Messwerte verfügbar.
- Exitcode 0: erfolgreicher Read; 1: Kommunikationsfehler; 2: Konfigurations-
  oder fataler Laufzeitfehler. `ok` ist keine Bestätigung der Messwertgenauigkeit.

Bei Bedarf den Exitcode **direkt danach** als eigenen Befehl abfragen, ohne
dazwischen einen anderen Befehl auszuführen:

```bash
echo $?
```

Nicht `"$?"` als eigenen Befehl eingeben: Dann versucht die Shell beispielsweise,
ein Programm namens `0` auszuführen. Alternativ Read und Exitcode-Abfrage mit
Semikolon auf derselben Shellzeile kombinieren.

## 4. Reader starten, beobachten und stoppen

Nach erfolgreichem Test, weiterhin in `rasppi/wallbox/`:

```bash
docker compose up -d
docker compose ps
docker compose logs --tail 20 -f wallbox-reader
```

`up -d` startet im Hintergrund; der Dienst läuft ohne offene SSH-Sitzung weiter.
`Ctrl+C` beendet **nur die Logansicht**, nicht den Dienst. Explizit stoppen:

```bash
docker compose down
```

Im bisherigen kurzen Test (etwa 25 s) waren 12 Reads erfolgreich, einer hatte
Timeout. Beim folgenden Read wurden automatisch wieder Messwerte geliefert.
Das bestätigt kurzfristiges Polling und Recovery, aber keinen stabilen
Langzeitbetrieb. Mindestens 10–15 Minuten beobachten und Häufigkeit der Fehler
notieren; reale Zustandswechsel und Messwertvergleich sind noch zu validieren.

Ausgelesenes Stromlimit und tatsächlicher Strom sind unterschiedliche Werte:
6 A Limit bei 0 A Messstrom bedeutet nicht, dass geladen wird. Der Reader
setzt keine Limits und startet/stoppt keine Session.

## 5. Vorhandenen MQTT-Broker wiederverwenden

**Keinen zweiten Broker starten.** Im aktuellen Aufbau existiert:

| Parameter | Beobachteter Wert |
|---|---|
| Containername | `elastic_lumiere` (deploymentabhängig) |
| Image | `eclipse-mosquitto:alpine` |
| veröffentlichter Host-Port | 1883 auf allen Host-Schnittstellen |
| ursprüngliches Docker-Netzwerk | `bridge` |
| Reader-Netzwerk vor MQTT-Anbindung | `wallbox_default` |

Bei Wiederinstallation Containername zuerst ermitteln:

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
```

Den tatsächlichen Namen für diese Shell setzen:

```bash
export BROKER_CONTAINER=elastic_lumiere
```

### Gemeinsames Netzwerk vorbereiten

```bash
docker network ls
```

Nur wenn `evse-mqtt` noch nicht existiert:

```bash
docker network create evse-mqtt
```

Broker verbinden, sofern er dort noch nicht mit dem Alias angeschlossen ist:

```bash
docker network connect --alias mqtt-broker evse-mqtt "$BROKER_CONTAINER"
```

Prüfen:

```bash
docker network inspect evse-mqtt
```

Broker-Netzwerke und Alias prüfen:

```bash
docker inspect -f '{{json .NetworkSettings.Networks}}' "$BROKER_CONTAINER"
```

`evse-mqtt` ist ein benutzerdefiniertes Docker-Netzwerk; darin ist der Broker
unter `mqtt-broker:1883` erreichbar. Es wird von verschiedenen Diensten geteilt,
nicht durch einen einzelnen Reader verwaltet. Ein „already exists“ bei Netz-
oder Endpoint-Erstellung bedeutet hier nicht, dass ein neues Netzwerk nötig ist;
vorhandene Zuordnung prüfen, keine laufenden Netze löschen.

Das Verbinden bleibt bei einem Neustart desselben Broker-Containers erhalten.
Wird der Broker **neu erstellt**, muss seine externe Netzwerkzuordnung mit
Alias in seiner eigenen Start-/Compose-Konfiguration dauerhaft hinterlegt oder
dieser Schritt wiederholt werden. Die unbekannte Broker-Konfiguration nicht
ersetzen; ursprüngliche Compose-/Startparameter, Konfiguration und Datenvolumes
vor einem vollständigen Neuaufbau sichern. Keine Secrets ins Repository kopieren.

### Verbindung aus einem Testcontainer prüfen

Den folgenden Befehl auf **einer Shellzeile** ausführen:

```bash
docker run --rm --network evse-mqtt eclipse-mosquitto:alpine mosquitto_pub -h mqtt-broker -t evse/test -m test -q 1 -d
```

Der Client läuft nur kurz in Docker und sendet keine Wallbox-Befehle.
Erwartete Ausgabe enthält `CONNACK (0)` und `PUBACK ... RC:0`.
Mario hat diese Ausgabe am 2026-10-03 bestätigt: Eine Verbindung und Veröffentlichung
auf `evse/test` ohne Zugangsdaten funktionieren über dieses Netzwerk.

Das bestätigt weder Berechtigungen auf allen Topics noch die Zustellung an einen
Subscriber. Anonymer Zugriff ist keine Sicherheitsempfehlung: Wegen des an alle
Host-Schnittstellen gebundenen Ports vor produktiver Verwendung Authentifizierung,
ACLs und erforderliche Erreichbarkeit klären. Keine Zugangsdaten hier posten.

### Aktuelle Grenze

**Der Wallbox-Reader ist noch nicht an MQTT angebunden.** Seine aktuelle
Compose-Datei verwendet weiterhin `wallbox_default`, nicht `evse-mqtt`.
Netzwerkzuordnung, Publisher, Topics und Payload-Vertrag werden im nächsten
Implementierungsschritt ergänzt. Erst danach erreichen Wallboxdaten den Broker.
Weboverlay, Home Assistant und Datenbankanbindung sind ebenfalls noch geplant.

## 6. Optionale ESP32-UART-Testbrücke

In einer neuen SSH-Sitzung aus dem Repository-Hauptverzeichnis, ohne anderen
Prozess am UART-Port:

```bash
docker compose -f rasppi/compose.yaml run --rm --build uart-bridge
```

Die Brücke ist bewusst interaktiv: `status`, `on`, `off` oder rohe Nachrichten
eingeben; `Ctrl+C` beendet sie. Standard ist `/dev/serial0`; einen abweichenden
Host-Pfad vorab mit `UART_DEVICE` setzen. Firmware, Verdrahtung und UART-
Hardwarefreigabe müssen vorhanden sein. `on`/`off` ändern nur den ESP32-Spiegel,
nicht die reale Wallbox. Details: [UART-Protokoll](uart-protocol.md).

## 7. Was für eine spätere Wiederholung gesichert werden muss

- Verwendeter Git-Commit/Branch und Imageversionen bzw. Digests.
- Eigene Wallbox-Gerätepfade, Baudrate/Parität/Slave-ID und Pollingparameter.
- Brokername, ursprüngliche Broker-Start-/Compose-Konfiguration und Volumes.
- Netzwerk `evse-mqtt` und Broker-Alias `mqtt-broker`.
- Testergebnisse: Read/Timeouts, beobachtete Zustände und MQTT-Bestätigungen.
- Secrets separat sichern; keine Passwörter, Schlüssel oder VPN-Konfiguration
  in Git einchecken. Grafana/MariaDB und andere bestehende Dienste nicht ersetzen.

Der vorliegende Guide deckt Projektbetrieb auf dem vorbereiteten Pi und die
MQTT-Vorbereitung ab. Eine komplette Neuinstallation benötigt zusätzlich die
bisher nicht dokumentierte Einrichtung von OS, Docker, SSH/WireGuard, Hardware-
Gerätezuordnung und vorhandenem Broker. Diese Voraussetzungen nicht als erledigt
behaupten. **Bei jedem neuen Einrichtungsschritt diesen Guide aktualisieren.**
