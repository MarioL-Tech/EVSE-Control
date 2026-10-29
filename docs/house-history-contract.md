# Haus-Netzleistung: persistente Historie (implementiert, opt-in)

Auftrag 2026-10-29. Quellstand 9aea000 Docker-geprüft, aktuellen Freigabestand
über PR #54 prüfen. Noch keine produktive Migration/Aktivierung.
Vorhandene MariaDB weiterverwenden; Preis-, Provider-, Wallbox- und Rawdaten
niemals löschen/umschreiben. Website bleibt SELECT-only. Nur vorwärts ab
Aktivierung aufzeichnen, keine früheren Hausmessungen erfinden.

## Datenfluss

Rohunterbrechungen gelten kantenbezogen: ein alter Retained-/Clock-Ausreißer
bleibt getrennt, isoliert aber nicht automatisch alle späteren, unabhängig
belegten Nachbarn. `complete=false` bleibt als Qualitätsangabe erhalten;
fehlender/trunkierter Ereigniskontext darf dadurch keine falsche Verbindung erhalten.

Separater `house-publisher` im bestehenden Website-Compose, Profil
`house-history`, verwendet dasselbe PHP-Image, SmartmeterClient und bestehende
SMARTMETER_URL, aber eigenen CLI-Entrypoint/Healthcheck/MQTT-Client. Website
weiter Apache plus genau zwei bisherige Worker. Beide HTTP-Poller bleiben
zunächst unabhängig; kein Zugriff des Browsers auf die echte Quelle.

Vorhandener Broker, standardmäßig `evse/house/state` und
`evse/house/availability`, retained/QoS 1; eigene Client-IDs. Neuer
`house-storage` im bestehenden Storage-Compose/Profil `house-history`, dasselbe
Python-Image und vorhandene DB-Secrets. Keine neuen Server/Hostports/Hardware-
oder Docker-Sockets. Kein Container verwaltet andere Container.

## MQTT-Vertrag 1

State ist UTF-8-JSON, maximal 8192 Bytes, exakt folgende Schlüssel:

```json
{"schema_version":1,"device":"house_grid","publisher_id":"00000000-0000-4000-8000-000000000001","sequence":1,"timestamp":"2026-10-29T00:00:00.000000Z","status":"ok","last_success_at":"2026-10-29T00:00:00.000000Z","power_w":-800.5,"error":null}
```

- `publisher_id`: kanonische zufällige UUID pro Lauf/Beobachtungsepoche.
- `sequence`: Integer 1..4294967295; jede neue Beobachtung neue Sequenz.
  Retries behalten ID/Sequenz/Inhalt. Vor Überlauf neue Epoche.
- UTC-Zeiten 1970..9998, Sekunden mit optional 1..6 Nachkommastellen.
  `timestamp` ist HTTP-Abruf-/Fehlerzeit, keine zugesicherte Geräte-Messzeit.
- `ok`: endliche signed Wattzahl mit Betrag <= 9007199254740991,
  `last_success_at=timestamp`, `error=null`. Echte 0 ist gültig.
- `error`: `power_w=null`, nullable `last_success_at`, statischer Fehlercode
  `read_failed|startup|stale|clock_error`; keine URLs/Bodys/Credentials/Exceptions.
- Rückwärtszeit/Verbindungswechsel/Sequenzsprünge/Fehler dürfen keine
  Kontinuität erzeugen. Keine künstlichen Live-Beobachtungen beim Reconnect.
- Availability `online|offline`, Offline-LWT und Shutdown; online bedeutet
  frischen erfolgreichen HTTP-Abruf, nicht neue physische Messung.
- Maximal letzte Beobachtung plus begrenzte ausstehende Nachrichten, PUBACK-
  Frist und Reconnect. Kein dauerhaftes Publisher-Outbox-/Replayversprechen.

## HOUSE-Schema 1 (separate Registry)

Migration ausdrücklich `python -m storage --migrate-house`. Bestehende globale
`evse_schema_versions` mit `{1}`/`{1,2}` bleibt unangetastet; keine Pause/
Migration des Wallboxcollectors erforderlich. DDL wiederanlaufbar, unter eigenem
Migration-Lock; vorhandene falsche Tabellenformen strikt ablehnen statt ändern.
Haus-Runtime besitzt nur SELECT/INSERT/UPDATE auf ihren Tabellen, kein DDL.

