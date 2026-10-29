# Kalenderhistorie und Verdichtung

Implementierter Vertrag, Stand 2026-10-29. Historische Docker-CI 40678971209 für c83b1cc
erfolgreich; kein Pi-Deployment oder produktiver Backfill. Eine Jahres-Fixture
verwendet 8.784 echte SQL-Stundenzeilen mit künstlichen Read-Countern, nicht
15 Millionen eingefügte Rohzeilen. Beobachtete CI-Lesezeit 1.278 ms (amd64),
keine zugesicherte Pi-/ARM-Laufzeit.

## Unveränderliche Grenzen

- Zukünftige Kalenderperioden oder explizite UTC-Anker nach jetzt liefern400,
  ebenso benutzerdefinierte Bereiche mit einem Ende nach jetzt. Laufende Stunde/
  Tag/Woche/Monat/Jahr bleiben auswählbar; deren kalendarische Achse darf noch
  leere zukünftige Intervalle enthalten, aber Abfragen lesen keine zukünftigen
  Summaries. `navigation.next` ist am aktuellen Zeitraum `null`. Die Oberfläche
  begrenzt alle Picker und verwirft zukünftige gespeicherte Auswahlen vor Fetch.
  Prüf-/Freigabestand dieser neuen Regel: PR#58; Live-Frische unverändert.

- Keine Löschung/Änderung bestehender Rohmessungen, Preis-/Providerdaten, Grants,
  Accounts, Server, Hardware, Netzwerke oder Ports. Website nur SELECT/read-only.
- Basisbetrieb Schema 1 und `/api/history?minutes=1|5|15` bleiben kompatibel.
- Keine Jahresabfrage über Millionen Rohzeilen. Begrenzte gespeicherte Summaries.
- Migration und Betrieb ausschließlich in Docker; kein Agent-Produktionszugriff.
- Neues Schema ausdrücklich optional migrieren, nicht automatisch beim Start.
- Schema2 allein aktiviert kein Retention/Purge. Separat autorisierte
  quellgebundene Aufbewahrung ist in [minute-recording.md](minute-recording.md)
  beschrieben und standardmäßig0/unbegrenzt. Ein Jahr ist die Anzeigespanne,
  keine Löschfrist.

## Speichervertrag (Schema 2, additiv)

`evse_schema_versions` enthält weiterhin Version 1 und nach explizitem
`--migrate-history` zusätzlich Version 2. Unterstützte Mengen exakt `{1}` und
`{1,2}`; andere Mengen ablehnen. Default-`--migrate` bleibt Schema 1.
002-Migration erstellt ausschließlich neue eigene Tabellen und registriert 2
erst nach erfolgreicher Shape-Prüfung. Keine ALTERs an vorhandenen Datentabellen.

Neue Tabellen (gemeinsame Schnittstelle, zusätzliche interne Spalten erlaubt):

1. `evse_history_buckets`: `source VARBINARY(240)`,
   `resolution_seconds INT UNSIGNED`, `bucket_start DATETIME(6)`,
   `data_json LONGTEXT` (utf8mb4, binäre Kollation), `updated_at DATETIME(6)`.
   Primary Key `(source,resolution_seconds,bucket_start)`.
2. `evse_history_work`: gleicher Schlüssel, `generation BIGINT UNSIGNED`,
   `done_generation BIGINT UNSIGNED`, `pending TINYINT UNSIGNED`.
   Index `(source,pending,resolution_seconds,bucket_start)`.
3. `evse_history_state`: `source VARBINARY(240)` Primary Key,
   `algorithm_version INT UNSIGNED` (1), `sample_cursor BIGINT UNSIGNED`,
   `sample_highwater BIGINT UNSIGNED`, `samples_done TINYINT UNSIGNED`,
   `events_done TINYINT UNSIGNED`, `updated_at DATETIME(6)`;
   interne Ereignis-Keyset-Cursor/Highwater zusätzlich.

