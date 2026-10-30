# UART-Brücke und opt-in ESP32-Gateway

Die **bestehende** `uart-bridge` besitzt zwei Betriebsarten, niemals zwei
gleichzeitige Besitzer von `/dev/serial0`. Standard bleibt `UART_MODE=interactive`:

```sh
docker compose -f rasppi/compose.yaml run --rm --build uart-bridge
```

`on`, `off`, `status` und die bisherige rohe interaktive Befehlseingabe bleiben
erhalten. Die Ausgabe wiederholt aus Datenschutzgründen keine rohen Befehle oder
RFID-Zeilen; nur geprüfte Lade-/Antitheftstatuszeilen werden ausgegeben.
Diese Bedienung ändert nur den ESP32, niemals die reale Wallbox.

## Gateway vorbereiten (kein automatisches Deployment)

Voraussetzungen: Docker/Compose, vorbereiteter UART mit 115200 Baud/8N1 und
gemeinsamer Masse, bestehendes externes Netz `evse-mqtt` mit dem bisherigen Broker
unter `mqtt-broker`, **Gateway-Firmware Version 2** auf dem ESP32. Alte Firmware
wird nicht über Legacybefehle umgangen. Das Gateway flasht nichts.

Vor dem Wechsel jeden interaktiven UART-Container beenden. Niemals neben diesem
Dienst eine zweite UART-Brücke starten. `exclusive=True` schützt unterstützte
POSIX-Geräte zusätzlich; es ersetzt keine koordinierte Betriebsumstellung.

In der lokalen Compose-Umgebung konfigurieren:

```dotenv
UART_MODE=gateway
UART_DEVICE=/dev/serial0
UART_NETWORK_MODE=evse-mqtt
MQTT_HOST=mqtt-broker
MQTT_PORT=1883
ESP32_MQTT_CLIENT_ID=evse-uart-gateway
ESP32_MQTT_TOPIC_PREFIX=evse/esp32
WALLBOX_MQTT_TOPIC_PREFIX=evse/wallbox
```

Dann bewusst den **bestehenden Dienst** starten:

```sh
docker compose -f rasppi/compose.yaml --profile tools up -d --build uart-bridge
```

Kein neuer Containerdienst, Broker, Hardware-Master oder Wallboxschreiber.
`UART_NETWORK_MODE` wählt das bereits vorhandene externe Docker-Netz (keine
Neuanlage). Default `none` hält das interaktive Werkzeug ohne MQTT-Netz nutzbar;
für den Gatewaymodus bewusst auf das vorhandene `evse-mqtt` setzen.
`WALLBOX_MQTT_TOPIC_PREFIX` fällt auf `MQTT_TOPIC_PREFIX`, dann `evse/wallbox`
zurück; der ESP32-Präfix ist davon unabhängig. Client-ID muss von Reader,
Storage und Website verschieden sein. Präfixe erlauben ausschließlich einfache
ASCII-Pfadsegmente, keine MQTT-Wildcards.

### Bestehende Brokeranmeldung

Ohne Brokeranmeldung bleiben `MQTT_USERNAME` und `MQTT_PASSWORD_FILE` leer.
Bei Dateianmeldung eine **explizite read-only-Dateieinbindung** bereitstellen;
kein Secret wird aus anderen Diensten gesucht oder übernommen. Beispiel für
einen vom Betreiber privat verwalteten zusätzlichen Compose-Override:

```yaml
services:
  uart-bridge:
    environment:
      MQTT_USERNAME: "${MQTT_USERNAME}"
      MQTT_PASSWORD_FILE: /run/secrets/uart_mqtt_password
    volumes:
      - type: bind
        source: "${MQTT_PASSWORD_HOST_FILE}"
        target: /run/secrets/uart_mqtt_password
        read_only: true
        bind:
          create_host_path: false
```

