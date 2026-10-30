# Lademodus: Frontend-Integrationsvertrag

`rasppi/weboverlay/static/charging-mode.js` besitzt ausschließlich die drei
nativen Radios und die kompakte Statuszeile. Keine Hardwarezugriffe, Styles,
Settingsspeicherung, weiteren Worker oder Ladezustandsableitungen.

## Markup und Eigentümer

Auf der Übersicht innerhalb `#wallbox-control`:

```html
<input type="radio" name="charging-mode" id="control-mode-pv">
<input type="radio" name="charging-mode" id="control-mode-manual">
<input type="radio" name="charging-mode" id="control-mode-custom">
<p id="automation-status" role="status"></p>
```

Bestehende Labels/Karten verwenden. Script nach dem Markup laden. Bisherige
Radiohandler und Checked-/Disabled-Schleifen des Wallboxclients entfernen.
Kein zweiter Besitzer dieser Radios; keine zusätzliche Freischalttaste.

## Ereignisse auf `window`

* Eingang `evse:automation-observation`, Detail `{automation: object|null}`:
  Wallboxclient liefert bevorzugt `command.automation`, sonst
  `inspection.automation`. Exakt validierte Readerdaten; nicht das PHP-Flag
  `automation_available`. Fehlende/ungültige Erweiterung bedeutet Legacyreader:
  Manuell anzeigen, PV/Custom sperren, bestehende manuelle Bedienung erhalten.
* Eingang `evse:wallbox-busy`, Detail `{busy:boolean}`: manueller Auftrag sperrt
  Karten und bricht eine laufende Modusanfrage lokal ab. Stop bleibt immer
  unabhängig bedienbar und erhält durch den Reader einen neuen kausalen Guard.
* Ausgang `evse:automation-mode`, Detail `{mode,supported,pending}`: Start und
  Übernehmen nur bei `mode === 'manual' && !pending` UND bisherigen technischen
  Grenzen freigeben. Stop niemals an diese Bedingung koppeln. Parent erzeugt
  `evse:manual-mode` für ESP32-Sichtbarkeit; ESP32-Ausfälle sperren Stop nicht.
* Ausgang `evse:refresh-control`: nach einer expliziten Anfrage einmalige
  Read-only-Inspektion durch den Parent. Kein zusätzlicher Inspektionspoller;
  bestehende Beobachtungen kommen über dessen 15-Sekunden-Pfad.

## Ablauf und Bedeutung

Nur expliziter Klick (auch erneut auf dieselbe Karte) oder Pfeiltaste aktiviert:
frisches `GET /api/wallbox-control` (12 s), dann
`GET /api/charging-mode` (4 s), exakt ein POST (5 s):
`{mode,revision,config_revision,guard}` und `X-CSRF-Token` der eigenen Modus-Session.
Gesamt maximal 21 s an Requestfristen. Same-origin-Credentials, keine Caches,
keine Wiederholung, Warteschlange oder Browserpersistenz. Antwortkörper strikt
auf 16 KiB begrenzt, ungültiges UTF-8/JSON, doppelte Schlüssel und unbekannte
Statuscodes der Automation werden abgelehnt. Readerguard ist kein Auth-Token.

POST-Erfolg heißt **angefordert**, nicht aktiv/lädt. Erst passende Reader-ID,
Guard und Konfigurationsrevision erlauben dessen festen Zustandslabel.
`manual_override` zeigt stets Manuell; `awaiting_activation` verlangt erneute
Wahl; `frozen` bleibt gesperrt gemeldet. Manuell auswählen ist kein Stop.
Settings speichern aktiviert nichts; der Backend-POST erfasst das Profil.
HTTP 400 mit bekannten Pflichtfeldern zeigt ausschließlich feste deutsche Labels
und Settingshinweis; 403/409 werden nicht wiederholt. Bei möglichem POST-Versand
bleibt „Ausgang unbekannt“ über Vordergrundwechsel und Beobachtungen erhalten,
bis eine neue bewusste Wahl erfolgt. Browserabbruch ist kein Serverstorno.
Lebenszyklus-/Uhrsprünge verwerfen Antworten, niemals Aktivierungen wiederholen.

CommonJS-Exporte: `MODES`, `STATES`, `HTTP`, `REQUIRED`, `automation`,
`strictJSON`, `modeResponse`, `controlResponse`, `readBody`, `mount`.

## Prüfungen

Parent registriert ausschließlich Dockerläufe für
`tests/charging-mode.test.cjs` (Node-Test-Runner) und
`tests/charging-mode-browser.cjs` (gepinntes Playwright-Image).
Browserprüfung nutzt eigenständiges Minimalmarkup und simulierte APIs; sie
ersetzt keine integrierte Seitenprüfung oder Pi-/Hardware-/Produktionsabnahme.
Bei Erstellung nicht ausgeführt; keine Hostausführung oder Installation.
