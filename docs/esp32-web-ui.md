# ESP32-Webbedienung: Integration

Nur simulierte Browserprüfungen, kein Hardware-/Flashnachweis. Das Modul
`rasppi/weboverlay/static/esp32.js` wird auf Übersicht und Settings als externes
Script mit `defer` geladen. Kein Modul auf Diagrammen erforderlich. Pro Seite
genau eine der folgenden Wurzeln bereitstellen. Klassen/Layout kommen vom
bestehenden Theme; Buttons initial deaktivieren und unbedingt `type="button"`.

Übersicht: innerhalb der manuellen Wallboxbedienung, unabhängig von deren
Fehlerstatus. Das Gateway darf deren Bedienelemente niemals sperren.

```html
<section id="esp32-control" aria-labelledby="esp32-heading">
  <h3 id="esp32-heading">Diebstahlsicherung</h3>
  <p id="esp32-status" role="status">ESP32 noch nicht geprüft.</p>
  <p id="esp32-state">Verriegelungsziel unbekannt</p>
  <button type="button" id="esp32-lock" disabled>Aktivieren</button>
  <button type="button" id="esp32-unlock" disabled>Deaktivieren</button>
  <p id="esp32-result" role="status">Noch keine Aktion.</p>
</section>
```

Settings: außerhalb des Konfigurationseditor-Formulars. Keine UID-Liste,
kein gespeicherter UID-Wert, kein Bestätigungsdialog mit UID-Echo.

```html
<section id="esp32-rfid" aria-labelledby="esp32-rfid-heading">
  <h3 id="esp32-rfid-heading">RFID-Karten</h3>
  <p id="esp32-rfid-status" role="status">ESP32 noch nicht geprüft.</p>
  <p>Karten: <span id="esp32-rfid-count">Unbekannt</span></p>
  <p id="esp32-rfid-enrolling">Unbekannt</p>
  <p>Anlernen: 30 Sekunden, eine frisch aufgelegte Karte.</p>
  <button type="button" id="esp32-enroll" disabled>Anlernen starten</button>
  <button type="button" id="esp32-cancel" disabled>Abbrechen</button>
  <label for="esp32-uid">Private Karten-UID zum Widerrufen</label>
  <input id="esp32-uid" type="password" autocomplete="off"
         autocapitalize="off" spellcheck="false" maxlength="29">
  <button type="button" id="esp32-revoke" disabled>Karte widerrufen</button>
  <p id="esp32-rfid-result" role="status">Noch keine Aktion.</p>
</section>
```

Die Modusauswahl meldet am `window` das Ereignis `evse:manual-mode` mit
`detail: {manual: boolean}`. Default ist manuell. PV und Custom melden `false`:
Übersichtswurzel ausblenden, Abfragen abbrechen, laufenden Schreibausgang als
unbekannt erhalten. Settings bleibt unabhängig. Rückkehr/Seitenaktivierung
führt ausschließlich eine neue Inspektion aus, niemals einen Schreibauftrag.

API: `/api/esp32-control`, GET alle fünf Sekunden bei sichtbarer erlaubter
Seite, 4-s-Timeout. POST ausschließlich explizite Aktionen, 12-s-Timeout,
`X-CSRF-Token` aus der Inspektion. Maximal eine aktive Anfrage pro Seite.
Keine Wiederholung/Offlinequeue. Anzeigen laufen nach maximal acht Sekunden
ab Requestbeginn ab (inklusive Roundtrip), beide Uhren werden geprüft.
Abbruch ist kein Hardware-Storno. Ein späteres GET löst einen unbekannten
Schreibausgang nicht nachträglich auf. UID wird nur beim Widerruf kopiert und
das Passwortfeld sofort geleert; keine URL-/Storage-/Logübernahme.

Bestätigung bedeutet Firmwareziel/Persistierung, keine tatsächliche mechanische
Endposition. Kein Bootpolicy-Workaround und kein Legacy-Firmwarefallback.
Der Ladezustand ist nur eine weitergeleitete Hardware-Spiegelung und kein
Nachweis einer Wallboxsteuerung; die Oberfläche zeigt ihn hier nicht an.

Parent muss HTML/CSS, Routing/Static-Serving, Shellgeneration und Docker-CI
integrieren sowie `CHANGELOG.md`/`AGENTS.md` ergänzen. Alle bestehenden
Browserfixtures bekommen eine unabhängige unavailable-Antwort dieses neuen
API-Endpunkts. Neue Prüfungen ausschließlich im bestehenden Docker-Harness:
`node --test tests/esp32.test.cjs` und `node tests/esp32-browser.cjs`.
Browser nutzt `TEST_URL`/`WEB_TEST_URL`, `ARTIFACT_DIR` und bestehendes Playwright.
Erzeugte Bilder: `ESP32manual1440dark.png`, `ESP32manual390light.png`,
`RFIDsettings320light.png`. Keine Tests auf dem Host ausführen.