Alle Zeitwerte UTC. Auflösungen genau 60/3600/86400 Sekunden, UTC-ausgerichtet.
Quelle exakt binäres MQTT_TOPIC_PREFIX, ohne `/state`. Keine personenbezogenen Daten.
Kein benötigtes DELETE-Recht: erledigte Work-Einträge behalten und aktualisieren.

Nur frisch eingefügte Rohsamples/Ereignisse markieren betroffene Minuten/angrenzende
Grenzen dirty, in derselben Transaktion wie die Originaleinfügung. Duplikate nicht
erneut beitragen lassen. Schema 1 hat diese zusätzliche Arbeit nicht.

Separater storage-eigener `--history-worker`, eigener Container/Connection und
Compose-Profil `history`; gleicher bestehender DB-Zugang und Image, keine Ports.
Auf Fehler/Backfill darf Raw-Collector-ACK/Hardware nicht warten. `GET_LOCK` pro
Quelle verhindert doppelte Worker. Bei Work-Publikation Generation vergleichen;
nur aktuelle Ergebnisse veröffentlichen, Elternstunden/-tage erneut markieren.

Minute deterministisch aus indexierten Rohdaten + Nachbarn + Ereigniskontext
neu berechnen, Stunde aus Minuten, Tag aus Stunden. Ersetzen statt additiver
Zählerfortschreibung: Wiederholung/uncertain commit/Backfill verdoppeln nichts.
Verspätete Samples, gleiche Zeit mit geändertem Payload und Ereignisse beachten;
zufällige UUID-Reihenfolge niemals als Chronologie interpretieren.
Backfill über eingefrorene Highwater/PK- und Ereignis-Keyset-Chunks, Fortschritt
transaktional speichern. Neue Live-Dirtymeldungen gleichzeitig weiterverarbeiten.
Jeder Turn hat Zeilen-/Zeitgrenzen; überdichte/mehrdeutige Daten bleiben explizit
unvollständig, keine unbeschränkten SELECTs oder erfundene Verfügbarkeit.
Backdatierte Availability-/Gapereignisse müssen ihren betroffenen Folgebereich
begrenzt/resumierbar invalidieren, nicht nur die Minute des Ereignisses.

### `data_json` Version 1

JSON-Objekt mit genau folgenden öffentlich benötigten Eigenschaften:

```json
{
  "schema_version": 1,
  "samples": 30,
  "valid_samples": 30,
  "error_samples": 0,
  "retained_samples": 0,
  "first_at": "2026-10-27T12:00:00.000000Z",
  "last_at": "2026-10-27T12:00:58.000000Z",
  "has_gap": false,
  "complete": true,
  "coverage_seconds": "58",
  "metrics": {
    "active_power_w": {
      "n": 30, "nulls": 0, "sum": "30000", "min": "1000",
      "max": "1000", "first": "1000", "last": "1000", "mixed": false
    }
  }
}
```

`metrics` enthält immer exakt die 16 typisierten DB-Felder:
`active_power_w`, `session_energy_wh`, `current_limit_a`,
`current_l1_a`, `current_l2_a`, `current_l3_a`,
`voltage_l1_v`, `voltage_l2_v`, `voltage_l3_v`,
`plugged_in`, `charging`, `below_commanded_current`, `error_code`,
`charging_state`, `charging_state_raw`, `socket_lock_state`.

Statistikzahlen als endliche kanonische Dezimalstrings, fehlende Werte `null`.
Counts ganze nichtnegative JSON-Zahlen, Bool-/Codewerte dezimal 0/1 bzw. UInt32.
`first`/`last` nach Messzeit + Roh-ID, nicht Empfangs- oder Verarbeitungsreihenfolge;
die tatsächlichen Endpunkte einschließlich NULL/Fehler, kein letzter Nichtnullwert.
Leere Buckets haben `first_at`/`last_at=null`; ein leerer Kindbucket überschreibt
keinen realen Endpunkt. `n=0` erzeugt keinen Mittelwert, auch bei Summe `"0"`.
`n` zählt Nichtnullwerte, `nulls` fehlende Werte. `sum` nur für W/A/V-Felder;
für Flags/Codes, Limit und Sessionzähler `null`. `mixed` bedeutet unterschiedliche
beobachtete Nichtnullwerte. Fehlerzeilen zählen Nulls, liefern keine Fakewerte.
Keine Bool-/Codemittel und keine Summierung von Session-Wh über Sessions.

