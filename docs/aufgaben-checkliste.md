# EVSE-Control – Aufgabencheckliste

**Status:** Umsetzung mit „Start“ freigegeben, Ausgangsstand `cbf15d4`. Begonnene Änderungen sind kein Abnahmenachweis.

## Arbeitsweise

- [x] **P00 – Auftrag erfassen und in delegierbare Pakete zerlegen.** Diese Datei ist die maßgebliche Liste für den Gesamtauftrag. Nach einem Kontextwechsel hier und bei den offenen Nachweisen fortsetzen.
- [x] **P01 – Ausgangscode sichern.** `656ee43` (vor den ersten WIP-Änderungen) bleibt in der Historie von `origin/main`; `cbf15d4` (Ausgangspunkt der Fortsetzung) zusätzlich im lokalen Branch `backup/fortsetzung-cbf15d4`. Beide Stände sind per Commit-ID wiederherstellbar, ohne den Arbeitsbaum zurückzusetzen.
- Der Projektinhaber bestimmt den Arbeitsstil; abweichende Arbeitsstilvorgaben nicht ungefragt übernehmen. Selbstständig arbeiten, unabhängige Pakete parallel an so viele Subagents wie sinnvoll verteilen. Effizienz vor einer festen Agentenzahl oder Tokenersparnis.
- Keine Zwischenberichte. Rückfragen vermeiden: Nur zu Beginn oder bei späteren Blockern, die nicht warten können; alle übrigen unvermeidbaren Fragen bis zum Schluss sammeln.
- Jedes Kästchen erst nach Umsetzung **und** Prüfung abhaken. Direkt am Punkt Commit, Tests oder Sichtnachweis ergänzen. Fehlt ein Nachweis oder scheitert ein Test, bleibt der Punkt offen und erhält einen kurzen Vermerk.
- Git-Identität vor jedem Commit mit dem tatsächlich verwendeten Repository-SSH-Key abgleichen. Kein Push auf `main`. Teil-PRs sind nur für GitHub-Tests zulässig: nicht reviewen lassen, nicht auf Reviews warten und nicht als Abschluss zählen. Am Ende genau **ein Gesamt-PR** zur Review.
- So viel wie möglich in Docker/GitHub-CI mit realistischen Simulationen testen. Kein Pi-Deployment, Flash, Zugriff auf reale Geräte oder echter Schreibauftrag ohne getrennte Freigabe. Bestandsdaten, private Einstellungen und fremde lokale Änderungen erhalten.

### Nachweisgrundlage des integrierten Kandidaten

Produktcode `c60bcad82bfe2121239f5a3763d65d025ada148f`, Ausgangspunkt
`cbf15d4` auf `main`. Seitdem betreffen die Änderungen nach `c60bcad` ausschließlich
isolierte Tests und Dokumentation. Aktuelle Läufe:
[Stack/Boot `0533743`](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/45910328714),
[Web/GUI `ac48c20`](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/45911719752).
Der Projektstand vor den Arbeiten (`656ee43`) bleibt
ebenfalls über die Historie erreichbar. Dokumentationsnachträge getrennt vom
geprüften Produktcode betrachten. Die verlinkten externen Dienste sind **nur
GitHub-Prüfläufe**, keine Verbindung zur Installation.

| Kürzel | Prüfumfang und Nachschlageort |
|---|---|
| [Stack](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/45910328714) | `isolated-ci.sh` (reiner Build, Bestandsplan, Projekte, Profile, Mounts, SQL und Netzausfall), `archive-boot-ci.sh` (installierte Unit, Docker-Kaltstarts, Identitätswechsel). Vorläufe **nicht** als Gesamterfolg zählen: auf [`c60bcad`](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/45908364746) nur Stack grün (Startlimit des Testdaemons), auf [`24936ff`](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/45909290844) nur Boot grün (Stack brach nach dem Disconnect ohne präzise Fehlerzeile ab). `0533743` prüft mit phasenbezogenen Fehlern und ohne Weiterleitung fixturefremder DNS-Anfragen. |
| [Reader](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/45908364763) | Je zehn CTest-Suiten, native Bookworm/Trixie × AMD64/ARM64, Sanitizer-Kern. `automation_test.cpp`, `automation_http_test.py`, `automation_owner_test.py`, `write_test.py`: Politik, Quellen, aktiver Portbesitzer und tatsächliche RTU-Frames auf PTY. |
| [Web](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/45908364669) | Zwei getrennte Builds/Runners: HTTP/PHP, MQTT und PTY in beiden Steuerpfaden; SQL/HOUSE, Settings-Provisionierung, TLS mit vertrauenswürdiger Test-CA, PWA mit Proxy-Ausfall, JS und Chromium. GUI-Matrizen verwenden kontrollierte API-Antworten, nicht echte Hardware. |
| [Storage](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/45908364711) | MariaDB 10.11/11.8.8/11.8, Collector/SQL-Integration und Runtime-Smoke. Unveränderte Datenmodelle und Migrationen. |
| [UART](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/45908364708) / [Firmware](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/45908364705) | UART-Image mit 54 Tests, Broker-/PTY-Pfad und Runtime; ESP32-Sanitizer/Adapter, MIRROR-Watchdog, Xtensa-Build, Artefakte und Flash-CLI **ohne Upload**. |

