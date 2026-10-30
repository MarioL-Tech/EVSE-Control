# Manuelle Webbedienung – Arbeitsvertrag Stufe 2

Stand 2026-10-30; Implementierung/Tests in Arbeit, noch kein Hardwareabnahmenachweis.
Ausdrücklich ohne Login oder zusätzlichen Freischalter; jeder erreichbare Nutzer
im vertrauenswürdigen LAN/VPN darf bedienen. Login folgt separat. Keine öffentliche
Freigabe. CSRF/Host-/Originprüfung ist KEINE Authentifizierung. Keine Agent-Pi- oder
Hardwaretests. Erster realer Schreibtest später ausschließlich über das Weboverlay,
nach Information der Leitung und gesonderter Testfreigabe.

## Nicht geratene Stromgrenzen

Die genannten 16 A sind nur eine Vermutung. Die Oberfläche liest das Wallboxmaximum
aus 0x4006/07; das ist KEIN Beleg für eine zulässige Installationsbelastung.
`WALLBOX_INSTALLATION_MAX_MA` muss separat tatsächlich konfiguriert werden, ohne
16-/32-A-Default (6000–32000 mA). Obergrenze = Minimum aus gemeldeter Geräte-,
konfigurierter Installations- und konservativer 32-A-Softwaregrenze. Ausgelesene
Gerätegrenzen außerhalb6000..32000 mA sind nicht nutzbar und werden nicht still
heruntergerechnet. Ohne gültige Grenzen kein Start/keine Stromvorgabe, jedoch kein Login/Freischalter. Stop benötigt
keine Stromerhöhung und daher kein Installationsmaximum; Verbindung/Frische bleiben
nötig. Die Hardwaregrenze und Firmware-Rohwert werden nur gelesen, nicht gesetzt.

## Befehlsweg und Protokoll

Browser → neuer PHP-Endpunkt `/api/wallbox-control` → bestehender MQTT-Broker →
eigener ControlChannel im bestehenden C++-Reader → WriteCore/libmodbus.
Kein zusätzlicher Container/Daemon/DB-Zugriff; kein zweiter Modbusmaster. Vorhandener
MQTT-Telemetriepublisher, PHP-Subscriber, Live-/Archiv-APIs und SQL bleiben unabhängig.

Das Readerimage baut libmosquitto 2.0.21 aus SHA256-gepinnter Upstreamquelle
mit lokalem Empfangspatch. MQTT Remaining Length über 4096 Bytes wird bereits
vor der Payloadallokation abgewiesen, nicht erst im 160-Byte-Anwendungscallback.
TLS/Threading und Upstreamframing bleiben erhalten. Ein exportierter Grenzwert-
marker wird beim Linken und vor Channelstart verlangt; eine ungepatchte System-
bibliothek ist kein still unterstützter Produktionsersatz. Der reine Docker-
TCP/PTY-Test verlangt: 4096-Byte-Paket akzeptiert, 4097-Byte-/64-MiB-Header ohne
Body schnell abgewiesen, Telemetrie läuft weiter. Keine solche Netzprobe an
Produktionsbroker/-reader ausführen. Der Website-End-to-End-Test verwendet
dieselbe Readerbibliothek. Upstreamlizenzen liegen unter
`/usr/share/doc/evse-libmosquitto/` im Image.

MQTT3 liefert RETAIN bei Livezustellung an bereits abonnierte Clients als false.
PHP publiziert deshalb nie retained; der Reader verwirft zusätzlich ankommendes
RETAIN=true. Primärer Schutz gegen Altwiederholungen sind neue Sessions,
einmalige monotone Leases und Dedupe, nicht dieses Bit allein. Der Wegwerf-
End-to-End-Fall kombiniert einen retained gespeicherten Auftrag mit ungültiger
alter Session/Lease; er belegt die kombinierte Ablehnung, keinen eigenständigen
RETAIN-Bit-Nachweis mit ansonsten gültiger unverbrauchter Lease.

Pro HTTP-Anfrage ein kurzlebiger PHP-MQTT-Client mit eindeutiger Client-ID und
denselben Backend-Zugangsdaten. Erfolgreichen SUBACK der eindeutigen Ergebnistopics
abwarten, danach genau einmal QoS0/nicht-retained veröffentlichen; keine Publish-
Wiederholung und keine automatische Verbindungserneuerung. Schleifen/Frames/Antwort
begrenzt, Client im finally schließen. Auch HTTP-/Browserabbruch ist kein Rückruf
eines bereits gesendeten Auftrags: Ausgang bleibt ggf. unbekannt, kein Auto-Retry.

Topics `<prefix>/control/request` und `<prefix>/control/result/<id>`.
Exakter ASCII-Payload, maximal 160 Bytes:

