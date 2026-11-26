# Ladeautomatisierung: Core- und Owner-Integrationsvertrag

Stand: 2026-11-26. Eigenständige Module auf Basis `c5ac0d7`, jetzt in den einzigen
Reader-Owner integriert; kein Hardwarezugriff und kein neuer Dienst/Container.
HTTP-API, Website-DNS-Alias, Statusanzeige und zentraler Installationsguide werden
vom Parent integriert/geprüft. Gesamt-Codeheadd4d60ef besteht Web41135320070,
native Reader-Matrix41135320145, UART41135320067 und Firmware41135320025/
41135313126. Keine Pi-/Hardware-/Dauerbetriebsabnahme, kein zusätzlicher finaler
unabhängiger Modellreview wegen Kontingent. Finale PR-Checks beachten.
Diese Datei ist zugleich das Änderungsledger dieses eng begrenzten Teilauftrags.

Die Gesamtverdrahtung umfasst inzwischen read-only Plan-API, explizite
Modusaktivierung, Websitealias und Settingsfelder; Docker-Gesamtprüfung bestanden.
Automatik verwendet ihren aktuellen HTTP-Plan/kausalen Guard, keine manuelle
MQTT-Lease: Brokerausfall darf insbesondere einen möglichen Schutz-Stop nicht
sperren. Bereits angenommene manuelle Absicht bleibt als Owner-Marker auch nach
Queueablauf oder MQTT-Verlust wirksam. Bei Uhrfehler während zuvor laufender
Automatik höchstens ein rein monoton befristeter Schutz-Stop, sonst Freeze.
Zwei kohärente Zeitbeobachtungen können nur die Referenz reparieren, niemals
selbst reaktivieren; neue explizite Aktivierung bleibt erforderlich.
Gesunde HTTP-Heartbeats/TTL-Erneuerung sind kein Sitzungswechsel. Nur geänderter
Planinhalt/Gültigkeit/Uhrfehler wechseln dessen Generation; vor jedem I/O werden
aktuelles Budget und Zeitfenster erneut geprüft. Ausreichender neuer Überschuss
oder ein unabhängiger Hausfehler im Custommodus ohne PV stornieren keine Aktion.
Bereits beobachtete Aktivierungs-IDs dürfen nie wieder scharfstellen: maximal4096
je Readerprozess ohne Verdrängung, danach sicher gesperrt bis Neustart und neuer
bewusster Wahl mit neuem Guard. Keine versteckte unbegrenzte Replayliste.

## Öffentliche Schnittstellen (`wallbox::automation`)

- `initialize_vienna_timezone()` **vor Threads** aufrufen: setzt pro Prozess einmal
  `TZ=Europe/Vienna`/`tzset`. UTC-Ausgaben müssen weiter `gmtime_r` verwenden.
- `HttpSource(string base_url)`, `snapshot()` liefern
  `shared_ptr<const Snapshot>`. Der produktive Owner verwendet ausschließlich
  `WALLBOX_AUTOMATION_WEB_URL`, Default leer = deaktiviert. Der ältere reine
  Core-Helper `environment_base_url()` (`WALLBOX_WEB_BASE_URL`/technischer DNS-
  Default) bleibt ABI-unverändert, wird vom Owner ausdrücklich NICHT benutzt.
  Nur HTTP(S)-Origins ohne
  Zugangsdaten, Pfad, Query oder Fragment; angehängt werden ausschließlich
  `/api/charging-plan` und `/api/smartmeter`. Keine Browser-URL, MQTT oder Modbus.
  Ein Thread, Zwei-Sekunden-Zyklus, Abbruch und Join im Destruktor.
- `Input`: `now` monotone Sekunden; `utc` Epochsekunden; kopierte `Sources`;
  `activation_guard` als vom Reader erzeugter kausaler Epochwert (32 kleine
  Hexzeichen), ausdrücklich NICHT aus HTTP übernommen;
  `bus_connected`; optionales bestehendes `Telemetry sample` mit explizitem
  `sample_at` (monotoner erfolgreicher Readzeitpunkt, kein Heartbeat) und
  `sample_expires`; `hardware_max_ma` mit `hardware_expires`; explizite
  `installation_max_ma`. **Kein Standortdefault**; 32 A sind nur Softwareobergrenze.
