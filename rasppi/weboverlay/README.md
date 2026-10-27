# Lesendes Weboverlay

Eigenständiger Docker-Dienst, **PHP-Migration implementiert und Docker-getestet**:
ein PHP-CLI-MQTT-Subscriber → privater atomarer Snapshot → PHP 8.4/Apache →
deutsche Browseranzeige. Zusätzlich optional: eigener PHP-CLI-HTTP-Worker für
die Haus-Netzleistung. Keine seriellen Ports, Publish-/Steuerbefehle oder Datenbank.
Bestehender Broker im Netzwerk `evse-mqtt` bleibt unverändert.

**Spätere Planung:** Die Website soll umgebaut werden; anschließend ist eine
Smartphone-WebApp vorgesehen. Umfang, Gestaltung und technische Umsetzung
sind noch offen. Beides ist noch nicht umgesetzt; die bestehende responsive
Browseranzeige bleibt lesend und ist nicht bereits die geplante WebApp.
Ein eigenes Home-Assistant-Modul wird nicht entwickelt. Die jetzt autorisierte
Backendmigration war kein visueller Umbau. Separat ist nun das Theme
„Compact / Dense“ nach Entwurf Nr. 8 nochmals präzisiert: dunkle Graphitflächen,
feine blau-graue Rahmen, 6-px-Kartenecken, ruhige Verläufe/Schatten, cyanfarbene Leistung,
gefüllte mintfarbene Live-Badges und kräftigere Schriftgewichte. Heller Modus
neutral-kühl. Nur CSS-Designwerte geändert; keine neuen Abstände, Größen, Grids,
Breakpoints, HTML-/JS- oder Funktionsänderungen. Neue Design-CI/Sichtprüfung offen.
Die Vorlagen dienen nur als Theme-Referenz; Sidebar, vier Übersichtskarten,
Messwerte bleiben erhalten. **Links unten** wechselt ein nativer
**Schiebeschalter** mit beweglichem Sonne-/Mond-Schieber und LIGHT/DARK MODE
zwischen Hell/Dunkel (160×52 px, Tastatur/Screenreader). Am Desktop im Sidebar-Fuß,
mobil unten links fixiert. **Settings mit Zahnrad unter Diagramme** öffnet
`/einstellungen`, einen ausdrücklich gekennzeichneten
Platzhalter ohne Lade-/Hardwareeinstellungen. Dort setzt **Systemdarstellung
verwenden** die lokale Wahl zurück. Default System folgt live der
Browser-/OS-Präferenz; Hell/Dunkel überschreibt sie und wird unter `evse-theme-v1`
gespeichert. System entfernt den Schlüssel. Nur ein Darstellungswert, keine
Messwerte oder Credentials; `evse-display-v1` bleibt unabhängig. Bei blockiertem
Speicher gilt die Auswahl nur für die aktuelle Seite; bei Pageshow bleibt eine
nicht speicherbare Wahl erhalten. Gespeicherte Wahl wird bei Pageshow/Storage-
Ereignissen neu geladen. Ohne JS bleiben Schalter/Reset deaktiviert, Systemfarben wirken
weiter. Selbst gehostetes `theme.js` vor CSS, keine CSP-Ausnahme oder API-Steuerung.
Wallbox-API, MQTT, C++-Reader, UART-Brücke und Speichercollector bleiben
unverändert. Schiebeschalter-/Textbereinigungs-CI **40491901055 für 13b8a20**
erfolgreich: 49 JS-Tests und alle fünf Chromium-Suiten mit 30 Theme-/Settings-
Fällen, nativer Checkbox, sichtbarer Schieberbewegung, Leertaste, Sidebar-
Reihenfolge/Links-unten-Position und allen bisherigen Backend-/Runtime-Prüfungen.
320/390/768/1440 px in Hell/Dunkel geprüft; Desktop-/Mobilbilder mit simulierten
Werten angesehen. Neue Pi-Prüfung und Hauszählerkonfiguration offen.
**Historische Symbolschalter-/Haus-Smartmeter-CI 40486476429 für 3c92398 erfolgreich:**
80 neue PHP-Prüfungen, 17 isolierte HTTP-Szenarien, insgesamt 49 JS-Tests und
fünf Chromium-Suiten (30 Theme-/Einstellungsfälle), alle bisherigen Backend-/
Runtime-Prüfungen. Simulierte Desktop-/Mobilbilder in Hell/Dunkel angesehen.
Kein echter Smartmeterabruf/Pi-Nachweis. Historische Auswahlfeld-CI
[40375388768](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/40375388768)
für `53ce565` erfolgreich: 37 JS-Tests (neun neue Theme-Unitfälle), vier Chromium-
Suiten mit 22 Theme-Browserfällen sowie vollständige Backend-/Runtime-Prüfungen.
Erzwungene Hell-/Dunkelansicht am Desktop und mobil mit simulierten Werten geprüft;
kein Nachweis der neuen Symbolschalter oder des Hauszählers am Pi. Bisherige Theme-CI
[40369056814](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/40369056814)
für `ff496f2` erfolgreich: beide Seiten in Hell/Dunkel bei 320/390/768/1440 px,
Farbschemawechsel und Textkontrast auf geprüften Flächen mindestens 4,5:1.
Simulierte Desktop-/Mobil-Screenshots geprüft; kein Pi-Deploymentnachweis.