`complete`: Kontext/bounded computation vollständig; nicht Garantie lückenlosen
Gerätebetriebs. `has_gap` konservativ bei Ausfall, unklarem Kontext, Retained,
Zeitfehler, Fehler- oder fehlenden Samples und fehlender Abdeckung. `coverage_seconds` nur
belegte Dauer zwischen gültigen, passend verfügbaren Nachbarreads <=10 s;
niemals allein aus Sampleanzahl Vollabdeckung ableiten. Abdeckung gilt für
gültige Beobachtungen, nicht zwingend jedes unabhängige Feld: unbekanntes Laden
zerreißt keine bekannten Spannungen; `nulls` unterbricht weiterhin genau die
betroffene Serie. Eindeutige nicht-retained Online-Refreshevents sind keine
Ausfälle; Lifecycle-/Offline-/Retained-/gleichzeitige mehrdeutige Ereignisse bleiben
Barrieren. Numerische Min/Max-Variation ist kein mehrdeutiger Codezustand und
unterbindet keine belegte Mittelwertlinie. Bestehende gespeicherte Aggregate
werden nicht nachträglich vom Browser umgedeutet; gezielter optionaler
`--refresh-history`-Auftrag siehe zentralen Installationsguide. Gemischte Zustände und
Session-Resets bleiben sichtbar/erklärbar, nicht künstlich konstante Kurven.
Stunden-/Tagkombination verwendet Summen/Counts statt Mittelwerte von Mittelwerten.

**Darstellung in Stunde/Tag/Woche/Monat/Jahr:** Linien verbinden vorhandene benachbarte
Intervallmittel bzw zulässige letzte Werte. Dies ist eine Interpolation von
Aggregaten, kein Nachweis durchgehend verfügbarer Rohmessungen. Die übergeordneten
Qualitätsflags `has_gap`, `coverage_seconds` und `complete` bleiben unverändert
in API und Inspektionslabels, isolieren aber nicht jeden bekannten Aggregatwert
während eines Verarbeitungsnachlaufs. Teilweise NULLs löschen einen bekannten
numerischen Mittel-/letzten Wert nicht; vollständig unbekannte oder fehlende/leere Intervalle,
unbekannte letzte Werte und gemischte kategoriale Zustände trennen weiterhin.
Für Bool-/Code-Stufen bleiben auch die bisherigen globalen Qualitätsbarrieren
erforderlich; eine unsichere Aggregatperiode wird nicht als konstanter Zustand ausgegeben.
Live-/Rohkurven behalten ihre10s-/Lifecycle-Regeln; nur eigene Zeiträume (custom)
verwenden weiter konservative Min/Max-Spannen. Linienachsen orientieren sich an
den dargestellten Mittel-/letzten Werten statt unsichtbaren Rohwertspitzen.
Keine Neuverdichtung als Voraussetzung.

Die PHP-Projektion erhält diese Trennung: unabhängige NULL-Metriken dürfen
`has_gap` nicht global verschärfen. Eine schlechte Readkante, die ausschließlich
vor dem halb offenen Bucket liegt und genau an dessen Anfang endet, belegt dort
keine Lücke; bereits eine positive Überlappung bleibt dagegen relevant.
Initialer Sample-/Event-Backfill bleibt global unbereit. Nach nachweislich
abgearbeiteten Initialcursorn sperrt eine spätere Eventinvalidierung erst ab
`invalidate_from` statt sämtliche älteren Perioden. Der Bereich bleibt bis zur
vollständigen Invalidierung gesperrt, unabhängig von deren Fortsetzungscursor;
Pending-Arbeit an Minuten/Stunden bleibt zusätzlich eine Sperre. Globale
`progress.events_done=false` kann deshalb mit einer bereits vollständigen älteren
Auswahl zusammenfallen. Keine Laufzeit-DDL oder Änderung gespeicherter Aggregate.

