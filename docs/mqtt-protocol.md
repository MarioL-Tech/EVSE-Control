# MQTT-Vertrag: Wallbox-Telemetrie

Der Reader veröffentlicht Messwerte über den vorhandenen Broker. Er empfängt
**keine Steuerbefehle**. Das [lesende Weboverlay](../rasppi/weboverlay/README.md)
abonniert beide Topics; der [MariaDB-Collector](../rasppi/storage/README.md) archiviert
sie unabhängig davon. Das ESP32-UART-Gateway bleibt separat geplant;
ein eigenes Home-Assistant-Modul ist nicht mehr vorgesehen.
Topic-Präfix standardmäßig `evse/wallbox`, konfigurierbar.

| Topic | Payload | QoS | Retained |
|---|---|---|---|
| `evse/wallbox/state` | JSON-Sample, `schema_version=1` | 1 | ja |
| `evse/wallbox/availability` | `online` oder `offline` | 1 | ja |

Nur **ein aktiver Publisher pro Topic-Präfix**; Client-IDs müssen für mehrere
Reader eindeutig sein. Standard-Client-ID: `evse-wallbox-reader`. QoS 1 kann
Nachrichten doppelt liefern; die Payload ist ein Snapshot, kein Zähler-Event.

## State

Payload entspricht der bisherigen JSON-Zeile auf stdout:

- `schema_version`: derzeit 1.
- `device`: `abb_terra_ac`.
- `timestamp`: Mess-/Fehlerzeitpunkt in UTC, nicht MQTT-Zustellzeit.
- `status`: `ok` bei erfolgreichem Read, sonst `error`.
- `last_success_at`: letzter erfolgreicher Read oder `null`.
- `values`: dekodierte Messwerte bei Erfolg, sonst `null`.
- `error`: Kommunikationsfehlertext oder `null`.

Messwertfelder und Einheiten:

| Feld in `values` | Bedeutung |
|---|---|
| `error_code` | Wallbox-Fehlercode; 0 = kein gemeldeter Fehler |
| `socket_lock_state` | roher Wallbox-Lockstatus, nicht der ESP32-Servo |
| `charging_state_raw`, `charging_state` | Rohwert und IEC-Zustandszuordnung |
| `below_commanded_current` | Reduktionsflag aus dem Ladezustandsregister |
| `plugged_in`, `charging` | getrennte boolesche Aussagen; bei unbestimmtem Zustand `null` |
| `current_limit_a` | Wallbox-Limit in A, nicht verfügbarer Gebäudestrom |
| `current_a` | drei Phasenströme in A, Reihenfolge L1/L2/L3 |
| `voltage_v` | drei Phasenspannungen in V; L-N/L-L abhängig von Wallbox-Konfiguration |
| `active_power_w` | Wirkleistung in W |
| `session_energy_wh` | Sessionenergie in Wh |

