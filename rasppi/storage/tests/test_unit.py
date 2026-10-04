import json
from decimal import Decimal
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, Mock, patch

import pymysql

from storage import __main__ as runtime
from storage.collector import Inbox, Subscriber, event
from storage.config import Config
from storage.database import Database
from storage.protocol import decode, MEASUREMENT_COLUMNS


def sample_payload(timestamp="2026-10-04T12:00:00Z", *, status="ok", values=None, **overrides):
    """Return fresh schema-1 bytes; usable by broker/SQL integration tests."""
    data = {"schema_version": 1, "device": "abb_terra_ac", "timestamp": timestamp,
            "last_success_at": timestamp, "status": status, "error": None,
            "values": {"error_code": 0, "socket_lock_state": 0, "charging_state_raw": 256,
                       "charging_state": 1, "below_commanded_current": False,
                       "plugged_in": True, "charging": False, "current_limit_a": 6,
                       "current_a": [0, 1.234, 6], "voltage_v": [230.1, 231, 229.9],
                       "active_power_w": 0, "session_energy_wh": 10}}
    if status == "error":
        data.update(values=values, error="Modbus timeout", last_success_at=None)
    elif values is not None:
        data["values"].update(values)
    data.update(overrides)
    return json.dumps(data).encode()


def config(**changes):
    return Config.from_environment({"DB_HOST": "database", "DB_PASSWORD": "db-secret", **changes})


class ProtocolTests(unittest.TestCase):
    def assert_invalid(self, payload):
        with self.assertRaises(ValueError):
            decode(payload)

    def test_success_columns_and_decimal_units(self):
        result = decode(sample_payload())
        columns = dict(zip(MEASUREMENT_COLUMNS, result["columns"]))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(columns["current_l2_a"], Decimal("1.234"))
        self.assertEqual(columns["voltage_l1_v"], Decimal("230.1"))
        self.assertEqual(len(result["hash"]), 32)
        self.assertIsNone(result["measured_at"].tzinfo)

    def test_uint32_limits(self):
        for key in ("error_code", "socket_lock_state", "charging_state_raw", "charging_state",
                    "active_power_w", "session_energy_wh"):
            for value in (0, 4294967295):
                decode(sample_payload(values={key: value}))
            for value in (-1, 4294967296, True, 1.0):
                with self.subTest(key=key, value=value):
                    self.assert_invalid(sample_payload(values={key: value}))

    def test_measurement_register_limits(self):
        decode(sample_payload(values={"current_limit_a": 4294967.295,
                                      "voltage_v": [429496729.5, 0, 0]}))
        for values in ({"current_limit_a": 4294967.296}, {"voltage_v": [429496729.6, 0, 0]},
                       {"current_a": [-0.001, 0, 0]}):
            self.assert_invalid(sample_payload(values=values))

    def test_nullable_booleans_and_error_null_columns(self):
        columns = dict(zip(MEASUREMENT_COLUMNS, decode(sample_payload(
            values={"plugged_in": None, "charging": None}))["columns"]))
        self.assertIsNone(columns["plugged_in"])
        self.assertIsNone(columns["charging"])
        result = decode(sample_payload(status="error"))
        self.assertEqual(result["columns"], [None] * len(MEASUREMENT_COLUMNS))
        self.assertIsNone(json.loads(result["payload"])["values"])

    def test_canonical_dedup(self):
        original = sample_payload()
        data = json.loads(original)
        data.update(timestamp="2026-10-04T12:00:00.000000+00:00",
                    last_success_at="2026-10-04T12:00:00+00:00", ignored="metadata")
        data["values"]["ignored"] = 42
        data = dict(reversed(list(data.items())))
        alternate = json.dumps(data).replace('"current_limit_a": 6,', '"current_limit_a": 6.000e0,').encode()
        self.assertEqual(decode(original)["hash"], decode(alternate)["hash"])
        self.assertEqual(decode(original)["payload"], decode(alternate)["payload"])

    def test_changed_values_same_second_distinct(self):
        self.assertNotEqual(decode(sample_payload())["hash"],
                            decode(sample_payload(values={"session_energy_wh": 11}))["hash"])

    def test_bad_encoding_duplicate_keys_constants_and_sizes(self):
        for payload in (b"\xff", b"", b" " * 16385, b'[]', b'{}',
                        sample_payload().replace(b'"schema_version": 1', b'"schema_version": 1, "schema_version": 1'),
                        sample_payload().replace(b'"error_code": 0', b'"error_code": 0, "error_code": 0')):
            self.assert_invalid(payload)
        for literal in (b"NaN", b"Infinity", b"-Infinity", b"1e999999", b"1e-999999"):
            self.assert_invalid(sample_payload().replace(b'"current_limit_a": 6', b'"current_limit_a": ' + literal))

    def test_boolean_numbers_and_precision(self):
        for values in ({"current_limit_a": True}, {"current_a": [False, 0, 0]},
                       {"voltage_v": [True, 0, 0]}, {"current_limit_a": 0.0001},
                       {"current_a": [0.0001, 0, 0]}, {"voltage_v": [230.01, 0, 0]},
                       {"plugged_in": 1}, {"charging": 0}, {"below_commanded_current": None}):
            self.assert_invalid(sample_payload(values=values))

    def test_arrays(self):
        for key in ("current_a", "voltage_v"):
            for value in (None, {}, "000", [], [0, 0], [0, 0, 0, 0], [None, 0, 0]):
                self.assert_invalid(sample_payload(values={key: value}))

    def test_invalid_timestamps(self):
        for value in (None, "0999-01-01T00:00:00Z", "2026-02-30T12:00:00Z",
                      "2026-10-04T12:00:00", "2026-10-04T12:00:00+01:00",
                      "2026-10-04T12:00:00.1234567Z", "2026-10-04T12:00:60Z"):
            self.assert_invalid(sample_payload(timestamp=value))

    def test_history_accepts_old_and_future(self):
        for value in ("1000-01-01T00:00:00Z", "2099-12-31T23:59:59Z"):
            self.assertEqual(decode(sample_payload(timestamp=value))["measured_at"].year, int(value[:4]))

    def test_schema_status_and_consistency(self):
        for changes in ({"schema_version": True}, {"schema_version": 2}, {"device": "other"},
                        {"status": "offline"}, {"error": "unexpected"},
                        {"last_success_at": None}):
            self.assert_invalid(sample_payload(**changes))
        data = json.loads(sample_payload())
        data["values"] = None
        self.assert_invalid(json.dumps(data).encode())
        for changes in ({"error": None}, {"error": ""}, {"error": "x" * 1025}, {"values": {}}):
            self.assert_invalid(sample_payload(status="error", **changes))