## A – Archiv und Docker-Betrieb

### A1 – Archivnetz beim Neustart · Host/Boot-Helfer

- [x] Den bekannten Effekt „leere Diagramme nach Neustart“ reproduzieren. Nachgewiesene Netztrennung von unbekannter ursprünglicher Ursache unterscheiden. **Nachweis:** KVM mit gezielt abgezogenem Archivnetz: HTTP-Liveness weiterhin vorhanden; frühere Pi-Ursache nicht belegt.
- [x] Soll-Netz und tatsächliche Verbindung prüfen. Fehlenden Archivanschluss nach Docker-/Hostneustart gezielt absichern; keine Reparatur bei zweifelhafter Container- oder Netzidentität. **Nachweis:** `archive-boot` auf `24936ff` grün: gepinnter Endpoint, Ablehnung von Ersetzung, Konfigurationsabweichung und unklaren Identitäten.
- [x] Isolierten Kaltstart, unveränderten Anschluss, ersetzten Container, geänderte Konfiguration und absichtlich fehlenden Anschluss prüfen. Keine Neuinitialisierung der DB und kein allgemeiner Neustart der Dienste. **Nachweis:** gleicher CI-Job und getrennte KVM-Prüfung auf Produktcode `c60bcad`.
  - Ubuntu-24.04.5-KVM, Docker 29.1.3, Compose 2.40.3: Wegwerfgast nach gezieltem Disconnect ausgeschaltet und mit derselben Disk neu gestartet. Neue Boot-ID, gleiche volle Web-/DB-IDs; Bootjournal `Archiv-Endpunkt im Readback vorhanden (Connect-Exit 0)`. Beide HTTP-Archive anschließend `ok`, identische synthetische Werte +1729 W/−251 W. Auf `c60bcad` mit neu gebauter Website, bytegleich installierter Unit/Helfer und neuer Freigabe wiederholt. Kein Nachweis für die Ursache des ursprünglichen Pi-Neustarts. Reproduzierbare Prüfung: `tests/stack/kvm-cold-boot.sh`.

### A2 – Archivzugriff und Wiederkehr · SQL/API

Zusatzprüfung im KVM-Gast mit finalem Webimage: Web mit **gestoppter** DB
gestartet. `stack up` meldete beide Archivprüfungen negativ; HTTP-Liveness
blieb positiv. Nach verspätetem Start allein derselben Datenbank erschienen
die vorher gespeicherten +1701/−701 W über die lesenden APIs, ohne zweites
`up`, Webneustart oder Migration. Separate Netzwerkfixture: nach Disconnect
beide Antworten HTTP 503/`unavailable` ohne Samples, bei Wiederanschluss `ok`.

- [x] Beim Start und bei verzögert verfügbarer DB echten lesenden Zugriff auf Wallbox- **und** HOUSE-Archiv sicherstellen. Deaktiviert, vorübergehend nicht verfügbar und erfolgreich leer unterscheiden. **Nachweis:** Beide Stackjobs auf `0533743` bestanden; nach spätem DB-Start zusätzlich beide Archivwerte ohne zweite Stack-Aktion gelesen (KVM oben).
- [x] In der Simulation vorhandene SQL-Werte vor und nach Netz-/DB-Ausfall vergleichen. Liveanzeige und Bedienung bleiben unabhängig; keine Löschung, Migration oder Neuaggregation als Reparatur. **Nachweis:** `isolated-ci.sh` auf `0533743`: ursprüngliche IDs, Zeitstempel und Werte +1729/−619 W nach Netztrennung, DB-Ausfall und Projektwiederanlauf per HTTP verglichen. Vorher wieder geöffnet, jetzt mit beiden grünen Jobs geschlossen.

### A3 – Gemeinsamer Start/Stop · Stack-Einstieg

- [x] Ursprünglichen Auftrag „nur noch 1 Docker-Container zum Starten und Stoppen (wie zuvor besprochen)“ als vereinbarten Ein-Befehl-Einstieg umsetzen: **ein Aufruf für Start, ein Aufruf für Stop**. Dienstcontainer bleiben getrennt; kein zusätzlicher Verwaltungscontainer. **Nachweis (`c60bcad`):** `bin/stack.sh up`/`stop`; finaler lokaler Vier-Rollen-Durchlauf mit tatsächlich getrennten Compose-Projekten.
- [x] Start, Stop und Wiederanlauf mit tatsächlich genutzten Projektnamen, Overlays und Profilen prüfen. Volumes und getrennte Portbesitzer erhalten; Broker und MariaDB nicht ersetzen oder stoppen. **Nachweis (`c60bcad`):** KVM/Docker 29.1.3: zweimal vollständiges up/stop, Web+Storage echt, Portbesitzer als inerte Container; DB/Broker mit unveränderten IDs und Startzeiten.

