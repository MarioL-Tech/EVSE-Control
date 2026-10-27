# Lesende Wallbox-Historie der Website

Die SQL-Historie ergänzt ausschließlich die vorhandene Diagrammseite. Sie ist
kein Live-Snapshot, keine Steuerung und keine Preis-/Hauszähler-API. `/api/state`
und seine MQTT-/Frischelogik bleiben unabhängig. Einrichtung ausschließlich im
[Installationsguide](installation.md#sql-verlauf-optional-einrichten).

## Anfrage und Grenzen

`GET` und `HEAD /api/history`, optional exakt `?minutes=1`, `5` oder `15`;
Default 15. Keine weiteren, wiederholten, Array- oder kodierten Parameter,
freien Zeitbereiche, Quellen, Tabellen oder Limits. Ungültige Query: HTTP 400;
andere Methoden: 405. `Cache-Control: no-store`, bestehende CSP/HTTP-Sicherheitsheader.

PHP verwendet PDO/mysqlnd, eine eigene Backend-Passwortdatei und ausschließlich
explizite SELECT-Projektionen in einer konsistenten Read-only-Transaktion.
Schema-Version muss genau 1 sein. Exakte binäre Herkunft ist der konfigurierte
`MQTT_TOPIC_PREFIX` selbst, ohne `/state`-Suffix. Keine Abfrage der Preistabellen,
keine Rohpayloads, Fehlertexte, Hashes, Zugangsdaten oder SQL-Diagnosen im HTTP.

Maximal 1.200 Samples, 2.400 Ereignisse plus zwei vorangehende Baseline-Ereignisse
(Zeitgleichheit bedeutet unbekannte Reihenfolge),
maximal 1 MiB JSON. Eine zusätzliche Zeile erkennt Überschreitung. Die bestehenden
Indizes `source_measurement` und `source_receipt` begrenzen die Zeit-/Quellensuche.
Verbindungstimeout 2 s, serverseitiges Statementlimit 1 s, monotones Gesamtbudget
3 s zwischen Treiberaufrufen und mysqlnd-Lesetimeout 2 s. Laufende Treiberaufrufe/
OS-DNS sind dadurch nicht sofort abbrechbar; kein garantiertes hartes HTTP-Limit.

## Antwort

Immer `schema_version=1`, `read_only=true` und:

| Feld | Bedeutung |
|---|---|
| `status` | `ok`, `disabled` oder `unavailable` |
| `reason` | Fester, sicherer deutscher Hinweis, keine DB-Fehlermeldung |
| `generated_at` | UTC-Referenz der Antwort; bei Erfolg Datenbankzeit |
| `minutes` | Gewähltes Fenster 1/5/15 |
| `range` | UTC-`from`/`to` des serverseitig bestimmten Messzeitfensters |
| `complete` | Query-/Projektionsgrenzen eingehalten; **keine** Zusicherung lückenloser Aufzeichnung |
| `samples` | Messzeitaufsteigend, bei Gleichstand Empfangszeit und ID; höchstens 1.200 |

`disabled`: HTTP 200, keine DB-Verbindung und leere Samples. `unavailable`: HTTP
503 und leere Samples; umfasst falsche Zugangsdaten, fehlende Rechte/Tabellen,
inkompatible Version, ungültige Daten und Treiberfehler. Bestehende Browserkurven
bleiben bei solchen Fehlern bis zur normalen Aufbewahrungsgrenze erhalten.

Jedes Sample enthält `id` als **Dezimalstring** (UInt64 ohne JavaScript-Rundung),
`timestamp`, `received_at` (UTC), `status=ok|error`, `values` und
`break_before` (Boolean). `values` übernimmt ausschließlich die typisierten
Wallboxfelder des Live-Vertrags: `error_code`, `socket_lock_state`,
`charging_state_raw`, `charging_state`, `below_commanded_current`, `plugged_in`,
`charging`, `current_limit_a`, `current_a[3]`, `voltage_v[3]`, `active_power_w`,
`session_energy_wh`. A/V/W/Wh bleiben unverändert; Dezimalwerte werden Zahlen,
Boolesche Werte echte Booleans, SQL-NULL bleibt `null`. Readfehler liefern
`values=null`, niemals erfundene Nullmessungen.

## Unterbrechungen und Browser

Ereignisse werden nach **Empfangszeit** zugeordnet, nicht auf die Messzeitachse
kopiert. Offline, Broker-/Collectorgrenzen, Ingest-Lücken, Fehler und Retained-
Ungewissheit unterbrechen Verbindungen. Empfangs-/Messzeitrücksprünge werden vor
dem Sortieren geprüft. Überlauf oder unzuordenbare Clock-/Ereignisreihenfolge
liefert `complete=false` und konservativ getrennte Punkte. Pausen über 10 s
werden weiterhin nicht verbunden. Fehlende Daten werden nicht interpoliert.

Der Browser lädt nur auf `/diagramme`, stets das gesamte 15-Minuten-Fenster und
filtert die bestehenden 1/5/15-Minuten-Auswahlen lokal. Höchstens ein aktiver Abruf,
Timeout 4 s, sichtbare Aktualisierung nach 60 s, Fehler-Backoff 10/30/60 s.
Verstecken/Verlassen bricht ab; Rückkehr/Seitencache-Neustart lädt neu.
Generations- und Uhrenprüfungen verwerfen verspätete Antworten. Deaktivierte
Historie stoppt regelmäßige SQL-Abrufe. Keine Messwerte in localStorage.

SQL-Import ist kein künstliches Live-Sample und ändert keine Frischeanker.
Gemeinsamer Puffer maximal 15 Minuten/1.200 Punkte; Live-Werte gewinnen bei
gleicher Zeitmarke, Unknown-/Fehlerwechsel bewahren Unterbrechungen. Gemischte
SQL-/Live-Kanten sind konservativ getrennt. Nach lokal beobachtetem Ausfall
werden spätere SQL-Punkte bis zum Zurücksetzen isoliert: lieber zusätzliche
Lücken als nachträgliches Überbrücken einer bekannten Unterbrechung.

## Nachweisgrenze

Automatische Tests verwenden ausschließlich isolierte Dummy-Accounts und einen
eigenen MariaDB-Testserver. Das ist kein Produktionslogin-/Pi-Deploymentnachweis.
Der tatsächliche Account `smartReader` wurde beim Projektinhaber über Socket und
Docker-TCP mit 1045 abgewiesen; Name, Passwortzuordnung und Hostfreigabe müssen
berechtigt geklärt werden. **Später ausdrücklich autorisierte Zwischenlösung:**
`HISTORY_DB_USERNAME=smart` mit eigener geschützter Website-Passwortkopie.
Der Code bleibt SELECT-only/Read-only-Transaktion, das Konto selbst besitzt aber
weitere Schreib-/DDL-/Löschrechte. Kein automatischer Rückfall, keine Benutzer-/
Grant-/Schemaänderung und kein Passwortreset; Least Privilege bleibt Empfehlung.