## Start auf dem Pi

Aus dem Repository-Verzeichnis, bei laufendem Reader und vorhandenem Broker:

```bash
cd rasppi/weboverlay
docker compose up -d --build
```

Auf deinem Rechner mit dem **bereits verwendeten SSH-Ziel**:

```bash
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8080:127.0.0.1:8080 'BENUTZER@PI-ADRESSE'
```

`BENUTZER@PI-ADRESSE` durch dein vorhandenes SSH-Ziel oder deinen SSH-Alias ersetzen;
dieses tatsächliche Ziel nur lokal aufbewahren, nicht im Repository.
Browser: **http://127.0.0.1:8080**. SSH-Tunnel offen halten. Hostport ist nur an
Pi-Localhost gebunden, kein neues Internet-/LAN-Portmapping. Keine SSH-/WG-Änderung.

Alle Schritte zu Konfiguration, Passwortdatei, Portkonflikten, Diagnose und Tests:
[zentraler Installationsguide](../../docs/installation.md#9-lesendes-weboverlay).

## Übersicht und eigene Diagrammseite

**Übersicht `/`:** kompakte Karten für Leistung, Fahrzeug, Sessionenergie und
Wallbox-Limit; darunter Phasen und Haus-Netzleistung nebeneinander (mobil
untereinander). Repetitive Hinweise gekürzt, Infokarte „Leistungsrahmen“ entfernt;
„Unter Sollstrom“ bleibt unter „Diagnose“ erhalten. Technische Rohwerte
ebenfalls dort. Datenstatus, Messzeit, Frische und aktive
Fehlerwarnungen bleiben außerhalb der einklappbaren Bereiche sichtbar.

**Netzleistung Haus:** eigener, von Wallbox/MQTT unabhängiger Bereich auf der
Übersicht mit Bezug (+)/Einspeisung (−), Status, letztem Abruf und Abrufalter.
Wert 7 wird aus W nach kW umgerechnet. Die 16 Wallbox-Präferenzen blenden ihn
nicht aus. Keine Hauskurve oder Speicherung in MQTT/MariaDB.

**Diagramme `/diagramme`:** über die gemeinsame Navigation öffnen. Vier
elektrische Zeitverläufe, weitere Zustands-/Rohwertkurven unter „Zustands- &
Diagnoseverläufe“. Beide Seiten unterstützen Desktop/Mobil und folgen dem
hellen/dunklen Farbschema des Browsers. Keine zusätzlichen Pakete/Ports nötig.

„Anzeige auswählen“ schaltet jeden der 16 Telemetriewerte und seine Diagrammkurve
einzeln ein/aus. Auswahl und Zeitfenster werden lokal im Browser gespeichert;
„Alle Messwerte anzeigen“ setzt sie zurück. Status, Messzeit und aktive
  Wallbox-Fehlerwarnung bleiben sichtbar. Bei blockiertem Browserspeicher gilt
die Auswahl nur für die geöffnete Seite; Credentials werden nie gespeichert.

SVG-Diagramme zeigen Leistung (kW), Phasenströme/Limit (A), Spannungen (V),
Sessionenergie (kWh) sowie getrennte Stufenverläufe für Anschluss/Laden und
Diagnosecodes/Rohwerte. Phasenkurven behalten beim Ausblenden ihre Farbe.
Zeitfenster: **1, 5 oder 15 Minuten**. Erst ein Messpunkt ist ein Punkt, keine Linie.

**Kein Datenbankarchiv:** maximal 15 Minuten/1200 Messzeitpunkte im RAM dieses
Browser-Tabs, nur seit Öffnen der **Diagrammseite** beobachtet. Neuladen oder
Seitenwechsel leert den Verlauf, auch Rückkehr über den Browser-Seitencache.
Die Übersicht sammelt keinen verdeckten Diagrammverlauf.
Wiederholte API-Polls zählen nicht als neue Messungen; bei gleicher Sekunden-
Zeitmarke bleibt der letzte beobachtete Wert. Fehler, Offline und unbekannte
Werte sind Lücken, nicht Nullwerte; Pausen über 10 s bleiben unverbunden.
Historische Kurven bleiben bei Ausfall sichtbar, während Live-Werte ausgeblendet
werden. Zwischenwerte während Browser-/Netzausfällen werden nicht nachgeladen.
Sessionenergie kann bei neuer Session zurückgesetzt werden, kein Gesamtsummenzähler.

## Datenmodell und Grenzen

- `GET /api/state`: normalisierter Read-only-Snapshot, niemals Credentials.
- `status`: `live`, `waiting`, `offline`, `stale`, `clock_error`, `invalid`, `read_error`.
- Nur `live` liefert `values`; sonst `null`, keine historischen Werte als aktuell.
- `reason`, `broker_connected`, `availability`, `timestamp`, `last_success_at`,
  `age_seconds`, `fresh_for_seconds`, `error` erklären Status/Restgültigkeit.
- Frische default 10 s; Empfangszeit allein reicht für retained Samples nicht.
  Monotone Ablaufzeit verhindert Wiederverjüngung bei lokaler Uhrkorrektur.
- Browser prüft Frische unabhängig von weiteren HTTP-Antworten und blendet bei
  Netzfehlern/abgelaufenen Daten Messwerte aus. Zeitstempel werden lokal dargestellt.
- `GET /healthz`: nur Prozess-/HTTP-Liveness; MQTT-Ausfall ist kein Neustartgrund.
- Apache non-root UID 10001, intern Port 8080, ein PHP-CLI-MQTT-Worker und ein
  unabhängiger PHP-CLI-Haus-Smartmeter-Worker (ohne konfigurierte URL nur Leerlauf);
  `php-mqtt/client` exakt 2.3.2, Abhängigkeiten exakt über `composer.lock` im
  Docker-Build. Kein PHP/Composer auf dem Host installieren; kein Python in
  Websitebackend, Runtime, Healthcheck oder Backendtests.
- Bash überwacht alle drei Prozesse: unerwarteter Prozessabbruch beendet die übrigen
  und den Container mit Fehler; SIGTERM stoppt alle. Bei Brokerausfall bleibt
  HTTP aktiv, Worker-Reconnect nach 1–30 s. Beide SUBACKs erforderlich;
  Reconnect verwirft Sample und Availability. MQTT-Restlänge maximal 32768 Bytes (ohne Festheader),
  Statepayload maximal 16384 Bytes.
- Privater tmpfs-Snapshot unter `/tmp/evse-weboverlay`, stabile flock-Datei mit
  maximal 200 ms Wartezeit, atomarer Austausch bis 64 KiB. Workerheartbeat alle
  250 ms; HTTP erneuert ihn nie. Nach 3 s Stillstand oder bei fehlendem/defektem
  Snapshot liefert die API fail-closed offline und keine Werte.
- Keine externen CDN-/Font-/Browser-MQTT-Abhängigkeiten, keine Zugangsdaten im JS.
- Kein HTTP-Login/TLS: nur vertrauenswürdiger Zugang über den vorhandenen SSH-Tunnel.
- MQTT-Vertrag: [Topics, Einheiten und Verfügbarkeit](../../docs/mqtt-protocol.md).

## Optionaler HTTP-Haus-Smartmeter

`SMARTMETER_URL` wird nur lokal in `.env` gesetzt, niemals in Git oder im Browser.
Leer (Default) bedeutet **Nicht eingerichtet**, nicht 0 W. Defaults: Abfrage 2 s,
HTTP-Timeout 2 s, Frische 10 s; Bereiche 1–60 / 1–5 / 3–120 Sekunden.
Zentraler Ablauf einschließlich Update/Diagnose:
[Haus-Smartmeter einrichten](../../docs/installation.md#haus-smartmeter-optional-einrichten).

Nur HTTP(S)-GET/200, keine Redirects oder Proxys; HTTPS-Prüfung bleibt aktiv.
Maximal 8 KiB Header/4 KiB Body, ASCII-Zahlenliste mit mindestens sieben
endlichen Zahlen. Nur Index 6 ist Netzleistung: **+ Netzbezug / − Einspeisung**.
Keine Berechnung verfügbaren Ladestroms oder Zuordnung zum geplanten DTSU666.

`GET /api/smartmeter` liest ausschließlich einen separaten 8-KiB-IPC-Cache:
`schema_version`, `read_only`, `status`, `reason`, `power_w`, `fetched_at`,
`age_seconds`, `fresh_for_seconds`. Nur `live` liefert eine Leistung;
sonst `null`. `fetched_at` ist die erfolgreiche HTTP-Empfangszeit, keine
Gerätemesszeit. Wiederholte gültige Antworten erneuern die Abruffrische, sind
aber kein Nachweis neuer Messungen im Gerät. Keine URL/Host-/Rohantwortausgabe.

Eigene stabile Lockdatei, maximal 200 ms Wartezeit, atomarer Austausch.
Heartbeat alle 250 ms zwischen Abfragen, Auslauf nach max(3 s, Timeout+1 s).
HTTP-Leser erneuern weder Heartbeat noch Abrufzeit. Fehler, Veraltung,
Zeitkorrekturen oder defekter Snapshot blenden Leistung aus; echte 0 bleibt
erlaubt. Browser-Timeout/Lifecycle/Frische laufen unabhängig von Wallboxwerten.
Blockierendes OS-DNS kann Prozessfristen beeinflussen; der Supervisor erzwingt
nach etwa 2 s das Stoppen verbliebener Kinder, Compose bleibt bei 10 s.
Docker-/Browsernachweis siehe oben; kein echter Smartmeterabruf bestätigt.

Docker-CI [40365837026](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/40365837026)
für `06a3626` erfolgreich: 16 PHP-Zustands-/Config-Fälle, IPC-Suite,
21 Transportfälle, vier echte MQTT-/HTTP-/Auth-/ACL-Szenarien, 28 JS-Tests und
drei Chromium-Suiten sowie non-root/readonly Runtime ohne Broker/Python.
Installation aus committed Composer-Lock und Bytevergleich ebenfalls bestätigt.
Prüfsystem Linux-amd64, kein Pi-ARM64-/Produktionsnachweis; alte Python-CI historisch.
Testbroker nur im Build-Container; Produktivbroker/Hardware werden nicht berührt.
Pi-Start und Live-Übersicht im Dark-Theme am 2026-10-26 vom Projektinhaber per
Screenshot bestätigt (18:52:39, MQTT online, angeschlossen/nicht ladend, Limit 6 A).
Websitezugriff und sichtbares bisheriges Auswahlfeld am 2026-10-27 erneut vom
Projektinhaber bestätigt. Neue Symbolschalter/Smartmeter, Langzeit-/Ausfalltests
und weitere Diagramm-/Hellansicht-Prüfungen am Pi offen; kein Agent-Deployment.
