# MQTT-Zustandsspeicherung

Separater Python-/Paho-/PyMySQL-Dienst: vorhandener MQTT-Broker → validierte
Wallbox-Samples → **vorhandene MariaDB**. Kein Hardwarezugriff, MQTT-Publish,
Webserver oder Steuerbefehl; kein neuer Produktionsbroker/DB-Server.

Einrichtung, Accounts, Passwortdateien, externe Netzwerke, Migration, Backup
und Prüfung: [Installationsguide, Abschnitt 10](../../docs/installation.md#10-mqtt-zustandsspeicherung-in-der-vorhandenen-mariadb).
**Vor dem ersten Start** bestehende DB-Version/Netzwerke prüfen, freigegebenes
Zielschema und passende Accounts vorbereiten und explizit migrieren. Der Guide
beschreibt eigene EVSE-Tabellen im vorhandenen `energyControl`.
**Pi-Bestätigung vom 2026-10-27:** Schema 1 migriert und 207 Wallbox-Samples
per SQL nachgewiesen (0 W, Limit 6 A, drei Phasenspannungen). Bestehende Preis-
Datensatzanzahlen nach Migration unverändert; Bestandssicherung auf Pi/PC mit
SHA256 und isoliertem Restore geprüft. Kein Langzeit-/Ausfallnachweis.
Aktuell bewusstes Bestandskonto `smart` mit mehr Rechten als technisch nötig;
Rechtehärtung nur abgestimmt. Pi-Kernel setzt angeforderte RAM-Limits nicht durch.

Danach aus diesem Verzeichnis:

```bash
docker compose up -d --build storage
docker compose logs --tail 50 storage
```

## Vertrag und Grenzen

- `evse_wallbox_samples`: Originalmesszeit und Empfangszeit UTC, erfolgreicher
  Read oder Kommunikationsfehler, unveränderte `null`-Zustände, typisierte Werte
  (A/V/W/Wh), bereinigtes Schema-1-JSON, Herkunft und erstes Retained-Flag.
- Identität: MQTT-Präfix + SHA256 des normalisierten Samples. QoS-Wiederholungen
  und retained Reconnects erzeugen keine neue Zeile. **Gleiche Sekundenzeit mit
  anderen Werten** bleibt eine eigene Zeile; Empfangsmetadaten werden nie erneuert.
- `evse_ingest_events`: Availability-Beobachtungen (auch wiederholtes `online`),
  Broker-/Collectorgrenzen und zusammengefasste verworfene Records/Zustellungen. UUID
  einmal pro Beobachtung, unverändert bei SQL-Retry. Availability hat keinen
  Gerätestempel und ist keine atomare Aussage zu einem bestimmten Sample.
- Strukturvalidierte alte/zukünftige Samples werden als Historie gespeichert,
  **niemals als aktuelle Messwerte angeboten**. `status=ok` heißt nur erfolgreicher
  Read zum Gerätezeitpunkt; `online` ist nicht Laden oder fehlerfreie Hardware.
- MQTT-Callbacks führen kein SQL aus. Ein Worker hält höchstens die konfigurierte
  RAM-Queue (default 256) plus einen ausstehenden Datensatz und Gap-Zähler.
  ACK erst nach Commit/bestätigter Duplikatzeile; Session-/Delivery-Tokens verhindern
  falsche ACKs bei wiederverwendeten MIDs. Ungültige Payloads werden bewusst verworfen.
- DB-Ausfall pausiert/disconnectet den Collector, nicht Reader oder andere MQTT-
  Dienste. Retry mit derselben Hash-/UUID-Identität auch bei ungewissem Commit.
  Nach Recovery kommt der neueste retained Snapshot, **kein Nachladen** fehlender Reads.
- Kein Disk-Spool, keine verlustfreie Zusage: Restart verliert RAM, Queue-Überlauf
  verwirft Zustellungen. Gap-Zähler/Startgrenzen kennzeichnen unbestimmte Abdeckung,
  nicht die exakte Anzahl fehlender Messungen. Queue-Zähler enthalten auch verworfene
  Collector-Ereignisse, Invalid-Zähler nur abgelehnte MQTT-Payloads. Bei Ausfall bleiben Lücken.
- Keine automatische Löschung, Sessionerkennung oder RFID-/UART-/Zählerdaten.
  Optionale Verdichtung für den getrennten lesenden Website-Kalender siehe unten. Speicherplatz
  und Backups überwachen; default 2 s ergeben etwa 43.200 Samples **plus** wiederholte
  Availability-Beobachtungen pro Tag. Daten wachsen ohne vereinbarte Aufbewahrungsfrist.
- Explizites `--migrate` mit CREATE/SELECT/INSERT-Berechtigung; getrennte
  Minimalrechte-Accounts sind empfohlen. Schema-1-Runtime führt nur SELECT/INSERT aus.
  Mit explizitem Schema 2 zusätzlich SELECT/INSERT/UPDATE an neuen eigenen Historytabellen,
  niemals UPDATE an Rohsamples/Events oder Preis-/Providertabellen.
  Keine automatische Änderung fremder Tabellen/Accounts.
  Vor Bestätigung werden Engine, Spaltentypen/Nullability und UNIQUE-Identitäten
  geprüft; gleichnamige inkompatible Tabellen werden nicht als Version 1 übernommen.
- Healthcheck ist **Readiness** (DB geprüft, MQTT subscribed, frischer Worker-Tick),
  nicht Vollständigkeit oder Wallbox-Frische. Fehler lösen kein neues DB-/Broker-
  Deployment aus. DNS kann Prozessfristen überschreiten; Compose beendet nötigenfalls
  nach 20 s, dann können RAM-Daten verloren gehen.

## Optionale Kalenderverdichtung (Schema 2)

Neu implementiert und Docker-geprüft: explizites
`--migrate-history` ergänzt drei eigene Tabellen und Metadataversion 2; Version 1
bleibt erhalten. Kein ALTER/Löschen bestehender Daten oder automatischer DDL-Start.
Die Versionsmengen `{1}` und `{1,2}` sind kompatibel; Basisbetrieb bleibt Schema 1.
Separater `history-rollup` im Compose-Profil `history` verwendet dasselbe Image,
die vorhandene DB und die geschützte Runtime-Passwortdatei, ausschließlich DB-Netz,
keinen Brokerzugriff, Hostport oder Docker-Socket. Keinen zweiten Server starten.

Neu eingefügte Samples/Ereignisse markieren Work in derselben Transaktion vor ACK.
Der Worker rekonstruiert UTC-Minuten/Stunden/Tage deterministisch, generation-geprüft
und mit dauerhaften Backfill-Cursorn. Wiederholungen ersetzen Summarydaten statt
Zähler doppelt zu erhöhen. Erledigte Workeinträge bleiben erhalten. Mittelwerte
nur aus vorhandenen W/A/V-Samples, keine Bool-/Codemittel oder Session-Wh-Summen.
Unklare Ereignisse, Retained, NULL und Ausfälle bleiben sichtbare Qualitätsgrenzen.

**Aktivierung zwingend koordiniert:** kompatible Website zuerst, neues Storageimage
bauen, alten Collector stoppen, Migration, aktualisierten Collector und erst dann
Worker starten. Eine schon unter Schema 1 verbundene Instanz kennt neue Dirtyarbeit
nicht. Die kurze Pause kann Records verlieren; retained ersetzt kein Replay.
Konkrete sichere Schritte ausschließlich im [Installationsguide](../../docs/installation.md#kalender-jahresverlauf-zusätzlich-einrichten-optionales-schema-2).
Worker-Health ist laufende DB-Verarbeitung, nicht abgeschlossener Backfill oder
lückenlose Messabdeckung. Keine Anzeigebegrenzung als Datenlöschfrist auslegen.
Schema-2-CI 40678971216 für c83b1cc: alle 75 Tests und Runtime auf MariaDB
10.11/11.8.8/11.8 erfolgreich. Kein Pi-/Produktionsmigrations-/Langzeitnachweis.

## Tests

Alle Tests in Docker, keine Host-Pakete erforderlich:

```bash
docker compose -f compose.test.yaml build tests
docker compose -f compose.test.yaml up --abort-on-container-exit --exit-code-from tests
docker compose -f compose.test.yaml down --volumes
```

**Nur diese Test-Datei** enthält einen temporären MariaDB-Server und Broker,
im isolierten Docker-Netz ohne Hostports/Produktionsnetz; bekannte Dummy-Passwörter
sind nur Testdaten. Das Aufräumen gilt nicht für vorhandene Produktionsdienste.
Default-Testversion 10.11; für den bestätigten Pi-Binary-Stand jedem Compose-Aufruf
`MARIADB_TEST_VERSION=11.8.8` voranstellen. CI prüft 10.11, exakt 11.8.8 und den
rollenden 11.8-Tag unabhängig. Letzterer war im ersten Matrixlauf bereits 11.8.9;
CI [37212624186](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/37212624186)
für `d30f00f`: **je 39 Tests + Runtime-Smoke** unter 10.11.19, 11.8.8 und 11.8.9
bestanden (amd64, kein echter ARM64-/Pi-Test). Produktionsimage bleibt unverändert.
Unit-Tests laufen zusätzlich bei jedem Runtime-Image-Build. GitHub-Docker-CI prüft
SQL/MQTT, eingeschränkte Grants, Retained-/Restart-Deduplizierung, DB-Recovery und
das gehärtete Runtime-Image. CI
[37209898185](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/37209898185)
für `50794db` erfolgreich: **32 Unit- und 7 Integrationstests** sowie Runtime-Smoke.
Das bestätigt isolierte Softwaretests, nicht echte Pi-/DB-Einrichtung.