### A4 – Reiner Build und vorbereitete `bin/.env` · Stack-Plan

- [x] Einen gemeinsamen **reinen Build-Befehl** anbieten: keine Projektdienste starten, stoppen oder neu erstellen; ohne reale Geräte testbar. **Nachweis:** Stack-Job auf `c60bcad`: fünf Images in leerem Docker; erneuter Build im laufenden Bestand ohne Identitäts-/Startzeitwechsel.
- [x] `bin/.env` mit sicheren, geheimnisfreien und änderbaren Vorgaben bereitstellen, ohne dass der Betreiber sie manuell anlegen muss. Vorhandene lokale Datei unverändert bewahren; kein produktives Overlay stillschweigend abwählen. **Nachweis:** `bin/stack-plan.example`, atomarer Ersteintrag, privater Plan und `ready yes` vor Start; Ablehnung verändert vorhandenen Plan nicht.
- [x] Frischen und bereits eingerichteten Checkout prüfen: wirksame Auswahl, nicht unterstützte Konfiguration, unveränderte Container und vorhandener Plan. Installation dokumentieren. **Nachweis:** Stack-Job: Auth+History, Projekt-/Profilregeln, ungültiger und leerer Altplan, keine Mount-/Portänderungen; `docs/stack.md`/`docs/installation.md`.

## B – Steuerung und Regelung

### B1 – Manuelle Startseiten-Steuerung · Browser und Control-Vertrag

- [x] Stromentwurf, Übernehmen, Start und Stop auf der Startseite fertigstellen und vereinfachen. Schieberegler sendet nicht von selbst; Stop bleibt bei frischer Bedienverbindung auch ohne Installationsmaximum oder ESP32 erreichbar. **Nachweis (Web `c60bcad`):** `wallbox-control-browser.cjs`, `control-e2e.py` – bewusster Klick, HTTP→Broker→Reader→PTY, Stop bei fehlender Erhöhungsfreigabe.
- [x] Rückmeldung zu erreichbar, gesperrt, gesendet, bestätigt und unbekannt prüfen. ACK, wirksames Limit und tatsächlicher Ladezustand nicht gleichsetzen. Keine Wiederholung unklarer Befehle. **Nachweis (Web `c60bcad`):** `control-http.cjs`, Lost-ACK/kein Retry und `unknown-stop`/`acknowledged-stop` aus den getrennten GUI-Matrizen.

### B2 – Auswählbare Lademodi · Browser und Mode-API

- [x] Manuell, PV und Benutzerdefiniert auf der Startseite auswählbar machen, sobald die jeweiligen Voraussetzungen erfüllt sind. Sonst fehlende Felder oder Dienstkonfiguration konkret nennen und zur passenden Stelle verlinken. **Nachweis (Web `c60bcad`):** `charging-mode-browser.cjs`: native Radioauswahl und korrekte Ziele `#charging-heading`/`#env-heading` bei separaten Fehlerursachen.
- [x] Aktivierung, Ablehnung, ausstehende Readerbestätigung und tatsächlich beobachteten Modus getrennt prüfen. Speichern, Neuladen oder Wiederverbinden aktivieren nichts; Handbedienung und expliziter Stop werden nicht durch eine wartende Moduswahl blockiert. **Nachweis (Web `c60bcad`):** `charging-mode-http.cjs`, Standalone- und integrierter Modebrowser inkl. Guard, Pending, manueller Priorität, keine Aktivierung beim bloßen Laden.

### B3 – Reglerpolitik · Reader-Kern

- [x] Regelungssystem fertigstellen: festgestellte Funktionslücken im Reglerkern und im Reader-Betrieb (B4) beheben und mit Regressionstests absichern. **Nachweis (`c60bcad`):** Reader: geänderter aktiver Plan wird unmittelbar vor I/O erneut geprüft.
- [x] PV-Budget, Phasenzahl, Zählereinschluss, Installations- und Gerätebegrenzung mit Grenzfällen prüfen. Unbekannte Standortparameter und Schwellwerte nicht raten. **Nachweis (`c60bcad`):** Reader: Grenzwertfälle in `automation_test.cpp`, CAP-/Start-Preflight in der Owner-PTY-Fixture.
- [x] Benutzerdefinierte Zeiten, Wochentage, Zeitumstellung, Verzögerungen und Verhalten außerhalb des Fensters prüfen. Verhalten bei Wechsel der Aktivierung, offener Startfreigabe, veralteten Quellen und Uhrfehler abdecken. **Nachweis (`c60bcad`):** Reader: Vienna-DST, Wochentage, Pending/Clock und Schutz-Stop in `wallbox-automation`.

