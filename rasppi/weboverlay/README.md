# Lesendes Weboverlay

Eigenständiger Docker-Dienst, **PHP-Migration implementiert und Docker-getestet**:
ein PHP-CLI-MQTT-Subscriber → privater atomarer Snapshot → PHP 8.4/Apache →
unveränderte deutsche Browseranzeige. Kein Hardwarezugriff, keine Publish-
oder Steuerbefehle, keine Datenbank. Bestehender Broker im Netzwerk `evse-mqtt`.

**Spätere Planung:** Die Website soll umgebaut werden; anschließend ist eine
Smartphone-WebApp vorgesehen. Umfang, Gestaltung und technische Umsetzung
sind noch offen. Beides ist noch nicht umgesetzt; die bestehende responsive
Browseranzeige bleibt unverändert und ist nicht bereits die geplante WebApp.
Ein eigenes Home-Assistant-Modul wird nicht entwickelt. Die jetzt autorisierte
Backendmigration war kein visueller Umbau. Separat ist nun das Theme
„Compact / Dense“ nach Entwurf Nr. 8 umgesetzt: kühle Blau-/Grautöne,
dezente Verläufe, feine Rahmen, Schatten und kompaktere Abstände in Hell/Dunkel.
Die Vorlagen dienen nur als Theme-Referenz; Sidebar, vier Übersichtskarten,
Messwerte und Seitenaufteilung bleiben erhalten. **Darstellung** oben auf beiden
Seiten bietet **System / Hell / Dunkel**. Default System folgt live der
Browser-/OS-Präferenz; Hell/Dunkel überschreibt sie und wird unter `evse-theme-v1`
gespeichert. System entfernt den Schlüssel. Nur ein Darstellungswert, keine
Messwerte oder Credentials; `evse-display-v1` bleibt unabhängig. Bei blockiertem
Speicher gilt die Auswahl nur für die aktuelle Seite; bei Pageshow bleibt eine
nicht speicherbare Wahl erhalten. Gespeicherte Wahl wird bei Pageshow/Storage-
Ereignissen neu geladen. Ohne JS bleibt das Feld deaktiviert, Systemfarben wirken
weiter. Selbst gehostetes `theme.js` vor CSS, keine CSP-Ausnahme oder API-Steuerung.
PHP-/MQTT-/Messwertverhalten, C++-Reader, UART-Brücke und Speichercollector bleiben
unverändert. Umschalter-CI
[40375388768](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/40375388768)
für `53ce565` erfolgreich: 37 JS-Tests (neun neue Theme-Unitfälle), vier Chromium-
Suiten mit 22 Theme-Browserfällen sowie vollständige Backend-/Runtime-Prüfungen.
Erzwungene Hell-/Dunkelansicht am Desktop und mobil mit simulierten Werten geprüft;
noch kein Pi-Nachweis für den neuen Umschalter. Bisherige Theme-CI
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
Wallbox-Limit; Phasenmessung und Leistungsrahmen darunter. Technische Rohwerte
unter „Diagnose & Datenqualität“. Datenstatus, Messzeit, Frische und aktive
Fehlerwarnungen bleiben außerhalb der einklappbaren Bereiche sichtbar.

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
- Apache non-root UID 10001, intern Port 8080, plus genau ein PHP-CLI-Worker;
  `php-mqtt/client` exakt 2.3.2, Abhängigkeiten exakt über `composer.lock` im
  Docker-Build. Kein PHP/Composer auf dem Host installieren; kein Python in
  Websitebackend, Runtime, Healthcheck oder Backendtests.
- Bash überwacht beide Prozesse: unerwarteter HTTP-/Workertod beendet den anderen
  und den Container mit Fehler; SIGTERM stoppt beide. Bei Brokerausfall bleibt
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

Docker-CI [40365837026](https://github.com/MarioL-Tech/EVSE-Control/actions/runs/40365837026)
für `06a3626` erfolgreich: 16 PHP-Zustands-/Config-Fälle, IPC-Suite,
21 Transportfälle, vier echte MQTT-/HTTP-/Auth-/ACL-Szenarien, 28 JS-Tests und
drei Chromium-Suiten sowie non-root/readonly Runtime ohne Broker/Python.
Installation aus committed Composer-Lock und Bytevergleich ebenfalls bestätigt.
Prüfsystem Linux-amd64, kein Pi-ARM64-/Produktionsnachweis; alte Python-CI historisch.
Testbroker nur im Build-Container; Produktivbroker/Hardware werden nicht berührt.
Pi-Start und Live-Übersicht im Dark-Theme am 2026-10-26 vom Projektinhaber per
Screenshot bestätigt (18:52:39, MQTT online, angeschlossen/nicht ladend, Limit 6 A).
Keine Bestätigung von Langzeitbetrieb, gezielten Ausfällen, Diagrammen, Hellansicht
oder des neuen manuellen Umschalters; kein Agent-Deployment.
