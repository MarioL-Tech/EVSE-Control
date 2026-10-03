from copy import deepcopy
from datetime import datetime, timezone
import json
import unittest

from overlay.app import create_app
from overlay.mqtt import Config
from overlay.state import StateStore


def sample(epoch=1791061398):
    timestamp = datetime.fromtimestamp(epoch, timezone.utc).isoformat().replace("+00:00", "Z")
    return {"schema_version": 1, "device": "abb_terra_ac", "timestamp": timestamp,
            "status": "ok", "last_success_at": timestamp, "error": None,
            "values": {"error_code": 0, "socket_lock_state": 273, "charging_state_raw": 33024,
                       "charging_state": 1, "below_commanded_current": True,
                       "plugged_in": True, "charging": False, "current_limit_a": 6.0,
                       "current_a": [0.0, 0.0, 0.0], "voltage_v": [235.7, 233.4, 235.3],
                       "active_power_w": 0, "session_energy_wh": 0}}


def encoded(data):
    return json.dumps(data).encode()


class StateTests(unittest.TestCase):
    def setUp(self):
        self.now = 1791061398
        self.elapsed = 100
        self.store = StateStore(10, lambda: self.now, lambda: self.elapsed)

    def load(self, data=None):
        self.store.connection(True)
        self.store.accept_sample(encoded(data or sample(self.now)))
        self.store.accept_availability(b"online")

    def test_waiting_and_both_topic_orders(self):
        self.assertEqual(self.store.snapshot()["status"], "offline")
        self.store.connection(True)
        self.store.accept_availability(b"online")
        self.assertEqual(self.store.snapshot()["status"], "waiting")
        self.store.accept_sample(encoded(sample(self.now)))
        self.assertEqual(self.store.snapshot()["status"], "live")
        self.store.connection(True)
        self.store.accept_sample(encoded(sample(self.now)))
        self.assertEqual(self.store.snapshot()["status"], "waiting")
        self.store.accept_availability(b"online")
        self.assertEqual(self.store.snapshot()["values"]["current_limit_a"], 6)

    def test_stale_retained_online_is_not_live(self):
        self.load(sample(self.now - 30))
        self.assertEqual(self.store.snapshot()["status"], "stale")
        self.assertIsNone(self.store.snapshot()["values"])

    def test_expiry_without_messages_and_monotonic_age(self):
        self.load()
        self.now -= 1
        self.elapsed += 10
        self.assertEqual(self.store.snapshot()["status"], "stale")
        self.assertEqual(self.store.snapshot()["fresh_for_seconds"], 0)

    def test_duplicate_cannot_renew_expiry_after_clock_change(self):
        self.load()
        original = sample(self.now)
        self.elapsed += 11
        self.now -= 1
        self.store.accept_sample(encoded(original))
        self.assertEqual(self.store.snapshot()["status"], "stale")

    def test_future_rejected_until_new_sample(self):
        self.load(sample(self.now + 20))
        self.assertEqual(self.store.snapshot()["status"], "clock_error")
        self.now += 18
        self.assertEqual(self.store.snapshot()["status"], "clock_error")
        self.store.accept_sample(encoded(sample(self.now)))
        self.assertEqual(self.store.snapshot()["status"], "live")

    def test_invalid_message_does_not_erase_duplicate_age(self):
        self.load()
        original = sample(self.now)
        self.elapsed += 11
        self.now += 1
        self.store.accept_sample(b"broken-json")
        self.assertEqual(self.store.snapshot()["status"], "invalid")
        self.store.accept_sample(encoded(original))
        self.assertEqual(self.store.snapshot()["status"], "stale")

    def test_clock_error_detected_after_ingestion_is_latched(self):
        self.load()
        original = self.now
        self.now -= 6
        self.assertEqual(self.store.snapshot()["status"], "clock_error")
        self.now = original + 1
        self.assertEqual(self.store.snapshot()["status"], "clock_error")
        self.store.accept_sample(b"invalid")
        self.store.accept_sample(encoded(sample(original)))
        self.assertEqual(self.store.snapshot()["status"], "clock_error")
        self.store.accept_sample(encoded(sample(self.now)))
        self.assertEqual(self.store.snapshot()["status"], "live")

    def test_disconnect_reconnect_clears_old_online(self):
        self.load()
        self.store.connection(False)
        self.assertIsNone(self.store.snapshot()["values"])
        self.store.connection(True)
        self.store.accept_sample(encoded(sample(self.now)))
        self.assertEqual(self.store.snapshot()["status"], "waiting")

    def test_read_error_and_recovery(self):
        self.load()
        failed = sample(self.now + 1)
        failed.update(status="error", values=None, error="read: Connection timed out")
        self.store.accept_sample(encoded(failed))
        self.assertEqual(self.store.snapshot()["status"], "read_error")
        self.assertIsNone(self.store.snapshot()["values"])
        self.store.accept_sample(encoded(sample(self.now + 2)))
        self.assertEqual(self.store.snapshot()["status"], "live")

    def test_offline_and_unknown_availability(self):
        self.load()
        for payload, status in ((b"offline", "offline"), (b"ONLINE", "invalid"), (b"", "invalid")):
            self.store.accept_availability(payload)
            self.assertEqual(self.store.snapshot()["status"], status)
            self.assertIsNone(self.store.snapshot()["values"])

    def test_unknown_flags_and_wallbox_error_are_not_invented(self):
        data = sample(self.now)
        data["values"].update(charging_state=5, plugged_in=None, charging=None, error_code=7)
        self.load(data)
        result = self.store.snapshot()
        self.assertEqual(result["status"], "live")
        self.assertIsNone(result["values"]["charging"])
        self.assertEqual(result["values"]["error_code"], 7)

    def test_malformed_inputs_invalidate_immediately(self):
        cases = [b"", b"{", b"null", b"[]", b"\xff", b" " * 16385,
                 b'{"schema_version":1,"schema_version":1}']
        for key, value in (("schema_version", 2), ("schema_version", True), ("device", "other"),
                           ("timestamp", "2026-10-03T12:00:00"), ("values", None)):
            data = sample(self.now)
            data[key] = value
            cases.append(encoded(data))
        for key, value in (("current_a", [0, 0]), ("current_limit_a", True),
                           ("voltage_v", [0, float("nan"), 0]), ("charging", "false"),
                           ("active_power_w", -1), ("current_limit_a", float("inf"))):
            data = sample(self.now)
            data["values"][key] = value
            cases.append(encoded(data))
        for payload in cases:
            with self.subTest(payload=payload[:80]):
                self.load()
                self.store.accept_sample(payload)
                self.assertEqual(self.store.snapshot()["status"], "invalid")
                self.assertIsNone(self.store.snapshot()["values"])

    def test_out_of_order_and_snapshot_ownership(self):
        self.load()
        self.store.accept_sample(encoded(sample(self.now - 2)))
        result = self.store.snapshot()
        self.assertEqual(result["timestamp"], sample(self.now)["timestamp"])
        result["values"]["current_a"][0] = 999
        self.assertEqual(self.store.snapshot()["values"]["current_a"][0], 0)

    def test_http_read_only_headers_and_allowlist(self):
        self.load()
        app = create_app(Config(password="never-return-this"), self.store, start_mqtt=False)
        client = app.test_client()
        result = client.get("/api/state")
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.headers["Cache-Control"], "no-store")
        self.assertIn("script-src 'self'", result.headers["Content-Security-Policy"])
        self.assertNotIn(b"never-return-this", result.data)
        self.assertIsNone(result.headers.get("Access-Control-Allow-Origin"))
        self.assertEqual(client.post("/api/state", json={"charging": True}).status_code, 405)
        self.assertEqual(client.put("/api/state").status_code, 405)
        self.assertEqual(client.get("/api/command").status_code, 404)
        self.assertEqual(client.get("/healthz").status_code, 200)
        self.assertEqual(client.get("/").status_code, 200)
        self.assertEqual(client.get("/static/../../overlay/mqtt.py").status_code, 404)


if __name__ == "__main__":
    unittest.main()
