# Wallbox-Schreibkern – Stufe 1, ausschließlich Simulation

Stand: 2026-10-30. Beauftragt sind ein C++17-/libmodbus-Schreibkern und isolierte
Docker-Tests, **keine echten Wallbox-Schreibtests oder Pi-Aktivierung**. Vor einem
späteren Schreibtest muss der Projektinhaber seine Leitung informieren und den
konkreten Hardwaretest gesondert freigeben. Simulation ist keine Hardwaregarantie.

## Produktionsgrenze

`rasppi/wallbox/src/write_core.hpp/.cpp` ist eine interne, synchrone Schnittstelle.
Der bisherige Reader bleibt alleiniger Besitzer seines libmodbus-Kontexts und
RS485-Ports; Polls und mögliche spätere Befehle gehören auf denselben Thread.
Der Core öffnet, schließt oder reconnectet keinen Port und besitzt keine Queue.
Aufrufe von anderen Threads werden vor Buszugriff verweigert.

Im Runtimeprogramm ist ausschließlich `WritePolicy{}` (deaktiviert, ohne
Installationslimit) verdrahtet. **Es gibt keine Auftragsquelle und keinen CLI-,
Env-, Compose-, stdin-, HTTP- oder MQTT-Aktivierungsweg.** Auch ein aktualisiertes
Readerimage bleibt FC03-only. MQTT-/JSON-/Live-Verträge bleiben unverändert.
Nur das separate Build-Testprogramm `wallbox-write-probe` bekommt aktivierte
Testpolicies. Es akzeptiert nur geprüfte Linux-PTYs und wird weder installiert
noch in das Runtimeimage kopiert. Kein neues Produktionsprogramm zum Schreiben.

## Register und Telegramme

Primärquelle: [ABB Terra AC Modbus Communication v1.7](ABB_Terra_AC_Charger_ModbusCommunication_v1.7.pdf),
Seiten 6 und 9–11. Registeradressen werden ohne zusätzliche 40001-Verschiebung
verwendet; Slave-ID 9 gehört der Wallbox, nicht dem Pi als Master.

| Typisierter Auftrag | Fester Schreibzugriff |
| --- | --- |
| `SetCurrent` | FC16 (`0x10`), `0x4100`, genau zwei Register, UInt32 in mA, MSW zuerst |
| `Start` | FC06, `0x4105`, ein Register, **0** |
| `Stop` | FC06, `0x4105`, ein Register, **1** |

6/10/16 A entsprechen 6000/10000/16000 mA und den Wortpaaren
`0000 1770` / `0000 2710` / `0000 3E80`. Ein Register ist ein 16-Bit-Wort,
nicht ein Byte. Keine frei wählbaren Register/Funktionscodes/Rohtelegramme in der
Core-Auftragsschnittstelle. Socket-Lock, Fallback-Limit und Kommunikationstimeout
werden in dieser Stufe **nicht geschrieben**. Historische `mbpoll`-Notizen sind
keine freigegebene Testanleitung; insbesondere sind Start/Stop dort widersprüchlich.

