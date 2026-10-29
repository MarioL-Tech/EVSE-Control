"""Opt-in disposable MariaDB fixtures only; never run against production."""
from datetime import timedelta
import os
import unittest

import test_minute_integration as fixtures
from storage.history import migrate_history
from storage.minutes import migrate
from storage.retention import cleanup
from test_minute_unit import SOURCE, observation
from test_retention_unit import NOW, MICRO, policy


@unittest.skipUnless(os.environ.get('STORAGE_INTEGRATION') == '1', 'isolated Docker services required')
class RetentionIntegration(unittest.TestCase):
    # Reuse the existing per-test random disposable schema, not the shared DB.
    setUp = fixtures.MinuteIntegration.setUp
    tearDown = fixtures.MinuteIntegration.tearDown
    query = fixtures.MinuteIntegration.query

    def test_schema1_raw_exact_boundary_and_binary_source(self):
        cutoff = policy().cutoff('minute', NOW)
        other = SOURCE.upper()
        for index, at in enumerate((cutoff - MICRO, cutoff, cutoff + MICRO)):
            for source in (SOURCE, other):
                item = observation(index * 2)
                item['source'] = source
                item['sample']['measured_at'] = at
                self.db.write(item)
        self.assertFalse(self.db.history_enabled)
        counts = cleanup(self.db, 'wallbox', policy(), NOW)
        self.assertEqual(counts, {'evse_wallbox_samples': 2, 'evse_ingest_events': 0})
        self.assertEqual(self.query('SELECT measured_at FROM evse_wallbox_samples WHERE source=%s ORDER BY measured_at LIMIT 10',
                                    (SOURCE,)), ((cutoff + MICRO,),))
        self.assertEqual(len(self.query('SELECT id FROM evse_wallbox_samples WHERE source=%s LIMIT 10', (other,))), 3)

    def test_calendar_and_shared_capture_expire_only_whole_intervals(self):
        migrate_history(self.db)
        self.db.verify()
        migrate(self.db)
        p = policy()
        for level, seconds in (('minute', 60), ('hour', 3600), ('day', 86400)):
            cutoff = p.cutoff(level, NOW)
            for start in (cutoff - timedelta(seconds=seconds), cutoff):
                for source in (SOURCE, SOURCE.upper()):
                    self.query('INSERT INTO evse_history_buckets '
                               '(source,resolution_seconds,bucket_start,data_json,updated_at) VALUES (%s,%s,%s,%s,%s)',
                               (source, seconds, start, '{}', NOW))
                    self.query('INSERT INTO evse_history_work '
                               '(source,resolution_seconds,bucket_start,generation,done_generation,pending) VALUES (%s,%s,%s,1,0,1)',
                               (source, seconds, start))
        cutoff = p.cutoff('minute', NOW)
        for kind in ('wallbox', 'house'):
            for start in (cutoff - timedelta(minutes=1), cutoff):
                self.query('INSERT INTO evse_minute_records '
                           '(kind,source,bucket_start,data_json,digest) VALUES (%s,%s,%s,%s,%s)',
                           (kind, SOURCE, start, '{}', bytes(32)))
        counts = cleanup(self.db, 'wallbox', p, NOW)
        self.assertEqual(counts['evse_history_buckets'], 3)
        self.assertEqual(counts['evse_history_work'], 3)  # pending work intentionally expires
        self.assertEqual(counts['evse_minute_records'], 1)
        for seconds in (60, 3600, 86400):
            for table in ('evse_history_buckets', 'evse_history_work'):
                rows = self.query('SELECT bucket_start FROM ' + table +
                                  ' WHERE source=%s AND resolution_seconds=%s ORDER BY bucket_start LIMIT 10', (SOURCE, seconds))
                self.assertEqual(rows, ((p.cutoff(seconds, NOW),),))
                self.assertEqual(len(self.query('SELECT bucket_start FROM ' + table +
                                               ' WHERE source=%s AND resolution_seconds=%s LIMIT 10',
                                               (SOURCE.upper(), seconds))), 2)
        self.assertEqual(len(self.query('SELECT bucket_start FROM evse_minute_records '
                                        'WHERE kind=%s AND source=%s LIMIT 10', ('house', SOURCE))), 2)

    def test_house_raw_events_and_registry_independent_of_wallbox_schema2(self):
        cutoff = policy().cutoff('minute', NOW)
        for index, at in enumerate((cutoff - MICRO, cutoff, cutoff + MICRO)):
            for source in (SOURCE, SOURCE.upper()):
                self.query('INSERT INTO evse_house_samples '
                           '(source,publisher_id,sequence,fetched_at,received_at,status,power_w,retained,digest) '
                           'VALUES (%s,%s,%s,%s,%s,%s,%s,0,%s)',
                           (source, bytes(16), index, at, at, 'ok', -10, bytes(32)))
                self.query('INSERT INTO evse_house_events '
                           '(source,event_id,kind,received_at,retained,details) VALUES (%s,%s,%s,%s,0,%s)',
                           (source, index.to_bytes(16, 'big'), 'collector_started', at, '{}'))
        counts = cleanup(self.house, 'house', policy(), NOW)
        self.assertEqual(counts['evse_house_samples'], 2)
        self.assertEqual(counts['evse_house_events'], 2)
        for table, stamp in (('evse_house_samples', 'fetched_at'), ('evse_house_events', 'received_at')):
            self.assertEqual(self.query('SELECT ' + stamp + ' FROM ' + table + ' WHERE source=%s LIMIT 10', (SOURCE,)),
                             ((cutoff + MICRO,),))
            self.assertEqual(len(self.query('SELECT id FROM ' + table + ' WHERE source=%s LIMIT 10', (SOURCE.upper(),))), 3)


if __name__ == '__main__':
    unittest.main()
