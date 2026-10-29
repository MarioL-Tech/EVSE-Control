"""HOUSE tests; run inside the storage Docker test stage only."""
from datetime import datetime, timedelta
from decimal import Decimal
import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
import uuid
import pymysql
from storage import __main__ as runtime
from storage import house_collector
from storage.collector import Inbox, Subscriber, event
from storage.house_collector import WorkWatch, configuration
from storage.house_database import HouseDatabase
from storage.house_protocol import decode
from storage.house_rollup import minute, combine, empty, floor, dirty_observation, HouseWorker

START = datetime(2026, 10, 29)
PUBLISHER = '00000000-0000-4000-8000-000000000001'


def payload(second=0, sequence=1, **changes):
    stamp = (START + timedelta(seconds=second)).isoformat(timespec='microseconds') + 'Z'
    data = dict(schema_version=1, device='house_grid', publisher_id=PUBLISHER,
                sequence=sequence, timestamp=stamp, status='ok', last_success_at=stamp,
                power_w=-800.5, error=None)
    data.update(changes)
    return json.dumps(data).encode()


def row(second, sequence, **changes):
    result = dict(id=sequence, **decode(payload(second, sequence)), retained=False,
                  received_at=START + timedelta(seconds=second))
    result.update(changes)
    return result


def continuous():
    return [row(s, i + 1) for i, s in enumerate(range(-2, 65, 2))]


