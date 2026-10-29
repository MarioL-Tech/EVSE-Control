"""Pure policy and fake-connection coverage; run via Docker test discovery."""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import unittest

from storage.retention import Cleaner, Policy, cleanup, MAX_DELETIONS


NOW = datetime(2026, 10, 29, 12, 34, 56, 789123)
MICRO = timedelta(microseconds=1)


def policy(minute='1', hour='2', day='3'):
    return Policy(dict(STORAGE_RETENTION_MINUTE_DAYS=minute,
                       STORAGE_RETENTION_HOUR_DAYS=hour,
                       STORAGE_RETENTION_DAY_DAYS=day))


class Cursor:
    def __init__(self, connection):
        self.connection = connection
        self.rowcount = 0
        self.rows = ()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def execute(self, sql, args):
        c = self.connection
        c.calls.append((sql, args))
        if c.fail and c.fail in sql:
            raise RuntimeError('simulated SQL failure')
        if 'information_schema' in sql:
            self.rows = (('evse_minute_records',),) if c.present else ()
        elif sql.startswith('SELECT'):
            width = 2 if sql.startswith(('SELECT measured_at,id ', 'SELECT fetched_at,id ',
                                         'SELECT received_at,id ', 'SELECT received_at,event_id ')) else 1
            self.rows = tuple((args[-2], index) if width == 2 else (args[-2],)
                              for index in range(args[-1] if c.full else 0))
        else:
            self.rowcount = 1

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


class Connection:
    def __init__(self, present=True, full=True):
        self.calls, self.begins, self.commits, self.rollbacks = [], 0, 0, 0
        self.present, self.full, self.fail = present, full, None

    def cursor(self):
        return Cursor(self)

    def begin(self):
        self.begins += 1

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


def database(**changes):
    db = SimpleNamespace(config=SimpleNamespace(prefix='EVSE/Exact', db_name='isolated'),
                         connection=Connection(), history_enabled=True)
    for name, value in changes.items():
        setattr(db, name, value)
    return db


class PolicyTests(unittest.TestCase):
    def test_strict_env_and_hierarchy(self):
        self.assertEqual(Policy().minute_days, 0)
        self.assertEqual(policy('36500', '36500', '36500').day_days, 36500)
        for value in ('', '-1', '+1', ' 1', '1 ', '1\n', '1.0', '1e2', '１２', '١',
                      '36501', '9' * 1000, None, 1, True):
            with self.subTest(value=value), self.assertRaises(ValueError):
                policy(value)
        for days in (('0', '1', '2'), ('1', '0', '2'), ('3', '2', '3'), ('1', '3', '2')):
            with self.subTest(days=days), self.assertRaises(ValueError):
                policy(*days)
        self.assertIsNone(policy('1', '0', '0').cutoff('day', NOW))

    def test_exact_utc_cutoffs_and_late_intake(self):
        p = policy()
        self.assertEqual(p.cutoff('minute', NOW), datetime(2026, 10, 28, 12, 34))
        self.assertEqual(p.cutoff('hour', NOW), datetime(2026, 10, 27, 12))
        self.assertEqual(p.cutoff('day', NOW), datetime(2026, 10, 26))
        aware = NOW.replace(tzinfo=timezone.utc).astimezone(timezone(timedelta(hours=-5)))
        self.assertEqual(p.cutoff('minute', aware), p.cutoff('minute', NOW))
        boundary = p.cutoff('minute', NOW)
        self.assertFalse(p.accepts(boundary - MICRO, NOW))
        self.assertFalse(p.accepts(boundary, NOW))
        self.assertTrue(p.accepts(boundary + MICRO, NOW))
        self.assertTrue(Policy().accepts(datetime.min, NOW))
        midnight = datetime(2026, 1, 2)
        self.assertEqual(p.cutoff('minute', midnight - MICRO), datetime(2025, 12, 31, 23, 59))
        self.assertEqual(p.cutoff('minute', midnight), datetime(2026, 1, 1))

    def test_expire_end_not_start_and_freeze_any_expired_child(self):
        p = policy()
        for kind in ('wallbox', 'house'):
            for level, seconds in (('minute', 60), ('hour', 3600), ('day', 86400)):
                cutoff = p.cutoff(level, NOW)
                self.assertEqual(p.action(kind, level, cutoff - timedelta(seconds=seconds), NOW), 'expire')
                self.assertNotEqual(p.action(kind, seconds, cutoff, NOW), 'expire')
            self.assertEqual(p.action(kind, 'hour', datetime(2026, 10, 28, 12), NOW), 'freeze')
            self.assertEqual(p.action(kind, 'hour', datetime(2026, 10, 28, 13), NOW), 'recompute')
            self.assertEqual(p.action(kind, 'day', datetime(2026, 10, 28), NOW), 'freeze')
            self.assertEqual(p.action(kind, 'day', datetime(2026, 10, 29), NOW), 'recompute')
            self.assertEqual(Policy().action(kind, 'day', datetime(2020, 1, 1), NOW), 'recompute')
        with self.assertRaises(ValueError):
            p.action('other', 'minute', NOW)
        with self.assertRaises(ValueError):
            p.action('house', 'day', datetime(2026, 1, 1, 1))