Gemeinsame Regeln: `source VARBINARY(240)` exakt der UTF-8-Topicpräfix;
alle DateTime-Spalten UTC/DATETIME(6); IDs BIGINT UNSIGNED werden in API Strings.
Wattwerte DECIMAL(24,6), Summen DECIMAL(38,6), keine Energieintegration.
Nur unten genannte feste Tabellen-/Spaltennamen im lesenden API verwenden.

- `evse_house_schema_versions`: `version` (1), `checksum`, `applied_at`.
- `evse_house_samples`: `id`, `source`, `publisher_id BINARY(16)`, `sequence`,
  `fetched_at`, `received_at`, `status`, `last_success_at`, `power_w`,
  `error_code`, `retained`, `digest BINARY(32)`.
  Unique `(source,publisher_id,sequence)`, Index `(source,fetched_at,id)`.
  Bestätigte Duplikate überschreiben keine Werte/erste Empfangszeit/Retainedflags.
- `evse_house_events`: `id`, `source`, `event_id BINARY(16)`, `kind`,
  `received_at`, `retained`, nullable `availability`, bereinigte `details`.
  Unique `(source,event_id)`. Startup/Disconnect/Offline/Overflow sind Barrieren.
- `evse_house_buckets`: `source`, `level` (`minute|hour|day`), `bucket_start`,
  `bucket_end`, `samples`, `valid_count`, `null_count`, `sum_w`, `min_w`,
  `max_w`, `first_w`, `last_w`, `first_at`, `last_at`, `coverage_ms`,
  `has_gap`, `complete`; Primary Key `(source,level,bucket_start)`.
  Leere Intervalle: Count 0, alle Werte/Beobachtungszeiten null, niemals 0 W
  erfinden. First/Last folgen tatsächlichen Randbeobachtungen einschließlich NULL.
- `evse_house_work`: `source`, `level`, `bucket_start`, `generation`,
  `processed_generation`, `pending`; Primary Key `(source,level,bucket_start)`.
  Pending-Index, keine automatische Löschung erledigter Work-Zeilen.

Raw/Event plus Dirty-Markierung atomar VOR ACK. Generation-/Delivery-MID-Schutz,
begrenzte Inbox/Backpressure/Retry wie Wallboxcollector; kein SQL im Callback.
Eigener HOUSE-Worker materialisiert begrenzte Work-Turns, nicht im Callback.
Roheintrag markiert aktuelle/vorherige Minute und betroffene Stunde/Tag dirty;
Kindveröffentlichung markiert Eltern nochmals. Generationen atomar prüfen.
Eltern nicht als fertig ausgeben, solange betroffene Kinder pending sind.

Abdeckung nur zwischen zeitlich geordneten, frischen, nicht-retained OK-
Beobachtungen gleicher Epoche mit benachbarten Sequenzen, höchstens 10 s Abstand
und ohne Barriere. Retained ist kein Backfill. Fehler/Neustarts/Verluste/Clock-
Sprünge unterbrechen; Aggregatsummen sind keine Kontinuitätsbeweise. Fehlende
oder abgeschnittene Kontexte machen keine vollständige Abdeckung. Minute braucht
begrenzten Kontext beider Seiten; kein unbeschränkter Rohscan. Physische Lücke
und noch nicht materialisierte Arbeit getrennt behandeln. Kein Löschen/Retention.

## Lesende Website-API

`WEB_HOUSE_HISTORY_ENABLED=0` Default. Vorhandene HISTORY_DB_*-Konfiguration und
readonly Secret-Mount, Source separat `HOUSE_MQTT_TOPIC_PREFIX=evse/house`.
House-Aktivierung darf nicht global Schema 2/Wallbox-Rollups voraussetzen.
`GET|HEAD /api/house-history`, sonst 405; no-store, keine SQL-/Host-/Secretdetails.
HistoryRange wiederverwenden (Vienna/UTC, DST, ISO-Wochen, maximal ein Kalenderjahr).
Bestehende Wallbox-API `/api/history` unverändert.

