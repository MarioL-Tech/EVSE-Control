# EVSE-Control – Aufgabencheckliste

**Status:** Umsetzung mit „Start“ freigegeben, Ausgangsstand `cbf15d4`. Begonnene Änderungen sind kein Abnahmenachweis.

## Arbeitsweise

- [x] **P00 – Auftrag erfassen und in delegierbare Pakete zerlegen.** Diese Datei ist die maßgebliche Liste für den Gesamtauftrag. Nach einem Kontextwechsel hier und bei den offenen Nachweisen fortsetzen.
- [x] **P01 – Ausgangscode sichern.** `656ee43` liegt in der Historie von `origin/main` und lokal zusätzlich auf `backup/vor-gesamtauftrag-20261126`.
- Der Projektinhaber bestimmt den Arbeitsstil; abweichende Arbeitsstilvorgaben nicht ungefragt übernehmen. Selbstständig arbeiten, unabhängige Pakete parallel an so viele Subagents wie sinnvoll verteilen. Effizienz vor einer festen Agentenzahl oder Tokenersparnis.
- Keine Zwischenberichte. Rückfragen vermeiden: Nur zu Beginn oder bei späteren Blockern, die nicht warten können; alle übrigen unvermeidbaren Fragen bis zum Schluss sammeln.
- Jedes Kästchen erst nach Umsetzung **und** Prüfung abhaken. Direkt am Punkt Commit, Tests oder Sichtnachweis ergänzen. Fehlt ein Nachweis oder scheitert ein Test, bleibt der Punkt offen und erhält einen kurzen Vermerk.
- Git-Identität vor jedem Commit mit dem tatsächlich verwendeten Repository-SSH-Key abgleichen. Kein Push auf `main`. Teil-PRs sind nur für GitHub-Tests zulässig: nicht reviewen lassen, nicht auf Reviews warten und nicht als Abschluss zählen. Am Ende genau **ein Gesamt-PR** zur Review.
- So viel wie möglich in Docker/GitHub-CI mit realistischen Simulationen testen. Kein Pi-Deployment, Flash, Zugriff auf reale Geräte oder echter Schreibauftrag ohne getrennte Freigabe. Bestandsdaten, private Einstellungen und fremde lokale Änderungen erhalten.

## A – Archiv und Docker-Betrieb

### A1 – Archivnetz beim Neustart · Host/Boot-Helfer

- [ ] Den bekannten Effekt „leere Diagramme nach Neustart“ reproduzieren. Nachgewiesene Netztrennung von unbekannter ursprünglicher Ursache unterscheiden.
- [ ] Soll-Netz und tatsächliche Verbindung prüfen. Fehlenden Archivanschluss nach Docker-/Hostneustart gezielt absichern; keine Reparatur bei zweifelhafter Container- oder Netzidentität.
- [ ] Isolierten Kaltstart, unveränderten Anschluss, ersetzten Container, geänderte Konfiguration und absichtlich fehlenden Anschluss prüfen. Keine Neuinitialisierung der DB und kein allgemeiner Neustart der Dienste.
  - Ubuntu-24.04.5-KVM, Docker 29.1.3: Wegwerfgast nach gezieltem Disconnect ausgeschaltet und mit derselben Disk neu gestartet. Neue Boot-ID, gleiche volle Web-/DB-IDs; Bootjournal `Archiv-Endpunkt im Readback vorhanden (Connect-Exit 0)`. Beide HTTP-Archive anschließend `ok`, identische synthetische Werte +1729 W/−251 W. Kein Nachweis für die Ursache des ursprünglichen Pi-Neustarts. Installierte Unit aus `221b860`, `tests/stack/kvm-cold-boot.sh`.

### A2 – Archivzugriff und Wiederkehr · SQL/API

- [ ] Beim Start und bei verzögert verfügbarer DB echten lesenden Zugriff auf Wallbox- **und** HOUSE-Archiv sicherstellen. Deaktiviert, vorübergehend nicht verfügbar und erfolgreich leer unterscheiden.
- [ ] In der Simulation vorhandene SQL-Werte vor und nach Netz-/DB-Ausfall vergleichen. Liveanzeige und Bedienung bleiben unabhängig; keine Löschung, Migration oder Neuaggregation als Reparatur.

### A3 – Gemeinsamer Start/Stop · Stack-Einstieg