### B4 – Reglerbetrieb und Priorität · Reader-Owner/WriteCore

- [x] Browserunabhängigen Regler über isoliertes HTTP, MQTT und PTY prüfen: jüngste Messung vor Start, Hardwarelimit, manuelle Priorität, Schutz-Stop, Timeout und unklarer Ausgang. **Nachweis (`c60bcad`):** Reader: `wallbox-automation-http`, `wallbox-automation-owner` und `wallbox-write-simulation`.
- [x] Reader bleibt einziger RS485-Portbesitzer. Kein Doppelstart, kein nachträgliches Ausführen abgelaufener Befehle, keine stillen Schreibwiederholungen; bestätigten Protokollausgang nicht als Messwert behandeln. **Nachweis (`c60bcad`):** Reader: Frame-/Auftragszählung, Lost-ACK, Leaseablauf und manuelle Priorität in denselben PTY-Fällen.

## C – Settings und Oberfläche

### C1 – Settings-Struktur · Gruppen und Navigation

- [x] Settings übersichtlicher gruppieren und vereinfachen. Häufige Bedienung von Dienst- und Spezialkonfiguration trennen; passende Zielanker für Einrichtungshinweise erhalten. **Nachweis (Web `c60bcad`):** `/einstellungen`: getrennte Ladeprofile, RFID, Dienst- und Browserdarstellung; Gruppen, Verlinkung und Aufklappen in beiden Chromium-Matrizen geprüft.

### C2 – Info-Symbol und Beispiele · Feld-Komponenten

- [x] Für jede Einstellung ein **kleines i im Kreis** vorsehen. Beim Hovern in wenigen Worten erklären, was die konkrete Einstellung bewirkt; zusätzlich per Tastatur und Touch erreichbar. **Nachweis (Web `c60bcad`):** `settings-ui.js`, `charging-settings-browser.cjs` und `field-help` in hell/dunkel: Hover, Fokus, Touch, sichtbare UID-Hilfe bei 320 px.
- [x] Graue Beispieltexte als echte Platzhalter einsetzen, die beim Eingeben verschwinden. Keine Defaults vortäuschen, keine Secrets oder produktiven Werte in Beispiele übernehmen. **Nachweis (Web `c60bcad`):** `charging-settings-browser.cjs`, Theme-/Settingsbrowser, leeres Feld und anschließende eigene Eingabe; keine Vorgabe oder Secret-Rückgabe.

### C3 – Dynamisches Eingabefeedback · Formulare

- [x] Nach Tippen oder Ändern direkt hilfreiches Feedback geben. Ungültige Werte, ungespeicherte Änderungen, Speichern, Konflikte und Fehler verständlich voneinander trennen. **Nachweis (Web `c60bcad`):** Invalid-Fokus, gesperrte Speichertaste, sichtbarer Konflikt bzw. ungewisser Save in `charging-settings-browser.cjs` und den Settings-Bildmatrizen.
- [x] Leere/unbekannte Werte, Rückgängig und getrennte Speicherabläufe prüfen. Profilentwurf wird nicht durch Speichern aktiviert; `.env`-Änderungen nicht als wirksame Laufzeitkonfiguration ausgeben. **Nachweis (Web `c60bcad`):** Regel- und Env-HTTP-Tests, Provisionierung und echte Browseraktionen: Reload/Konflikt statt blinder Wiederholung, getrennte POSTs, keine Aktivierung/Recreation.

### C4 – Website-Redesign und Text · Gemeinsame Gestaltung

- [x] Kreatives, dynamischeres und professionelles Gesamtbild für alle Seiten gestalten. Gemeinsame visuelle Hierarchie, konsistente Komponenten und sinnvolle Zustandswechsel in Hell/Dunkel prüfen. **Nachweis (Web `c60bcad`):** Beide Bildprüfer: vier Routen × Desktop/Mobil × hell/dunkel; kompakte Zustandskarten, gemeinsame Navigation und klar zugeordnete Aktionen.
- [x] Überflüssige Wiederholungen und nichtssagende Texte entfernen. Handlungshinweise, Fehler, Frische, Messzeit und unklare Auftragsergebnisse sichtbar lassen. **Nachweis (Web `c60bcad`):** Fehler-/Ergebniszeile, Messstatus und einklappbare Details in `layout-browser.cjs`, `wallbox-control-browser.cjs` und den Matrixbildern geprüft.

### C5 – Mobile Website · Layout und Bedienbarkeit

- [x] Navigation, Startseiten-Aktionen, Slider, Settings und Diagnose auf schmalen Ansichten optimieren. Touchflächen, Fokus und vergrößerte Schrift prüfen; nichts darf Stop verdecken oder horizontal aus dem Fenster laufen. **Nachweis (Web `c60bcad`):** `layout-browser.cjs` 320–2560 px, Skiplink-Hittest und reale Stop-Aktion; beide unabhängigen Bildprüfer, zusätzlicher Schriftversuch unten.
  - Ergänzender Chromium-Reflowtest auf `c60bcad`: auf allen vier Seiten bei 320/390 px die tatsächlich texttragenden HTML-Elemente per Test-Styles auf mindestens 20 px vergrößert. Je nach Seite 77–271 vergrößerte Elemente, Dokument nicht breiter als der Viewport; Navigation fokussierbar und Stop am Mittelpunkt unverdeckt. Kein Test einer konkreten Handy-OS-Schrifteinstellung.