- `Engine::step(Input)` ergibt null oder genau eine `Action` mit `Operation::Stop`,
  `SetCurrent`, `Start`, Ziel-mA, Seriennummer, Generation, Aktivierungs-ID,
  Konfigurationsrevision, Guard, Ausgabezeit/UTC und gemeinsamer monotoner
  Drei-Sekunden-Deadline.
- Vor **jedem** WriteCore-I/O (auch zwischen SetCurrent und Start)
  `engine.accepts(action, latest_input)` prüfen. Dies prüft auch manuelle Sperren;
  die freie Funktion `action_is_current` prüft nur Quellen/Ticket. `accepts` ist
  jetzt nicht const: auch hier beobachtete neue Nonces werden während offener
  Aktionen quarantänisiert; Zeit-/Busfehler verriegeln die Engine.
  Bei false nichts mehr senden;
  `complete(action,{attempted, acknowledged, set_current_ack_without_verified_limit})`
  melden. Das zweite Feld bestätigt den **gesamten** Aktionsvertrag; das dritte
  gilt nur für eigenständiges SetCurrent mit strikt passendem FC16-ACK, aber
  ohne rechtzeitig validierte Limitbeobachtung ≤ Ziel (`current_limit_checked`).
  Es gilt weder für verlorene Schreib-ACKs noch für die Vorbereitung eines
  zusammengesetzten Starts. Der Owner priorisiert manuelle
  Befehle, hält den einzigen RS485-Port und führt maximal eine Aktion je Poll aus.
  `Start` bedeutet ausdrücklich **SetCurrent, danach Start im selben WriteCore
  und derselben Deadline**. Vor dem automatischen Start muss auch der letzte
  volle Registerblock noch „angesteckt, nicht ladend“ zeigen. Seine Spannungen
  und seine Wallboxleistung ersetzen die älteren Pollwerte für die abschließende
  Budgetprüfung; keine Frist wird verlängert. Die manuelle Startprüfung bleibt
  unverändert. Aggregat-ACK nur bei beiden strikten ACKs. Wenn nur der
  erste Teil versucht wurde und der zweite entfällt, `attempted=true,
  acknowledged=false`: Automatik friert ein. Kein Retry, kein zweiter Master.
- `manual_override()` vor jedem manuellen Start/Stop/SetCurrent: verriegelt die
  Automatik bis neuer Aktivierungs-ID mit passendem Readerguard. Offene Aktionen
  bleiben bis `complete` erhalten, auch nach manuellem Eingriff. Manuelles Stoppen bleibt unabhängig vom
  Enginezustand verfügbar. Doppelte/veraltete `complete`-Meldungen werden ignoriert.
- `status()`/`status_name()`; reine `schedule_contains(Profile, utc)`.

HTTP-Vertrag: Schema 1 aus dem Parentauftrag, inklusive nullable Site-Feldern.
`activation.guard` ist ein erforderlicher String aus exakt 32 kleinen Hexzeichen;
ein Default-Manualplan darf 32 Nullen liefern, aber keinen passenden Bootguard
vortäuschen. HTTP aktualisiert niemals den Guard des Reader-Owners.
Unbekannte/fehlende Pflichtwerte erlauben keinen automatischen Start. Smartmeter
bleibt bestehendes Schema 1: signed `power_w`, `fetched_at` ISO8601 UTC mit optional
bis sechs Nachkommastellen, `age_seconds`, **verbleibende** `fresh_for_seconds`.
TLS-Prüfung/CA bleiben aktiv, Proxy und Redirect aus; Verbindung 500 ms, Gesamt
1500 ms je Request; Header 8 KiB, Body 16 KiB, HTTP 200, endliche Zahlen, keine
doppelten JSON-Schlüssel. Keine URL-/Credential-/Rohdatenlogs. Transportausfall
behält nur ursprüngliche Frist; explizite Unknown-/NULL-/Fehlerantwort sperrt.
Gleiches `fetched_at` kann seine erste Frist niemals verlängern. Generationen
ändern sich bei Publikation und verhindern veraltete Owner-Aktionen.