Rohfenster `minutes=1|5|15` (Default 15), Response:

```json
{"schema_version":1,"read_only":true,"status":"ok","reason":"Hausverlauf","generated_at":"2026-10-29T00:00:00Z","minutes":15,"range":{"from":"2026-10-28T23:45:00Z","to":"2026-10-29T00:00:00Z"},"complete":true,"samples":[{"id":"1","timestamp":"2026-10-28T23:59:58.000000Z","received_at":"2026-10-28T23:59:58.010000Z","status":"ok","power_w":-800.5,"break_before":true}]}
```

Maximal 1200 Samples/1 MiB. Barrieren/Baselines begrenzt auswerten, nicht bloß
Fehlersamples filtern und Nachbarn verbinden. Kein Archivimport in Live-Frische.

Kalender: exakt dieselben Top-Level-Schlüssel wie Wallbox-Schema 2
(`schema_version,read_only,status,reason,generated_at,range,selection,navigation,
aggregation,complete,progress,buckets`), `aggregation=sample_mean`.
Bucket-Schlüssel `from,to,samples,has_gap,complete,coverage_seconds,metrics`;
`metrics` enthält NUR `power_w`, mit
`count,nulls,mean,min,max,last,mixed` (mixed=false für numerische Leistung).
Signed Werte; kein Summe-als-Verbrauch. Response maximal 512 Buckets/2 MiB,
Input maximal 10000 Zeilen/32 MiB, Keyset-Seiten 256. Read-only Snapshot und
prepared SELECTs; Statement 1 s, Treiber 2 s, kooperativ gesamt 3 s.
Jahresansichten nur materialisierte Minute/Stunde/Tag, nie Jahres-Rohscan.
Pending Work/fehlende Bucketdaten konservativ als unvollständig kennzeichnen.
Disabled=200, Fehler=503/unavailable, unabhängig von Live- und Wallboxstatus.

## Frontend/Performance

Kalenderkoordination für beide Archive:
- `window.OverlayCalendar.currentSelection` ist null im Live-Modus, sonst die
  aktuelle Query-Auswahl. `currentRange` optional `{from,to,timezone}`.
- Bei Select/geladenem Bereich wird `evse:calendar-change` am window ausgelöst:
  detail `{selection,range}`. Initialer Zustand auch als obige Properties, da
  die Hausmodule erst nach app.js binden. Keine Messdaten in diesem Event.
- Nach Serverauflösung einer relativen `date=now`-Auswahl darf die veröffentlichte
  Query über `at=range.from` auf genau denselben aktuellen Zeitraum verankern;
  gespeicherte Benutzerpräferenz/Now-Semantik unverändert lassen.
- Falls Wallboxhistorie disabled/unavailable ist, kann eine validierte HOUSE-
  Antwort ihre Range/Navigation liefern: `evse:calendar-range` mit detail
  `{query, metadata}`; query ist die exakte aktuelle `OverlayHistory.calendarQuery`
  und metadata enthält nur range/selection/navigation (keine Messwerte).
  Controller ignoriert fremde/veraltete Query und nutzt gültige Metadaten nur
  als Ersatz für noch fehlende Navigation. HOUSE darf nicht vom Erfolg einer
  Wallboxabfrage abhängig werden.

Hausdaten via eigener API in dieselbe Kalenderauswahl integrieren; echte Live-
Abrufe weiter unabhängig von MQTT, Roh-/Archivstores begrenzen. Archivdaten
erneuern nie Live-Frische. Spätantworten/Hidden/Pageshow/Zeitrücksprung absichern.
Netzleistung vor dem Diagnosefenster, keine neuen erklärenden Karten/Texte.

Diagramme brauchen bounded DOM statt zwei DOM-Knoten je Messpunkt/Bucket.
Pfad-Batching, Bildschirmdichte und geschlossene Diagnosegruppen berücksichtigen;
keine echten Unterbrechungen optisch heilen. Lesbare Kurven/Achsen in beiden
Themes/320..1440 px, keine Daten-/Auswahlverluste als Performance-Trick.

Installation ausschließlich im zentralen Installationsguide ergänzen; keine
Produktivzugriffe/-migrationen durch Agent, keine Passwörter/privaten URLs im Repo.
