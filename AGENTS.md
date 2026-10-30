# Arbeitskontext für Agents: EVSE-Control

Stand: 2026-10-30. Diese Datei beschreibt den geprüften Repositoryzustand und
die vom Projektinhaber genannten Ziele. Geplante Funktionen sind **nicht** als
bereits implementiert zu behandeln. Auf Deutsch kommunizieren.

Aktueller Webbedienauftrag (2026-10-30): PR#64 vom Projektinhaber gemergt.
PR#65 inzwischen ebenfalls vom Projektinhaber gemergt (maina0c828b). Betreiber-
ARM64-Build kompiliert vollständig und besteht6/7Suiten; die neue Python-Probe
lädt durch generische ctypes-Suche jedoch die ungepatchte Systembibliothek.
Hotfix verlangt explizit `/usr/local/lib/libmosquitto.so.1` ohne Fallback;
unabhängige Prüfung tatsächlicher Reader-Mappings/Marker/Grenzwerte bleibt.
Native ARM64-Bookworm-/Trixie-CI plus eager Runtime-Symbolauflösung ergänzt,
Prüfstand des Hotfix-PR prüfen; noch keinen Pi-Neubauerfolg daraus ableiten.
Der gezeigte Buildabbruch belegt weder Containerneustart noch Betriebsstatus;
Websitefolgekommando wurde wegen `&&` nicht ausgeführt. Keine Schreibfreigabe.
Umsetzung in PR#65. Endgültigen Docker-Prüf-/Freigabestand und visuell geprüfte
Artefakte über PR#65 prüfen; nachfolgend dokumentierte Fehler sind Zwischenstände,
kein Ersatz für dessen Abschlussnachweis. Keine reale Schreibabnahme.
Statische Gegenprüfung: HTTP-Ablehnungen dürfen bei `command_sent=false` keinen
unklaren Hardwareausgang vortäuschen. Libmosquitto braucht Empfangsgrenze VOR
Payloadallokation: gepinnte2.0.21 mit kleinem4096-Byte-Patch und zwingendem
Link-/Laufzeitmarker, reine Docker-TCP-/PTY-Regressionen. Keine Produktionsprobe.
Gegenprüfung bestätigt beide statischen P2-Korrekturen, kein Laufzeittestersatz.
Weitere Docker-CI fand realen Authfehlerabsturz (`FATAL: exception not rethrown`):
Controlcallback + erzwungenes pthread_cancel; Controlchannel daher normales
Disconnect/Join ohne Forcedcancel. Authregression dreimal ohne gelockerte Read-
Anforderung. 4096/4097-/64MiB-Präallokationsprüfung auf beiden Debianvarianten
bereits bestanden; Gesamt-CI/Abnahme weiterhin offen.
Code5ac3ff3 besteht Reader41059437073/41059443951, einschließlich dreifachem
Authfehlerfall. Website41059437220/41059444094 besteht neuen echten HTTP-/MQTT-/
PTY-Controlpfad und neue Controlbrowsersuite, scheitert jedoch am alten Drei-
Navigationspunkte-Assert im Historienbrowser. Assert um Wallbox ergänzen, nicht
löschen; finale Gesamt-CI noch erforderlich. Kombinierte Retained-/Stale-
Ablehnung nicht als eigenständigen RETAIN-Bit-Test ausgeben.
Weiterentwicklung jetzt ausdrücklich OHNE Passwort/Login oder zusätzlichen
Freischalter; jeder erreichbare Nutzer im vertrauenswürdigen LAN/VPN darf
manuell bedienen. Login folgt erst zum Schluss. Diese Freigabe ersetzt die
frühere produktive Nichtaktivierbarkeit aus Stufe1, NICHT das Verbot von Agent-
Hardwaretests/SSH/Pi-Deployment. Erster realer Schreibtest später ausdrücklich
über das Weboverlay, nach vorheriger Information der Leitung und gesondertem Go.
Übersicht mit kompakter Start/Stop-/Slider-/Übernehmen-Bedienung, eigener neuer
Tab `/wallbox` für vollständige Details. Angefordert, Protokoll-ACK, wirksames Limit
und tatsächliche frische Messwerte getrennt; Sliderbewegung allein sendet nichts.
Nutzer vermutet16A, bestätigt aber KEINE Installationsgrenze. Keine16-/32-A-
Defaultfreigabe: `WALLBOX_INSTALLATION_MAX_MA` explizit6000..32000 konfigurieren,
Hardwaremaximum aus4006/07 und Firmware-Rohwert4004/05 neu lesen. Stop benötigt
keine stromerhöhende Vorgabe und deshalb kein Installationsmaximum. Fehlende
technische Grenzen verhindern nur Start/Stromvorgabe, keine Auth-Sperre.
Neuer Weg Browser→PHP-ControlHttp/ControlMqttTransport→bestehender Broker→eigener
ControlChannel im bestehenden C++-Reader→libmodbus. Keine neuen Container/Worker
im Produktionsstack, kein SQL-/State-JSON-/Historien- oder Fremddatenumbau.
Clean-Session, QoS0/nicht-retained Befehle, eindeutige IDs, begrenzte Queue/Dedupe,
Reader-Sitzung und einmalige monotone8s-Inspect-Lease verhindern Nachholen/Replay.
Nur Portbesitzerthread führt aus; Callback nie seriell. Start ist explizit zwei
Schritte SetCurrent+Start derselben Webaktion/Lease, beide Ergebnisse erhalten.
Keine Wiederholung bei Timeout/HTTP-Abbruch, unklar bleibt unklar. Frischeinspektion
nach Fehlern read-only, kein altes Write wird nachgeholt. Origin/Host/CSRF bleiben
erhalten (kein Login). `WEB_CONTROL_ORIGIN` erbt explizite Settings-/Compose-Origin;
bei anderem Browserhostname/HTTPS passend konfigurieren. Kein öffentliches Hosting.
PWA v15, Control-API und POST immer network-only/no-store, keine Offlinequeue.
Docker-/Browser-/durchgängige HTTP→MQTT→C++→PTY-Abnahme noch offen. Agentabbrüche
am Codex-Kontingent lieferten keinen Abschluss; auf ausdrücklichen Wunsch mit
openai/gpt-6.1-sol neu gestartet, Änderungen vom Hauptagent prüfen.
Vertrag `docs/wallbox/web-control-contract.md`. Netzbezugs-/Solarautomationen,
Schwellen und echte Hardwaretests bleiben separate Aufträge, keine Werte raten.