## Regeln und Sicherheitsgrenzen

Erste gültige Aktivierung nach Boot ist nur Baseline, auch bei persistiertem PV.
Nur neue explizite ID aktiviert; Speichern/GET/Reload nicht. Revision ohne neue ID,
Busverlust, Zeitfehler und nicht bestätigter versuchter Write frieren bis zur
nächsten expliziten Aktivierung ein. ACK ist kein Nachweis tatsächlichen Ladens.
Start wartet auf neues `charging=true`, Stop auf `false` mit einem streng neueren
`sample_at` als vor der Aktion; kein vorliegender Read beweist einen Writeeffekt.
Keine Wiederholung.
Eine neue Aktivierung darf niemals den Zeitfehler derselben Eingabe löschen.
Ungültige UTC/Monotonie/Drift (>2 s) wird nicht als neue Zeitbaseline installiert;
erst eine gültige Uhr plus wirklich neue Aktivierung kann die Sperre lösen.
Bei Uhrfehler ist ausschließlich der oben beschriebene einmalige monotone
Schutz-Stop zulässig; bei Busverlust findet kein serieller Auftrag statt. Stop-Tickets
brauchen dagegen ausdrücklich KEIN frisches Sample, keine Hausdaten und keinen
Hardwarecap: zuvor beobachtetes oder per Start-ACK angefordertes Laden genügt
für genau einen Schutz-Stop. Danach bleibt unbekanntes Laden unbekannt und löst
keine Wiederholung aus. Ein versuchter Stop ohne ACK friert ein.

Der Owner erzeugt mit begrenztem CSPRNG einen neuen Guard je Boot und rotiert ihn
nach jedem manuellen Start/SetCurrent/Stop sowie unklarem Buskontext. Vor manuellen
Befehlen `manual_override` aufrufen. Guard ist Kausalversion, keine Authentifizierung.
Nur eine neue Aktivierungs-ID mit exakt passendem nichtleerem Guard darf rearmen;
Guardwechsel allein reicht nicht. Verspätete Mode-POSTs mit altem Guard dürfen
keinen manuellen Stop aufheben. Vor jedem laststeigernden I/O gilt erneut die
Guard-/Snapshotprüfung; Schutz-Stop ist vom Guard unabhängig, aber nicht von der
manuellen/Freeze-Sperre. GET/Refresh/Reconnect rotiert den Guard nicht automatisch.
Während einer offenen Aktion beobachtete Nonces (auch aus `accepts`) bleiben
verbraucht; ein später unklarer Ausgang erfordert eine erst danach beobachtete
explizite ID. Bis zu 64 solche IDs bleiben pro Engine quarantänisiert, auch nach
Rearm; Überlauf sperrt bis zum Engine-/Readerneustart statt alte IDs zu vergessen.
Moduswechsel während I/O friert konservativ auch bei späterem ACK ein; keine
aufgeschobene Aktivierung wird nach `complete` automatisch ausgeführt.
Nach beobachtetem Fahrzeugende kein Blindstart bis Ab-/Anstecken oder Aktivierung.