- [ ] Ursprünglichen Auftrag „nur noch 1 Docker-Container zum Starten und Stoppen (wie zuvor besprochen)“ als vereinbarten Ein-Befehl-Einstieg umsetzen: **ein Aufruf für Start, ein Aufruf für Stop**. Dienstcontainer bleiben getrennt; kein zusätzlicher Verwaltungscontainer.
- [ ] Start, Stop und Wiederanlauf mit tatsächlich genutzten Projektnamen, Overlays und Profilen prüfen. Volumes und getrennte Portbesitzer erhalten; Broker und MariaDB nicht ersetzen oder stoppen.

### A4 – Reiner Build und vorbereitete `bin/.env` · Stack-Plan

- [ ] Einen gemeinsamen **reinen Build-Befehl** anbieten: keine Projektdienste starten, stoppen oder neu erstellen; ohne reale Geräte testbar.
- [ ] `bin/.env` mit sicheren, geheimnisfreien und änderbaren Vorgaben bereitstellen, ohne dass der Betreiber sie manuell anlegen muss. Vorhandene lokale Datei unverändert bewahren; kein produktives Overlay stillschweigend abwählen.
- [ ] Frischen und bereits eingerichteten Checkout prüfen: wirksame Auswahl, nicht unterstützte Konfiguration, unveränderte Container und vorhandener Plan. Installation dokumentieren.

## B – Steuerung und Regelung

### B1 – Manuelle Startseiten-Steuerung · Browser und Control-Vertrag

- [ ] Stromentwurf, Übernehmen, Start und Stop auf der Startseite fertigstellen und vereinfachen. Schieberegler sendet nicht von selbst; Stop bleibt bei frischer Bedienverbindung auch ohne Installationsmaximum oder ESP32 erreichbar.
- [ ] Rückmeldung zu erreichbar, gesperrt, gesendet, bestätigt und unbekannt prüfen. ACK, wirksames Limit und tatsächlicher Ladezustand nicht gleichsetzen. Keine Wiederholung unklarer Befehle.

### B2 – Auswählbare Lademodi · Browser und Mode-API

- [ ] Manuell, PV und Benutzerdefiniert auf der Startseite auswählbar machen, sobald die jeweiligen Voraussetzungen erfüllt sind. Sonst fehlende Felder oder Dienstkonfiguration konkret nennen und zur passenden Stelle verlinken.
- [ ] Aktivierung, Ablehnung, ausstehende Readerbestätigung und tatsächlich beobachteten Modus getrennt prüfen. Speichern, Neuladen oder Wiederverbinden aktivieren nichts; Handbedienung und expliziter Stop werden nicht durch eine wartende Moduswahl blockiert.

### B3 – Reglerpolitik · Reader-Kern

- [ ] Regelungssystem fertigstellen: festgestellte Funktionslücken im Reglerkern und im Reader-Betrieb (B4) beheben und mit Regressionstests absichern.
- [ ] PV-Budget, Phasenzahl, Zählereinschluss, Installations- und Gerätebegrenzung mit Grenzfällen prüfen. Unbekannte Standortparameter und Schwellwerte nicht raten.
- [ ] Benutzerdefinierte Zeiten, Wochentage, Zeitumstellung, Verzögerungen und Verhalten außerhalb des Fensters prüfen. Verhalten bei Wechsel der Aktivierung, offener Startfreigabe, veralteten Quellen und Uhrfehler abdecken.

### B4 – Reglerbetrieb und Priorität · Reader-Owner/WriteCore

- [ ] Browserunabhängigen Regler über isoliertes HTTP, MQTT und PTY prüfen: jüngste Messung vor Start, Hardwarelimit, manuelle Priorität, Schutz-Stop, Timeout und unklarer Ausgang.
- [ ] Reader bleibt einziger RS485-Portbesitzer. Kein Doppelstart, kein nachträgliches Ausführen abgelaufener Befehle, keine stillen Schreibwiederholungen; bestätigten Protokollausgang nicht als Messwert behandeln.

## C – Settings und Oberfläche

### C1 – Settings-Struktur · Gruppen und Navigation

- [ ] Settings übersichtlicher gruppieren und vereinfachen. Häufige Bedienung von Dienst- und Spezialkonfiguration trennen; passende Zielanker für Einrichtungshinweise erhalten.