Die High-level-Schreibfunktionen von libmodbus 3.1.6 prüfen nicht das vollständige
ACK-Echo: bei FC06 fehlen Adress-/Wertvergleich, bei FC16 der Adressvergleich.
Darum verwendet dieser Core bewusst die öffentlichen libmodbus-Funktionen
[`modbus_send_raw_request`](https://libmodbus.org/reference/modbus_send_raw_request/)
und [`modbus_receive_confirmation`](https://libmodbus.org/reference/modbus_receive_confirmation/):
Framing, CRC und Empfang bleiben in libmodbus. Zusätzlich werden Länge, Slave,
Funktion, Adresse und Wert bzw. Registeranzahl der Antwort exakt geprüft.
Kein eigener serieller Treiber und keine neue Modbus-Bibliothek.

## Freigaben, Stromgrenzen und Startvorbereitung

Vor jedem Core-I/O werden deaktivierte Policy, Thread, Auftragstyp, explizites
Installationsmaximum, Stromwert, monotone Deadline, Shutdown und verbundener
Unicast-RTU-Kontext geprüft. Die Deadline darf höchstens zehn Sekunden nach
Auftragsannahme liegen; Standardaufträge sind abgelaufen. Keine UTC-/Wanduhr-TTL.

- Zulässige Vorgabe mindestens **6000 mA**. Stop ist ein eigener Auftrag mit
  `current_ma=0`, kein versteckter Unter-6-A-Pausenbefehl.
- Das **explizite** Installationsmaximum ist erforderlich; es gibt weder einen
  angenommenen 16-A- noch 32-A-Installationsdefault. Als zusätzliche konservative
  Softwareobergrenze akzeptiert Stufe 1 höchstens 32000 mA. Das ist **keine**
  Aussage über die tatsächlich zulässige Stromstärke einer Installation.
- Vor `SetCurrent` und `Start` wird `0x4006/07` per FC03 neu gelesen. Fehlende,
  fehlerhafte, unter 6 A oder über der Softwaregrenze liegende Angaben sperren
  den Auftrag. Die Vorgabe muss auch innerhalb dieses Hardwaremaximums liegen.
- `SetCurrent` schreibt genau einmal. Nur ein gültiges ACK mit anschließendem
  lesbarem wirksamem Limit `0x400E/0F <= Vorgabe` bereitet einen Start vor.
  Ein niedrigeres wirksames Limit, auch 0, kann internes Lastmanagement sein:
  **kein Setpoint-Echo und kein Nachweis, dass tatsächlich Strom fließt**.
- `Start` benötigt dieselbe frische Vorgabe im selben Core/Bussitzung, vor Ablauf
  der ursprünglichen SetCurrent-Deadline. Es prüft Hardwaremaximum und den
  bestehenden FC03-Telemetrieblock erneut: Fehlercode muss 0, Ladezustand bekannt
  (0–4) und wirksames Limit höchstens die vorbereitete Vorgabe sein.
  Ein Startversuch verbraucht die Vorbereitung, auch bei späterer Ablehnung.
  Kein implizites SetCurrent, kein automatischer Start und kein Wiederanlauf.
- `Stop` hebt die Startvorbereitung auf, schreibt einmal und braucht keine
  erfolgreiche Hardwarelimit-/Fehlerstatus-Vorabfrage. Die grundsätzliche
  Schreibpolicy samt Installationslimit und lebender Verbindung bleibt nötig.
- Jeder neue SetCurrent-Versuch verwirft eine ältere Vorbereitung. Ein Busfehler
  oder explizites `invalidate_session()` sperrt den Core bis zum bewussten
  Neuaufbau der Sitzung/des Cores; kein stilles Entsperren beim nächsten Poll.

Das Handbuch beschreibt Pause unter 6 A und Wiederaufnahme „über 6 A“.
Wiederaufnahme bei exakt 6 A bleibt eine Frage für die spätere Hardwareabnahme.
Eine Vorgabe ist eine **Obergrenze**, keine Anforderung eines garantierten Stroms.

## Ergebnis, Beobachtung und unklarer Ausgang

`WriteResult` trennt Status, festen Fehlergrund, `attempted`, `acknowledged` und
optionale Beobachtungen. `attempted=true` bedeutet Eintritt in den Sendepfad;
auch bei Sendefehler kann eine Wirkung nicht pauschal ausgeschlossen werden.
Ein ACK bestätigt nur das Protokoll, **nicht aktives Laden oder erfolgreiche
physische Abschaltung**. Nach bestätigtem Start/Stop wird `0x400C/0D` gelesen:
Zustand 4 bedeutet beobachtetes Laden; 0–3 beobachtet nicht ladend; andere Werte
bleiben unbekannt. Ein noch ladender Zustand nach Stop bleibt sichtbar und wird
nicht in eine erfundene Abschaltbestätigung umgedeutet.

Nach einem gültigen ACK ändern fehlendes Readback, Shutdown oder Deadline den
Auftrag nicht nachträglich zu „nicht gesendet“. Startvorbereitung entfällt, wenn
die Limitbeobachtung fehlt, zu hoch oder nach Deadline/Shutdown nicht mehr nutzbar
ist. Bei Start ist das zurückgegebene wirksame Limit eine **Vorabbeobachtung**,
der Ladezustand nach ACK eine anschließende Beobachtung; keine Dauerzustandszusage.

**Genau ein Send-Aufruf pro Auftrag, keine automatische Wiederholung:**
libmodbus-Error-Recovery steht ausdrücklich auf `NONE`. Timeout, Teilantwort,
CRC-/Slave-/Funktions-/Echoabweichung führen zu `outcome_unknown` und gesperrtem
Core. Keine automatische Kompensation, kein unmittelbares unsicheres Readback und
kein Reconnect im Core. Der Besitzer muss danach Verbindung/Sitzung bewusst
erneuern, frischen Istzustand lesen und einen etwaigen **neuen** Auftrag gesondert
entscheiden; alte Aufträge werden niemals aufgehoben/nachgeholt. Ein später
passender Istwert kann bereits vorher bestanden haben und beweist keinen Erfolg
des unbestätigten Auftrags.

Gültige Modbus-Ausnahmen 1/2/3 werden als Geräteablehnung klassifiziert.
Andere Ausnahmen bleiben bezüglich Wirkung unklar; insbesondere bedeutet Code 5
„angenommen/in Bearbeitung“, **nicht abgelehnt**. Alle sperren die Sitzung.

Vor jedem I/O wird Deadline/Abbruch erneut geprüft, das Response-Timeout auf das
verbleibende Budget begrenzt und Byte-Timeout deaktiviert. Vor Empfang wird bereits
verbrauchte Sendezeit berücksichtigt. Ursprüngliche Response-/Byte-Timeouts werden
anschließend wiederhergestellt; Error-Recovery bleibt aus. Ein bereits laufender
synchroner libmodbus-/OS-Aufruf kann durch das Abbruchflag nicht rückgängig gemacht
werden. Keine harte Gesamtfrist für sämtliche OS-/Treiberblockaden versprochen.

## Reproduzierbare Tests – ohne Wallbox und Produktionsbroker

Vom Repository-Hauptverzeichnis, ausschließlich Docker:

```bash
docker build --target build -t evse-wallbox-tests rasppi/wallbox
docker run --rm --network none evse-wallbox-tests ctest --test-dir /src/build --output-on-failure
```

Keine `--device`-Freigabe, Produktionsnetzwerke, Pi-Adressen oder Secrets nötig.
Die bestehenden Decoder-, FC03-PTY- und lokalen MQTT-Tests bleiben erhalten und
fordern weiterhin **ausschließlich FC03** für den ausgelieferten Reader. Neu sind
Release-aktive No-I/O-Validierungstests und eine eigene PTY-Schreibsimulation mit
vollständigem Framevergleich, Grenz-/Readback-/Fehler-/Shutdownfällen und Zählern
gegen Wiederholungen. Der Testprobe verweigert reale serielle Gerätepfade.

CI baut/testet Bookworm und Trixie; Bookworm bleibt unveränderter Produktionsdefault.
Die tatsächlichen libmodbus-/libmosquitto-Paketversionen stehen im Buildlog.
Der erste vollständige Codeabgleich besteht beide Distributionen mit allen fünf
Suiten und Runtime-Sperrprüfung. Konkreter Code-/Run-/Freigabestand zentral in
[PR #64](https://github.com/MarioL-Tech/EVSE-Control/pull/64). Kein ARM-, Firmware-,
Dauerbetriebs- oder Hardwarefreigabenachweis durch diese Tests.

## Spätere Hardwareabnahme – noch nicht freigegeben

Vorher Leitung informieren, Termin und verantwortliche Person abstimmen. Modell,
Firmware, erlaubten externen Steuerzugriff und tatsächliches Installationsmaximum
prüfen; einen sicheren Lade-/Fahrzeugzustand und erreichbaren Ansprechpartner
organisieren. Niemals einen zweiten Master neben dem Reader starten.

Ein gesonderter Folgeauftrag muss erst einen ausdrücklich gesperrten/geschützten
Testzugang, Abbruchkriterien und ein konkretes Protokoll bereitstellen. Darin
angeforderte Werte, gültige Protokollantworten, wirkliche Readbacks und beobachtetes
Laden getrennt dokumentieren. Keine testweise Erhöhung über geprüfte Grenzen,
kein automatisches Wiederholen nach Timeout und keine Automationsfreigabe aus
einem einzelnen erfolgreichen Test. Dieses Dokument enthält bewusst **keine
ausführbaren Hardware-Schreibbefehle**.

MQTT-Bedienvertrag, Zugriffsschutz, Slider mit „Übernehmen“ und Solar-/Netzbezugs-
regeln folgen separat. Anonymer LAN-Settingseditor ist keine Freigabe anonymer
Ladebefehle; gewünschte Abschaltschwellen/Zeiten werden nicht geraten.