PV: bekannte Phasenzahl und Zählertopologie erforderlich. Mindestens so viele
gültige Spannungen 150–300 V; W/A = Phasenanzahl × größte gültige Spannung.
Budget = erlaubter Bezug − Hausleistung + Wallboxleistung (nur wenn mitgemessen).
Abgerundete ganze Ampere, begrenzt durch Profil, Standort, frisches Hardwaremaximum
und Software32A, Minimum6A. Darunter verzögert pausieren, darüber verzögert starten;
Anpassung nach konfigurierter Verzögerung. Importgrenze 0–100000 W; Hardwaremaximum
6000–32000 mA. Vor der Rückkopplung muss Wallboxleistung endlich und nichtnegativ
sein. Alle fünf PV-Profilparameter sind Pflicht, keine geratenen Defaults. Custom
ohne PV benötigt weder Hausleistung, Importgrenze noch Zählertopologie; Phasenzahl
1–3, Stromgrenzen und Verzögerungen bleiben auch dort Pflicht.
Bestätigtes Sollziel statt wirksamen Limits merken: internes Lastmanagement löst
keine Wiederholungen aus. Quellenablauf während aktiver Automatik löst höchstens
eine noch mögliche Stopaktion aus; Wiederanlauf braucht frische Daten/Verzögerung.
Ein Start-ACK ohne neu beobachtetes Laden ist weiterhin eine erteilte Freigabe.
Eine neue PV-/Custom-Aktivierung setzt die Verzögerungen neu an, verwirft aber
weder diese Freigabe noch ihr letztes bestätigtes Soll oder einen ausstehenden
Stop. Das gilt auch beim erneuten Aktivieren desselben Modus. Ein neueres
`charging=false` allein schließt die Startfreigabe nicht: Erst beobachtetes
Ladeende, Abstecken oder Stop mit nachfolgender Nichtladebeobachtung beenden sie.
Eine bewusste Aktivierung von **Manuell** oder ein angenommener manueller Auftrag
übergibt die Verantwortung ohne impliziten Stop an den Bediener. Erst eine weitere
gültige Aktivierung übergibt sie zurück; sie darf auch nach Fahrzeugende neu starten.
Währenddessen keinen zweiten Start und keine Stromerhöhung senden. Sinkt das
Budget, ist nach Anpassungsverzögerung ein niedrigerer Sollstrom zulässig; unter
6 A oder außerhalb eines Pause-Fensters nach Pausenverzögerung einmal stoppen,
auch wenn noch kein Ladestrom beobachtet wurde. Außerhalb `manual` bleibt
unverändert ohne automatische Aktion.

Ist das angeforderte Limit niedriger als das letzte bestätigte Soll oder das
beobachtete wirksame Limit, genügt ein FC16-ACK ohne passende rechtzeitige
Rücklesung **nicht** als Reduktionsnachweis. Das alte Soll bleibt erhalten,
die Regelung friert ein. Genau bei der nächsten Entscheidung ist bei weiter
offener Freigabe oder beobachtetem Laden ein einziger Schutz-Stop möglich
(normales 3-s-Ticket, intakter Bus/Uhr, kein wartender manueller Schreibauftrag).
Ein bereits wartender, rein lesender Inspect kann diesen einmaligen Stop nicht
verdrängen. Ein wegen Ablauf, Bus- oder Uhrfehler verworfenes Schutzticket
wird nicht wieder zulässig. Kein Wiederholen
von SetCurrent, kein Nachholen des Stops nach Buswiederkehr, kein automatischer
Neustart. Eine neue Auto-ID allein löst die Sperre nicht: Bei ungeklärter
Freigabe bleibt nur die bewusste manuelle Übernahme; nach beobachtetem Ende
oder Abstecken ist eine neue Aktivierung erforderlich. Ein reiner Inspect
repariert allenfalls den Transport und belegt keinen Writeeffekt.
Fehlt dagegen der Schreib-ACK selbst, gibt es keine solche Stop-Ausnahme.
Nach neuer bewusster Aktivierung ist das vor dem unklaren SetCurrent bekannte
Soll keine verlässliche Basis für eine Erhöhung oder Reduktion: Solange der
Start noch auf Ladebeobachtung wartet, bleibt jeder positive Sollauftrag
gesperrt, ein nötiger Stop bei Nullbudget bleibt möglich.

Custom: feste Wiener Ortszeit, Wochentage 1–7, maximal16 Fenster, ODER-Verknüpfung,
Ende exklusiv. Übernachtfenster gehören zum Startwochentag. Gleiche Endpunkte sind
ungültig (kein geratenes 24h-Fenster). Zeitumstellung gilt nach echter Ortszeit;
beide wiederholten Herbststunden werden gleich behandelt. Außerhalb `pause` stoppt,
`manual` lässt bestehendes Laden unverändert und erzeugt keine Automatikaktion.
Ohne manuellen Override kann innen wieder Automatik laufen.

