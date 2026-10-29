"""Disposable MariaDB only, never production. STORAGE_INTEGRATION=1 opts in."""
from dataclasses import replace
from datetime import timedelta
from decimal import Decimal
import os
import unittest
from unittest.mock import patch
import uuid
import pymysql
from storage.collector import event
from storage.config import Config
from storage.database import Database
from storage.house_database import HouseDatabase, TABLES
from storage.house_protocol import decode
from storage.house_rollup import HouseWorker, dirty
from storage.protocol import decode as decode_wallbox
from test_house_unit import payload, START
from test_unit import sample_payload


@unittest.skipUnless(os.environ.get('STORAGE_INTEGRATION') == '1', 'isolated Docker services required')
class HouseIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        base = Config.from_environment()
        cls.root = pymysql.connect(host=base.db_host, port=base.db_port, user='root',
                                   password=os.environ['DB_ROOT_PASSWORD'], autocommit=True,
                                   connect_timeout=3, read_timeout=3, write_timeout=3)
        name = 'house_fixture_' + uuid.uuid4().hex[:12]
        with cls.root.cursor() as c:
            c.execute('CREATE DATABASE ' + name + ' CHARACTER SET utf8mb4')
        cls.config = replace(base, db_name=name, db_user='root', db_password=os.environ['DB_ROOT_PASSWORD'])
        cls.wallbox = Database(cls.config)
        cls.wallbox.connect()
        cls.wallbox.migrate()
        cls.wallbox.verify()  # Keep this schema-1 connection alive across HOUSE migration.
        house = HouseDatabase(cls.config)
        house.connect()
        house.migrate()
        house.migrate()
        house.close()
        cls.user = 'house_' + uuid.uuid4().hex[:12]
        with cls.root.cursor() as c:
            c.execute("CREATE USER '" + cls.user + "'@'%' IDENTIFIED BY 'isolated-house-only'")
            for table in TABLES:
                c.execute('GRANT SELECT,INSERT,UPDATE ON ' + name + '.' + table + " TO '" + cls.user + "'@'%'")

    @classmethod
    def tearDownClass(cls):
        cls.wallbox.close()
        cls.root.close()  # Disposable DB service owns cleanup. No data deletion.

    def setUp(self):
        self.source = 'house/test/' + uuid.uuid4().hex
        self.config = replace(self.config, prefix=self.source)
        self.db = HouseDatabase(self.config)
        self.db.connect()
        self.db.verify()
        self.worker_db = HouseDatabase(self.config)
        self.worker_db.connect()
        self.worker = HouseWorker(self.worker_db)
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

    def item(self, second=0, sequence=1, retained=False, **changes):
        return dict(kind='sample', sample=decode(payload(second, sequence, **changes)), source=self.source,
                    received_at=START + timedelta(seconds=second), retained=retained, ack=None)

    def drain(self):
        for _ in range(100):
            self.worker.turn()
            if self.query('SELECT COUNT(*) FROM evse_house_work WHERE source=%s AND pending=1', (self.source,))[0][0] == 0:
                return
        self.fail('HOUSE work failed to drain in bounded turns')

    def bucket(self, level='minute', at=START):
        with self.db.connection.cursor(pymysql.cursors.DictCursor) as c:
            c.execute('SELECT * FROM evse_house_buckets WHERE source=%s AND level=%s AND bucket_start=%s',
                      (self.source, level, at))
            row = c.fetchone()
        self.db.connection.commit()
        return row

    def generations(self):
        return self.query('SELECT level,bucket_start,generation,processed_generation,pending '
                          'FROM evse_house_work WHERE source=%s ORDER BY level,bucket_start', (self.source,))

    def test_live_wallbox_registry_and_writer_unaffected(self):
        self.assertFalse(self.wallbox.history_enabled)
        item = dict(kind='sample', sample=decode_wallbox(sample_payload()), source=self.source,
                    received_at=START, retained=False)
        self.assertTrue(self.wallbox.write(item))
        self.wallbox.verify()
        self.assertEqual(self.query('SELECT version FROM evse_schema_versions'), ((1,),))
        self.assertEqual(self.query('SELECT version FROM evse_house_schema_versions'), ((1,),))

    def test_signed_zero_null_dedupe_and_conflict(self):
        first = self.item(retained=True)
        self.assertTrue(self.db.write(first))
        before = self.generations()
        retry = dict(first, received_at=START + timedelta(seconds=1), retained=False)
        self.assertFalse(self.db.write(retry))
        self.assertEqual(before, self.generations())
        self.assertEqual(self.query('SELECT power_w,received_at,retained FROM evse_house_samples WHERE source=%s',
                                    (self.source,)), ((Decimal('-800.500000'), START, 1),))
        with self.assertRaises(ValueError):
            self.db.write(self.item(power_w=12))
        self.db.write(self.item(2, 2, power_w=0))
        self.db.write(self.item(4, 3, status='error', power_w=None, last_success_at=None, error='read_failed'))
        self.assertEqual(self.query('SELECT power_w FROM evse_house_samples WHERE source=%s ORDER BY id',
                                    (self.source,)), ((Decimal('-800.500000'),), (Decimal(0),), (None,)))

    def test_commit_retry_keeps_identity_and_dirty_generations(self):
        item = self.item()
        original = self.db.connection.commit
        def ambiguous():
            original()
            raise pymysql.OperationalError(2013, 'isolated uncertain commit')
        with patch.object(self.db.connection, 'commit', side_effect=ambiguous):
            with self.assertRaises(pymysql.OperationalError):
                self.db.write(item)
        before = self.generations()
        self.assertFalse(self.db.write(item))
        self.assertEqual(before, self.generations())
        self.assertEqual(self.query('SELECT COUNT(*) FROM evse_house_samples WHERE source=%s', (self.source,))[0][0], 1)

    def test_dirty_failure_rolls_raw_back_and_event_retry_is_idempotent(self):
        with patch('storage.house_rollup.dirty_observation', side_effect=pymysql.OperationalError(1205, 'fixture')):
            with self.assertRaises(pymysql.OperationalError):
                self.db.write(self.item())
        self.assertEqual(self.query('SELECT COUNT(*) FROM evse_house_samples WHERE source=%s', (self.source,))[0][0], 0)
        item = event(self.source, 'ingestion_gap', missed_samples='unknown')
        item['received_at'] = START
        self.assertTrue(self.db.write(item))
        before = self.generations()
        self.assertFalse(self.db.write(item))
        self.assertEqual(self.generations(), before)
        conflicting = dict(item, details='{"missed_samples":"different"}')
        with self.assertRaises(ValueError):
            self.db.write(conflicting)

    def test_minute_hour_day_and_null_last(self):
        for i, s in enumerate(range(-2, 65, 2)):
            self.db.write(self.item(s, i + 1, power_w=-2))
        self.drain()
        minute = self.bucket()
        self.assertEqual((minute['coverage_ms'], minute['samples'], minute['sum_w'], minute['complete'], minute['has_gap']),
                         (60000, 30, Decimal(-60), 1, 0))
        hour, day = self.bucket('hour'), self.bucket('day')
        self.assertEqual(hour['sum_w'], day['sum_w'])
        self.assertFalse(hour['complete'])  # Missing child minutes are not manufactured.
        self.db.write(self.item(66, 35, status='error', power_w=None, last_success_at=None, error='read_failed'))
        self.drain()
        self.assertIsNone(self.bucket('hour')['last_w'])
        self.assertIsNone(self.bucket('day')['last_w'])

    def test_real_gap_retained_clock_event_and_bounded_context(self):
        for i, s in enumerate(range(-2, 65, 2)):
            self.db.write(self.item(s, i + 1, retained=s == 20))
        item = event(self.source, 'broker_disconnected', missed_samples='unknown')
        item['received_at'] = START + timedelta(seconds=40)
        self.db.write(item)
        self.drain()
        self.assertTrue(self.bucket()['has_gap'])
        self.assertLess(self.bucket()['coverage_ms'], 60000)
        self.db.write(self.item(5, 100))  # Backdated clock/sequence interruption.
        self.drain()
        self.assertTrue(self.bucket()['has_gap'])

    def test_house_only_runtime_grants_no_global_registry_access(self):
        config = replace(self.config, db_user=self.user, db_password='isolated-house-only')
        db = HouseDatabase(config)
        db.connect()
        try:
            db.verify()
            self.assertTrue(db.write(self.item()))
            worker = HouseWorker(db)
            # Existing worker owns source lock; use job() directly to exercise DML grants.
            self.assertTrue(worker.job())
            with db.connection.cursor() as c:
                with self.assertRaises(pymysql.MySQLError):
                    c.execute('SELECT * FROM evse_schema_versions')
                with self.assertRaises(pymysql.MySQLError):
                    c.execute('CREATE TABLE forbidden_house_fixture (id INT)')
        finally:
            db.close()

    def test_pending_child_blocks_parent_and_generation_race(self):
        self.db.write(self.item())
        original = self.worker.raw_minute
        changed = []
        def race(c, start):
            result = original(c, start)
            if not changed:
                with self.db.connection.cursor() as intake:
                    dirty(intake, self.source, start, 'minute')
                self.db.connection.commit()
                changed.append(start)
            return result
        with patch.object(self.worker, 'raw_minute', side_effect=race):
            self.assertTrue(self.worker.job())
        self.assertEqual(self.query('SELECT COUNT(*) FROM evse_house_buckets WHERE source=%s', (self.source,))[0][0], 0)
        self.assertTrue(any(r[-1] for r in self.generations()))
        self.drain()
        self.assertIsNotNone(self.bucket('hour'))
        self.assertTrue(all(r[2] == r[3] and not r[4] for r in self.generations()))

    def test_continuous_intake_advances_minute_hour_and_day_without_drain_phase(self):
        seen = set()
        for index, second in enumerate(range(0, 20, 2), 1):
            self.db.write(self.item(second, index, power_w=index))
            availability = event(self.source, 'availability', measurement_time='unknown')
            availability.update(received_at=START + timedelta(seconds=second, microseconds=1),
                                availability='online')
            self.db.write(availability)
            self.worker.turn()  # One bounded service turn while intake continues.
            seen.update(row[0] for row in self.query(
                'SELECT DISTINCT level FROM evse_house_buckets WHERE source=%s', (self.source,)))
        self.assertEqual(seen, {'minute', 'hour', 'day'})
        progressed = self.query('SELECT level,MAX(processed_generation) FROM evse_house_work '
                                'WHERE source=%s GROUP BY level', (self.source,))
        self.assertEqual({level for level, generation in progressed if generation > 0},
                         {'minute', 'hour', 'day'})

    def test_partial_wrong_house_table_aborts_before_any_migration_ddl(self):
        name = 'house_wrong_' + uuid.uuid4().hex[:12]
        with self.root.cursor() as c:
            c.execute('CREATE DATABASE ' + name + ' CHARACTER SET utf8mb4')
            c.execute('CREATE TABLE ' + name + '.evse_house_samples (id INT PRIMARY KEY) ENGINE=InnoDB')
        config = replace(self.config, db_name=name, db_user='root',
                         db_password=os.environ['DB_ROOT_PASSWORD'])
        database = HouseDatabase(config)
        database.connect()
        try:
            with self.assertRaises(ValueError):
                database.migrate()
            with database.connection.cursor() as c:
                c.execute("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=%s "
                          "AND TABLE_NAME LIKE 'evse_house_%%' ORDER BY TABLE_NAME", (name,))
                self.assertEqual(c.fetchall(), (('evse_house_samples',),))
            database.connection.commit()
        finally:
            database.close()


if __name__ == '__main__':
    unittest.main()
