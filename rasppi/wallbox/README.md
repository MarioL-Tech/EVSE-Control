# Lesender ABB-Terra-AC-Dienst

C++17-Dienst mit libmodbus, der **im Docker-Container auf dem Raspberry Pi** läuft. Er liest
Holding Registers über Modbus RTU (FC03), dekodiert sie und gibt pro Abfrage
eine JSON-Zeile auf stdout aus. Zusätzlich veröffentlicht libmosquitto denselben
Snapshot und die Verfügbarkeit auf MQTT. Diagnosen gehen auf stderr.

**Keine Schreibbefehle, keine Ladefreigabe, keine Datenbank und
keine Weboberfläche in diesem Entwicklungsschritt.** Das bestehende
`rasppi/src/main.py` bleibt die separate ESP32-UART-Brücke.

## Start auf dem Pi

Docker/Compose, Repository und Wallbox-Verbindung müssen vorhanden sein.
Netzwerk `evse-mqtt` und vorhandenen Broker-Alias `mqtt-broker` zuerst gemäß
[Installationsguide](../../docs/installation.md#5-vorhandenen-mqtt-broker-wiederverwenden) vorbereiten.
**Keine Host-Pakete installieren; andere Prozesse am RS485-Port vorher stoppen.**

```bash
cd rasppi/wallbox
docker compose build
docker compose stop wallbox-reader
docker compose run --rm --no-deps -T --interactive=false wallbox-reader --once && docker compose up -d
docker compose logs --tail 20 -f wallbox-reader
```

Standard: `/dev/ttyUSBEVSEcontrol`, 57600 Baud, 8E1, ID 9.
Anderer Gerätepfad: vorher `export WALLBOX_DEVICE=/dev/ttyUSB0` setzen.
`Ctrl+C` beendet nur die Logansicht; `docker compose down` stoppt den Dienst.
Alle Einrichtungsschritte, einschließlich MQTT-Empfangstest:
[Installationsguide](../../docs/installation.md).

## MQTT

- `evse/wallbox/state`: JSON-Sample.
- `evse/wallbox/availability`: `online`/`offline` inklusive Last Will.
- Beide retained, QoS 1; `online` bedeutet einen frischen Read, nicht fehlerfreie Wallbox.
- Brokerausfälle stoppen keine Modbus-Abfragen; keine unbegrenzte Nachrichtenhistorie.
- `MQTT_ENABLED=false` deaktiviert den Publisher. Das externe Compose-Netzwerk
  muss trotzdem existieren. Direkter Programmstart ohne Umgebungsoption aktiviert MQTT nicht.

Konfiguration: `.env.example` nach lokaler `.env` kopieren; `MQTT_HOST`,
`MQTT_PORT`, `MQTT_TOPIC_PREFIX`, `MQTT_CLIENT_ID`, optional `MQTT_USERNAME`.
Passwort bevorzugt mit `compose.auth.yaml` aus externer Datei einbinden.
Kein Passwort committen oder per CLI weitergeben.
[Vertrag und Frische](../../docs/mqtt-protocol.md),
[Auth-/Updateanleitung](../../docs/installation.md#mqtt-konfiguration-und-optionale-authentifizierung).

<details>
<summary>Konfiguration, Tests und Betriebshinweise</summary>

## Auf den Pi übertragen

Zugriff erfolgt über die bestehende WireGuard-Verbindung und SSH. Der Pi
greift selbst lokal auf die Wallbox zu, nicht über WireGuard. Quellcode über
Git (nach Commit/Push) oder SCP übertragen. Das Image wird auf dem Pi gebaut,
damit es zur Pi-Architektur passt. Keine SSH-/WireGuard-Konfiguration ändern.

## Verbindlich: nur Docker

**Build, Tests und Betrieb erfolgen ausschließlich in Docker.** Auf dem Pi
keine Projektpakete installieren: kein Compiler, CMake, libmodbus, Python,
pyserial oder mbpoll per Host-`apt`/`pip`. Voraussetzung sind eine bestehende
Docker Engine samt Compose-Plugin, Zugriff darauf und der serielle Gerätepfad.
Die Installationen im Dockerfile betreffen ausschließlich das Container-Image.

## Image bauen und ohne Hardware prüfen

```bash
cd rasppi/wallbox
docker compose build
```

Der Multi-Stage-Build installiert Compiler und Testwerkzeuge nur in der
Build-Stufe und führt die Tests automatisch aus; Fehler brechen den Image-Build
ab. Das Laufzeit-Image enthält Reader, libmodbus und libmosquitto, keine Buildtools.
Für den Build ist kein serielles Gerät erforderlich.

Die Decoder-/JSON-Tests brauchen keine Hardware. Im Build-Container testet ein
zusätzlicher Python-Standardbibliothek-Test eine simulierte RTU-Gegenstelle
über PTY: FC03-Anfrage, Messwerte, Timeout, Wiederanlauf, CLI und SIGTERM.
Zusätzlich werden unvollständige Antworten, Shutdown während einer laufenden
Abfrage, volle stdout-Pipes und Wiederherstellung der Port-Einstellungen geprüft.
Diese Tests ersetzen **keinen Test an der echten Wallbox**.
Ein weiterer Test startet ausschließlich im Build-Container einen isolierten
Loopback-Broker und PTY-Reader: retained State, Online/Offline bei Readfehlern,
Brokerneustart, fortlaufendes Polling ohne Broker, Shutdown und Last Will.
Zusätzlich Passwortdatei/abgelehnte Test-Zugangsdaten und begrenzte Publish-
Warteschlange bei fehlenden ACKs.
Er benutzt keine Produktionsdaten und kontaktiert nicht euren Pi-Broker.

Zum expliziten Wiederholen der Tests kann die Build-Stufe als Test-Image
gebaut werden (weiterhin ohne Host-Installationen oder Hardware):

```bash
docker build --target build -t evse-wallbox-tests .
docker run --rm evse-wallbox-tests ctest --test-dir /src/build --output-on-failure
```

Die CMake-Option `BUILD_WALLBOX_SERVICE=OFF` bleibt für Decoder-only-Builds
innerhalb einer Build-Umgebung verfügbar; sie ist keine Anleitung für einen
nativen Host-Build auf dem Pi.

## Erster Hardwaretest: einmal lesen

Vorher alle anderen Prozesse mit Zugriff auf denselben RS485-Port stoppen,
insbesondere `mbpoll` und einen eventuell laufenden Reader-Container.
**Genau ein Dienst besitzt den Port.** Vorhandene Modbus-Master ebenfalls prüfen.

```bash
# Weiterhin im Verzeichnis rasppi/wallbox:
# Falls nötig VOR Test und Dauerbetrieb den Host-Gerätepfad setzen:
# export WALLBOX_DEVICE=/dev/ttyUSB0
docker compose stop wallbox-reader
docker compose run --rm --no-deps -T --interactive=false wallbox-reader --once
```

Bei abweichenden Kommunikationsparametern diese vor beiden Starts setzen:

```bash
export WALLBOX_BAUD=57600
export WALLBOX_PARITY=E
export WALLBOX_SLAVE=9
export WALLBOX_INTERVAL_MS=2000
export WALLBOX_TIMEOUT_MS=1000
docker compose run --rm --no-deps -T --interactive=false wallbox-reader --once
```

`WALLBOX_DEVICE` ist der Host-Gerätepfad, innerhalb des Containers heißt er
immer `/dev/ttyWallbox`. Der Entrypoint verwendet dieselben Einstellungen für
Einmal-Test und Dauerbetrieb. Zusätzliche CLI-Optionen können sie für einen
einzelnen Aufruf überschreiben, z. B. `docker compose run --rm --no-deps -T --interactive=false
wallbox-reader --slave 9 --once`.

Einmaltests benötigen keine interaktive Eingabe. `-T --interactive=false`
verhindert, dass beim Einfügen mehrerer Befehle die Folgezeilen im Container
landen. Für einen Exitcode den Test und `printf 'Exitcode: %s\n' "$?"` mit
Semikolon auf **derselben Shellzeile** ausführen.

8 Datenbits und 1 Stoppbit sind festgelegt. Parität ist `E`, `O` oder `N`.
Bei Geräte-/Berechtigungsfehlern die Gerätezuordnung und Docker-Zugriffsrechte
prüfen; keine Pakete nachinstallieren oder Dateirechte pauschal auf `777` setzen.

`Ctrl+C`/SIGTERM beenden den Dienst und schließen den Port. `--once` liefert
Exitcode 0 bei erfolgreichem Lesen, 1 bei Kommunikationsfehler, 2 bei ungültiger
Konfiguration oder fatalem Laufzeit-/Ausgabefehler. Ein erfolgreicher Read kann trotzdem einen Wallbox-Fehlercode
oder einen unbekannten Ladezustand enthalten. MQTT-ACKs werden im Einmalmodus
kurz abgewartet; der Exitcode bestätigt dennoch nur Modbus, nicht MQTT-Empfang.

Ohne `--once` wird bei Fehlern der Port geschlossen und im nächsten Zyklus
erneut geöffnet. Die vollständige Antwort hat einen Timeout; keine alten
Messwerte werden als aktuell ausgegeben. Bei fortlaufenden Fehlern kann trotz
der Abfrageversuche der Wallbox-Kommunikationstimeout ablaufen.

Die JSON-Ausgabe muss laufend abgenommen werden. Bei voller stdout-Pipe wartet
der Dienst unterbrechbar höchstens eine Sekunde und beendet sich dann mit
Exitcode 2, statt das Polling unbegrenzt anzuhalten. Eine geschlossene Pipe
wird ebenfalls als Ausgabefehler behandelt. Auch stderr-Diagnosen müssen
abgenommen werden. Bei aktivem MQTT ist stderr nichtblockierend; bei voller
Pipe können Diagnosen entfallen. Der Dienst verwendet Linux/POSIX-APIs im Container.

## Dauerbetrieb mit Docker Compose

Nach erfolgreichem Einmal-Test:

```bash
docker compose up -d
docker compose logs --tail 20 -f wallbox-reader
# Beenden:
docker compose down
```

Bei anderem Host-Gerätepfad `WALLBOX_DEVICE` wie oben vor beiden Starts exportieren.
Weitere Variablen: `WALLBOX_BAUD`, `WALLBOX_PARITY`, `WALLBOX_SLAVE`,
`WALLBOX_INTERVAL_MS`, `WALLBOX_TIMEOUT_MS`. Bei Änderungen den Container neu
erstellen. Der Container bekommt nur das angegebene serielle Gerät, keine
privilegierte Ausführung und keine veröffentlichten Netzwerkports. Er läuft
derzeit mit dem Standardbenutzer root im Container. Das ist keine OS-seitige
Lesesperre: die Anwendung ist lesend, das serielle Protokoll muss Anfragen senden.

Bei USB-Abziehen/Neuanschließen kann ein Container-Neustart bzw. Neuerstellen
nötig werden, damit Docker das Gerät erneut zuordnet. Keine garantierte
USB-Hotplug-Recovery für die Container-Gerätezuordnung behaupten.

</details>

## Register und Interpretation

Ein FC03-Read ab `0x4008` liest 24 **16-Bit-Register** bis einschließlich
`0x401F`. Jeder der folgenden Werte belegt zwei Register, High Word zuerst:

| Adresse | JSON-Feld | Interpretation |
|---|---|---|
| `0x4008` | `error_code` | Hersteller-Fehlercode, 0 = kein Fehler |
| `0x400A` | `socket_lock_state` | roher Wallbox-Verriegelungsstatus, nicht ESP32-Servo |
| `0x400C` | `charging_state_raw`, `charging_state` | Byte 1 Bits 0–6; Bit 7 separat |
| `0x400E` | `current_limit_a` | tatsächlich von der Wallbox gewähltes Limit, mA / 1000 |
| `0x4010/12/14` | `current_a` | L1/L2/L3, mA / 1000 |
| `0x4016/18/1A` | `voltage_v` | L1/L2/L3, Rohwert / 10; L-N/L-L je Wallbox-Konfiguration |
| `0x401C` | `active_power_w` | W |
| `0x401E` | `session_energy_wh` | Wh der aktuellen Session |

`raw = (high_word << 16) | low_word`, `state = (raw >> 8) & 0x7F`.
`below_commanded_current` liest Bit 7 von Byte 1.

- 0: Idle → `plugged_in=false`, `charging=false`.
- 1/2/3: B1/B2/C1 → `plugged_in=true`, `charging=false`.
- 4: C2 / Kontakt geschlossen, Energieabgabe → beide `true`.
- 5 („Others“) oder unbekannte Codes → beide `null`, keine falsche Aussage.

Diese Werte sind **keine Ladefreigabe**. `current_limit_a` ist auch nicht der
im Gebäude verfügbare Strom; dafür fehlen noch DTSU666-Auswertung und Regelung.

### Ausgabe und Fehler

```json
{"schema_version":1,"device":"abb_terra_ac","timestamp":"2026-10-03T16:00:00Z","status":"error","last_success_at":null,"values":null,"error":"read: Connection timed out"}
```

UTC-Zeitstempel; `status` beschreibt die Kommunikation, nicht den Fehlerzustand
der Wallbox. Bei erfolgreichem Read enthält `values` die oben beschriebenen
Felder, `error` ist `null`, `last_success_at` entspricht dem Messzeitstempel.
Bei Fehler ist `values=null`; `last_success_at` bleibt auf dem letzten Erfolg
oder `null`, wenn noch kein erfolgreicher Read stattgefunden hat. Die Ausgabe
entspricht dem [MQTT-State-Vertrag](../../docs/mqtt-protocol.md).

## Vor realer Nutzung verifizieren

- Bestätigter Einmaltest laut Projektinhaber (2026-10-03): Docker-Reader liest den
  gesamten Block per FC03 erfolgreich, `status=ok`, Fehlercode 0. Zustand B1,
  16-A-Limit und Phasenspannungen wurden ausgegeben. Das ist noch keine
  Dauerbetriebs-/Fehlerfallprüfung oder unabhängige Messwertvalidierung.
- Herstellerquelle: `docs/wallbox/ABB_Terra_AC_Charger_ModbusCommunication_v1.7.pdf`.
  Die neue `modbusRegisters.txt` verweist auf v1.11, enthält aber widersprüchliche
  Steuerwerte. Zusätzliche v1.11-Register werden hier noch nicht abgefragt.
- Laut v1.7 FC03/Holding Registers; vorhandene `mbpoll`-Beispiele lesen teilweise
  FC04/Input Registers (`-t 3`). Dieser Dienst verwendet **nur FC03** und wechselt
  nicht stillschweigend auf FC04. Unterstützung an der echten Firmware prüfen.
- Registerbreiten, Wortreihenfolge, Skalierung und Zustände anhand echter
  Rohwerte bestätigen. Falls der Block abgelehnt wird, mit einzelnen lesenden
  `mbpoll -t 4`-Abfragen in einem vorhandenen Diagnosecontainer diagnostizieren,
  nicht auf dem Host installieren und nicht parallel zum Dienst ausführen.
- Zwei Sekunden sind der Ausgangswert; der reale Wallbox-Timeout muss länger
  als das Intervall sein. Die bisher dokumentierten bis zu 90 Sekunden passen
  nicht zu einem Standardtimeout von 60 Sekunden.
- **Keine Schreibbefehle aus den widersprüchlichen Notizen ausprobieren.**
  Ladesteuerung und weitere Integrationen folgen separat; MQTT bleibt rein lesende Telemetrie.
