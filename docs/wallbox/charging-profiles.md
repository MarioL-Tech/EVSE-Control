# Lademodi, Entwürfe und explizite Aktivierung

Stand2026-10-30: Nach der reinen VorlagenstufePR#68 ist nun ein optionaler
Hintergrundregler im bestehenden Reader angebunden. Gemeinsame Docker-CI noch
offen; kein Pi-/Hardware-/Dauerbetriebsnachweis. Vertrag und Sicherheitsgrenzen:
[Automatisierung](automation-contract.md). Keine automatische Aktivierung alter
Vorlagen oder gespeicherter Absicht nach Readerneustart.

## Übersicht

Drei native, gegenseitig ausschließende Optionen: PV-Regelung, Manuell und
Benutzerdefiniert. Eine bewusste Wahl erfasst einen unveränderlichen Snapshot
der gespeicherten Regeln mit neuer Aktivierungs-ID und frischem Readerguard.
Erst der Reader bestätigt seinen Reglerzustand; HTTP-Erfolg heißt angefordert,
nicht tatsächliches Laden. Reload/Pageshow/Settingsspeichern aktivieren nichts.
Alte Reader bleiben manuell bedienbar, Automatik dort nicht auswählbar.
Start/Übernehmen sind nur manuell verfügbar. Stop bleibt bei geprüfter Verbindung
unabhängig von Modus/ESP32/Settings möglich und setzt einen manuellen Override.
Keine automatische Wiederaufnahme bis zu einer neuen bewussten Aktivierung.
Manuell auswählen allein ist kein Stop; bisherige Grenzen/CSRF bleiben erhalten.

Wiederholte Erklärtexte entfallen. Die drei Einstellungsprofile sind einzeln
auf-/zuklappbar, standardmäßig geschlossen. Ungültige Eingaben öffnen beim
Speicherversuch ihr Profil. Zahlen-/Zeitfelder bleiben44px groß; Wochentage
bekommen eigenen Abstand, Felder maximaldrei Spalten statt langer Einzeilen.
Ohne Auftrag gibt es keine Ergebniszeile;
nach einem Auftrag bleibt dessen Ergebnis außerhalb eingeklappter Details
sichtbar, insbesondere unklarer Ausgang/Teilstart/Ablehnung. Angeforderte Werte,
Protokoll-ACK und echte Livewerte bleiben getrennt innerhalb der bestehenden
„Diagnose“ erhalten. Große Moduskarten und Aktionstasten, Slidertrack14px und
28px-Griff; Auswahl/Bewegen allein erzeugt weiterhin keine Hardwareaktion.
Fehlende Installationsgrenze wird direkt als Sperrgrund angezeigt; ein
ausgelesenes 32-A-Gerätemaximum ist niemals Installationsfreigabe.

## Settings

Strukturierte Felder statt freier Regeln/Befehle. Nicht festgelegte Zahlen und
Entscheidungen bleiben NULL, keine geratenen Schwellen oder Verzögerungen.

- Manuell: optionale Ladestromvorlage in A (gespeichert als mA).
- PV: maximaler Netzbezug in W, Profil-Strommaximum, Verzögerungen vor
  Stromanpassung, Pause und Wiederaufnahme.
- Benutzerdefiniert: dieselben Grenz-/Zeitwerte, Entscheidung PV-Grenze beachten,
  Zeitfenster verwenden, bis zu sieben Wochentage und 16 Zeitfenster; außerhalb
  der Zeitfenster „Pausieren“ oder „Manuell bedienen“, zunächst nicht festgelegt.
- Zahlenformate: Strom 6000..32000mA; Netzbezug 0..100000W; Verzögerungen
  0..3600s. Das sind Eingabegrenzen, keine Betriebsdefaults/Hardwarefreigaben.
- Zeitzone fest Europe/Vienna. Format HH:MM, Anfang ungleich Ende; ein über
  Mitternacht eingetragenes Fenster bezeichnet den Folgetag. Doppelte Fenster
  werden abgewiesen. Die spätere DST-/Überlappungs-/Betriebsentscheidung gehört
  zum noch ausstehenden Regler; die Konfigurationsstufe führt keine Uhrzeitregel
  aus. Unvollständige Vorlagen dürfen gespeichert werden, sind nicht aktiv.

Die vorhandene Hausmessquelle bleibt unverändert: siebter Wert signed W,
positiv Netzbezug/negativ Einspeisung. Kein neuer Haus-MQTT-Pfad, keine Worker-
oder Storageänderung. Die zukünftige Regelung braucht einen ausdrücklich
getesteten browserunabhängigen Ausführungspfad im bestehenden System, geprüfte
Installationsgrenze, frische Daten, Fehler-/Unknown- und Wiederanlaufsperren.

## Speicherung und HTTP

`/api/charging-settings` liest/speichert ausschließlich nicht geheime Regel-
vorlagen. Keine MQTT-Verbindung, SQL-, Hardware-, Shell- oder Dockeroperation.
Die Antwort enthält stets `automation_available:false`. Nur GET/HEAD/POST,
keine Queryparameter, strikte Host/Origin/Fetch-Site/Session-CSRF-Prüfung wie bei
manueller Bedienung. Kein Login; nur vertrauenswürdiges LAN/VPN. Explizites POST
mit `{revision,config}`, maximal16KiB, keine unbekannten/doppelten Schlüssel.
GET/HEAD erzeugen keine Regeldatei. Alle API-Zugriffe network-only/no-store.

Speicherziel ist ausschließlich `weboverlay/charging.json` im bestehenden
Settings-only-Mount (`/run/evse-settings`). Kein neuer Mount, kein vollständiger
beschreibbarer Projektbaum. Verzeichnisse müssen bereits durch den Operator
bereitgestellt sein und UID10001 gehören. Dateien dürfen keine Symlinks oder
Hardlinks sein. Persistenter separater Lock `charging.lock`, maximal200ms,
SHA256-Revision/409-Konflikt, Tempdatei/fsync/Revisionsnachprüfung/atomarer Rename.
Config0640, Lock0600; private lesende Operatorgruppe wie bei .env. Keine perfekte
CAS-Zusage gegen fremde gleichberechtigte Writer ohne gemeinsamen Lock.

„Regeln speichern“ speichert nur Vorlagen – **aktiviert keine Automatik, ändert
keine laufenden .env-Werte und startet keinen Ladevorgang**. Kein Autosave oder
POST-Retry. Konflikt/unklarer Speicherausgang wird angezeigt, Entwurf bleibt
erhalten und muss bewusst neu geladen werden. Die bestehende .env-Konfiguration
und insbesondere `WALLBOX_INSTALLATION_MAX_MA` werden nicht ersetzt.
