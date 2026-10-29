# Minutenaufzeichnung und Aufbewahrung

Umsetzung in PR #57; Codehead979b148 ist Docker-geprüft
(Web40927845891/40927833069, Storage40927845966 auf drei MariaDB-Versionen).
Die nachfolgende Minimalrechtekorrektur4a35f26 besteht Storage40929786439 mit
181 Tests je Version, einschließlich Migration und Reconnect ohne UPDATE-Recht.
Betreiberaktivierung und Pi-Abnahme bleiben offen.
Installation und Freigabeschritte stehen ausschließlich in
[installation.md](installation.md#minutenaufzeichnung-und-aufbewahrung).

## Datenvertrag

- Live-MQTT und Haus-HTTP-Erfassung bleiben im bisherigen Zwei-Sekunden-Takt.
  Die Websitefrische wird weder durch SQL noch durch Minutenabschluss erneuert.
- `STORAGE_RECORDING_MODE=minute` hält Beobachtungen begrenzt im RAM und
  veröffentlicht je Quelle und UTC-Minute einen dauerhaften Minutenrecord.
  Abschluss benötigt rechten Kontext; deshalb sind die neuesten Sekunden noch
  nicht im Archiv vorhanden. Teilminuten und Neustarts beweisen keine Coverage.
- Leistung, Phasenströme und Phasenspannungen: Stichprobenmittel aus Summe und
  Anzahl. Stunden-/Tagesmittel werden aus den Summen und Anzahlen gebildet,
  nicht aus einem ungewichteten Mittel der Minutenmittel.
- Stromlimit, Sessionenergie, Zustände, Boolesche Werte und Fehlercodes werden
  nicht gemittelt oder summiert. Letzter Wert und Mehrdeutigkeit bleiben getrennt.
- Ein Record enthält Min/Max/Anzahl/NULL- und Coverage-Evidenz, aber keine Kopie
  sämtlicher Zwei-Sekunden-Werte. Kurzzeitige Fehler dürfen trotz bekanntem
  Minutenmittel keine erfundene lückenlose Linie erzeugen.
- Stunde/Tag/Woche zeichnen Mittelwerte als einfache Linien und Zustände als
  Stufen. Isolierte Werte haben kleine Marker; belegte Nachbarn werden verbunden.
  Echte Lücken bleiben unverbunden. Monat/Jahr/eigener Bereich behalten Bänder.

## Speicherung und Verlustgrenze

Kurze SQL-Fenster (`/api/history?minutes=15` beziehungsweise
`/api/house-history?minutes=15`) verwenden nach Cutover den neuen Antwortvertrag
`schema_version=3`. Legacyantworten bleiben Schema 1; Kalender bleibt Schema 2.
Schema-3-Samples haben zusätzlich `interval`: bei Legacyraw `null`, bei einem
Minutenprodukt `{from,to,complete,has_gap,break_fields}`. `timestamp` bezeichnet
hier ausdrücklich die Intervallmitte, `received_at` den Intervallabschluss,
`id` ist Minutenidentität und keine Raw-SQL-ID. Es wird keine Geräte-Einzelmessung
vorgetäuscht. Nur ganze abgeschlossene Minuten innerhalb des Fensters kommen
zurück; fehlende/abgeschnittene Minuten werden nicht aufgefüllt.

Eigene NULL-/Mehrdeutigkeitsbarrieren bleiben über `break_fields` erhalten,
auch wenn ein gültiger Mittelwert existiert. Nur validierte, vollständige,
gapfreie und direkt angrenzende Minutenintervalle können eine Minutenlinie
belegen. Tatsächliche schnelle Raw-/Livepunkte behalten die 10-s-Grenze.
Legacy-/Minuten- und SQL-/Liveübergänge bleiben ausdrücklich getrennt; kein
Archivwert erneuert Live-Frische. Nachträgliche Offline-/Lifecycle-Ereignisse
einschließlich vorausgehender Baseline dürfen auch immutable Captures sperren.

Additive unabhängige Tabellen `evse_minute_schema_versions`,
`evse_minute_sources` und `evse_minute_records`; explizites `--migrate-minutes`.
Bestehende Wallboxversionen 1/2 und HOUSE-Version 1 bleiben unverändert.
Quellkennung und persistierter Umschaltzeitpunkt trennen alte Rohdaten von neuen
Minutenprodukten. Vorhandene Rohdaten werden nicht in Minutenwerte umetikettiert.
Nach einmaligem Cutover ist ein Rückwechsel dieser Quelle auf Rawaufnahme nicht
unterstützt und wird vor Intake abgelehnt; vorhandene Captures dürfen neue
Rohzeilen nicht still verdecken. Rawkonfigurierte Kalenderworker dürfen dagegen
weiterhin Captures lesen. Topologierückbau wäre ein eigener Migrationsauftrag.

Ein eingefrorener Record erhält eine feste Identität und Prüfsumme. Ungewisser
Commit wird mit demselben Inhalt wiederholt, widersprüchliche Identitäten werden
nicht überschrieben. Minutenmodus quittiert MQTT **nach begrenzter RAM-Aufnahme**,
nicht erst nach dem Minutencommit. Crash oder Stromausfall können offene RAM-Daten
verlieren. Der bisherige Rawmodus behält seine Commit-vor-ACK-Semantik. Retained
ist kein Replay, weder Modus verspricht lückenlose Wiederherstellung.

## Aufbewahrung

`STORAGE_RETENTION_MINUTE_DAYS`, `STORAGE_RETENTION_HOUR_DAYS` und
`STORAGE_RETENTION_DAY_DAYS` sind getrennte Aufbewahrungsfristen in Tagen.
`0` bedeutet unbegrenzt und ist der Default; keine Löschung ohne aktive Frist.
Die Minutenfrist umfasst auch Legacy-Rohbeobachtungen und Empfangsereignisse.
Eine endliche gröbere Stufe darf nicht kürzer aufbewahren als ihre feinere Stufe.

Bereinigung ist ausschließlich auf eigene EVSE-Tabellen und die konfigurierte
Quelle begrenzt, in kleinen Transaktionen. Strompreise, Anbieter und fremde
Quellen werden nicht angefasst. Behaltene Elternaggregate dürfen nach dem
Entfernen ihrer Kinder nicht aus einer leeren Kindermenge neu berechnet werden.
Gelöschte Werte lassen sich durch spätere Verlängerung der Frist nicht zurückholen.

Bei zwei Quellen ergeben sich maximal 2.880 reguläre Minutenrecords pro Tag
statt ungefähr 86.400 Zwei-Sekunden-Messrecords; Ereignisse und Verdichtungen
kommen hinzu. Das ist keine Byte-/Festplattenplatzgarantie. Backups separat
planen. InnoDB gibt gelöschte Seiten normalerweise zur internen Wiederverwendung
frei; die physische Datei muss dadurch nicht kleiner werden. Kein automatisches
`OPTIMIZE TABLE`, kein Datenbankneustart oder Volumeaustausch.
