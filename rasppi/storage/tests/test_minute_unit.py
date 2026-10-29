"""Minute admission/publication tests; Docker discovery only, never host execution."""
import copy
from dataclasses import replace
from datetime import datetime, timedelta
from decimal import Decimal
import hashlib
import json
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

import pymysql
from storage.collector import Subscriber, Inbox
from storage.config import Config
from storage.history import combine
from storage.house_protocol import decode as house_decode
from storage.house_rollup import combine as house_combine
from storage.minutes import (Accumulator, IntakeRejected, Recorder, MAX_ROWS,
                             captured, decode, encode, verify)
from storage.protocol import decode as wallbox_decode
from test_unit import sample_payload, config

START = datetime(2026, 10, 25, 12)
SOURCE = 'minute/test'


def observation(second, kind='wallbox', retained=False, received=None, **values):
    at = START + timedelta(seconds=second)
    stamp = at.isoformat(timespec='microseconds') + 'Z'
    if kind == 'wallbox':
        sample = wallbox_decode(sample_payload(stamp, values=values))
    else:
        sample = house_decode(json.dumps(dict(schema_version=1, device='house_grid',
            publisher_id='12345678-1234-4234-8234-123456789012', sequence=second // 2 + 100,
            timestamp=stamp, last_success_at=stamp, status='ok', power_w=values.get('power_w', -10),
            error=None)).encode())
    return dict(kind='sample', sample=sample, source=SOURCE,
                received_at=received or at, retained=retained, ack=None)


def online(second=-20, **changes):
    return dict(kind='availability', availability='online', source=SOURCE,
                received_at=START + timedelta(seconds=second), retained=False,
                id=bytes(16), details='{}', **changes)


def accumulator(kind='wallbox'):
    return Accumulator(kind, SOURCE, START, at=START - timedelta(minutes=2), monotonic=lambda: 0)


def result(acc, at=START + timedelta(seconds=70), shutdown=False):
    start, payload, digest = acc.freeze(at, shutdown)
    assert digest == hashlib.sha256(payload.encode()).digest()
    return decode(acc.kind, payload, start)


