"""Schema-2 tests on a NEW disposable database in compose.test.yaml only.

The original 39 tests continue to use their schema-1 database unchanged.
"""
from dataclasses import replace
from datetime import datetime, timedelta
import json
import os
import unittest
import uuid
from unittest.mock import patch

import pymysql

from storage.collector import event
from storage.config import Config
from storage.database import Database
from storage.history import CHUNK, HistoryWorker, dirty, migrate_history, minute
from storage.protocol import decode
from test_unit import sample_payload

START = datetime(2026, 10, 25, 1)


@unittest.skipUnless(os.environ.get("STORAGE_INTEGRATION") == "1", "isolated Docker database required")
class HistoryIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        base = Config.from_environment()
        cls.root = pymysql.connect(host=base.db_host, user="root", password=os.environ["DB_ROOT_PASSWORD"],
                                   autocommit=True, connect_timeout=3, read_timeout=3, write_timeout=3)
        # No shared schema-1 fixture upgrade; CREATE a new isolated database.
        name = "history_fixture_" + uuid.uuid4().hex[:12]
        with cls.root.cursor() as c:
            c.execute(f"CREATE DATABASE {name} CHARACTER SET utf8mb4")
        cls.base = replace(base, db_name=name, db_user="root", db_password=os.environ["DB_ROOT_PASSWORD"])
        cls.fixture = Database(cls.base)
        cls.fixture.connect()
        cls.fixture.migrate()
        cls.fixture.verify()
        assert not cls.fixture.history_enabled
        with cls.fixture.connection.cursor() as c:
            c.execute("CREATE TABLE T_ELECTRICITYPRICE (id INT PRIMARY KEY, price DECIMAL(12,4)) ENGINE=InnoDB")
            c.execute("CREATE TABLE T_ELECTRICITYPROVIDER (id INT PRIMARY KEY, name VARCHAR(64)) ENGINE=InnoDB")
            c.execute("INSERT INTO T_ELECTRICITYPRICE VALUES (1,0.1234)")
            c.execute("INSERT INTO T_ELECTRICITYPROVIDER VALUES (1,'isolated fixture')")
        cls.fixture.connection.commit()
        raw = {"kind": "sample", "sample": decode(sample_payload()), "source": "before/upgrade",
               "received_at": START, "retained": True}
        cls.fixture.write(raw)
        with cls.fixture.connection.cursor() as c:
            c.execute("SELECT * FROM evse_wallbox_samples ORDER BY id")
            cls.original_raw = c.fetchall()
        cls.fixture.connection.commit()
        migrate_history(cls.fixture)
        migrate_history(cls.fixture)

    @classmethod
    def tearDownClass(cls):
        cls.fixture.close()
        cls.root.close()  # Disposable service tmpfs owns cleanup; no DELETE needed.

    def setUp(self):
        self.source = "history/test/" + uuid.uuid4().hex
        self.config = replace(self.base, prefix=self.source)
        self.db = Database(self.config)
        self.db.connect()
        self.db.verify()
        self.worker_db = Database(self.config)
        self.worker_db.connect()
        self.worker = HistoryWorker(self.worker_db)
        self.worker.acquire()

    def tearDown(self):
        self.worker_db.close()
        self.db.close()

    def query(self, sql, args=()):
        with self.db.connection.cursor() as c:
            c.execute(sql, args)
            rows = c.fetchall()
        self.db.connection.commit()
        return rows

    def sample(self, second=0, **changes):
        at = START + timedelta(seconds=second)
        stamp = at.isoformat(timespec="microseconds") + "Z"
        values = changes.pop("values", None)
        raw = sample_payload(timestamp=stamp, values=values, **changes)
        return {"kind": "sample", "source": self.source, "sample": decode(raw), "received_at": at,
                "retained": False, "ack": None}

    def availability(self, second=-60, availability="online", retained=False, kind="availability"):
        item = event(self.source, kind)
        item.update(received_at=START + timedelta(seconds=second), retained=retained)
        if kind == "availability":
            item["availability"] = availability
        return item

    def drain(self):
        for _ in range(200):
            self.worker.turn()
            pending = self.query("SELECT COUNT(*) FROM evse_history_work WHERE source=%s AND pending=1", (self.source,))[0][0]
            state = self.query("SELECT samples_done,events_done,invalidate_from FROM evse_history_state WHERE source=%s", (self.source,))[0]
            if not pending and state == (1, 1, None):
                return
        self.fail("bounded test turns did not drain")

    def bucket(self, at=START, seconds=60):
        rows = self.query("SELECT data_json FROM evse_history_buckets WHERE source=%s AND resolution_seconds=%s AND bucket_start=%s",
                          (self.source, seconds, at))
        return json.loads(rows[0][0])

    def generations(self):
        return self.query("SELECT resolution_seconds,bucket_start,generation,done_generation,pending FROM evse_history_work WHERE source=%s ORDER BY resolution_seconds,bucket_start", (self.source,))

    def test_upgrade_preserves_raw_prices_provider_and_base_migration(self):
        self.assertEqual(self.query("SELECT * FROM evse_wallbox_samples WHERE source='before/upgrade' ORDER BY id"), self.original_raw)
        self.assertEqual(str(self.query("SELECT price FROM T_ELECTRICITYPRICE")[0][0]), "0.1234")
        self.assertEqual(self.query("SELECT * FROM T_ELECTRICITYPROVIDER"), ((1, "isolated fixture"),))
        self.assertEqual(self.query("SELECT version FROM evse_schema_versions ORDER BY version"), ((1,), (2,)))
        self.db.migrate()  # Default remains a no-op on supported schema 2.
        self.db.verify()
        self.assertTrue(self.db.history_enabled)

    def test_shape_rejects_missing_pending_index(self):
        # Shape checks inspect the index, not merely the three table names.
        from storage.history import verify_history_shape
        from unittest.mock import MagicMock
        fake = MagicMock()
        fake.config.db_name = self.config.db_name
        c = fake.connection.cursor.return_value.__enter__.return_value
        c.fetchone.return_value = ("utf8mb4_bin",)
        c.fetchall.return_value = (("source", None),)
        with self.assertRaises(ValueError):
            verify_history_shape(fake)

    def test_coordinated_activation_stops_schema_one_collector_before_migration(self):
        name = "history_activation_" + uuid.uuid4().hex[:12]
        with self.root.cursor() as c:
            c.execute(f"CREATE DATABASE {name} CHARACTER SET utf8mb4")
        config = replace(self.config, db_name=name)
        old_collector, migrator, collector, worker_db = (Database(config) for _ in range(4))
        try:
            old_collector.connect()
            old_collector.migrate()
            old_collector.verify()
            self.assertFalse(old_collector.history_enabled)
            old_collector.write(self.availability(-180))
            old_collector.write(self.sample(-120, values={"active_power_w": 10}))
            old_collector.close()  # Supported activation stops intake first.

            migrator.connect()
            migrate_history(migrator)
            migrator.close()
            collector.connect()  # New image/process, never reuse stale v1 state.
            collector.verify()
            self.assertTrue(collector.history_enabled)
            collector.write(self.sample(0, values={"active_power_w": 20}))
            with collector.connection.cursor() as c:
                c.execute("SELECT pending FROM evse_history_work WHERE source=%s AND resolution_seconds=60 AND bucket_start=%s",
                          (self.source, START))
                self.assertEqual(c.fetchone(), (1,))
            collector.connection.commit()

            worker_db.connect()  # Worker starts only after collector restart.
            worker = HistoryWorker(worker_db)
            worker.acquire()
            worker.backfill()
            collector.write(self.sample(2, values={"active_power_w": 30}))
            for _ in range(200):
                worker.turn()
                with collector.connection.cursor() as c:
                    c.execute("SELECT COUNT(*) FROM evse_history_work WHERE source=%s AND pending=1", (self.source,))
                    pending = c.fetchone()[0]
                    c.execute("SELECT samples_done,events_done,invalidate_from FROM evse_history_state WHERE source=%s", (self.source,))
                    state = c.fetchone()
                collector.connection.commit()
                if not pending and state == (1, 1, None):
                    break
            else:
                self.fail("coordinated activation did not finish backfill/dirty work")
            with collector.connection.cursor() as c:
                c.execute("SELECT bucket_start,data_json FROM evse_history_buckets WHERE source=%s AND resolution_seconds=60 ORDER BY bucket_start",
                          (self.source,))
                buckets = {at: json.loads(payload) for at, payload in c.fetchall()}
                c.execute("SELECT COUNT(*) FROM evse_wallbox_samples WHERE source=%s", (self.source,))
                self.assertEqual(c.fetchone(), (3,))
            collector.connection.commit()
            old = buckets[START - timedelta(minutes=2)]
            self.assertEqual(old["samples"], 1)
            self.assertEqual(old["metrics"]["active_power_w"]["sum"], "10")
            self.assertEqual(buckets[START]["samples"], 2)
            self.assertEqual(buckets[START]["metrics"]["active_power_w"]["sum"], "50")
        finally:
            for db in (old_collector, migrator, collector, worker_db):
                db.close()

    def test_duplicate_and_uncertain_commit_never_repeat_notification(self):
        item = self.sample()
        original_commit = self.db.connection.commit
        def lost_reply():
            original_commit()
            raise pymysql.OperationalError(2013, "isolated COMMIT reply lost")
        with patch.object(self.db.connection, "commit", side_effect=lost_reply):
            with self.assertRaises(pymysql.OperationalError):
                self.db.write(item)
        before = self.generations()
        self.assertFalse(self.db.write(item))
        self.assertEqual(self.generations(), before)
        item = self.availability()
        self.assertTrue(self.db.write(item))
        state = self.query("SELECT invalidate_from,invalidate_cursor FROM evse_history_state WHERE source=%s", (self.source,))
        self.assertFalse(self.db.write(item))
        self.assertEqual(self.query("SELECT invalidate_from,invalidate_cursor FROM evse_history_state WHERE source=%s", (self.source,)), state)

    def test_stats_idempotence_and_replacement(self):
        self.db.write(self.availability())
        for second in range(-2, 62, 2):
            self.db.write(self.sample(second, values={"active_power_w": 1000, "session_energy_wh": 9}))
        self.drain()
        first = self.bucket()
        self.assertEqual(first["coverage_seconds"], "60")
        self.assertEqual(first["metrics"]["active_power_w"]["sum"], "30000")
        self.assertIsNone(first["metrics"]["session_energy_wh"]["sum"])
        with self.db.connection.cursor() as c:
            dirty(c, self.source, START)
        self.db.connection.commit()
        self.drain()
        self.assertEqual(self.bucket(), first)
        self.assertEqual(self.bucket(seconds=3600)["metrics"]["active_power_w"]["n"], 31)

    def test_left_adjoining_retained_edge_and_in_bucket_tie(self):
        self.db.write(self.availability())
        left = self.sample(-2)
        left["retained"] = True
        self.db.write(left)
        for second in range(0, 62, 2):
            self.db.write(self.sample(second, values={"active_power_w": 0, "charging": None}))
        self.drain()
        healthy = self.bucket()
        self.assertTrue(healthy["complete"])
        self.assertFalse(healthy["has_gap"])
        self.assertEqual(healthy["coverage_seconds"], "60")
        self.assertEqual(healthy["metrics"]["active_power_w"]["sum"], "0")
        self.assertEqual(healthy["metrics"]["charging"]["nulls"], 30)
        # A different payload at the same in-bucket time is not deduplicated
        # and must remain ambiguous, even with 60 seconds of other good edges.
        self.db.write(self.sample(0, values={"active_power_w": 1, "charging": None}))
        self.drain()
        tied = self.bucket()
        self.assertEqual(tied["samples"], 31)
        self.assertEqual(tied["coverage_seconds"], "60")
        self.assertTrue(tied["has_gap"])

    def test_explicit_refresh_requeues_only_existing_source_minutes_in_range(self):
        import threading
        from storage.history_refresh import refresh_history

        self.db.write(self.availability())
        for second in range(-2, 182, 2):
            self.db.write(self.sample(second, values={"charging": None, "active_power_w": 100}))
        self.drain()
        original = self.bucket()
        self.assertFalse(original["has_gap"])
        # Simulate a persisted, conservative summary from the old algorithm.
        conservative = {**original, "has_gap": True, "coverage_seconds": "0"}
        other = self.source.upper()  # Binary source matching must not fold case.
        with self.db.connection.cursor() as c:
            c.execute("UPDATE evse_history_buckets SET data_json=%s WHERE source=%s "
                      "AND resolution_seconds=60 AND bucket_start=%s",
                      (json.dumps(conservative), self.source, START))
            c.execute("INSERT INTO evse_history_buckets (source,resolution_seconds,bucket_start,data_json,updated_at) "
                      "SELECT %s,resolution_seconds,bucket_start,data_json,updated_at FROM evse_history_buckets WHERE source=%s",
                      (other, self.source))
            c.execute("INSERT INTO evse_history_work (source,resolution_seconds,bucket_start,generation,done_generation,pending) "
                      "SELECT %s,resolution_seconds,bucket_start,generation,done_generation,pending "
                      "FROM evse_history_work WHERE source=%s", (other, self.source))
        self.db.connection.commit()

        def work():
            return self.query("SELECT source,resolution_seconds,bucket_start,generation,done_generation,pending "
                              "FROM evse_history_work WHERE source IN (%s,%s) ORDER BY source,resolution_seconds,bucket_start",
                              (self.source, other))

        def unchanged():
            return (
                self.query("SELECT * FROM evse_wallbox_samples WHERE source=%s ORDER BY id", (self.source,)),
                self.query("SELECT * FROM evse_ingest_events WHERE source=%s ORDER BY event_id", (self.source,)),
                self.query("SELECT * FROM evse_history_buckets WHERE source IN (%s,%s) "
                           "ORDER BY source,resolution_seconds,bucket_start", (self.source, other)),
                self.query("SELECT * FROM evse_history_state WHERE source=%s", (self.source,)),
                self.query("SELECT * FROM evse_schema_versions ORDER BY version"),
                self.query("SELECT * FROM T_ELECTRICITYPRICE ORDER BY id"),
                self.query("SELECT * FROM T_ELECTRICITYPROVIDER ORDER BY id"),
            )

        before, untouched = work(), unchanged()
        start, end = START.isoformat() + "Z", (START + timedelta(minutes=2)).isoformat() + "Z"
        for repeat in (1, 2):
            self.assertEqual(refresh_history(self.db, start, end, threading.Event()), 2)
            expected = []
            for source, resolution, at, generation, done, pending in before:
                selected = source == self.source.encode() and resolution == 60 and START <= at < START + timedelta(minutes=2)
                expected.append((source, resolution, at, generation + (repeat if selected else 0), done,
                                 1 if selected else pending))
            self.assertEqual(work(), tuple(expected))
            self.assertEqual(unchanged(), untouched)  # Includes byte-identical raw/materializations and version/state.
        self.assertEqual(self.query("SELECT algorithm_version FROM evse_history_state WHERE source=%s", (self.source,)), ((1,),))
        self.assertEqual(self.query("SELECT version FROM evse_schema_versions ORDER BY version"), ((1,), (2,)))
        self.drain()  # Ordinary worker owns reconstruction and parent notification.
        self.assertEqual(self.bucket(), original)
        parent = self.bucket(seconds=3600)
        self.assertTrue(parent["has_gap"])
        self.assertFalse(parent["complete"])
        self.assertEqual(self.query("SELECT data_json FROM evse_history_buckets WHERE source=%s "
                                    "AND resolution_seconds=60 AND bucket_start=%s", (other, START)),
                         ((json.dumps(conservative),),))

    def test_backfill_and_new_live_insert_concurrently(self):
        for second in range(CHUNK + 3):
            self.db.write(self.sample(second))
        self.worker.backfill()
        high = self.query("SELECT sample_highwater FROM evse_history_state WHERE source=%s", (self.source,))[0][0]
        self.db.write(self.sample(301))
        self.drain()
        self.assertEqual(self.query("SELECT sample_highwater FROM evse_history_state WHERE source=%s", (self.source,))[0][0], high)
        self.assertEqual(self.bucket(START + timedelta(minutes=5))["samples"], 1)

    def test_live_generation_change_discards_obsolete_result(self):
        self.db.write(self.sample())
        self.worker.backfill()
        self.worker.invalidations()
        original = self.worker.raw_minute
        injected = []
        def concurrent(cursor, start):
            result = original(cursor, start)
            if not injected:
                self.db.write(self.sample(1, values={"active_power_w": 99}))
                injected.append(True)
            return result
        with patch.object(self.worker, "raw_minute", side_effect=concurrent):
            self.worker.job()
        self.drain()
        self.assertEqual(self.bucket()["samples"], 2)
        self.assertEqual(self.bucket()["metrics"]["active_power_w"]["sum"], "99")

    def test_restart_preserves_keyset_cursors_and_source_lock(self):
        for second in range(CHUNK + 5):
            self.db.write(self.sample(second))
        self.worker.backfill()
        cursor_before = self.query("SELECT sample_cursor,sample_highwater FROM evse_history_state WHERE source=%s", (self.source,))[0]
        other = Database(self.config)
        other.connect()
        try:
            with self.assertRaises(ValueError):
                HistoryWorker(other).acquire()
        finally:
            other.close()
        self.worker_db.close()
        self.worker_db.connect()
        self.worker = HistoryWorker(self.worker_db)
        self.worker.acquire()
        self.assertEqual(self.query("SELECT sample_cursor,sample_highwater FROM evse_history_state WHERE source=%s", (self.source,))[0], cursor_before)
        self.drain()
        state = self.query("SELECT sample_cursor,sample_highwater FROM evse_history_state WHERE source=%s", (self.source,))[0]
        self.assertEqual(state[0], state[1])

    def test_backdated_event_invalidates_following_minutes_resumably(self):
        self.db.write(self.availability(-120))
        for minute_index in range(CHUNK + 2):
            self.db.write(self.sample(minute_index * 60))
            self.db.write(self.sample(minute_index * 60 + 2))
        self.drain()
        old = self.bucket(START + timedelta(minutes=CHUNK))
        self.assertEqual(old["coverage_seconds"], "2")
        self.db.write(self.availability(-30, "offline"))
        self.worker.invalidations()
        self.assertEqual(self.query("SELECT events_done FROM evse_history_state WHERE source=%s", (self.source,))[0][0], 0)
        self.worker_db.close()
        self.worker_db.connect()
        self.worker = HistoryWorker(self.worker_db)
        self.worker.acquire()
        self.drain()
        changed = self.bucket(START + timedelta(minutes=CHUNK))
        self.assertEqual(changed["coverage_seconds"], "0")
        self.assertTrue(changed["has_gap"])

    def test_late_out_of_order_samples_and_same_time_event_ambiguity(self):
        self.db.write(self.availability())
        self.db.write(self.sample(4, values={"active_power_w": 40}))
        self.drain()
        self.db.write(self.sample(0, values={"active_power_w": 10}))
        self.db.write(self.sample(0, values={"active_power_w": 20}))
        self.db.write(self.availability(kind="broker_connected"))
        self.drain()
        data = self.bucket()
        self.assertEqual(data["metrics"]["active_power_w"]["first"], "10")
        self.assertEqual(data["metrics"]["active_power_w"]["last"], "40")
        self.assertEqual(data["coverage_seconds"], "0")
        self.assertTrue(data["has_gap"])
        self.assertFalse(data["complete"])

    def test_missing_retained_availability_and_errors_stay_gaps(self):
        self.db.write(self.sample())
        self.db.write(self.sample(2, status="error", error="timeout", last_success_at=None))
        self.db.write(self.availability(retained=True))
        self.drain()
        data = self.bucket()
        self.assertFalse(data["complete"])
        self.assertTrue(data["has_gap"])
        self.assertEqual(data["metrics"]["charging"]["nulls"], 1)
        self.assertEqual(data["error_samples"], 1)

    def test_actual_error_endpoint_and_empty_neighbor_survive_parent_merge(self):
        self.db.write(self.availability())
        self.db.write(self.sample(0, values={"active_power_w": 100, "session_energy_wh": 9}))
        self.db.write(self.sample(62, status="error", error="timeout", last_success_at=None))
        self.drain()
        for data in (self.bucket(START + timedelta(minutes=1)), self.bucket(seconds=3600)):
            self.assertIsNone(data["metrics"]["active_power_w"]["last"])
            self.assertIsNone(data["metrics"]["session_energy_wh"]["last"])
        parent = self.bucket(seconds=3600)
        self.assertEqual(parent["metrics"]["active_power_w"]["first"], "100")
        self.assertEqual(parent["metrics"]["active_power_w"]["sum"], "100")
        self.assertEqual(parent["metrics"]["active_power_w"]["nulls"], 1)
        no_data = self.bucket(START + timedelta(minutes=2))
        self.assertEqual(no_data["samples"], 0)
        self.assertIsNone(no_data["first_at"])
        self.assertIsNone(no_data["last_at"])

    def test_known_offline_context_is_fully_computed(self):
        self.db.write(self.availability(availability="offline"))
        self.db.write(self.sample(0))
        self.db.write(self.sample(2))
        self.drain()
        data = self.bucket()
        self.assertTrue(data["complete"])
        self.assertTrue(data["has_gap"])
        self.assertEqual(data["coverage_seconds"], "0")
        self.assertEqual(data["samples"], 2)

    def test_real_event_overflow_omits_offline_without_claiming_coverage(self):
        self.db.write(self.sample(0, values={"active_power_w": 100}))
        self.db.write(self.sample(2, values={"active_power_w": 100}))
        # All 2048 online events precede the reads. The 2049th event is
        # offline and will be excluded from the bounded computation's prefix.
        events = [(uuid.uuid4().bytes, self.source,
                   START - timedelta(seconds=19) + timedelta(microseconds=i),
                   "availability", "online", False, "{}") for i in range(2048)]
        events.append((uuid.uuid4().bytes, self.source, START - timedelta(seconds=1),
                       "availability", "offline", False, "{}"))
        with self.db.connection.cursor() as c:
            c.executemany("INSERT INTO evse_ingest_events (event_id,source,received_at,kind,availability,retained,details_json) "
                          "VALUES (%s,%s,%s,%s,%s,%s,%s)", events)
        self.db.connection.commit()
        with self.worker_db.connection.cursor(pymysql.cursors.DictCursor) as c:
            truncated = self.worker.raw_minute(c, START)
        self.worker_db.connection.commit()
        self.assertFalse(truncated["complete"])
        self.assertTrue(truncated["has_gap"])
        self.assertEqual(truncated["coverage_seconds"], "0")
        self.assertEqual(truncated["samples"], 2)
        self.assertEqual(truncated["metrics"]["active_power_w"]["sum"], "200")
        with patch("storage.history.ROW_LIMIT", 4096):
            with self.worker_db.connection.cursor(pymysql.cursors.DictCursor) as c:
                full = self.worker.raw_minute(c, START)
        self.worker_db.connection.commit()
        self.assertTrue(full["complete"])
        self.assertEqual(full["coverage_seconds"], "0")
        self.assertEqual(full["metrics"], truncated["metrics"])

    def test_event_keyset_restart_and_late_uuid_below_highwater(self):
        self.db.write(self.sample())
        for index in range(CHUNK + 3):
            item = self.availability(-120, kind="broker_connected")
            item["id"] = (index + 1000).to_bytes(16, "big")
            self.db.write(item)
        self.worker.backfill()
        first_cursor = self.query("SELECT event_cursor_id,events_done FROM evse_history_state WHERE source=%s", (self.source,))[0]
        self.assertEqual(first_cursor[1], 0)
        self.worker_db.close()
        self.worker_db.connect()
        self.worker = HistoryWorker(self.worker_db)
        self.worker.acquire()
        self.drain()
        late = self.availability(-120, availability="offline")
        late["id"] = (1).to_bytes(16, "big")
        self.db.write(late)
        self.drain()
        self.assertTrue(self.bucket()["has_gap"])
        self.assertFalse(self.bucket()["complete"])
        self.assertGreater(self.query("SELECT event_cursor_id FROM evse_history_state WHERE source=%s", (self.source,))[0][0], late["id"])

    def test_dense_minute_is_bounded_explicitly_incomplete(self):
        self.db.write(self.sample())
        # Exercise the real SQL cap with a small injected bound, not thousands of
        # inserts: production uses 2048 raw rows/events per minute computation.
        for second in (1, 2, 3):
            self.db.write(self.sample(second))
        with patch("storage.history.ROW_LIMIT", 2):
            self.drain()
        data = self.bucket()
        self.assertFalse(data["complete"])
        self.assertTrue(data["has_gap"])
        self.assertEqual(data["coverage_seconds"], "0")
        self.assertIsNone(data["metrics"]["active_power_w"]["last"])


if __name__ == "__main__":
    unittest.main()