**Keine harte Netzanschluss-Schutzfunktion:** abgetastete Rückkopplung/Verzögerungen
garantieren keine augenblickliche absolute W-Grenze.

Feste Enginestatuscodes: `awaiting_activation`, `manual`, `manual_override`,
`frozen`, `invalid_configuration`, `source_unavailable`, `manual_handling`,
`unplugged`, `adjusting`, `pausing`, `resuming`, `awaiting_start`, `awaiting_stop`,
`charging`, `vehicle_finished`. HTTP: `waiting`, `ok`, `transport_unavailable`,
`invalid_response`, `disabled`, `clock_error`, `invalid_base`.

## Einrichtung und Rückmeldung auf der Übersicht

- Ohne Reader-URL bleibt die Automatik aus. Die Übersicht nennt die interne
  Website-Origin und den erforderlichen Reader-Neustart durch Neuerstellen. Bei
  falscher URL, nicht abrufbarem Plan oder deaktiviertem Settings-Editor zeigt
  sie den jeweiligen Prüfschritt. Weder ein Link noch ein Reload schaltet frei.
- `GET /api/charging-mode` liefert für genau die gelesene Entwurfsrevision
  zusätzlich `missing_by_mode: {pv: [...], custom: [...]}` mit bekannten
  Feldnamen. Die Übersicht benennt fehlende Felder vor dem POST. Der Server
  prüft sie beim tatsächlichen POST unter Lock erneut. Eine leere Liste ist
  **keine** Bestätigung von Gerät, Standortgrenze oder Ausführung.
- Manuelles Starten/Stromsetzen bleibt an die üblichen technischen Grenzen
  gebunden; Stop ist davon und von den Modus-APIs unabhängig. Ein passiver
  Settings-GET blockiert die Handbedienung nicht. Wählt der Betreiber Manuell,
  kann er bei ausgefallenem Regler-/Profilzugang die Handbedienung verwenden.
  Das schaltet nicht still den Reader um: erst ein tatsächlich angenommener
  manueller Auftrag hat beim Owner Vorrang. Die UI kennzeichnet den nicht
  bestätigten Moduswechsel; ein möglicherweise gesendeter POST wird nie wiederholt.
- Der Owner meldet die ausgewertete Plan-ID mit dem zugehörigen Reglerstatus,
  nicht eine zwischenzeitlich eingetroffene, noch nicht verarbeitete HTTP-Absicht.

## Änderungs-/Prüfledger

2026-11-26: Die unten dokumentierte frühere Cap-Erneuerung erst im freien
Aktionsslot nach Ablauf konnte gesunden Ladebetrieb alle zehn Sekunden stoppen.
Der Owner entscheidet **zuerst** mit der tatsächlich verfügbaren Grenze. Nur
wenn die Engine keine Aktion verlangt und kein Bedienauftrag (auch kein Inspect)
übernommen wurde, darf er im freien Slot vorsorglich `0x4004..0x4007` lesen:
passender frischer Plan, Grenze fehlt oder läuft bis zum Ende der nächsten
Pollantwort ab, und das volle Antworttimeout passt noch bis zum nächsten Poll.
Bei bereits fehlender Grenze hat ein nötiger Stop Vorrang. Die optionale Lesung
verbraucht den Slot; bei knapper Zeit entfällt sie statt den Poll zu verzögern.
Nur ein gültiger Read erneuert den Zehn-Sekunden-Wert. Ein fehlgeschlagener
Cap-Read (auch bei explizitem Inspect) verriegelt die Automatik noch vor einem
möglicherweise erfolgreichen Wiederverbinden. WriteCore prüft unabhängig vor
jedem Strom-/Startauftrag frisch. Neue PTY-Fixtures decken den TTL-Wechsel ohne
Browser/Inspect, fehlende bzw. widersprechende Rücklesung, späte Änderungen im
Start-Preflight und langsame Antworten ab. Neue CI-Ausführung ausstehend; keine
Hardware-/Pi-Abnahme.

