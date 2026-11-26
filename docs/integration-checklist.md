# Integrationsauftrag: Bedienung, Betrieb und Prüfung

Ausgangspunkt `e83f9f6` bleibt über die Git-Historie wiederherstellbar. Ziel ist ein Gesamt-PR, kein Merge oder Deployment. Diese Liste hält den Auftrag auch bei einem Kontextwechsel fest. Ein Eintrag ist kein Testnachweis.

- Archiv nach Neustart/Neuerstellung: konfigurierte und tatsächliche DB-Netzmitgliedschaft und lesende Archivantwort prüfen. HTTP-Liveness nicht von MariaDB abhängig machen.
- Ein gemeinsamer Start-/Stoppeinstieg für getrennte Projektdienste; vorhandene Broker, MariaDB, Volumes, private Konfigurationen, Profile und einzelne Hardwareport-Besitzer erhalten.
- Übersicht: manuelle Bedienelemente sowie Moduswahl, tatsächliche Reglerausführung und Feedback fertigstellen. Keine Freigabe aus fehlenden Phasen-, Topologie-, Geräte- oder Installationswerten ableiten. Stop, unbekannte Ausgänge und Keine-Wiederholung erhalten.
- Settings vereinfachen: verständliche Gruppen, kleines eingekreistes i (Hover, Fokus und Touch), echte Beispiel-Platzhalter und unmittelbares, wahrheitsgemäßes Feedback. Speichern ist nicht Aktivieren.
- Professionelles responsives Design, mobile Diagramme, weniger Wiederholungen, vereinfachte Steuerung und neu gestaltete Diebstahlsicherung. Fehler, Frische und Grenzen sichtbar lassen.
- Eigener Diagnose-Tab vor Settings, keine doppelten Steuerpfade oder Diagnosewerte erfinden.
- Optimierungen nur nachvollziehbar und mit Regressionstests; keine Änderungen an Bestandsdaten. Abschließend alle Komponenten in Docker/CI prüfen, Web und GUI zweimal kontrollieren, tatsächliche Resultate und verbleibende Hardwarefragen dokumentieren.

### Checks für den Gesamt-PR

`bin/stack.sh` löst die Komponenten-Workflows für Push und PR gemeinsam aus; ohne Änderung am Einstieg gelten weiterhin deren eigene Pfadfilter. Eine normale Änderung unter `docs/` löst nicht die gesamte Matrix aus. Erwartet werden Storage auf drei MariaDB-Versionen, Firmware mit Targetbuild ohne Upload, UART, vier native Reader-Builds sowie zwei vollständige Web-/GUI-Läufe auf getrennten Runnern. Das Web-E2E baut die ESP32-Kerne aus demselben Checkout wie den Gateway. Die separaten Stack-Jobs kommen hinzu.

Die beiden Web-Jobs behalten Docker-/SQL-/TLS-/PWA- und Browserprüfungen bei. Die PWA-Prüfung vergleicht die Bytes im installierten Shellcache mit den statischen Dateien aus dem Checkout. Zur Sichtprüfung beider Läufe dienen `weboverlay-browser-screenshots` und `weboverlay-browser-screenshots-pass-2`; Desktop/Mobil, Feldhilfe, Diagnose und Offlineansicht müssen tatsächlich erzeugt werden. Ein Teilarchiv aus einem fehlgeschlagenen Job ist kein bestandener Test.

| Job | Historische erfolgreiche Jobdauer (Min:Sek) / GitHub-Run | Limit jetzt (Minuten) |
| --- | --- | ---: |
| Web (je Lauf) | 16:19 / `41135320070`; 17:28 / `41134227758` | 35 (vorher 25) |
| Reader (je Job) | 3:07–3:48 / `41135320145` | 15 |
| Storage (je Job) | 1:11–1:12 / `40940945815` | 15 |
| UART | 0:18 / `41135320067` | 15 |
| Firmware | 1:14 / `41135320025` | 25 |

Die historischen Zeiten sind Stichproben aus `started_at` bis `completed_at`, keine Vorhersage für den neuen Code. Ergebnisse und Sichtprüfung des aktuellen PR erst nach tatsächlichen Läufen eintragen.

### Tatsächlich geprüft: isolierte lokale Docker-Gäste, 26.11.2026

| Bereich | Beobachtung am Arbeitsstand |
| --- | --- |
| Start/Stop und Archiv | Beide Stack-Skripte im systemd-Gast mit Docker 29.1.3 und Compose 2.40.3 erfolgreich. Beim Kaltstart wurde genau der verlorene, vorher freigegebene Web-Netzanschluss wiederhergestellt. Separater SQL-Test: synthetischer 1729-W-Wert nach Netzreparatur und Stop/Start weiterhin lesbar; externe DB und Broker liefen weiter. |
| Bedienung und Regelung | Je 10 Reader-Suiten plus Sanitizer-Kern auf AMD64 Bookworm und Trixie; echter HTTP→PHP→MQTT→Reader→PTY-Pfad. Trotz langsamer ungültiger Geräteantwort blieb Stop möglich. Kein Start bei Anschlussverlust, bereits laufender Ladung oder zu kleinem Budget im letzten Read. |
| Storage, UART, Firmware | Je 181 Storage-Tests mit drei MariaDB-Versionen; 48 UART-Fälle; native und simulierte Firmwaretests, Xtensa-Build, vier Firmwareartefakte und Flash-CLI ohne Upload. HTTP→Gateway→PTY→native ESP32-Kerne bestanden. |
| Web und Darstellung | Zwei separate Docker-Gäste für die GUI. Im ersten fiel ein vorzeitig aufgerufener Integrationstest ohne Webserver auf. Nach Trennung der Testphasen: kompletter zweiter Webablauf mit 17/17 Schritten, 207 JS-Tests, elf integrierten Chromium-Suiten sowie SQL/HOUSE und TLS/PWA. Desktop-/Mobilbilder für Bedienung, Kurven, Feldhilfen, Diagnose und Offlineansicht angesehen. |

Das sind keine GitHub-Actions-Läufe, keine native ARM64-Prüfung und keine Pi-/Elektro-/Mechanikabnahme. Der erfolgreiche TLS-Test im Browsernetz beweist nicht die HTTPS-Portveröffentlichung am Host: Der gesonderte Docker-29.1.3-Test zeigte beim nur intern vernetzten optionalen Proxy eine fehlende Veröffentlichung; siehe `docs/stack.md`. Die Ursache des ursprünglichen Pi-Neustarts ist unbekannt. Produktive Phasenzahl und Zählereinschluss bleiben Betreiberangaben, keine aus der UI geschätzten Werte.