Ein `ok`-Sample oder `online` ist **keine Ladefreigabe** und kein Nachweis
fehlerfreier Wallbox-Hardware. Wallbox-Fehlercode und tatsächlichen Ladezustand
separat darstellen. Details: [Registerdekodierung](../rasppi/wallbox/README.md#register-und-interpretation).

## Availability und Frische

- `online`: MQTT verbunden und letzter Modbus-Read erfolgreich und frisch.
- `offline`: noch kein erfolgreicher Read, Readfehler, zu alter Snapshot oder Shutdown.
- Frischegrenze: `max(5000 ms, 3 × Pollintervall + Antworttimeout)`, standardmäßig 7 s.
- Retained Last Will `offline` bei unerwartetem Abbruch/Verbindungsverlust.
  Keepalive 15 s; bei stiller Netztrennung ist Offline-Erkennung nicht sofort garantiert.
- Geordnetes Beenden versucht die retained Offline-Meldung vor DISCONNECT zu bestätigen.

**Consumer müssen Availability UND Samplezeitpunkt berücksichtigen.** Retained
State bleibt nach Shutdown/Brokerausfall erhalten und ist nicht automatisch
aktuell. Auch eine nach Brokerneustart wiederhergestellte Online-Meldung darf
alte Daten nicht als frisch darstellen. Auf Zeitstempel achten, bei Offline/
veralteten Daten „unbekannt“ anzeigen; einen alten Anschlusszustand nicht als
aktuell oder als `false` interpretieren. Keine atomare Zustellung beider Topics
voraussetzen: State und Availability sind zwei separate Nachrichten.

## Ausfälle und Reconnect

Broker-/DNS-Arbeit läuft im Hintergrund, Modbus und stdout laufen weiter.
Bei aktivem Publisher ist stderr nichtblockierend: bei voller Docker-Logpipe
können Diagnosezeilen entfallen, statt den gemeinsamen Sample-Mutex zu blockieren.
Nur der neueste Snapshot wird gespeichert; maximal eine Zweiergruppe ist
ausstehend. Bei Ausfall gibt es **keinen historischen Replay-Backlog**. Reconnect
veröffentlicht den neuesten verfügbaren Snapshot; Zwischenwerte gehen verloren.
Retries mit begrenztem Backoff bis 30 s, ACK-/Verbindungsdeadline 3 s.
DNS-Auflösung findet ebenfalls außerhalb des Modbus-Threads statt. Eine
blockierende OS-DNS-Auflösung kann dennoch das geordnete Beenden verzögern;
die Compose-Stopfrist von 20 s ist kein garantierter DNS-Timeout. Bei nötigem
SIGKILL greift die Broker-Will-Erkennung, nicht eine erfolgreiche Shutdown-ACK.

Einmalmodus wartet kurz auf ACKs. Sein Exitcode beschreibt **Modbus**, nicht
MQTT: Ein erfolgreicher Read ohne Broker kann Exitcode 0 liefern. Warnung und
Subscriber-Empfang prüfen. QoS-ACKs bestätigen außerdem keine UI-Zustellung;
ACLs und Empfang auf den tatsächlichen Topics mit einem Subscriber testen.

## Historische Speicherung

Der Collector speichert Originalmesszeit und Empfangszeit getrennt. Alte retained
Samples dürfen ins Archiv, aber nicht daraus als aktuell dargestellt werden.
Identische normalisierte State-Snapshots werden pro Präfix dedupliziert; gleiche
Zeitmarke mit anderen Werten bleibt erhalten. Schema 1 hat keinen Sequenzzähler:
zwei identische Reads in derselben Sekunde sind nicht unterscheidbar.

Availability ist eine Beobachtung ohne Gerätezeitstempel. Wiederholte `online`-
Nachrichten sind keine neuen Ladesessions oder sicher zeitlich zuordenbare Übergänge.
Die beiden Topics sind weiterhin nicht atomar. Collector-Start/Gaps markieren
unbekannte Aufzeichnungsabdeckung; DB-Ausfall/Queue-Überlauf/Restart können Reads
verlieren. MQTT-QoS 1 und manuelle ACKs nach SQL-Commit sind **keine End-to-End-
Verlustfreiheitsgarantie**; Publisher/Broker stellen keine vollständige Historie bereit.

## Netzwerk und Zugang

Vorhandener Broker auf externem Docker-Netzwerk `evse-mqtt`, Alias `mqtt-broker`,
Port 1883. Kein zweiter Produktionsbroker. Passwort optional über lokale
Umgebung oder bevorzugt read-only gemountete Datei. Keine Secrets in Git/CLI-
Argumenten oder Chat. TLS wird in diesem Schritt nicht implementiert; nur im
vertrauenswürdigen Docker-Netz betreiben, keine ungeschützte Internetanbindung.

Einrichtung und Empfangstest: [Installationsguide](installation.md#5-vorhandenen-mqtt-broker-wiederverwenden).