class CleanerTests(unittest.TestCase):
    def test_disabled_no_connection_or_sql(self):
        db = database(connection=None)
        self.assertEqual(cleanup(db, 'wallbox', Policy(), NOW), {})

    def test_bound_fairness_binary_source_and_no_forbidden_sql(self):
        db = database()
        seen = set()
        for _ in range(3):
            db.connection.calls.clear()
            counts = cleanup(db, 'wallbox', policy(), NOW)
            self.assertEqual(sum(counts.values()), MAX_DELETIONS)
            for sql, args in db.connection.calls:
                self.assertNotIn('OFFSET', sql)
                self.assertNotIn('COUNT(', sql)
                for forbidden in ('TRUNCATE', 'DROP ', 'ALTER ', 'CREATE ', 'evse_history_state', 'PRICE', 'PROVIDER'):
                    self.assertNotIn(forbidden, sql)
                if 'information_schema' in sql:
                    continue
                self.assertEqual(args[0], b'EVSE/Exact')
                self.assertIn('source=%s', sql)
                if sql.startswith('SELECT'):
                    self.assertIn('FORCE INDEX', sql)
                    self.assertIn('ORDER BY', sql)
                    self.assertLessEqual(args[-1], 16)
                    seen.add((sql.split(' FROM ')[1].split()[0], args[1] if 'resolution_seconds=%s' in sql else None))
                else:
                    self.assertTrue(sql.endswith(' LIMIT 1'))
        for seconds in (60, 3600, 86400):
            for table in ('evse_history_buckets', 'evse_history_work'):
                self.assertIn((table, seconds), seen)
        self.assertEqual(db.connection.begins, 3)
        self.assertEqual(db.connection.commits, 3)

    def test_absent_optional_schema_and_wallbox_history_disabled(self):
        db = database(history_enabled=False, connection=Connection(present=False, full=False))
        cleanup(db, 'wallbox', policy(), NOW)
        cleanup(db, 'wallbox', policy(), NOW)
        calls = db.connection.calls
        self.assertEqual(sum('information_schema' in sql for sql, _ in calls), 1)
        self.assertFalse(any('FROM evse_minute_records' in sql or 'evse_history_' in sql for sql, _ in calls))
        db.connection = Connection(present=True, full=False)
        cleanup(db, 'wallbox', policy(), NOW)
        self.assertTrue(any('FROM evse_minute_records' in sql for sql, _ in db.connection.calls))

    def test_house_registry_independent_and_exact_bucket_frontiers(self):
        db = database(history_enabled=False, connection=Connection(full=False))
        cleanup(db, 'house', policy(), NOW)
        for sql, args in db.connection.calls:
            if 'information_schema' in sql:
                continue
            self.assertNotIn('wallbox', sql)
            if 'evse_house_buckets' in sql or 'evse_house_work' in sql:
                level = args[1]
                seconds = dict(minute=60, hour=3600, day=86400)[level]
                self.assertEqual(args[-2], policy().cutoff(level, NOW) - timedelta(seconds=seconds))
            if 'evse_minute_records' in sql:
                self.assertEqual(args[1], 'house')

    def test_rollback_and_retry_does_not_cache_failed_metadata(self):
        db = database()
        cleaner = Cleaner()
        db.connection.fail = 'DELETE FROM'
        with self.assertRaises(RuntimeError):
            cleaner.cleanup(db, 'house', policy(), NOW)
        self.assertEqual(db.connection.commits, 0)
        self.assertEqual(db.connection.rollbacks, 1)
        db.connection.fail = None
        cleaner.cleanup(db, 'house', policy(), NOW)
        self.assertEqual(sum('information_schema' in sql for sql, _ in db.connection.calls), 2)


if __name__ == '__main__':
    unittest.main()
