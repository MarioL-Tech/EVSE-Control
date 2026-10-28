# Installation, Hardware und Wiederinbetriebnahme

Diese Anleitung dokumentiert den **aktuellen, nachvollziehbaren Ablauf** für
EVSE-Control. Neue Einrichtungsschritte werden hier ergänzt, sobald sie umgesetzt
werden. Die Betriebsschritte setzen einen vorbereiteten Pi voraus. Hardware-
und Erstvorbereitungsreferenz stehen in Abschnitt 8; eine vollständige OS-,
Docker- oder Broker-Neuinstallation ist damit noch nicht beschrieben.

**Stand:** 2026-10-28. Wallbox-Reader läuft in Docker. Einmal-Lesen und ein kurzer
zyklischer Betrieb wurden vom Projektinhaber bestätigt. Der vorhandene MQTT-Broker ist
erreichbar; der Empfang der echten Reader-Messwerte wurde ebenfalls bestätigt.
Das rein lesende PHP-Weboverlay ist implementiert und Docker-getestet;
Pi-Start und Live-Übersicht vom Projektinhaber am 2026-10-26 bestätigt;
gezielte Ausfalltests, Diagramme und neuer manueller Theme-Schalter noch offen
(Abschnitt 9).

**Planungsänderung:** Kein eigenes Home-Assistant-Modul. Die Website soll später
inhaltlich umgebaut werden. Separat ergänzt ist die **installierbare PWA** mit
optionalem lokalem HTTPS (eigene CA, zunächst ohne Domain). Einrichtung und
Sicherheitsgrenzen stehen im PWA-Abschnitt; Docker-geprüft, Pi-/Handyabnahme offen.
Keine native Handy-App und kein automatisches Pi-/Netzwerkdeployment.

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
Python-/pip-Pakete, PHP/Composer, mbpoll oder Mosquitto auf dem Pi-Host installieren.
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

### Spätere Lademodi (noch nicht einrichtbar)

Geplant sind **Laden wenn Solarstrom**, **Laden ohne Solarstrom** und
**Benutzerdefiniert**. Die Modi sind noch nicht implementiert; aktuell gibt es
weder Modusauswahl noch zugehörige Konfigurationsschritte oder Steuerbefehle.
Solar-Messquelle/-Messpunkt, PV-Überschussregel, Schwellwerte, Ausfallverhalten,
benutzerdefinierte Vorgaben und Moduswechsel sind noch zu klären.
Die heutigen lesenden Dienste und Startbefehle bleiben unverändert. Sobald die
Modi umgesetzt werden, ihre Einrichtung und Bedienung hier dokumentieren.

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
Weboverlay siehe Abschnitt 9, MariaDB-Speicherung Abschnitt 10;
UART-MQTT-Bridge und Ladesteuerung bleiben geplant.

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

### Neue Firmware und Erwartungsgrenzen

