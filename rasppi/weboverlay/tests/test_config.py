import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from overlay.mqtt import Config, Subscriber
from overlay.state import StateStore


class ConfigTests(unittest.TestCase):
    def test_defaults(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(Config.from_environment(), Config())

    def test_invalid_configuration(self):
        for env in ({"MQTT_PORT": "0"}, {"MQTT_PORT": "65536"}, {"MQTT_PORT": "1x"},
                    {"MQTT_HOST": ""}, {"MQTT_CLIENT_ID": ""}, {"MQTT_TOPIC_PREFIX": "evse/#"},
                    {"MQTT_TOPIC_PREFIX": "evse/"}, {"MQTT_PASSWORD": "test-secret"},
                    {"WEB_STALE_SECONDS": "0"}, {"MQTT_PASSWORD_FILE": "/does/not/exist"}):
            with self.subTest(env=env), patch.dict(os.environ, env, clear=True):
                with self.assertRaises(ValueError) as result:
                    Config.from_environment()
                self.assertNotIn("test-secret", str(result.exception))

    def test_password_file(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "password"
            file.write_text("test-secret\n")
            with patch.dict(os.environ, {"MQTT_USERNAME": "test", "MQTT_PASSWORD_FILE": str(file)}, clear=True):
                config = Config.from_environment()
                self.assertEqual(config.password, "test-secret")
                self.assertNotIn("test-secret", repr(config))
                with patch.dict(os.environ, {"MQTT_PASSWORD": "another"}):
                    with self.assertRaises(ValueError):
                        Config.from_environment()

    def test_subscribe_denied_fails_closed(self):
        from paho.mqtt.reasoncodes import ReasonCode
        from paho.mqtt.packettypes import PacketTypes
        store = StateStore()
        subscriber = Subscriber(Config(), store)
        store.connection(True)
        subscriber.on_subscribe(None, None, 1,
                                [ReasonCode(PacketTypes.SUBACK, identifier=128)], None)
        self.assertFalse(store.snapshot()["broker_connected"])
