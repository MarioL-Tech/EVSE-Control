"""Mocked combined runtime regressions; execute only in the Docker test stage."""
from datetime import datetime, timedelta
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import MagicMock, patch

import pymysql
from storage import __main__ as runtime
from storage import house_collector as house
from storage.house_http import HouseConfig


class HouseRuntimeTests(unittest.TestCase):
    def config(self):
        return house.configuration({'DB_HOST': 'database', 'DB_PASSWORD': 'fixture'})

    def http(self):
        return SimpleNamespace(enabled=True, source='evse/house', poll_seconds=0)

    def test_attempts_are_signed_zero_or_null_and_clock_rollback_is_explicit(self):
        observations = house.Observations()
        start = datetime(2026, 10, 29)
        stamps = [start, start + timedelta(seconds=2), start + timedelta(seconds=4), start]
        with patch.object(house, 'fetch', side_effect=[-12.5, 0, OSError('private'), 42]), \
                patch.object(house, 'utcnow', side_effect=stamps):
            items = [observations.attempt(self.http())['sample'] for _ in stamps]
        self.assertEqual([s['sequence'] for s in items], [1, 2, 3, 4])
        self.assertEqual(len({s['publisher_id'] for s in items}), 1)
        self.assertEqual(items[0]['power_w'], -12.5)
        self.assertEqual(items[1]['power_w'], 0)
        self.assertEqual([s['error_code'] for s in items[2:]], ['read_failed', 'clock_error'])
        self.assertTrue(all(s['power_w'] is None for s in items[2:]))

    def test_u32_wrap_starts_new_uuid_epoch(self):
        observations = house.Observations()
        previous = observations.publisher
        observations.sequence = 4294967295
        with patch.object(house, 'fetch', return_value=0):
            sample = observations.attempt(self.http())['sample']
        self.assertEqual(sample['sequence'], 1)
        self.assertNotEqual(str(uuid.UUID(bytes=sample['publisher_id'])), previous)

    def test_ambiguous_sample_commit_retains_one_identity_and_shutdown_boundary(self):
        stop = threading.Event()
        db, worker = MagicMock(), MagicMock()
        worker.pending_keys.return_value = {}
        attempts = []
        failed = False

        def write(item):
            nonlocal failed
            attempts.append(item)
            if item['kind'] == 'sample':
                if not failed:
                    failed = True
                    stop.set()  # Also exercise draining an ambiguous write during shutdown.
                    raise pymysql.OperationalError(2013, 'fixture')
            return True

        db.write.side_effect = write
        with patch.object(house, 'HouseDatabase', return_value=db), \
                patch.object(house, 'HouseWorker', return_value=worker), \
                patch.object(house, 'fetch', return_value=0) as fetch, \
                patch.object(house, 'health'):
            house.run(self.config(), stop, self.http())
        samples = [i for i in attempts if i['kind'] == 'sample']
        self.assertEqual(len(samples), 2)
        self.assertIs(samples[0], samples[1])
        fetch.assert_called_once()
        self.assertEqual(attempts[0]['kind'], 'collector_started')
        self.assertEqual(attempts[-1]['kind'], 'collector_stopping')
        online = [i for i in attempts if i.get('availability') == 'online']
        self.assertEqual(len(online), 1)
        self.assertFalse(online[0]['retained'])
        self.assertGreater(online[0]['received_at'], attempts[0]['received_at'])
        db.close.assert_called()

    def test_error_samples_allow_health_and_recovery_reopens_coverage(self):
        stop = threading.Event()
        db, worker = MagicMock(), MagicMock()
        worker.pending_keys.return_value = {}
        items = []

        def write(item):
            items.append(item)
            if item.get('availability') == 'online':
                stop.set()
            return True

        db.write.side_effect = write
        with patch.object(house, 'HouseDatabase', return_value=db), \
                patch.object(house, 'HouseWorker', return_value=worker), \
                patch.object(house, 'fetch', side_effect=[ValueError('fixture'), -4]), \
                patch.object(house, 'health') as health:
            house.run(self.config(), stop, self.http())
        self.assertEqual([i.get('availability') for i in items if i['kind'] == 'availability'],
                         ['offline', 'online'])
        self.assertIsNone(next(i['sample'] for i in items if i['kind'] == 'sample')['power_w'])
        self.assertTrue(any(call.args[:3] == (True, True, True) for call in health.call_args_list))

    def test_combined_house_progresses_while_wallbox_loop_is_blocked(self):
        stop, committed = threading.Event(), threading.Event()
        db, worker = MagicMock(), MagicMock()
        worker.pending_keys.return_value = {}
        caller = threading.get_ident()
        threads = set()

        def write(item):
            threads.add(threading.get_ident())
            if item['kind'] == 'sample':
                committed.set()
            return True

        def blocked_wallbox(config, shared_stop):
            self.assertIs(shared_stop, stop)
            self.assertTrue(committed.wait(2), 'HOUSE must progress during Wallbox DB reconnect')
            stop.set()

        db.write.side_effect = write
        with patch.object(house.HouseConfig, 'from_environment', return_value=self.http()), \
                patch.object(house, 'HouseDatabase', return_value=db), \
                patch.object(house, 'HouseWorker', return_value=worker), \
                patch.object(house, 'fetch', return_value=0), \
                patch.object(house, 'health'), \
                patch.object(runtime, 'run', side_effect=blocked_wallbox):
            runtime.run_combined(self.config(), stop)
        self.assertEqual(len(threads), 1)
        self.assertNotIn(caller, threads)
        self.assertFalse(any(t.name == 'house-history' for t in threading.enumerate()))

    def test_combined_wallbox_progresses_during_house_database_failure(self):
        stop, connecting = threading.Event(), threading.Event()
        db = MagicMock()

        def unavailable():
            connecting.set()
            raise pymysql.OperationalError(2003, 'fixture')

        def wallbox(config, shared_stop):
            self.assertTrue(connecting.wait(2))
            shared_stop.set()

        db.connect.side_effect = unavailable
        with patch.object(house.HouseConfig, 'from_environment', return_value=self.http()), \
                patch.object(house, 'HouseDatabase', return_value=db), \
                patch.object(house, 'health'), \
                patch.object(runtime, 'run', side_effect=wallbox):
            runtime.run_combined(self.config(), stop)
        self.assertTrue(stop.is_set())
        db.close.assert_called()

    def test_disabled_combined_runtime_creates_no_house_thread(self):
        with patch.object(house.HouseConfig, 'from_environment', return_value=HouseConfig()), \
                patch.object(runtime.threading, 'Thread') as thread, \
                patch.object(runtime, 'run') as wallbox:
            runtime.run_combined(self.config(), threading.Event())
        thread.assert_not_called()
        wallbox.assert_called_once()

    def test_health_aggregates_only_when_http_configured_without_reading_db_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'health.json'
            path.write_text('{"tick":10,"database_ready":true,"subscribed":true}')
            with patch.object(runtime, 'Path', return_value=path), \
                    patch.object(runtime.time, 'monotonic', return_value=10), \
                    patch.object(house.HouseConfig, 'from_environment', return_value=self.http()), \
                    patch.object(house, 'healthcheck', return_value=1) as check, \
                    patch.object(runtime.Config, 'from_environment') as secret:
                self.assertEqual(runtime.healthcheck(), 1)
                check.assert_called_once()
                secret.assert_not_called()


if __name__ == '__main__':
    unittest.main()