### C6 – Mobile Diagramme · Darstellung und Kalender

- [x] Mobile Diagramme mit lesbaren Achsen, Einheiten, Auswahl und Zeitraumsteuerung optimieren. Wallbox, HOUSE, Live und Archiv mit synthetischen Daten prüfen. **Nachweis (Web `c60bcad`):** `charts-browser.cjs`, `history-browser.cjs`, `house-history-browser.cjs`; beide Bildprüfer prüften Daten/Achsen, HOUSE vor den elektrischen Kurven.
- [x] Kalender, 16 bestehende Anzeigepräferenzen, Quellenunabhängigkeit und Datenlücken/NULL/Qualität erhalten. Keine erfundenen Werte oder durchgehenden Zustände, keine unnötigen Renderdurchgänge. **Nachweis (Web `c60bcad`):** JS-/SQL-/Browsertests: Kalender, Präferenzen, individuelle Quellen und echte Barrieren, kein Live-Ersatz bei Archivfehler und keine Renderuhr im Hintergrund.

### C7 – Diagnose · Seite und Datenzuordnung

- [x] Diagnosefelder auf eine eigene Seite verschieben. Diagnose in der tatsächlichen Navigationsreihenfolge vor Settings anordnen, auch mobil und per Tastatur. **Nachweis (Web `c60bcad`):** `layout-browser.cjs`, tatsächliche Links, Fokus und Screenbreiten; `/diagnose` vor `/einstellungen`.
- [x] Roh-/Zustandswerte, Lesefehler und Frische prüfen. Aktive Warnungen und konkrete Auftragsergebnisse dort belassen, wo sie zur Bedienung nötig sind. Diagnose bleibt lesend. **Nachweis (Web `c60bcad`):** Browser/DOM-Assertions und Fehler-/Offline-Matrix: Diagnose ohne Schreibpfad, Warnungen und Persistenz von Bedienergebnissen geprüft.

### C8 – Diebstahlsicherung · Eigenständiges Redesign

- [x] Bedienung der Diebstahlsicherung eigenständig neu gestalten und ihre beiden Aktionen samt Ziel, Nichtverfügbarkeit und ungewissem Ausgang prüfen. Ein Servoziel ist keine mechanische Bestätigung. **Nachweis (Web `c60bcad`):** `esp32-browser.cjs` prüft Lock und Unlock, Touch, beobachtetes Ziel, Timeout und ACK ohne mechanische Bestätigung.
- [x] RFID-Verwaltung und Privacy-Grenzen erhalten. Private, einmalige UID-Eingabe zum Widerruf bleibt möglich; keine UID-Ausgabe oder Ablage in Browser, API-Antwort, Log oder Prüfartefakt. Kein zusätzlicher Hardwarepfad. **Nachweis (Web `c60bcad`):** `esp32-http.cjs`, `esp32-e2e.py`, PTY und Firmwareadapter; private synthetische Eingabe nach Tabwechsel geleert und auf Ergebnis-/UI-Seite nicht wiedergegeben.

## D – Gesamter Code: getrennte Audits

### D1 – Weboverlay · PHP, Browser und PWA

- [x] PHP/HTTP, Browser/Renderer und PWA auf Duplikate, unnötige Arbeit und schwer prüfbare Pfade untersuchen. Messbare oder konkret belegte Verbesserungen mit Regressionstests absichern. **Nachweis (Web `c60bcad`):** `shared.php`: normale Leseabfrage ersetzt Inode nicht, Uhrenfehler wird gespeichert; Timer-/Formatter-/Plotregressionen, TLS/PWA und Offline-Wiederkehr in beiden Webjobs.
  - Befund: Hintergrundintervalle (100/250 ms), Formatter-Neuanlage, Geometrielesungen und Ersetzen des IPC-Inodes bei gewöhnlichen State-Abfragen. Gezielte Regressionen in `frontend.test.cjs`, `smartmeter.test.cjs`, `charts.test.cjs`, `shared.php`.

### D2 – Storage und Archivpipeline · Python/SQL

- [x] Erfassung, Speicherpfade, Archivabfragen und Laufzeitaufwand prüfen und sinnvoll vereinfachen. Daten, Schema, ACK-/Retry- und Abdeckungseigenschaften erhalten. **Nachweis:** Statischer Audit unten; unveränderte Storage-Pipeline, Docker-Matrix [45908364711](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/45908364711) auf `c60bcad` vollständig grün.
  - Separater Audit von Intake, Commit-/Retry, Offene-Minuten-Publikation, Rollup-Generationen und Retention: kein belegter Grund für Änderungen am Datenpfad oder SQL-Schema. Laufzeitmatrix separat unter E1.

