# ESP32-Gateway-Vertrag, Version 1 / Firmware-Protokoll 2

## MQTT-RPC

MQTT 3.1.1, Clean Session, vorhandener Broker, eigener Gatewayclient.
Defaultpräfix `evse/esp32`. Anfrage auf `<prefix>/control/request`: nicht-retained,
QoS 0, höchstens 192 ASCII-Bytes, **genau sechs** Felder:

```text
v1|<id32>|<gateway_session32 oder ->|<gateway_lease32 oder ->|<operation>|<uid oder ->
```

Alle IDs/Sitzungen/Leases sind 32 kleingeschriebene Hexzeichen, kryptographisch
zufällig. Operation: `inspect`, `lock`, `unlock`, `enroll`, `cancel`, `revoke`.
`inspect` verlangt Sitzung und Lease `-`. Jede Mutation verlangt die zuletzt
inspizierte Gatewaysitzung und eine noch gültige einmalige Lease. UID nur bei
`revoke`, als 4/7/10 Hexbytes mit Doppelpunkten; sonst letztes Feld `-`.
Keine Callerpfade, Register, Zeitlimits oder Rohbefehle. Falsche/zu große,
retained, QoS>0 oder überzählige Anfragen werden ohne Wirkung verworfen.

Ergebnis nicht-retained, QoS 1 auf `<prefix>/control/result/<id32>`, maximal
4096 Bytes. Feste JSON-Schlüssel:

```text
schema_version=1
id, operation, status, reason, session
lease: null | 32hex
fresh_for_seconds: 0 | 8
firmware_version: null | 2
state: {charging, antitheft, store_ready, cards, enrolling, reader_ready, servo_ready}
command_sent: bool
result_code: null | fester Firmwarecode
```

Statuswerte: `ok`, `disabled`, `busy`, `rejected`, `outcome_unknown`, `unavailable`,
`acknowledged`. Gründe ausschließlich:
`inspection_complete`, `gateway_unavailable`, `firmware_unsupported`,
`serial_timeout`, `invalid_session`, `invalid_lease`, `queue_full`, `busy`,
`deadline_elapsed`, `protocol_ack_only`, `rejected_by_device`, `outcome_unknown`,
`invalid_request`, `not_ready`, `gateway_session_changed`, `uart_unavailable`.
Nicht jeder zulässige Status/Grund wird vom Gateway selbst erzeugt.

Statewerte sind nullable bool; `cards` nullable int 0..16. `antitheft=true`
bezeichnet den angeforderten aktiven Servozustand, keine mechanische Rückmeldung.
`charging=null` bleibt UNKNOWN. `command_sent=true` bedeutet einen versuchten
UART-Write, nicht den nachgewiesenen Empfang oder eine bestätigte reale Wirkung.
Nach Management-ACK sind Statefelder wieder null bis zur nächsten Inspektion.
`acknowledged/protocol_ack_only` beweist nur die Firmwareantwort. Bei verlorener
Antwort nach einem Writeversuch `outcome_unknown`, nie automatische Wiederholung.
Explizites Legacy-UNKNOWN_CMD auf HELLO ergibt `unavailable/firmware_unsupported`;
keine Legacy-Managementbefehle als Fallback.

Ergebniscode: `OK NOT_READY STORAGE_ERROR INVALID_UID INVALID_ARGUMENT FULL
ALREADY_ALLOWED ENROLL_STARTED ENROLL_ACTIVE ENROLL_CANCELLED ENROLL_INACTIVE
ENROLL_EXPIRED ENROLLED REVOKED NOT_FOUND DENIED DEBOUNCED LOCKED UNLOCKED
MODE_CHANGED INVALID_SESSION INVALID_LEASE BUSY DUPLICATE_MISMATCH
SESSION_MISMATCH GATEWAY_UNAVAILABLE`.
Das tatsächliche Firmware-Sessionfehlerwort ist `SESSION_MISMATCH` und wird auf
den festen Gatewaygrund `invalid_session` abgebildet; kein ungeprüfter Freitext.
Keine zusätzlichen Freitextfehler, RFID-Zeilen, UIDs, Payloads oder Credentials.

Gatewaysitzung ist nicht Firmwarebootsitzung. Nur korreliertes STATUS-ACK nach
allen drei kohärenten Statuszeilen erzeugt eine Clientlease, intern auf die
Firmwarelease abgebildet. Acht Sekunden beginnen beim STATUS-ACK, **nicht** bei
späterem MQTT-Empfang. Vor Ausführung konsumiert; Firmware prüft unabhängig.
Abgelaufene oder bereits wiederholte Inspektionsergebnisse enthalten keine neue
Lease und `fresh_for_seconds=0`. Wiederholte Ergebnisse sind keine Frischebeweise.

Limits: Anfragequeue 4 / Empfangsfrist 3 Sekunden monoton; Ergebnisqueue 8 plus
ein QoS1-inflight mit 3 Sekunden ACK-Frist; IDledger 128 für 30 Sekunden ohne
Verdrängen gültiger IDs; Clientleases 64 / 8 Sekunden. Gleiche ID+Digest liefert
nur gecachtes Ergebnis ohne neue Lease/Ausführung, abweichender Digest wird
abgewiesen. Bei voller Queue keine Ausführung. Keine Persistenz/Offlinequeue.
Bei Reconnect wird ein neuer Paho-Client ohne alte QoS1-Replaydaten erstellt.
UID wird im Ledger nur indirekt als Bestandteil des Anfragedigests gebunden.