class MinuteAdmission(unittest.TestCase):
    def test_thirty_two_second_observations_one_record_and_real_statistics(self):
        acc = accumulator()
        acc.admit(online())
        for second in range(0, 62, 2):
            acc.admit(observation(second, active_power_w=second,
                                  current_a=[second / 1000, 0, 0], charging=second < 30))
        data = result(acc)
        self.assertEqual(data['samples'], 30)
        self.assertEqual(data['coverage_seconds'], '60')
        self.assertFalse(data['has_gap'])
        self.assertEqual(data['metrics']['active_power_w']['sum'], '870')
        self.assertEqual(data['metrics']['current_l1_a']['sum'], '0.87')
        self.assertIsNone(data['metrics']['charging']['sum'])
        self.assertTrue(data['metrics']['charging']['mixed'])
        identity = acc.freeze(START + timedelta(seconds=100))
        self.assertIs(identity, acc.frozen)
        acc.published()
        self.assertNotIn(START, acc.open)
        self.assertEqual(len(acc.open), 1)  # next minute's right-context sample
        with self.assertRaises(IntakeRejected):
            acc.admit(observation(20))

    def test_weighted_parent_sums_not_mean_of_means(self):
        summaries = []
        for seconds, watts in ((range(0, 60, 2), 10), (range(0, 60, 6), 100)):
            acc = accumulator()
            acc.admit(online())
            for second in seconds:
                acc.admit(observation(second, active_power_w=watts))
            summaries.append(result(acc))
        parent = combine(summaries, 3600)
        metric = parent['metrics']['active_power_w']
        self.assertEqual(metric['n'], 40)
        self.assertEqual(Decimal(metric['sum']) / metric['n'], Decimal('32.5'))
        self.assertIsNone(parent['metrics']['session_energy_wh']['sum'])
        self.assertIsNone(parent['metrics']['current_limit_a']['sum'])

    def test_house_signed_decimal_stats_and_typed_roundtrip(self):
        acc = accumulator('house')
        acc.admit(online())
        for second in range(0, 62, 2):
            acc.admit(observation(second, 'house', power_w=-20 if second < 30 else 10))
        data = result(acc)
        self.assertEqual(data['samples'], 30)
        self.assertEqual(data['sum_w'], Decimal(-150))
        self.assertEqual(data['min_w'], Decimal(-20))
        self.assertEqual(data['coverage_ms'], 60000)
        self.assertFalse(data['has_gap'])
        self.assertIsInstance(data['bucket_start'], datetime)
        self.assertEqual(decode('house', encode(data), START), data)
        parent = house_combine(START, 'hour', [data])
        self.assertEqual(parent['sum_w'] / parent['valid_count'], Decimal(-5))

    def test_null_retained_offline_clock_and_short_gap_never_filled(self):
        for failure in ('null', 'retained', 'offline', 'clock', 'drop'):
            acc = accumulator()
            acc.admit(online())
            for second in range(0, 62, 2):
                if failure == 'drop' and 20 <= second <= 30:
                    continue
                item = observation(second, retained=failure == 'retained' and second == 20)
                if second == 20:
                    if failure == 'null':
                        item['sample'] = wallbox_decode(sample_payload(
                            (START + timedelta(seconds=20)).isoformat() + 'Z', status='error'))
                    elif failure == 'clock':
                        item['received_at'] = START + timedelta(seconds=17)
                    elif failure == 'offline':
                        event = online(19)
                        event['availability'] = 'offline'
                        acc.admit(event)
                acc.admit(item)
            with self.subTest(failure=failure):
                data = result(acc)
                self.assertTrue(data['has_gap'])
                self.assertLess(Decimal(data['coverage_seconds']), 60)

    def test_duplicate_hash_not_counted_and_retained_is_conservative(self):
        acc = accumulator()
        item = observation(0)
        self.assertTrue(acc.admit(item))
        duplicate = copy.deepcopy(item)
        duplicate['received_at'] += timedelta(seconds=1)
        self.assertFalse(acc.admit(duplicate))
        duplicate['retained'] = True
        self.assertTrue(acc.admit(duplicate))
        data = result(acc)
        self.assertEqual(data['samples'], 2)
        self.assertEqual(data['retained_samples'], 1)
        self.assertTrue(data['has_gap'])

    def test_house_null_clock_and_conflicting_sequence_are_conservative(self):
        for error in ('read_failed', 'clock_error'):
            acc = accumulator('house')
            acc.admit(online())
            for second in range(0, 62, 2):
                item = observation(second, 'house')
                if second == 20:
                    sample = item['sample']
                    sample.update(status='error', power_w=None, error_code=error)
                acc.admit(item)
            data = result(acc)
            self.assertEqual(data['null_count'], 1)
            self.assertTrue(data['has_gap'])
            self.assertLess(data['coverage_ms'], 60000)
        acc = accumulator('house')
        acc.admit(observation(0, 'house', power_w=10))
        conflicting = observation(0, 'house', power_w=20)
        conflicting['received_at'] += timedelta(seconds=1)
        with self.assertRaises(IntakeRejected):
            acc.admit(conflicting)
        self.assertEqual(len(acc.rows), 1)
        self.assertTrue(result(acc)['has_gap'])

    def test_lifecycle_context_is_bounded_even_without_samples(self):
        acc = accumulator()
        for index in range(1000):
            event = online(0)
            event['received_at'] += timedelta(microseconds=index)
            event['kind'] = 'broker_disconnected'
            acc.admit(event)
        self.assertLessEqual(len(acc.events), 257)
        self.assertFalse(acc.open)

    def test_bounded_open_minutes_observations_and_no_wait_after_deadline(self):
        acc = accumulator()
        for count in range(MAX_ROWS):
            item = observation(0, active_power_w=count)
            item['received_at'] += timedelta(microseconds=count)
            acc.admit(item)
        with self.assertRaises(IntakeRejected):
            acc.admit(observation(1))
        self.assertEqual(len(acc.rows), MAX_ROWS)
        acc.admit(observation(60))
        with self.assertRaises(IntakeRejected):
            acc.admit(observation(120))
        self.assertEqual(len(acc.open), 2)
        self.assertIsNone(acc.freeze(START + timedelta(seconds=69)))
        self.assertIsNotNone(acc.freeze(START + timedelta(seconds=70)))
        with self.assertRaises(IntakeRejected):
            acc.admit(observation(62))

    def test_shutdown_and_restart_never_fabricate_full_coverage(self):
        for shutdown in (False, True):
            acc = Accumulator('wallbox', SOURCE, START, at=START + timedelta(seconds=20), monotonic=lambda: 0)
            acc.admit(online())
            for second in range(20, 62, 2):
                acc.admit(observation(second))
            data = result(acc, shutdown=shutdown)
            self.assertTrue(data['has_gap'])
            self.assertFalse(data['complete'])
        acc = accumulator()
        acc.admit(observation(20))
        self.assertTrue(result(acc, START + timedelta(seconds=21), True)['has_gap'])

    def test_backward_wallclock_still_finalizes_using_monotonic_budget(self):
        clock = [0]
        acc = Accumulator('wallbox', SOURCE, START, at=START, monotonic=lambda: clock[0])
        acc.admit(observation(0))
        clock[0] = 71
        self.assertIsNotNone(acc.freeze(START - timedelta(days=1)))

    def test_config_default_raw_and_strict_minute(self):
        self.assertEqual(config().recording_mode, 'raw')
        self.assertEqual(config(STORAGE_RECORDING_MODE='minute').recording_mode, 'minute')
        for invalid in ('', 'MINUTE', 'snapshot', 'minute '):
            with self.assertRaises(ValueError):
                config(STORAGE_RECORDING_MODE=invalid)


