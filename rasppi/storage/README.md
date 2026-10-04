# MQTT-Zustandsspeicherung

Separater Python-/Paho-/PyMySQL-Dienst: vorhandener MQTT-Broker → validierte
Wallbox-Samples → **vorhandene MariaDB**. Kein Hardwarezugriff, MQTT-Publish,
Webserver oder Steuerbefehl; kein neuer Produktionsbroker/DB-Server.

Einrichtung, Accounts, Passwortdateien, externe Netzwerke, Migration, Backup
und Prüfung: [Installationsguide, Abschnitt 10](../../docs/installation.md#10-mqtt-zustandsspeicherung-in-der-vorhandenen-mariadb).
**Vor dem ersten Start** bestehende DB-Version/Netzwerke prüfen, eigene Datenbank
und Accounts vorbereiten und explizit migrieren. Die Pi-Einrichtung ist noch nicht bestätigt.

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
- Keine automatische Löschung/Aggregation, Sessionerkennung, RFID-/UART-/Zählerdaten
  oder Verbindung der Browserdiagramme mit SQL. Das folgt separat. Speicherplatz
  und Backups überwachen; default 2 s ergeben etwa 43.200 Samples **plus** wiederholte
  Availability-Beobachtungen pro Tag. Daten wachsen ohne vereinbarte Aufbewahrungsfrist.
- Explizites `--migrate` mit separatem DDL-Account, Runtime nur SELECT/INSERT.
  Schema-Version 1; keine automatische Änderung fremder Tabellen/Accounts.
  Vor Bestätigung werden Engine, Spaltentypen/Nullability und UNIQUE-Identitäten
  geprüft; gleichnamige inkompatible Tabellen werden nicht als Version 1 übernommen.
- Healthcheck ist **Readiness** (DB geprüft, MQTT subscribed, frischer Worker-Tick),
  nicht Vollständigkeit oder Wallbox-Frische. Fehler lösen kein neues DB-/Broker-
  Deployment aus. DNS kann Prozessfristen überschreiten; Compose beendet nötigenfalls
  nach 20 s, dann können RAM-Daten verloren gehen.

## Tests

Alle Tests in Docker, keine Host-Pakete erforderlich:

```bash
docker compose -f compose.test.yaml build tests
docker compose -f compose.test.yaml up --abort-on-container-exit --exit-code-from tests
docker compose -f compose.test.yaml down --volumes
```

**Nur diese Test-Datei** enthält einen temporären MariaDB-10.11-Server und Broker,
im isolierten Docker-Netz ohne Hostports/Produktionsnetz; bekannte Dummy-Passwörter
sind nur Testdaten. Das Aufräumen gilt nicht für vorhandene Produktionsdienste.
Unit-Tests laufen zusätzlich bei jedem Runtime-Image-Build. GitHub-Docker-CI prüft
SQL/MQTT, eingeschränkte Grants, Retained-/Restart-Deduplizierung, DB-Recovery und
das gehärtete Runtime-Image. Ausführung für den neuen Dienst noch ausstehend.
