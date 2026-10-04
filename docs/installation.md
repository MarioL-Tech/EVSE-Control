# Installation, Hardware und Wiederinbetriebnahme

Diese Anleitung dokumentiert den **aktuellen, nachvollziehbaren Ablauf** für
EVSE-Control. Neue Einrichtungsschritte werden hier ergänzt, sobald sie umgesetzt
werden. Die Betriebsschritte setzen einen vorbereiteten Pi voraus. Hardware-
und Erstvorbereitungsreferenz stehen in Abschnitt 8; eine vollständige OS-,
Docker- oder Broker-Neuinstallation ist damit noch nicht beschrieben.

**Stand:** 2026-10-04. Wallbox-Reader läuft in Docker. Einmal-Lesen und ein kurzer
zyklischer Betrieb wurden vom Projektinhaber bestätigt. Der vorhandene MQTT-Broker ist
erreichbar; der Empfang der echten Reader-Messwerte wurde ebenfalls bestätigt.
Das neue rein lesende Weboverlay ist implementiert, der Browser-/Deploymenttest
auf dem Pi steht noch aus (Abschnitt 9).

## Inhalt

1. [Voraussetzungen und Regeln](#1-voraussetzungen-und-regeln)
2. [Repository bereitstellen](#2-repository-bereitstellen-und-stand-notieren)
3. [Wallbox bauen und testen](#3-wallbox-reader-bauen-und-einmal-testen)
4. [Reader betreiben](#4-reader-starten-beobachten-und-stoppen)
5. [MQTT-Broker wiederverwenden](#5-vorhandenen-mqtt-broker-wiederverwenden)
6. [ESP32-UART testen](#6-optionale-esp32-uart-testbrücke)
7. [Wiederinstallation vorbereiten](#7-was-für-eine-spätere-wiederholung-gesichert-werden-muss)
8. [Hardware und Erstvorbereitung](#8-hardware-und-erstvorbereitung)
9. [Lesendes Weboverlay](#9-lesendes-weboverlay)
10. [MQTT-Zustandsspeicherung](#10-mqtt-zustandsspeicherung-in-der-vorhandenen-mariadb)

## 1. Voraussetzungen und Regeln

- Raspberry Pi mit bestehendem Docker Engine-/Compose-Zugriff.
- SSH-Zugriff, im aktuellen Aufbau über WireGuard. Kein direkter Hardwarezugang
  erforderlich, sofern Geräte und Verdrahtung bereits eingerichtet sind.
- Repositoryzugriff über vorhandenes Git oder Übertragung vom Entwicklungsrechner.
- USB-RS485-Gerät und Wallbox: 57600 Baud, 8E1, Slave-ID 9.
- Für den Image-Build Netzwerkzugriff auf Image-/Paketquellen.
- Für Abschnitt 5 ein bereits eingerichteter Mosquitto-Container.

**Vor dem neuen Reader-Start Abschnitt 5 zur Broker-/Netzwerkvorbereitung
ausführen.** Compose verwendet jetzt das externe Netzwerk `evse-mqtt` und
erzeugt es nicht selbst. Danach mit Abschnitt 3 fortfahren. Es wird kein zweiter
Produktionsbroker benötigt.

**Alles an Projektsoftware bleibt in Docker:** keine Compiler, libmodbus,
Python-/pip-Pakete, mbpoll oder Mosquitto auf dem Pi-Host installieren.
Dockerfiles installieren Pakete nur innerhalb der Images.

**Ein Prozess pro Hardwareport:** Reader und mbpoll dürfen nicht gleichzeitig
Modbus-Anfragen über denselben Adapter senden. UART hat einen eigenen Port.
Keine Netzspannungsarbeiten, Netzwerk-/WireGuard-Änderungen oder Reboots für
diese Betriebsschritte durchführen. Hardwaredetails:
[Abschnitt 8](#8-hardware-und-erstvorbereitung) und [Pinbelegung](pin-connection.md).

### Befehle korrekt eingeben

Die Betriebsbefehle laufen **in der SSH-Shell auf dem Pi**, nicht in einem
Windows-Terminal ohne SSH. Abschnitt 8 kennzeichnet separate Schritte auf dem
Entwicklungsrechner ausdrücklich. Befehle einzeln einfügen; sichtbarer Zeilenumbruch
im Terminal darf nicht als zusätzliches Enter übernommen werden. Es gab beim
Test ein vom Projektinhaber Windows zugeordnetes Aufrufproblem.

### Späterer gemeinsamer Compose-Einstieg (noch nicht umgesetzt)

Vereinbart ist eine gemeinsame Compose-Datei für mehrere spezialisierte
Pi-Projektcontainer. Ziel: gemeinsamer Start mit `docker compose up -d` und
Stop mit `docker compose down` im später festgelegten Stack-Verzeichnis.
**Diese Gesamtstart-Anleitung ist noch nicht verfügbar:** derzeit gelten die
getrennten Befehle der jeweiligen Dienstabschnitte, keine Umstellung jetzt.

Ein fachlicher Ladecontroller wird später per MQTT die Ladeautomatisierung
übernehmen, nicht andere Container starten/stoppen. Kein zusätzlicher Docker-
Verwaltungscontainer und kein Docker-Socket-Mount für diese Aufgabe.
Vorhandener Broker, MariaDB und andere fremde Dienste bleiben außerhalb des
Projektstacks; gemeinsames Stoppen darf diese Infrastruktur nicht beenden.
Kontrollierte Übernahme der bisherigen Stacks, Hardwareport-Eigentum, externe
Netzwerke, Secrets und Startabhängigkeiten werden erst bei Umsetzung dokumentiert.

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

Für dauerhafte lokale Einstellungen kann die Vorlage übernommen werden, ohne
eine vorhandene Datei zu überschreiben:

```bash
test -e .env || cp .env.example .env
```

`.env` wird nicht committed oder in den Docker-Build kopiert. Reader-Konfiguration
und optionale MQTT-Authentifizierung siehe Abschnitt 5. Defaults: MQTT aktiviert,
Host `mqtt-broker`, Port 1883, Präfix `evse/wallbox`, Client-ID `evse-wallbox-reader`.

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
- Exitcode 0 bestätigt **nicht MQTT-Empfang**. Einmalmodus wartet kurz auf ACKs;
  ohne Broker kann Modbus trotzdem erfolgreich sein. Subscriber-Test aus Abschnitt 5 nutzen.

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
Der Projektinhaber hat diese Ausgabe am 2026-10-03 bestätigt: Eine Verbindung und Veröffentlichung
auf `evse/test` ohne Zugangsdaten funktionieren über dieses Netzwerk.

Das bestätigt weder Berechtigungen auf allen Topics noch die Zustellung an einen
Subscriber. Anonymer Zugriff ist keine Sicherheitsempfehlung: Wegen des an alle
Host-Schnittstellen gebundenen Ports vor produktiver Verwendung Authentifizierung,
ACLs und erforderliche Erreichbarkeit klären. Keine Zugangsdaten hier posten.

### Reader auf die MQTT-Version aktualisieren

Nach Merge der MQTT-PR auf `main`, oder bewusst auf dem gewünschten Feature-
Branch, den Stand gemäß Abschnitt 2 aktualisieren. Dann aus `rasppi/wallbox/`:

```bash
docker compose build
docker compose stop wallbox-reader
docker compose run --rm --no-deps -T --interactive=false wallbox-reader --once
```

Nur nach erfolgreichem Modbus-Test:

```bash
docker compose up -d --force-recreate
docker compose logs --tail 20 -f wallbox-reader
```

Der neue Reader hängt damit dauerhaft am **externen** `evse-mqtt`, auch nach
Neuerstellung durch Compose. `docker compose down` entfernt dieses gemeinsame
Netzwerk oder den Broker nicht. Während des Builds kann die alte Reader-Version
weiterlaufen; zum Einmal-Test muss sie gestoppt sein. Pollingpausen bei aktivem
Laden vorab koordinieren, da die Wallbox einen Kommunikationstimeout hat.

### Wallboxdaten empfangen

In einer zweiten SSH-Sitzung den folgenden einzelnen Befehl ausführen:

```bash
docker run --rm --network evse-mqtt eclipse-mosquitto:alpine mosquitto_sub -h mqtt-broker -t 'evse/wallbox/#' -v
```

Erwartet werden:

```text
evse/wallbox/state {"schema_version":1,...}
evse/wallbox/availability online
```

`...` ist hier nur ein gekürztes JSON-Beispiel. Beide Topics sind retained: ein
später gestarteter Subscriber erhält den letzten Stand. Er muss trotzdem
Timestamp und Availability prüfen, nicht alte Daten als frisch behandeln.
`online` bedeutet erfolgreicher frischer Read, nicht aktives Laden.
Die vollständige Definition steht im [MQTT-Vertrag](mqtt-protocol.md).

Bei gestopptem Reader wird `offline` erwartet. `Ctrl+C` beendet nur den
Testsubscriber; der Hintergrund-Reader läuft weiter. Bei abweichendem Präfix
das Topic entsprechend ändern. Authentifizierte Broker brauchen auch auf der
Subscriber-Seite gültige Zugangskonfiguration; keine Secrets in Chat/CLI posten.

### MQTT-Konfiguration und optionale Authentifizierung

Lokale `.env` in `rasppi/wallbox/`, keine Geheimnisse in Git:

| Variable | Default / Funktion |
|---|---|
| `MQTT_ENABLED` | `true` in Compose; `false` deaktiviert Publishing |
| `MQTT_HOST`, `MQTT_PORT` | `mqtt-broker`, `1883` |
| `MQTT_TOPIC_PREFIX` | `evse/wallbox`, keine Wildcards |
| `MQTT_CLIENT_ID` | `evse-wallbox-reader`, eindeutig pro aktivem Reader |
| `MQTT_USERNAME` | leer für bisherigen anonymen Test |
| `MQTT_PASSWORD` | optional; sichtbar in Container-Umgebung, Datei bevorzugen |
| `MQTT_PASSWORD_FILE` | Containerpfad zu einer read-only gemounteten Datei |

Nur ein Publisher pro Topic-Präfix, sonst überschreiben Reader sich gegenseitig.
`MQTT_ENABLED=false` benötigt weiterhin das existierende Compose-Netzwerk, aber
keine erreichbare Broker-Verbindung. Der Reader bleibt unabhängig von Brokerausfällen
lesend und gibt JSON aus. Beim Reconnect wird nur der neueste Snapshot übertragen,
kein Verlauf; State-/Availability-Topics sind keine Steuerkanäle.

Wenn der vorhandene Broker Benutzer/Passwort verlangt, vorhandene sichere
Passwortdatei **außerhalb des Repositorys** verwenden. In lokaler `.env`
`MQTT_USERNAME` und `MQTT_PASSWORD_HOST_FILE` (absoluter Host-Dateipfad) setzen.
Datei enthält Passwort in der ersten Zeile. Nicht beide Passwortmethoden kombinieren.
Start mit der mitgelieferten Override-Datei:

```bash
docker compose -f compose.yaml -f compose.auth.yaml up -d --build
```

Sie mountet das Passwort read-only nach `/run/secrets/mqtt-password` und leert
die Passwort-Umgebung. Bei dieser Betriebsart dieselben `-f`-Optionen für spätere
Run-/Stop-/Log-Befehle verwenden. Keine Zugangsdaten veröffentlichen oder aus dem
aktuellen anonymen Test eine produktive Sicherheitseinstellung ableiten.
TLS ist noch nicht implementiert; MQTT nur im vertrauenswürdigen Docker-Netz nutzen.

### Automatische Tests und aktuelle Grenze

`docker compose build` führt Decoder-/RTU-Tests und isolierte MQTT-Integrationstests
im Build-Container aus. Der temporäre Testbroker lauscht nur auf Loopback und
kontaktiert weder eure Wallbox noch den Produktionsbroker. Geprüft werden retained
State, Readfehler/Availability, Brokerneustart, Polling ohne Broker, Shutdown und Will.
Zusätzlich Authentifizierung per Datei, abgelehnte Test-Zugangsdaten und die
begrenzte Warteschlange bei ausbleibenden Publish-ACKs.
Eine volle stderr-Pipe darf ebenfalls weder Polling noch Shutdown blockieren;
bei aktivem MQTT sind Diagnosen deshalb best-effort/nichtblockierend.
Die GitHub-Docker-CI baut ebenfalls ausschließlich in Docker.
Bestätigter Lauf [37153110560](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/37153110560):
alle drei Tests und Runtime-Smoke-Test erfolgreich; dies ersetzt keinen Pi-Empfangstest.

**Realer Empfang bestätigt:** Subscriber-Auszug des Projektinhabers vom 2026-10-03,
21:03:18–21:03:46 UTC (23:03:18–23:03:46 Europe/Vienna), zeigt 15 erfolgreiche
Reader-Samples im 2-Sekunden-Takt plus `availability online`. Zustand B1,
angeschlossen/nicht ladend, Fehlercode 0, Limit 6 A, Ströme/Leistung 0 und
Spannungen ungefähr 233–236 V. Das bestätigt Wallbox → Reader → vorhandener
Broker → Subscriber, nicht Langzeitstabilität oder Ausfallverhalten am Pi.
Weboverlay siehe Abschnitt 9, MariaDB-Speicherung Abschnitt 10; Home Assistant, UART-MQTT-Bridge und
Ladesteuerung bleiben geplant.

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

### Erwartete Meldungen und Funktionstest

Wenn der ESP32 bootet und die Brücke bereits lauscht:

```text
EVSE UART bridge: listening on /dev/serial0 @ 115200 baud
RX <- ESP32: EVSE:STATUS:CHARGING:OFF:SRC:boot
RX <- ESP32: EVSE:STATUS:ANTITHEFT:INACTIVE:SRC:boot
```

Ein schon laufender ESP32 sendet beim Start der Pi-Brücke nicht automatisch
erneut seine Bootmeldungen. Mit `status` beide Zustände abfragen.

Im USB-Serial-Monitor des ESP32 (115200 Baud) erscheinen zusätzlich etwa:

```text
MFRC522 firmware version: 0x82
EVSE RFID controller started
```

`0x91`/`0x92` sind übliche MFRC522-Kennungen; `0x82` wurde an der vorhandenen
Hardware beobachtet und zeigt SPI-Erreichbarkeit, nicht allein vollständige
RFID-Funktion. `0x00`/`0xFF` deuten auf Verdrahtungs-/Versorgungsprobleme hin.

Mit einer lesbaren 13,56-MHz-Karte wird zuerst verriegelt, beim nächsten Tap
entriegelt. Der Servo startet bei 0°, erster Tap bewegt ihn auf 90°:

```text
RX <- ESP32: EVSE:RFID:CARD:UID:AB:CD:EF:12
RX <- ESP32: EVSE:STATUS:ANTITHEFT:ACTIVE:SRC:rfid
RX <- ESP32: EVSE:STATUS:ANTITHEFT:INACTIVE:SRC:rfid
```

Jeder Tap meldet außerdem seinen UID-Event. Der Servo ist unabhängig vom
Ladevorgang. Derzeit akzeptiert die Firmware jede lesbare Karte, keine Whitelist.

| Symptom | Prüfen |
|---|---|
| `raspberrypi login:`/`Password:` statt Protokoll | Serielle Login-Konsole noch aktiv; Hardwarefreigabe gemäß Abschnitt 8 prüfen |
| Keine Bootmeldungen | `status` versuchen, TX/RX/Masse, Gerätepfad und Firmware prüfen; USB-Monitor zum Vergleich |
| SPI-Kennung vorhanden, keine Kartenreaktion | 13,56 MHz statt 125 kHz, Position/Abstand zur Antenne und Reader-Verdrahtung prüfen |
| Auch USB-Monitor ohne Ausgabe | Monitorbaudrate, ESP32-Versorgung und Flash prüfen |

## 7. Was für eine spätere Wiederholung gesichert werden muss

- Verwendeter Git-Commit/Branch und Imageversionen bzw. Digests.
- Eigene Wallbox-Gerätepfade, Baudrate/Parität/Slave-ID und Pollingparameter.
- Brokername, ursprüngliche Broker-Start-/Compose-Konfiguration und Volumes.
- Netzwerk `evse-mqtt` und Broker-Alias `mqtt-broker`.
- Testergebnisse: Read/Timeouts, beobachtete Zustände und MQTT-Bestätigungen.
- Secrets separat sichern; keine Passwörter, Schlüssel oder VPN-Konfiguration
  in Git einchecken. Grafana/MariaDB und andere bestehende Dienste nicht ersetzen.

Der Guide deckt Projektbetrieb, MQTT-Anbindung und Hardware-/Setup-Referenz
ab. Eine komplette Neuinstallation benötigt zusätzlich OS-/Docker-Installation,
SSH/WireGuard, die konkrete udev-Gerätezuordnung und ursprüngliche Broker-
Einrichtung. Diese Voraussetzungen nicht als erledigt behaupten.
**Bei jedem neuen Einrichtungsschritt diesen Guide aktualisieren.**

## 8. Hardware und Erstvorbereitung

Dieser Abschnitt übernimmt die Hardware-/Setup-Inhalte der früheren separaten
Anleitung. **Referenz für einen neu vorbereiteten Aufbau, nicht ungeprüft auf
dem funktionierenden Remote-Pi ausführen.** Änderungen an Zugang, UART-Freigabe
oder Reboots vorher abstimmen; Netzspannungsarbeiten nur durch Fachkräfte.

### Benötigte Hardware

- Raspberry Pi 3/4 mit Raspberry Pi OS (z. B. Bookworm) und microSD.
- ESP32 DevKit (z. B. WROOM-32), MFRC522 und passende 13,56-MHz-Karten.
- Modellservo (z. B. SG90), geeignete 5-V-Versorgung und gemeinsame Masse.
- Drei Leitungen für Pi-ESP32-UART (TX, RX, GND).
- USB-RS485-Adapter mit RS485-Transceiver und ABB Terra AC.

### Raspberry-Pi-Erstvorbereitung

Docker-only betrifft Projektsoftware. OS-Gerätefreigaben sind davon getrennt.
WiFi/SSH/WireGuard müssen vorhanden sein; hier keine Projektpakete nachinstallieren.
Die früher verwendeten WiFi-/SSH-Schritte sind nur Referenz für einen neuen Pi:

```bash
nmcli device wifi list
nmcli device wifi connect "SSID" password "PASSWORD"
sudo systemctl enable --now ssh
```

`SSID`/`PASSWORD` sind Platzhalter; reale Zugangsdaten nicht in Git oder Chat
speichern. Aktuelle Remote-Netzwerkverbindung nicht mit diesen Befehlen ersetzen.
WireGuard-Einrichtung ist noch keine vollständig dokumentierte Neuinstallation.

UART-Freigabe bei einem neuen Aufbau:

```bash
sudo raspi-config
```

Unter **Interface Options → Serial Port**:

- Serielle Login-Shell: **No**.
- UART-Hardware aktivieren: **Yes**.

Falls dafür erforderlich, einen abgestimmten Neustart durchführen. Anschließend:

```bash
ls -l /dev/serial*
```

Optionales Tastaturlayout: **Localisation Options → Keyboard → German**.
Keinen Neustart des Remote-Pi ohne gesicherten Wiederzugriff veranlassen.

### UART-Verdrahtung: Pi und ESP32

Beide Seiten verwenden 3,3-V-Logik. TX/RX kreuzen, gemeinsame Masse verbinden:

| Raspberry Pi | ESP32 | Signal |
|---|---|---|
| GPIO14/TXD, Pin 8 | GPIO16/Serial2 RX | Pi → ESP32 |
| GPIO15/RXD, Pin 10 | GPIO17/Serial2 TX | ESP32 → Pi |
| GND, Pin 6 | GND | gemeinsame Masse |

**Keine 5 V an ESP32-GPIOs.** Ausführliche [Pinbelegung](pin-connection.md).

### MFRC522 über SPI

| MFRC522 | ESP32 |
|---|---|
| SDA/SS | GPIO5 |
| SCK | GPIO18 |
| MOSI | GPIO23 |
| MISO | GPIO19 |
| RST | GPIO22 |
| 3.3V | 3.3V |
| GND | GND |

IRQ bleibt unverbunden; Firmware fragt den Reader zyklisch ab. Mit 3,3 V
versorgen, nicht 5 V. Karten müssen 13,56 MHz verwenden, keine 125-kHz-Tags.

### Anti-Theft-Servo

| Servo | Verbindung |
|---|---|
| Signal | ESP32 GPIO13 |
| VCC | geeignete 5-V-Versorgung |
| GND | gemeinsame Masse mit ESP32/Pi |

Nicht aus der ESP32-3,3-V-Schiene versorgen. 0° bedeutet entriegelt/inaktiv,
90° verriegelt/aktiv; RFID toggelt unabhängig vom Laden. Bootzustand: 0°.

### ESP32 flashen

Auf dem Entwicklungsrechner mit vorhandenem PlatformIO/VS Code das Verzeichnis
`esp32/` öffnen; Flashen setzt Zugang zum USB-Anschluss des ESP32 voraus:

```bash
pio run -t upload
```

Dies ist keine Anleitung zur PlatformIO-Installation auf dem Pi-Host und kein
bereits eingerichteter Remote-Flashweg. Firmware initialisiert RFID/Servo und
UART mit 115200 Baud. Funktionstest siehe [Abschnitt 6](#6-optionale-esp32-uart-testbrücke).

### RS485 zur Wallbox

Pi USB → USB-RS485-Adapter → ABB Terra AC. Keine ESP32-GPIOs beteiligt.
Ein reiner USB-UART-Adapter ohne RS485-Transceiver reicht nicht aus.

| USB-RS485-Adapter | Wallbox |
|---|---|
| A/D+ | RS485 A |
| B/D− | RS485 B |
| GND | gemäß Hersteller-Vorgaben, sofern entsprechender Anschluss vorhanden |

Klemmen/Verdrahtung mit dem Terra-AC-Installationshandbuch abgleichen. In
**Terra Config → Communication Settings**: Modbus RTU, Wallbox als Secondary,
57600 Baud, Even-Parität, 8 Datenbits, 1 Stoppbit, Slave-ID 9.

`/dev/ttyUSBEVSEcontrol` ist der bestehende udev-Symlink; Rohgerät häufig
`/dev/ttyUSB0`. Konkrete udev-Regel ist noch nicht als Neuinstallation dokumentiert.
Docker-Test und Betrieb stehen einmalig in [Abschnitt 3](#3-wallbox-reader-bauen-und-einmal-testen).

### Optionale Einzelabfrage mit mbpoll im Diagnosecontainer

Nur wenn der vorhandene `deb-mbpoll`-Container den Adapter durchgereicht bekommt.
Reader und andere Master zuerst stoppen; vom Repository-Hauptverzeichnis:

```bash
docker compose -f rasppi/wallbox/compose.yaml stop wallbox-reader
docker exec -it deb-mbpoll mbpoll /dev/ttyUSBEVSEcontrol -m rtu -a 9 -c 2 -0 -1 -b 57600 -P even -s 1 -r 16396 -t 4
```

Das liest zwei 16-Bit-Rohregister des Ladezustands per FC03. `-t 3` in älteren
Beispielen bedeutet FC04; es ist nicht dieselbe Funktion. FC03 wurde an der
vorhandenen Wallbox für den Reader-Block bestätigt. Kein mbpoll auf dem Host
installieren, keinen parallelen Read starten. Mehr [Registerreferenzen](wallbox/).

### Wallbox-Grenzen

- Kommunikations-Timeout laut Handbuch standardmäßig 60 s; Reader-Intervall
  2 s sicher darunter halten. Fehlgeschlagene Reads beweisen keinen Watchdog-Reset.
- Stromlimits unter 6 A pausieren das Laden; tatsächliches Limit separat
  auslesen. 6 A Limit bedeutet nicht automatisch tatsächliches Laden.
- Wallbox-Socket-Lock existiert nur bei passenden Modellen; unabhängig vom
  ESP32-Modellservo. Entriegelungsbedingungen im Herstellerhandbuch beachten.
- Start-/Stop-Notizen sind widersprüchlich. Handbuch v1.7 nennt 0=Start, 1=Stop;
  die Reader-Anwendung sendet **keine Schreibbefehle**. Keine unvalidierten
  Steuerbefehle ausführen oder diese Fähigkeiten als implementiert darstellen.
- ABB-Handbuch: [Modbus v1.7](wallbox/ABB_Terra_AC_Charger_ModbusCommunication_v1.7.pdf).

## 9. Lesendes Weboverlay

### Aufbau und Voraussetzungen

`rasppi/weboverlay/` ist ein eigener Docker-Dienst. Sein Python-/Flask-Backend
abonniert mit Paho die bestehenden MQTT-Topics; Gunicorn liefert API und statische
Browseroberfläche aus. **Kein zusätzlicher Broker, kein Zugriff auf RS485/UART,
keine Schreibbefehle.** Der laufende Wallbox-Reader muss nicht gestoppt werden.

Voraussetzungen: Abschnitt 5 eingerichtet (`evse-mqtt`, `mqtt-broker`), laufender
Reader und aktueller Repository-Stand nach Merge der Weboverlay-PR. Build und
Tests benötigen keine Wallbox, Tests verwenden nur einen isolierten Loopback-Broker.

### Auf dem Pi starten

Aus dem Repository-Verzeichnis:

```bash
git switch main
git pull --ff-only
cd rasppi/weboverlay
test -e .env || cp .env.example .env
docker compose up -d --build
docker compose logs --tail 30 -f weboverlay
```

`Ctrl+C` beendet nur die Logansicht. Das Image führt beim Build automatisch
Python-/HTTP-/MQTT- und JavaScript-Tests aus; ein Testfehler bricht den Build ab.
Weder Compiler noch Python-/Node-/pip-Pakete auf dem Pi-Host installieren.

Der Dienst bindet den Hostport bewusst **nur an `127.0.0.1:8080`**. Es werden
keine Firewall-, SSH-, WireGuard- oder Routereinstellungen verändert. Kein
HTTP-Login und kein TLS in dieser ersten Version: nicht ins Internet freigeben.

### Browserzugriff über vorhandenes SSH/WireGuard

Auf **deinem Rechner**, in einem separaten Terminal, nicht auf dem Pi:

```bash
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8080:127.0.0.1:8080 'BENUTZER@PI-ADRESSE'
```

`BENUTZER@PI-ADRESSE` ist ein Platzhalter: denselben Benutzer und dieselbe
Pi-Adresse oder deinen vorhandenen SSH-Alias wie bei deiner üblichen
SSH-Verbindung über WireGuard einsetzen. Das tatsächliche Ziel nur lokal in
deiner SSH-Konfiguration/privaten Einrichtungsnotiz aufbewahren, nicht im Repository.
Keine neue öffentliche IP/Freigabe
einrichten. Terminal offen lassen und im Browser **http://127.0.0.1:8080** öffnen.
`Ctrl+C` beendet den Tunnel, nicht den Pi-Webdienst oder Reader.

Ist Port 8080 **auf deinem Rechner** belegt, links 8081 wählen:

```bash
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8081:127.0.0.1:8080 'BENUTZER@PI-ADRESSE'
```

Dann http://127.0.0.1:8081 öffnen. Ist Port 8080 hingegen **auf dem Pi** belegt,
`WEB_PORT=8081` in der lokalen Weboverlay-`.env` setzen, Compose erneut starten
und auch das rechte Tunnelziel auf `127.0.0.1:8081` ändern. Vorhandene Dienste
nicht stoppen/ersetzen, um den Port frei zu machen.

### Erwartete Anzeige und Frische

Startseite **Übersicht** (`/`): kompakte Karten für Wirkleistung, Fahrzeug,
Sessionenergie und Wallbox-Limit, darunter Phasenmessung/Leistungsrahmen.
Technische Rohwerte und Detailprotokoll sind unter **„Diagnose & Datenqualität“**
einklappbar. Navigation am Desktop links, auf kleinen Bildschirmen oben;
helles/dunkles Farbschema folgt dem Browser. Datenstatus, Messzeit, Frische und
aktive Fehlerwarnungen sind nicht in den einklappbaren Bereichen versteckt.

**Diagramme** über die Navigation oder direkt **http://127.0.0.1:8080/diagramme**
öffnen (bei abweichendem Tunnelport entsprechend anpassen). Separate Seite,
gleicher Container/SSH-Tunnel, keine neue Freigabe. Vier elektrische Diagramme;
weitere Kurven unter **„Zustands- & Diagnoseverläufe“** öffnen.

Die Oberfläche zeigt Fahrzeuganschluss und tatsächliches Laden getrennt,
Phasenströme/-spannungen, Wirkleistung, Sessionenergie, Wallbox-Limit, Fehlercode
und Messzeit. **Verfügbarer Gebäudestrom ist noch nicht erfasst**; dafür fehlt
die DTSU666-Anbindung. Die Wallbox-Verriegelung ist nicht der ESP32-Servo.
Es gibt keine Start-/Stop-, Limit- oder frei eingebbaren Steuerbefehle.

Messwerte erscheinen nur, wenn Brokerverbindung, `availability online`, ein
gültiges `status=ok`-Sample und dessen Frische zusammenpassen. Default maximal
10 s Samplealter, mehr als 5 s Zukunftsabweichung wird abgelehnt. Pi-/Reader-Uhr
müssen stimmen; große Zeitfehler nicht durch eine großzügige Frist kaschieren.
Readfehler, ungültige Payloads, fehlende Verfügbarkeit, Brokerverlust oder zu alte
Daten blenden die Messwerte aus. Unbekannte Anschluss-/Ladezustände sind nicht
`false`, sondern „Unbekannt“. Ein Wallbox-Fehlercode wird separat angezeigt;
eine funktionierende Datenverbindung bedeutet nicht fehlerfreie Hardware.

Der Browser fragt `/api/state` ungefähr jede Sekunde ab, verwirft Werte auch
bei API-Ausfall und lässt sie unabhängig von weiteren HTTP-Antworten ablaufen.
Eine unterbrochene Verbindung wird nicht zwingend sofort erkannt, aber alte
Messwerte bleiben nicht unbegrenzt als „aktuell“ sichtbar. Retained MQTT-Werte
werden nach Backend-Reconnect erst mit beiden Topics und gültiger Frische gezeigt.

### Diagramme und Messwerte auswählen

Unter **„Anzeige auswählen“** jeden der 16 Messwerte einzeln ein-/ausblenden.
Die Auswahl gilt auf **beiden Seiten** für die aktuelle Anzeige und die zugehörige
Diagrammkurve/Legende. L1/L2/L3 können einzeln gewählt werden; wenn alle Ströme
oder Spannungen abgewählt sind, verschwindet die entsprechende Tabellenspalte.
Leere Messwertkarten/Diagramme werden ausgeblendet. Verbindung, Frische, Messzeit
und aktive Wallbox-Fehlerwarnungen bleiben zur Sicherheit sichtbar.

**„Alle Messwerte anzeigen“** setzt Auswahl und Zeitfenster auf die Defaults
zurück. Auswahl/Zeitraum werden in diesem Browser im localStorage unter
`evse-display-v1` gespeichert, weder auf dem Pi noch kontoübergreifend.
Blockierter/defekter Browserspeicher darf die Anzeige nicht verhindern; dann
gelten Defaults beziehungsweise die Auswahl der geöffneten Seite. Zum vollständigen
Zurücksetzen ggf. nur diesen Eintrag in den Browser-Websitedaten löschen.
Keine Zugangsdaten oder Messwertverläufe werden im localStorage gespeichert.
Bei Rückkehr über Browser-Zurück/Vorwärts werden gespeicherte Einstellungen
erneut gelesen; ohne lesbaren Speicher bleiben temporäre Einstellungen erhalten.

Zeitverläufe nutzen native SVG, keine zusätzlichen Pakete/CDNs. Zeitfenster
**1, 5 oder 15 Minuten**, Default 5. Leistung kW, Strom A, Spannung V,
Sessionenergie kWh; Bool-Zustände zeigen Nein/Ja, unbekannte Zustände Lücken.
Codes/Rohwerte sind separate Stufendiagramme, keine physikalischen Messgrößen.
Skalierung erfolgt je Diagramm; Spannungen sind automatisch skaliert, die
Achsenwerte stehen links. Phasenkurven werden mit Farben und Linienstilen unterschieden.

Der Verlauf beginnt erst mit Öffnen der **Diagrammseite** und liegt ausschließlich
im RAM des Tabs (maximal 15 Minuten/1200 Zeitpunkte). Die Übersicht sammelt keinen
Diagrammverlauf. **Neuladen und Seitenwechsel leeren die Daten**, nicht die
Anzeigeauswahl; auch Rückkehr aus dem Browser-Seitencache startet neu.
Erste Messung: einzelner Punkt; eine Linie entsteht erst
mit weiteren verschiedenen Zeitmarken. Doppelte API-Antworten erzeugen keine
zusätzlichen Punkte; gleiche Sekunden-Zeitmarken behalten den zuletzt beobachteten
Wert, da Schema 1 keine Subsekunden unterscheidet. Kurze Zwischenwerte/Fehler
zwischen Browserabfragen können fehlen; dies ist kein lückenloses Datenarchiv.

Offline, Lesefehler, ungültige/veraltete Daten, Tabwechsel und unbekannte Werte
unterbrechen Kurven. Zeitabstände >10 s werden ebenfalls nicht verbunden;
eine rückwärts springende Browseruhr leert den Verlauf. Nach Wiederverbindung
werden keine Messungen rückwirkend nachgeladen oder Nullwerte erfunden.
**Historische Linien bleiben bei Offline sichtbar** und sind ausdrücklich als
historisch markiert; aktuelle Werte bleiben dann ausgeblendet. Maus über den
letzten Punkt zeigt dessen Wert/Zeit. Sessionenergie ist je Ladesitzung und
kann zurückgesetzt werden, nicht der Gesamtverbrauch.

Update der Dashboard-/Diagrammversion nach Merge, auf dem Pi:

```bash
cd ~/EVSE-Control
git switch main
git pull --ff-only
cd rasppi/weboverlay
docker compose up -d --build
```

Reader/Broker weiterlaufen lassen. Bestehenden SSH-Tunnel wie oben nutzen und
die Seite neu laden; bei altem Browsercode notfalls mit Strg+F5 aktualisieren.
Keine neue Netzwerk-/SSH-Freigabe oder Host-Pakete erforderlich.

Nach dem Update auf `/` aktuelle Werte/Status prüfen, dann über **Diagramme**
wechseln: `/diagramme`, gleiches Status-/Warnungsband, Verlauf ab Seitenöffnung.
Die Diagnosekurven aufklappen. Eine Anzeigeoption ändern und zurück zur Übersicht
wechseln: die Auswahl bleibt, der Diagrammverlauf nicht. Mobilansicht ebenfalls
prüfen; unbekannte/offline Werte dürfen nicht als Null oder „Nein“ erscheinen.
Eine echte Pi-/Browserprüfung ist dadurch beschrieben, nicht bereits bestätigt.

Diagramm-CI [37204010318](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/37204010318)
bestätigt 21 Python-/MQTT-/HTTP-Tests, 27 JavaScript-Tests und beide Chromium-
Browsersuiten (Auswahl, Persistenz, Phasenspalten, mobile SVGs, Ausfalllücken).
Desktop-/Mobilbilder verwenden simulierte Werte; echten Pi-Empfang/Browserverlauf
separat prüfen, nicht aus diesen Screenshots ableiten.

Abschließende Dashboard-CI [37220843434](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/37220843434)
bestätigt 21 Python-/MQTT-/HTTP- und 28 JavaScript-Tests plus drei Chromium-Suiten:
beide Seiten in hell/dunkel bei 320/390/768/1440 px, Navigation/Tastatur, Auswahl,
geschützte Warnungen/Frische, CSP und blockierter Browserspeicher. Simulierte
Desktop-/Mobilbilder wurden geprüft; Seitencache-Rückkehr lädt gemeinsame
Einstellungen neu beziehungsweise bewahrt temporäre Auswahl bei blockiertem
Speicher. PR-CI `37221004357` ebenfalls erfolgreich. Die echte Pi-Browserprüfung
bleibt offen. PR #33 wurde durch den Projektinhaber gemergt; obige Updatefolge verwenden.

### Lokale Konfiguration und optionale Zugangsdaten

Eigene `.env` unter `rasppi/weboverlay/`, unabhängig von `rasppi/wallbox/.env`:

| Variable | Default / Bedeutung |
|---|---|
| `WEB_PORT` | `8080`, Hostport ausschließlich auf Pi-Localhost |
| `WEB_STALE_SECONDS` | `10`, zulässig 3–120 s; an Reader-Intervall anpassen |
| `MQTT_HOST`, `MQTT_PORT` | `mqtt-broker`, `1883` |
| `MQTT_TOPIC_PREFIX` | `evse/wallbox`, muss zum Reader passen |
| `MQTT_CLIENT_ID` | `evse-weboverlay`, **nicht** die Reader-Client-ID verwenden |
| `MQTT_USERNAME`, `MQTT_PASSWORD` | optional, lokal; Passwortdatei bevorzugen |
| `MQTT_PASSWORD_FILE` | gemounteter Containerpfad, mit Auth-Override gesetzt |

Nur Leserechte auf `<Präfix>/state` und `<Präfix>/availability` sind erforderlich;
der Dienst veröffentlicht selbst nichts. MQTT-Zugangsdaten bleiben im Backend
und gelangen nicht zum Browser. Ein Broker ohne diese Abonnementrechte liefert
keine aktuelle Anzeige. Bei Änderungen `docker compose up -d --force-recreate`.

Wenn euer Broker Authentifizierung benötigt: vorhandene Passwortdatei außerhalb
des Repositorys mit Passwort in der ersten Zeile verwenden. In der lokalen
`.env` `MQTT_USERNAME` und `MQTT_PASSWORD_HOST_FILE=/absoluter/host/pfad` setzen.
Die Datei muss für Container-UID **10001** lesbar sein (z. B. gezielt Eigentümer
10001 und Modus 0400 für eine eigens dafür angelegte Kopie setzen; nicht die
Broker-Datei ändern oder pauschal weltlesbar machen). Beispiel für diese Kopie:

```bash
sudo chown 10001:10001 /absoluter/host/pfad
sudo chmod 0400 /absoluter/host/pfad
docker compose -f compose.yaml -f compose.auth.yaml up -d --build
```

Platzhalter durch den echten Pfad ersetzen. Der Override mountet read-only nach
`/run/secrets/mqtt-password`; nicht beide Passwortmethoden kombinieren. Bei dieser
Betriebsart dieselben `-f`-Optionen auch für Updates/Logs/Stop verwenden. Keine
Secrets committen, in Chat posten oder als CLI-Argumente weitergeben.

### Diagnose, Tests und Update

Im Verzeichnis `rasppi/weboverlay/`:

```bash
docker compose ps
docker compose logs --tail 50 weboverlay
docker compose exec -T weboverlay python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8080/api/state', timeout=3).read().decode())"
```

`/healthz` prüft nur die Webserver-Erreichbarkeit, nicht MQTT-/Wallbox-Verfügbarkeit.
Container „healthy“ und Oberfläche „offline“ widersprechen sich deshalb nicht.
Ein Broker-Ausfall darf den Webserver nicht in eine Neustartschleife treiben.
Bei „Warte auf Daten“ Präfix, Reader-Publishing, Broker-Abonnementrechte und Uhrzeit
prüfen. Für MQTT-Diagnose weiterhin den Subscriber aus Abschnitt 5 verwenden.

Tests unabhängig von Hardware wiederholen, vollständig in Docker:

```bash
docker build --target test -t evse-weboverlay-tests .
docker run --rm evse-weboverlay-tests python -m unittest discover -s tests -v
docker run --rm evse-weboverlay-tests node --test tests/frontend.test.cjs tests/charts.test.cjs
```

Update nach Git-Aktualisierung: `docker compose up -d --build`.
Stoppen: `docker compose down`. Das betrifft nur das Weboverlay, nicht Reader
oder vorhandenen Broker. Der Dienst speichert keinen serverseitigen Verlauf; nach Neustart
werden neue/retained Nachrichten erneut geprüft. Kein Datenbankdienst enthalten.
Gunicorn bleibt bei **einem Worker** mit mehreren HTTP-Threads; mehrere Worker
würden getrennte Snapshots und konkurrierende MQTT-Client-IDs erzeugen.
Blockierende OS-DNS-Auflösung im MQTT-Thread kann das saubere Beenden verzögern;
Gunicorn-/Compose-Stopfristen begrenzen dann den Prozess statt eine erfolgreiche
MQTT-Abmeldung zu garantieren. Das Overlay veröffentlicht selbst nichts und
besitzt keinen Hardwareport, auch ein erzwungenes Beenden stoppt den Reader nicht.

Docker-CI [37200290345](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/37200290345)
bestätigt 21 Python-/MQTT-/HTTP-Tests, 13 JavaScript-Tests und Chromium-Browsertests sowie das
gehärtete Laufzeit-Image ohne Broker. Desktop-/Mobil-Screenshots mit simulierten
Messwerten wurden geprüft; das ist kein Nachweis der Browseranzeige am echten Pi.
Browser-Regressionen prüfen auch Ablauf ohne Antwort, hängende/verspätete Requests,
Abort-Verhalten, simulierte Visibility-/Pageshow-Ereignisse, fehlende Fetch-
Parallelität und unveränderte Live-Region-Texte. Simulatorereignisse sind kein
vollständiger Nachweis aller Bfcache-/Suspend-Varianten jedes Browsers.

**Noch zu bestätigen:** tatsächlicher Pi-Start und Browseranzeige über deinen
Tunnel. Die automatischen Tests ersetzen diese Bedien-/Deploymentprüfung nicht.

## 10. MQTT-Zustandsspeicherung in der vorhandenen MariaDB

**Erster Datenbankabschnitt:** Wallbox-Samples (auch Lesefehler) und Availability-
Beobachtungen speichern. Keine Ladesteuerung, SQL-Diagrammabfrage, RFID-/UART-
oder Zählerdaten. Weboverlay bleibt unverändert: Live-MQTT und Browser-RAM-Verlauf.
Die Produktions-Compose startet **keinen DB-Server und keinen Broker**.

### Bestehende Datenbank prüfen, nicht ersetzen

Der Projektinhaber hat am 2026-10-04 per Containerübersicht bestätigt: **`maria_uno`**, Image
**`mariadb:lts`**, Hostport 3306 an allen IPv4/IPv6-Schnittstellen. Das ist kein
Nachweis öffentlicher Erreichbarkeit (Firewall/Netz unbekannt) oder konkreter
Serverversion. Ein weiterer Screenshot bestätigt ausschließlich Standardnetz
`bridge`, ohne Alias. Ein dritter Screenshot bestätigt die installierte Server-
Binary **11.8.8-MariaDB-ubu2404 auf aarch64** und ein lokales Docker-Volume RW
nach `/var/lib/mysql`. Volume ist kein Backup; dessen lange automatisch wirkende
Namenskennung und Mount erhalten, nicht neu initialisieren/löschen. Accounts,
TLS und Backupverfahren bleiben unbekannt. Vor Einrichtung lokal auf dem Pi
prüfen (keine Passwörter posten):

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
# <mariadb-container> durch den tatsächlich gefundenen Namen ersetzen:
docker inspect --format '{{.Config.Image}}' <mariadb-container>
docker inspect --format '{{json .NetworkSettings.Networks}}' <mariadb-container>
docker inspect --format '{{json .Mounts}}' <mariadb-container>
```

Für den bestätigten aktuellen Container sind die nächsten reinen Diagnosebefehle:

```bash
docker inspect --format '{{json .NetworkSettings.Networks}}' maria_uno
docker inspect --format '{{json .Mounts}}' maria_uno
docker exec -it maria_uno mariadb -u root -p -e 'SELECT VERSION();'
```

Adminpasswort nur lokal am Prompt eingeben. Bei anderer vorhandener Admin-
Authentifizierung das bestehende Verfahren nutzen; keine Root-Freigabe anlegen.
`mariadb:lts` kann bei Neuerstellung eine andere Version bezeichnen. Nicht neu
erstellen/upgraden, nur um die Version herauszufinden. Portbindung ist ein
separater Sicherheitspunkt: nicht als abgesichert behaupten und nicht ohne
Auftrag ändern. Collector selbst veröffentlicht keinen Hostport.

Der berichtete Versuch mit `root -p` wurde mit **1045 / Access denied** abgewiesen.
Das beweist weder eine defekte DB noch eindeutig ein falsches Passwort; Account,
Authentifizierungsart und ursprünglicher Adminzugang müssen geklärt werden.
DB-Adminpasswort ist nicht automatisch das SSH-Passwort. Keine Passwörter teilen,
keinen Container/Volume löschen und keinen Passwortreset ohne gesonderten Auftrag.
Version der installierten Server-Binary und Mounts sind unabhängig vom Login lesbar:

```bash
docker exec maria_uno mariadbd --version
docker inspect --format '{{json .Mounts}}' maria_uno
```

Binary-Version ist nicht dieselbe Bestätigung wie `SELECT VERSION()` am laufenden
Server. Die Mount-Ausgabe liegt nun vor, der sichere Adminzugang weiterhin nicht.
Früher wurde ein lesender Socket-Login als Diagnose vorgeschlagen; ein Erfolg
ist nicht bestätigt. **Der Projektinhaber hat keinen autorisierten DB-Adminzugang und hat
MariaDB nicht eingerichtet: jetzt keine weiteren Loginversuche durchführen.**
Nur der berechtigte Betreiber kann bei Bedarf und mit gesondertem Auftrag prüfen,
ob Root per lokalem Unix-Socket authentifiziert ist:

```bash
docker exec -it maria_uno mariadb --protocol=socket -u root -e 'SELECT VERSION();'
```

Das ändert keine Passwörter oder Accounts. Erneutes 1045 heißt nicht, dass die DB
neu aufgebaut werden muss: vorhandenen Adminzugang/ursprüngliche geschützte
Einrichtung klären, nicht Passwörter raten oder Env-/Secretwerte teilen.
Bis sicherer Adminzugang geklärt ist, keine Accounts/Migration oder Server-/
Netzänderung vornehmen.

**Aktueller Blocker:** Der Projektinhaber hat keinen DB-Adminzugang. Zuerst klären, wer MariaDB
eingerichtet/verwaltet hat. Dieser berechtigte Betreiber kann das eigene EVSE-
Schema sowie Runtime-/Migrationsaccount wie unten bereitstellen, ohne Root-
Passwort weiterzugeben. App-Secrets ausschließlich lokal/sicher übergeben.
Falls der Projektinhaber die ursprüngliche Einrichtung selbst verwaltet, deren geschützte
Compose-/Env-/Secret-Dateien nur lokal prüfen, keine Inhalte in Chat/Git/logs teilen.
Keine weitere Passwortsuche durch Raten, kein Ersatzserver, keine Neuinitialisierung
des Volumes. Passwort-Recovery/Reset erfordert gesonderten Auftrag, geprüftes Backup,
Ausfallplanung und Rücksicht auf bestehende DB-Nutzer; ist hier nicht durchgeführt.

Der Projektinhaber hat MariaDB nicht selbst eingerichtet. Daher den bestehenden berechtigten
Betreiber kontaktieren, statt fremde Einrichtungs-Secrets zu suchen. Root ist
**kein Pflichtaccount**: ein anderer DB-Login mit den nötigen Account-/Grant-
Rechten kann provisionieren. SSH-/Dockerrechte geben nicht automatisch SQL-Rechte.
Dem Betreiber folgende Anforderung weitergeben (SQL-Beispiele siehe unten):

- Eigenes, noch unbenutztes Schema `evse_control`, UTF-8; keine Grafana-/Fremdtabellen nutzen.
- `evse_storage`: ausschließlich SELECT/INSERT in diesem Schema für Dauerbetrieb.
- Separater `evse_migrator`: SELECT/INSERT/CREATE in diesem Schema, nur für explizite
  Initialisierung. Alternativ führt der Betreiber die initiale Migration selbst aus.
- Nur App-Accounts/-Secrets sicher lokal bereitstellen, kein Root-Passwort an Agent/Chat.
- Bestehendes Datenvolume/Backup sichern und den zulässigen lokalen Docker-Zugangsweg klären.

Ohne passenden DB-Zugang bleibt nur das Pi-Deployment blockiert; Entwicklung und
die isolierten Docker-Tests benötigen keine Produktionsrechte.

Keine komplette `docker inspect`-/Env-Ausgabe teilen: sie kann Credentials enthalten.
Falls MariaDB nicht als Container läuft, zunächst deren tatsächlichen sicheren
Zugangsweg klären; keine Container-Aliasbefehle blind auf einen Hostdienst anwenden
oder dafür dessen Bindadresse/Firewall ohne Auftrag öffnen.
Serverversion zusätzlich mit `SELECT VERSION();` im bestehenden DB-Client prüfen.
CI [37212624186](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/37212624186)
bestätigt je 39 Tests + Runtime unter 10.11.19, exakt **11.8.8** und 11.8.9.
Der rollende `11.8`-Tag bezeichnet nicht zwingend die bestätigte installierte 11.8.8;
CI ist amd64 und kein echter Pi-ARM64-/Zugriffstest. Andere Versionen erst prüfen, niemals
den bestehenden Server/Volumes zum Erfüllen dieser Versionsangabe ersetzen.
Vor Änderungen bestehende Backup-/Restorefähigkeit klären. Keine globalen
SQL-Settings, WireGuard/SSH, Portfreigaben oder fremden Schemas ändern.
Dieser Schritt bietet kein DB-/MQTT-TLS; falls vorhandene DB TLS verlangt,
Unterstützung vor Deployment ergänzen, nicht die Serverpflicht deaktivieren.

### Docker-Netzwerk und Alias

Collector benötigt das vorhandene `evse-mqtt` für `mqtt-broker` und ein **externes
DB-Netzwerk**. MariaDB muss nicht im MQTT-Netz stehen. Entweder geeignetes bestehendes
DB-Netz als `DB_NETWORK` verwenden oder nach Prüfung ein eigenes `evse-data`
vorbereiten. Beispiel für die bewusste manuelle Vorbereitung, nicht automatisch
von Compose ausgeführt:

```bash
docker network inspect evse-data
# Nur wenn es noch nicht existiert und dieses Netzwerk gewünscht ist:
docker network create evse-data
# Nur wenn MariaDB noch nicht dort mit passendem Alias verbunden ist:
docker network connect --alias evse-database evse-data <mariadb-container>
```

`DB_HOST=evse-database` gilt nur nach dieser tatsächlichen Aliaszuordnung;
alternativ vorhandenen erreichbaren DB-Alias eintragen. `127.0.0.1` im Collector
ist nicht MariaDB/Pi-Localhost. Kein neues Host-Portmapping erforderlich.
Manuelle Netzwerkzuordnung überlebt Containerneustart, nicht dessen Neuerstellung.
Die ursprüngliche MariaDB-Compose muss später dasselbe externe Netz/Alias pflegen;
deren bisher unbekannte Definition/Volumes keinesfalls durch Beispiel-Compose ersetzen.

### Eigene Datenbank und zwei Accounts

Einen **eigenen**, bisher unbenutzten Schemanamen (Default `evse_control`) verwenden.
Wenn Schema/Accounts bereits existieren, zuerst Zweck/Grants klären; nichts löschen,
keine Passwörter vorhandener Grafana-/Root-Accounts ändern. Namen in SQL und `.env`
müssen übereinstimmen. Datenbankname: ASCII-Buchstaben, Ziffern, Unterstrich.

Mit bestehendem Adminzugang im vorhandenen Container interaktiv arbeiten:

```bash
docker exec -e MYSQL_HISTFILE=/dev/null -it <mariadb-container> mariadb -u root -p
```

`-p` ohne Passwortwert, Eingabe am Prompt. Wenn Root anders authentifiziert ist,
das bestehende sichere Adminverfahren verwenden, keine neue Root-Freigabe anlegen.
**Beispiel-SQL: Platzhalter nur lokal durch zwei unterschiedliche Passwörter ersetzen.**
Keine echten Passwörter als Shell-Argument, Chatinhalt oder Git-Datei:

```sql
CREATE DATABASE evse_control CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE USER 'evse_storage'@'%' IDENTIFIED BY 'LOKAL_GEWAHLTES_WRITER_PASSWORT';
CREATE USER 'evse_migrator'@'%' IDENTIFIED BY 'LOKAL_GEWAHLTES_MIGRATIONS_PASSWORT';
GRANT SELECT, INSERT ON evse_control.* TO 'evse_storage'@'%';
GRANT SELECT, INSERT, CREATE ON evse_control.* TO 'evse_migrator'@'%';
```

`%` ist ein Beispiel für variable Container-IP-Adressen, keine Empfehlung für
öffentlichen DB-Zugang. Account-Hostbereich soweit möglich auf das geprüfte lokale
Docker-Netz begrenzen; bestehende Server-Erreichbarkeit unabhängig prüfen.
Runtime darf **nicht** UPDATE, DELETE, DDL, globale Rechte oder Adminrechte erhalten.
Migration nutzt CREATE nur im eigenen Schema; spätere Schema-Versionen können
andere ausdrücklich freizugebende Rechte benötigen. Kein `GRANT ALL` für Runtime.

### Konfiguration und Passwortdateien

Auf dem Pi nach Merge:

```bash
cd ~/EVSE-Control
git switch main
git pull --ff-only
cd rasppi/storage
cp .env.example .env
mkdir -p secrets
chmod 700 secrets
```

`.env` lokal editieren: verifizierte `DB_HOST`, `DB_NETWORK`, `DB_PORT`, `DB_NAME`,
Accounts und ggf. MQTT-Benutzer. Keine Passwörter in `.env` erforderlich.
`MQTT_CLIENT_ID=evse-storage` muss sich vom Reader/Overlay und jedem anderen
laufenden Client unterscheiden. Präfix muss dem Reader entsprechen; keine Wildcards.

Zwei Passwortdateien mit den zuvor lokal vergebenen Accountpasswörtern anlegen.
Beispiel für interaktive Bash ohne Geheimnis im Shell-History-Befehl:

```bash
umask 077
IFS= read -r -s -p 'DB-Writer-Passwort: ' SECRET; printf '\n'
printf '%s\n' "$SECRET" > secrets/db-password.txt
unset SECRET
IFS= read -r -s -p 'DB-Migrations-Passwort: ' SECRET; printf '\n'
printf '%s\n' "$SECRET" > secrets/migration-password.txt
unset SECRET
sudo chown 10001:10001 secrets/db-password.txt secrets/migration-password.txt
sudo chmod 0400 secrets/db-password.txt secrets/migration-password.txt
```

Bei Rootless-/Usernamespace-Docker die entsprechende Host-UID-Zuordnung prüfen.
Dateien werden einzeln readonly gemountet und müssen für Container-UID **10001**
lesbar sein. Nie bestehende Broker-/DB-Passwortdateien chmod/chownen oder Secrets
weltlesbar machen. Zum späteren Ersetzen ggf. eine neue Datei im geschützten
Verzeichnis schreiben, berechtigen und austauschen, nicht fremde Dateien verändern.
Leere/zu große Dateien, mehrzeilige Passwörter und parallele ENV-/FILE-Angabe
werden abgelehnt. `secrets/`, `.env`, `backups/` sind ausgeschlossen aus Git/Build.

Bei MQTT-Passwort ebenfalls eine **eigene** `secrets/mqtt-password.txt` mit diesen
Berechtigungen vorbereiten und `MQTT_USERNAME` setzen. Ab dann alle Runtime-
Aufrufe mit `docker compose -f compose.yaml -f compose.auth.yaml …` ausführen.
Ohne Passwortdatei Basis-Compose verwenden; anonymous Brokerzugang bleibt nur
eine bestehende Konfiguration, kein Sicherheitsnachweis.

### Explizite Migration und Start

```bash
docker compose build storage
docker compose --profile tools run --rm --no-deps -T --interactive=false migrate
```

Migration muss erfolgreich `schema version 1 ready` melden (stderr), Exitcode 0.
Sie erstellt nur `evse_schema_versions`, `evse_wallbox_samples`, `evse_ingest_events`
im konfigurierten Schema; keine Datenbank/Accounts und keine fremden Tabellen.
Ein DB-Lock verhindert parallele Migration. Wiederholung von Version 1 ist
idempotent. MariaDB-DDL ist nicht komplett transaktional: nach Teilabbruch dieselbe
Version kontrolliert erneut ausführen, keine fremden Tabellen manuell löschen.
Andere registrierte Versionen werden abgelehnt, nicht automatisch überschrieben.
Engine, Spaltentypen, Nullability und Unique-Identitäten werden vor Bestätigung
geprüft; bereits bestehende inkompatible Tabellen führen zum Abbruch. Nicht einfach
die Versionszeile manuell eintragen. Während Schemaänderungen Collector stoppen,
Reader/Broker können weiterlaufen; spätere Versionen verlangen eigene Migrationen.
Migrationsdatei kann nach erfolgreicher Einrichtung geschützt/offline verwahrt
werden; laufender Collector mountet sie nicht.

Danach (ggf. mit Auth-Overlay wie oben):

```bash
docker compose up -d storage
docker compose ps
docker compose logs --tail 100 storage
```

Ohne Schema/DB-Zugang bleibt MQTT-Intake pausiert und der Container unready;
Runtime führt nie automatische DDL aus. Healthcheck prüft DB/MQTT-Readiness,
nicht vollständige Aufzeichnung oder fehlerfreie Wallbox. DB-Ping etwa alle 5 s,
MQTT-ACKs erst nach SQL-Commit/bestätigtem Duplikat. Logs enthalten Zähler,
keine kompletten Samples oder Zugangsdaten; volle Logpipes dürfen nicht blockieren.

### Datenmodell, Lücken und Betriebsgrenzen

- Sample-Tabelle: `source` ist das MQTT-Präfix als exakte UTF-8-Bytes, getrennte
  UTC-`measured_at`/`received_at`, `last_success_at`, erster Retained-Status,
  `status=ok|error`, nullable Flags und Messwerte; A/V/W/Wh bleiben dokumentierte
  Einheiten. Readfehler speichern Messwerte **NULL**, nicht 0. Kein Ladestatus aus
  bloßer Ladefreigabe/Online oder Stromlimit ableiten.
- Pro Source normalisierte Payload-SHA256: gleiche Samples nur einmal, neue Werte
  mit derselben Sekunde bleiben eigene Zeilen. Immutable Daten, kein Update der
  Empfangszeit beim retained Reconnect. Schema 1 unterscheidet identische Reads
  derselben Sekunde nicht; kein impliziter Sequenz-/Ladesessionzähler.
- Alte und zukünftige formal gültige Samples werden archiviert, nicht live
  ausgegeben. Eine spätere Historien-API muss Geräte-/Empfangszeit, Lücken und
  Clock-Anomalien unterscheiden. Der aktuelle `/api/state`-Vertrag bleibt unverändert.
- Events: Availability-Beobachtungen mit Empfangszeit, aber ohne Gerätezeit;
  Start-/Stop-/Broker-/Gap-Grenzen. Wiederholtes `online` ist normal, kein Nachweis
  einer neuen Session. State/Availability sind nicht atomar zugestellt.
- RAM-Queue default 256 + ein ausstehender Record und aggregierte Gap-Zähler,
  `STORAGE_QUEUE_SIZE=8..4096`. DB-Ausfall disconnectet nur den Collector und
  hält bereits angenommene Records im RAM. Identischer Hash/UUID wird nach ungewissem
  Commit wiederholt, keine blind duplizierte Zeile. Backoff bis 30 s.
- Retained stellt nach Recovery nur den neuesten Snapshot bereit. Dazwischen
  fehlen Reads; **kein Disk-Spool/Replay und keine Verlustfreiheitsgarantie**.
  Überlauf verwirft Zustellungen, Invalid-Payloads werden bewusst abgelehnt.
  Gap-Zähler kennen nur lokal verworfene Zustellungen, nicht alle fehlenden Reads.
  `queue_rejected_records`/`dropped` enthält auch verworfene System-/Collector-
  Ereignisse; `rejected_deliveries`/`invalid` nur abgelehnte MQTT-Payloads.
  Restart verliert RAM und setzt eine neue Grenze unbekannter Abdeckung.
- SIGTERM stoppt Intake und versucht 8 s zu drainen. SQL-/OS-DNS kann darüber
  hinaus dauern; Compose-20-s-Frist beendet nötigenfalls den Prozess, dann können
  Records verloren gehen. Reader/Broker/Hardware werden nicht gestoppt.
- Kein automatisches Löschen/Aggregieren: etwa **43.200 Samples pro Tag** bei 2 s,
  zusätzlich viele Availability-Zeilen/Indizes. Speicherplatz, Datenwachstum und
  Backupzustand regelmäßig prüfen; Aufbewahrungsfrist ist noch abzustimmen.

### Backup und unabhängiger Empfangsnachweis

Bestehendes Backupverfahren bevorzugen. Falls ein eigenes logisches Backup für
Schema 1 nötig ist: geschützte `secrets/backup.cnf` mit lokalem Host/User/Passwort
für dieses Schema anlegen (`[client]`, `host`, `user`, `password`; Client-Options-
Escaping bei Sonderzeichen beachten), UID 10001 lesbar, nicht committen. Schema 1
hat keine Trigger/Views/Routinen; der folgende Dump überspringt Trigger ausdrücklich.
Bei späteren Schemaerweiterungen Backupoptionen anpassen, nicht unbemerkt ausschließen.

```bash
umask 077
mkdir -p backups
docker run --rm --network evse-data --user 10001:10001 \
  --mount type=bind,src="$PWD/secrets/backup.cnf",dst=/run/secrets/client.cnf,readonly \
  mariadb:11.8 mariadb-dump --defaults-extra-file=/run/secrets/client.cnf \
  --single-transaction --skip-triggers --no-tablespaces --databases evse_control \
  > "backups/evse-$(date -u +%Y%m%dT%H%M%SZ).sql"
```

Netz/Schema/Clientversion an bestätigte Einrichtung anpassen. Exitcode/Dumpgröße
prüfen, Backup außerhalb dieses Pi geschützt kopieren und Restore nur in isolierter
Testdatenbank prüfen. Nie blind einen Dump auf vorhandene Produktivschemas anwenden.

Im lokalen DB-Client mit SELECT-Rechten unabhängig prüfen:

```sql
SELECT COUNT(*) FROM evse_wallbox_samples;
SELECT CONVERT(source USING utf8mb4) AS source, measured_at, received_at, status,
       plugged_in, charging, current_limit_a, active_power_w
FROM evse_wallbox_samples ORDER BY id DESC LIMIT 5;
SELECT kind, availability, received_at FROM evse_ingest_events
ORDER BY received_at DESC LIMIT 10;
```

Wachsende Samples/korrekte UTC-Werte mit laufendem Reader/Subscriber vergleichen;
nicht nur Containerstatus oder Logs als End-to-End-Nachweis werten. Keine reale
Wallbox-/Broker-/DB-Abschaltung für Tests ohne separaten Auftrag. Stoppen mit
`docker compose down` in `rasppi/storage` betrifft nur diese Clients, nicht
MariaDB/Grafana/Broker. **Kein `down --volumes` auf bestehender Infrastruktur.**

### Isolierte Tests (Docker-only)

```bash
docker compose -f compose.test.yaml build tests
docker compose -f compose.test.yaml up --abort-on-container-exit --exit-code-from tests
docker compose -f compose.test.yaml down --volumes
```

Nur diese Testdatei startet einen flüchtigen MariaDB-Server und Testbroker
im isolierten Netz ohne Hostports/Produktionsnetze, mit bekannten Dummy-Credentials.
Tests prüfen typed SQL/null, Schema-/Grant-Grenzen, Duplikate/Same-Second/Retained,
Restart/DB-Recovery und Parameterbindung. Runtime-Image-Build führt Unit-Tests aus;
GitHub-CI ergänzt diese Integration und non-root/readonly/No-Network-Smoke-Test.
Default 10.11, weitere Matrixversionen exakt 11.8.8 und rollend 11.8. Lokal für
11.8.8 jedem Compose-Aufruf `MARIADB_TEST_VERSION=11.8.8` voranstellen; keine Produktiv-Image-/Server-
änderung. CI nutzt Linux amd64, das ist kein Pi-ARM64-Deploymentnachweis.
CI [37209898185](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/37209898185)
für `50794db` bestanden: **32 Unit- und 7 SQL/MQTT-Integrationstests**, eingeschränkte
Grants/Schemaverifikation, Retained-/Restart-Deduplizierung, DB-Recovery und
gehärteter Runtime-Smoke. Keine Produktionsverbindung. **Echtes Pi-Deployment/
DB-Empfang weiterhin offen**; vorhandene MariaDB-Konfiguration erst bestätigen.