## HTTP-Vertrag

Legacy-Minutenform bleibt Schema 1 und dessen bestehende Grenzen.
Neue alternative Form (kein Mischen von Formen):

`/api/history?period=day&date=2026-10-27&tz=Europe%2FVienna`

- `period`: `hour|day|week|month|year|custom`.
- `date`: `YYYY-MM-DDTHH:00`, `YYYY-MM-DD`, `YYYY-Www`, `YYYY-MM`, `YYYY`;
  alternativ literal `now` für serverseitigen aktuellen Zeitraum.
- Navigation alternativ `at=<UTC-ISO-Z>` statt `date` (insbesondere doppelte
  Herbststunde eindeutig). `custom`: `from`/`to` als strikte UTC-Zeitgrenzen,
  oder `date_from`/`date_to` als zivile `YYYY-MM-DDTHH:mm` in angegebener Zone.
  Eigene Zeitbereiche liefern `navigation: null`, da benachbarte Kalenderperioden
  dafür nicht eindeutig definiert sind.
- Zonen explizit `Europe/Vienna` (Default) oder `UTC`, keine versteckte Browserzone.
- Strikte Kalenderdaten, ISO-Wochen, Schaltjahre, Sommerzeit 23/25-h-Tage,
  nicht existente Stunden ablehnen. Bereich halb offen `[from,to)`, maximal ein
  Kalenderjahr. Kalenderjahre 1970..9998. Keine freien SQL-Feldnamen/Auflösungen.
- Query maximal 512 Bytes, keine mehrfachen/unbekannten/Arrayparameter;
  erlaubte URL-Escapes streng prüfen. GET/HEAD/405 und Securityheader erhalten.
- Nur neue fertig materialisierte Summaries lesen. Schema 1 oder fehlende
  Verdichtung sauber `unavailable`, kein langer Raw-Fallback.
- Genaues Source-Präfix, Version-/Typprüfung, prepared SELECT, Read-only-Snapshot,
  Statementbudget 1 s, kooperativ 3 s. Höchstens 10.000 Summary-Eingangszeilen,
  32 MiB eingelesene Summarydaten, maximal 512 Ausgabebuckets/2 MiB JSON.
  Legacy-Ausgabebudget 1 MiB unverändert. Keine Treiber-/Credentialdetails nach außen.
- Stunde: Minuten; Tag: 5-Minuten-Bins aus Minuten; Woche: Stunden; Monat:
  lokale Kalendertage (28–31 Punkte, DST-Tage mit23/25 Stunden); Jahr: lokale
  ISO-Kalenderwochen, an den Jahresgrenzen abgeschnitten (53, in seltenen Jahren
  54 Punkte). Keine fremden Dezember-/Januartage in die Jahresauswahl aufnehmen.
  Beide aus bestehenden Stundensummen/Counts (max.8785 Stunden), nicht Mittelwert
  von Mittelwerten, keine neue SQL-Verdichtung/Migration und kein Rawscan.
  Keine falsche Zuordnung von UTC-Tagen zu lokalen Tagen.

Schema-2-Antwort:

```json
{
  "schema_version": 2, "read_only": true, "status": "ok", "reason": "...",
  "generated_at": "2026-10-27T12:01:00Z",
  "range": {"from":"2026-10-26T23:00:00Z", "to":"2026-10-27T23:00:00Z", "timezone":"Europe/Vienna"},
  "selection": {"period":"day", "date":"2026-10-27", "timezone":"Europe/Vienna"},
  "navigation": {
    "previous":{"period":"day","at":"2026-10-25T23:00:00Z","tz":"Europe/Vienna"},
    "next":{"period":"day","at":"2026-10-27T23:00:00Z","tz":"Europe/Vienna"},
    "now":{"period":"day","date":"now","tz":"Europe/Vienna"}
  },
  "aggregation":"sample_mean", "complete":true,
  "progress":{"samples_done":true,"events_done":true},
  "buckets":[{
    "from":"2026-10-26T23:00:00Z","to":"2026-10-26T23:05:00Z",
    "samples":150,"has_gap":false,"complete":true,"coverage_seconds":300,
    "metrics":{"active_power_w":{"count":150,"nulls":0,"mean":1000,"min":1000,"max":1000,"last":1000,"mixed":false}}
  }]
}
```

API-Metrics ebenfalls immer die 16 obigen Keys, typisierte finite Zahlen,
Bool-`last` als echtes bool, gemischte Flags/Codes durch `mixed`/Null darstellbar.
Keine Summe nach außen nötig. Physik W/A/V: samplegewichteter Mittelwert/Min/Max;
Limit/Sessioncounter: letzter Messwert/Spanne; Flags/Codes: nie Mittelwert.
`complete` ist Materialisierungsstand, nicht Hardwareverfügbarkeit. Pending-Work
im Bereich erkennt API indexiert, fehlende/dirty Buckets als Lücken/partial.
Fehler `unavailable`503/leer, deaktiviert200/leer, feste sichere Gründe.

## Browservertrag

- Bestehende Live-Karten/Frische/Warnings/Präferenzen nicht aus Archiv erneuern.
- Live-Modus mit 1/5/15 min erhalten. Unabhängiger begrenzter Archivstore.
- Toolbar nur Diagrammseite: Kalender mit adaptivem Native-Input, ausgewählter
  Zeitraum, Jetzt, Zurück/Weiter, Auswahl Live/Stunde/Tag/Woche/Monat/Jahr/Zeitraum.
  Zeitraum/Timezone klar beschriften, native Tastaturbedienung. Auswahl nur
  Präferenzen; keine Daten in localStorage. Server berechnet Zonen-/Kalendergrenzen.
- Summarydaten in Stunde bis Jahr als Mittel-/Letzter-Wert-Linien darstellen,
  nicht als durchgehende Rohaufnahme ausgeben; Lücken-/NULL-/Coveragequalität in
  API und Inspektionslabels behalten. Vollständig fehlende Intervalle trennen;
  Custom behält konservative Intervall-Min/Max-Spannen.
  Keine Marker-Pillen. Für Sessionenergie explizit letzter Sessionzähler,
  kein Tages-/Jahresverbrauch; gemischte Flags/Codes nicht als konstant darstellen.
- Raw-Graphfehler: `gapFloor`/globale Unvollständigkeit/Source-Wechsel nicht
  dauerhaft jeden SQL-Punkt isolieren lassen. Kantenbezogene Evidenz verwenden;
  nur browserseitige Transportlücken mit belegten SQL-Messungen auffüllen.
  Explizite Mess-/Clock-/Nullbarrieren erhalten, Same-Time-Live hat Vorrang.
  `break_before` gehört zur ursprünglichen SQL-Vorgängerkante, nicht pauschal
  zu jedem nach Merge davor stehenden Punkt. Ein unbelegter Seam ist eine Lücke,
  kein Gift für alle späteren Punkte. Marker zusätzlich nach Pixeldichte begrenzen.
- Eine Anfrage gleichzeitig, Abort/Generation/Hidden/Pageshow/Uhrenkorrektur
  wie bisher absichern. Calendar Requests verwenden nur festen API-Endpunkt.
- Aktuelles Jahr aktualisieren sichtbar begrenzt; vergangene Bereiche nicht
  unnötig jede Sekunde laden. SQL-/Rollupfehler ändern nie Live-/HTTP-Liveness.