Paho **2.1.0** bleibt MQTT-Framingimplementierung. Eine kleine Unterklasse prüft
`_in_packet.remaining_length` in `_sock_recv` **vor** dem Bodyread/-append:
maximal 32768 Bytes einschließlich variablem Header (Wallboxpayload maximal
16384). Version/Initialstruktur werden geprüft, bei Abweichung Abbruch. Da alle
Subscriptions QoS0 verlangen, werden eingehende QoS1/2-PUBLISH-Frames vor dem
Body verworfen; keine unbeschränkte Paho-QoS2-Eingangssammlung. Broker müssen
diese QoS0-Subscriptions bestätigen, bevor Anfragen angenommen werden.

## UART

ASCII, maximal 192 Zeichen vor LF, LF/CRLF, absolute 2-Sekunden-Framefrist;
Fehler/Overflow bis LF verwerfen. UART ausschließlich im Ownerloop, begrenzter
Write-Timeout 200 ms, keine Callbacks oder zweite Prozesse am Port.

```text
CMD:GATEWAY:HELLO:<id32>
EVSE:GATEWAY:HELLO:<id32>:<boot_session32>:2

CMD:GATEWAY:<id32>:<boot_session32>:STATUS
EVSE:STATUS:CHARGING:ON|OFF|UNKNOWN:SRC:query
EVSE:STATUS:ANTITHEFT:ACTIVE|INACTIVE:SRC:query
EVSE:STATUS:SECURITY:STORE:READY|FAULT:FAULT:<enum>:BOOT:<enum>:CARDS:<0..16>:ENROLL:ON|OFF:READER:SPI_OK|FAULT:SERVO:PWM_OK|FAULT
EVSE:GATEWAY:RESULT:<id32>:<boot_session32>:STATUS:OK:<firmware_lease32>:8

CMD:GATEWAY:<id32>:<boot_session32>:<firmware_lease32>:LOCK
CMD:GATEWAY:<id32>:<boot_session32>:<firmware_lease32>:UNLOCK
CMD:GATEWAY:<id32>:<boot_session32>:<firmware_lease32>:ENROLL
CMD:GATEWAY:<id32>:<boot_session32>:<firmware_lease32>:CANCEL
CMD:GATEWAY:<id32>:<boot_session32>:<firmware_lease32>:REVOKE:<uid>
CMD:GATEWAY:<id32>:<boot_session32>:<firmware_lease32>:MIRROR:ON|OFF|UNKNOWN
EVSE:GATEWAY:RESULT:<id32>:<boot_session32>:<OP>:<fester Ergebniscode>
```

`|` oben bezeichnet Alternativen, nicht wörtliche UART-Zeichen. Faultenum:
`NONE/UNAVAILABLE/CORRUPT/WRITE`, Bootenum `RESTORE/LOCKED/UNLOCKED`.
Die Statusabfrage verlangt exakt die Firmware-Quellkennung `query`. Alle drei
Statuszeilen müssen in obiger Reihenfolge zum korrelierten ACK vollständig
eingehen. Unkorrelierte Legacyzeilen werden nicht weitergereicht.
Firmwarelease: einmalig, bootgebunden, monotone acht Sekunden, vor Versuch
verbraucht. Firmware-IDcache: acht Einträge, mindestens Lease-TTL+2 Sekunden,
kein Verdrängen lebender IDs, gleicher Inhalt nur ACK, anderer Inhalt ablehnen.
Diese Firmwarepflichten wurden gegen `esp32/src/gateway.cpp` und
`esp32/include/gateway.h` aus Firmwarecommit `4e5b213` read-only abgeglichen.
HELLO/STATUS belegen ebenfalls die acht Cacheplätze; der Gateway-Owner lässt
daher lokal höchstens acht UART-Transaktionen pro konservativem
10,2-Sekunden-Fenster zu. Zusätzliche Bedienung kann `busy` ergeben, nicht ein
stiller Retry. Status-/HELLO-BUSY wird als feste Ablehnung erkannt, nicht als
verlorenes ACK. Gatewaytests simulieren Firmware und beweisen keine echte
ESP32-Laufzeit.

## Tatsächlichen Ladezustand spiegeln

Separate QoS0-Abos des vorhandenen Wallboxpräfixes `/state` und `/availability`.
Schema1 `abb_terra_ac`, valide Messwerte einschließlich endlicher W/A/V-Werte,
`status=ok`, `last_success_at=timestamp` in UTC, 0..10 Sekunden alt,
`values.charging` exakt bool/null. Nur neue nicht-retained Messzeitpunkte plus
nicht-retained `online` erlauben ON/OFF. Initial/Retained/Reconnect/Fehler/Clock-
sprung/Offline/Ablauf => UNKNOWN. Unveränderte Payload verlängert niemals die
monotone Frische. Spiegelung viersekündlich über eigene STATUS-Lease, Management
hat Vorrang. Firmware-Watchdog: nach zehn Sekunden ohne bestätigte Aktualisierung
UNKNOWN. Kein automatischer Servo-Lock, keine reale Wallboxsteuerung.