### D3 – Reader, UART und Firmware · Je ein eigener Prüfauftrag

- [x] Reader-Code außerhalb der Regelarbeit auf unnötige Komplexität und Arbeit prüfen und sinnvolle Vereinfachungen absichern. **Nachweis (`c60bcad`):** Reader-Matrix und statischer Audit unten; kein belegter Anlass, Decoder/Publisher umzubauen.
  - Separater Review von Telemetrie, MQTT und ControlChannel samt Owner/WriteCore. Begrenzte Queues, explizite Vorprüfungen und I/O-Trennung beibehalten; kein weiterer belegter Umbau.
- [x] UART-Brücke und Gateway separat auf Wiederholungen, Leerlauf und Frische-/Deadline-Verhalten prüfen; gezielte Verbesserungen gegenprüfen. **Nachweis:** EOF/Leerzeile, Frist/Verbindung nach blockierendem Read, PTY und Broker in [45908364708](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/45908364708), `c60bcad`.
- [x] ESP32-Firmware separat auf unnötige Arbeit und Komplexität prüfen; native Simulation, Artefakte und Build ohne Upload. Unveränderte Bereiche mit Begründung festhalten statt blind umzubauen. **Nachweis (`c60bcad`):** Firmware-Job: neue Adapterregression für MIRROR-Frist; bewährte NVS-/Servoziel- und UID-Pfade nicht verändert.

### D4 – Infrastruktur und Testcode · Compose, Build, CI

- [x] Stack-/Compose-Code, Buildkonfiguration und Tests auf unnötige Dopplung prüfen. Vereinfachen, ohne Varianten, echte Assertions oder fehlerhafte Läufe zu verdecken. **Nachweis:** `compose_for` teilt die explizite Datei-/Profilwahl für Modell, Build und Laufzeit. `rasppi/.dockerignore` begrenzt den UART-Buildkontext. Stack-Job auf `c60bcad` grün; instabile Mount-Reihenfolge als sortierte Menge *aller* Einträge vergleichen. Separat `archive-boot` auf `24936ff` grün (Fehlerbild und Korrektur oben).

## E – Abschluss: erst nach Integration

### E1 – Gesamter hardwarefreier Testlauf · Parallelisierbare Testgruppen

- [x] Operatorablauf, Build-only, Start/Stop, Boot, Archivnetz und SQL-Wiederkehr im isolierten Docker-/VM-Test prüfen. **Nachweis:** Stack/Boot `45910328714` komplett grün. Zusätzlich dieselbe KVM-Disk kalt gestartet, Vier-Rollen-Plan zweimal gestartet/gestoppt und verspäteten DB-Start geprüft – siehe A1–A4.
- [x] Weboverlay vollständig prüfen: PHP/JS, SQL/HOUSE, TLS/PWA, Browser und beide simulierten Steuerpfade. Vorherigen fehlgeschlagenen Web-CI-Lauf untersuchen und den finalen Stand in **beiden** Web-Jobs bestätigen. **Finaler Nachweis:** [45911719752](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/45911719752), Checkout `ac48c2017de471f9c8dcde6d9dcb12b8abc5a861`: [docker](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/45911719752/job/140221416881) und [unabhängiger Web-/GUI-Job](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/45911719752/job/140221416554) abgeschlossen mit `success`, real per GitHub-API abgeglichen. Beide vollständigen Workflows einschließlich integrierter Steuerpfade, SQL/HOUSE, TLS/PWA, Provisionierung und Runtime bestanden.
  - Job `140153165232` aus `45890946168`: Buildtest `tests/integration.cjs:396` beim zweiten Broker-Wiederanlauf; der MQTT-Subscriber beendete sich, der Supervisor stoppte Apache. Der Log nennt keine Exceptionursache. **Nicht** der ESP32-Pfad. Neuerer Ausgangsstand `cbf15d4`: Weblauf `45901462337` grün, Bootjob `140187980676` rot. Das ist noch kein Abschlussnachweis.
  - Untersuchung und Abgrenzung: Die ursprüngliche Exceptionursache bleibt unbelegt; `worker.php` protokolliert nun ausschließlich feste, geheimnisfreie Fehlerkategorien. Kein behaupteter kausaler Fix für einen unbekannten Fehler. Beide späteren vollständigen Webjobs auf Produktcode `c60bcad` sowie beide finalen Jobs auf `ac48c20` bestanden, einschließlich Broker-Wiederkehr. Seit `c60bcad` nur Test-/Dokumentationsänderungen, keine zusätzliche Produktcodeabweichung.
