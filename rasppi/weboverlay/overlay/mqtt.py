"""Subscribe-only MQTT connection. Credentials never go to the browser."""

from dataclasses import dataclass, field
import os
from pathlib import Path

import paho.mqtt.client as mqtt


@dataclass(frozen=True)
class Config:
    host: str = "mqtt-broker"
    port: int = 1883
    prefix: str = "evse/wallbox"
    client_id: str = "evse-weboverlay"
    username: str = ""
    password: str = field(default="", repr=False)
    stale_seconds: int = 10

    @classmethod
    def from_environment(cls):
        def number(name, default, low, high):
            text = os.environ.get(name, str(default))
            if not text.isascii() or not text.isdecimal() or not low <= int(text) <= high:
                raise ValueError(f"Invalid {name}")
            return int(text)

        host = os.environ.get("MQTT_HOST", "mqtt-broker")
        prefix = os.environ.get("MQTT_TOPIC_PREFIX", "evse/wallbox")
        client_id = os.environ.get("MQTT_CLIENT_ID", "evse-weboverlay")
        if not host or not client_id or len(client_id.encode()) > 128:
            raise ValueError("Invalid MQTT_HOST / MQTT_CLIENT_ID")
        if not prefix or len(prefix.encode()) > 240 or prefix.startswith("/") or prefix.endswith("/") or any(c in prefix for c in ("+", "#", "\x00")):
            raise ValueError("Invalid MQTT_TOPIC_PREFIX")
        username = os.environ.get("MQTT_USERNAME", "")
        password = os.environ.get("MQTT_PASSWORD", "")
        password_file = os.environ.get("MQTT_PASSWORD_FILE", "")
        if password_file:
            if password:
                raise ValueError("Use MQTT_PASSWORD or MQTT_PASSWORD_FILE, not both")
            try:
                with Path(password_file).open(encoding="utf-8") as stream:
                    password = stream.readline(4097).rstrip("\r\n")
            except (OSError, UnicodeError) as error:
                raise ValueError("Cannot read MQTT_PASSWORD_FILE") from error
            if not password or len(password) > 4096:
                raise ValueError("Invalid MQTT_PASSWORD_FILE")
        if password and not username:
            raise ValueError("MQTT password requires MQTT_USERNAME")
        return cls(host, number("MQTT_PORT", 1883, 1, 65535), prefix, client_id,
                   username, password, number("WEB_STALE_SECONDS", 10, 3, 120))


class Subscriber:
    def __init__(self, config, store):
        self.config = config
        self.store = store
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
                                  client_id=config.client_id, clean_session=True,
                                  protocol=mqtt.MQTTv311)
        if config.username:
            self.client.username_pw_set(config.username, config.password or None)
        self.client.reconnect_delay_set(min_delay=1, max_delay=30)
        self.client.on_connect = self.on_connect
        self.client.on_connect_fail = lambda client, userdata: store.connection(False)
        self.client.on_disconnect = lambda client, userdata, flags, reason, props: store.connection(False)
        self.client.on_subscribe = self.on_subscribe
        self.client.on_message = self.on_message

    def on_connect(self, client, userdata, flags, reason, properties):
        self.store.connection(not reason.is_failure)
        if not reason.is_failure:
            result, _ = client.subscribe([(self.config.prefix + "/state", 1),
                                          (self.config.prefix + "/availability", 1)])
            if result != mqtt.MQTT_ERR_SUCCESS:
                self.store.connection(False)

    def on_subscribe(self, client, userdata, mid, reasons, properties):
        if len(reasons) != 2 or any(reason.is_failure for reason in reasons):
            self.store.connection(False)

    def on_message(self, client, userdata, message):
        if message.topic == self.config.prefix + "/state":
            self.store.accept_sample(message.payload)
        elif message.topic == self.config.prefix + "/availability":
            self.store.accept_availability(message.payload)

    def start(self):
        # connect_async/loop_start also retry initial broker absence in the background.
        self.client.connect_async(self.config.host, self.config.port, keepalive=15)
        self.client.loop_start()

    def stop(self):
        self.store.connection(False)
        self.client.disconnect()
        self.client.loop_stop()