2026-10-30 18:43 (Europe/Vienna): Ownerverdrahtung mit einem HTTP-Thread und
genau einem seriellen Owner, höchstens einer Aktion je Poll. Manuelle Requests
haben Vorrang; vor jedem WriteCore-I/O werden aktuelle Quelle, Guard, Session und
queued manuelle Requests geprüft. Schutz-/Startaktionen behalten die Core-
Outcomezuordnung; sichere Teilvorbereitung friert ein, ohne einen bereits
wartenden manuellen Stop wegzuwerfen. Echte Unknown-/Transportfehler widerrufen
die Controlsitzung. Inspect repariert nur den Transport, nicht die Engine.
Hardwaremaximum stammt ausschließlich aus höchstens zehn Sekunden altem
`0x4004..0x4007`-Read; autonome Capabfrage verbraucht eine Pollaktion. Telemetrie-
Readzeit ist die Samplezeit; Verfall spätestens zehn Sekunden, bei kurzen
Intervallen konservativ früher. `--once` startet keinen HTTP-Thread und liest
keine zusätzlichen Capabilityregister.

Ownerantworten enthalten optional `automation` mit exakt `schema_version`,
`guard`, `requested_mode`, `activation_id`, `config_revision`, `state`, `plan`,
`house`. Feste Enumlabels und validierte Hexstrings, keine URLs/Rohfehler.
Channelsynthetische Antworten liefern `null`. Guard aus demselben begrenzten
getrandom/urandom-Pfad wie Controlleases; bei Entropiefehler keine Automatik,
Monitoring/manueller Pfad bleiben bestehen. Guardwechsel vor JEDEM manuellen
Owner-Schreibauftrag (auch abgelaufenen/gesperrten), bei Busverlust/Unknown.
Keine Authentifizierungszusage. HTTP-Inspektion der Website sollte höchstens alle
15 Sekunden erfolgen, nicht alle zwei Sekunden, damit sie keine Pollaktionen
verdrängt. Konkrete Phasen/Zählertopologie niemals aus bestätigten32A ableiten.

Neue Docker-CTest-Fixture kombiniert echten Reader, isolierten Broker, PTY und
Loopback-HTTP: Bootbaseline, fehlende Topologie, Ganzampere-PV-Start, Schutzstop,
alte Guards nach manuellem Stop, abgelaufene Hausdaten, ACK-Verlust ohne Retry,
Inspect ohne Enginefreigabe, Custom-Teilvorbereitung und Stop während I/O.
Nicht ausgeführt; auch keine Hostprojektläufe, SSH-/Pi-/Hardwareaktionen.

2026-10-30 19:27 CET (Europe/Vienna): Basis `8b82d7d`, enger Safety-Folgeauftrag:
gleichzeitige Clock-/Noncefehler, Sampleverlust beim Schutz-Stop, ausstehende
Outcomes über Aktivierung/manuellen Override und kausale Readerguards abgesichert.
HTTP-Guardpflicht, konsistente Import-/Hardwaregrenzen und Custom-ohne-PV ergänzt.
Gezielte Engine- und Loopback-HTTP-Regressionen hinzugefügt. Ausschließlich
statisch geprüft; keine Hosttests, Builds, Docker-/CI-Läufe oder Hardwareaktionen.
Parent muss Docker/GitHub-CI und Integrationsprüfung ausführen. Andere Agenten-
und Parentdateien bleiben außerhalb dieses Branchscopes unverändert.

2026-10-30 19:09 CET (Europe/Vienna): Engine, HTTP-Snapshotthread, Release-aktive native Fälle,
Loopback-HTTP-Fixtures, additive CMake-Ziele, Docker-Abhängigkeiten und separater
ASan/UBSan-Enginebuild ergänzt. Bestehende sieben Tests/der Mosquitto-Guard bleiben.
Kein Docker lokal verfügbar: **keine Projektprüfung ausgeführt**, kein Build-/CI-
oder Hardwareerfolg behauptet. Nur statische Prüfung und `git diff --check`.
Parent muss vor Integration Docker/GitHub-CI ausführen und Änderungen prüfen.