class ConfigTests(unittest.TestCase):
    def test_defaults_and_no_environment_contamination(self):
        with patch.dict("os.environ", {"DB_PORT": "invalid"}, clear=True):
            c = config()
        self.assertEqual((c.db_port, c.mqtt_port, c.queue_size, c.timeout), (3306, 1883, 256, 3))
        self.assertEqual((c.db_name, c.db_user, c.prefix, c.client_id),
                         ("evse_control", "evse_storage", "evse/wallbox", "evse-storage"))

    def test_required_database(self):
        for changes in ({"DB_HOST": ""}, {"DB_PASSWORD": ""}, {"DB_USERNAME": ""}, {"DB_NAME": "bad-name"}):
            with self.assertRaises(ValueError):
                config(**changes)

    def test_password_files_conflicts_and_repr(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "secret"
            path.write_text("file-secret\n", encoding="utf-8")
            c = config(DB_PASSWORD="", DB_PASSWORD_FILE=str(path), MQTT_USERNAME="reader", MQTT_PASSWORD="mqtt-secret")
            self.assertEqual(c.db_password, "file-secret")
            self.assertNotIn("file-secret", repr(c))
            self.assertNotIn("mqtt-secret", repr(c))
            for key in ("DB_PASSWORD", "MQTT_PASSWORD"):
                with self.assertRaises(ValueError):
                    config(**{key: "secret", key + "_FILE": str(path), "MQTT_USERNAME": "reader"})

    def test_unreadable_and_oversized_secrets(self):
        with patch("storage.config.Path.stat", side_effect=PermissionError):
            with self.assertRaises(ValueError):
                config(DB_PASSWORD="", DB_PASSWORD_FILE="unreadable")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "secret"
            path.write_bytes(b"x" * 4097)
            with self.assertRaises(ValueError):
                config(DB_PASSWORD="", DB_PASSWORD_FILE=str(path))
        for password in ("x" * 4097, "line\nbreak", "nul\x00byte"):
            with self.assertRaises(ValueError):
                config(DB_PASSWORD=password)

    def test_mqtt_credentials(self):
        with self.assertRaises(ValueError):
            config(MQTT_PASSWORD="secret")
        self.assertEqual(config(MQTT_USERNAME="reader", MQTT_PASSWORD="secret").mqtt_user, "reader")

    def test_optional_mqtt_secret_file_must_not_silently_fall_back_to_no_password(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "mqtt-secret"
            for value in (b"", b"\n", b"x" * 4097, b"first\nsecond"):
                path.write_bytes(value)
                with self.assertRaises(ValueError):
                    config(MQTT_USERNAME="reader", MQTT_PASSWORD_FILE=str(path))
            with self.assertRaises(ValueError):
                config(MQTT_USERNAME="reader", MQTT_PASSWORD_FILE=directory)

    def test_prefix(self):
        for prefix in ("", "/evse", "evse/", "evse/+", "evse/#", "x\n", "x" * 241):
            with self.assertRaises(ValueError):
                config(MQTT_TOPIC_PREFIX=prefix)

    def test_ports_and_numeric_bounds(self):
        for key, low, high in (("DB_PORT", 1, 65535), ("MQTT_PORT", 1, 65535),
                               ("STORAGE_QUEUE_SIZE", 8, 4096), ("DB_TIMEOUT_SECONDS", 1, 10)):
            for value in (str(low), str(high)):
                config(**{key: value})
            for value in (str(low - 1), str(high + 1), "1.0", "True", "１２", "-1"):
                with self.assertRaises(ValueError):
                    config(**{key: value})


class InboxTests(unittest.TestCase):
    def test_finite_queue_and_aggregated_gap(self):
        inbox = Inbox("source", 1)
        self.assertTrue(inbox.put(event("source", "first")))
        self.assertFalse(inbox.put(event("source", "second")))
        self.assertFalse(inbox.put(event("source", "third")))
        inbox.reject()
        inbox.reject()
        self.assertTrue(inbox.pressure.is_set())
        self.assertEqual(inbox.stats(), {"queued": 1, "dropped": 2, "invalid": 2})
        details = json.loads(inbox.gap()["details"])
        self.assertEqual(details, {"rejected_deliveries": 2, "queue_rejected_records": 2, "missed_samples": "unknown"})
        self.assertIsNone(inbox.gap())
        self.assertEqual(inbox.stats()["dropped"], 2)

    def test_event_identity_created_once(self):
        with patch("storage.collector.uuid.uuid4") as uuid:
            uuid.return_value.bytes = b"u" * 16
            item = event("source", "availability")
            self.assertEqual(item["id"], b"u" * 16)
            self.assertEqual(item["id"], item["id"])
            uuid.assert_called_once_with()
        self.assertIsNone(item["ack"])


class SubscriberTests(unittest.TestCase):
    def setUp(self):
        self.inbox = Inbox("evse/wallbox", 8)
        self.sub = Subscriber(config(), self.inbox)
        self.client = Mock()
        self.client.subscribe.return_value = (0, 1)
        self.client.ack.return_value = 0
        self.sub.client = self.client
        self.sub.on_connect(self.client, None, None, SimpleNamespace(is_failure=False), None)
        self.inbox.queue.get_nowait()

    def message(self, payload=None, suffix="state", qos=1):
        return SimpleNamespace(topic="evse/wallbox/" + suffix, payload=sample_payload() if payload is None else payload,
                               mid=42, qos=qos, retain=True)

    def test_start_manual_ack(self):
        with patch("storage.collector.mqtt.Client", return_value=Mock()) as factory:
            self.sub.start()
        self.assertTrue(factory.call_args.kwargs["manual_ack"])
        self.assertTrue(factory.call_args.kwargs["clean_session"])

    def test_ack_only_current_connected_generation(self):
        token = (self.sub.generation, 42, 1, 1)
        self.sub.pending_mids[42] = token
        self.sub.ack(token)
        self.client.ack.assert_called_once_with(42, 1)
        self.client.ack.reset_mock()
        self.sub.ack(None)
        self.sub.ack((token[0] - 1, 42, 1, 1))
        self.sub.connected = False
        self.sub.ack(token)
        self.client.ack.assert_not_called()

    def test_reused_mid_in_same_connection_does_not_ack_new_delivery(self):
        self.sub.on_message(self.client, None, self.message())
        older = self.inbox.queue.get_nowait()["ack"]
        self.sub.on_message(self.client, None, self.message())
        newer = self.inbox.queue.get_nowait()["ack"]
        self.sub.ack(older)
        self.client.ack.assert_not_called()
        self.sub.ack(newer)
        self.client.ack.assert_called_once_with(42, 1)

    def test_old_client_callbacks_ignored(self):
        old = Mock()
        generation = self.sub.generation
        self.sub.on_connect(old, None, None, SimpleNamespace(is_failure=False), None)
        self.sub.on_disconnect(old, None, None, None, None)
        self.sub.on_subscribe(old, None, 1, [], None)
        self.sub.on_message(old, None, self.message())
        self.assertEqual(self.sub.generation, generation)
        self.assertTrue(self.sub.connected)
        self.assertEqual(self.inbox.stats()["queued"], 0)

    def test_malformed_ack_but_overflow_withholds(self):
        self.sub.on_message(self.client, None, self.message(b"invalid"))
        self.client.ack.assert_called_once_with(42, 1)
        self.assertEqual(self.inbox.invalid, 1)
        self.client.ack.reset_mock()
        for _ in range(9):
            self.sub.on_message(self.client, None, self.message())
        self.client.ack.assert_not_called()
        self.client.disconnect.assert_called_once_with()
        self.assertEqual(self.inbox.dropped, 1)

    def test_qos_retained_and_nullable_mapping(self):
        for qos in (0, 1):
            self.sub.on_message(self.client, None, self.message(sample_payload(values={"charging": None}), qos=qos))
            item = self.inbox.queue.get_nowait()
            self.assertEqual(item["ack"][:3], (self.sub.generation, 42, qos))
            self.assertTrue(item["retained"])
            self.assertIsNone(item["sample"]["columns"][MEASUREMENT_COLUMNS.index("charging")])

    def test_subscription_denied(self):
        self.sub.on_subscribe(self.client, None, 1, [SimpleNamespace(is_failure=False), SimpleNamespace(is_failure=True)], None)
        self.assertFalse(self.sub.subscribed)
        self.assertTrue(self.inbox.pressure.is_set())
        self.client.disconnect.assert_called_once_with()


class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.db = Database(config())
        self.connection = self.db.connection = MagicMock()
        self.cursor = self.connection.cursor.return_value.__enter__.return_value = Mock()
        self.item = event("source", "availability")

    def test_insert_only_and_duplicate_identity(self):
        for item in (self.item, {**self.item, "kind": "sample", "sample": decode(sample_payload())}):
            self.cursor.execute.side_effect = None
            self.assertTrue(self.db.write(item))
            sql = self.cursor.execute.call_args.args[0].upper()
            self.assertTrue(sql.startswith("INSERT INTO"))
            self.assertNotIn("UPDATE", sql)
            self.assertNotIn("IGNORE", sql)
            self.cursor.execute.side_effect = [pymysql.IntegrityError(1062, "duplicate"), None]
            self.cursor.fetchone.return_value = (1,)
            self.assertFalse(self.db.write(item))
            identity = self.cursor.execute.call_args.args[1]
            self.assertIn(item["sample"]["hash"] if item["kind"] == "sample" else item["id"], identity)

    def test_other_integrity_error_and_unconfirmed_duplicate_raise(self):
        for code in (1048, 1452, 1062):
            self.cursor.execute.side_effect = [pymysql.IntegrityError(code, "constraint"), None]
            self.cursor.fetchone.return_value = None
            with self.assertRaises(pymysql.IntegrityError):
                self.db.write(self.item)
        self.assertEqual(self.connection.rollback.call_count, 3)

    def test_commit_ambiguity_retries_same_event_in_runtime(self):
        stop = threading.Event()
        written = []
        def write(item):
            written.append((item, item["id"]))
            if len(written) == 1:
                raise pymysql.OperationalError(2013, "COMMIT response lost")
            stop.set()
            return False
        with patch.object(runtime, "Database") as database, patch.object(runtime, "Subscriber"), \
                patch.object(runtime, "health"), patch.object(runtime, "diagnostic"), patch.object(stop, "wait"):
            database.return_value.write.side_effect = write
            runtime.run(config(), stop)
        self.assertIs(written[0][0], written[1][0])
        self.assertEqual(written[0][1], written[1][1])
        self.assertGreaterEqual(database.return_value.connect.call_count, 2)


if __name__ == "__main__":
    unittest.main()