`v1|id|session|lease|operation|milliamps`

- id/session/lease: genau 32 kleine Hexzeichen, id zufällig; Session/Lease bei
  `inspect` genau `-|-`, Strom 0. Operation exakt `inspect|set_current|start|stop`.
- Start/SetCurrent: UInt32-Dezimal ohne Vorzeichen, 6000–32000 mA; Stop 0.
- `inspect` liest Hardwaremaximum/Firmware im Portbesitzerthread und liefert eine
  zufällige, an die Reader-/Bus-/Broker-Sitzung gebundene Lease. Frist acht Sekunden
  auf monotoner Readeruhr, nicht vom Browser oder beim verspäteten Empfang erneuert.
- Jede schreibende Webaktion verbraucht eine solche Lease einmalig. Ein erneuter
  Inspector ist read-only. Vor jedem POST wird serverseitig frisch inspiziert;
  Browser darf keine Topics, Leases, Register, Fristen oder Brokerziele vorgeben.
- Queue höchstens vier, ein aktiver Auftrag. Dedupe-/Ergebniseinträge höchstens128,
  Leases höchstens64; keine noch gültigen Reservierungen bei Überfüllung verdrängen.
  Gleiche id/gleicher Payload: niemals erneut ausführen; gespeichertes Ergebnis
  höchstens erneut melden. Gleiche id/anderer Payload: nicht ausführen.
- Reconnect/Restart/Busfehler: neue Session, alte Leases und wartende Befehle
  verwerfen. Laufende Auftragsschritte vor jedem I/O gegen Sitzung/Shutdown prüfen.
  Callback macht niemals serielles I/O. Telemetriepolls dürfen nicht verhungern.

Start bedeutet im Web **explizit Stromvorgabe vorbereiten, dann Start** im selben
Core/Ownerthread und innerhalb derselben Lease. Kein Start nach fehlender/unklarer
Vorbereitungsbestätigung. Ergebnis hält beide Schritte getrennt fest; eine bereits
übernommene Stromvorgabe wird bei später fehlendem Start nicht verheimlicht.
Kein impliziter Core-Write und kein aufgehobener Auftrag für Reconnect.

## JSON-Ergebnis

Maximal 4096 Bytes, Schema 1, id/operation/status/reason, session, lease (nur Inspect),
fresh_for_seconds (8 bei gültiger Lease), minimum_ma=6000, software_max_ma=32000,
hardware_max_ma/installation_max_ma/effective_max_ma/firmware_raw nullable.
`write` und `preparation` nullable mit WriteCore-Status, festem reason, attempted,
acknowledged, hardware_max_ma/effective_current_ma/charging_state_raw und
charging_observed nullable. Protokoll-ACK, tatsächlicher Ladezustand und wirksames
Limit sind NICHT gleichbedeutend. Kein Secret/Hostname/Rohpayload in API oder Log.

HTTP GET/HEAD ohne Query: `{status,csrf,inspection,command:null,command_sent:false}`.
POST exakt JSON `{operation:'start'|'stop'|'set_current',current_ma:integer}` plus
Origin/Host/Fetch-Site/CSRF; höchstens1024 Byte, doppelte/unbekannte Schlüssel ablehnen.
GET liest nur, POST publiziert genau einen logischen Schreibauftrag nach Inspect.
Antwort `{status,csrf,inspection,command,command_sent}`: status `ok` bedeutet erhaltene
Antwort, NICHT erfolgreiches Laden. `unavailable` vor Command-Publish bedeutet kein
Schreibauftrag versendet; `outcome_unknown` danach niemals als nicht gesendet
darstellen. Command kann selbst einen ACK/technische Ablehnung/unklaren Ausgang
melden. Alle API-Zugriffe network-only/no-store, keine PWA-/Offline-POST-Queue.

## Oberfläche

Gemeinsame Komponente auf Übersicht und neuem `/wallbox`-Detailtab. Start/Stop,
Slider (1-A-Schritte innerhalb gültiger Grenzen), Ampereanzeige und „Übernehmen“;
Ziehen ändert ausschließlich den Entwurf, niemals einen Modbuswert. Kein Speichern
von Befehlen im localStorage und keine Wiederholung bei Reload/Pageshow/Retry.
Details zeigen Wallbox-/Installationsmaximum, Rohfirmware, letzten angeforderten
Wert, beide Befehlsbestätigungen und unabhängig die aktuellen realen Messwerte.
Unbekannt/Fehler/Offline bleiben sichtbar; aktive Fehlerwarnung/Frische erhalten.
Keine Historienaufnahme auf der Übersicht, bestehende16 Präferenzen unverändert.