- [x] Storage-Matrix mit vorhandenen MariaDB-Versionen ausführen. **Nachweis:** [45908364711](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/45908364711), `c60bcad`: 10.11, 11.8.8 und 11.8 einschließlich Runtime ohne DB.
- [x] Reader-/Regler-Matrix samt Sanitizern sowie PTY-, Timeout-, Recovery- und Stop-Fällen ausführen. **Nachweis (`c60bcad`):** Reader: alle vier nativen Jobs grün, je zehn CTest-Suiten und Sanitizer-Kern.
- [x] UART-Gateway, Firmware-Simulation und ESP32-Zielbuild ohne Upload ausführen. **Nachweis (`c60bcad`):** UART (54 Fälle) und Firmware einschließlich gespeichertem Artefakt; beide Workflows grün.

### E2 – Zweifache Weboverlay- und GUI-Abnahme · Unabhängig delegieren

- [x] **Durchgang 1:** Übersicht, Diagramme, Diagnose und Settings auf Desktop und Mobil in Hell/Dunkel am integrierten Build prüfen. Bedienung, Live/Archiv, Status und Einstellungen in Screenshots und Interaktionen beurteilen. **Final:** [Artefakt 15161167062](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/45911719752/artifacts/15161167062), `ac48c20`, 16 erfolgreiche Zellen/68 PNGs; eigener vollständiger Build im Job `140221416881`.
- [x] **Durchgang 2:** Separat dieselben vier Seiten auf Desktop und Mobil prüfen, mit Schwerpunkt auf Leer-/Fehler-/Offlinefällen, Touch/Tastatur/Fokus, abgeschnittenen Inhalten und sichtbarem Feedback. Screenshots erneut tatsächlich ansehen, nicht nur das Vorhandensein von Artefakten prüfen. **Final:** [Artefakt 15161366204](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/45911719752/artifacts/15161366204), gleicher Checkout, 16 erfolgreiche Zellen/68 PNGs; eigener vollständiger Build im Job `140221416554`.
  - Zwei unabhängige Sichtprüfer haben jeweils **beide** finalen lokalen Matrizen tatsächlich angesehen: je 136 PNGs auf 32 geöffneten Kontaktbögen sowie kritische Einzelbilder. Beide berichten keine neuen sichtbaren Layoutblocker. Das helle Desktop-Archiv ist jetzt 1440×2057 vollständig: Haus, Wirkleistung, Strom/Limit, Phasenspannungen und Sessionenergie einschließlich Achsen/Fußtexten und abschließendem Messdatenblock. Die frühere abgeschnittene Aufnahme ist ausdrücklich **nicht** akzeptiert.
  - Konkrete übereinstimmende Beobachtungen: Diagnose bis Buchsenverriegelung vollständig; Fehlerpass ohne erfundene Archivkurven; Skiplink und Tastaturfokus sichtbar; Invalid-Meldungen bei 320 px innerhalb der Karten; mobile UID-Hilfe vollständig, knapp am unteren Viewportrand; ACK ohne Ladebestätigung, unbekannter Stopausgang und unklarer Speicherstand lesbar. Interaktionen (echte Tab-/Enter-/Touchaktionen, keine unbeabsichtigten POSTs) zusätzlich durch die Browserassertions in beiden grünen Jobs belegt.
  - Lokale Sichtprüfung und gehostete Ausführung getrennt: Beide Prüfer führten keinen eigenen Docker-Neulauf aus. Die zwei GitHub-Jobs bauten unabhängig denselben Stand; beide heruntergeladenen Manifeste bestätigen SHA, 16/16 Zellen und je 68 PNGs. Der Koordinator sah zusätzlich das **gehostete** helle Desktop-Archiv (1440×2057, alle fünf Gruppen) und das dunkle mobile 320-px-Fehlerarchiv (explizit nicht verfügbar, keine Ersatzkurven) tatsächlich an. Kein Hardware-/Handynachweis.
  - Lokale Vorprüfung am UI-Code `c0582f5`: zwei getrennte Prüfer haben die beiden 60-PNG-Matrizen ausgewertet. Skip-Link, ungültigen Regelentwurf, Kalendermodus und mobile Feldhilfe korrigiert. Weitere tatsächliche Bildprüfung an `0ad067d`: UID-Hilfe lag bei 320 px unter dem Viewport; auf `c60bcad` korrigiert, Sichtbarkeit zusätzlich im echten Browser geprüft.
  - Zwei weitere Sichtprüfer sahen je 68 PNGs auf `c442c4f`, einschließlich sichtbarem Tastatur-Skiplink und modelliertem Lesefehler. Das helle Desktop-Archivbild des ersten lokalen Durchgangs war unten abgeschnitten; der zweite Durchgang hatte keinen solchen Befund. Deshalb auf `ac48c20` die Daten beider Quellen vor diesem Bild abwarten und die gespeicherte PNG-Höhe jedes Fullpage-Bilds gegen das Dokument prüfen. Keine zusätzliche Bedienaktion zur Bilderzeugung.

### E3 – Zusätzliche Vollständigkeitsprüfung · Nach dem Abhaken

