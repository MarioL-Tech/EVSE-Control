# Lesender ABB-Terra-AC-Dienst

C++17-Dienst mit libmodbus, der **auf dem Raspberry Pi** läuft. Er liest
Holding Registers über Modbus RTU (FC03), dekodiert sie und gibt pro Abfrage
eine JSON-Zeile auf stdout aus. Diagnosen gehen auf stderr.

**Keine Schreibbefehle, keine Ladefreigabe, kein MQTT, keine Datenbank und
keine Weboberfläche in diesem Entwicklungsschritt.** Das bestehende
`rasppi/src/main.py` bleibt die separate ESP32-UART-Brücke.

## Auf den Pi übertragen

Zugriff erfolgt über die bestehende WireGuard-Verbindung und SSH. Der Pi
greift selbst lokal auf die Wallbox zu, nicht über WireGuard. Quellcode über
Git (nach Commit/Push) oder SCP übertragen. Auf dem Pi bauen: Windows-Binaries
sind nicht auf dem Pi ausführbar. Keine SSH-/WireGuard-Konfiguration ändern.

## Nativ auf dem Pi bauen und prüfen

Für Raspberry Pi OS / Debian:

```bash
sudo apt update
sudo apt install g++ cmake make pkg-config libmodbus-dev python3

# Aus dem Repository-Hauptverzeichnis:
cmake -S rasppi/wallbox -B rasppi/wallbox/build -DCMAKE_BUILD_TYPE=Release
cmake --build rasppi/wallbox/build --parallel 2
ctest --test-dir rasppi/wallbox/build --output-on-failure
rasppi/wallbox/build/evse-wallbox --help
```

Die Decoder-/JSON-Tests brauchen keine Hardware. Unter Linux testet ein
zusätzlicher Python-Standardbibliothek-Test eine simulierte RTU-Gegenstelle
über PTY: FC03-Anfrage, Messwerte, Timeout, Wiederanlauf, CLI und SIGTERM.
Zusätzlich werden unvollständige Antworten, Shutdown während einer laufenden
Abfrage, volle stdout-Pipes und Wiederherstellung der Port-Einstellungen geprüft.
Diese Tests ersetzen **keinen Test an der echten Wallbox**.

Nur Decoder-/JSON-Tests bauen, ohne libmodbus:

```bash
cmake -S rasppi/wallbox -B rasppi/wallbox/build -DBUILD_WALLBOX_SERVICE=OFF
cmake --build rasppi/wallbox/build --parallel 2
ctest --test-dir rasppi/wallbox/build --output-on-failure
```

Zum späteren Dienst-Build dieselbe Option wieder auf `ON` setzen.

## Erster Hardwaretest: einmal lesen

Vorher alle anderen Prozesse mit Zugriff auf denselben RS485-Port stoppen,
insbesondere `mbpoll` und einen eventuell laufenden Reader-Container.
**Genau ein Dienst besitzt den Port.** Vorhandene Modbus-Master ebenfalls prüfen.

```bash
ls -l /dev/ttyUSBEVSEcontrol
rasppi/wallbox/build/evse-wallbox --once
```

Falls nötig die tatsächlichen Parameter angeben:

```bash
rasppi/wallbox/build/evse-wallbox \
  --device /dev/ttyUSBEVSEcontrol --baud 57600 --parity E --slave 9 \
  --interval-ms 2000 --timeout-ms 1000
```

8 Datenbits und 1 Stoppbit sind festgelegt. Parität ist `E`, `O` oder `N`.
Der Benutzer benötigt Zugriff auf den seriellen Port (auf Raspberry Pi OS
häufig Gruppe `dialout`; nach Gruppenänderung neu anmelden). Nicht pauschal
Dateirechte auf `777` setzen. Prüfen, ob der dokumentierte udev-Symlink existiert.

`Ctrl+C`/SIGTERM beenden den Dienst und schließen den Port. `--once` liefert
Exitcode 0 bei erfolgreichem Lesen, 1 bei Kommunikationsfehler, 2 bei ungültiger
Konfiguration oder fatalem Laufzeit-/Ausgabefehler. Ein erfolgreicher Read kann trotzdem einen Wallbox-Fehlercode
oder einen unbekannten Ladezustand enthalten.

Ohne `--once` wird bei Fehlern der Port geschlossen und im nächsten Zyklus
erneut geöffnet. Die vollständige Antwort hat einen Timeout; keine alten
Messwerte werden als aktuell ausgegeben. Bei fortlaufenden Fehlern kann trotz
der Abfrageversuche der Wallbox-Kommunikationstimeout ablaufen.

Die JSON-Ausgabe muss laufend abgenommen werden. Bei voller stdout-Pipe wartet
der Dienst unterbrechbar höchstens eine Sekunde und beendet sich dann mit
Exitcode 2, statt das Polling unbegrenzt anzuhalten. Eine geschlossene Pipe
wird ebenfalls als Ausgabefehler behandelt. Auch stderr-Diagnosen müssen
abgenommen werden. Die native Dienst-Ausgabe verwendet Linux/POSIX-APIs.

## Dauerbetrieb mit Docker Compose

Docker Engine und das Compose-Plugin müssen auf dem Pi bereits verfügbar sein.
Build und Start **auf dem Pi** erzeugen ein zur Pi-Architektur passendes Image.

```bash
cd rasppi/wallbox
# Bei abweichendem Host-Gerätepfad VOR Test und Dauerbetrieb setzen:
# export WALLBOX_DEVICE=/dev/ttyUSB0
docker compose build
# Zunächst einmal testen, keine zweite Instanz parallel betreiben:
docker compose run --rm --no-deps wallbox-reader --device /dev/ttyWallbox --once

docker compose up -d
docker compose logs --tail 20 -f wallbox-reader
# Beenden:
docker compose down
```

Der Einmal-Test verwendet die Standard-Baudrate/Parität/ID. Bei abweichender
Gerätekonfiguration diese Optionen auch im `compose run`-Befehl angeben.

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
ist eine vorläufige JSON-Schnittstelle, noch kein beschlossener MQTT-Vertrag.

## Vor realer Nutzung verifizieren

- Herstellerquelle: `docs/wallbox/ABB_Terra_AC_Charger_ModbusCommunication_v1.7.pdf`.
  Die neue `modbusRegisters.txt` verweist auf v1.11, enthält aber widersprüchliche
  Steuerwerte. Zusätzliche v1.11-Register werden hier noch nicht abgefragt.
- Laut v1.7 FC03/Holding Registers; vorhandene `mbpoll`-Beispiele lesen teilweise
  FC04/Input Registers (`-t 3`). Dieser Dienst verwendet **nur FC03** und wechselt
  nicht stillschweigend auf FC04. Unterstützung an der echten Firmware prüfen.
- Registerbreiten, Wortreihenfolge, Skalierung und Zustände anhand echter
  Rohwerte bestätigen. Falls der Block abgelehnt wird, mit einzelnen lesenden
  `mbpoll -t 4`-Abfragen diagnostizieren, nicht parallel zum Dienst.
- Zwei Sekunden sind der Ausgangswert; der reale Wallbox-Timeout muss länger
  als das Intervall sein. Die bisher dokumentierten bis zu 90 Sekunden passen
  nicht zu einem Standardtimeout von 60 Sekunden.
- **Keine Schreibbefehle aus den widersprüchlichen Notizen ausprobieren.**
  Erst danach folgen MQTT, Ladesteuerung und weitere Integrationen.