class HouseProtocolTests(unittest.TestCase):
    def test_sign_zero_null_and_extremes(self):
        for value in (-9007199254740991, -0.125, 0, 9007199254740991):
            self.assertEqual(decode(payload(power_w=value))['power_w'], Decimal(str(value)))
        for error in ('startup', 'read_failed', 'stale', 'clock_error'):
            sample = decode(payload(status='error', power_w=None, last_success_at=None, error=error))
            self.assertIsNone(sample['power_w'])
        self.assertEqual(decode(payload(power_w=1.2345678))['power_w'], Decimal('1.234568'))

    def test_bad_wire(self):
        for changes in ({'extra': 1}, {'sequence': True}, {'sequence': 0}, {'sequence': 4294967296},
                        {'publisher_id': str(uuid.uuid1())}, {'publisher_id': PUBLISHER.upper().replace('a', 'A') + 'x'},
                        {'power_w': True}, {'power_w': None}, {'power_w': 9007199254740992},
                        {'schema_version': True}, {'status': 'offline'}, {'device': 'abb_terra_ac'},
                        {'last_success_at': None}, {'error': 'http://private/'},
                        {'timestamp': '1969-12-31T23:59:59Z'}, {'timestamp': '9999-01-01T00:00:00Z'},
                        {'timestamp': '2026-10-29T00:00:00+00:00'},
                        {'status': 'error', 'power_w': None, 'error': 'secret'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                decode(payload(**changes))
        for wire in (b'{}', b'[]', b'\xff', b' ' * 8193,
                     payload().replace(b'"schema_version": 1', b'"schema_version": 1, "schema_version": 1'),
                     payload().replace(b'-800.5', b'NaN'), payload().replace(b'-800.5', b'1e999999')):
            with self.assertRaises(ValueError):
                decode(wire)

    def test_timestamp_and_epoch_boundaries(self):
        for stamp in ('1970-01-01T00:00:00Z', '9998-12-31T23:59:59.123456Z'):
            decode(payload(timestamp=stamp, last_success_at=stamp))
        with self.assertRaises(ValueError):
            decode(payload(timestamp='2026-02-30T00:00:00Z'))
        self.assertEqual(floor(datetime(9998, 12, 31, 23, 59, 59, 999999), 'minute'),
                         datetime(9998, 12, 31, 23, 59))

    def test_digest_semantic_identity(self):
        self.assertEqual(decode(payload(power_w=0))['digest'], decode(payload(power_w=0.0))['digest'])
        self.assertEqual(decode(payload(power_w=0))['digest'], decode(payload(power_w=-0.0))['digest'])
        self.assertNotEqual(decode(payload())['digest'], decode(payload(sequence=2))['digest'])


class HouseSummaryTests(unittest.TestCase):
    def test_full_two_sided_minute(self):
        result = minute(START, continuous(), [])
        self.assertEqual((result['coverage_ms'], result['complete'], result['has_gap']), (60000, True, False))
        self.assertEqual((result['samples'], result['valid_count'], result['null_count']), (30, 30, 0))
        self.assertEqual(result['sum_w'], Decimal('-24015'))

    def test_sequence_epoch_retained_error_and_clock_barriers(self):
        variants = [dict(sequence=99), dict(publisher_id=uuid.uuid4().bytes), dict(retained=True),
                    dict(status='error', power_w=None), dict(received_at=START - timedelta(hours=1)),
                    dict(id=0)]
        for change in variants:
            rows = continuous()
            rows[10].update(change)
            with self.subTest(change=change):
                result = minute(START, rows, [])
                self.assertTrue(result['has_gap'])
                self.assertLess(result['coverage_ms'], 60000)
        rows = continuous()
        rows[10]['fetched_at'] -= timedelta(seconds=15)
        rows.sort(key=lambda r: (r['fetched_at'], r['id']))
        self.assertTrue(minute(START, rows, [])['has_gap'])

    def test_events_and_context_truncation(self):
        for kind, availability, retained in [('collector_started', None, False),
                ('broker_connected', None, False), ('broker_disconnected', None, False),
                ('ingestion_gap', None, False), ('availability', 'offline', False),
                ('availability', 'online', True)]:
            event = dict(kind=kind, availability=availability, retained=retained,
                         received_at=START + timedelta(seconds=20))
            self.assertTrue(minute(START, continuous(), [event])['has_gap'])
        self.assertFalse(minute(START, continuous(), [], bounded=False)['complete'])
        self.assertFalse(minute(START, continuous()[2:-3], [])['complete'])
        self.assertTrue(minute(START, [row(0, 1), row(11, 2), row(60, 3)], [])['has_gap'])

    def test_known_offline_baseline_persists_until_unambiguous_online(self):
        offline = dict(kind='availability', availability='offline', retained=False,
                       received_at=START - timedelta(seconds=30))
        self.assertEqual(minute(START, continuous(), [offline])['coverage_ms'], 0)
        online = dict(kind='availability', availability='online', retained=False,
                      received_at=START + timedelta(seconds=20, microseconds=1))
        recovered = minute(START, continuous(), [offline, online])
        self.assertGreater(recovered['coverage_ms'], 0)
        self.assertLess(recovered['coverage_ms'], 60000)
        tied = {**offline, 'received_at': online['received_at']}
        self.assertEqual(minute(START, continuous(), [offline, online, tied])['coverage_ms'], 0)

    def test_empty_and_null_last_are_not_zero_or_previous_value(self):
        result = minute(START, [], [])
        for key in ('sum_w', 'first_w', 'last_w', 'min_w', 'max_w', 'first_at', 'last_at'):
            self.assertIsNone(result[key])
        rows = continuous()
        rows[-4].update(status='error', power_w=None)  # 58 s, last inside interval.
        result = minute(START, rows, [])
        self.assertIsNone(result['last_w'])
        self.assertEqual(result['null_count'], 1)
        for r in rows:
            r.update(status='ok', power_w=Decimal(0))
        self.assertEqual(minute(START, rows, [])['last_w'], 0)

    def test_hour_day_only_children_keep_null_endpoints(self):
        children = []
        for m in range(60):
            start = START + timedelta(minutes=m)
            child = empty(start, 'minute')
            child.update(samples=1, valid_count=1, null_count=0, sum_w=Decimal('-2'),
                         min_w=Decimal('-2'), max_w=Decimal('-2'), first_w=Decimal('-2'), last_w=Decimal('-2'),
                         first_at=start, last_at=start, complete=True, has_gap=False, coverage_ms=60000)
            children.append(child)
        hour = combine(START, 'hour', children)
        self.assertEqual((hour['samples'], hour['sum_w'], hour['coverage_ms']), (60, -120, 3600000))
        self.assertTrue(hour['complete'])
        children[-1].update(last_w=None, valid_count=0, null_count=1, sum_w=None, min_w=None, max_w=None)
        self.assertIsNone(combine(START, 'hour', children)['last_w'])
        self.assertFalse(combine(START, 'hour', children[:-1])['complete'])
        hours = []
        for h in range(24):
            item = dict(hour, bucket_start=START + timedelta(hours=h), bucket_end=START + timedelta(hours=h + 1))
            hours.append(item)
        day = combine(START, 'day', hours)
        self.assertEqual((day['sum_w'], day['coverage_ms']), (-2880, 86400000))
        self.assertTrue(day['complete'])


class HouseIntakeTests(unittest.TestCase):
    def config(self):
        return configuration({'DB_HOST': 'database', 'DB_PASSWORD': 'private'})

    def test_default_and_optional_decoder_mid_reuse(self):
        cfg = self.config()
        self.assertEqual((cfg.prefix, cfg.client_id), ('evse/house', 'evse-house-storage'))
        isolated = configuration({'DB_HOST': 'database', 'DB_PASSWORD': 'private',
                                  'MQTT_TOPIC_PREFIX': 'evse/wallbox', 'MQTT_CLIENT_ID': 'evse-storage',
                                  'MQTT_USERNAME': 'shared-reader', 'MQTT_PASSWORD': 'shared-secret'})
        self.assertEqual((isolated.prefix, isolated.client_id), ('evse/house', 'evse-house-storage'))
        self.assertEqual((isolated.mqtt_user, isolated.mqtt_password), ('shared-reader', 'shared-secret'))
        named = configuration({'DB_HOST': 'database', 'DB_PASSWORD': 'private',
                               'HOUSE_MQTT_TOPIC_PREFIX': 'site/house',
                               'HOUSE_STORAGE_CLIENT_ID': 'site-house-storage'})
        self.assertEqual((named.prefix, named.client_id), ('site/house', 'site-house-storage'))
        inbox = Inbox(cfg.prefix, 8)
        sub = Subscriber(cfg, inbox, decoder=decode)
        client = MagicMock()
        sub.client, sub.connected = client, True
        message = SimpleNamespace(topic=cfg.prefix + '/state', payload=payload(), retain=False, qos=1, mid=8)
        sub.on_message(client, None, message)
        first = inbox.queue.get_nowait()
        sub.on_message(client, None, message)
        second = inbox.queue.get_nowait()
        client.ack.return_value = 0
        sub.ack(first['ack'])
        client.ack.assert_not_called()
        sub.ack(second['ack'])
        client.ack.assert_called_once_with(8, 1)
        sub.generation += 1
        sub.ack(second['ack'])
        client.ack.assert_called_once()

    def test_dirty_is_bounded_and_in_same_transaction(self):
        db = HouseDatabase(self.config())
        db.connection = MagicMock()
        item = dict(kind='sample', sample=decode(payload()), source='evse/house',
                    received_at=START, retained=False)
        with patch('storage.house_rollup.dirty_observation') as mark:
            def before_commit(*_):
                db.connection.commit.assert_not_called()
            mark.side_effect = before_commit
            self.assertTrue(db.write(item))
            mark.assert_called_once()
        db.connection.commit.assert_called_once()
        cursor = MagicMock()
        cursor.fetchone.return_value = None
        dirty_observation(cursor, 'evse/house', START)
        self.assertEqual(cursor.execute.call_count, 7)
        starts = {(call.args[1][1], call.args[1][2]) for call in cursor.execute.call_args_list
                  if call.args[0].startswith('INSERT')}
        self.assertNotIn(('minute', START + timedelta(minutes=1)), starts)
        cursor.reset_mock()
        dirty_observation(cursor, 'evse/house', START + timedelta(minutes=30, seconds=30))
        self.assertEqual(cursor.execute.call_count, 5)

    def test_late_context_dirties_existing_following_minute_and_its_parents(self):
        cursor = MagicMock()
        cursor.fetchone.return_value = (1,)
        dirty_observation(cursor, 'evse/house', START + timedelta(hours=23, minutes=59, seconds=58))
        starts = {(call.args[1][1], call.args[1][2]) for call in cursor.execute.call_args_list
                  if call.args[0].startswith('INSERT')}
        following = START + timedelta(days=1)
        for level in ('minute', 'hour', 'day'):
            self.assertIn((level, following), starts)
        self.assertEqual(sum(level == 'minute' for level, _ in starts), 3)
        self.assertIn('FOR UPDATE', cursor.execute.call_args_list[0].args[0])

    def test_failed_dirty_never_commits(self):
        db = HouseDatabase(self.config())
        db.connection = MagicMock()
        item = dict(kind='sample', sample=decode(payload()), source='evse/house', received_at=START, retained=False)
        with patch('storage.house_rollup.dirty_observation', side_effect=pymysql.OperationalError(1205, 'fixture')):
            with self.assertRaises(pymysql.OperationalError):
                db.write(item)
        db.connection.commit.assert_not_called()
        db.connection.rollback.assert_called_once()

    def test_work_watch_fails_stuck_level_but_resets_on_real_progress(self):
        watch = WorkWatch()
        self.assertTrue(watch.update({'minute': START, 'day': START}, now=0))
        self.assertTrue(watch.update({'minute': START, 'day': START}, progressed={'minute'}, now=29))
        self.assertFalse(watch.update({'minute': START, 'day': START}, now=30))
        self.assertTrue(watch.update({'minute': START, 'day': START}, progressed={'day'}, now=30))
        self.assertTrue(watch.update({'minute': START + timedelta(minutes=1), 'day': START}, now=59))
        self.assertTrue(watch.update({}, now=1000))

    def test_house_health_requires_fresh_database_mqtt_and_rollup(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(house_collector, 'HEALTH', Path(directory) / 'health.json'), \
                patch('storage.house_collector.time.monotonic', return_value=10):
            house_collector.health(True, True, True, written=1)
            self.assertEqual(house_collector.healthcheck(), 0)
            house_collector.health(True, True, False)
            self.assertEqual(house_collector.healthcheck(), 1)
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(house_collector, 'HEALTH', Path(directory) / 'health.json'), \
                patch('storage.house_collector.time.monotonic', side_effect=[10, 41]):
            house_collector.health(True, True, True)
            self.assertEqual(house_collector.healthcheck(), 1)

    def test_shutdown_full_inbox_keeps_gap_boundary_and_commit_identity(self):
        cfg = self.config()
        inbox = Inbox(cfg.prefix, 8)
        for index in range(8):
            self.assertTrue(inbox.put(event(cfg.prefix, 'availability', measurement_time=str(index))))
        self.assertFalse(inbox.put(event(cfg.prefix, 'availability', measurement_time='overflow')))
        stop = threading.Event()
        stop.set()
        subscriber = MagicMock()
        subscriber.client = None
        subscriber.subscribed = True
        subscriber.accepting = True
        database = MagicMock()
        attempts = []

        def write(item):
            attempts.append(item)
            if len(attempts) == 1:
                raise pymysql.OperationalError(2013, 'ambiguous fixture commit')
            return True

        database.write.side_effect = write
        worker = MagicMock()
        with patch('storage.house_collector.Inbox', return_value=inbox), \
                patch('storage.house_collector.Subscriber', return_value=subscriber), \
                patch('storage.house_collector.HouseDatabase', return_value=database), \
                patch('storage.house_collector.HouseWorker', return_value=worker), \
                patch('storage.house_collector.health'), \
                patch('storage.house_collector.time.sleep'):
            house_collector.run(cfg, stop)
        self.assertIs(attempts[0], attempts[1])
        kinds = [item['kind'] for item in attempts[1:]]
        self.assertEqual(kinds[0], 'collector_started')
        self.assertIn('ingestion_gap', kinds)
        self.assertEqual(kinds[-1], 'collector_stopping')
        self.assertEqual(kinds.count('availability'), 8)
        subscriber.ack.assert_called()

    def test_dispatch_before_wallbox_verify(self):
        with patch('sys.argv', ['storage', '--migrate-house']), patch.object(runtime.Database, 'verify') as wallbox:
            with patch('storage.house_collector.configuration', return_value=self.config()), \
                 patch('storage.house_database.HouseDatabase') as cls:
                self.assertEqual(runtime.main(), 0)
                cls.return_value.migrate.assert_called_once()
                wallbox.assert_not_called()

    def test_house_healthcheck_cli_needs_no_database_configuration(self):
        with patch('sys.argv', ['storage', '--house-healthcheck']), \
                patch('storage.house_collector.healthcheck', return_value=1) as check, \
                patch.object(runtime.Config, 'from_environment') as generic:
            self.assertEqual(runtime.main(), 1)
            check.assert_called_once_with()
            generic.assert_not_called()

    def test_generation_mismatch_does_not_publish(self):
        db = HouseDatabase(self.config())
        db.connection = MagicMock()
        c = db.connection.cursor.return_value.__enter__.return_value
        c.fetchone.side_effect = [dict(level='minute', bucket_start=START, generation=1), dict(generation=2)]
        worker = HouseWorker(db)
        with patch.object(worker, 'raw_minute', return_value=empty(START, 'minute')):
            self.assertTrue(worker.job())
        sql = [call.args[0] for call in c.execute.call_args_list]
        self.assertFalse(any('INSERT INTO evse_house_buckets' in text for text in sql))
        db.connection.rollback.assert_called_once()


if __name__ == '__main__':
    unittest.main()