- [ ] **Erst wenn sämtliche Arbeits- und Prüfkästchen P00 bis E2 abgehakt sind**, den Gesamtstand nochmals unabhängig prüfen. Die ursprüngliche Aufgabenstellung samt Ergänzungen Punkt für Punkt gegen die tatsächliche Umsetzung und ihre Nachweise am finalen Stand abgleichen. Ein Haken allein ist kein Nachweis.
- [ ] Befunde mit fehlendem oder ungültigem Nachweis wieder öffnen, beheben, nachtesten und die Vollständigkeitsprüfung wiederholen. Gibt es keine Befunde, diesen Schritt als erledigt dokumentieren. Simulatorergebnisse, reale Hardwaregrenzen und offene Standortangaben klar unterscheiden.

### E4 – Ein Gesamt-PR zur Review · Schlussübergabe

- [ ] Erst nach bestandener Vollständigkeitsprüfung E3 **genau einen Gesamt-PR zur Review** bereitstellen und die Nachweise dem PR-Stand zuordnen. Eventuelle Teil-PRs bleiben reine Testläufe und stehen nicht zur Review. Kein Review abwarten und kein Merge im Auftrag enthalten.

## Delegation ohne Dateikonflikte

1. **Parallel starten:** A1 (Boot), A2 (Archiv-Backend), A3/A4 (ein Owner für den Stack-Einstieg), B1 (manueller Client), B2 (Modus-Client/API), B3 (Reglerkern), B4 (Reader-Owner), C1 (Settings-Struktur), C2 (Feldkomponenten), C3 (Formularlogik), C4 (gemeinsames Design und Texte), C5 (mobiles Layout), C6 (mobile Chart-Komponenten), C7 (Diagnose), C8 (Diebstahlsicherung). D1–D4 können parallel zunächst lesend prüfen; D3 in Reader, UART und ESP32 teilen.
2. **Gemeinsame Dateien nur einmal vergeben:** A3 integriert A4 in `bin/stack.sh`. Je ein Owner integriert Änderungen an Startseiten-/Settings-Markup, globalem Stylesheet, Router, Service Worker und gemeinsamen Browser-Fixtures. Andere Pakete liefern separat abgrenzbare Dateien, Komponenten oder Änderungsvorschläge. Für D-Pakete keine parallelen Schreibzugriffe auf aktive Feature-Dateien.
3. **Handoff:** Jedes Paket liefert Prüfkriterien, betroffene Dateien, Testnachweis und verbleibende Grenzen. Integration folgt den Abhängigkeiten A1/A2 → Boot-/Archivtest, B1/B2/B3/B4 → Steuerpfadtest sowie C1–C8 → beide GUI-Prüfungen. E1 und E2 laufen auf demselben finalen Code-Stand parallel. Sobald alle Arbeits- und Prüfkästchen abgehakt sind, folgt E3; erst danach wird der Gesamt-PR in E4 bereitgestellt.

## Deckungsabgleich mit dem erneuten Originalauftrag

| Originalpunkt | Arbeitspakete |
| --- | --- |
| 1. Diagramme nach Hardware-Neustart | A1, A2, E1 |
| 2. Steuerelemente Startseite fertigstellen | B1, E2 |
| 3. Regelungselemente Startseite auswählbar machen | B2, E2 |
| 4. Regelungssystem fertigstellen | B3, B4, E1 |
| 5a. Übersichtlichkeit Settings | C1 |
| 5b. Kurze Erklärung beim Hover, kleines i im Kreis | C2 |
| 5c. Graue, beim Eingeben verschwindende Beispiele | C2 |
| 5d. Dynamisches Feedback nach Eingabe | C3 |
| 5e. Settings vereinfachen | C1, C3 |
| 6. Gemeinsam starten/stoppen wie besprochen | A3 |
| 7. Mobile Website und mobile Diagramme optimieren | C5, C6 |
| 8. Steuerelemente vereinfachen | B1, C5 |
| 9. Unnötigen Website-Text entfernen | C4 |
| 10. Eigener Diagnose-Tab über Settings | C7 |
| 11. Diebstahlsicherung neu gestalten | C8 |
| 12. Professionelles, kreatives und dynamischeres Website-Redesign | C4, C5, E2 |
| 13. Gesamten Code optimieren/vereinfachen; vorher Wiederherstellung sichern | P01, D1–D4 |
| 14. Gesamttest und zwei Weboverlay-/GUI-Prüfungen | E1, E2 |
| Ergänzung: reiner Build mit einem Befehl, vorbereitete `bin/.env` | A4 |
| Arbeitsauftrag: Autonomie, Rückfragen, Delegation, Kontext, SSH-Identität, Test-PRs und genau ein Gesamt-PR | Arbeitsweise, P00, E4 |
| Ergänzung: nach vollständigem Abhaken erneut prüfen, ob wirklich alles abgeschlossen ist | E3 |