Vorheriger Schreibauftrag (2026-10-30, PR#64 gemergt): Nach bestätigter Funktion von PR#63
ausdrückliches Go ausschließlich für **Stufe 1: C++-/libmodbus-Schreibkern und
isolierte Docker-Simulation**, NICHT für reale Writes, Pi-Aktivierung oder
Automationen. Der Projektinhaber muss vor Schreibtests seine Leitung informieren;
Hardwaretest erst nach gesondertem Go, keine Garantie durch Simulatorerfolg.
Manuelle spätere Stromvorgabe ausdrücklich als Schieberegler; „Übernehmen“ ist
der bisherige Interaktionsvorschlag, UI/Bedienanbindung noch nicht implementiert.
Neue `write_core.hpp/.cpp`: typisierte Start/Stop/SetCurrent-Aufträge, bestehender
Reader bleibt einziger Kontext-/Portbesitzer. Unveränderlich deaktivierte Runtime-
Policy, **kein** Env-/CLI-/Compose-/MQTT-/HTTP-/stdin-Aktivierungsweg. Nur separater
Build-Testprobe mit geprüften devpts-Slaves aktivierbar, nicht im Runtimeimage.
FC06 `0x4105`:0 Start/1 Stop; FC16 `0x4100`:zwei MSW-first-UInt32-mA-Wörter.
Explizites Installationsmaximum nötig, kein16-/32-A-Default; konservative Software-
obergrenze32A ist keine Installationsfreigabe. Mindestvorgabe6A, Hardwaremaximum
`0x4006` für jede Strom-/Startanfrage frisch prüfen. Stop eigenständiger Auftrag.
Start erst nach frischem bestätigtem SetCurrent und zulässigem beobachtetem Limit,
passender Vorgabe und erneuter fehlerfreier/bekannter Telemetrie. Vorbereitung
einmalig, auch ungültige/abgelaufene Ersatzversuche verwerfen sie; ursprüngliche
Vorbereitungsfrist bleibt bis zum Start-Senden wirksam. Keine impliziten Writes.
ACK, wirksames Limit und beobachtetes Laden strikt getrennt, unknown bleibt unknown.
Libmodbus3.1.6 prüft High-level-Schreibechos nicht vollständig; deshalb öffentliche
Raw-send/receive-APIs mit Library-Framing/CRC und zusätzlichem komplettem Echo-
vergleich. Genau ein Send je Auftrag, Recovery NONE, keine automatischen Retries,
Kompensationen oder Reconnects. Unklarer Ausgang sperrt Core bis bewusstem Neuaufbau;
spätere Istwerte beweisen keinen Erfolg. Exception5 ist angenommen/in Bearbeitung,
nicht Geräteablehnung. Monotone maximal10s-Deadline, Abbruch/Responsebudget vor I/O;
kein hartes OS-/Treiber-Gesamtzeitversprechen. Neue No-I/O-/PTY-Fehler-/Grenz-/ACK-/
Startfristen-/Recovery-/Shutdownprüfungen; bestehende drei Decoder-/FC03-/MQTT-
Suiten unverändert erhalten. CI jetzt Bookworm/Trixie, Bookworm Produktionsdefault.
Unabhängiger statischer Review fand zwei Startvorbereitungsfehler; korrigiert,
gezielt regressionsabgedeckt und danach gezielt ohne weitere Befunde gegengeprüft.
Codehead ed32b18 besteht Wallbox-Docker41050330438 (Push) und41050371128 (PR)
vollständig: je fünf Suiten mit Bookworm/libmodbus3.1.6 und Trixie/3.1.11 sowie
Runtime-/Nichtaktivierbarkeitsprüfung. Kein Host-, ARM- oder echter Schreibtest.
Finalen Dokumentations-/Freigabestand über PR#64 prüfen; Merge beim Projektinhaber.
Vertrag `docs/wallbox/write-core-contract.md`, Einrichtung zentral dokumentiert;
historische mbpoll-Notizen ausdrücklich keine freigegebene Schreibtestanleitung.
MQTT-Bedienvertrag/Zugriffsschutz, Slider, Netzbezugsabschaltung, Automationswerte
und reale Schreibtests bleiben separate Aufträge; keine Schwellen raten.

Vorheriger Folgeauftrag (2026-10-30, PR#63 gemergt, Funktion vom Nutzer bestätigt): Haus-Netzleistung auf der Diagrammseite direkt
unter die gemeinsame Zeitraumwahl und oberhalb sämtlicher Wallboxdiagramme.
Reihenfolge im echten DOM geändert, keine CSS-Umsortierung/Komprimierung oder
zweite Instanz. Diagnose unten, Status-/Frische-/Fehler und Datenpfade unverändert;
Browser prüft tatsächliche Reihenfolge bei320..2560px. PWA-Shell v13. Codehead
4577675 besteht Web41037745303/41037726231 vollständig (180 JS-Fälle und bisherige
Backend-/SQL-/HTTP-/TLS-/PWA-/Chromium-/Runtime-/Provisioningprüfungen). Simulierte
dunkle Desktop-Liveansicht und helle mobile Hauswochenansicht visuell geprüft:
Hauskurve oberhalb der Wallbox, gleiche Dimensionen, Diagnose unten. Finaler
Prüf-/Freigabestand in PR#63; kein Pi-Deployment.
Nutzer meldet weiterhin unverbundene Diagnosepunkte nach PR#62. Screenshot der
Tagesansicht und privat lokal bereitgestellter API-Auszug nun ausgewertet (kein
Produktionsabruf):136 belegte/288 Intervalle,20120 Messwerte; alle sieben Diagnose-
felder haben136 bekannte, nicht gemischte letzte Werte, keinerlei unknown-last.
16 Intervalle wurden fälschlich zu separaten Beobachtungspunkten:13 mit einzelnen
vorangehenden NULLs,3 ausschließlich groben Qualitätsflags. Reine Qualitätslane
und Marker aus PR#62 haben diesen Nutzerfehler nicht behoben.
Gezielte neue Semantik: Kalenderdiagnose zeigt ausdrücklich **letzte beobachtete
Intervallwerte**, keine dauerhafte Zustandsbelegung. Bekannte, nicht gemischte
letzte Werte bilden schematische Stufen durch benachbarte Intervallmittelpunkte,
auch bei vorherigen Teil-NULLs oder grober Erfassungsqualität. Kein gemessener
Übergangszeitpunkt, keine Zusage, der Zustand habe während einer Aufnahmelücke
bestanden. Qualität bleibt unter der Hauptkurve und in Inspektionslabels erhalten;
letzter Wert NULL, komplett unbekannte/fehlende/leere Intervalle und gemischte
Zustände brechen beide Kanten weiterhin. Mixed mit bekanntem letztem Wert bleibt
isoliert. Keine Bool-/Codemittel, echte false/0 bleiben Werte, keine NULL-Füllung.
Live-/Raw-/Lifecycle-/SQL-Live-/Frischeregeln unverändert. PWA-Shell v14. Synthetische
136-Intervall-Regressionsstruktur und Tagesbrowserprüfung aller sieben Kurven;
private JSON-Datei nicht ins Repository übernehmen. Statische Gegenprüfung ohne
weiteren Datenpfadbefund, zugänglichen Beobachtungstitel auch bei Inspektion erhalten.
Docker-/Bildabnahme und finaler Freigabestand für diese Diagnosekorrektur in PR#63;
keine produktive Pi- oder Hardwareabnahme daraus ableiten.
Keine DB-/Aufzeichnungs-/Steueränderung oder Produktionszugriff durch diesen
Darstellungsauftrag; damaliges fehlendes Wallbox-Go nun ausschließlich durch den
oben begrenzten Simulationsauftrag ersetzt, reale Writes weiter nicht freigegeben.

Vorheriger Darstellungsauftrag (2026-10-30, implementiert; PR#62 gemergt):
Live-/Diagnosekurven auf Abschneiden prüfen, Phasenspannungen auch Live voll
statt gestrichelt; Übersicht/Diagramme wie Settings volle verfügbare Breite.
Überflüssige Wiederholungen kürzen, Status/Frische/Messzeit/Fehler und wichtige
Unknown-/Archivinformationen erhalten. Screenshot23:55 zeigt auch eine innere
Unterbrechung, keinen belegten SVG-Clip: Raw10s-/NULL-/Lifecycle-/Minuten-/SQL-
Live-Barrieren NICHT pauschal lockern. Linken Fensterrand nur mit vorhandenem,
nach denselben Regeln nachweislich verbundenem Vorgänger visuell schneiden;
kein neuer Messwert/Frischenachweis. Diagnosecodes ganzzahlige Achsen mit Platz
für UInt32, Boolwerte niemals mitteln. Gemischte/teilweise/unknown Archivzustände
in separater Qualitätslane unterhalb der Zahlenachse und bekannten letzten Wert
isoliert markieren, niemals einen durchgehenden Zustand oder NULL=Nein erfinden.
Subagents für Analyse und gezielte Browser-/Diagnoseimplementierung verwendet;
Änderungen vom Hauptagent prüfen. PWA-Shell v12. Keine Pi-Aktion/Hardwarewrites.
Zusätzliche statische Gegenprüfung fand unzulässigen Einfluss eines nicht
verbindbaren alten Randvorgängers auf die Y-Skalierung. Korrigiert: nur sichtbare
Werte plus tatsächlicher Schnittwert eines nachgewiesenen Randsegments zählen
zur Skala. Neue Regressionen für Timeout-/Lifecycle-/Produktbarrieren und
verbundenen Rand mit altem Ausreißer. Zusätzliche breite/mobile Live-Diagnose-
und UInt32-Screenshots sowie Kalenderdiagnose zur Sichtprüfung; tatsächliche
Dockerresultate/Abnahme im PR prüfen, keine Produktions- oder ARM-Garantie.
**Wallboxschreiben und Netzbezugs-Abschaltregeln ausdrücklich erst nach weiterem
Go des Projektinhabers**, auch Start/Stop/max.Ladestrom jetzt NICHT implementieren.
Frühere Konfigurationsbeispiele dann wieder heranziehen; keine Schwellen raten.

Vorheriger Folgeauftrag (2026-10-29, implementiert/Docker-geprüft; PR#61 gemergt): Monat maximal ein
lokales Tagesmittel pro Tag, Jahr ISO-Wochenmittel an Jahresgrenzen gekürzt.
Read-only-Projektion vorhandener Stundensummen/Counts, keine DB-Neuverdichtung,
Migration, Rawdatenänderung oder erfundene Null. Stunde bis Jahr als Linien
benachbarter bekannter numerischer Aggregate; einzelne NULL-Beobachtungen löschen
einen existierenden Mittelwert nicht, vollständig unbekannte/leere/fehlende
Intervalle und mehrdeutige Bool-/Codezustände trennen. Custom behält Min/Max.
Nutzer meldet zusätzlich Punkte in Tagesansicht (Screenshot22:15); dieselbe
Korrektur gilt auch dort. Netzbezug/Einspeisung jetzt größer/kräftiger darstellen.
Settingskarten auf ganze verfügbare Browserbreite. Konfigurationseditor ist jetzt
ausdrücklich OHNE Admin-Login freigegeben: Compose durchreichen, config-only
Schreibmount, bewusste Operatorbereitstellung mit Envbackups und Links statt
Scheinkopien. Keine Agent-Pi-/Secretzugriffe. CSRF/Host-/Originprüfung erhalten,
jeder erreichbare Nutzer darf schreiben: nur vertrauenswürdiges LAN/VPN, keine
öffentliche Freigabe. Kein Docker-Socket/Restart/Autorecreate, Speichern≠Anwenden.
Setup ausschließlich Docker, Runtime UID10001/cap-drop. Dedizierte Verzeichnisse
2750/setgid + Env0640 für lesende private Operatorgruppe (Legacytestroot0600).
PWA-Shell v11. Gewünschte unabhängige Modellrecherche scheitert erneut am
Kontingent, null Tools/keine Ergebnisse; keine solche Prüfung behaupten.
Codehead531c8f9 besteht Web40965775294 und40965769367 vollständig:173 JS-Fälle,
80 HOUSE-/bestehende PHP-/SQL-/HTTP-/TLS-/PWA-/acht Chromium-/Runtimeprüfungen,
20 neue reine Provisioningprüfungen plus echter Wegwerf-Operatorablauf inkl.
Backups/Links, atomarem UID10001-Speichern, fortbestehendem Compose-Lesezugriff
und idempotentem Wiederaufruf. Echtes SQL-Schaltjahr aus8784 Stunden liefert53
Wochenbuckets/15.811.200 künstliche Samplecounter, beobachtet1206ms (kein Pi-/ARM-
Versprechen). Tageslinie trotz teilweisen NULLs, mobile Jahreslinie mit53
Intervallen, dunkle Hausjahreslinie, größere Richtung und breite Settings visuell
an simulierten CI-Bildern geprüft. Erneuter Nutzerscreenshot23:30 zeigt weiterhin
Stundenunterbrechungen im bisherigen Produktivstand; PR#61 zu diesem Zeitpunkt
noch nicht gemergt/installiert, daher kein Beleg gegen die neue Korrektur.
Keine Pi-Einrichtung/Backups/Verzeichnisänderung durch Agent. Finalstand über PR#61.

Historischer Fehlerauftrag (2026-10-29, PR#60 gemergt): Stundenarchiv zeigt zunächst nur Punkte,
neuere Intervalle werden ohne Update später Linien (Nutzerscreenshots21:05/21:07,
119 bzw208 Messwerte). Auf ausdrücklichen Auftrag jetzt reine Renderer-
Korrektur: Stunde/Tag/Woche verbinden vorhandene benachbarte Intervallmittel/
letzte Werte unabhängig von groben has_gap-/coverage-/complete-Qualitätsflags.
Die Linie ist ausdrücklich Aggregatinterpolation, KEIN Nachweis lückenloser
Rohmessung. Qualitätsflags/Inspektionslabels bleiben unverändert. Fehlende/leere
Intervalle, feldlokale NULL und gemischte/unbekannte Zustände trennen weiterhin.
Live-/Raw-10s- und Lifecycle-Barrieren sowie Langzeit-Min/Max-Spannen unverändert.
Keine DB-/Aufzeichnungs-/Verdichtungsänderung, Migration oder Refresh. Regression
für119 Messwerte in vier noch qualitätsunsicheren Minuten und stabiles Linienbild
bei nachlaufenden Flagupdates, echte Fehlintervalle/NULL und unabhängige Hauswerte.
Statische Shell v10. Separater Fix-PR#60 baut auf Nullreferenz-PR#59 auf, um diese
kleine Darstellung separat überprüfbar zu halten; dessen Merge bleibt beim Nutzer.
Prüf-/Freigabestand über PR#60. Nullreferenz-PR#59 besteht Web40945782058;
simulierte helle/mobil/dunkle Nullreferenz angesehen, PR ist bereit zur Prüfung.

Aktueller kleiner UI-Auftrag (2026-10-29): dezente Nullreferenz im Haus-
Netzleistungsdiagramm. Separate neutrale1px-Linie mit4/5-Strichelung,55% Deckkraft
und kleinem0-Achsenlabel hinter der Datenkurve, in Live und Archiv. Keine
Messreihe/Nullfüllung, keine Änderungen an Daten, Skalierung, Lücken, API oder
Hardware. Statische Shell v9; Hell-/Dunkel-/Mobil-/Archivprüfungen ergänzt,
Prüf-/Freigabestand über PR#59. PR#58 alsfe0999b gemergt; Nutzer bestätigt nach
Websiteupdate wieder Funktion. Optionales MQTT-Authoverlay scheiterte erneut
an fehlendem MQTT_PASSWORD_HOST_FILE; ohne dieses Overlay funktioniert es laut
Nutzer. Daraus keine Broker-Authentifizierung oder spezifische Envwerte ableiten.

Aktuelle Nachbesserung (2026-10-29, implementiert; Freigabestand PR#58): Zukünftige Kalenderperioden und
benutzerdefinierte Enden nach jetzt in UI UND beiden Historien-APIs sperren;
laufende Kalenderperioden bleiben auswählbar, Next am aktuellen Zeitraum null.
Kalender-SELECTs dürfen nur bereits abgeschlossene vergangene Summaries lesen.
Betreiber-API zunächst239 belegte Tagesintervalle,237 has_gap,3 incomplete,
erste6 coverage_seconds=0. Nutzer stellt ausdrücklich klar: keine erneute
Komprimierung/Verdichtung beauftragt, nur Diagrammdarstellung. Die daraus zuvor
abgeleitete Refresh-Empfehlung ist zurückgenommen; keine Produktionsaktion durch
Agent. Neuer Nutzerscreenshot vom29.10.,20:40 zeigt am rechten Rand bereits
verbundene neuere Werte neben älteren Punkten. Nutzer vermutet letzte Änderung
als Ursache, ohne kausalen Nachweis oder bestätigte Refresh-Ausführung.
Auftrag nun: PR#58 vorbereiten, keine vorschnelle Lockerung der Lückenprüfung.
Begonnene uncommittete Rendererlockerung und Erweiterung auf alle Perioden
vollständig verworfen; bisherige Renderer bleiben unverändert. Bestehender
expliziter Refresh ist nur separate optionale Wartung, keine Diagrammvoraussetzung.
Codehead1ad27a7 besteht Web40940945771/40940936832 und Storage40940945815
auf drei MariaDB-Versionen:171 JS-Fälle,83 PHP-Kalenderfälle,18 Archiv-SQL-/HTTP-
Szenarien,35 Theme-/Settingsfälle und181 Storagefälle je DB-Version. Kalender-/
Lückenbilder aus simulierter CI angesehen; kein Nachweis durchgehender Altwerte.
Aktuellen finalen Dokumentations-/Freigabestand über PR#58 prüfen; Merge nur
durch Projektinhaber. Zusätzlicher Modelltest-Lookup scheiterte am Kontingent,
ohne Toolausführung/Ergebnis; keine zusätzliche unabhängige Prüfung behaupten.

Aktueller Auftrag (2026-10-29, implementiert/Docker-geprüft, Pi-Abnahme offen): Stunde/Tag/Woche sollen
dieselbe einfache Linienoptik wie Live bekommen. Echte Offline-/NULL-/Clock-/
Lifecycle-Unterbrechungen bleiben getrennt; Min-Max-Bänder entfallen in diesen
drei Ansichten. Wallbox- und Hauswerte sollen nur noch minutenweise als
Stichprobenmittel für W/A/V dauerhaft aufgezeichnet werden; Zustände, Limits und
Sessionzähler nicht mitteln. Erfassung/Live bleiben bei zwei Sekunden. Neue
Minutenprodukte brauchen eigene Coverage und explizite additive Migration;
Bestandsrohdaten/Preise/Provider bleiben unangetastet. RAM-Zwischenpuffer kann
bei Crash offene Minuten samt Randkontext verlieren, kein Commit-vor-ACK-Versprechen
für diesen neuen Aufzeichnungsmodus. Legacy-Rawmodus bleibt getrennt.
Minutenpipeline und quellgebundene Bereinigung implementiert und in isolierten
Docker-/MariaDB-Tests geprüft. Drei unabhängige Minutentabellen,
explizites `--migrate-minutes`; bisherige Compose-Deployments bleiben raw bis
bewusster Umstellung. Minutenworker verwenden validierte Captures statt Raw;
kurze SQL-Fenster verwenden nach Cutover ausdrücklich Schema3 mit Intervallen,
Legacyraw bleibt Schema1 und Kalender Schema2. Keine stillen Rohmittelwerte.
Codehead979b148 besteht Web40927845891/40927833069 und Storage40927845966
auf10.11/11.8.8/11.8:168 JS-Fälle,182 PHP-Minuten-/209 Envprüfungen,
zehn neue echte Schema3-SQL-/HTTP-Szenarien,35 Theme-/Settings-Browserfälle
einschließlich aktiviertem synthetischem Editor sowie bestehende SQL-/TLS-/PWA-/
Chromium-/Runtimeprüfungen. Simulierte Desktop-/Mobil-Wochenbilder, Hauskurve
und deaktivierte Settings angesehen. Zusätzlicher finaler Modellreview wegen
Kontingent nicht gestartet; frühere unabhängige Reviews und Korrekturen erhalten,
abschließende eigene statische Prüfung ohne weiteren bestätigten Befund.
Keine Pi-Migration, Retentionlöschung, Schreibmounts oder Produktionsabnahme.
Abschließender Rechteabgleich fand unnötige No-op-UPDATEs bei Minutenregistry/
Cutover: unter bestehenden Advisorylocks durch SELECT und gegebenenfalls INSERT
ersetzt. Neuer echter SQL-Fall mit CREATE/SELECT/INSERT ohne UPDATE prüft explizite
Migration, Wiederholung, Aufnahme und Reconnect. Storage40929786439 für4a35f26
bestätigt diesen Fall und insgesamt181 Tests je MariaDB-Version10.11/11.8.8/11.8.
Frontendcode seit dem vollständig grünen979b148 unverändert; finalen Gesamtstand
über PR#57 prüfen. Merge ausschließlich beim Projektinhaber.
Unabhängiger Review fand versteckten Raw-Rückwechsel und fehlende vorangehende
Lifecycle-Baseline: Rawaufnahme nach Cutover jetzt ablehnen, Worker dürfen mit
Rawkonfiguration Captures lesen; nachträgliche Offline-/Unknown-Baseline sperrt
auch immutable Captures. Env-Review: Testfixture-Reihenfolge korrigiert und
Dateirevision direkt nach fsync vor Rename erneut prüfen. Keine CAS-Zusage für
fremde Dateieditoren ohne gemeinsamen Lock.
GitHub-Secretscanningwarnungen1/2 als OpenVSX-Format wurden auf UUID-Beispiele
in Dokumentation/Minutentest eingegrenzt; Warnung2 direkt mit deterministischer
Testfixture verglichen, kein echter Zugangsschlüssel. Keine echten `.env`-/
Secretdateien committed, Warnungen nicht durch Agent geschlossen/Token rotiert.
Automatische Löschung älterer EVSE-Werte jetzt ausdrücklich autorisiert:
`STORAGE_RETENTION_MINUTE_DAYS/HOUR_DAYS/DAY_DAYS`, Default0=unbegrenzt. Quellen-
gebundene begrenzte Löschungen einschließlich Legacyraw/Ereignissen; fremde
Quellen, Preise und Provider nie anfassen. Gröbere Stufen mindestens so lange
aufbewahren, Eltern mit abgelaufenen Kindern nicht leer neu verdichten.
Echte `.env`-Dateibearbeitung im Settingsmenü ist jetzt ausdrücklich beauftragt;
kein reiner Download/JSON-Entwurf. Admin-Login hingegen ausdrücklich erst nach
neuer gesonderter Freigabe implementieren, nicht automatisch zum Abschluss.
Frühere Default-Deaktivierung jetzt durch ausdrückliche LAN-Freigabe ohne Login
ersetzt, mit bewusster Operator-Dateibereitstellung (siehe aktueller Auftrag).
Keine produktiven Schreibmounts/Deployment durch Agent. Dateispeicherung ist nicht Containerneuerstellung; kein Docker-Socket
oder privilegierter Verwaltungscontainer implizit erlaubt. Nächster gewünschter
Architekturschritt ist ein gemeinsamer Compose-Einstieg, sodass ein Befehl alle
Projektdienste baut/startet; weiterhin getrennte Container und bestehender
externer Broker/MariaDB. Noch nicht umgesetzt.
Betreiberrückmeldung: Hausarchiv war wegen leerer Storage-`SMARTMETER_URL`
deaktiviert. Nach Konfiguration meldet dessen Healthdatei alive/database_ready/
materialization_ready=true, written=6. Belegt gestartete Speicherung, nicht alle
gültigen Messwerte oder erfolgreiche Pi-Diagramm-/Dauerbetriebsabnahme.

## Projekt und Ziele

Aktuelle Nachbesserung (2026-10-29): Projektinhaber meldet Website wieder
erreichbar, aber weiterhin Punktreihen, Renderlast und leeres Hausarchiv bei
vorhandenem Livewert. Screenshot ist kein Nachweis der Archivaktivierung.
Belegter Fehler: PHP-Projektion machte metrikspezifische NULLs zu globalen
Lücken; Korrektur erhält globale Ausfall-/Coverage-/Dirty-Barrieren. Links nur
angrenzende schlechte Readkanten ohne zeitliche Überlappung dürfen keine neue
Minute vergiften. Archivaufbereitung auf ausgewählte Gruppen begrenzen,
Inspektionslabels lazy, unveränderliche Renderansicht statt JSON-Kopie pro Frame,
keine Archivframes bei unveränderten Frischeticks. Formatter und statische
Liveanzeige wiederverwenden; Frische-/Clock-/Retryprüfung bleibt aktiv.
Hausloaderstatus in bestehender Diagrammbeschreibung anzeigen, keine neue Karte;
deaktiviert/unverfügbar/erfolgreich leer/unvollständig unterscheiden und erhaltene
Altdaten als solche kennzeichnen. Produktive Ursache des leeren Hausarchivs noch
offen; ausschließlich redigierte API-Zähler beim Betreiber angefragt.
Codehead 7452be0 vollständig Docker-geprüft: Web 40911077845 (PR) und
40911066582 (Push), Storage-Matrix 40911077779 mit MariaDB 10.11/11.8.8/11.8.
150 JS-Fälle, PHP-/SQL-/Transport-/TLS-/acht Browser-/Runtimeprüfungen sowie
kombinierte HTTP-/MQTT-Ausfälle, Broker-Recovery, Prozess-/Shutdownprüfung.
Neue 168-Bucket-Wochenfixture repräsentiert 81.478 künstliche Read-Counter:
100 unveränderte Frischeticks verursachen keine zusätzlichen Archivplotaufbauten,
Wallbox-Geometrielesungen oder SVG-Mutationen; alle sichtbaren Diagramme <100
SVG-Knoten. Simulierte verbundene Wochenkurven bei 1440 px dunkel/390 px hell,
Hausjahreskurve und Status-/Fehlerdarstellung visuell angesehen. Keine reale
Pi-Last-/ARM-Garantie oder bestätigte Hausarchivierung daraus ableiten.
Aktueller Abschluss-/Freigabehead in PR #56; Merge durch Projektinhaber.
Vorhandene konservative Bestandsaggregate nur durch expliziten begrenzten
`--refresh-history` neu berechnen, niemals still umdeuten.
Laufende Eventinvalidierung wird nach nachweislich abgeschlossenen Initialcursorn
ab `invalidate_from` lokalisiert; historische Bereiche davor bleiben lesbar.
Initialbackfill, widersprüchliche Zustände und Pending-Kind-/Elternarbeit bleiben
gesperrt. Erster abschließender Reviewversuch wegen Kontingent abgebrochen;
anschließend zwei unabhängige gpt-6.1-sol-Reviews: Frontend ohne konkreten
Befund, Backend fand Präzisionsverlust einer Mikrosekunden-Grenzprüfung am
SQL-Epochjahr 1000. Minutenabgleich jetzt vor Floatkonvertierung am Text,
beide Invalidierungsfelder regressionsabgedeckt. Kein Ersatz für Docker-CI.
PR #55 ist mittlerweile
gemergt (420854b); Featurehead fcb14da bestand Web 40900732201/40900717412 und
Storage 40900732166. Nachmerge-Lauf 40902481238 bestand kombinierten Datenpfad
und Broker-Recovery, scheiterte danach an Prozesszählung mit möglicher
Healthchecküberlappung. Test nimmt nur den exakten Healthcheckvektor aus und
prüft echte Duplikate/Legacy-Hausdienste weiterhin; Shutdownassertionen erhalten.

Aktueller Folgeauftrag (2026-10-29): Archivdiagramme wegen hoher Renderlast und
weiterhin unbefriedigender Darstellung erneut überarbeiten; Haus-Netzleistung
nun ausdrücklich dauerhaft speichern und in Stunde/Tag/weiteren Kalenderansichten
anzeigen, oberhalb von „Diagnose“. Hausarchivierung ist als opt-in implementiert,
alte Aufteilung und vereinfachter Storagepfad Docker-geprüft (Nachweise oben);
Pi-Hausarchivabnahme offen. Bisheriger Live-RAM-Verlauf allein ist
kein SQL-Hausarchiv. Vorgabe zusätzlich: belegte Datenpunkte als Linien verbinden.
Website bleibt SELECT-only, vorhandene Raw-/Preis-/Providerdaten erhalten,
keine Produktionsmigration durch Agent. Main-Build 40782985667 scheiterte nach
drei Hauswertprüfungen in der MQTT-Unabhängigkeitsphase; Hotfix ersetzt deren
einmalige Folgebeobachtung durch begrenztes gemeinsames Warten bei unveränderten
Anwendungsgrenzen und ergänzt redigierte Phasendiagnostik. Zusätzliche unabhängige
Live-/Archiv-Readiness im Historienbrowsertest getrennt synchronisiert.
Hotfix-PR #53 für 6d976fc ist reviewbereit: vollständige Docker-CI
40846713475 und 40846704139 erfolgreich. Merge durch Projektinhaber.

Neuer ausdrücklicher Vereinfachungsauftrag (2026-10-29): keine eigenen Haus-
Container. HTTP-Erfassung, SQL-Speicherung und Hausverdichtung gehören in den
bestehenden `storage`-Container. Implementierter Ersatz: ein interner HTTP-/DB-
Thread mit eigener Verbindung/Retryverwaltung neben unverändertem Wallbox-MQTT-
Pfad, gemeinsames Stop-Event und aggregierter Healthcheck. Keine Haus-MQTT-
Topics/Client-IDs, separaten Publisher oder zusätzlichen Compose-Profile.
`SMARTMETER_URL` in Storage leer = Hausarchivierung deaktiviert; konfiguriert =
direkte HTTP-Erfassung. Bestehende Website-Liveabfrage bleibt unabhängig.
Websitecontainer weiterhin Apache plus bisherige zwei Worker, SELECT-only.
`HOUSE_HISTORY_SOURCE` ist nur SQL-Quellkennung (Default `evse/house`), Legacy
`HOUSE_MQTT_TOPIC_PREFIX` bleibt Fallback, um alte Datenzuordnungen zu erhalten.
`--migrate-house`
legt ausschließlich fünf `evse_house_*`-Tabellen und unabhängige Registry 1 an;
globale Wallboxversionen bleiben `{1}`/`{1,2}`. Signed W, echte 0/NULL, UUID/Sequenz-
Dedupe, Raw+Dirty atomar, begrenzte materialisierte Minute/Stunde/Tag. Keine
Produktionsmigration, Hauswerte vor Aktivierung oder bestehende Daten erfinden.
Readonly `/api/house-history` unabhängig von Wallboxhistorie/deren Schema;
Rohgrenzen mikrosekundengenau wie SQL, reine Online-Refreshereignisse bei bereits
bekanntem Onlinezustand unterbrechen keine Kurve. Abrufzeitfenster nicht als
identisches Empfangszeitfenster behandeln; 10-s-Clock-/Transportgrenzen bleiben.
`WEB_HOUSE_HISTORY_ENABLED=0` Default, vorhandene HISTORY_DB-Lesekonfiguration.
Eigener Browserstore mit Kalenderkoordinator, kein Import von Archivwerten in
Live-Frische. Unabhängige HTTP-Poller nicht zu abwechselnden Live-/SQL-Punkten
vermischen; SQL-Basis mit separat unterbrochenem, strikt neuerem Live-Endstück.
Hausdiagramm oberhalb von Diagnose, keine zusätzlichen Erklärungskarten.

Archivrenderer bündelt Werte/Bänder je Serie statt DOM-Knoten je Bucket, zeichnet
geschlossene Diagnosegruppen erst bei Bedarf und verwendet Revisions-/RAF-
Koaleszierung. Variable numerische Mittelwerte sind kein mehrdeutiger Codezustand
und dürfen verbunden werden. Wallboxrollups werten bekannte Online-Refreshevents
nicht als Ausfall und unbekannte andere Felder nicht als Verlust aller Messungen.
NULLs bleiben pro Serie sichtbar; echte Offline-/Retained-/Clock-/Eventbarrieren
bleiben erhalten. Bereits gespeicherte Aggregate werden nicht still neu gedeutet:
optionales `--refresh-history --history-from ... --history-to ...` markiert nur
vorhandene Minutenbuckets eines expliziten UTC-Bereichs (max. Kalenderjahr) in
256er-Seiten erneut dirty, keine Raw-/Fremddaten-/DDL-/Versionsänderung. Kein
automatischer Refresh beim Start; regulärer Worker verdichtet anschließend.
Vertrag `docs/house-history-contract.md`, vollständige Einrichtung zentral in
`docs/installation.md`. Die alte Aufteilung aus PR #54 ist gemergt (fff4efa),
Finalhead d727aed bestand Web 40878353419 und Storage-Matrix 40878353418. Diese
Nachweise ersetzen nicht die neue Prüfung des direkten Storage-HTTP-Pfads.
Neue HTTP-/kombinierte Laufzeit-/E2E-Prüfung samt bisheriger API-/Browser-/PWA-
und MariaDB-10.11/11.8.8/11.8-Matrix integriert. Aktueller Freigabehead und
Abschlussnachweise in PR #55, bis dahin kein neuer Abnahmeanspruch. Gezielter
unabhängiger Review von HTTP-/kombiniertem Runtimepfad ohne konkreten Befund;
keine dadurch ersetzte Laufzeitprüfung.
Der bestehende Schema-1-Beispieldump enthält keine optionalen Archive;
Installationsguide verlangt deren Tabellen ausdrücklich im privaten Backup.
Beim Umstieg alte bereits laufende Hausdienste vor Update bewusst stoppen,
keine automatische Container-/Volumeentfernung. Zentralen Installationsguide
beachten; Merge durch Projektinhaber.
Erneute unabhängige Abschlussprüfung: API/Diagramme und Betriebsanleitung ohne
konkreten Befund. Datenpipeline fand fehlende Invalidierung einer bereits
materialisierten Folgeminute bei verspätetem linken Kontext. Korrektur markiert
nur bereits vorhandene Folge-Minutenwork samt Eltern in derselben Transaktion;
keine unbegrenzte Zukunftsarbeit. Korrektur a682f7c nochmals unabhängig gezielt
geprüft, ohne weitere konkrete Befunde. Unit-/MariaDB-Fälle für zurückdatierte
Clockfehler und Retainedwerte bleiben erhalten. Keine Agent-Mergefreigabe für Produktion.
Keine lokalen Hosttests und kein Pi-/ARM-/Dauerbetriebsnachweis oder Deployment.

EVSE-Control ist eine Diplomarbeit zur Steuerung und Überwachung einer
Elektrofahrzeug-Ladestation mit RFID-basierter Diebstahlsicherung.
Repository: https://github.com/MarioL-Tech/EVSE-Control

Geplant sind Ladefreigabe und Ladestatus, Erkennung eines angeschlossenen
Fahrzeugs, Energie- und Strommesswerte, Regelung nach verfügbarer Leistung und
Dringlichkeit, Datenbank und Bedienung über die Website.
Der modulare Aufbau mit Docker-Compose-Komponenten ist ein erklärtes Projektziel.
Festgelegt ist ein gemeinsamer Compose-Einstieg für mehrere spezialisierte
Container. Detailaufteilung und Zusammenführung der heutigen Compose-Dateien
sind noch umzusetzen; diese Umstellung ist ausdrücklich erst später gewünscht.

**Aktualisierte Oberflächenplanung:** Es wird kein eigenes Home-Assistant-Modul
und keine eigene Home-Assistant-Integration entwickelt. Die Website soll später
inhaltlich umgebaut werden. Davon separat wird eine Smartphone-PWA umgesetzt. Am 2026-10-28
konkretisiert: Die Handy-Oberfläche soll eine **installierbare Progressive Web App
(PWA)** sein, nicht eine native Handy-App. Funktionsumfang, Gestaltung und
Zusammenspiel weitergehender Bedienoberflächen sind noch festzulegen. Manifest,
HTTPS-only-Installationscontroller und Offline-Shell sowie optionaler lokaler
HTTPS-Proxy und Produkticons sind implementiert und Docker-geprüft;
Pi-/Handyabnahme noch offen. Separat
autorisiert und implementiert ist die PHP-Backendmigration ausschließlich der Website
`rasppi/weboverlay`; HTML/CSS/JS, Seiten und Diagramme bleiben ohne Neugestaltung.
Separat beauftragt und umgesetzt ist das Theme „Compact / Dense“ nach Entwurf
Nr. 8 für Dark- und Light-Mode: kühle Blau-/Grautöne, dezente Kartenverläufe,
feine Rahmen/Schatten und kompaktere Typografie/Abstände. Die Vorlagen zeigen
nur das Theme, nicht die zu übernehmende Ansicht: Sidebar, vier Übersichtskarten,
Messwerte, Auswahl, Navigation und Seitenaufteilung bleiben erhalten.
Responsive Darstellung allein gilt nicht als PWA-Nachweis. Der separat beauftragte
PWA-/HTTPS-Ausbau verändert weder Hardwaredienste noch deren Schnittstellen;
weitergehender inhaltlicher Umbau und Ladebedienung bleiben gesonderte Aufträge.

### Konkretisierte Anforderungen (Umsetzungsstand siehe unten)

- Laden identifizieren durch wiederholte Zustandsabfragen („Repeating Request“)
  und den Ladevorgang steuern. Abfrageintervalle und Fehlerbehandlung sind noch
  festzulegen; die Modbus-Timeout-Grenzen beachten.
- System- und Ladezustände in einer Datenbank sichern.
- Website zur Bedienung bereitstellen; späterer Websiteumbau und anschließend
  eine auf dem Handy installierbare PWA sind geplant, Details noch offen.
- Übergeordnete Softwarekommunikation über MQTT mit **demselben Message Broker**
  für alle beteiligten Dienste; Hardwareanbindungen siehe Architekturabschnitt.
- Dienste modular mit Docker Compose betreiben.
- **Strikte Docker-only-Regel auf dem Pi:** Projektsoftware, Build, Tests und
  Abhängigkeiten ausschließlich in Containern. Keine Host-Installation von
  Compiler, CMake, Python-/pip-Paketen, libmodbus, mbpoll oder Mosquitto empfehlen
  oder durchführen. Docker Engine und Compose sind bestehende Voraussetzungen.

Für die bedienende Website sind folgende Funktionen vorgesehen; die genaue
Übernahme in die spätere Smartphone-WebApp ist noch abzustimmen:

- **Bedienung:** AN-/AUS-Button für die Ladefreigabe.
- **Anzeigen:** vorhandener/verfügbarer Strom, tatsächlicher Ladestrom,
  Fahrzeug angeschlossen („Plugged in“), Ladevorgang aktiv („Laden?“).
  Ladefreigabe und tatsächliches Laden als getrennte Zustände behandeln.
- **Automationen:** Laden abhängig vom verfügbaren Strom sowie von einer
  festgelegten Dringlichkeit. Messpunkt/Einheiten des verfügbaren Stroms und
  Definition der Dringlichkeit sind noch zu präzisieren.

### Handy-Oberfläche: installierbare PWA und lokales HTTPS

- Verbindliche Konkretisierung vom 2026-10-28: webbasierte Handy-App mit
  Installation auf dem Homescreen/eigenem App-Symbol und appartigem Start.
  Keine native Android-/iOS-App als Teil dieser Planung. Die heutige responsive
  Browseranzeige und ein einfacher Homescreen-Link sind kein Nachweis einer
  vollständig umgesetzten PWA. Zielgeräte/-browser und jeweiliger Android-/iOS-
  Installationsablauf bleiben konkret festzulegen und tatsächlich zu testen.
- PHP/Apache, vorhandene MariaDB und MQTT-/Hardwaredienste bleiben die Basis;
  keine implizite Migration auf andere Backendsprachen, Frameworks oder SQLite.
  Kein Home-Assistant-Modul, keine neue Ladesteuerung durch diese Anforderung.
- Für eine reguläre PWA mit Service Worker ist ein sicherer Kontext nötig:
  vertrauenswürdiges HTTPS auch im LAN. Der aktuelle HTTP-Zugang zur privaten
  Pi-Adresse genügt dafür nicht. Am 2026-10-28 zusätzlich festgelegt: zunächst
  ausschließlich lokal und **ohne nutzbare Domain**, spätere Domainanbindung
  muss möglich bleiben. Implementierter opt-in-Weg: Docker-HTTPS-Reverse-Proxy Caddy
  mit eigener lokaler CA und gültigem Zertifikat für die gewählte lokale Adresse.
  Öffentliches CA-Zertifikat auf jedem Zielhandy explizit installieren/vertrauen;
  eine weggeklickte Browserwarnung ist kein verlässlicher PWA-Installationsweg.
  CA-Daten dauerhaft/geschützt speichern, privaten CA-Schlüssel niemals an
  Handys verteilen oder committen. Zielgeräte/Vertrauensinstallation und konkrete
  Pi-Aktivierung noch offen; keine öffentliche Freigabe, neuen VPN-/Clouddienste
  oder tatsächliche Proxy-/Portänderung ohne Umsetzungsauftrag vornehmen.
- Präzisierung nach Rückfrage: Nicht jede Installation/Homescreen-Verknüpfung
  setzt HTTPS voraus; Browser können HTTP-Seiten als Shortcut/App-Fenster ablegen.
  Davon die sicheren Service-Worker-/Offlinefunktionen dieser WebApp unterscheiden.
  Deren Controller verlangt bewusst HTTPS, auch auf Loopback; `localhost` auf dem
  Handy ist nicht der entfernte Pi. Später hat der Projektinhaber die HTTPS-/
  Handy-Einrichtung ausdrücklich vorerst zurückgestellt; HTTP bleibt nutzbar.
  Keine bereits erfolgte Deaktivierung/Aktivierung auf dem Pi daraus ableiten.
- Spätere Domainanbindung als konfigurierbare Erweiterung derselben Proxygrenze
  vorsehen (Zieladresse, Zertifikatsmodus/-bezug), kein PHP-/DB-/MQTT-Neubau und
  keine fest codierte Deploymentadresse. DNS/Zertifikatsvalidierung und gewünschte
  Erreichbarkeit dann gesondert festlegen; Domain bedeutet nicht automatisch
  Internetfreigabe. IP/Hostname-Wechsel ändert Browser-Origin: PWA gegebenenfalls
  neu installieren, lokale Anzeige-/Themepräferenzen nicht automatisch migriert.
  Serverseitige Messdaten bleiben unabhängig von diesem Adresswechsel erhalten.
- Manifest/HTTPS-Controller/Service Worker/Offline-Seite
  und zugehörige Tests implementiert; PNG-Produktion aus freigegebenem SVG erfolgt
  ausschließlich im gepinnten Docker-Browserimage. Strict-Allowlist-Shellcache,
  `/api/*` und `/healthz` network-only/no-store, keine Messwert-/Dashboardcaches
  und keine POST-Queue. Offline-Navigation zeigt explizite Offline-Seite, bestehende
  Live-Frische/Unknown/NULL bleiben erhalten. Kein ungefragtes `skipWaiting`.
- Optionaler Dienst `https` im bestehenden Website-Compose, Profil `https`
  über lokale `.env` (`COMPOSE_PROFILES=https`), keine dritte Betriebsdatei.
  Gesamten Website-Stack ohne Dienstsuffix starten. Bindung über `WEB_BIND_ADDRESS`,
  Port `WEB_HTTPS_PORT=443`, Zertifikatsname `WEB_TLS_HOST` leer = Bindungs-IP.
  UID 10001, readonly/cap-drop, private interne Webnetzverbindung, persistente CA
  in `https-data`, kein Broker-/DB-Netz/Docker-Socket. Nur interne CA, auch bei
  zukünftigem DNS-Namen keine automatische öffentliche Ausstellung. HTTP 8080
  bleibt aus Kompatibilität unverändert, kein Redirect/HSTS/Login ergänzt.
- Installation ersetzt weder Servererreichbarkeit noch Authentifizierung.
  Außerhalb des LAN entsteht keine automatische Fernverbindung; Zugriffsschutz,
  erlaubtes Offlineverhalten und mobile Bedienung bleiben abzustimmen. Bestehende
  serverseitige Dienste laufen unabhängig davon, ob die Handy-App geöffnet ist.
- Produkticons aus Docker-Rendererlauf 40725917549 übernommen (dieser erste
  Bootstraplauf scheiterte danach erwartungsgemäß an noch fehlenden committed
  PNGs, kein App-/TLS-Nachweis). Statische Prüfung fand einen unbegrenzten
  Shell-Asset-Fetch bei Netzwerk-Blackholes: jetzt auch für Scripts/CSS 3-s-
  Abort/Race mit ausschließlich statischem Cachefallback und Regressionstest.
  Bei späteren Assetänderungen die Shellgeneration bewusst erhöhen.
- Caddy-Pin `2.11.7-alpine@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f`
  unabhängig als OCI-Index mit Linux-amd64 und arm64/v8 geprüft; keine ARM-Laufzeit-
  Aussage. TLS-/Rootvertrauen-/IPv4-ohne-SNI-/Persistenzprüfungen bisher bestanden.
  Erster Browserlauf scheiterte nur an CI-Ausgaberechten; Folgelauf zeigte, dass
  CDP-`setOffline` Service-Worker-Netzzugriffe nicht zuverlässig unterbricht.
  Neuer isolierter Harness stoppt/startet den echten Testproxy über den CI-Host,
  ohne Docker-Socket im Browser; MQTT/Backend laufen für echte Frische weiter.
- Vollständige Docker-CI 40730086578 für 6c72193 erfolgreich: 108 JS-Fälle
  (15 neue PWA-Fälle), bestehende PHP-/SQL-/sechs Chromium-Suiten/Lock-/Runtime-
  Prüfungen plus siebte vertrauenswürdige PWA-Suite mit echtem Proxy-Ausfall und
  neuer MQTT-Telemetrie nach Wiederkehr. Gleichzeitiger PR-Lauf 40730095578 bestand
  PWA/TLS/SQL, scheiterte am älteren Charts-Browsertest: „Live“ allein beweist noch
  keinen neuen plottbaren Zeitstempel. Test wartet jetzt auf denselben weiterhin
  geforderten getrennten SVG-Pfad; keine Diagramm-/Produktionslogik verändert.
  Aktuellen Abschluss-/Freigabestand über PR #51 prüfen. Kein Pi-HTTPS-Deployment,
  produktives CA-Zertifikat oder echter Android-/iOS-Installationsnachweis.

### Geplante Lademodi (noch nicht implementiert)

Für die spätere Ladesteuerung sind drei Modi vorgesehen:

1. **Laden wenn Solarstrom**: Laden abhängig von verfügbarem Solarstrom.
2. **Laden ohne Solarstrom**: Laden soll auch ohne verfügbaren Solarstrom möglich sein.
3. **Benutzerdefiniert**: Laden nach benutzerdefinierten Vorgaben; deren Umfang ist noch offen.

Noch zu klären sind Datenquelle und Messpunkt für Solarstrom, ob Modus 1 nur
PV-Überschuss nutzen soll, Schwellwerte und Verhalten bei fehlenden/veralteten
Messwerten sowie die konfigurierbaren Regeln des benutzerdefinierten Modus.
Standardmodus, Moduswechsel und Zusammenspiel mit Ladefreigabe, verfügbarem
Strom und Dringlichkeit sind ebenfalls noch festzulegen. Die Modi ändern keine
Geräte-/Sicherheitsgrenzen und sind keine bereits verfügbaren Bedienfunktionen.

Zusätzlich soll das Weboverlay eine **modulare Einrichtungsfunktion mit
Befehlseingabe für Wallboxbefehle** anbieten. Befehlsformat, Validierung und
zulässige Operationen sind noch festzulegen; Gerätegrenzen nicht umgehen.

Verbindliche Anforderung vom 2026-10-29: Sämtliche bisher über `.env` gesetzten
Projektkonfigurationen zentral unter **Settings** verwalten, nicht nur lokale
Anzeigepräferenzen. Echte Dateibearbeitung inzwischen autorisiert, Implementierung
in Arbeit. Admin-Login nur nach neuer ausdrücklicher Freigabe. Validierung,
Secret-/Mountschutz und Unterscheidung gespeichert/wirksam sind erforderlich;
kein Docker-Socket, keine anonym produktiv freigegebene Verwaltung. Die
Messdaten-APIs und SQL-Zugriffe bleiben SELECT-only; ein Editor darf weder
Secretdateien lesen noch Hardwarebefehle ausführen.

## Repository und Quellen

- `esp32/src/main.cpp`: ESP32-Firmware (Arduino/PlatformIO).
- `esp32/include/config.h`: Pins, UART-Baudrate und Servo-/RFID-Konfiguration.
- `esp32/platformio.ini`: ESP32 DevKit (4 MB), gepinnte Arduino-2-/MFRC522-Toolchain;
  Servo über nativen LEDC-Adapter statt ESP32Servo. `esp32/Dockerfile` baut native
  Tests mit Sanitizern und die komplette Firmware; opt-in Flash-Target separat.
- `rasppi/src/main.py`: derzeit interaktive UART-Brücke, kein zentraler Backenddienst.
- `rasppi/requirements.txt`: derzeit nur `pyserial`.
- `rasppi/Dockerfile.uart` und `rasppi/compose.yaml`: interaktive UART-Testbrücke
  mit Python/pyserial ausschließlich im Container, Hardwaregerät durchgereicht.
- `rasppi/wallbox/`: rein lesender C++17-libmodbus-Dienst, Decoder-/JSON-Tests,
  simulierte RTU-Tests, CMake sowie Dockerfile/Compose und Pi-Startanleitung.
- `rasppi/weboverlay/`: PHP 8.4/Apache und ein PHP-CLI-
  MQTT-Subscriber und unabhängigem HTTP-Haus-Smartmeter-Worker; `php/` enthält
  Config, StrictJson, StateStore, SharedState, MqttTransport, `worker.php` sowie
  die optionale lesende `HistoryConfig`/`HistoryStore`-/`HistoryRange`-/
  `HistoryArchive`-Anbindung (PDO/mysqlnd) und
  SmartmeterConfig/-Client/-Cache und `smartmeter-worker.php`, `public/` den HTTP-Einstieg, `docker/` Apache-
  Konfiguration, Bash-Supervision und PHP-Healthcheck. Bestehende Browseroberfläche,
  PHP-/Node-Tests und Docker/Compose; keine seriellen Ports/Schreibbefehle. Docker-CI
  40365837026 für 06a3626 erfolgreich; Pi-Start und Live-Übersicht am 2026-10-26
  durch Projektinhaber/Screenshot bestätigt, gezielte Fehlerfallprüfung offen.
- `rasppi/storage/`: MQTT-Collector für vorhandene MariaDB, Schema/Migration,
  typisierte Wallbox-Historie und optionale separate Schema-2-Kalenderverdichtung,
  Docker-only-Tests; keine Steuerung/Hardwareports.
- `docs/pin-connection.md`, `docs/uart-protocol.md`: Pinreferenz und UART-Protokoll.
- `docs/installation.md`: zentrale Anleitung für Installation, Hardware und
  Wiederinbetriebnahme; vereint die frühere Setup-Datei mit dem Docker-only-Ablauf
  inklusive Broker, Netzwerk, Tests und bekannten Einrichtungsgrenzen.
  Die separate `docs/setup.md` wurde entfernt; keine zweite Anleitung parallel pflegen.
  **Jeden neuen Installations-/Konfigurationsschritt dort ebenfalls dokumentieren**;
  Die Einrichtung muss später ohne persönliche Angaben reproduzierbar sein.
- `docs/wallbox/`: ABB-Terra-AC-Modbus-Dokumentation und Befehlsreferenz.
- `docs/wallbox/modbusRegisters.txt`: ergänzte Register-/Testnotizen mit Verweis
  auf Handbuch v1.11; das entsprechende PDF liegt derzeit nicht im Repository.
  Die Notizen enthalten Widersprüche, siehe unten; nicht ungeprüft übernehmen.
- `docs/smartmeter/`: DTSU666-Handbuch.
- `docs/schematic/` und Pinout-Bilder: Hardware-Referenzen.
- `CHANGELOG.md`: Änderungen mit Zeitstempel (Europe/Vienna).

Code beschreibt die aktuelle Implementierung; Hardwarehandbücher beschreiben
Geräteanforderungen. Widersprüche offen benennen. `README.md` ist der deutsche
Projekteinstieg mit getrennten Zielen/Implementierungsstand, Architektur und
Docker-only-Schnellstart. Startabschnitte kurz halten; ausführliche Wallbox-
Konfiguration und Betriebshinweise sind in der Dienst-README einklappbar.
Die frühere SmartCharge-Marketingbeschreibung mit
unbelegten Feature-Versprechen wurde entfernt. README bei Änderungen konsistent
halten; laufende Hardwaretests erst nach bestätigten Ergebnissen dokumentieren.

## Festgelegte Architektur

```text
ESP32 <-> UART <-> Raspberry Pi <-> USB-RS485 / Modbus RTU <-> ABB Terra AC
                         |
                         +-- Wallbox-MQTT -> vorhandener Broker
                         |                   -> Weboverlay (lesend)
                         |                   -> Speichercollector -> vorhandene MariaDB
                         |                   -> weitere Dienste (geplant)
                         +-- UART-MQTT-Gateway (geplant)
                         +-- DTSU666-Messwerterfassung (geplant)
                         +-- HTTP-Haus-Smartmeter -> PHP-Worker -> Website (optional)
```

- Der Pi ist die zentrale Steuerungsplattform und Modbus-Master.
- Später eine gemeinsame Docker-Compose-Datei für die Pi-Projektdienste:
  ein Start-/Stop-Befehl für mehrere getrennte Container, kein All-in-one-
  Container und kein zusätzlicher Container, der andere Container verwaltet.
  Docker/Compose übernimmt den Containerlebenszyklus; ein geplanter Ladecontroller
  übernimmt ausschließlich die fachliche Ladeautomatisierung über MQTT.
- Vorhandener MQTT-Broker und MariaDB werden weiterhin extern wiederverwendet,
  nicht ersetzt oder beim Stoppen des Projektstacks mit heruntergefahren.
  Aktuell bleiben die einzelnen Dienst-Compose-Dateien unverändert; keine
  Zusammenführung oder Laufzeitumstellung ohne späteren ausdrücklichen Auftrag.
- Die Wallbox-Schnittstelle ist bereits entschieden: ABB Terra AC über
  USB-RS485, `/dev/ttyUSBEVSEcontrol`, **57600 Baud, 8E1, Slave-ID 9**.
  Die ID 9 gehört zur Wallbox, nicht zum Pi als Master.
- Direkte ESP32-Pi-Kommunikation bleibt kabelgebunden über UART,
  **115200 Baud, 8N1**, Pi-Gerät `/dev/serial0`.
- Für diese direkte Verbindung ist kein WiFi gewünscht; Ethernet-Hardware
  und geeignete zusätzliche Leitungen sind derzeit nicht vorgesehen.
- MQTT ist für die übergeordnete Softwarekommunikation über einen gemeinsamen
  Message Broker vorgesehen; der Pi soll als UART-MQTT-Gateway dienen.
  UART ist kein MQTT-/TCP/IP-Transport ohne
  zusätzliche Protokollschichten. Ob der Lehrer MQTT auch auf der direkten
  Geräteverbindung verlangt, muss noch geklärt werden.
- Nur das Websitebackend wird durch PHP ersetzt; C++-Reader, Python-UART-Brücke
  und Python-Speichercollector bleiben unverändert. Keine Compose-Zusammenführung,
  Home-Assistant-Integration, Modbus-Schreibbefehle, DB-/Historienoberfläche oder
  Smartmeterabfrage als Teil dieser Migration.

### Haus-Smartmeter: optionale lesende Websiteintegration

- Laut Projektinhaber liefert ein konfigurierbarer privater HTTP-Host unter
  `/dev/powerValue.txt` whitespace-getrennte Werte (schematisch
  `U1 U2 U3 Feld4 Feld5 Feld6 1549.40 …`). Wert 7 ist Netzaustauschleistung in W:
  positiv Netzbezug, negativ Einspeisung; Beispiel 1549.40 bedeutet 1549,40 W Bezug.
- Die ersten drei Werte sind Phasenspannungen und für die geplante Auswertung
  vorerst zu ignorieren; andere Felder sind unbekannt. Keine Deployment-IP
  dokumentieren. Nicht unabhängig abgerufen oder verifiziert.
- Nach abgeschlossener PHP-Migration separat beauftragt und implementiert:
  eigener PHP-CLI-HTTP-Worker im Websitecontainer. Nur lokal konfiguriertes
  `SMARTMETER_URL`, leer = deaktiviert; keine Deployment-IP im Repository.
  `SMARTMETER_POLL_SECONDS=2` (1–60), `SMARTMETER_TIMEOUT_SECONDS=2` (1–5),
  `SMARTMETER_STALE_SECONDS=10` (3–120). cURL aus dem vorhandenen PHP-Image,
  GET/HTTP 200, kein Redirect/Proxy, maximal 8 KiB Header und 4 KiB Body.
  ASCII-Zahlenliste mit mindestens sieben endlichen Zahlen; nur Index 6 auswerten.
- Unabhängiger privater 8-KiB-Cache mit atomarem Austausch/stabilem flock
  (maximal 200 ms), Heartbeat alle 250 ms zwischen Abfragen. Bei fehlendem/
  defektem Snapshot, Zeitfehler, Ausfall oder Veraltung keine Leistung; echte 0
  bleibt erlaubt. Heartbeatgrenze max(3 s, HTTP-Timeout + 1 s). HTTP-Lesezugriffe
  erneuern weder Heartbeat noch Abrufzeit. DNS/Shutdown können durch OS-Limits
  verzögert werden; Supervisor erzwingt das Prozessende nach seiner Frist.
- `GET /api/smartmeter`: schema_version/read_only/status/reason/power_w/fetched_at/
  age_seconds/fresh_for_seconds. Nur `live` gibt signed `power_w`, sonst null.
  Keine URL/Host-/Rohdaten oder Credentials in API/Diagnosen. Browser pollt nur
  auf der Übersicht, separat von MQTT, und verwirft abgelaufene/späte Daten.
  Empfangs-/Abruffrische ist kein Nachweis einer neuen Messung im Gerät.
- Anzeige „Netzleistung Haus“ mit Netzbezug (+)/Einspeisung (−), eigenem Status,
  letztem HTTP-Abruf und Abrufalter. Ohne neues opt-in keine Hauswerte in MQTT/DB; separat ergänzter
  signierter Browser-RAM-Liveverlauf auf der Diagrammseite (15 Minuten/1200 Abrufe),
  allein kein Haus-Kalenderarchiv; das neue unabhängige opt-in-Archiv ergänzt dieses;
  Wallbox-API, Reader/UART/Collector und 16 Wallbox-Präferenzen unverändert.
  Beziehung zur geplanten DTSU666-Erfassung ungeklärt; kein verfügbarer Strom in A.
  Docker-CI 40486476429 für 3c92398 erfolgreich: 80 PHP-Smartmeterprüfungen,
  17 isolierte HTTP-/Cache-/Shutdown-Szenarien, insgesamt 49 JS-Tests und fünf
  Chromium-Suiten (darunter 30 Theme-/Einstellungsfälle) sowie alle bestehenden
  PHP-/IPC-/MQTT-/HTTP-/Auth-/ACL-/Runtime-Prüfungen. Desktop-/Mobilbilder mit
  simulierten Werten in Hell/Dunkel angesehen; kein Produktionsabruf/Pi-Nachweis.
- Projektinhaber meldete am 2026-10-27 zunächst fehlende Hauswerte; nach den
  Einrichtungs-/Updatebefehlen folgte „funktioniert“. Keine konkreten Hauswerte,
  API-Ausgabe oder Einzelprüfungen gezeigt; nicht als unabhängige Sensor-/Frische-
  validierung ausgeben. Tatsächliche private URL-Konfiguration nicht ausgelesen.
  `SMARTMETER_URL` bleibt nur in vorhandener lokaler `.env`; Container danach
  neu erstellen (kein Neubau für reine Env-Änderung nötig). Quelle muss vom Pi-
  Container erreichbar sein. Keine SSH-/Netzwerkänderung, echte Quelle oder
  private `.env`-Inhalte durch Agent abgerufen.

## Betrieb und Remote-Zugriff

- Der Projektinhaber hat keinen direkten physischen Zugang zu Pi oder Wallbox.
  Zugriff auf den Pi erfolgt über WireGuard; SSH-Zugriff ist laut Projektinhaber bereits möglich.
  Das bedeutet nicht, dass ein Agent automatisch SSH-Zugang hat.
- Das Programm soll auf den **Raspberry Pi übertragen und dort ausgeführt**
  werden. Der Pi greift lokal auf USB-RS485/Modbus und ESP32-UART zu; diese
  Hardwareverbindungen werden nicht über WireGuard ersetzt.
- Entwicklung kann lokal erfolgen; Build, Tests und Ausführung der Pi-Dienste
  laufen im Docker-Container. Image-Build auf dem Pi erzeugt passende ARM-Binaries.
  OS-/Hardwarekonfiguration ist davon getrennt und rechtfertigt keine Installation
  von Projektpaketen auf dem Host. Keine Docker-/Netzwerkinstallation ohne Auftrag.
- Verwaltung zunächst über SSH und Logs; später Zugriff auf die auf dem Pi
  bereitgestellte Bedienoberfläche über WireGuard. Der Wallbox-Dienst soll
  unabhängig von einer offenen SSH-Sitzung laufen; Docker Compose bleibt das
  Ziel für den modularen Betrieb.
- Hardwaretests als Remote-Tests planen, zunächst nur lesen. Physische Fehler
  lassen sich remote nur eingeschränkt prüfen. Keine Änderungen an WireGuard,
  SSH oder Netzwerkfreigaben ohne ausdrücklichen Auftrag; keine Zugangsdaten
  im Repository speichern. Hardwarezugriff/Deployment nicht ohne tatsächliche
  Ausführung als erfolgreich melden.

## Tatsächlich implementiert

### ESP32

- MFRC522 über SPI: SS GPIO5, SCK GPIO18, MOSI GPIO23, MISO GPIO19,
  RST GPIO22; Reader mit 3,3 V versorgen.
- UART RX GPIO16 (vom Pi TX GPIO14, Pin 8), TX GPIO17
  (zum Pi RX GPIO15, Pin 10), gemeinsame Masse (z. B. Pi Pin 6).
  Beide Seiten haben 3,3-V-Logik; keine 5 V an GPIOs anlegen.
- Servo-Signal GPIO13; Versorgung mit 5 V und gemeinsamer Masse,
  nicht über die 3,3-V-Schiene des ESP32.
- Die frühere Firmware war ein UART-Kommunikationstest (beliebige Karte,
  Start 0°). Neue Firmware: maximal 16 freigegebene UIDs (4/7/10 Bytes) toggeln
  unabhängig vom Laden zwischen 90°/0°. Unbekannte/widerrufene Karten abweisen.
  MFRC522 verwendet 13,56-MHz-Karten, keine 125-kHz-Tags. UIDs sind klonbar;
  Whitelist ist kein kryptografischer Berechtigungsnachweis.
- Startmodus `RESTORE` (Default), `LOCKED`, `UNLOCKED` über vertrauenswürdigen
  Pi-UART konfigurierbar, gilt erst beim nächsten ESP32-Neustart. Neuer leerer
  Store: verriegelt/90°, keine Karten. `RESTORE` lädt letzten gespeicherten
  **angeforderten** Servozielwert. Keine mechanische Rückmeldung, kein zugesicherter
  Schutz bei Stromausfall; Modellservo, keine zertifizierte Diebstahlsicherung.
- Version-/CRC-/semantikgeprüfter 188-Byte-Blob speichert Karten, Policy und Ziel
  zusammen: direkte ESP-IDF-NVS-API, Partition `evse_nvs` (0x290000/0x6000),
  Namespace `evse-lock`, Key `state`. Eigene 4-MB-Partitionstabelle isoliert den
  Store vom Arduino-Default-NVS-Autoerase. Kein automatisches Löschen, kein
  Factoryreset, keine zugesicherte Verschlüsselung. Nur exaktes NOT_FOUND
  initialisiert einen neuen Store; Korruptions-/Lesefehler nicht als Leere behandeln.
- Startup-Storefehler fordern verriegelt an; Laufzeit-Schreibfehler ebenfalls
  LOCKED, beenden Anlernen und sperren Änderungen bis Neustart. Normale Aktionen
  erst nach erfolgreicher Speicherung bestätigen/ausgeben. Fehler-Fallback ist
  nicht sicher persistierbar: nächster RESTORE-Start liest tatsächlich letzten
  gültigen Blob (kann abweichendes Ziel/ungewissen Commitausgang enthalten).
- Anlernen: bewusster START über Pi-UART, 30 s/eine Karte, kein Toggle bei Aufnahme;
  Duplikat schließt Fenster ohne Bewegung, Cancel/Ablauf/Widerruf beendet es.
  Wiederholtes aktives START verlängert nicht und setzt Gate nicht zurück. Nach
  START erneut mindestens 500 ms saubere Leere verlangen, erst dann auflegen.
  Boot-/gehaltene Karten und UID-Wechsel ohne Leere erzeugen keine frische
  Präsentation. WUPA/Selektieren/HALT statt falscher REQA-Entfernungserkennung;
  nur Chip-TimerIRQ ohne Fehler zählt als Abwesenheitsindiz. Poll-Lücken >250 ms,
  Kollisionen/Select-/SPI-/Softwaretimeoutfehler brechen die Serie ab. Funkkopplungs-
  verlust kann physisches Entfernen imitieren; keine Hardware-Anwesenheitsgarantie.
  Zusätzlich 800 ms Aktionssperre, kein künstlicher Startaufschub.
- Native LEDC-PWM auf GPIO13: Defaultmapping-Referenz ESP32Servo 1.1.2,
  544..2400 µs (0°=544, 90°=1472); Zielduty vor GPIO-Anbindung. Pulsform,
  Mechanik/Kalibrierung und tatsächlicher NVS-/Powerloss-Betrieb noch hardwareoffen.
  Firmware aktuell ungeflasht; Docker-CI 37235418853 für 8f98c41 bestätigt
  41 native Sanitizer-Fälle, fünf simulierte Firmwareadapter-Suiten, kompletten
  Xtensa-Targetcompile und Artefakt-/Flash-CLI-Smoke ohne USB/Upload. Prüfhost
  Linux-amd64, keine echte NVS-/SPI-/Servo-/Pi-ARM64-Prüfung. Unabhängige
  Codeprüfung ohne weitere belegte Defekte. Kein Agent-
  Hardwarezugang. Erstupgrade verändert Boot0° auf90° und Partitionstabelle;
  vor Ort sicher koordinieren, kein Erase-All/Stock-SPIFFS-Zugriff.
- Laut Projektinhaber wurde eine Reader-Firmwarekennung `0x82` beobachtet.
  Das ist ein SPI-Diagnosehinweis, kein Nachweis vollständiger RFID-Funktion.
- Ladezustand startet OFF und wird durch Pi-UART-Befehle gespiegelt, steuert
  **keine reale Wallbox**. Keine neue ESP32-Wallbox-Schnittstelle als offene Architekturentscheidung
  darstellen: die reale Steuerung soll über den Pi und Modbus erfolgen.

### UART und Pi

Zeilenbasiertes ASCII-Protokoll mit Newline; dokumentiert in
`docs/uart-protocol.md`:

- `CMD:CHARGE:ON`, `CMD:CHARGE:OFF`, `CMD:STATUS`.
- `CMD:RFID:ENROLL:START`, `CMD:RFID:ENROLL:CANCEL`, `CMD:RFID:REVOKE:<uid>`.
- `CMD:ANTITHEFT:BOOT:RESTORE|LOCKED|UNLOCKED`; kein direkter Servo-Unlock-Befehl.
- `EVSE:STATUS:CHARGING:ON|OFF:SRC:<quelle>`.
- `EVSE:STATUS:ANTITHEFT:ACTIVE|INACTIVE:SRC:<quelle>`.
- `EVSE:STATUS:SECURITY:...` meldet Storefehler, Bootpolicy, Kartenanzahl,
  Anlernfenster sowie SPI-/PWM-Diagnosen (keine mechanische Bestätigung).
- `EVSE:RESULT:<aktion>:<ergebnis>`; UID-Zusatz nur bei erfolgreicher bewusster
  Aufnahme am Pi-UART, nicht in USB-Diagnosen oder gewöhnlichen RFID-Ereignissen.
- Generische `EVSE:ERROR:UNKNOWN_CMD`/`INVALID_ARGUMENT`/`UART:...` ohne Eingabeecho;
  alte allgemeine UID-Nachricht bewusst entfernt. Vertragsdetails im UART-Dokument.

ASCII-Frames maximal 192 Bytes, LF/CRLF, absolute 2-s-Frist; ungültige/abgelaufene
Frames bis LF verwerfen, pro Loop maximal 64 Bytes/ein Befehl. Keine Protokoll-
authentifizierung: physischer UART vertraut dem Pi. Kein anonymes MQTT-/HTTP-
Management; spätere Gateway-/Webbedienung separat geschützt implementieren.
Die Schreibweise mit `|` oben bezeichnet Alternativen, keine wörtlichen Nachrichten.
`CMD:STATUS` meldet drei Statuszeilen. Zustandsänderungen und Bootzustände werden
gemeldet. Das Pi-Skript druckt empfangene Zeilen und übersetzt interaktive
Eingaben `on`, `off`, `status`; andere Eingaben werden unverändert gesendet.
Diese Befehle schalten derzeit **nur den ESP32-Zustand**, nicht die Wallbox.

### Lesender Pi-Wallbox-Dienst

- `rasppi/wallbox/` implementiert zyklische FC03-Abfragen des Blocks
  `0x4008..0x401F` (24 Rohregister), standardmäßig alle 2 Sekunden.
- Konfigurierbare Geräteadresse, Baudrate, Parität, Slave-ID, Intervall und
  vollständiger Antworttimeout; `--once` für einen einzelnen Test.
- 32-Bit-Big-Endian-Dekodierung, Strom-/Spannungsskalierung und getrennte
  Anschluss-/Ladezustände. Unbekannte Zustände liefern `null` statt „Nein“.
- JSON-Zeilen mit UTC-Zeitstempel und letztem erfolgreichen Messzeitpunkt.
  Kommunikationsfehler liefern `values=null`, der Dienst versucht erneut zu
  verbinden; SIGINT/SIGTERM schließen den Port. Ownership-basierte Freigabe
  stellt auch bei Ausnahmen Port-Einstellungen wieder her und schließt den Port.
  JSON-Ausgabe auf stdout ist unterbrechbar und bei vollen Pipes auf 1 s
  begrenzt; Ausgabefehler beenden den Dienst. Keine Schreibfunktionen.
- CMake-Build und beide Tests bestanden unter Debian/WSL (GCC 14.2,
  libmodbus 3.1.6 und 3.1.11): Decoder/JSON sowie simulierte RTU-Kommunikation über PTY.
  Fehlerfall-, CLI- und Shutdown-Prüfungen sind hardwareunabhängig, einschließlich
  Teilantwort-Timeout, Shutdown während einer Abfrage und blockierter Ausgabe.
- Der Projektinhaber hat am 2026-10-03 einen erfolgreichen Docker-Einmaltest am realen
  Pi/Wallbox per Screenshot bestätigt: FC03, Slave 9, Block `0x4008..0x401F`,
  `status=ok`, Fehlercode 0, Zustand 1/B1, angeschlossen, nicht ladend,
  Stromlimit 16 A; Spannungen 237,6/234,6/237,2 V. Damit ist FC03 für diesen
  Block an der getesteten Wallbox bestätigt; FC04-Unterstützung anderer Register
  oder die Korrektheit aller Zustände/Messwerte ist dadurch nicht nachgewiesen.
  Langzeitbetrieb, gezielte Fehlerfalltests und Messwertvergleich bleiben offen.
- Der Projektinhaber hat einen kurzen zyklischen Docker-Betrieb protokolliert: 13 Abfragen
  über etwa 25 s, davon 12 erfolgreich und 1 Timeout; beim folgenden Read
  Recovery ohne Eingriff. Stromlimit dort 6 A, Messströme/Leistung 0. Der Reader
  setzt keine Limits; Wechsel von zuvor 16 A wurde nicht vom Reader verursacht,
  seine Ursache ist ungeklärt (z. B. interne Wallbox-Logik oder andere Steuerung).
  Diese Beobachtung nicht als Langzeitstabilität oder unabhängige Messvalidierung ausgeben.
- Der Projektinhaber ordnet die anfänglich fehlende Ausgabe/fehlerhafte Exitcode-Abfrage
  einem Windows-Problem beim Befehlsaufruf zu, nicht der Wallbox-Kommunikation.
  Die genaue Windows-Ursache wurde hier nicht unabhängig untersucht.
- Einmaltests mit `docker compose run --rm --no-deps -T --interactive=false
  wallbox-reader --once` ausführen. So werden keine nachfolgenden eingefügten
  Shellzeilen als Containereingabe übernommen. Exitcode-Abfrage bei Bedarf auf
  derselben Shellzeile ausführen; `"$?"` nicht als eigenen Befehl eingeben.
- Docker-only-Anleitungen ersetzen die früheren nativen Host-Build-Schritte.
  Tests laufen automatisch im Multi-Stage-Image-Build. Ein Entrypoint übernimmt
  dieselben Compose-Umgebungsparameter für `--once` und Dauerbetrieb; `WALLBOX_DEVICE`
  ist der Host-Pfad, `/dev/ttyWallbox` der Container-Pfad.
- Nur ein Prozess darf den RS485-Port verwenden; parallel laufendes `mbpoll`
  oder andere Master vermeiden. Die Python-UART-Logik bleibt unverändert,
  ihr unterstützter Startweg ist jetzt `docker compose -f rasppi/compose.yaml
  run --rm --build uart-bridge` aus dem Repository-Hauptverzeichnis.
- Keine Ladefreigabe oder SQL-Anbindung im Reader. MQTT-Empfang am Pi und
  lesende Live-Browserübersicht laut Projektinhaber am 2026-10-26 bestätigt.

### MQTT-Publisher im Reader

- `src/mqtt.cpp` verwendet libmosquitto; Netzwerk-/Reconnect-Arbeit läuft getrennt
  von Modbus. Bei Brokerausfall bleiben Reads und JSON-Ausgabe aktiv.
- Topics standardmäßig `evse/wallbox/state` (identische JSON-Samples) und
  `evse/wallbox/availability` (`online`/`offline`), beide retained und QoS 1.
  `online` bedeutet frischer erfolgreicher Read, nicht fehlerfreie Wallbox.
  Readfehler, veraltete Samples, Shutdown und Last Will melden offline.
- Es wird nur der letzte Sample vorgehalten; höchstens eine Zweiergruppe von
  Nachrichten ist ausstehend. Fehlende ACKs führen zum Neuaufbau der Verbindung.
- Compose aktiviert MQTT und bindet ausschließlich das externe `evse-mqtt`
  ein, Alias/Host `mqtt-broker`; Netzwerk und vorhandener Broker müssen vorbereitet sein.
- Konfiguration über `MQTT_ENABLED/HOST/PORT/TOPIC_PREFIX/CLIENT_ID/USERNAME`;
  Passwort optional über `MQTT_PASSWORD` oder bevorzugt `MQTT_PASSWORD_FILE`
  mit `compose.auth.yaml`. Keine Secrets committen; `.env` bleibt lokal.
- Docker-Build enthält isolierte Broker-/PTY-Integrationstests; Tests kontaktieren
  nie den Produktionsbroker. GitHub-Docker-CI mit allen drei Tests inklusive
  Datei-Authentifizierung, abgelehnten Credentials, fehlenden PUBACKs und
  Runtime-Smoke-Test erfolgreich (Run `37153110560`, Commit `1b6f868`).
- Vertrag: `docs/mqtt-protocol.md`; Installationsguide enthält externes Netzwerk
  als Startvoraussetzung, Update-/Subscriber-Test und optionale Passwortdatei.
- Bei aktivem MQTT ist stderr best-effort/nichtblockierend; volle Logpipes
  dürfen den Callback-/Sample-Mutex und damit Modbus nicht blockieren.
  DNS kann Shutdown dennoch verzögern; siehe dokumentierte Fristgrenze im Vertrag.
- UART-MQTT-Bridge und Steuerbefehle bleiben geplant; Weboverlay abonniert lesend.

### Vorhandener MQTT-Broker und bestätigte Vorbereitung

- Auf dem Pi läuft bereits `elastic_lumiere`, Image `eclipse-mosquitto:alpine`,
  Port 1883 an allen Host-Schnittstellen; ursprünglich Netzwerk `bridge`.
  Reader war beim bisherigen Pi-Test in `wallbox_default`; die neue Compose-
  Version nutzt `evse-mqtt`. Containername ist deploymentabhängig.
- **Diesen Broker wiederverwenden, keinen zweiten starten.** Grafana und MariaDB
  laufen ebenfalls bereits; keine bestehende Infrastruktur ersetzen.
- Der Projektinhaber hat `evse-mqtt` angelegt und den Broker mit Alias `mqtt-broker` verbunden.
  Docker-Testclient über dieses Netzwerk bestätigt `CONNACK (0)` und QoS-1-
  `PUBACK RC:0` für `evse/test` ohne Zugangsdaten. Das bestätigt weder alle ACLs
  noch Subscriber-Zustellung; Authentifizierung/Port-Erreichbarkeit prüfen.
- Netzwerkzuordnung übersteht Neustart desselben Containers, nicht automatisch
  dessen Neuerstellung. Ursprüngliche Broker-Compose-/Config-/Volume-Einrichtung
  ist noch nicht bekannt; keine vollständige Broker-Neuinstallation vortäuschen.
- Der Projektinhaber hat am 2026-10-03 den tatsächlichen Subscriber-Empfang bestätigt:
  15 erfolgreiche Samples von 21:03:18 bis 21:03:46 UTC (23:03:18–23:03:46 Wien),
  alle 2 s, jeweils `availability online`. Zustand B1/angeschlossen/nicht ladend,
  Fehlercode 0, Limit 6 A, Ströme/Leistung 0, Spannungen etwa 233–236 V.
  Bestätigt Wallbox → Reader → vorhandener Broker → Subscriber, nicht
  Langzeitstabilität, gezielte Ausfälle oder unabhängige Messwertvalidierung.

### Rein lesendes Weboverlay

- Website-Logo separat autorisiert: bereitgestellte sechs SVG-Pfade als
  `static/icon.svg` in Sidebar/Mobilkopf aller drei Seiten und als Favicon;
  unveränderte Blau-/Grünfarben, helle Trägerfläche auch für dunkle Browser-Tabs.
  Bestehende Wortmarke, Seiten-/Navigationsstruktur und Markengrößen bleiben.
  Originale unter `docs/` nicht verändert/aufgenommen. Docker-CI 40590551938 und
  40590543291 für e839bb2 erfolgreich (bestehende Backend-/SQL-/JS-/sechs
  Chromium-/Runtimeprüfungen). Simulierte Dark-Desktop-/Light-Mobil-Artefakte
  visuell geprüft; SVG-Laden auf allen drei Seiten geprüft, kein Pi-Deployment.
- PHP-Migration implementiert: PHP 8.4/Apache (non-root
  UID 10001, intern Port 8080) plus genau ein PHP-CLI-Subscribe-only-Worker und
  ein unabhängiger PHP-CLI-Haus-Smartmeter-Worker im
  selben Websitecontainer. `php-mqtt/client` exakt 2.3.2; Docker-Builds verwenden
  die exakt gesperrten Abhängigkeiten aus `composer.lock`, keine Hostinstallation
  von PHP/Composer. Kein Python in Websitebackend, Runtime, Healthcheck oder
  Backendtests; UART und Storage behalten Python.
- Bash-Entrypoint überwacht HTTP und beide Worker: unerwartetes Prozessende
  beendet die übrigen und den Container mit Fehler; SIGTERM stoppt alle drei.
  Bei Brokerausfall läuft HTTP weiter, der Worker versucht Reconnect mit 1–30 s
  Abstand. Beide SUBACKs sind Voraussetzung; Reconnect löscht Sample/Availability.
  MQTT-Restlänge maximal 32768 Bytes (ohne Festheader), Statepayload maximal 16384 Bytes.
- Privater Interprozess-Snapshot unter `/tmp/evse-weboverlay` im tmpfs:
  stabile flock-Datei, höchstens 200 ms Lockwartezeit, atomarer Austausch,
  maximal 64 KiB. Workerheartbeat alle 250 ms, HTTP erneuert ihn niemals.
  Nach 3 s Worker-Stillstand oder bei fehlendem/beschädigtem Snapshot liefert
  die API fail-closed offline/keine Werte. Kein MQTT-Publish, keine seriellen
  Geräte oder Start-/Stop-/Limitbefehle.
- Docker-CI 40365837026 für 06a3626 erfolgreich: 16 PHP-Zustands-/Config-Fälle,
  IPC-Suite, 21 isolierte Transportfälle, vier echte MQTT-/HTTP-/Auth-/ACL-Szenarien,
  28 JS-Tests und drei Chromium-Suiten sowie gehärteter Runtime-Smoke ohne Broker
  und ohne Python. Composer-Lock unverändert aus CI 40364677345 übernommen;
  Installation aus committed Lockfile und Bytevergleich ebenfalls bestätigt.
  Simulierte Desktop-/Mobilansichten geprüft. Prüfsystem Linux-amd64,
  kein Pi-ARM64-/Produktionsnachweis. Alle nachfolgenden Python-CI-Nachweise sind
  historische Nachweise der früheren Flask-/Paho-Version, nicht der PHP-Migration;
  deren damalige Offenvermerke zum Pi ersetzen nicht die aktuelle Bestätigung unten.
- Deutsche statische Oberfläche, keine CDN-/Browser-MQTT-Abhängigkeiten.
  Auf erneuten Wunsch enger an Nr. 8 angelehnt: dunklere Graphitflächen statt
  starkem Blaustich, feine blau-graue Rahmen und 6-px-Kartenecken, ruhige Verläufe/Schatten,
  cyanfarbene Wallbox-Leistung, gefüllte mintfarbene Live-Badges und kräftigere
  Überschriften/Zahlen. Heller Modus als neutral-kühle Entsprechung. Ausschließlich
  CSS-Designwerte; HTML/JS, Texte, Grid/Abstände/Größen/Breakpoints, Navigation,
  native Schaltergeometrie und sämtliche Messwert-/Backendfunktionen unverändert.
  Palette-/Kontrast-/Layoutfreeze-CI 40499228102 für acce554 erfolgreich:
  49 JS-Tests und alle fünf Chromium-Suiten mit 30 Theme-/Settings-Fällen sowie
  vollständige Backend-/Runtime-Prüfungen. Hell/Dunkel bei 320/390/768/1440 px,
  Kontraste auf geprüften Flächen/Verlauf-Endpunkten mindestens 4,5:1 und
  unveränderte Sidebar-/Grid-/Abstands-/Karten-/Schaltergeometrie geprüft.
  Simulierte Desktop-/Mobilbilder von Übersicht, Diagrammen und Settings angesehen;
  keine neue Pi-Ausführung. Separater älterer Diagrammtest wird beim Sammeln von
  Samples auf geänderte angezeigte Zeitmarken synchronisiert statt nur „Live“.
  Theme „Compact / Dense“ für Dark/Light nach Entwurf Nr. 8; kompakter
  nativer Checkbox-Schiebeschalter links unten auf allen drei Seiten (160×52 px,
  beweglicher 42-px-Schieber, Sonne/Mond, LIGHT MODE/DARK MODE, Tastatur/Screenreader).
  Am Desktop im Sidebar-Fuß, mobil unten links fixiert. „Settings“ mit Zahnrad
  steht in der Hauptnavigation unter „Diagramme“ und führt nach `/einstellungen`:
  Platzhalter ohne Hardware-/Ladefunktionen,
  nur „Systemdarstellung verwenden“ setzt die lokale Theme-Wahl zurück.
  Default System folgt weiterhin
  `prefers-color-scheme`; manuelle Wahl gilt browserlokal über `evse-theme-v1`
  (nur light/dark, System entfernt den Schlüssel). Blockierter Speicher fällt
  auf die aktuelle Seite zurück; nicht speicherbare Wahl bleibt bei Pageshow
  erhalten. Lesbare gespeicherte Wahl wird bei Pageshow/Storage-Ereignissen
  neu geladen. `theme.js` setzt sie vor dem Stylesheet, ohne Inline-JS oder
  Steuerbefehle; bei deaktiviertem JS bleiben Schalter/Reset deaktiviert.
  Schiebeschalter-/Textbereinigungs-CI 40491901055 für 13b8a20 erfolgreich:
  49 JS-Tests und alle fünf Chromium-Suiten einschließlich 30 Theme-/Settings-
  Fällen, nativer Checkbox/Schieberbewegung/Leertaste, Sidebar-Reihenfolge und
  Links-unten-Position bei 320/390/768/1440 px; alle Backend-/Runtime-Prüfungen
  ebenfalls bestanden. Simulierte Hell-/Dunkelbilder am Desktop und mobil
  visuell angesehen; neue Pi-/Browserprüfung und Hauszähler-Konfiguration offen.
  Historische
  Symbolschalter-/Smartmeter-CI 40486476429 für 3c92398 erfolgreich (oben);
  historische Auswahlfeld-CI 40375388768
  für 53ce565 erfolgreich: 37 JS-Tests (neun neue Theme-
  Unitfälle), alle vier Chromium-Suiten einschließlich 22 Theme-Browserfällen
  sowie vollständige PHP-/IPC-/MQTT-/HTTP-/Auth-/ACL-/Runtime-Prüfungen bestanden.
  Manuelle Wahl gegen die OS-Präferenz, Persistenz, Systemmodus und Storage-
  Fehler geprüft; simulierte Desktop-/Mobilbilder in Hell/Dunkel angesehen.
  Noch kein Pi-Nachweis für die neuen Symbolschalter.
  Die ursprüngliche Theme-Änderung betraf nur CSS und dekorative Inline-
  SVG-Symbole; keine Karten umgeordnet oder entfernt. PHP/MQTT/API,
  Frischelogik, Präferenzen und Diagrammdaten unverändert. Theme-CI 40369056814
  für ff496f2 erfolgreich: vollständige PHP-/MQTT-/HTTP-/JS-/Chromium-Prüfungen,
  Systemfarbwechsel und Textkontrast auf geprüften Flächen mindestens 4,5:1.
  Beide Seiten in Hell/Dunkel bei 320/390/768/1440 px geprüft; simulierte
  Desktop-/Mobilbilder visuell angesehen, kein Pi-Deploymentnachweis.
  Unterscheidet Anschluss, tatsächliches Laden, Wallbox-Limit und noch nicht
  erfassten Gebäudestrom. Unknown/null bleibt unbekannt, nicht „Nein“.
- Projektinhaber bestätigt am 2026-10-26 Dienststart und sichtbare Werte der
  Pi-Website; Screenshot der Übersicht zeigt Live/MQTT online, Messzeit 18:52:39,
  Alter 1 s, 0 kW, 0 kWh, Limit 6 A, angeschlossen/nicht ladend sowie
  234,8/235,0/235,2 V bei 0 A je Phase. Neues Dark-Theme sichtbar. Nur bestätigte
  Momentaufnahme, kein Langzeit-/Ausfall-/Messwertvergleichsnachweis und kein
  Agent-Deployment. Projektinhaber bestätigt am 2026-10-27 erneut Websitezugriff
  und sieht den bisherigen großen Theme-Selektor. Neue Symbolschalter und
  Haus-Smartmeter sowie gezielte Diagramm-/Ausfallprüfung auf dem Pi offen.
  Kein bestätigtes produktives Passwortfile:
  optionales Auth-Override scheiterte an fehlendem `MQTT_PASSWORD_HOST_FILE`,
  danach wurde der Betrieb bestätigt. Daraus keine Broker-Authkonfiguration ableiten.
- Dashboard `/` und eigene Diagrammseite `/diagramme` mit gemeinsamer echter
  Navigation, responsivem Layout und automatischem hell/dunklem Farbschema.
  Vier kompakte Übersichtskarten, Phasen/Haus-Netzleistung nebeneinander
  (mobil untereinander), einklappbare Diagnose. Repetitive Untertitel/Hinweistexte
  gekürzt; Infokarte „Leistungsrahmen“ entfernt. Deren Messwert „Unter Sollstrom“
  bleibt unter „Diagnose“ und über dieselbe der 16 Wallbox-Präferenzen verfügbar.
  Status/Frische/Messzeit/aktive Fehlerwarnung unverändert sichtbar; HTTP-Abrufzeit
  bleibt von Geräte-Messzeit und Netzleistung von verfügbarem Ladestrom abgegrenzt.
  Diagramme: vier elektrische Gruppen plus fünf einklappbare Zustands-/Rohwert-
  Gruppen. Status, Frische, Messzeit und aktive Fehlerwarnung bleiben sichtbar.
- `/api/state` liefert Messwerte nur bei verbundenem Broker, gültigem Sample,
  `availability online` und Frische (default 10 s). Ungültige/alte/zu weit
  zukünftige Payloads, Readfehler und Offline blenden Werte aus. Browser lässt
  Werte auch ohne weitere API-Antworten ablaufen. Dieser Live-Endpunkt nutzt keine
  Datenbank; die separat beauftragte optionale `/api/history` ist unabhängig.
- `/healthz` ist HTTP-Liveness, nicht MQTT-Readiness. Brokerausfall startet
  den Webserver nicht neu. Reconnect verwirft alte Availability/Samples.
- Compose nutzt bestehenden `evse-mqtt`/`mqtt-broker`, Client-ID `evse-weboverlay`
  muss sich vom Reader unterscheiden. Container non-root UID 10001, readonly,
  keine Capabilities. Hostport standardmäßig `127.0.0.1:8080`; Zugang via
  vorhandenem SSH-Tunnel. Separat ausdrücklich gewünschter direkter LAN-Zugang
  jetzt über eine einzige lokale `.env`-Einstellung `WEB_BIND_ADDRESS` auf die
  Pi-LAN-IPv4-Adresse, `WEB_PORT` weiter 8080. Keine zusätzliche LAN-Datei oder
  dynamische Dateilisten-/Array-Skripte nötig; frühere Chatempfehlung ersetzt.
  Bestehende Auth-/History-Overlays weiterverwenden, nur Website neu erstellen;
  kein Build/Migration/Pi-Neustart/Collectorstop nötig. Default nicht ungefragt
  auf alle Schnittstellen ändern. Kein Login/TLS, keine WAN-/Routerfreigabe;
  Docker-Ports können UFW umgehen. Keine automatische Firewall-/SSH-/Netzänderung.
  Projektinhaber zeigte am 2026-10-28 zunächst einen gesunden, aber nur localhost-
  gebundenen Websitecontainer. Nach Merge von PR #49 und der vereinfachten
  LAN-Anleitung meldet er am selben Tag „funktioniert“: positive Rückmeldung zum
  direkten LAN-Websitezugriff, keine vom Agent geprüfte Laufzeitkonfiguration.
  Keine unabhängige API-/Dauerbetriebs-/Zugriffsschutzprüfung und insbesondere
  kein zusätzlicher Nachweis der Schema-2-Migration/Kalenderverdichtung daraus.
  Compose-CI prüft Default und explizite Test-LAN-Bindung samt Overlays ohne
  tatsächliche Testportfreigabe; aktuellen Prüf-/Freigabestand über PR #49 prüfen.
  Keine neue LAN-Erreichbarkeit allein aus einem CI-Konfigurationstest ableiten.
- Kein HTTP-Login/TLS; nicht öffentlich freigeben. MQTT-Credentials nur Backend,
  optional Passwortdatei mit `compose.auth.yaml`, für UID 10001 lesbar.
- Build/Tests ausschließlich in Docker. Historische Python-CI `37200290345` für `cf7184f` erfolgreich:
  21 Python-/MQTT-/HTTP-Tests, 13 Frontend-Unit- und Chromium-Browsertests,
  gehärtetes Runtime-Image ohne Broker. Desktop-/Mobil-Screenshots mit simulierten
  Werten geprüft; tatsächlicher Pi-Browser-/Deploymenttest bleibt offen.
- Der Projektinhaber hat den Prototyp als `80f2808` auf `main` committed/gepusht. Erster
  Weboverlay-CI-Lauf `37154800334` scheiterte an einer nicht abgeschlossenen
  CSP-Zeichenkette in `overlay/app.py`; Syntax korrigiert und CI erfolgreich.
- Erweiterte Tests prüfen UTF-8-Payloads, API-Feld-Whitelist und parallele HTTP-
  Leser. OS-DNS kann geordneten MQTT-Shutdown verzögern; Prozessfristen gelten,
  es werden dabei keine Hardwareports oder MQTT-Publisher beeinflusst.
- Browser-Codeprüfung: unveränderte Live-Region-Texte werden nicht mehr ständig
  ersetzt; zusätzliche Browser-Regressionen für Timeout/Spätantworten, Visibility/
  Pageshow, Request-Parallelität und Live-Region-Mutationen; erweiterte CI erfolgreich.
- `static/charts.js`: dependency-freie SVG-Zeitverläufe für die 16 Telemetriewerte,
  gruppiert nach Einheit, Bool-/Codewerte als Stufen. Nur auf der Diagrammseite
  erfasste Werte im RAM, maximal 15 Minuten/1200 Messzeitpunkte; Zeitfenster 1/5/15
  Minuten. Default weiter nur Browser-RAM ohne DB-Verlauf. Optionaler SQL-Import
  lädt nach Neuladen/Seitenwechsel/Seitencache das gespeicherte 15-Minuten-Fenster
  neu; Übersicht sammelt/lädt keinen Verlauf. Keine künstlichen Live-Samples.
- Wiederholte API-Samples werden nicht mehrfach gezählt. Bei gleicher Sekunden-
  Zeitmarke werden geänderte Werte nur ohne Ausfall durch den letzten Wert ersetzt.
  Offline/Fehler/Unknown erzeugen Lücken, Pausen >10 s werden nicht verbunden;
  rückwärts springende Browserzeit löscht den Verlauf. Historische Kurven bleiben
  bei Offline sichtbar und sind ausdrücklich nicht als Live-Anzeige bezeichnet.
- Aktuell autorisierte UI-Überarbeitung: Übersicht ohne Auswahlfenster und ohne
  Verstecken von Messwerten durch Diagrammpräferenzen; Datenstatus „Aktuelle
  Wallbox-Messdaten“ auf Übersicht/Diagrammen ganz unten, aktive Fehlerwarnung
  weiterhin oben. Diagramme mit eigenen Checkboxen je Kurvengruppe, auch bei
  all-off bedienbar; unveränderte 16 Wallbox-Präferenzen. Periodentasten und
  adaptive Datumseingabe statt sichtbarem Modusmenü, kompakte Historienstatuszeile
  statt Verlaufskarte. Archiv mit getrennten soliden Aggregatmarken/dezenten
  Min-Max-Spannen, keine erfundenen Intervallverbindungen; SVG-Breite dynamisch
  für lesbare mobile Achsen. WebApp-Karte in Settings entfernt; Grundfunktion
  optional erhalten. Theme-Schalter folgt vor erstem Render dem effektiven Modus.
  Docker-CI 40777926455/40777919496 für 296074c erfolgreich: 125 JS-Fälle,
  17 PHP-Zustandsfälle, bestehende PHP-/SQL-/Transport-/Auth-/Runtimeprüfungen und
  sieben Chromium-Suiten, darunter 34 Themefälle und unabhängige Hauskurve bei
  MQTT-Offline. Reader-CI 40777926278/40777919514 bestätigt alle drei bisherigen
  C++-/simulierten RTU-/MQTT-Suiten mit zusätzlicher Buchsen-Enumregression.
  Simulierte mobile Stunden-/Jahresansichten und dunkle Hausanzeige angesehen;
  erweiterte getrennte Desktop-/Hauskurvenartefakte folgen mit PR-Checks.
  Aktuellen Freigabestand über PR #52 prüfen; kein Pi-Deployment/Hardwarebeweis.
  Zusätzlich durch Nutzerscreenshot eingegrenzt: Ladezustand 5, Rohwert 34048
  (`0x8500`), Buchsenstatus 257 (`0x0101`), Live/Fehlercode 0. Bisheriger Reader
  nutzte nur den Ladezustand und verlor dabei die unabhängige Anschlussaussage.
  Hersteller-PDF v1.7 Seite 7/Abschnitt 5.5 bestätigt `0x0101`/`0x0111` als Kabel
  an Station UND Fahrzeug. Decoder nutzt nur diese exakten positiven Enums bei
  unklarem Ladezustand für `plugged_in=true`; `charging` bleibt unbekannt, bekannte
  Zustände 0–4 unverändert. Keine Ableitung aus 0 W/Entriegelung, keine zusätzlichen
  Abfragen/Schreibbefehle, keine alten Archivdaten ändern. Fix benötigt neues
  Readerimage, Pi-Nachweis noch offen. Direkter lesender API-Abrufversuch durch
  Agent endete mit Timeout; keine API-Daten/Secrets gelesen, kein SSH/Deployment.
  Keine zusätzlichen Erklärungstexte/-fenster in der Oberfläche hinzufügen.
- Kurvencheckboxen gelten nur auf der Diagrammseite; Einstellungen
  lokal im Browser (`evse-display-v1`), keine Messwerte/Credentials im localStorage.
  Nicht verfügbarer Speicher fällt auf aktuelle Sitzung zurück. Status, Messzeit
  und aktive Wallbox-Fehlerwarnung bleiben unabhängig von Auswahl sichtbar.
- Seitenrendering toleriert fehlende seitenspezifische Felder; Diagrammauswahl
  bleibt unter demselben Schlüssel gespeichert, blendet keine Übersichtswerte aus. Keine neuen MQTT-
  Clients, Hardwarebefehle oder Portänderungen. SQL/zusätzliches DB-Netz nur mit
  dem separat beauftragten opt-in-Historienoverlay, nicht durch Anzeigepräferenzen.
- Abschließende Dashboard-CI `37220843434` für `154e7f2` und PR-CI `37221004357`
  erfolgreich: 21 Python-/MQTT-/HTTP-
  und 28 JS-Tests plus drei Chromium-Suiten (beide Seiten, Navigation/Fokus,
  Auswahl/Frische/Warnings, 320/390/768/1440 px, hell/dunkel, blockierter Speicher).
  Desktop-/Mobilbilder mit simulierten Werten geprüft, keine Pi-Bestätigung.
  Codeprüfung ergänzt getestetes Präferenz-Neuladen bei Seitencache-Rückkehr;
  temporäre Auswahl ohne lesbaren Speicher bleibt erhalten. Der Projektinhaber hat PR #33
  als `863c66c` gemergt; echtes Pi-Deployment/Browserprüfung weiterhin offen.
- Erste Diagramm-Docker-CI `37203503188` für `4edb64f` erfolgreich. Codeprüfung
  ergänzt pro Kurve konservative Same-Second-Unknown-Unterbrechungen (beide
  Nachbarsegmente); erweiterte CI `37203627509` erfolgreich. Isolierte Samples
  bekommen sichtbare Punktmarker; kleine Skalen werden nicht auf 0/0 gerundet.
  Abschließende CI `37204010318` für `70b21d7` erfolgreich: 21 Python-Tests,
  27 JS-Tests und beide Chromium-Browsersuiten. Desktop-/Mobil-Diagramme mit
  simulierten Daten geprüft, echte Pi-Anzeige weiterhin offen. Lokale MCP-
  Artefakte bleiben außerhalb Git und werden nicht als Projektdaten behandelt.

### Optionale SQL-Historie der Website

- Separat am 2026-10-27 autorisiert und implementiert: PHP/PDO-SELECTs aus den
  vorhandenen Schema-1-Tabellen ergänzen die bisherigen Diagramme. Live-MQTT,
  `/api/state`, Status/Frische, Theme, Sidebar/Karten, 16 Werte und 1/5/15-Minuten-
  Auswahl bleiben erhalten. Keine Preis-/Haus-Smartmeter-/Hardware-/Steuerintegration.
- `WEB_HISTORY_ENABLED=0` Default, `compose.history.yaml` opt-in: vorhandenes
  `evse-data` zusätzlich zum MQTT-Netz, eigener readonly Reader-Passwortmount.
  `HISTORY_DB_HOST/PORT/NAME/USERNAME/PASSWORD_FILE` nur Backend, kein Writer-
  Fallback. PDO/mysqlnd ausschließlich Docker, keine Composer-Lockänderung.
- `GET/HEAD /api/history`, literal `minutes=1|5|15` (Default 15), strikte Query-
  Whitelist. `HistoryConfig`/`HistoryStore`: Schema 1, binärer Source-Präfix,
  explizite SELECTs/Read-only-Transaktion, Maxima 1.200 Samples/2.400 Ereignisse
  plus zwei Baselines/1 MiB. UInt64-ID als String, nullable Zahlen/Bools, keine
  Roh-JSON-/Fehler-/SQL-/Zugangsdaten. Statementlimit 1 s, Connect/Read 2 s,
  monotones Gesamtbudget 3 s zwischen Treiberaufrufen; OS-DNS/laufende I/O können
  darüber hinaus verzögern. Fehler 503/unavailable, disabled 200, live-unabhängig.
- `history.js` lädt nur Diagrammseite, initial/vordergründig alle 60 s, Timeout
  4 s, Fehlerbackoff 10/30/60 s, max. ein aktiver Request; Lifecycle-/Clock-
  Generationen verwerfen Spätantworten. Puffer kombiniert 1.200 Punkte/15 Minuten,
  SQL importiert keine Live-Frische. Live gewinnt bei gleicher präziser Zeitmarke;
  Unknown/Same-Stamp-/Retained-/Event-/Rücksprunglücken bleiben konservativ.
  Gleichzeitige Baseline-Ereignisse beweisen keine Reihenfolge. Die beauftragte
  Diagrammkorrektur ersetzt die frühere globale SQL-Lückensperre durch begrenzte
  Kanten-/Barrierenevidenz: belegte SQL-Messungen dürfen reine Browser-Transport-
  lücken füllen, explizite Mess-/Clock-/Nullunterbrechungen bleiben erhalten.
  Ein unbelegter Quellenübergang isoliert nicht sämtliche nachfolgenden SQL-Punkte.
- Reale `smartReader`-Anmeldung über Socket und Docker-TCP wurde jeweils mit
  1045 abgewiesen; kein SELECT-Rechtenachweis möglich. Exakten Benutzernamen,
  Passwortzuordnung/Hostfreigabe nur durch berechtigten Einrichter klären, nicht
  raten/resetten oder fremde Credentials auslesen. Implementierung/isolierte
  Tests können unabhängig erfolgen. Später ausdrücklich autorisierte Zwischenlösung:
  `HISTORY_DB_USERNAME=smart`, eigene geschützte Website-Passwortkopie, kein
  automatischer Writer-Fallback. Code bleibt SELECT-only/Read-only-Transaktion;
  Account selbst hat mehr Rechte. Keine ungefragte Rechteänderung; funktionierender
  SELECT-only-Zugang bleibt Empfehlung. Nach Merge von PR #46 und der
  Aktivierungsanleitung meldet der Projektinhaber am 2026-10-27 „funktioniert“.
  Bestätigte Bedien-/Betriebsrückmeldung, kein Agent-Deployment. Eigene API-Ausgabe,
  Reload-Vergleich, produktive Ausfall-/Langzeittests wurden dabei nicht vorgelegt.
- Docker-CI `40583180183` für `5daff27` erfolgreich: 130 PHP-Historienfälle,
  insgesamt 74 JS-Tests, 18 echte isolierte MariaDB-11.8.8-/MQTT-/HTTP-/Auth-/Grant-
  Szenarien einschließlich explizitem Writer-Zugang bei unverändert lesender API,
  alle sechs Chromium-Suiten und bestehende Backend-/Runtimeprüfungen. Default-
  Disabled bleibt auch bei Uhrenrücksprung deaktiviert; erst explizite Rückkehr
  prüft neu. Finale Desktop-/Mobil-Artefakte mit simulierter Historie visuell
  geprüft, kein Pi-/Produktionsnachweis. Keine Hosttests oder Produktionszugriffe.
  Vertrag `docs/history-api.md`,
  alle Konfigurationsschritte zentral in `docs/installation.md`.

### Optionale Kalenderhistorie bis ein Jahr (Schema 2)

- Separat am 2026-10-27 beauftragt, am 2026-10-28 implementiert und Docker-geprüft:
  Stunde/Tag/ISO-Woche/Monat/Jahr/eigener Zeitraum, maximal ein Kalenderjahr,
  native Kalender-/Jahreseingabe und Jetzt/Vor/Zurück auf der Diagrammseite.
  Default weiter Live/1/5/15 Minuten. Minutenwahl nur im Live-Modus sichtbar;
  16 Anzeigepräferenzen, Theme, Navigation, Karten und Live-Frische unabhängig.
- Alternative `/api/history?period=day&date=2026-10-27&tz=Europe%2FVienna`, Schema 2;
  Server berechnet halb offene Grenzen einschließlich 23-/25-Stunden-Tagen,
  Schaltjahren/ISO-Wochen; UTC-Navigation unterscheidet doppelte Herbststunden.
  Europe/Vienna oder UTC, eigene Bereiche maximal ein Kalenderjahr. Keine freien
  SQLnamen, nur prepared SELECT/Read-only-Snapshot. 256-Zeilen-Keysetseiten,
  insgesamt maximal 10.000 Eingangszeilen/32 MiB, 512 Ausgabebuckets/2 MiB;
  Statementbudget 1 s, kooperativ 3 s. Kein Jahres-Rohscan/Raw-GROUP-BY-Fallback.
- Website bleibt mit genau drei Prozessen lesend. `newcalendar.js` verwaltet
  eigenen begrenzten Archivstore und nur Präferenzen unter `evse-calendar-v1`.
  Auswahlwechsel/Hidden/Pageshow/Clock verwenden Abort-/Generationenschutz;
  vergangene vollständige Perioden nicht unnötig laufend abfragen. Archivabschluss
  zeichnet selbst, nicht erst beim nächsten Live-Takt. Intervalle als Min/Max und
  Messwertmittel (W/A/V), Limit/Sessionzähler letzter Wert; keine Session-Wh-Summe
  oder behauptete Jahresverbrauchsenergie, keine Bool-/Codemittel. NULL-Endpunkte
  und gemischte/unklare Zustände nicht als konstantes Ja/Nein/0 darstellen.
- Additive optionale `--migrate-history`: neue Tabellen `evse_history_buckets`,
  `evse_history_work`, `evse_history_state`; Metadataversion 2 zusätzlich zu 1.
  Unterstützt exakt `{1}` und `{1,2}`, Default-`--migrate` bleibt Schema 1,
  keine automatische DDL, keine Raw-/Preis-/Provideränderung oder Löschfrist.
  Neuer separater `history-rollup` im Storageprofil `history`, gleiches Image/
  vorhandener DB-Zugang, nur DB-Netz/kein MQTT/Hostport/Hardware/Docker-Socket.
  Runtime braucht zusätzlich SELECT/INSERT/UPDATE ausschließlich an neuen
  Historytabellen. Website zusätzlich SELECT dort; `smart` vorübergehend
  ausdrücklich erlaubt, dessen weitere Rechte und kaputter `smartReader` bleiben.
- Neu eingefügte Rawdaten/Ereignisse markieren Work atomar vor ACK; Worker
  recomputiert UTC-Minute/Stunde/Tag, Generation-/Commit-Retry idempotent,
  Backfill-Cursor dauerhaft und begrenzt. Zufällige UUIDs beweisen keine zeitliche
  Ordnung; fehlender/abgeschnittener Kontext liefert keine Coverage. Bekannter
  Offlinezustand ist Lücke, nicht automatisch unfertige Verarbeitung. Health
  bedeutet laufende DB-Verarbeitung, nicht fertiges Archiv. Raw bleibt append-only.
- **Aktivierung zwingend koordiniert:** kompatible neue Website zuerst, neues
  Storageimage bauen, alten Collector vor Migration stoppen, aus neuem Image
  starten und erst dann Worker. Eine unter Schema 1 verbundene Instanz cached
  ihren Modus und erzeugt sonst keine Dirtymeldungen. Pause kann Records verlieren,
  retained ist kein Replay. Aktuelle EVSE-Sicherung nötig; bisheriger bestätigter
  Vor-Migrationsdump enthält keine EVSE-Tabellen. Kein Agent-Produktionszugriff.
- CI 40678971209/c83b1cc: 132 PHP-Rohhistorien-/59 Kalenderfälle, 93 JS-Tests,
  18 bisherige + 14 Kalender-SQL-/HTTP-Szenarien, sechs Chromium-Suiten und Runtime
  erfolgreich. Echte isolierte 8.784 SQL-Stundenzeilen repräsentieren 15.811.200
  künstliche Read-Counter, liefern 366 lokale Tagesbuckets in beobachteten 1.278 ms.
  Kein Test mit 15 Millionen Rawzeilen, keine Pi-/ARM-Laufzeitgarantie. Matrix
  40678971216 besteht 75 Storagefälle + Runtime je MariaDB 10.11/11.8.8/11.8.
  Mobile 320-px-Jahresansicht und Desktop-Roharchiv visuell geprüft; kein echter
  Pi-Kalender-/Migrations-/Backfill-/Ausfallnachweis. Zusätzliche Browserassertion
  prüft die ausgeblendete Minutenwahl im Archivmodus; aktuellen Freigabestand
  über die PR-Checks prüfen. Vertrag `docs/history-range-contract.md`,
  Aktivierungsablauf nur im zentralen Installationsguide.

### MQTT-Speichercollector / MariaDB

- **Aktueller bestätigter Zugangsstand (2026-10-27):** Projektinhaber hat sich
  erfolgreich per Container-Socket als `smart@%` angemeldet; `SELECT VERSION()`
  bestätigt 11.8.8-MariaDB-ubu2404. Global nur USAGE, umfangreiche nicht
  weitergebbare Rechte inkl. CREATE/SELECT/INSERT auf `energyControl`.
  `mysql.global_priv` ist nicht lesbar; passwortloser Root-Socketzugang wurde
  mit 1045 abgewiesen. Kein bestätigter Account-/Grant-Adminzugang.
- Projektinhaber hat die Arbeit im bestehenden `energyControl` einschließlich
  Erhalt der Strompreise entschieden. Schema 1 ist produktiv angelegt: drei
  `evse_*`-Tabellen zusätzlich zu `T_ELECTRICITYPRICE`/`T_ELECTRICITYPROVIDER`,
  `applied_at=2026-10-27 17:13:09.298160` UTC. Nach Migration weiterhin
  274.804 Preise und 2 Anbieter, keine Löschung/Änderung dieser Tabellen beauftragt.
  Aktuell lokal `DB_NAME=energyControl`, `DB_USERNAME=smart` und
  `DB_MIGRATION_USERNAME=smart`; Code-/Compose-
  Defaults `evse_control`/`evse_migrator` bleiben unverändert. Frühere fehlende
  Sichtbarkeit von `evse_control` beweist nicht seine Nichtexistenz.
- Projektinhaber bestätigt `smart` als dafür eingerichtetes Schreibkonto und
  `smartReader` als Lesekonto und hat Nutzung der Bestandskonten gewählt; separater
  `evse_storage`-Account ist keine technische Voraussetzung. Runtime mit `smart`
  funktioniert, dessen zusätzliche ALTER-/DROP-/DELETE-Rechte bleiben unverändert
  und sind ein bekanntes Risiko, keine minimalen Runtime-Rechte. Kein ungefragtes
  Einschränken/Ändern bestehender Accounts. `smartReader`-Login/Grants sind nicht
  unabhängig bestätigt; die gezeigten Kontrollabfragen verwendeten `smart`.
  Minimalrechte bleiben Empfehlung: Im geteilten Schema vorzugsweise SELECT auf
  `evse_schema_versions`, SELECT/INSERT auf Samples/Events, keine Fremdtabellen-,
  globalen, DDL- oder weitergebbaren Rechte. Kein GRANT durch `smart`.
- SQL bestätigt Default `utf8mb4`/`utf8mb4_uca1400_ai_ci`. Text-/Enum-Spalten erben
  ihn; `verify_shape` verlangt utf8mb4. Keine pauschale Schema-/Tabellenkonvertierung.
  Projektinhaber hat `evse-data` angelegt, MariaDB zusätzlich mit Alias
  `evse-database` verbunden, ohne bisheriges `bridge` zu entfernen. TCP-Zugang
  durch Migration und Collector belegt; TLS nicht unabhängig nachgewiesen.
- Bestandssicherung vor Migration: schemaweiter Docker-`mariadb-dump` mit
  verdeckter Passwortabfrage und `--result-file`, private Kopien auf Pi und PC
  mit übereinstimmender SHA256. Restore im separaten Testcontainer desselben Images
  ohne Netzwerk/Ports/Produktivvolume erfolgreich: 274.804 Preise, 2 Anbieter;
  Testcontainer danach gestoppt. Kein Server-/Accountbackup und kein Backup der
  erst später angelegten EVSE-Tabellen; regelmäßige aktuelle Sicherung bleibt offen.
- Produktive Collector-Aufzeichnung am 2026-10-27 per SQL bestätigt: 207 Samples,
  letzter Messzeitpunkt 17:44:23 UTC, 0 W, Limit 6,000 A und 233,7/233,2/234,8 V.
  Belegt gespeicherte Wallbox-Telemetrie, keine Langzeit-/Ausfall-/Messkalibrierung
  oder abschließende Healthcheck-Bestätigung. Ursache erster pausierter Aufnahme:
  lokales `DB_NAME=energy_control` statt `energyControl`; `.env` korrigiert und nur
  Storage-Container neu erstellt. Migration nicht wiederholt, keine fremden Daten
  gelöscht. Damals Haus-Smartmeter ohne SQL-Archiv; neues HOUSE-opt-in siehe oben.
  Optionale Websitehistorie ist
  separat implementiert; deren Aktivierung mit ausdrücklich erlaubtem temporärem
  `smart` wurde danach vom Projektinhaber als „funktioniert“ gemeldet (siehe oben).
- Pi meldet fehlende Docker-Speicherlimitfähigkeit; angeforderte RAM-Limits werden
  verworfen (Test und Storage). Kein wirksames 256-/512-MiB-Limit behaupten;
  keine Host-/Kernel-/cgroup-Änderung ohne separaten Auftrag. Migration ohne `--rm`
  auf Wunsch behalten; Orphan-Warnung beim Start kein Grund für `--remove-orphans`.
  Keine Agent-SSH-/Produktionszugriffe: alle Betriebsnachweise stammen vom
  Projektinhaber. Private Ziele, Backup-/Secretpfade und Passwörter nicht dokumentieren.
- Installationsguide beschreibt vorhandenes Schema, die drei EVSE-Tabellen,
  getrennte Einrichtung/Runtime, lokale Secrets, explizite Migration/SQL-Prüfung
  und einen auf EVSE-Tabellen begrenzten Dump. Frühere Zugangsnotizen unten sind
  historische Nachweise, nicht der aktuelle pauschale Migrationsblocker.
- `rasppi/storage/`: Subscribe-only Paho + PyMySQL, eigener Client `evse-storage`,
  bestehendes `evse-mqtt`. Produktions-Compose enthält Collector, expliziten
  Migrations-Client und optionalen Kalenderworker im Profil `history`;
  vorhandene MariaDB extern über konfigurierbares `DB_NETWORK`
  (Default `evse-data`), kein zweiter DB-Server/Broker, keine Hostports/Hardware.
- Schema 1: `evse_wallbox_samples` (typisierte A/V/W/Wh, Nullable-Flags, Readfehler,
  Mess-/Empfangszeit UTC, bereinigtes JSON, erstes Retained-Flag) und
  `evse_ingest_events` (Availability, Verbindungs-/Startup-/Shutdowngrenzen, Gaps).
  Source-Präfix exakt UTF-8 als VARBINARY, Hash-Deduplizierung pro Source.
  Gleiche UTC-Zeit mit geändertem Inhalt bleibt erhalten; Duplikate überschreiben
  weder Empfangszeit noch Werte. Events haben unveränderte UUIDs bei Commit-Retry.
- Kein SQL im MQTT-Callback. Bounded RAM-Queue 256 + ausstehender Record/Gap-Zähler,
  manuelle ACKs erst nach Commit/bestätigtem Duplikat. Generation + Delivery-Version
  schützen auch gegen MID-Wiederverwendung in derselben Verbindung. Ungültige
  Payloads werden bewusst verworfen, Überlauf/DB-Ausfall pausiert nur Collector-MQTT.
- Explizites `--migrate` mit CREATE/SELECT/INSERT-Account; Runtime SELECT/INSERT,
  keine automatische DDL/Löschung. Secrets per Datei, Runtime non-root 10001,
  readonly/cap-drop/tmpfs, Readiness ohne Webserver. SIGTERM versucht 8 s zu drainen;
  Query/DNS kann darüber hinaus verzögern, Compose-Stop 20 s bleibt Prozessgrenze.
- Alte/zukünftige valide Samples werden als Archiv gespeichert, nicht als live
  angeboten. Keine lückenlose Aufzeichnung: retained ist kein Replay, RAM geht
  bei Crash/Restart verloren. Startup-/Gap-Ereignisse markieren unbekannte Abdeckung.
  Keine automatische Aufbewahrungs-/Backup-Policy und keine RFID-/UART-/DTSU666-
  Datenerfassung. Die optionale Website-Historie liest separat und verändert den
  Schema-1-Collectorvertrag nicht; zusätzliches Schema 2 ist separat und explizit
  zu aktivieren. Browserpuffer selbst bleibt im Tab-RAM.
- Docker-CI `37209898185` für `50794db` erfolgreich: 32 Unit- und 7 isolierte
  MariaDB-10.11-/MQTT-Integrationstests sowie non-root/readonly Runtime-Smoke ohne DB.
  Prüft auch defekte bereits registrierte Schemas, eingeschränkte Runtime-Grants,
  Retained/Restart-Deduplizierung, DB-Recovery, ACK-MID-Eigentum und fail-closed
  Secretdateien. Gap-`dropped` zählt Records inklusive Collectorereignisse, nicht
  die Zahl fehlender Hardwaremessungen. Pi-Empfang inzwischen wie oben bestätigt;
  diese CI selbst bleibt ein isolierter Nachweis. Bei Wiederinstallation konkrete
  DB-Version, Netzwerke, Accounts/Grants, TLS-Anforderungen und Backups prüfen.
- Der Projektinhaber bestätigt am 2026-10-04 per `docker ps`-Screenshot den laufenden MariaDB-
  Container `maria_uno`, Image `mariadb:lts`, Hostport 3306 an IPv4/IPv6 allen
  Schnittstellen. `lts` ist keine konkrete Serverversion; Volume,
  Accounts und tatsächliche Port-Erreichbarkeit/Firewall sind dadurch nicht bestätigt.
  Vorhandenen Container/Volumes beibehalten, keine Port-/Netzwerkänderung ausgeführt.
  Ebenso sind `grafana`, `elastic_lumiere`, Reader und Weboverlay-Container gelistet;
  letzterer bindet 127.0.0.1:8080. Das beweist Containerbetrieb, nicht HTTP-/MQTT-
  Readiness oder korrekte Browserwerte. `deb-mbpoll` ist ebenfalls gelistet; daraus
  keinen tatsächlich laufenden Modbus-Master ableiten, Parallelzugriff weiter vermeiden.
- Zweiter Screenshot: MariaDB ist nur im Standardnetz `bridge`, keine Aliases;
  kein bestätigter DB-Netzzugang für den Collector. `mariadb -u root -p -e
  'SELECT VERSION();'` wurde mit 1045 (`root@localhost`, Passwort verwendet)
  abgewiesen. Ursache/Adminzugang nicht bekannt, kein Reset/Containerneustart.
  Installierte Server-Binary-Version ersetzt nicht den Nachweis erfolgreichen DB-Zugangs.
- Dritter Screenshot: `mariadbd --version` meldet **11.8.8-MariaDB-ubu2404, aarch64**;
  Docker-Volume mit langem generiert wirkendem Namen, Driver `local`, RW nach
  `/var/lib/mysql`. Das ist persistente Datenhaltung, kein Backup-/Restore-Nachweis.
  Volume/Container nicht löschen oder neu initialisieren. Vorhandene Start-/Compose-
  Definition weiter unbekannt. CI `37212624186` für `d30f00f` bestätigt je
  39 Tests + Runtime für 10.11.19, exakt 11.8.8 und 11.8.9 (rollender 11.8-Tag).
  CI ist amd64, kein Pi-ARM64-/Adminzugangs-/Deploymentnachweis;
  keine Änderung am Produktionsserver. Loginfreie Version nicht mit `SELECT VERSION()`
  oder bestätigter Admin-Authentifizierung gleichsetzen.
- Historischer Stand am 2026-10-04: Projektinhaber meldete **keinen DB-Adminzugang**.
  Damals war die Pi-Provisionierung/Migration blockiert; berechtigten Betreiber
  bzw. ursprüngliche lokale Compose-/Env-/Secret-Einrichtung klären.
  Root-Passwort muss nicht an Projektinhaber/Agent
  gegeben werden: Betreiber kann eigenes EVSE-Schema/least-privilege Accounts
  bereitstellen. Keine weiteren Passwortversuche, Secret-Ausgaben, neue Produktions-
  DB oder Reset ohne separaten Auftrag; gesichertes Recovery wäre eigener Abschnitt.
- Der Projektinhaber hat MariaDB **nicht selbst eingerichtet**. Bestehenden Einrichter/
  berechtigten Betreiber nur bei gewünschter Rechtehärtung um eingeschränkten
  Collector-Account bitten; aktuell wird bewusst das Bestandskonto `smart` genutzt.
  Separates EVSE-Schema nur als Alternative; aktuell freigegeben ist `energyControl`.
  Weiterhin keine fremden Credentials auslesen oder Server-Authentifizierung ändern.
  Root ist kein Pflichtaccount: Provisionierung braucht einen DB-Login mit
  CREATE USER/entsprechendem GRANT-Recht, Migration CREATE/SELECT/INSERT nur im
  freigegebenen Tabellenbereich, laufender Collector SELECT/INSERT an eigenen Tabellen.
  SSH-/Dockerzugang allein
  ersetzt SQL-Rechte nicht. Entwicklung/isolierte Tests können unabhängig weitergehen.

## Geplant / noch nicht implementiert

- Tatsächliche Pi-Aktivierung/Migration und Prüfung des implementierten Kalender-
  archivs/Backfills bis ein Jahr; keine Remote-/Langzeit-/Ausfallnachweise durch CI.
- Dauerbetriebs-/Fehlerfallprüfung und weitere Hardwarevalidierung der ABB-Abfragen sowie
  anschließende Pi-Modbus-Steuerung der ABB Terra AC.
- DTSU666-Messwerterfassung und Berechnung verfügbarer Ladeleistung.
- UART-MQTT-Gateway und dessen Topic-/Payload-Vertrag. Wallbox-Telemetrie ist definiert.
- Weitergehender Websiteumbau und echte Handyabnahme der separat implementierten
  Smartphone-PWA; zunächst lokales HTTPS mit eigener CA ohne Domain, spätere
  konfigurierbare Domainanbindung vorgesehen. Zielbrowser/Vertrauensinstallation
  und weitergehende mobile Gestaltung offen. Keine native App/Home-Assistant-
  Integration als Teil dieser Planung.
- Bedienende Website (inklusive modularer Wallbox-Einrichtungsfunktion),
  Gezielte Pi-/Langzeit-/Fehlerfallvalidierung der optionalen lesenden SQL-Historie und weitere Datenmodelle für
  Ladesessions, UART/RFID und Zählerdaten.
- Ladeautomatisierung nach verfügbarer Leistung und Dringlichkeit mit den drei
  geplanten Modi „Laden wenn Solarstrom“, „Laden ohne Solarstrom“ und
  „Benutzerdefiniert“; Detailregeln siehe Anforderungen oben.
- Gemeinsamer Compose-Einstieg für getrennte modulare Pi-Projektdienste,
  erst später umzusetzen. Konkrete Dienste/Startabhängigkeiten und kontrollierte
  Migration der bisherigen Einzel-Stacks noch offen; bestehende Infrastruktur
  bleibt extern. Kein Container-Orchestrator im Projekt und kein Docker-Socket-
  Zugriff für den fachlichen Ladecontroller.
- Tatsächliches ESP32-Flashen und Hardware-/Fehlerfallprüfung der neuen
  RFID-Allowlist/Persistenz/LEDC-Startreihenfolge; geschützte Webkonfiguration
  über das weiterhin geplante UART-MQTT-Gateway.
- Anforderungen mit dem Lehrer sowie Diplomarbeitsanmeldung abstimmen.

Wallbox-Decoder-/Simulationstests stehen unter `rasppi/wallbox/tests/`;
`esp32/tests/` enthält native Core-/UART-Tests und simulierte Firmwareadaptertests,
`esp32/test/README` verweist auf Docker-Test-/Flashablauf. Vorhandene Verdrahtung und
berichtete frühere Tests nicht mit aktuell durchgeführten Hardwaretests gleichsetzen.

## Wichtige Modbus- und Sicherheitsgrenzen

- `mbpoll` bleibt Diagnosewerkzeug. Der neue Reader verwendet die C-Bibliothek
  libmodbus (https://libmodbus.org/) direkt aus C++; das bestehende
  Python-UART-Skript wurde nicht ersetzt. Kein Parsen von mbpoll-Textausgaben.
- Laut ABB-Handbuch v1.7 werden Holding Registers mit Funktionscode 03 gelesen:
  libmodbus `modbus_read_registers()`, bei `mbpoll` Typ `-t 4`.
  Vorhandene Beispiele verwenden teilweise `-t 3` (Input Registers/FC04).
  Tatsächliche Geräte-/Firmwareunterstützung prüfen; Typnummer und Funktionscode
  nicht gleichsetzen. Zum Prüfen zunächst 16-Bit-Rohregister auslesen.
- ABB-Registerwerte und Registerbreiten im Handbuch prüfen. Viele Werte
  belegen zwei 16-Bit-Register; Stromlimit `0x4100` ebenfalls.
- Sessionsteuerung `0x4105`: 0 = Start, 1 = Stop.
  Wallbox-Socket-Lock `0x4103`: 0 = Unlock, 1 = Lock.
  Dieser Wallbox-Lock ist nicht der separate ESP32-Servo.
- Achtung: `modbusRegisters.txt` bestätigt oben 0=Start/1=Stop, dreht diese
  Werte unten aber um. Bis zur Klärung am passenden Herstellerhandbuch keine
  Steuerlogik aus der widersprüchlichen Passage ableiten. Ebenso behauptet die
  Datei Entriegelung unabhängig vom Ladezustand; Sicherheitsbedingungen des
  Herstellerhandbuchs weiter beachten.
- Neue Notizen führen `0x4022` als per Modbus gesetztes Stromlimit auf,
  `0x4024` als Fallback-Limit und `0x4109` zum Setzen des Fallback-Limits.
  Unterstützung anhand Firmware/v1.11-Handbuch prüfen. Der spätere Verweis auf
  `0x4020` als Modbus-Stromlimit widerspricht der Tabelle: `0x4020` ist Timeout.
- Eine Registergröße von 1 bedeutet ein 16-Bit-Wort, nicht ein Byte.
  Ladezustand aus Byte 1, Bits 0–6 des 32-Bit-Wertes dekodieren
  (`(raw >> 8) & 0x7F`); Bit 7 separat behandeln. Zustand 5 („Others“) ist keine
  verlässliche Aussage „Fahrzeug angeschlossen, lädt nicht“.
- Wallbox-Polling-Timeout standardmäßig 60 s: sicher darunter pollen oder
  Timeout passend konfigurieren. Die dokumentierte Empfehlung 30–90 s
  widerspricht am oberen Ende diesem Standardwert; nicht ungeprüft übernehmen.
- Stromlimits unter 6 A pausieren das Laden. Tatsächliches Limit kann wegen
  internem Lastmanagement abweichen; Rückleseregister `0x400E` beachten.
- Socket-Unlock nur ohne laufende Session; Handbuchbedingungen beachten.
- DTSU666 hat eigene Parameter: Handbuch beschreibt u. a. Modbus-Adresse 1,
  9600 Baud, 8N1. Gerätevariante und physische Konfiguration vor Nutzung prüfen;
  nicht mit den Wallbox-Parametern verwechseln. RS485: Klemme 24=A, 25=B.
- Zähler-Messwerte sind laut Handbuch zweiregistrige IEEE754-Floats in ABCD-
  Reihenfolge; Wandlerverhältnisse/Skalierung berücksichtigen.
- Unterschiedliche serielle Geräteeinstellungen nicht ungeprüft auf einen
  gemeinsamen Bus legen. Chint ist nicht in ABBs dokumentierter Liste
  kompatibler Zähler enthalten; geplante Erfassung erfolgt durch den Pi.
- Arbeiten an Netzspannung/Zählerinstallation nur durch qualifiziertes Personal.
  CP/PP-Ladesignale sind keine direkt anschließbaren ESP32-GPIO-Signale.

## Entwicklungsablauf

1. Zuerst `AGENTS.md`, relevante Quellen und `git status` lesen.
2. Vor Änderungen Remote-Stand synchronisieren/prüfen, ohne fremde lokale
   Änderungen zu überschreiben. Keine destruktiven Git-Befehle verwenden.
3. Änderungen auf einem Feature-Branch, nicht direkt auf `main`, durchführen.
4. Nur beabsichtigte Dateien committen; keine Secrets, generierten Dateien
   oder fremden Änderungen aufnehmen.
   Neue Commits immer mit dem GitHub-Benutzernamen des Projektinhabers als
   Autor- und Committername erstellen, nicht mit dessen Klar- oder Kurznamen;
   die bereits zugeordnete Commit-E-Mail beibehalten. Dies gilt auch bei
   Agent-Unterstützung und Bereinigungen.
   Keine Ersatzautoren wie `EVSE-Control-AGENT`, `EVSE-Control Agent` oder
   `EVSE-Control` und keine erfundenen Automationsadressen verwenden.
   Vor jedem Commit `git var GIT_AUTHOR_IDENT` und `git var GIT_COMMITTER_IDENT`
   prüfen; bei fehlender oder unklarer Identität nachfragen statt raten.
   Einstellungen nur repositorylokal setzen, globale Git-Konfiguration nicht
   ändern. Abweichende Autor-/Committer-Overrides nicht verwenden.
5. Relevante Tests/Builds und Dokumentation prüfen; nicht ausgeführte oder
   hardwareabhängige Prüfungen ausdrücklich benennen.
6. Bei jeder Code-, Dokumentations- oder Infrastrukturänderung `CHANGELOG.md`
   mit aktuellem Europe/Vienna-Zeitstempel ergänzen, neueste Einträge oben.
7. Pull Request erstellen, sofern im Auftrag vorgesehen und Zugriff vorhanden.
   **Der Projektinhaber führt den Merge selbst durch**, außer er erteilt ausdrücklich eine
   Ausnahme. Commit/Push/PR-Status wahrheitsgemäß berichten.

Historische Commit-/Branch-Angaben aus älteren Zusammenfassungen immer mit Git
prüfen. Ebenso war ein PlatformIO-Build auf NixOS durch die dynamisch gelinkte
Xtensa-Toolchain blockiert; Lösungsoptionen waren `nix-ld`, `patchelf` oder FHS.
Das ist kein bestätigter aktueller Windows-Buildfehler. Betriebssystem und
verfügbare Toolchain jeweils prüfen; ohne Buildlauf keinen Build-Erfolg behaupten.

## Diese Datei regelmäßig aktualisieren

### Datenschutz bei Dokumentation und Änderungen

- Keine persönlichen Namen, SSH-Ziele oder Benutzer-Homepfade in neue Beispiele,
  Changelog-Einträge oder Berichte übernehmen; Rollen und Platzhalter verwenden.
- Funktionsrelevante personenbezogene Angaben zuerst melden, nicht ungefragt
  entfernen/ersetzen. Der persönliche Compilerpfad in
  `esp32/.vscode/settings.json` bleibt bis zu einer gesonderten Entscheidung
  unverändert; er betrifft die lokale Editorintegration, nicht die Firmwarelaufzeit.
- Git-Autor-/Committerdaten, historische Dateien und öffentliche Repository-/CI-
  Referenzen sind nicht durch eine Bereinigung des aktuellen Dateistands entfernt.
  Keine Historienumschreibung, Änderung bestehender Commitidentitäten,
  Secretrotation oder Anpassung von Deployment-/Zugangsdaten ohne gesonderten
  Auftrag. Neue Bereinigungscommits ebenfalls unter der persönlichen
  Git-Identität des Projektinhabers erstellen (siehe Entwicklungsablauf);
  die frühere Vorgabe anonymisierter Autoren gilt nicht mehr.
  RFID-UID-Ausgabe erfolgt nur zur
  bewussten Aufnahme am Pi-UART, USB redigiert. Keine echte UID in Code, Chat,
  CI oder Repository hinterlegen; nur private lokale Notiz für Widerruf.
- Herstellerreferenzen/Urheberhinweise nicht mit privaten Projektdaten verwechseln.

**`AGENTS.md` ist aktiv zu pflegen, kein einmaliger Übergabetext.**

- Bei Änderungen an Architektur, Protokollen, Hardware/Pins, Verhalten,
  Anforderungen, Arbeitsregeln oder bekannten Blockern im selben Arbeitsgang
  den betroffenen Abschnitt aktualisieren.
- Nach abgeschlossenen Entwicklungsabschnitten und vor einer Übergabe den
  gesamten Kontext mit Code und Dokumentation abgleichen.
- Alle für Betrieb/Wiederinstallation nötigen Befehle, Voraussetzungen,
  Netzwerk-/Gerätezuordnungen und Änderungen im Installationsguide pflegen.
- Neue Funktionen erst nach tatsächlicher Implementierung von „geplant“ nach
  „implementiert“ verschieben. Veraltete Aussagen entfernen oder klar als
  historisch markieren; keine bloßen Absichten als Tatsachen dokumentieren.
- Das Standdatum bei inhaltlichen Aktualisierungen erneuern und die Änderung
  in `CHANGELOG.md` vermerken. Keine Secrets oder unnötigen lokalen Details
  in dieser Datei speichern.
