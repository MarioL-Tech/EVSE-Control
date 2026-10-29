"""Independent disposable DB fixtures. These tests never connect by default."""
from dataclasses import replace
from datetime import timedelta
import os
import unittest
from unittest.mock import patch
import uuid

import pymysql
from storage.config import Config
from storage.database import Database
from storage.history import HistoryWorker, migrate_history
from storage.house_database import HouseDatabase
from storage.house_rollup import HouseWorker
from storage.minutes import Recorder, captured, migrate, verify, require_raw_source
from test_minute_unit import START, SOURCE, observation, online


@unittest.skipUnless(os.environ.get('STORAGE_INTEGRATION') == '1', 'isolated Docker services required')
class MinuteIntegration(unittest.TestCase):
    def setUp(self):
        base = Config.from_environment()
        self.root = pymysql.connect(host=base.db_host, port=base.db_port, user='root',
            password=os.environ['DB_ROOT_PASSWORD'], autocommit=True,
            connect_timeout=3, read_timeout=3, write_timeout=3)
        name = 'minute_fixture_' + uuid.uuid4().hex[:12]
        with self.root.cursor() as c:
            c.execute('CREATE DATABASE ' + name + ' CHARACTER SET utf8mb4')
        self.config = replace(base, db_name=name, db_user='root',
                              db_password=os.environ['DB_ROOT_PASSWORD'], prefix=SOURCE, recording_mode='raw')
        self.db = Database(self.config)
        self.db.connect()
        self.db.migrate()
        self.db.verify()
        self.house = HouseDatabase(self.config)
        self.house.connect()
        self.house.migrate()

    def tearDown(self):
        self.house.close()
        self.db.close()
        self.root.close()  # Disposable server owns cleanup; no DELETE/DROP here.

    def query(self, sql, args=(), db=None):
        db = db or self.db
        with db.connection.cursor() as c:
            c.execute(sql, args)
            rows = c.fetchall()
        db.connection.commit()
        return rows

    def recorder(self, kind='wallbox'):
        db = self.db if kind == 'wallbox' else self.house
        db.config = replace(self.config, recording_mode='minute')
        db._minute_present = True
        db.verify()
        recorder = Recorder(db, kind)
        with patch('storage.minutes.UTC', return_value=START + timedelta(seconds=1)):
            recorder.acquire()
        return recorder

    def feed(self, recorder):
        recorder.write(online())
        for second in range(0, 62, 2):
            recorder.write(observation(second, recorder.kind))
            recorder.write(online(second))
        recorder.accumulator.freeze(START + timedelta(seconds=70))
        recorder.flush()

    def test_missing_minute_schema_raw_ok_minute_and_housekeeping_fail_closed(self):
        self.assertFalse(verify(self.db))
        for db in (self.db, self.house):
            db.config = replace(self.config, recording_mode='minute')
            with self.assertRaises(ValueError):
                db.verify()
            worker = HistoryWorker(db) if db is self.db else HouseWorker(db)
            with self.assertRaises(ValueError):
                worker.acquire()

    def test_additive_idempotent_migration_never_changes_old_rows_or_registries(self):
        legacy = observation(-2)
        self.db.write(legacy)
        legacy_house = observation(-2, 'house')
        self.house.write(legacy_house)
        snapshots = {
            'wallbox': self.query('SELECT id,payload_json FROM evse_wallbox_samples WHERE source=%s LIMIT 2', (SOURCE,)),
            'house': self.query('SELECT publisher_id,sequence,digest FROM evse_house_samples WHERE source=%s LIMIT 2', (SOURCE,)),
            'schema': self.query('SELECT version,applied_at FROM evse_schema_versions ORDER BY version LIMIT 3'),
            'house_schema': self.query('SELECT version,checksum,applied_at FROM evse_house_schema_versions ORDER BY version LIMIT 3'),
        }
        migrate(self.db)
        first = self.query('SELECT version,checksum,applied_at FROM evse_minute_schema_versions LIMIT 2')
        migrate(self.db)
        self.assertEqual(first, self.query('SELECT version,checksum,applied_at FROM evse_minute_schema_versions LIMIT 2'))
        self.assertEqual(snapshots['wallbox'], self.query('SELECT id,payload_json FROM evse_wallbox_samples WHERE source=%s LIMIT 2', (SOURCE,)))
        self.assertEqual(snapshots['house'], self.query('SELECT publisher_id,sequence,digest FROM evse_house_samples WHERE source=%s LIMIT 2', (SOURCE,)))
        self.assertEqual(snapshots['schema'], self.query('SELECT version,applied_at FROM evse_schema_versions ORDER BY version LIMIT 3'))
        self.assertEqual(snapshots['house_schema'], self.query('SELECT version,checksum,applied_at FROM evse_house_schema_versions ORDER BY version LIMIT 3'))

    def test_wallbox_without_schema2_one_capture_zero_raw_and_exact_duplicate(self):
        migrate(self.db)
        recorder = self.recorder()
        recorder.write(online())
        for second in range(0, 62, 2):
            recorder.write(observation(second))
            recorder.write(online(second))
        frozen = recorder.accumulator.freeze(START + timedelta(seconds=70))
        recorder.flush()
        self.assertFalse(self.db.history_enabled)
        self.assertEqual(self.query('SELECT id FROM evse_wallbox_samples WHERE source=%s LIMIT 2', (SOURCE,)), ())
        rows = self.query('SELECT bucket_start,data_json,digest FROM evse_minute_records WHERE kind=%s AND source=%s ORDER BY bucket_start LIMIT 3', ('wallbox', SOURCE))
        self.assertEqual(rows, ((START, frozen[1], frozen[2]),))
        # Simulate successful COMMIT followed by a broken response.
        recorder.accumulator.open[START] = dict(keys=set(), gap=True, deadline=0)
        recorder.accumulator.frozen = frozen
        recorder.flush()
        recorder.accumulator.open[START] = dict(keys=set(), gap=True, deadline=0)
        recorder.accumulator.frozen = (START, frozen[1] + ' ', frozen[2])
        with self.assertRaises(ValueError):
            recorder.flush()
        self.assertEqual(rows, self.query('SELECT bucket_start,data_json,digest FROM evse_minute_records WHERE kind=%s AND source=%s ORDER BY bucket_start LIMIT 3', ('wallbox', SOURCE)))
        self.assertEqual(self.query('SELECT received_at FROM evse_ingest_events WHERE source=%s AND kind=%s LIMIT 3', (SOURCE, 'availability')), ((START - timedelta(seconds=20),),))

    def test_capture_dirty_workers_read_capture_even_with_raw_configuration(self):
        migrate(self.db)
        migrate_history(self.db)
        for kind in ('wallbox', 'house'):
            recorder = self.recorder(kind)
            self.feed(recorder)
            db = self.db if kind == 'wallbox' else self.house
            if kind == 'wallbox':
                for seconds, at in ((60, START), (3600, START), (86400, START.replace(hour=0))):
                    self.assertEqual(self.query('SELECT pending FROM evse_history_work WHERE source=%s AND resolution_seconds=%s AND bucket_start=%s', (SOURCE, seconds, at)), ((1,),))
            else:
                for level, at in (('minute', START), ('hour', START), ('day', START.replace(hour=0))):
                    self.assertEqual(self.query('SELECT pending FROM evse_house_work WHERE source=%s AND level=%s AND bucket_start=%s', (SOURCE, level, at)), ((1,),))
            db.config = replace(db.config, recording_mode='raw')
            worker = HistoryWorker(db) if kind == 'wallbox' else HouseWorker(db)
            with db.connection.cursor(pymysql.cursors.DictCursor) as c:
                data = worker.raw_minute(c, START)
                self.assertEqual(data['samples'], 30)
                self.assertEqual(captured(db, c, kind, SOURCE, START + timedelta(minutes=5))['samples'], 0)
                self.assertIsNone(captured(db, c, kind, SOURCE, START - timedelta(minutes=1)))
            db.connection.commit()
            if kind == 'house':
                self.assertEqual(self.query('SELECT id FROM evse_house_samples WHERE source=%s LIMIT 2', (SOURCE,)), ())

    def test_source_cutover_is_persistent_on_reconnect(self):
        migrate(self.db)
        recorder = self.recorder()
        recorder.write(observation(0))
        recorder.accumulator.freeze(START + timedelta(seconds=1), shutdown=True)
        recorder.flush()
        self.db.close()
        self.db.connect()
        restarted = self.recorder()
        self.assertEqual(restarted.accumulator.started_at, START)
        self.assertEqual(restarted.accumulator.closed, START)
        from storage.minutes import IntakeRejected
        with self.assertRaises(IntakeRejected):
            restarted.write(observation(30))
        with self.assertRaises(ValueError):
            require_raw_source(self.db, 'wallbox')
        require_raw_source(self.house, 'house')  # independent kind has no cutover

    def test_bad_registry_checksum_blocks_both_intake_and_housekeeping(self):
        migrate(self.db)
        with self.db.connection.cursor() as c:
            c.execute('UPDATE evse_minute_schema_versions SET checksum=%s WHERE version=1', (bytes(32),))
        self.db.connection.commit()
        self.db.config = replace(self.config, recording_mode='minute')
        with self.assertRaises(ValueError):
            Recorder(self.db, 'wallbox').acquire()
        # A raw-configured history worker must not bypass a registered but
        # incompatible minute capture schema either.
        self.db.config = replace(self.config, recording_mode='raw')
        with self.assertRaises(ValueError):
            HistoryWorker(self.db).acquire()


if __name__ == '__main__':
    unittest.main()