### C2 – Info-Symbol und Beispiele · Feld-Komponenten

- [ ] Für jede Einstellung ein **kleines i im Kreis** vorsehen. Beim Hovern in wenigen Worten erklären, was die konkrete Einstellung bewirkt; zusätzlich per Tastatur und Touch erreichbar.
- [ ] Graue Beispieltexte als echte Platzhalter einsetzen, die beim Eingeben verschwinden. Keine Defaults vortäuschen, keine Secrets oder produktiven Werte in Beispiele übernehmen.

### C3 – Dynamisches Eingabefeedback · Formulare

- [ ] Nach Tippen oder Ändern direkt hilfreiches Feedback geben. Ungültige Werte, ungespeicherte Änderungen, Speichern, Konflikte und Fehler verständlich voneinander trennen.
- [ ] Leere/unbekannte Werte, Rückgängig und getrennte Speicherabläufe prüfen. Profilentwurf wird nicht durch Speichern aktiviert; `.env`-Änderungen nicht als wirksame Laufzeitkonfiguration ausgeben.

### C4 – Website-Redesign und Text · Gemeinsame Gestaltung

- [ ] Kreatives, dynamischeres und professionelles Gesamtbild für alle Seiten gestalten. Gemeinsame visuelle Hierarchie, konsistente Komponenten und sinnvolle Zustandswechsel in Hell/Dunkel prüfen.
- [ ] Überflüssige Wiederholungen und nichtssagende Texte entfernen. Handlungshinweise, Fehler, Frische, Messzeit und unklare Auftragsergebnisse sichtbar lassen.

### C5 – Mobile Website · Layout und Bedienbarkeit

- [ ] Navigation, Startseiten-Aktionen, Slider, Settings und Diagnose auf schmalen Ansichten optimieren. Touchflächen, Fokus und vergrößerte Schrift prüfen; nichts darf Stop verdecken oder horizontal aus dem Fenster laufen.

### C6 – Mobile Diagramme · Darstellung und Kalender

- [ ] Mobile Diagramme mit lesbaren Achsen, Einheiten, Auswahl und Zeitraumsteuerung optimieren. Wallbox, HOUSE, Live und Archiv mit synthetischen Daten prüfen.
- [ ] Kalender, 16 bestehende Anzeigepräferenzen, Quellenunabhängigkeit und Datenlücken/NULL/Qualität erhalten. Keine erfundenen Werte oder durchgehenden Zustände, keine unnötigen Renderdurchgänge.

### C7 – Diagnose · Seite und Datenzuordnung

- [ ] Diagnosefelder auf eine eigene Seite verschieben. Diagnose in der tatsächlichen Navigationsreihenfolge vor Settings anordnen, auch mobil und per Tastatur.
- [ ] Roh-/Zustandswerte, Lesefehler und Frische prüfen. Aktive Warnungen und konkrete Auftragsergebnisse dort belassen, wo sie zur Bedienung nötig sind. Diagnose bleibt lesend.

### C8 – Diebstahlsicherung · Eigenständiges Redesign

- [ ] Bedienung der Diebstahlsicherung eigenständig neu gestalten und ihre beiden Aktionen samt Ziel, Nichtverfügbarkeit und ungewissem Ausgang prüfen. Ein Servoziel ist keine mechanische Bestätigung.
- [ ] RFID-Verwaltung und Privacy-Grenzen erhalten. Private, einmalige UID-Eingabe zum Widerruf bleibt möglich; keine UID-Ausgabe oder Ablage in Browser, API-Antwort, Log oder Prüfartefakt. Kein zusätzlicher Hardwarepfad.

## D – Gesamter Code: getrennte Audits

### D1 – Weboverlay · PHP, Browser und PWA

- [ ] PHP/HTTP, Browser/Renderer und PWA auf Duplikate, unnötige Arbeit und schwer prüfbare Pfade untersuchen. Messbare oder konkret belegte Verbesserungen mit Regressionstests absichern.
  - Befund: Hintergrundintervalle (100/250 ms), Formatter-Neuanlage, Geometrielesungen und Ersetzen des IPC-Inodes bei gewöhnlichen State-Abfragen. Gezielte Regressionen in `frontend.test.cjs`, `smartmeter.test.cjs`, `charts.test.cjs`, `shared.php`.