Die frühere Firmware war ein **UART-Kommunikationstest**, startete bei 0° und
ließ jede lesbare Karte toggeln. Die neue Allowlist-/Persistenzimplementierung
ist **noch ungeflasht und nicht am realen ESP32 verifiziert**. Docker-CI
[37235418853](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/37235418853)
für `8f98c41` bestätigt 41 native Sanitizer-Fälle, fünf simulierte Adapter-Suiten,
kompletten Xtensa-Zielcompile, vier Artefakte und Flash-CLI-Hilfe ohne USB/Upload.
Prüfhost Linux-amd64, kein Pi-ARM64- oder Hardwaretest; folgende Hardwareprüfung
ist ein Plan, kein Erfolg.
Vor dem Upgrade [Flash-/Sicherheitsablauf](#esp32-bauen-und-flashen) beachten:
mit leerem NVS wechselt der Start von **0° auf 90°**.

UART bleibt 115200/8N1 mit denselben Pins. Die Python-Brücke ist unverändert:
Managementbefehle unten als rohe Zeilen eingeben. Physischer UART und Pi bilden
die Vertrauensgrenze; ein bösartiger Pi kann Karten aufnehmen/Bootpolicy ändern.
Keine Anbindung an anonyme MQTT-Befehlstopics oder aktuelle lesende HTTP-Controls.
Gateway und Webbedienung sind geplant und benötigen später geschützte,
authentifizierte, autorisierte Weiterleitung.

Bei neuem Erststart mit leerem NVS und bereits lauschender Brücke erwartet:

```text
RX <- ESP32: EVSE:STATUS:CHARGING:OFF:SRC:boot
RX <- ESP32: EVSE:STATUS:ANTITHEFT:ACTIVE:SRC:boot
RX <- ESP32: EVSE:STATUS:SECURITY:STORE:READY:FAULT:NONE:BOOT:RESTORE:CARDS:0:ENROLL:OFF:READER:SPI_OK:SERVO:PWM_OK
```

Ein laufender ESP32 wiederholt beim Start der Brücke keine Bootmeldungen;
`status` fragt Lade-/Servoziel und Security-Status ab. Eine vorhandene gültige
NVS-Konfiguration bleibt erhalten, dann sind Kartenanzahl/Bootziel nicht
zwangsläufig wie oben. **Nicht zum Erzwingen dieses Beispiels NVS löschen.**
`ACTIVE`/`INACTIVE` melden nur angeforderte 90°/0°, keine mechanische Messung.
`SPI_OK`/`PWM_OK` bestätigen keine vollständige Karten-/Servo-/Schlossfunktion.
Die früher beobachtete MFRC522-Kennung `0x82` ist ebenfalls nur SPI-Diagnose;
`0x91`/`0x92` sind üblich, `0x00`/`0xFF` deuten auf Anschluss-/Versorgungsprobleme.

### Geplanter Hardwaretest nach abgestimmtem Flashen

Nur mit gesichertem Bewegungsraum, koordinierter Betreuung vor Ort und ohne
reale Wallboxsteuerung durchführen. Ergebnisse privat notieren, keine echten
UIDs in Git, Scripts, Chat oder geteilte Screenshots/Logs übernehmen.

1. `status`: bei neuem leerem NVS `CARDS:0`, `RESTORE`, `ACTIVE`, Store READY
   erwarten. Bei `FAULT` stoppen und Ursache prüfen; nicht automatisch löschen.
2. Karte aus dem Lesefeld entfernen, `CMD:RFID:ENROLL:START` senden und
   `EVSE:RESULT:ENROLL:ENROLL_STARTED` abwarten. **Nach diesem START** Lesefeld
   mindestens 500 ms sauber leer lassen, praktisch **1 s warten**; erst dann
   innerhalb der 30 s genau eine bewusst gewählte 13,56-MHz-Karte auflegen.
   Ein echter START setzt das Presence-Gate erneut auf requireRemoval, auch
   wenn zuvor Leere beobachtet wurde. Bereits gehaltene Karten werden nicht
   durch START zum Kandidaten. Wiederholtes START im aktiven Fenster verändert
   weder Gate noch Frist (`ENROLL_ACTIVE`).
3. `EVSE:RESULT:ENROLL:ENROLLED:UID:<uid>` und Kartenanzahl 1 prüfen; UID nur
   privat lokal für den Widerruf festhalten. Aufnahme bewegt den Servo nicht.
   Bereits erlaubte Karte ergibt `ALREADY_ALLOWED` und schließt ebenfalls das
   Fenster ohne Toggle. USB-Ausgabe redigiert die UID; Pi-Brücke zeigt sie.
4. Karte mindestens 500 ms sauber entfernen (praktisch 1 s), erneut auflegen:
   zuerst 0°/`UNLOCKED`, nach erneutem Entfernen/Auflegen 90°/`LOCKED` erwarten.
   Zwischen erfolgreichen Toggles mindestens 800 ms; kein künstlicher
   800-ms-Startaufschub. Gehaltene Karte darf keine Wiederholung erzeugen.
   Auch bei Boot gehaltene Karte muss erst sauber entfernt werden. Selectfehler,
   Kollision oder SPI-Fehler sind keine Entfernungsnachweise.
5. Andere, nicht erlaubte Karte frisch präsentieren: `DENIED`, kein Toggle,
   keine UID-Ausgabe. Cancel (`CMD:RFID:ENROLL:CANCEL`) und Ablauf des Fensters
   nach 30 s ebenfalls prüfen. Jeder echte neue START verlangt erneut Leere.
6. `CMD:RFID:REVOKE:<uid>` mit der **nur lokal** erfassten UID senden
   (`<uid>` ersetzen; 4/7/10 Bytes, zwei Hexzeichen je Byte, Doppelpunkttrenner).
   `REVOKED`, Kartenanzahl und anschließend `DENIED` ohne Bewegung prüfen.
7. Für jede Policy `CMD:ANTITHEFT:BOOT:RESTORE`, `...:LOCKED`, `...:UNLOCKED`
   einzeln senden: Einstellung darf **jetzt nicht bewegen**. Jeweils einen
   abgestimmten **ESP32-Neustart** auslösen, nicht ungefragt den Remote-Pi rebooten.
   RESTORE: letzter gespeicherter angeforderter Zielwert; LOCKED: 90°;
   UNLOCKED: 0°. Vorher Zielwert/Policy notieren, NVS-Erhalt prüfen. Zum Test
   beider RESTORE-Ziele kann die private Testkarte erneut aufgenommen werden.
   Gewünschte endgültige Policy und Kartenbestand bewusst festlegen.

Persistenz: maximal 16 UIDs mit 4/7/10 Bytes in einem version-/CRC-geprüften
NVS-Blob, Namespace `evse-lock`, Schlüssel `state`, über direkte ESP-IDF-NVS-API
in eigener Partition `evse_nvs`, nicht Preferences; **keine zugesicherte
Verschlüsselung**, kein automatisches Erase/Factoryreset. Startupfehler
(`UNAVAILABLE`, `CORRUPT`, `WRITE`) fordern verriegelt an und verweigern
Management-/Kartenänderungen. Runtime-Schreibfehler fordern **LOCKED/90°** an,
brechen Aufnahme ab und sperren Änderungen bis Neustart. Das Fallback kann bei
Schreibfehler nicht gespeichert werden; RESTORE beim nächsten Start liest den
letzten tatsächlich gültigen dauerhaften Blob, dessen Ziel abweichen kann.
Speichern erfolgt vor Erfolg/normalem Servotoggle; ein ungewisser Schreibausgang
kann nach Neustart dennoch angewendet werden. Keine absichtlichen
Stromunterbrechungen ohne eigenen,
sicher abgestimmten Testplan.

UIDs sind klonbar, keine kryptografische Authentifizierung. SG90 ist keine
zertifizierte physische Diebstahlsicherung; kein mechanischer Sensor oder
Sicherheitsversprechen bei Stromverlust. Kein direkter UART-Unlock-Befehl.
Vollständige Frames/Fehler/Antworten: [UART-Vertrag](uart-protocol.md),
Firmwareübersicht: [ESP32-README](../esp32/README.md).

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
90° verriegelt/aktiv; erlaubte RFID-Karten toggeln unabhängig vom Laden.
Neuer Erststart mit leerem NVS: 90°, keine Karten, RESTORE. Sonst konfigurierte
Bootpolicy gemäß Abschnitt 6. Status ist ein angeforderter Zielwert, kein
mechanischer Nachweis. Vor Upgrade/Bewegung sichere Freigängigkeit koordinieren.

### ESP32 bauen und flashen

**Upgrade vor Ort koordinieren:** Die alte UART-Testfirmware startete bei 0°;
neue Firmware startet bei leerem NVS mit 90°. Servo/Mechanik müssen sich sicher
bewegen können. USB-Zugang/Versorgung und Flashen mit einer Person vor Ort
abstimmen; kein vorhandener Agentzugang zum ESP32 oder bestätigter Remote-Flashweg.
Keine Hardwareprüfung/Deployment als bereits erfolgt behandeln.

**Board-/Partitionsvoraussetzung:** 4-MB-ESP32; eigene Tabelle
`esp32/partitions.csv` mit `evse_nvs` bei `0x290000`, Größe `0x6000`.
Direkte ESP-IDF-NVS-API isoliert Securitydaten vom Arduino-Default-NVS und
dessen möglichem Autoerase. Nur genau `ESP_ERR_NVS_NOT_FOUND` bedeutet fehlender
Eintrag; Initialisierungs-/Open-/Korruptionsfehler nicht durch Löschen beheben.
Die alte Stock-SPIFFS-Region überlappt die neue Securitypartition:
**keinen SPIFFS-Zugriff und kein Stock-Partitionsimage verwenden**.
Der geprüfte frühere UART-Testcode persistierte keine Kartenfreigaben;
dies ist keine Freigabe zum Löschen unbekannter Daten anderer Geräte.

Beim ersten Deployment muss die **neue Partitionstabelle zusammen mit passender
Firmware und Bootloader** aus demselben Build-/Toolchainstand geflasht werden.
Nur `firmware.bin` über einer alten Tabelle reicht nicht. Vor Upload Boardgröße,
aktive Tabelle und vollständige Uploadliste/-Offsets des geprüften PlatformIO-
Builds lokal kontrollieren; nicht Binärdateien verschiedener Stände mischen.
Kein `erase-all`/Erase-Flash-Befehl, kein automatisches Reset des Kartenstores.
Ohne bestätigte 4-MB-/USB-/Partitionsvoraussetzungen nicht flashen.

Toolchain gepinnt: `espressif32@6.9.0`, Framework `3.20017.0` (Arduino 2.0.17),
MFRC522 `1.4.11`. ESP32Servo entfernt; native Arduino-2-LEDC-PWM auf GPIO13:
Baseline 544 µs für 0°, 1472 µs für 90°, Bereich 544–2400 µs
(Referenz: Defaultmapping ESP32Servo 1.1.2; reale Mechanik ungeprüft).
Timer/Duty werden vor GPIO-Anbindung gesetzt. Diese Startreihenfolge ersetzt
keine sichere mechanische Kalibrierung vor Ort; `PWM_OK` ist kein Positionsbeweis.

Vorgesehener reproduzierbarer Build aus dem Repository-Hauptverzeichnis, mit
Docker auf dem Entwicklungsrechner oder Pi (keine Hostpakete auf dem Pi):

```bash
docker build -f esp32/Dockerfile -t evse-esp32:test esp32
```

Der Image-Build führt native Security-/Protokoll- und simulierte Adaptertests
unter ASAN/UBSAN sowie den vollständigen
PlatformIO-Zielcompile aus. Bei Fehler abbrechen, kein altes Artefakt
flashen. CI-Lauf oben bestätigt den Build/Softwaretest, nicht reale
ESP32-Funktion. Das finale Image ist **artefakt-only**, kein PlatformIO-Runtime
zum Flashen. Artefakte lokal entnehmen (Zielordner vorher auf Kollision prüfen):

```bash
docker create --name evse-esp32-artifacts evse-esp32:test
docker cp evse-esp32-artifacts:/firmware ./esp32-firmware
docker rm evse-esp32-artifacts
```

Nur der eigens erstellte temporäre Artefaktcontainer wird entfernt, keine
Volumes; wenn sein Name schon belegt ist, erst Eigentum klären/anderen Namen
verwenden, nicht fremden Container löschen. `firmware.bin`, `bootloader.bin`,
`partitions.bin` und `boot_app0.bin` (OTA-Initialisierung) aus demselben Build
bleiben **nur lokal, nicht Git**. Commit/Buildquelle privat notieren.
Das finale Image unterstützt **keinen `pio`-Upload**. Ein gesonderter,
ausdrücklich gewählter Docker-Flash-Target enthält Toolchain, bestandene native
Buildtests und Firmware. Erst nach bestätigter Hardware-/Partitionsfreigabe
auf einem Linux-Rechner mit lokalem ESP32-USB-Zugang verwenden:

```bash
docker build --target flash -t evse-esp32:flash esp32
# Platzhalter ersetzen: ESP32-USB-Geraet vorher eindeutig identifizieren!
ESP32_USB_DEVICE=/dev/DEIN_ESP32_USB_GERAET
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges \
  --device "${ESP32_USB_DEVICE}:/dev/ttyESP32" \
  evse-esp32:flash --upload-port /dev/ttyESP32
```

Der Target-Build und `--help` wurden in Docker-CI ohne USB geprüft;
das ist **kein ausgeführter oder hardwarebestätigter Upload**. Kein
`--privileged`, keine Hostpakete, keine Docker-Socket-Freigabe. Nicht den
Wallbox-RS485-Port `/dev/ttyUSBEVSEcontrol` oder die UART-Headerverbindung
`/dev/serial0` auswählen. Kein automatisches Ermitteln/Öffnen fremder Ports.
Windows-USB-Passthrough zu Docker ist hier nicht eingerichtet; Docker ohne
USB-Zugang kann nur bauen/Artefakte liefern. Gerät und freien Zugriff vorab
bestätigen; Upload übernimmt die projektbezogene Partitionstabelle, kein Erase-All.

Auf dem Entwicklungsrechner mit vorhandenem PlatformIO/VS Code das Verzeichnis
`esp32/` am gleichen geprüften Commit öffnen; Flashen setzt Zugang zum
USB-Anschluss des ESP32 voraus. Dieser Weg baut mit der lokalen Dev-Toolchain
und lädt deren Firmware hoch, nicht automatisch das Docker-Artefakt:

```bash
pio run -t upload
```

Dies ist keine Anleitung zur PlatformIO-Installation auf dem Pi-Host und kein
bereits eingerichteter Remote-Flashweg. Firmware initialisiert RFID/Servo und
UART mit 115200 Baud, 8N1. Kein automatisches NVS-Erase/Factoryreset vornehmen;
bei Storagefehler Ursache prüfen. Funktionstest siehe
[Abschnitt 6](#6-optionale-esp32-uart-testbrücke).

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
`/dev/ttyUSB0`. Ein Symlink kann über eine udev-Regel erzeugt werden. Die 
USB-Ports sind am RP physisch eindeutig mit einer USB-ID zuordenbar:

```bash
cat << EOF >> /etc/udev/rules.d/99-setUSBNames.rules
ACTION=="add", SUBSYSTEMS=="usb", KERNELS=="1-1", SYMLINK+="ttyUSBEVSEcontrol"
EOF
```

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

`rasppi/weboverlay/` ist ein eigener Docker-Dienst. Die Migration ersetzt
nur sein Websitebackend durch PHP 8.4/Apache und genau einen PHP-CLI-MQTT-
Subscriber mit `php-mqtt/client` exakt 2.3.2 im selben Container. HTML/CSS/JS,
Seiten, Diagramme, API-Schema, deutsche Statusgründe, Frische-/Read-only-Semantik,
CSP und sonstige Sicherheitsheader bleiben erhalten; keine visuelle Neugestaltung.
**PHP-Docker-CI 40365837026 für 06a3626 erfolgreich; Pi-Übersicht bestätigt.**
Die Software-CI läuft auf Linux-amd64, nicht auf dem Pi/ARM64. Den tatsächlichen
Pi-Start und die Live-Übersicht bestätigt der Projektinhaber (Details unten).
Websitezugriff und bisheriger großer Theme-Selektor wurden danach erneut
bestätigt. Neue Symbolschalter und Haus-Smartmeter müssen nach Merge/Update
noch auf dem Pi geprüft werden. Docker-CI 40486476429 für 3c92398 erfolgreich:
80 neue PHP-Prüfungen, 17 isolierte HTTP-Szenarien, insgesamt 49 JS-Tests und
fünf Chromium-Suiten einschließlich 30 Theme-/Einstellungsfällen sowie bisherige
Backend-/Runtime-Prüfungen. Simulierte Desktop-/Mobilbilder in Hell/Dunkel angesehen.
**Kein zusätzlicher Broker, kein Zugriff auf RS485/UART,
keine Schreibbefehle.** Der laufende Wallbox-Reader muss nicht gestoppt werden.

Voraussetzungen: Abschnitt 5 eingerichtet (`evse-mqtt`, `mqtt-broker`), laufender
Reader und aktueller Repository-Stand nach Merge der Weboverlay-PR. Build und
Tests benötigen keine Wallbox, Tests verwenden nur einen isolierten Loopback-Broker.

Apache läuft non-root als UID 10001, intern auf Port 8080. Bash überwacht HTTP,
MQTT-Worker und den unabhängigen Haus-Smartmeter-Worker: stirbt ein Prozess
unerwartet, beendet der Entrypoint die übrigen und den Container mit Fehler;
SIGTERM stoppt alle drei. HTTP bleibt bei Brokerausfall erreichbar,
der Worker versucht Reconnect mit 1–30 s Abstand. Erst beide SUBACKs erlauben
die Datenfreigabe, Reconnect verwirft Sample und Availability. Die MQTT-Restlänge
ist auf 32768 Bytes (ohne Festheader), Statepayloads auf 16384 Bytes begrenzt.

Privater Snapshot unter `/tmp/evse-weboverlay` im vorhandenen tmpfs: stabile
flock-Datei mit maximal 200 ms Wartezeit, atomarer Austausch bis 64 KiB.
Workerheartbeat alle 250 ms, niemals durch HTTP erneuert. Bei fehlendem/defektem
Snapshot oder 3 s Worker-Stillstand liefert die API fail-closed offline/keine Werte.
Interne Defaults `WEB_STATE_DIR=/tmp/evse-weboverlay` und `EVSE_HTTP_PORT=8080`
brauchen im unveränderten Compose-Dienst keine Anpassung. Bestehendes externes
`evse-mqtt`, Broker/Client-ID, Umgebungsvariablen, Passwortoverride, readonly,
tmpfs, cap-drop und Localhost-Bindung bleiben unverändert. C++-Reader,
Python-UART-Brücke und Python-Speichercollector werden nicht ersetzt.

**Separat ergänzter HTTP-Haus-Smartmeter:** Laut Projektinhaber
liefert ein konfigurierbarer privater HTTP-Host unter `/dev/powerValue.txt`
whitespace-getrennte Werte, schematisch `U1 U2 U3 Feld4 Feld5 Feld6 1549.40 …`.
Wert 7 ist Netzaustauschleistung in W: positiv Bezug, negativ Einspeisung;
die ersten drei Phasenspannungen vorerst ignorieren, übrige Felder unbekannt.
Nach der PHP-Migration separat autorisiert und implementiert; echte Quelle
nicht unabhängig abgerufen/verifiziert. Einrichtung optional über lokale URL
(siehe unten), keine Deployment-IP dokumentieren. Beziehung zur geplanten
DTSU666-Erfassung offen, daraus keinen verfügbaren Strom in A ableiten.
Keine Modbus-Schreibbefehle, DB-/Historienoberfläche, Home-Assistant-Integration
oder gemeinsame Compose-Datei in diesem Arbeitsschritt.

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
PHP-/Node-Unit-/HTTP-/MQTT- und JavaScript-Tests aus; ein Testfehler bricht den
Build ab. Abhängigkeiten werden exakt aus `composer.lock` installiert.
Kein Python in Websitebackend, Runtime, Healthcheck oder Backendtests.
Weder PHP/Composer noch Compiler oder Node-Pakete auf dem Pi-Host installieren.
PHP-CI 40365837026 bestätigt 16 Zustands-/Config-Fälle, IPC-Suite,
21 Transportfälle, vier MQTT-/HTTP-/Auth-/ACL-Szenarien, 28 JS-Tests und drei
Chromium-Suiten sowie non-root/readonly Runtime ohne Broker/Python. Installation
aus committed Lockfile und Bytevergleich des extrahierten Locks sind bestätigt.

Der Dienst bindet den Hostport standardmäßig **nur an `127.0.0.1:8080`**. Es werden
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

### Direkter Zugriff im vertrauenswürdigen LAN

Separat autorisierter Zugang ohne SSH-/WireGuard-Tunnel: **eine Einstellung in
der bestehenden Website-`.env`**, keine zusätzliche Compose-Datei oder Hilfsskripte.
Der Default bleibt localhost, damit ein Update nicht ungefragt andere Netze öffnet.
Kein HTTP-Login/TLS; andere erreichende LAN-Geräte können die Anzeige lesen.
Nicht für öffentliche/unvertrauenswürdige Netze verwenden, keine Router-
Portweiterleitung einrichten. Docker-Portfreigaben können UFW umgehen; eine
UFW-Regel allein ist keine verlässliche Zugriffsbeschränkung für Containerports.

Nach Repositoryupdate, aus `rasppi/weboverlay`, die vorhandene `.env` bearbeiten:

```bash
nano .env
```

Nur folgenden Wert ergänzen/anpassen; `PI-LAN-IP` durch die tatsächlich dem Pi
zugewiesene LAN-IPv4-Adresse ersetzen, nicht durch eine Docker-/VPN-Adresse:

```dotenv
WEB_BIND_ADDRESS=PI-LAN-IP
```

Bestehende MQTT-/DB-/Smartmeterwerte und Passwortdateien behalten. Adresse nur
lokal speichern, nie committen. `0.0.0.0` würde alle IPv4-Schnittstellen öffnen,
nicht nur LAN. Die konkrete LAN-Adresse muss beim Containerstart vorhanden sein;
ändert sie sich, `.env` aktualisieren. Die frühere Empfehlung mit separater
`compose.lan.yaml` und dynamischem Dateiliste-/Array-Skript ist nicht mehr nötig.
Eine eventuell vorhandene solche Datei nicht weiter mit `-f` einbeziehen; sie
muss nicht gelöscht werden. Keine fremden Konfigurationsdateien überschreiben.

Danach Website mit **derselben bisher genutzten History-/Auth-Auswahl** neu erstellen.
Bei der bereits eingerichteten SQL-Historie ohne MQTT-Auth-Datei:

```bash
docker compose -f compose.yaml -f compose.history.yaml up -d weboverlay
docker compose -f compose.yaml ps weboverlay
```

Mit bisher genutztem `compose.auth.yaml` dieses wie zuvor zusätzlich einbeziehen;
ohne SQL-Historie genügt der normale Basisaufruf. Keine Images neu bauen und
keine Datenbankmigration nötig: ausschließlich Docker-Portbindung. Kein Pi-
Neustart, kein Stoppen von Reader/Collector/DB/Broker, keine Hostpakete installieren.

Unter `PORTS` muss `PI-LAN-IP:8080->8080/tcp` stehen (beziehungsweise `WEB_PORT`).
Dann im LAN-Browser `http://PI-LAN-IP:8080` öffnen. Firewallfreigabe und Router-
Erreichbarkeit bei Bedarf gezielt prüfen, nicht wahllos weitere Ports öffnen.
Die localhost-Bindung wird damit ersetzt; für den bisherigen Tunnelbetrieb
`WEB_BIND_ADDRESS=127.0.0.1` setzen und denselben Compose-Aufruf wiederholen.
HTTP-Healthcheck im Container und MQTT-/SQL-/Hausdienste bleiben unverändert.
Ein Hostport-Eintrag allein ist noch kein bestätigter Browser-/LAN-Erreichbarkeitstest.

Projektinhaber meldet nach Merge von PR #49 und dieser vereinfachten Anleitung
am 2026-10-28 „funktioniert“. Damit ist direkter LAN-Websitezugriff laut Rückmeldung
bestätigt; keine unabhängig geprüfte Runtime-/API-/Zugriffsschutz-/Langzeitprüfung
und kein Agent-Deployment. Diese Rückmeldung bestätigt nicht zusätzlich die
gesonderte Schema-2-Migration oder abgeschlossene Kalenderverdichtung.

### Installierbare Handy-WebApp: lokales HTTPS und PWA

**Aktuell zurückgestellt:** Der Projektinhaber möchte die HTTPS-/Handyeinrichtung
vorerst nicht durchführen. Es ist kein Agent-Deployment erfolgt. HTTP bleibt
unverändert; die folgenden optionalen Schritte nur bei später gewünschter
Aktivierung verwenden. Die WebApp-Karte in Settings wurde auf Wunsch entfernt.
Manifest, Installationsicons und begrenzter Service Worker bleiben implementiert.
Android-/iOS-Installation und Zertifikatsvertrauen müssen anschließend auf den
tatsächlichen Handys bestätigt werden; Browser-CI ersetzt keinen Gerätetest.
PHP/Apache, MQTT-/Haus-Worker und MariaDB bleiben bestehen. Der weitergehende
inhaltliche Websiteumbau und Ladesteuerung sind davon getrennte Vorhaben.

**Voraussetzung für eine reguläre PWA mit Service Worker ist vertrauenswürdiges
HTTPS.** Der bisherige HTTP-LAN-Zugriff allein genügt nicht. Zunächst läuft alles
**nur lokal ohne Domain**: optionaler Caddy-Container im Profil `https`, eigene
lokale CA, Port 443/TCP → intern 8443 → Apache 8080. Keine Internet-Portweiterleitung,
kein zusätzlicher Broker/DB/VPN-/Clouddienst, keine Hostinstallation von Caddy oder
OpenSSL. Caddy ist non-root/readonly/cap-drop, nur im privaten internen Webnetz,
nicht im MQTT-/DB-Netz. IPv4 ohne SNI wird durch explizites `default_sni` unterstützt.

Das heißt nicht, dass jeder Homescreen-Eintrag HTTPS benötigt: Je nach Browser
kann auch eine HTTP-Seite als Verknüpfung/App-Fenster hinzugefügt werden. Das allein
beweist keine Service-Worker-/Offline-Unterstützung. Diese WebApp aktiviert ihre
PWA-Funktionen ausdrücklich nur über HTTPS. Die Browserausnahme für `localhost`
bezieht sich auf das Gerät selbst, nicht auf eine entfernte Pi-LAN-IP.

#### 1. Bestehende Websitekonfiguration beibehalten und HTTPS aktivieren

Nach Feature-Merge und Repositoryupdate aus `rasppi/weboverlay` die vorhandene
`.env` bearbeiten, nicht überschreiben. Für das bereits freigegebene LAN:

```dotenv
WEB_BIND_ADDRESS=PI-LAN-IP
COMPOSE_PROFILES=https
```

`PI-LAN-IP` durch die echte lokale IPv4-Adresse ersetzen. Bestehende MQTT-/DB-/
Smartmeterwerte und Passwortdateien behalten. `WEB_HTTPS_PORT=443` ist Default.
`WEB_TLS_HOST` darf leer bleiben: Die Zertifikatsidentität übernimmt dann
`WEB_BIND_ADDRESS`. Bei Bindung an `0.0.0.0` muss `WEB_TLS_HOST` ausdrücklich eine
erreichbare konkrete IP/ein DNS-Name sein; `0.0.0.0` ist keine Zertifikatsidentität.
Keine URLs, Ports, Pfade, Wildcards oder IPv6-Literale als `WEB_TLS_HOST` verwenden.

Mit bisheriger History-Auswahl den **gesamten Website-Stack ohne Dienstsuffix**
starten; dadurch startet das aktivierte HTTPS-Profil mit, ohne dritte Betriebsdatei:

```bash
docker compose -f compose.yaml -f compose.history.yaml up -d --build
docker compose -f compose.yaml -f compose.history.yaml ps
```

Falls bisher `compose.auth.yaml` verwendet wird, diese Datei wie bisher zusätzlich
einbeziehen. Ohne SQL-Historie den History-Schalter weglassen. Ein explizites
`up -d weboverlay` startet den unabhängigen HTTPS-Proxy **nicht** mit. Nur die
Websitekomponenten ändern sich; Reader/Collector/DB/Broker weiterlaufen lassen,
keine Migration oder Pi-Neustart nötig. Port 443 muss lokal frei/erreichbar sein;
Firewall nur bei Bedarf gezielt prüfen, keine pauschalen Netzwerkänderungen.
Docker-Portveröffentlichungen können UFW umgehen.

**Kompatibilität:** Die vorhandene HTTP-Veröffentlichung auf `WEB_PORT` bleibt
unverändert erreichbar. Es gibt keinen erzwungenen Redirect und kein HSTS;
die PWA ausschließlich über HTTPS verwenden. HTTPS ist kein Login/Zugriffsschutz.
Es ist keine öffentliche ACME-Ausstellung aktiviert, auch nicht bei einem DNS-Namen.
Das spätere Entfernen des Profilwerts beendet einen bereits laufenden Proxy nicht
automatisch. Zum Abschalten nur `https` mit derselben Compose-Dateiauswahl und
`--profile https stop https` stoppen; vorhandenen CA-Store behalten. Keine anderen
Dienste/Volumes herunterfahren oder löschen.

#### 2. Öffentliches CA-Zertifikat vertrauenswürdig zum Handy übertragen

Erst nach gesundem HTTPS-Container aus der bestehenden vertrauenswürdigen
SSH-/Docker-Verwaltung **nur das öffentliche Root-Zertifikat** exportieren:

```bash
umask 077
mkdir -p pwa-public-ca
docker compose -f compose.yaml -f compose.history.yaml cp \
  https:/data/caddy/pki/authorities/local/root.crt pwa-public-ca/evse-local-ca.crt
docker compose -f compose.yaml -f compose.history.yaml exec -T https \
  openssl x509 -in /data/caddy/pki/authorities/local/root.crt -noout -fingerprint -sha256
```

Für diese Verwaltungsaufrufe dieselbe bisherige Auth-/History-Dateiauswahl
beibehalten. Die ausgegebene SHA256-**Zertifikats**fingerprint ist nicht die
Prüfsumme der PEM-Datei. Das `.crt` über einen vertrauenswürdigen Weg vom Pi/PC
auf das Handy kopieren und Fingerprint vergleichen. Nicht aus einer ungeprüften
Browserwarnung oder einem fremden HTTP-Download eine CA übernehmen. Die Website
bietet absichtlich keinen CA-/Schlüsseldownload an.

- **Android:** Je nach Version unter Sicherheit/Datenschutz → Verschlüsselung/
  Anmeldedaten → Zertifikat installieren → **CA-Zertifikat** installieren.
  Nicht mit einem WLAN-/Clientzertifikat verwechseln. Danach aktuellen Chrome/
  geeigneten Browser öffnen. Menübezeichnungen und Installationsangebot variieren.
- **iPhone/iPad:** Zertifikat als Profil installieren (Einstellungen → Allgemein →
  VPN und Geräteverwaltung/geladenes Profil). Anschließend unter Allgemein → Info →
  **Zertifikatsvertrauenseinstellungen** das volle Vertrauen für diese Root-CA
  ausdrücklich aktivieren. Eine Profilinstallation allein genügt nicht immer.

Eine weggeklickte Browserwarnung ist **kein** verlässlicher PWA-Installationsweg.
Nur das öffentliche Zertifikat verteilen, **niemals `root.key` oder andere private
CA-Schlüssel**. Das persistente Volume `https-data` gehört zu diesem HTTPS-Dienst:
nicht löschen/neu initialisieren. Ein Containerneubau behält es; Verlust/Ersetzung
der CA erfordert eine neue Vertrauensinstallation auf allen Geräten. Eine Sicherung
dieses privaten CA-Stores ist vertraulich aufzubewahren, nicht ins Repository kopieren.

#### 3. HTTPS und Handyinstallation prüfen

Im Handy-Browser `https://PI-LAN-IP` öffnen (bei anderem HTTPS-Port mit `:PORT`).
Es darf keine Zertifikatswarnung bleiben. Das Installationsangebot des
Browsermenüs nutzen. Auf iOS in Safari Teilen → Zum Home-Bildschirm bzw.
Als Web-App öffnen. Android kann je nach Browser/Version/Vertrauensart eine
Installation oder einen Homescreen-Eintrag anbieten; eine native WebAPK-Erstellung
durch einen externen Browserdienst wird für private CA/LAN-Adressen nicht zugesichert.
App-Symbol, eigenständigen Start, Navigation, Theme und Live-Frische tatsächlich prüfen.

Der Service Worker registriert nur auf HTTPS in sicherem Kontext. Er speichert
ausschließlich freigegebene statische App-Dateien; `/api/*` und `/healthz` sind
network-only/no-store. Offline-Navigation zeigt eine ausdrücklich benannte
Offline-Seite statt eines zwischengespeicherten Dashboards. Bereits angezeigte
Livewerte müssen durch die bestehende Frischelogik verfallen, keine 0/Nein-Werte
erfinden. Keine Offline-Befehlsqueue, kein MQTT-/Hardwarezugriff im Browser.
Neue Worker warten regulär auf den Abschluss alter Clients statt laufende Seiten
mit `skipWaiting` ungefragt auf gemischte Scriptversionen umzuschalten.

#### Spätere Domainanbindung

`WEB_TLS_HOST` nimmt auch einen ASCII-DNS-Namen an; DNS auf den Pi dann gesondert
einrichten. Dieselbe lokale CA funktioniert dafür weiter, ohne Backend-/DB-/MQTT-
Umbau. Ein öffentlich vertrauenswürdiges Zertifikat/anderes Ausstellungsverfahren
ist eine spätere gesonderte Proxykonfiguration, **kein** bereits automatisierter
Domain-/ACME-Assistent. Eine Domain erteilt keine automatische Internetfreigabe.
Adresswechsel von IP/lokalem Namen zur
Domain ändert die Browser-Origin: eventuell PWA neu installieren und browserlokale
Präferenzen neu wählen; gespeicherte Messdaten auf dem Server bleiben erhalten.

Installation macht den Server außerhalb des LAN nicht automatisch erreichbar.
Kein Agent-Pi-Deployment, produktives Zertifikat oder echte Android-/iOS-Installation
als bewiesen behandeln; hierfür sind die Rückmeldungen des Betreibers erforderlich.
Docker-CI 40730086578 für 6c72193 besteht die bestehenden und neuen Prüfungen
einschließlich echter CA-Verifikation ohne Zertifikatsbypass, IPv4 ohne SNI,
Root-Persistenz, sicherem Kontext und PWA-Offline-/MQTT-Wiederkehr. Testsystem
Linux-amd64, kein Pi-ARM-/Handy-Installationsnachweis. Aktuelle Freigabe über PR #51.

### Haus-Smartmeter optional einrichten

Die Quelle muss vom vorhandenen Websitecontainer aus über das bestehende Netz
erreichbar sein. Keine neue Portfreigabe, kein Hostnetworking, keine Änderung an
WireGuard/Firewall oder dem MQTT-Broker. Ohne konfigurierte URL erfolgt keine
Smartmeterabfrage; die Übersicht zeigt **Nicht eingerichtet**, keine 0 W.

Im Verzeichnis `rasppi/weboverlay` eine vorhandene `.env` **beibehalten**;
falls noch keine existiert: `test -e .env || cp .env.example .env`.
Nur diese Zeilen lokal ergänzen/anpassen, MQTT-Credentials nicht überschreiben:

```dotenv
SMARTMETER_URL=http://SMARTMETER-ADRESSE/dev/powerValue.txt
SMARTMETER_POLL_SECONDS=2
SMARTMETER_TIMEOUT_SECONDS=2
SMARTMETER_STALE_SECONDS=10
```

`SMARTMETER-ADRESSE` durch die eigene bekannte Quelle ersetzen. Die tatsächliche
URL nur in der lokalen `.env` aufbewahren, nicht committen oder in Screenshots
der Konfiguration veröffentlichen. HTTP/HTTPS sind erlaubt; keine eingebetteten
Zugangsdaten, Fragmente oder Redirects. HTTPS-Zertifikatsprüfung bleibt aktiv.
Abfrageintervall 1–60 s, gesamter HTTP-Timeout 1–5 s, Frische 3–120 s;
Defaults 2/2/10 s. Frische sinnvoll größer als Intervall plus Timeout wählen.

Nach Merge/Pull mit vorhandenen Docker-Voraussetzungen neu bauen/starten:

```bash
docker compose -f compose.yaml up -d --build weboverlay
docker compose -f compose.yaml ps
docker compose -f compose.yaml exec -T weboverlay php -r 'echo file_get_contents("http://127.0.0.1:8080/api/smartmeter"), PHP_EOL;'
```

Der letzte Befehl liest nur den bereinigten API-Cache, keine Secrets oder
Deployment-URL. Ein eventuell bereits korrekt eingerichtetes Auth-Override wie
bisher beibehalten; ohne echte Passwortdatei nicht neu hinzufügen. `.env`
allein wird ohne Compose-Neuerstellung nicht an laufende Prozesse übernommen.

**Datenvertrag:** ASCII-Whitespace-Zahlenliste, mindestens sieben endliche
Zahlen, höchstens 4 KiB Body und 8 KiB Header. Genau **Index 6 / Wert 7** ist
Netzaustauschleistung in W: positiv Netzbezug, negativ Einspeisung; die ersten
drei Spannungen und weitere Felder werden nicht als Messgrößen übernommen.
Kein HTML-/Komma-/NaN-/Inf-Fallback, keine Ersatznull. Die Übersicht zeigt kW
und Richtung, getrennt von Wallboxleistung und verfügbarem Ladestrom.

`GET /api/smartmeter` liefert `schema_version`, `read_only`, `status`, `reason`,
`power_w`, `fetched_at`, `age_seconds`, `fresh_for_seconds` — nie die URL,
Rohantwort oder Credentials. Nur `live` enthält Leistung; `disabled`, `waiting`,
`stale`, `offline`, `read_error`, `clock_error` liefern `power_w=null`.
**Letzter Abruf/Abrufalter** beschreiben die HTTP-Empfangszeit, nicht eine
Gerätemesszeit. Wiederholte gültige Antworten belegen Abruffrische, nicht
zwingend einen neuen Messwert im Gerät.

Der zweite PHP-Worker liest die Quelle unabhängig von MQTT und HTTP-Anfragen.
Privater Cache bis 8 KiB, separate stabile Lockdatei (max. 200 ms), atomarer
Austausch. Heartbeat alle 250 ms zwischen Abfragen, Auslauf nach max(3 s,
Timeout+1 s). Browser pollt auf Übersicht und Diagrammseite jede Sekunde und lässt Werte
auch ohne weitere API-Antworten auslaufen. Störungen blenden nur Hausleistung
aus; MQTT-/Wallboxanzeige bleibt unabhängig. Quelle nicht erreichbar: lokale
URL und bestehende Erreichbarkeit durch berechtigten Betreiber prüfen lassen,
keine ungefragten Netzwerkänderungen. DNS kann OS-bedingt verzögern; der
Supervisor erzwingt nach etwa 2 s das Ende verbliebener Kinder, Compose 10 s.

Kein Hauswert-Publish, keine SQL-/Diagrammaufzeichnung, DTSU666-Integration oder
Ladeautomation. Die bestehenden 16 Wallbox-Präferenzen ändern den Hausbereich
nicht. Docker-/Browsernachweis siehe oben; echter Pi-/Smartmeternachweis offen.

### Erwartete Anzeige und Frische

Startseite **Übersicht** (`/`): kompakte Karten für Wirkleistung, Fahrzeug,
Sessionenergie und Wallbox-Limit, darunter Phasen und Haus-Netzleistung
nebeneinander (mobil untereinander). Die Infokarte „Leistungsrahmen“ entfällt;
„Unter Sollstrom“ bleibt als Messwert in der Diagnose verfügbar. Technische
Rohwerte und Detailprotokoll sind unter **„Diagnose“**
einklappbar. Navigation am Desktop links, auf kleinen Bildschirmen oben;
helles/dunkles Farbschema folgt dem Browser. Datenstatus, Messzeit, Frische und
aktive Fehlerwarnungen sind nicht in den einklappbaren Bereichen versteckt.

Das Theme entspricht „Compact / Dense“ nach Entwurf Nr. 8 in Hell/Dunkel:
kühle Graphitflächen, feine blau-graue Rahmen, 6-px-Kartenecken, zurückhaltende Verläufe/
Schatten, cyanfarbene Leistung, gefüllte mintfarbene Live-Badges und kräftigere
Schriftgewichte. Hell neutral-kühl. Die aktuelle Präzisierung ändert nur CSS-
Designwerte, keine Abstände/Größen/Grids/Breakpoints, HTML/JS oder Funktionen.
Design-CI 40499228102 für acce554 erfolgreich: 49 JS-Tests, alle fünf Chromium-
Suiten mit 30 Theme-/Settings-Fällen und vollständige Backend-/Runtime-Prüfungen.
Palette, unveränderte Layoutgeometrie und mindestens 4,5:1 Textkontrast auf
geprüften Flächen/Verlauf-Endpunkten bei 320/390/768/1440 px in Hell/Dunkel geprüft;
simulierte Bilder von Übersicht, Diagrammen und Settings angesehen. Kein neues
Pi-Deployment. Die Entwürfe sind nur Stilvorlagen;
keine Änderung von Sidebar,
vier Übersichtskarten, Messwerten oder Seitenaufteilung. PHP/API/MQTT und
Wallbox-Frischelogik unverändert, keine neuen Ports. Die Smartmeterkonfiguration
ist ein separat beauftragter Schritt (oben). Ein nativer **Schiebeschalter links
unten** wechselt Hell/Dunkel auf allen drei Seiten: beweglicher Sonne-/Mond-
Schieber mit LIGHT/DARK MODE (160×52 px, 42-px-Schieber). Am Desktop im Sidebar-
Fuß, mobil unten links fixiert; Leertaste schaltet, Fokusrahmen bleibt sichtbar.
**Settings mit Zahnrad unter Diagramme** führt zu `/einstellungen`, weiterhin
ein Platzhalter ohne Hardware-/Ladefunktionen. Wiederholte Untertitel und
Erklärblöcke sind reduziert, Messwerte/Status/Frische/aktive Warnungen bleiben.
Dort stellt **Systemdarstellung verwenden** den Standard wieder her.
**System** (Default) folgt weiterhin `prefers-color-scheme` einschließlich
späterer OS-Änderungen. Auswahl gilt beim Seitenwechsel/Neuladen browserlokal über
`evse-theme-v1` (nur light/dark, System entfernt den Schlüssel); keine Messwerte,
Zugangsdaten oder neuen Servereinstellungen. Bei blockiertem Speicher gilt die Wahl
für die aktuelle Seite und bleibt bei Pageshow erhalten, wenn Speichern scheiterte.
Ohne JavaScript bleiben Theme-Schalter/Reset deaktiviert; Systemfarben wirken.
Schiebeschalter-/Textbereinigungs-CI 40491901055 für 13b8a20 erfolgreich:
49 JS-Tests und alle fünf Chromium-Suiten mit 30 Theme-/Settings-Fällen,
nativer Checkbox, Schieberbewegung, Tastatur, Sidebar-Reihenfolge/Links-unten-
Position und geschützten Messwerten/Warnungen; Backend-/Runtime-Prüfungen ebenfalls
bestanden. 320/390/768/1440 px in Hell/Dunkel geprüft, simulierte Desktop-/Mobilbilder
angesehen; neue Pi-/Browserprüfung und Hauszählerkonfiguration offen. Historische
Symbolschalter-/Smartmeter-CI 40486476429 für 3c92398 erfolgreich (oben).
Historische Auswahlfeld-
CI 40375388768 für 53ce565 erfolgreich: 37 JS-Tests, vier Chromium-
Suiten einschließlich 22 Theme-Browserfällen sowie Backend-/Runtime-Prüfungen.
Erzwungene Hell-/Dunkelansicht mit simulierten Werten visuell geprüft;
kein Pi-Nachweis für die jetzigen Symbolschalter.
Update wie unten mit `docker compose up -d --build`, bei altem CSS Strg+F5.
Theme-CI 40369056814 für ff496f2 erfolgreich: beide Seiten in Hell/Dunkel bei
320/390/768/1440 px, Systemfarbwechsel, geprüfte Textkontraste und weiterhin
geschützte Status-/Warnungsanzeige. Desktop-/Mobilbilder mit simulierten Werten
visuell geprüft; kein tatsächlicher Pi-Nachweis.

**Diagramme** über die Navigation oder direkt **http://127.0.0.1:8080/diagramme**
öffnen (bei abweichendem Tunnelport entsprechend anpassen). Separate Seite,
gleicher Container/SSH-Tunnel, keine neue Freigabe. Vier elektrische Diagramme;
weitere Kurven unter **„Zustands- & Diagnoseverläufe“** öffnen.

Die Oberfläche zeigt Fahrzeuganschluss und tatsächliches Laden getrennt,
Phasenströme/-spannungen, Wirkleistung, Sessionenergie, Wallbox-Limit, Fehlercode
und Messzeit. Zusätzlich eigene **Netzleistung Haus** bei eingerichteter URL.
**Verfügbarer Gebäudestrom ist noch nicht berechnet**; die neue HTTP-Netzleistung
in W ist kein Ladestrom in A und keine DTSU666-Anbindung.
Die Wallbox-Verriegelung ist nicht der ESP32-Servo.
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

Die **Checkboxen direkt am jeweiligen Diagramm** schalten dessen Kurven ein/aus.
Die 16 Wallbox-Präferenzen gelten nur für Diagramme; die Übersicht zeigt alle
Messwerte ohne Auswahlfenster. Auch bei vollständig abgewählten Kurven bleiben
Karte und Checkboxen zum Wiedereinschalten sichtbar. Der Datenstatus mit Verbindung,
Frische und Messzeit steht auf beiden Seiten ganz unten; aktive Fehlerwarnungen
bleiben zusätzlich oben. Periodentasten wählen Live/Stunde/Tag/Woche/Monat/Jahr/
Zeitraum, der Datumswähler passt sich an. Die große Verlaufshinweiskarte entfällt;
kurze Lade-/Fehler-/Unvollständigkeitsmeldungen bleiben erhalten.

**Haus-Netzleistung:** unabhängiger Live-Verlauf seit Öffnen der Diagrammseite,
signed kW (Bezug + / Einspeisung −), maximal 15 Minuten/1200 HTTP-Abrufe im RAM.
Neuladen leert diesen Verlauf. Die Hausquelle besitzt kein SQL-Archiv: bei
Kalenderauswahl wird keine historische Hauskurve behauptet. Eigene Checkbox,
keine Erweiterung der 16 Wallbox-Präferenzen, keine neue Einrichtung/DB-Migration.
Ausfälle/Nullwerte/Veraltung/Lifecycle-/Zeitbrüche erzeugen Lücken, keine Nullen.

**„Alle Kurven anzeigen“** setzt Auswahl und Zeitfenster auf die Defaults
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
Diese vollständige Prüffolge bleibt nach Updates sinnvoll; bestätigt ist bisher
die Live-Übersicht, nicht jeder hier beschriebene Fehler-/Bedienfall.

Historische Diagramm-CI der Python-Version [37204010318](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/37204010318)
bestätigt 21 Python-/MQTT-/HTTP-Tests, 27 JavaScript-Tests und beide Chromium-
Browsersuiten (Auswahl, Persistenz, Phasenspalten, mobile SVGs, Ausfalllücken).
Desktop-/Mobilbilder verwenden simulierte Werte; echten Pi-Empfang/Browserverlauf
separat prüfen, nicht aus diesen Screenshots ableiten.

Historische abschließende Dashboard-CI der Python-Version [37220843434](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/37220843434)
bestätigt 21 Python-/MQTT-/HTTP- und 28 JavaScript-Tests plus drei Chromium-Suiten:
beide Seiten in hell/dunkel bei 320/390/768/1440 px, Navigation/Tastatur, Auswahl,
geschützte Warnungen/Frische, CSP und blockierter Browserspeicher. Simulierte
Desktop-/Mobilbilder wurden geprüft; Seitencache-Rückkehr lädt gemeinsame
Einstellungen neu beziehungsweise bewahrt temporäre Auswahl bei blockiertem
Speicher. PR-CI `37221004357` ebenfalls erfolgreich. Zum damaligen Stand war die
echte Pi-Browserprüfung noch offen; die aktuelle Bestätigung steht unten.
PR #33 wurde durch den Projektinhaber gemergt; obige Updatefolge verwenden.

### Lokale Konfiguration und optionale Zugangsdaten

Eigene `.env` unter `rasppi/weboverlay/`, unabhängig von `rasppi/wallbox/.env`:

| Variable | Default / Bedeutung |
|---|---|
| `WEB_PORT` | `8080`, veröffentlichter Hostport |
| `WEB_BIND_ADDRESS` | `127.0.0.1`; für ausdrücklich gewünschten vertrauenswürdigen LAN-Zugriff lokale Pi-LAN-IPv4-Adresse, ohne zusätzliche Datei |
| `COMPOSE_PROFILES` | leer = HTTP wie bisher; `https` aktiviert zusätzlich den lokalen TLS-Proxy beim Start des gesamten Website-Stacks |
| `WEB_HTTPS_PORT` | `443`/TCP, nur bei HTTPS-Profil; kein öffentlicher Router-Port nötig |
| `WEB_TLS_HOST` | leer = Bindungs-IP; einzelne IPv4/DNS-Identität für interne CA, keine URL/Ports/Wildcards; DNS gegebenenfalls gesondert einrichten |
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
docker compose exec -T weboverlay php -r '$ctx = stream_context_create(["http" => ["timeout" => 3]]); $body = file_get_contents("http://127.0.0.1:8080/api/state", false, $ctx); if ($body === false) { exit(1); } print($body . PHP_EOL);'
```

`/healthz` prüft nur die Webserver-Erreichbarkeit, nicht MQTT-/Wallbox-Verfügbarkeit.
Container „healthy“ und Oberfläche „offline“ widersprechen sich deshalb nicht.
Ein Broker-Ausfall darf den Webserver nicht in eine Neustartschleife treiben.
Bei „Warte auf Daten“ Präfix, Reader-Publishing, Broker-Abonnementrechte und Uhrzeit
prüfen. Für MQTT-Diagnose weiterhin den Subscriber aus Abschnitt 5 verwenden.

Tests unabhängig von Hardware wiederholen, vollständig in Docker:

```bash
docker build --target test -t evse-weboverlay-tests .
docker run --rm --entrypoint php evse-weboverlay-tests tests/unit.php
docker run --rm --entrypoint php evse-weboverlay-tests tests/shared.php
docker run --rm --entrypoint php evse-weboverlay-tests tests/transport.php
docker run --rm --entrypoint node evse-weboverlay-tests tests/integration.cjs
docker run --rm evse-weboverlay-tests node --test tests/frontend.test.cjs tests/charts.test.cjs
```

Update nach Git-Aktualisierung: `docker compose up -d --build`.
Stoppen: `docker compose down`. Das betrifft nur das Weboverlay, nicht Reader
oder vorhandenen Broker. Der Dienst speichert keinen serverseitigen Verlauf; nach Neustart
werden neue/retained Nachrichten erneut geprüft. Kein Datenbankdienst enthalten.
HTTP-Anfragen bauen keine MQTT-Verbindung auf; nur der eine PHP-CLI-Worker
verwendet die MQTT-Client-ID und schreibt Snapshot/Heartbeat. Prozess-/Compose-
Stopfristen begrenzen das Beenden, nicht eine erfolgreiche MQTT-Abmeldung.
Das Overlay veröffentlicht selbst nichts und
besitzt keinen Hardwareport, auch ein erzwungenes Beenden stoppt den Reader nicht.

Historische Docker-CI der Python-Version [37200290345](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/37200290345)
bestätigt 21 Python-/MQTT-/HTTP-Tests, 13 JavaScript-Tests und Chromium-Browsertests sowie das
gehärtete Laufzeit-Image ohne Broker. Desktop-/Mobil-Screenshots mit simulierten
Messwerten wurden geprüft; das ist kein Nachweis der Browseranzeige am echten Pi.
Browser-Regressionen prüfen auch Ablauf ohne Antwort, hängende/verspätete Requests,
Abort-Verhalten, simulierte Visibility-/Pageshow-Ereignisse, fehlende Fetch-
Parallelität und unveränderte Live-Region-Texte. Simulatorereignisse sind kein
vollständiger Nachweis aller Bfcache-/Suspend-Varianten jedes Browsers.

**Am 2026-10-26 vom Projektinhaber bestätigt:** Dienst läuft und zeigt Messwerte
im Browser; Screenshot der Live-Übersicht im Dark-Theme mit Messzeit 18:52:39,
MQTT online, Alter 1 s, 0 kW, Limit 6 A, angeschlossen/nicht ladend und
234,8/235,0/235,2 V. Bestätigte Momentaufnahme, keine unabhängige Messvalidierung.
Websitezugriff und bisheriges großes Auswahlfeld am 2026-10-27 erneut bestätigt.
**Weiter offen:** neue Symbolschalter/Haus-Smartmeter, weitere Diagramm-/Hellansicht-
und gezielte Ausfall-/Frischeprüfungen am Pi. Kein Agent-Deployment; automatische Tests
ersetzen diese Bedien-/Fehlerfallprüfung nicht.

### SQL-Verlauf optional einrichten

Separat beauftragt: PHP/PDO kann die letzten 15 Minuten gespeicherter Wallbox-
Telemetrie für die vorhandenen Diagramme lesen. Zeitfenster 1/5/15 Minuten,
Layout, Theme und Live-MQTT bleiben unverändert. Default deaktiviert; keine
Preise/Hausdaten, SQL-Schreibbefehle, Migration, neuen Worker oder Hostports.

**Reader-Status:** `smartReader` wurde über Socket und Docker-TCP
mit 1045 abgewiesen. Das ist ein Anmeldefehler vor der Tabellenabfrage, kein
Nachweis fehlender SELECT-Rechte. Einrichter muss exakten Namen, Passwortzuordnung
und Hostfreigabe klären. Keine Passwortversuche/Resets, Grantänderung durch `smart`
oder automatischer Writer-Fallback. **Danach ausdrücklich freigegebene Zwischenlösung:**
Der Projektinhaber erlaubt für den Anfang `smart` auch für die Historie. Das Konto
selbst bleibt überprivilegiert; nur die Websiteabfragen sind lesend und zusätzlich
durch eine Read-only-Transaktion begrenzt. Kein Least-Privilege-Nachweis behaupten.

Benötigt: vorhandene MariaDB/Schema 1 mit allen drei `evse_*`-Tabellen und den
Indizes `source_measurement`/`source_receipt`, laufender Collector für neue Daten,
bestehendes externes `evse-data` mit DB-Alias und ein freigegebenes Konto.
Empfohlen sind nur **SELECT auf diesen drei Tabellen**; Preis-/Provider-,
Schreib-, DDL-, globale oder weitergebbare Rechte sind nicht nötig. Die
Zwischenlösung mit `smart` hat mehr Rechte, die nicht ungefragt geändert werden.
Keine zweite DB,
Port-/Firewalländerung oder neue Hostabhängigkeit; PDO/mysqlnd nur im Docker-Build.

In `rasppi/weboverlay` vorhandene `.env` erhalten und nur lokal ergänzen:

```dotenv
HISTORY_DB_HOST=evse-database
HISTORY_DB_PORT=3306
HISTORY_DB_NAME=energyControl
HISTORY_DB_USERNAME=smart
DB_NETWORK=evse-data
HISTORY_DB_PASSWORD_HOST_FILE=/ABSOLUTER/PRIVATER/PFAD/history-reader-password.txt
```

Das Beispiel nutzt die bewusst gewählte Zwischenlösung. Zur späteren Härtung
den tatsächlich funktionierenden Leseaccount eintragen; `smartReader` bleibt
generischer Default, kein automatisch bestätigter Login. Name exakt
`energyControl`, nicht `energy_control`. Eigene Passwortdatei für Website-UID
10001 neu anlegen: Writer-Datei nicht direkt in die Website mounten, keine
vorhandenen fremden Secrets überschreiben.
Interaktive Bash; bei Rootless/Usernamespace vorher Host-UID-Mapping abgleichen:

```bash
(
  set +x
  set -e
  umask 077
  mkdir -p secrets
  chmod 700 secrets
  test ! -e secrets/history-reader-password.txt
  unset SECRET
  IFS= read -r -s -p 'Passwort des bewusst gewählten DB-Kontos: ' SECRET
  printf '\n'
  test -n "$SECRET"
  temporary="$(mktemp secrets/.history-reader.XXXXXXXX)"
  printf '%s\n' "$SECRET" > "$temporary"
  unset SECRET
  sudo chown 10001:10001 "$temporary"
  sudo chmod 0400 "$temporary"
  mv -n "$temporary" secrets/history-reader-password.txt
)
```

Alternativ darf für die ausdrücklich gewählte `smart`-Zwischenlösung eine eigene
geschützte Kopie der schon berechtigt eingerichteten Projektdatei erzeugt werden
(statt des obigen Eingabeblocks, nur ohne abweichendes UID-Mapping):

```bash
(
  set -e
  umask 077
  mkdir -p secrets
  chmod 700 secrets
  test ! -e secrets/history-reader-password.txt
  sudo install -o 10001 -g 10001 -m 0400 \
    ../storage/secrets/migration-password.txt \
    secrets/history-reader-password.txt
)
```

Dateiname bezeichnet den Lesezweck, nicht eingeschränkte Accountrechte. Kein
Auslesen anderer Infrastruktur-Secrets. Den absoluten lokalen Dateipfad in
`.env` eintragen, nicht posten. Dann
explizit mit zusätzlichem Overlay bauen/starten:

```bash
docker compose -f compose.yaml -f compose.history.yaml up -d --build weboverlay
docker compose -f compose.yaml -f compose.history.yaml ps
```

Bei bereits konfigurierter MQTT-Dateiauthentifizierung immer **beide** Overlays
nutzen und funktionierende MQTT-Secrets erhalten:

```bash
docker compose -f compose.yaml -f compose.auth.yaml -f compose.history.yaml \
  up -d --build weboverlay
```

`compose.history.yaml` aktiviert die Option, ergänzt nur den Websitebeitritt zum
bestehenden DB-Netz und den eigenen readonly Secretmount. Nur den Flag
`WEB_HISTORY_ENABLED` umzuschalten ersetzt Netzwerk/Mount nicht. Bei späteren
Aufrufen dieselbe Overlay-Auswahl verwenden. Apache/MQTT-/Haus-Worker bleiben
drei Prozesse; DB-Ausfall ist kein Livenessfehler und ändert `/api/state` nicht.
Bei späterem atomarem Austausch der Passwortdatei den Websitecontainer mit
derselben Overlay-Auswahl und `up -d --force-recreate weboverlay` neu erstellen:
Ein bestehender Einzeldatei-Bind-Mount kann sonst noch die alte Datei verwenden.
Dies betrifft nur die Website, nicht MariaDB/Collector oder deren gespeicherte Daten.

Unter `/diagramme` unterscheidet der vorhandene Hinweis geladene, unvollständige,
nicht verfügbare oder rein lokale Historie. Neuladen kann gespeicherte Punkte
wieder anzeigen; sie sind historisch, **nicht live**. Leerer Zeitraum bedeutet
nicht Nullleistung. API im Browser über den bestehenden Tunnel prüfen:
`/api/history?minutes=15` liefert `ok`/200, `disabled`/200 oder `unavailable`/503.
Keine Passwort-/Env-Dumps posten. Vertrag, Limits/Timeouts und konservative Lücken:
[Historien-API](history-api.md). Nach Merge von PR #46 und dieser Anleitung meldet
der Projektinhaber am 2026-10-27 „funktioniert“. Eine gezielte API-Ausgabe,
Reload-/Ausfallprüfung und Langzeitvalidierung wurden noch nicht vorgelegt;
keinen weitergehenden Produktionsnachweis oder Agent-Deployment behaupten.

Isolierte Tests, ausschließlich mit eigener Testdatei/Dummy-Accounts:

```bash
docker compose -f compose.history-test.yaml build history-tests
docker compose -f compose.history-test.yaml up --abort-on-container-exit \
  --exit-code-from history-tests
docker compose -f compose.history-test.yaml down --volumes
```

Nur diese Datei enthält einen flüchtigen MariaDB-11.8.8-Testserver, internes Netz
und keine Hostports/Produktivnetze. `down --volumes` nie gegen bestehende Infrastruktur
verwenden. Docker-CI und echte Pi-/Accounttests getrennt berichten.

### Kalender-/Jahresverlauf zusätzlich einrichten (optionales Schema 2)

**Neue optionale Erweiterung:** Docker-CI 40678971209 für c83b1cc erfolgreich,
reale Pi-Aktivierung noch offen. Erst nach Merge und Prüfung des freigegebenen
Standes aktivieren. Der bestehende Minutenverlauf
benötigt weiterhin nur Schema 1. Kalenderansichten für Stunde, Tag, ISO-Woche,
Monat, Jahr und eigenen Zeitraum lesen ausschließlich vorverdichtete Daten.
Ein Jahr ist die maximale **Anzeigespanne**, keine Aufbewahrungs-/Löschfrist.
Vor Beginn der Aufzeichnung existieren keine nachträglich erzeugten Messwerte;
vorhandene Strompreise sind keine Wallboxmessungen und werden nicht umgedeutet.

Voraussetzungen: funktionierender Schema-1-Collector, aktuelle Sicherung auch der
inzwischen aufgezeichneten EVSE-Rohdaten, ausdrücklich freigegebene additive
Migration und kompatible Website. Die alten Sicherungen vor Schema 1 enthalten
noch keine EVSE-Messungen. Bestehende `.env`, Netzwerkzuordnungen und geschützte
Passwortdateien **behalten**; keine neuen Accounts oder Grants automatisch ändern.
Ein eingeschränkter Website-Reader braucht zusätzlich SELECT auf den drei neuen
Tabellen; die ausdrücklich erlaubte temporäre `smart`-Konfiguration bleibt möglich.
Collector/Worker brauchen zusätzlich SELECT/INSERT/UPDATE ausschließlich an den
neuen eigenen Historytabellen. Original-Samples/Events bleiben append-only.

Die explizite `--migrate-history`-Migration erstellt ausschließlich
`evse_history_buckets`, `evse_history_work`, `evse_history_state` und registriert
Version 2 **zusätzlich** zu Version 1. Keine Umwandlung/Löschung der bestehenden
Mess-, Preis-/Providertabellen. Default-`--migrate` bleibt Schema 1; Laufzeit startet
keine DDL. Minuten-/Stunden-/Tagesverdichtung und resumierbarer Backfill laufen in
einem eigenen `history-rollup`-Container aus demselben Storageimage. Keine neue DB,
kein Broker, kein Hostport/Hardwarezugriff und kein vierter Websiteprozess.

**Reihenfolge ist zwingend:** Eine bereits mit Schema 1 verbundene alte
Collectorinstanz kennt die neuen Dirtymeldungen nicht. Deshalb erst die kompatible
Website bereitstellen, dann den Collector vor der Migration stoppen und aus dem
aktualisierten Image starten; den Worker niemals zuerst gegen den alten weiter-
laufenden Collector aktivieren. Die kurze Collectorpause kann eine Aufzeichnungslücke
verursachen, MQTT-retained ist kein Replay. Reader/Broker/MariaDB bleiben aktiv.

Nach Merge und sauberem Repositoryupdate, aus `rasppi/weboverlay`, zunächst nur
die aktualisierte Website mit **derselben bisherigen Overlayauswahl** bauen:

```bash
docker compose -f compose.yaml -f compose.history.yaml up -d --build weboverlay
```

Bei bereits genutzter MQTT-Dateiauthentifizierung wie bisher zusätzlich
`-f compose.auth.yaml` vor dem Historyoverlay verwenden. Nicht neu hinzufügen,
wenn keine passende lokale Konfiguration vorliegt. Die neue Website versteht
die Versionsmengen `{1}` und `{1,2}`; der alte Websitecode nur Schema 1.

Dann nach `rasppi/storage` wechseln. Auch dort vorhandene Auth-Overlays bei
Build/Start unverändert beibehalten. Jeden Block einzeln ausführen:

```bash
docker compose -f compose.yaml build storage
docker compose -f compose.yaml stop storage
```

Nur den Migrationsclient mit vorhandenem, berechtigtem Projektzugang starten;
bewusst **ohne `--rm`**, damit der Container prüfbar erhalten bleibt:

```bash
docker compose -f compose.yaml --profile tools run \
  --no-deps -T --interactive=false migrate --migrate-history
```

Nur bei erfolgreichem Abschluss und `storage: schema version 2 ready` fortfahren.
Bei Fehlern keine Version manuell registrieren, keine Tabellen/Volumes löschen;
erst die nicht geheimen Fehlermeldungen und die konkrete Schemaform prüfen.
Additive DDL ist nicht vollständig transaktional; erneuter Lauf prüft vorhandene
Teiltabellen statt sie zu ersetzen. Keine Host-Pakete installieren.

```bash
docker compose -f compose.yaml up -d storage
docker compose -f compose.yaml --profile history up -d history-rollup
docker compose -f compose.yaml --profile history ps
docker compose -f compose.yaml --profile history logs --tail 30 storage history-rollup
```

Das aktualisierte `storage` wird dabei neu gestartet und erkennt Schema 2, bevor
es neue Reads schreibt; neue Daten und Dirtymeldungen committen zusammen vor ACK.
Workerfehler pausieren keine Modbusabfragen und blockieren keine Collector-ACKs.
Orphan-Warnungen zu erhaltenen Migrationscontainern sind kein Aufräumauftrag;
**kein `--remove-orphans`, kein `down --volumes` gegen den Produktivstack.**

Website über den vorhandenen Tunnel öffnen, neu laden und unter `/diagramme`
die Ansicht und das Kalenderdatum wählen. „Jetzt“ springt in die aktuelle
gewählte Periode, Pfeile wechseln die Periode. Zeitzone ist ausdrücklich
`Europe/Vienna`; Sommerzeit-/Schalttage haben ihre tatsächlichen Grenzen.
Archivdaten verändern keine Live-Frische. Bei laufendem Backfill/Dirtyarbeit
bleiben unvollständige Intervalle als solche gekennzeichnet. `healthy` des Workers
bedeutet laufende DB-Verarbeitung, nicht abgeschlossenen Jahresbackfill.

Für größere Intervalle sind W/A/V stichprobengewichtete Mittel mit Min/Max-Spannen,
keine zugesicherten zeitgewichteten Energieintegrale. Sessionenergie ist der
letzte Sessionzähler, **kein Tages-/Jahresverbrauch**. Gemischte/fehlende Zustände
werden nicht zu konstantem „Nein“ oder Null. API und Grenzen:
[Kalendervertrag](history-range-contract.md). Reale Aktivierung/API-/Browser-
und Ausfallnachweise erst nach tatsächlicher Prüfung dokumentieren.

## 10. MQTT-Zustandsspeicherung in der vorhandenen MariaDB

**Erster Datenbankabschnitt:** Wallbox-Samples (auch Lesefehler) und Availability-
Beobachtungen speichern. Keine Ladesteuerung, SQL-Diagrammabfrage, RFID-/UART-
oder Zählerdaten. Haus-HTTP-Anzeige und Live-MQTT bleiben unabhängig; die separat
beauftragte optionale PHP-Historienabfrage der Website schreibt keine SQL-Daten.
Die Produktions-Compose startet **keinen DB-Server und keinen Broker**.

### Bestehende Datenbank prüfen, nicht ersetzen

**Bestätigter Stand vom 2026-10-27, anhand der vom Projektinhaber ausgeführten SQL-Abfragen:**

- Vorhandener Container **`maria_uno`**, Image `mariadb:lts`; SQL-Serverversion
  **11.8.8-MariaDB-ubu2404**, authentifizierter Account **`smart@%`**.
- Ziel ist ausdrücklich die vorhandene Datenbank **`energyControl`**. Der
  Projektinhaber hat eigene EVSE-Tabellen darin freigegeben. Die bisherigen
  Tabellen **`T_ELECTRICITYPRICE`** und **`T_ELECTRICITYPROVIDER`** samt Daten
  bleiben unverändert; keine Preis-/Providerintegration im Collector.
- `smart` besitzt `CREATE`, `SELECT`, `INSERT` und weitere Schema-Rechte in
  `energyControl`, aber global nur `USAGE`; keine weitergebbaren Rechte
  (`IS_GRANTABLE=NO`). Damit ist er für die freigegebene Initialmigration geeignet,
  nicht für die Benutzerprovisionierung. Als Collector-Login ist er stärker
  privilegiert als nötig; siehe bewusste Bestandskonto-Nutzung unten.
- Zugriff auf `mysql.global_priv` wurde abgewiesen; passwortloser Root-Socket-
  Zugang ebenfalls. Es gibt keinen bestätigten Adminzugang. `evse_control` war
  für `smart` nicht sichtbar, seine Nichtexistenz ist damit **nicht** bewiesen.
- Schema-default `utf8mb4` / `utf8mb4_uca1400_ai_ci` bestätigt. Bestand umfasst
  274.804 Preise für Hofer Strom/Awattar und 2 Anbieter; nicht als leere DB behandeln.
  Zeitformat/Preisskalierung und laufende Aktualisierung sind noch nicht geklärt.
- Bestandssicherung vor Migration auf Pi und PC mit SHA256 geprüft, isolierter
  Restore desselben MariaDB-Images ohne Netzwerk/Ports/Produktivvolume erfolgreich:
  274.804 Preise, 2 Anbieter. Testcontainer danach gestoppt. Dieser Snapshot enthält
  noch keine erst danach angelegten EVSE-Tabellen, keine Serveraccounts/-konfiguration.
- `evse-data` angelegt und vorhandene MariaDB zusätzlich mit Alias `evse-database`
  verbunden; bisheriges `bridge` beibehalten. Schema 1 angelegt, SQL zeigt alle fünf
  Tabellen und `applied_at=2026-10-27 17:13:09.298160` UTC. Preis-/Anbieterzahlen
  nach Migration unverändert.
- Collector mit bewusst gewähltem Bestandskonto `smart` produktiv: SQL zeigt
  207 Samples, Messzeit 17:44:23 UTC, 0 W, Limit 6,000 A und Phasenspannungen
  233,7/233,2/234,8 V. Das ist ein Empfangs-/Speichernachweis, kein Langzeit-,
  Ausfall-, unabhängiger Messvergleichs- oder abschließender Healthchecknachweis.
  `smartReader` ist laut Projektinhaber das Lesekonto; dessen Login/Grants wurden
  hier nicht geprüft, die gezeigten Kontrollen verwendeten `smart`.
- Offen: regelmäßige aktuelle Backups, ggf. Rechtehärtung und TLS-Nachweis.
  Alle genannten Pi-Schritte wurden vom Projektinhaber ausgeführt, nicht vom Agent.

**Für eine Wiederinstallation sind Container-, Account- und Schemanamen lokal
zu verifizieren.** `energyControl`/`smart` sind die bestätigte aktuelle Zuordnung,
keine fest eingebauten Namen: Compose/Code bleiben konfigurierbar. Der
unveränderte `.env.example`-Default `DB_NAME=evse_control` muss für diesen Ablauf
lokal auf **`energyControl`** geändert werden; Groß-/Kleinschreibung beibehalten.

Historisch wurde ein persistentes Volume nach `/var/lib/mysql` und das Standard-
netz `bridge` ohne Alias beobachtet. **Volume ist kein Backup.** Ursprüngliche
Startdefinition/Volumes erhalten, nicht ersetzen, neu initialisieren oder löschen.
Port 3306 war am Host gebunden; das belegt weder öffentliche Erreichbarkeit noch
Absicherung. Keine Änderung an Ports, Firewall oder WireGuard als Nebenwirkung.
Vor Einrichtung lokal auf dem Pi prüfen (keine vollständigen Inspect-/Env-Dumps):

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
docker inspect --format '{{.Config.Image}}' maria_uno
docker inspect --format '{{range $name, $network := .NetworkSettings.Networks}}{{printf "%s " $name}}{{json $network.Aliases}}{{println}}{{end}}' maria_uno
docker inspect --format '{{range .Mounts}}{{println .Type "->" .Destination}}{{end}}' maria_uno
```

Mit dem **berechtigt übergebenen** Passwort anmelden; `-p` fragt verdeckt ab.
Kein Passwort im Befehl, Chat, Repository oder Log; kein SSH-Passwort annehmen:

```bash
docker exec -e MYSQL_HISTFILE=/dev/null -it maria_uno \
  mariadb --no-defaults --protocol=socket -u smart -p
```

In dieser Konsole zunächst nur lesen:

```sql
SELECT CURRENT_USER() AS account, VERSION() AS version;
SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME
FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = 'energyControl';
SHOW TABLES FROM energyControl;
SELECT GRANTEE, PRIVILEGE_TYPE, IS_GRANTABLE
FROM information_schema.USER_PRIVILEGES;
SELECT GRANTEE, TABLE_SCHEMA, PRIVILEGE_TYPE, IS_GRANTABLE
FROM information_schema.SCHEMA_PRIVILEGES;
```

**Vor Migration stoppen, wenn** Sicherung/Restore bzw. ausdrückliche Risikoakzeptanz
nicht geklärt ist, Ziel-/Rechte-
zuordnung abweicht, unerwartete `evse_*`-Tabellen existieren oder der Default-
Zeichensatz nicht **`utf8mb4`** ist. Die aktuelle SQL-Migration übernimmt für
Enums/Fehlertext den Datenbankdefault, die Verifikation verlangt UTF-8.
In einem geteilten Schema deshalb **kein pauschales `ALTER DATABASE` und kein
Ändern fremder Tabellen**; passende Einrichtung der neuen EVSE-Tabellen bzw.
ein eigenes UTF-8-Schema erst gesondert abstimmen. Ein bloßes `SET NAMES` löst
eine abweichende Tabellencodierung nicht.

`smart` braucht für diese Migration keinen Zugriff auf `mysql.global_priv`,
kein `CREATE USER` und kein `GRANT`. Die Benutzerprovisionierung bleibt Aufgabe
eines berechtigten Betreibers. Weder `SHOW CREATE USER` noch ungefilterte Grants/
Inspect-/Env-/Secret-Ausgaben in Chat oder Repository übernehmen; sie können
Passwort-Hashes oder andere Secrets enthalten. Keine weiteren Root-Passwort-
versuche, neue Root-Freigabe oder Recovery/Reset ohne separaten Auftrag.

Der `lts`-Tag ist keine feste Versionsangabe: bestehenden Server nicht zum Prüfen
neu erstellen/upgraden. SQL-Version ist jetzt authentifiziert bestätigt.
CI [37212624186](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/37212624186)
bestätigt je 39 Tests + Runtime unter 10.11.19, exakt **11.8.8** und 11.8.9.
Der rollende `11.8`-Tag bezeichnet nicht zwingend die bestätigte installierte 11.8.8;
CI ist amd64 und kein echter Pi-ARM64-/Migrationsnachweis. Andere Versionen erst
prüfen, niemals bestehenden Server/Volumes zum Erfüllen der Versionsangabe ersetzen.
Keine globalen SQL-Settings, WireGuard/SSH, Portfreigaben oder fremden Tabellen ändern.
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
docker network connect --alias evse-database evse-data maria_uno
```

`DB_HOST=evse-database` gilt nur nach dieser tatsächlichen Aliaszuordnung;
alternativ vorhandenen erreichbaren DB-Alias eintragen. `127.0.0.1` im Collector
ist nicht MariaDB/Pi-Localhost. Kein neues Host-Portmapping erforderlich.
Manuelle Netzwerkzuordnung überlebt Containerneustart, nicht dessen Neuerstellung.
Die ursprüngliche MariaDB-Compose muss später dasselbe externe Netz/Alias pflegen;
deren bisher unbekannte Definition/Volumes keinesfalls durch Beispiel-Compose ersetzen.
Netzwerk und Alias wurden auf diesem Pi inzwischen wie oben eingerichtet.
Bei Wiederinstallation zuerst aktuellen Stand prüfen, nicht doppelt verbinden;
ein Socket-Login allein bestätigt keinen SQL-Zugang aus dem Clientnetzwerk.

### Aufbau innerhalb von energyControl

Die vorhandenen Preis-/Providertabellen werden **weder umgebaut noch gelöscht**.
Schema-Version 1 ergänzt genau drei unabhängig benannte Tabellen:

| Tabelle | Zweck und wesentliche Struktur |
|---|---|
| `energyControl.evse_schema_versions` | `version INT` als Primärschlüssel und `applied_at DATETIME(6)` in UTC; nach erfolgreicher Initialmigration genau Version `1`. |
| `energyControl.evse_wallbox_samples` | Wallbox-Sample, `id BIGINT UNSIGNED AUTO_INCREMENT`, Quellpräfix `VARBINARY(240)`, normalisierter Payload-Hash `BINARY(32)`; UNIQUE auf `(source, payload_sha256)`. |
| `energyControl.evse_ingest_events` | Collector-/Broker-/Availability-/Lückenereignisse mit UUID `BINARY(16)` als Primärschlüssel, Quelle, UTC-Empfangszeit, Typ, nullable Availability, Retained-Flag und bereinigtem JSON. |

Die Sample-Tabelle enthält getrennte `measured_at`, `received_at` und nullable
`last_success_at` (`DATETIME(6)`, UTC), Retained-Flag, `status=ok|error` und nullable
`communication_error`. Die 16 Wallbox-Messwerte bleiben typisiert und nullable:

- Stromlimit und drei Phasenströme: `DECIMAL(14,3)` in **A**.
- Drei Phasenspannungen: `DECIMAL(14,1)` in **V**.
- Wirkleistung und Sessionenergie: `INT UNSIGNED` in **W / Wh**.
- Anschluss, tatsächliches Laden und Unter-Sollstrom-Flag: nullable Booleans.
- Fehler-/Ladezustands-/Roh-/Buchsenverriegelungscodes: nullable `INT UNSIGNED`.
- `payload_json` bzw. `details_json`: `LONGTEXT utf8mb4_bin` mit `JSON_VALID`-
  Prüfung. Quelle/Hashes bleiben binär; keine sprachabhängige Deduplizierung.

Alle drei Tabellen sind **InnoDB**. Indizes unterstützen Quell-/Messzeit- und
Empfangszeitabfragen. Keine Fremdschlüssel zu den Preis-/Providertabellen,
keine Ladefreigabe-/RFID-/Ladesessiontabellen und keine HTTP-Haus-Smartmeterdaten.
Die kanonischen Definitionen liegen in `rasppi/storage/migrations/001_initial.sql`
und `storage/database.py` (Versionstabelle/Verifikation); nicht per Hand eine
abweichende zweite SQL-Definition pflegen oder nur eine Versionszeile eintragen.

### Einrichtungskonto und späterer Collector-Account

Für die aktuelle Initialmigration **`DB_MIGRATION_USERNAME=smart`** und
**`DB_NAME=energyControl`** setzen. Sein berechtigtes Passwort bleibt lokal.
Die Migration nutzt ausschließlich `CREATE`, `SELECT`, `INSERT` an den eigenen
`evse_*`-Tabellen; sie erteilt keine Rechte und erstellt keine Datenbank/Accounts.
`smart` besitzt zusätzliche ALTER-/DROP-/DELETE-Rechte. **Empfohlen** sind nur
die unten genannten Minimalrechte. Der Projektinhaber hat klargestellt, dass
`smart`/`smartReader` für dieses Projekt eingerichtet wurden und bewusst die
vorhandenen Konten gewählt: aktuell `DB_USERNAME=smart`, Lesen vorgesehen über
`smartReader`. Ein neuer Account ist keine technische Voraussetzung. Bestehende
Rechte nicht ungefragt ändern, da andere Dienste/Migration sie benötigen können.
Der Collector führt zur Laufzeit nur SELECT/INSERT aus, verhindert mit diesem
überprivilegierten Account aber nicht jeden denkbaren Lösch-/DDL-Missbrauch.
Ein reiner Leseaccount reicht zum Speichern nicht.

Für einen separaten minimal berechtigten Collector-Account kann ein berechtigter
Betreiber beispielsweise `evse_storage` bereitstellen. Dafür reichen nach Migration
SELECT auf `evse_schema_versions` und SELECT/INSERT auf den beiden Datentabellen;
keine Rechte auf `T_ELECTRICITYPRICE`/`T_ELECTRICITYPROVIDER` oder andere Daten.
Die SQL-Beispiele stehen nach dem Migrationsschritt. `smart` hat kein GRANT-Recht
und darf diesen Schritt nicht stellvertretend durch Passwort-/Root-Versuche lösen.

Für eine andere Installation bleibt ein eigenes Schema `evse_control` möglich:
ein berechtigter Betreiber legt es in `utf8mb4` an und provisioniert einen
Migrationsaccount mit SELECT/INSERT/CREATE sowie den eingeschränkten Collector-
Account. Diese alternative Admin-Einrichtung ist **kein** erforderlicher oder
bereits erfolgreicher Schritt für den aktuell freigegebenen `energyControl`-Weg.

### Konfiguration und Passwortdateien

Auf dem Pi nach Merge im Repository-Hauptverzeichnis; vorhandene `.env` erhalten:

```bash
git switch main
git pull --ff-only
cd rasppi/storage
test -e .env || cp .env.example .env
umask 077
mkdir -p secrets
chmod 700 secrets
```

`.env` lokal editieren: verifizierte `DB_HOST`, `DB_NETWORK`, `DB_PORT`, `DB_NAME`,
Accounts und ggf. MQTT-Benutzer. Für den aktuellen Zielaufbau (Host/Alias erst
nach tatsächlicher Netzwerkprüfung übernehmen):

```dotenv
DB_HOST=evse-database
DB_NETWORK=evse-data
DB_PORT=3306
DB_NAME=energyControl
DB_MIGRATION_USERNAME=smart
DB_USERNAME=smart
```

Das Beispiel folgt der bewussten Nutzung des Bestandskontos. Für Minimalrechte
stattdessen den tatsächlich bereitgestellten eigenen Writer eintragen;
`evse_storage` ist bisher kein bestätigter Login. Compose-/Code-Defaults bleiben
`evse_control`/`evse_storage`/`evse_migrator`; nur lokale Konfiguration anpassen.
Keine Passwörter in `.env` erforderlich, keine bestehenden MQTT-Werte überschreiben.
`MQTT_CLIENT_ID=evse-storage` muss sich vom Reader/Overlay und jedem anderen
laufenden Client unterscheiden. Präfix muss dem Reader entsprechen; keine Wildcards.

**Für die reine Migration zunächst nur** die eigene Migrations-Passwortdatei
mit dem berechtigt übergebenen Passwort für `smart` anlegen. Noch keine Runtime-
Datei mit demselben Passwort erzeugen und `storage` noch nicht starten.
Vor den `chown`-Beispielen die Host-UID-Zuordnung prüfen: `10001:10001` gilt für
den unveränderten Dockerbetrieb ohne abweichendes Rootless-/Usernamespace-Mapping.
Interaktive Bash, ohne Passwort in Shell-Argumenten/History oder Debug-Ausgabe:

```bash
set +x
umask 077
IFS= read -r -s -p 'Passwort des Einrichtungskontos: ' SECRET; printf '\n'
printf '%s\n' "$SECRET" > secrets/migration-password.new
unset SECRET
sudo chown 10001:10001 secrets/migration-password.new
sudo chmod 0400 secrets/migration-password.new
mv -f secrets/migration-password.new secrets/migration-password.txt
```

Bei Rootless-/Usernamespace-Docker die entsprechende Host-UID-Zuordnung prüfen.
Dateien werden einzeln readonly gemountet und müssen für Container-UID **10001**
lesbar sein. Nie bestehende Broker-/DB-Passwortdateien chmod/chownen oder Secrets
weltlesbar machen. Zum späteren Ersetzen ggf. eine neue Datei im geschützten
Verzeichnis schreiben, berechtigen und austauschen, nicht fremde Dateien verändern.
Leere/zu große Dateien, mehrzeilige Passwörter und parallele ENV-/FILE-Angabe
werden abgelehnt. `secrets/`, `.env`, `backups/` sind ausgeschlossen aus Git/Build.
Wurde eine Secretdatei durch Umbenennen ausgetauscht, den betroffenen **EVSE-
Clientcontainer** neu erstellen, damit sein Bind-Mount die neue Datei verwendet;
kein Neustart/Neuanlegen von MariaDB nötig. Keine Dateiinhalte zur Diagnose ausgeben.

Bei MQTT-Passwort ebenfalls eine **eigene** `secrets/mqtt-password.txt` mit diesen
Berechtigungen vorbereiten und `MQTT_USERNAME` setzen. Ab dann alle Runtime-
Aufrufe mit `docker compose -f compose.yaml -f compose.auth.yaml …` ausführen.
Ohne Passwortdatei Basis-Compose verwenden; anonymous Brokerzugang bleibt nur
eine bestehende Konfiguration, kein Sicherheitsnachweis.

### Explizite Migration, anschließend SQL-Prüfung

```bash
docker compose -f compose.yaml build storage
docker compose -f compose.yaml --profile tools run \
  --no-deps -T --interactive=false migrate
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
Die **Migrations-Passwortdatei** kann danach geschützt/offline verwahrt werden;
der laufende Collector mountet sie nicht. Die SQL-Migrationsdatei bleibt im Image.

Mit dem Einrichtungskonto in der vorhandenen MariaDB prüfen:

```sql
SHOW TABLES FROM energyControl;
SELECT version, applied_at FROM energyControl.evse_schema_versions;
SELECT COUNT(*) AS samples FROM energyControl.evse_wallbox_samples;
SELECT COUNT(*) AS events FROM energyControl.evse_ingest_events;
```

Erwartet nach erster erfolgreicher Einrichtung: die beiden alten Tabellen plus
die drei `evse_*`-Tabellen, Schema-Version 1. Leere Sample-/Eventtabellen vor dem
ersten Collector-Start sind normal. Die alten Tabellen bleiben bestehen; ihre
Daten werden nicht als Nachweis einer erfolgreichen EVSE-Aufzeichnung verwendet.
Dieser Aufbau wurde auf dem Pi wie oben bestätigt. Der einmalige
Migrationscontainer bleibt absichtlich zur Kontrolle erhalten: kein `--rm`.
Spätere Orphan-Warnung bezeichnet diesen behaltenen Einmalcontainer; nicht
ungefragt `--remove-orphans`/`down --volumes` zur Bereinigung verwenden.

### Writer wählen, dann Collector starten

Für den **aktuell gewählten Bestandsaccount `smart`** kann dessen bereits
funktionierende Migrations-Passwortdatei in eine eigene Runtime-Datei kopiert
werden. Das ist kein Lesen/Übernehmen fremder Einrichtungs-Secrets. Nur im
Standard-Docker ohne abweichendes UID-Mapping, mit den oben geprüften Rechten:

```bash
(
  set -e
  if [ -e secrets/db-password.txt ]; then
    echo 'Datei existiert bereits; nicht überschreiben, zuerst Zuordnung prüfen.'
    exit 1
  fi
  sudo install -o 10001 -g 10001 -m 0400 \
    secrets/migration-password.txt secrets/db-password.txt
)
```

Wenn diese Bestandskonto-Option gewählt wurde, **keinen neuen Account anlegen**
und direkt zum Startblock unten gehen. Die nächste Option samt neuer
Passworteingabe gilt nur für einen gesondert beauftragten Minimalrechte-Account:

<details>
<summary>Optional: eigener Writer mit minimalen Tabellenrechten</summary>

**Nur ein dazu berechtigter Betreiber**, nicht `smart`, legt den separaten
Collector-Account über sein geschütztes Adminverfahren an. Vorhandene gleichnamige
Accounts zuerst prüfen, keine fremden Passwörter ändern. Beispiel-SQL erst nach
erfolgreicher Migration; Hostbereich und Passwortplatzhalter nur lokal ersetzen:

Langes, eigenes Passwort wählen, keine öffentlichen Beispielpasswörter übernehmen.
Bei Fehlern (insbesondere bereits vorhandenem Account) stoppen und nicht blind
mit den nachfolgenden GRANTs fortfahren. SQL-History/Debug-Ausgaben wie beim
geschützten Adminverfahren deaktivieren; keine Authentifizierungsdaten teilen.

```sql
CREATE USER 'evse_storage'@'ERLAUBTER_CLIENTHOST' IDENTIFIED BY 'LOKAL_GEWAHLTES_WRITER_PASSWORT';
GRANT SELECT ON energyControl.evse_schema_versions TO 'evse_storage'@'ERLAUBTER_CLIENTHOST';
GRANT SELECT, INSERT ON energyControl.evse_wallbox_samples TO 'evse_storage'@'ERLAUBTER_CLIENTHOST';
GRANT SELECT, INSERT ON energyControl.evse_ingest_events TO 'evse_storage'@'ERLAUBTER_CLIENTHOST';
```

Für `ERLAUBTER_CLIENTHOST` die geprüfte Herkunft im DB-Docker-Netz wählen;
`%` nicht blind als öffentliche Freigabe übernehmen. Keine zusätzlichen globalen/
Schema-/Rollenrechte, UPDATE, DELETE, DDL oder GRANT OPTION für Runtime. Der
bereitgestellte Account muss über den **Container-Netzwerkweg** funktionieren;
ein erfolgreicher lokaler Socket-Login allein beweist diesen TCP-Zugang nicht.
Keine Root-/Account-/Grant-Ausgaben mit Authentifizierungsdaten weitergeben.

Erst mit dem neuen berechtigt übergebenen Writer-Passwort die eigene Runtime-
Datei anlegen (vorhandene fremde Secretdateien nicht verändern):

```bash
set +x
umask 077
IFS= read -r -s -p 'DB-Writer-Passwort: ' SECRET; printf '\n'
printf '%s\n' "$SECRET" > secrets/db-password.new
unset SECRET
sudo chown 10001:10001 secrets/db-password.new
sudo chmod 0400 secrets/db-password.new
mv -f secrets/db-password.new secrets/db-password.txt
```

</details>

**Nur mit dem ausdrücklich gewählten, geprüften Writer starten**; weder einen
reinen Lesebenutzer noch Root verwenden. Bei Bestandskonto-Nutzung dessen
zusätzliche Rechte als Risiko behalten, nicht als Least Privilege ausgeben.
Danach (ggf. mit eigener MQTT-Passwortdatei und Auth-Overlay wie oben):

```bash
docker compose -f compose.yaml up -d storage
docker compose -f compose.yaml ps
docker compose -f compose.yaml logs --tail 100 storage
```

**Bekannter Pi-Konfigurationsfehler:** `energy_control` ist nicht `energyControl`.
Ein falsches `DB_NAME` führte zu `database unavailable or schema not initialized;
intake paused`. Die Migration war bereits erfolgreich; keine Neumigration oder
neue Datenbank nötig. Nur lokale `.env` korrigieren, ggf. gleichnamige alte Shell-
Exports mit `unset DB_NAME` entfernen und **nur Storage** mit obigem `up -d`
neu erstellen. Kein MariaDB-Neustart und kein Eingriff in Preis-/Backupdaten.
Die wirksamen nicht geheimen Zielwerte lassen sich ohne kompletten Env-Dump prüfen:

```bash
docker compose -f compose.yaml exec -T storage \
  printenv DB_HOST DB_PORT DB_NAME DB_USERNAME
```

Auf dem geprüften Pi meldet Docker fehlende Speicherlimitfähigkeit und verwirft
RAM-Limits. `mem_limit` in Compose bedeutet dort **kein durchgesetztes Limit**.
Keine Kernel-/cgroup-/Bootänderung ohne eigenen Auftrag. `health: starting`
direkt nach Start und fehlende erste Logs sind noch kein Fehler-/Erfolgsnachweis;
SQL-Empfang separat prüfen.

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
  Clock-Anomalien unterscheiden. Dies übernimmt jetzt optional die oben beschriebene
  PHP-Historienabfrage; der aktuelle `/api/state`-Vertrag bleibt unverändert.
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

Bestehendes Backupverfahren bevorzugen. Die oben bestätigte erste Sicherung war
ein schemaweiter Dump **vor** der EVSE-Migration; neue Samples brauchen neue
Sicherungen. Ein kompatibler, im vorhandenen MariaDB-Container enthaltener
`mariadb-dump` kann mit `--no-defaults --protocol=socket -u smart -p`,
`--single-transaction --quick --skip-lock-tables`, `--routines --events --triggers`,
`--hex-blob --no-tablespaces --skip-add-drop-table --skip-add-locks`,
`--default-character-set=utf8mb4 --databases energyControl` sichern. **Mit
`--result-file` in eine neue Datei in einem privaten Container-Tempordner schreiben**,
nicht `docker exec -it ... > dump.sql`: TTY/Passwortprompt dürfen den Dump nicht
verunreinigen. Vorher freien Platz prüfen; `umask 077` und `mktemp -d` verwenden,
Passwort nur verdeckt am nativen Prompt, kein Passwortargument/-Env-Dump.
Nur InnoDB und keine parallelen Schemaänderungen erlauben diesen konsistenten
Datendump ohne explizite Tabellensperren. Bei Fehler stoppen, kein `--force`.

Exitcode und Abschlussmarker `-- Dump completed on` prüfen, SHA256 im Quellordner
erzeugen, SQL/Prüfsumme mit `docker cp` in ein neues privates Verzeichnis außerhalb
Git kopieren und mit `sha256sum -c SHA256SUMS` vergleichen. Eine zweite Kopie auf
anderem Gerät ebenfalls per SHA256 prüfen; Pi-/Containerkopie allein liegen auf
demselben Medium. Dumpinhalte nicht in Chat/Git/öffentliche Logs übernehmen.
Restore nur im isolierten Testcontainer desselben Images, ohne Netzwerk/Ports/
Produktivvolumes, mit eigenem privatem Testpasswort, separatem Datenverzeichnis
(beim bestätigten Test tmpfs) und `event_scheduler=DISABLED`. Root dort ist nur
Testadministrator, kein Produktionszugang. Größen/RAM prüfen; gegebenenfalls
fehlende Kernel-Limitdurchsetzung beachten. Import per `docker exec -i` ohne TTY,
danach Tabellen/Zahlen vergleichen. Nur den verifizierten Testcontainer stoppen,
niemals den Produktionsserver als Restore-Ziel verwenden. Dies prüft Restore/
Datensatzanzahlen, nicht jede fachliche Bedeutung oder zukünftige Restorefähigkeit.

Falls ein eigenes logisches Backup **nur der drei EVSE-Tabellen** nötig ist:
geschützte `secrets/backup.cnf` mit lokalem
Host/User/Passwort für deren leseberechtigten Account anlegen (`[client]`, `host`, `user`, `password`; Client-Options-
Escaping bei Sonderzeichen beachten), UID 10001 lesbar, nicht committen. Schema 1
hat keine Trigger/Views/Routinen; der folgende Dump überspringt Trigger ausdrücklich.
Bei späteren Schemaerweiterungen Backupoptionen anpassen, nicht unbemerkt ausschließen.

```bash
umask 077
mkdir -p backups
docker run --rm --network evse-data --user 10001:10001 \
  --mount type=bind,src="$PWD/secrets/backup.cnf",dst=/run/secrets/client.cnf,readonly \
  mariadb:11.8.8 mariadb-dump --defaults-extra-file=/run/secrets/client.cnf \
  --single-transaction --skip-lock-tables --skip-triggers --no-tablespaces \
  --skip-add-drop-table --skip-add-locks \
  energyControl evse_schema_versions evse_wallbox_samples evse_ingest_events \
  > "backups/evse-$(date -u +%Y%m%dT%H%M%SZ).sql"
```

Dies ist **kein Vollbackup von `energyControl` oder des DB-Servers**: Preis-/
Providertabellen, Accounts/Grants und sonstige Betreiberobjekte sind nicht enthalten.
Das erforderliche Betreiberbackup **vor** der Initialmigration ist davon getrennt;
dieser EVSE-Dump ist erst nach erfolgreicher Tabellenanlage möglich. Keine fremden
Tabellen durch eine ungeprüfte Vollschema-Dump-/Restore-Anleitung gefährden.
Netz/Schema/Clientversion an bestätigte Einrichtung anpassen. Exitcode/Dumpgröße
prüfen, Backup außerhalb dieses Pi geschützt kopieren und Restore nur in isolierter
Testdatenbank prüfen. Nie blind einen Dump auf vorhandene Produktivschemas anwenden.

Im lokalen DB-Client mit SELECT-Rechten unabhängig prüfen:

```sql
USE energyControl;
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
gehärteter Runtime-Smoke. Keine Produktionsverbindung durch CI. Pi-Migration/
SQL-Empfang wurden inzwischen separat durch den Projektinhaber wie oben bestätigt;
Langzeit-/Fehlerfallprüfung, Rechtehärtung und regelmäßige Backups bleiben offen.