Diesen Override beim Start ausdrücklich mit `-f <private-override-datei>`
ergänzen. Nur die benötigte Passwortdatei einbinden, keine Secretverzeichnisse,
Docker-Sockets oder Hardware außer dem eigenen UART. Die Datei muss für den
Container lesbar sein und darf nicht committed werden. Der Prozess unterstützt
alternativ `MQTT_PASSWORD`, Compose reicht es bewusst nicht automatisch durch.
Passwortdatei maximal 4096 Bytes; URL/Passwort/UID/Befehlsinhalt erscheinen nicht
in Gatewaylogs. Keine Hostpakete installieren.

**Sicherheitsgrenze:** Dieses MQTT-Protokoll hat keine eigene Benutzeranmeldung.
Broker/ACL müssen Anfragen auf den vorgesehenen autorisierten Webdienst
begrenzen. Jeder mit Schreibrecht auf `/control/request` kann nach frischer
Inspektion bedienen. Eine Lease ist Frische-/Replaykontrolle, kein Passwort.
Keine öffentliche Freigabe des Brokers. Webschutz ist Aufgabe der getrennten
Websiteintegration.

## Verhalten und Grenzen

Antitheft LOCK/UNLOCK steuert nur den separaten ESP32-Servo; ACK bedeutet weder
mechanische Verriegelungsbestätigung noch Wallboxfreigabe. RFID-Anlernen öffnet
das Firmwarefenster; Kartenanzahl/Ergebnis reichen zur Bedienung, keine UID-Liste
wird veröffentlicht. Widerrufs-UID wird nur kurz in der begrenzten Anfrage und
im ausgehenden UART-Befehl gehalten; Ergebnis und Dedupeledger enthalten sie
nicht (Ledger speichert nur SHA256). Legacy-UID-Meldungen werden verworfen.

Wallbox-Ladezustand wird unabhängig von Servo/RFID gespiegelt: nur tatsächliches
frisches `values.charging` plus frisches nicht-retained `availability=online`
erlaubt ON/OFF. Start, Retained, Reconnect, Mess-/Clockfehler oder Ablauf ergeben
UNKNOWN. Keine Ableitung aus Wattzahl, Ladefreigabe oder Befehls-ACK. Neue
identische Messzeitpunkte verlängern die Frische nicht. Spiegelung etwa alle
vier Sekunden über denselben UART-Owner; Management hat Vorrang. Die Firmware
muss nach zehn Sekunden ohne Spiegelung selbst UNKNOWN setzen.

UART-Ausfall/Bootwechsel/MQTT-Reconnect löschen Sitzungen, offene Anfragen und
Leases. Nach verlorenem ACK wird niemals ein Managementbefehl erneut gesendet.
Erneut inspizieren; der neue Status bestätigt keinen alten Befehl nachträglich.
Es gibt keine Datenbank, persistente Befehle oder reale Wallboxschreibfunktion.

## Ausschließlich Docker prüfen

```sh
docker build -f rasppi/Dockerfile.uart --target test -t evse-uart-test rasppi
docker build -f rasppi/Dockerfile.uart -t evse-uart rasppi
```

Der Produktionsbuild kopiert einen Marker aus dem Teststage: dessen Tests können
nicht durch Überspringen des separaten Testtargets umgangen werden. Teststage:
Fakeclock/Fakeserial, echtes Linux-PTY und isolierter Loopback-Mosquitto; nur dort
werden Testpakete installiert. Runtime enthält keinen Mosquitto. Kein Hosttest,
kein Produktionsbroker, keine reale serielle Hardware. Laufzeit-/ARM-/ESP32- und
mechanische Abnahme sind separate Freigaben.

Wire-Vertrag: [`../docs/esp32-gateway-contract.md`](../docs/esp32-gateway-contract.md).
Die zentrale Installationsanleitung muss bei der Elternintegration denselben
opt-in-Ablauf aufnehmen; deren Bearbeitung liegt außerhalb dieses Dateiscopes.