### D2 – Storage und Archivpipeline · Python/SQL

- [ ] Erfassung, Speicherpfade, Archivabfragen und Laufzeitaufwand prüfen und sinnvoll vereinfachen. Daten, Schema, ACK-/Retry- und Abdeckungseigenschaften erhalten.
  - Separater Audit von Intake, Commit-/Retry, Offene-Minuten-Publikation, Rollup-Generationen und Retention: kein belegter Grund für Änderungen am Datenpfad oder SQL-Schema. Laufzeitmatrix separat unter E1.

### D3 – Reader, UART und Firmware · Je ein eigener Prüfauftrag

- [ ] Reader-Code außerhalb der Regelarbeit auf unnötige Komplexität und Arbeit prüfen und sinnvolle Vereinfachungen absichern.
  - Separater Review von Telemetrie, MQTT und ControlChannel samt Owner/WriteCore. Begrenzte Queues, explizite Vorprüfungen und I/O-Trennung beibehalten; kein weiterer belegter Umbau.
- [ ] UART-Brücke und Gateway separat auf Wiederholungen, Leerlauf und Frische-/Deadline-Verhalten prüfen; gezielte Verbesserungen gegenprüfen.
- [ ] ESP32-Firmware separat auf unnötige Arbeit und Komplexität prüfen; native Simulation, Artefakte und Build ohne Upload. Unveränderte Bereiche mit Begründung festhalten statt blind umzubauen.

### D4 – Infrastruktur und Testcode · Compose, Build, CI

- [ ] Stack-/Compose-Code, Buildkonfiguration und Tests auf unnötige Dopplung prüfen. Vereinfachen, ohne Varianten, echte Assertions oder fehlerhafte Läufe zu verdecken.

## E – Abschluss: erst nach Integration

### E1 – Gesamter hardwarefreier Testlauf · Parallelisierbare Testgruppen

- [ ] Operatorablauf, Build-only, Start/Stop, Boot, Archivnetz und SQL-Wiederkehr im isolierten Docker-/VM-Test prüfen.
- [ ] Weboverlay vollständig prüfen: PHP/JS, SQL/HOUSE, TLS/PWA, Browser und beide simulierten Steuerpfade. Vorherigen fehlgeschlagenen Web-CI-Lauf untersuchen und den finalen Stand in **beiden** Web-Jobs bestätigen.
  - Job `140153165232` aus `45890946168`: Buildtest `tests/integration.cjs:396` beim zweiten Broker-Wiederanlauf; der MQTT-Subscriber beendete sich, der Supervisor stoppte Apache. Der Log nennt keine Exceptionursache. **Nicht** der ESP32-Pfad. Neuerer Ausgangsstand `cbf15d4`: Weblauf `45901462337` grün, Bootjob `140187980676` rot. Das ist noch kein Abschlussnachweis.
- [ ] Storage-Matrix mit vorhandenen MariaDB-Versionen ausführen.
- [ ] Reader-/Regler-Matrix samt Sanitizern sowie PTY-, Timeout-, Recovery- und Stop-Fällen ausführen.
- [ ] UART-Gateway, Firmware-Simulation und ESP32-Zielbuild ohne Upload ausführen.

### E2 – Zweifache Weboverlay- und GUI-Abnahme · Unabhängig delegieren

- [ ] **Durchgang 1:** Übersicht, Diagramme, Diagnose und Settings auf Desktop und Mobil in Hell/Dunkel am integrierten Build prüfen. Bedienung, Live/Archiv, Status und Einstellungen in Screenshots und Interaktionen beurteilen.
- [ ] **Durchgang 2:** Separat dieselben vier Seiten auf Desktop und Mobil prüfen, mit Schwerpunkt auf Leer-/Fehler-/Offlinefällen, Touch/Tastatur/Fokus, abgeschnittenen Inhalten und sichtbarem Feedback. Screenshots erneut tatsächlich ansehen, nicht nur das Vorhandensein von Artefakten prüfen.
  - Lokale Vorprüfung am UI-Code `c0582f5`: zwei getrennte Prüfer haben die beiden 60-PNG-Matrizen ausgewertet. Befunde bei Skip-Link, ungültigem Regelentwurf, Kalendermodus und mobiler Feldhilfe; vor der Schlussabnahme korrigieren und erneut prüfen.

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