class MinutePublication(unittest.TestCase):
    def setup_recorder(self):
        db = MagicMock()
        db.config = replace(config(), prefix=SOURCE)
        db.history_enabled = True
        c = db.connection.cursor.return_value.__enter__.return_value
        recorder = Recorder(db, 'wallbox')
        recorder.accumulator = accumulator()
        recorder.accumulator.admit(observation(0))
        recorder.accumulator.freeze(START + timedelta(seconds=70))
        return db, c, recorder

    def test_ambiguous_commit_retries_identical_frozen_item_then_exact_duplicate(self):
        db, c, recorder = self.setup_recorder()
        frozen = recorder.accumulator.frozen
        db.connection.commit.side_effect = pymysql.OperationalError(2013, 'isolated failure')
        with self.assertRaises(pymysql.OperationalError):
            recorder.flush()
        self.assertIs(recorder.accumulator.frozen, frozen)
        db.connection.commit.side_effect = None
        c.execute.side_effect = [pymysql.IntegrityError(1062, 'duplicate'), None]
        c.fetchone.return_value = (frozen[1], frozen[2])
        self.assertTrue(recorder.flush())
        self.assertIsNone(recorder.accumulator.frozen)
        calls = [call.args[1] for call in c.execute.call_args_list if call.args[0].startswith('INSERT INTO evse_minute_records')]
        self.assertEqual(calls[0], calls[-1])

    def test_conflict_is_not_overwritten_and_remains_frozen(self):
        db, c, recorder = self.setup_recorder()
        c.execute.side_effect = [pymysql.IntegrityError(1062, 'duplicate'), None]
        c.fetchone.return_value = ('different', bytes(32))
        frozen = recorder.accumulator.frozen
        with self.assertRaisesRegex(ValueError, 'Conflicting'):
            recorder.flush()
        self.assertIs(recorder.accumulator.frozen, frozen)
        self.assertFalse(any('UPDATE evse_minute_records' in call.args[0] for call in c.execute.call_args_list))

    def test_publication_and_dirty_parents_share_transaction(self):
        db, c, recorder = self.setup_recorder()
        recorder.flush()
        dirty = [call.args[1][1] for call in c.execute.call_args_list if call.args[0].startswith('INSERT INTO evse_history_work')]
        self.assertEqual(dirty, [60, 3600, 86400])
        db.connection.commit.assert_called_once()

    def test_ack_is_ram_admission_not_sql_and_pressure_withholds_ack(self):
        db, _, recorder = self.setup_recorder()
        recorder.accumulator = accumulator()
        inbox = Inbox(SOURCE, 8)
        subscriber = Subscriber(db.config, inbox)
        subscriber.client = MagicMock()
        subscriber.client.ack.return_value = 0
        subscriber.connected = True
        token = (0, 1, 1, 1)
        subscriber.pending_mids[1] = token
        item = observation(0)
        item['ack'] = token
        recorder.write(item)
        subscriber.ack(token)
        subscriber.client.ack.assert_called_once_with(1, 1)
        db.write.assert_not_called()
        db.connection.commit.assert_not_called()
        recorder.accumulator.freeze(START + timedelta(seconds=70))
        with self.assertRaises(IntakeRejected):
            recorder.write(observation(2))
        subscriber.client.ack.assert_called_once()

    def test_availability_refresh_suppression_preserves_changes_and_retained(self):
        db, _, recorder = self.setup_recorder()
        recorder.accumulator = accumulator()
        for second in range(30):
            recorder.write(online(second))
        self.assertEqual(db.write.call_count, 1)
        event = online(31)
        event['availability'] = 'offline'
        recorder.write(event)
        recorder.write(event)
        event = online(32)
        event['retained'] = True
        recorder.write(event)
        self.assertEqual(db.write.call_count, 3)

    def test_missing_registry_raw_probe_once_and_minute_failclosed(self):
        db = MagicMock()
        del db._minute_present
        db.connection.cursor.return_value.__enter__.return_value.fetchall.return_value = ()
        self.assertFalse(verify(db))
        self.assertFalse(verify(db))
        self.assertEqual(db.connection.cursor.call_count, 1)
        with self.assertRaises(ValueError):
            verify(db, True)
        db = MagicMock()
        del db._minute_present
        db.connection.cursor.return_value.__enter__.return_value.fetchall.return_value = (('evse_minute_records',),)
        self.assertFalse(verify(db))  # unregistered partial DDL is not enabled
        with self.assertRaises(ValueError):
            verify(db, True)

    def test_cutover_missing_capture_no_legacy_fallback_and_late_event_gap(self):
        db = SimpleNamespace(_minute_present=True)
        c = MagicMock()
        c.fetchone.side_effect = [{'started_at': START}, None]
        c.fetchall.return_value = ()
        data = captured(db, c, 'wallbox', SOURCE, START)
        self.assertEqual(data['samples'], 0)
        self.assertFalse(data['complete'])
        acc = accumulator()
        acc.admit(online())
        for second in range(0, 62, 2):
            acc.admit(observation(second))
        frozen = acc.freeze(START + timedelta(seconds=70))
        c.fetchone.side_effect = [{'started_at': START}, {'data_json': frozen[1], 'digest': frozen[2]}]
        c.fetchall.return_value = [dict(received_at=START + timedelta(seconds=10), kind='availability',
                                       availability='offline', retained=False)]
        data = captured(db, c, 'wallbox', SOURCE, START)
        self.assertTrue(data['has_gap'])
        self.assertEqual(data['coverage_seconds'], '0')
        c.fetchone.side_effect = [{'started_at': START}]
        self.assertIsNone(captured(db, c, 'wallbox', SOURCE, START - timedelta(minutes=1)))


if __name__ == '__main__':
    unittest.main()
