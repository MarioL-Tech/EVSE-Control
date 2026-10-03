# Lesendes Weboverlay

Eigenständiger Docker-Dienst: Paho-MQTT → validierter In-Memory-Snapshot →
Flask/Gunicorn → deutsche Browseranzeige. Kein Hardwarezugriff, keine Publish-
oder Steuerbefehle, keine Datenbank. Bestehender Broker im Netzwerk `evse-mqtt`.

## Start auf dem Pi

Aus dem Repository-Verzeichnis, bei laufendem Reader und vorhandenem Broker:

```bash
cd rasppi/weboverlay
docker compose up -d --build
```

Auf deinem Rechner mit dem **bereits verwendeten SSH-Ziel**:

```bash
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8080:127.0.0.1:8080 ml@elke
```

Browser: **http://127.0.0.1:8080**. SSH-Tunnel offen halten. Hostport ist nur an
Pi-Localhost gebunden, kein neues Internet-/LAN-Portmapping. Keine SSH-/WG-Änderung.

Alle Schritte zu Konfiguration, Passwortdatei, Portkonflikten, Diagnose und Tests:
[zentraler Installationsguide](../../docs/installation.md#9-lesendes-weboverlay).

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
- Ein Gunicorn-Worker mit vier Threads; Paho läuft als eigener Netzwerkthread.
- Keine externen CDN-/Font-/Browser-MQTT-Abhängigkeiten, keine Zugangsdaten im JS.
- Kein HTTP-Login/TLS: nur vertrauenswürdiger Zugang über den vorhandenen SSH-Tunnel.
- MQTT-Vertrag: [Topics, Einheiten und Verfügbarkeit](../../docs/mqtt-protocol.md).

Docker-Build führt Backend-, HTTP-/MQTT-Integrations- und Frontendtests aus.
Testbroker nur im Build-Container; Produktivbroker/Hardware werden nicht berührt.
Pi-Browser-/Deploymentprüfung ist separat durch Mario zu bestätigen.
