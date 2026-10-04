"""Disposable MariaDB + broker only; enabled by compose.test.yaml."""
from dataclasses import replace
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
import paho.mqtt.client as mqtt
import pymysql
from storage.collector import event, now
from storage.config import Config
from storage.database import Database
from storage.protocol import decode


def payload(**changes):
    stamp = datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")
    data = {"schema_version": 1, "device": "abb_terra_ac", "timestamp": stamp,
            "status": "ok", "last_success_at": stamp, "error": None,
            "values": {"error_code": 0, "socket_lock_state": 273, "charging_state_raw": 33024,
                       "charging_state": 1, "below_commanded_current": True,
                       "plugged_in": True, "charging": False, "current_limit_a": 6,
                       "current_a": [0.123, 0, 0], "voltage_v": [235.7, 233.4, 235.3],
                       "active_power_w": 0, "session_energy_wh": 0}}
    data.update(changes)
    return json.dumps(data).encode()


def wait_for(predicate, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.1)
    raise AssertionError("Timed out waiting for isolated integration condition")


@unittest.skipUnless(os.environ.get("STORAGE_INTEGRATION") == "1", "requires isolated Docker services")
class Integration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = Config.from_environment()
        cls.db = Database(cls.config)
        cls.db.connect()
        cls.db.migrate()
        cls.db.migrate()
        cls.db.verify()
        cls.root = pymysql.connect(host=cls.config.db_host, user="root", password=os.environ["DB_ROOT_PASSWORD"],
                                   database=cls.config.db_name, charset="utf8mb4", autocommit=True,
                                   connect_timeout=3, read_timeout=3, write_timeout=3)
        with cls.root.cursor() as cursor:
            cursor.execute("CREATE USER IF NOT EXISTS 'runtime_test'@'%' IDENTIFIED BY 'isolated-runtime'")
            cursor.execute("GRANT SELECT, INSERT ON evse_test.* TO 'runtime_test'@'%'")

    @classmethod
    def tearDownClass(cls):
        cls.db.close()
        cls.root.close()

    def setUp(self):
        self.source = "test/storage/" + uuid.uuid4().hex
        self.processes, self.publishers, self.logs = [], [], []
        self.temp = tempfile.TemporaryDirectory()

    def tearDown(self):
        # Restore grants even if outage regression failed.
        with self.root.cursor() as cursor:
            cursor.execute("GRANT SELECT, INSERT ON evse_test.* TO 'runtime_test'@'%'")
        for client in self.publishers:
            client.disconnect()
            client.loop_stop()
        for process in self.processes:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                    self.fail("Storage shutdown exceeded process deadline")
            if process.returncode != 0:
                for log in self.logs:
                    log.seek(0)
                    print(log.read())
            self.assertEqual(process.returncode, 0)
        for log in self.logs:
            log.close()
        self.temp.cleanup()

    def query(self, sql, args=()):
        with self.root.cursor() as cursor:
            cursor.execute(sql, args)
            return cursor.fetchall()

    def count(self):
        return self.query("SELECT COUNT(*) FROM evse_wallbox_samples WHERE source=%s", (self.source,))[0][0]

    def item(self, raw, retained=False):
        return {"kind": "sample", "source": self.source, "sample": decode(raw), "received_at": now(), "retained": retained, "ack": None}

    def publisher(self):
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="test-pub-" + uuid.uuid4().hex)
        deadline = time.monotonic() + 15
        while True:
            try:
                client.connect(self.config.mqtt_host, self.config.mqtt_port, keepalive=10)
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.1)
        client.loop_start()
        self.publishers.append(client)
        return client

    def publish(self, client, raw, topic="state"):
        message = client.publish(self.source + "/" + topic, raw, qos=1, retain=True)
        message.wait_for_publish(5)
        self.assertTrue(message.is_published(), "Publisher must not depend on storage ACKs")

    def start(self):
        filename = Path(self.temp.name) / "db-password"
        filename.write_text("isolated-runtime\n")
        env = {**os.environ, "DB_USERNAME": "runtime_test", "DB_PASSWORD_FILE": str(filename),
               "MQTT_TOPIC_PREFIX": self.source, "MQTT_CLIENT_ID": "test-store-" + uuid.uuid4().hex}
        env.pop("DB_PASSWORD", None)
        log = tempfile.TemporaryFile(mode="w+")
        self.logs.append(log)
        process = subprocess.Popen([sys.executable, "-m", "storage"], env=env, stdout=log, stderr=log)
        self.processes.append(process)
        wait_for(lambda: self.query("SELECT COUNT(*) FROM evse_ingest_events WHERE source=%s AND kind='broker_connected'", (self.source,))[0][0] > 0)
        wait_for(lambda: json.loads(Path("/tmp/evse-storage-health.json").read_text())["subscribed"])
        return process

    def test_sql_types_nulls_errors_same_second_and_duplicate_metadata(self):
        raw = payload()
        first = self.item(raw, True)
        self.assertTrue(self.db.write(first))
        duplicate = self.item(raw, False)
        self.assertFalse(self.db.write(duplicate))
        row = self.query("SELECT received_at,retained,current_l1_a,voltage_l1_v,charging FROM evse_wallbox_samples WHERE source=%s", (self.source,))[0]
        self.assertEqual(row[:2], (first["received_at"], 1))
        self.assertEqual(str(row[2]), "0.123")
        self.assertEqual(str(row[3]), "235.7")
        self.assertEqual(row[4], 0)
        data = json.loads(raw)
        data["values"]["charging"] = None
        data["values"]["plugged_in"] = None
        self.assertTrue(self.db.write(self.item(json.dumps(data).encode())))
        self.assertEqual(self.count(), 2)
        error = payload(status="error", values=None, error="read: Connection timed out", last_success_at=data["timestamp"])
        self.assertTrue(self.db.write(self.item(error)))
        rows = self.query("SELECT status,plugged_in,charging,active_power_w FROM evse_wallbox_samples WHERE source=%s ORDER BY id", (self.source,))
        self.assertEqual(rows[1][1:3], (None, None))
        self.assertEqual(rows[2], ("error", None, None, None))

    def test_historical_future_and_parameterized_error_are_not_live_values(self):
        for stamp in ("2010-01-01T00:00:00Z", "2099-01-01T00:00:00Z"):
            self.db.write(self.item(payload(timestamp=stamp, last_success_at=stamp)))
        text = "read: '); DROP TABLE evse_wallbox_samples; -- Ä"
        self.db.write(self.item(payload(status="error", values=None, error=text, last_success_at=None)))
        self.assertEqual(self.count(), 3)
        self.assertEqual(self.query("SELECT communication_error FROM evse_wallbox_samples WHERE source=%s AND status='error'", (self.source,))[0][0], text)

    def test_event_uuid_is_idempotent_and_prefix_case_space_is_distinct(self):
        item = event(self.source, "availability", measurement_time="unknown")
        item["availability"] = "offline"
        self.assertTrue(self.db.write(item))
        self.assertFalse(self.db.write(item))
        self.assertEqual(self.query("SELECT COUNT(*) FROM evse_ingest_events WHERE event_id=%s", (item["id"],))[0][0], 1)
        raw = payload()
        for suffix in ("A", "a", "a "):
            sample = self.item(raw)
            sample["source"] += suffix
            self.assertTrue(self.db.write(sample))

    def test_runtime_account_cannot_migrate_update_or_delete(self):
        limited = Database(replace(self.config, db_user="runtime_test", db_password="isolated-runtime"))
        limited.connect()
        try:
            limited.verify()
            limited.write(self.item(payload()))
            with self.assertRaises(pymysql.MySQLError):
                limited.migrate()
            for sql in ("DELETE FROM evse_wallbox_samples WHERE 1=0", "UPDATE evse_wallbox_samples SET retained=0 WHERE 1=0"):
                with self.assertRaises(pymysql.MySQLError):
                    with limited.connection.cursor() as cursor:
                        cursor.execute(sql)
        finally:
            limited.close()

    def test_incompatible_existing_identity_is_not_blessed_as_version_one(self):
        for defect in ("missing_unique", "text_source"):
            name = "evse_bad_" + uuid.uuid4().hex[:12]
            self.query(f"CREATE DATABASE {name} CHARACTER SET utf8mb4")
            bad = Database(replace(self.config, db_name=name, db_user="root", db_password=os.environ["DB_ROOT_PASSWORD"]))
            try:
                self.query(f"CREATE TABLE {name}.evse_wallbox_samples LIKE evse_test.evse_wallbox_samples")
                if defect == "missing_unique":
                    self.query(f"ALTER TABLE {name}.evse_wallbox_samples DROP INDEX sample_identity")
                else:
                    self.query(f"ALTER TABLE {name}.evse_wallbox_samples MODIFY source VARCHAR(240) NOT NULL")
                bad.connect()
                with self.assertRaises(ValueError):
                    bad.migrate()
                self.assertEqual(self.query(f"SELECT COUNT(*) FROM {name}.evse_schema_versions")[0][0], 0)
                with self.assertRaises(ValueError):
                    bad.verify()
            finally:
                bad.close()
                self.query(f"DROP DATABASE {name}")

    def test_retained_restart_and_duplicate_delivery(self):
        publisher = self.publisher()
        raw = payload()
        self.publish(publisher, raw)
        self.publish(publisher, b"online", "availability")
        process = self.start()
        wait_for(lambda: self.count() == 1)
        self.publish(publisher, raw)
        time.sleep(0.5)
        self.assertEqual(self.count(), 1)
        self.assertEqual(self.query("SELECT retained FROM evse_wallbox_samples WHERE source=%s", (self.source,))[0][0], 1)
        process.terminate()
        process.wait(timeout=15)
        self.start()
        wait_for(lambda: self.query("SELECT COUNT(*) FROM evse_ingest_events WHERE source=%s AND kind='availability'", (self.source,))[0][0] >= 2)
        self.assertEqual(self.count(), 1)
        self.assertEqual(self.query("SELECT COUNT(*) FROM evse_ingest_events WHERE source=%s AND kind='collector_started'", (self.source,))[0][0], 2)

    def test_database_outage_keeps_pending_and_latest_retained_snapshot(self):
        publisher = self.publisher()
        process = self.start()
        self.publish(publisher, payload())
        wait_for(lambda: self.count() == 1)
        with self.root.cursor() as cursor:
            cursor.execute("REVOKE INSERT ON evse_test.* FROM 'runtime_test'@'%'")
            cursor.execute("SELECT ID FROM information_schema.PROCESSLIST WHERE USER='runtime_test'")
            for (identifier,) in cursor.fetchall():
                cursor.execute(f"KILL CONNECTION {int(identifier)}")
        self.publish(publisher, payload())
        wait_for(lambda: not json.loads(Path("/tmp/evse-storage-health.json").read_text())["database_ready"])
        latest = payload()
        self.publish(publisher, latest)  # Publisher ACK works even while collector is paused.
        with self.root.cursor() as cursor:
            cursor.execute("GRANT SELECT, INSERT ON evse_test.* TO 'runtime_test'@'%'")
        wait_for(lambda: self.count() >= 2, timeout=40)
        wait_for(lambda: self.query("SELECT COUNT(*) FROM evse_wallbox_samples WHERE source=%s AND payload_sha256=%s", (self.source, decode(latest)["hash"]))[0][0] == 1, timeout=40)
        wait_for(lambda: json.loads(Path("/tmp/evse-storage-health.json").read_text())["subscribed"], timeout=40)
        self.assertIsNone(process.poll())
