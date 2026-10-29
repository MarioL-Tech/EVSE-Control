"""Refresh CLI tests; run only in the Docker test stage."""
from datetime import datetime, timedelta
import threading
import unittest
from unittest.mock import MagicMock, call, patch

import pymysql

from storage.history_refresh import HistoryRefreshStopped, parse_range, refresh_history

FROM = "2026-10-28T00:00:00Z"
TO = "2026-10-29T00:00:00Z"
START = datetime(2026, 10, 28)


class HistoryRefreshRange(unittest.TestCase):
    def test_strict_utc_seconds_and_half_open_bounds(self):
        self.assertEqual(parse_range(FROM, TO), (START, START + timedelta(days=1)))
        self.assertEqual(parse_range("1970-01-01T00:00:00Z", "1970-01-01T00:00:01Z")[0], datetime(1970, 1, 1))
        for start, end in ((None, TO), (FROM, None), (FROM, FROM), (TO, FROM),
                           ("1969-12-31T23:59:59Z", FROM),
                           ("9998-01-01T00:00:00Z", "9999-01-01T00:00:00Z"),
                           ("2026-02-29T00:00:00Z", TO),
                           ("2026-10-28T24:00:00Z", TO),
                           ("2026-10-28T00:00:60Z", TO)):
            with self.subTest(start=start, end=end), self.assertRaises(ValueError):
                parse_range(start, end)
        for bad in (FROM + "\n", " " + FROM, FROM.lower(), FROM.replace("Z", "+00:00"),
                    FROM.replace("Z", ".000000Z"), "2026-1-28T00:00:00Z",
                    "２０２６-10-28T00:00:00Z", 123):
            for start, end in ((bad, TO), (FROM, bad)):
                with self.subTest(start=start, end=end), self.assertRaises(ValueError):
                    parse_range(start, end)

    def test_calendar_year_and_clamped_leap_anniversary(self):
        parse_range("2023-03-01T12:00:00Z", "2024-03-01T12:00:00Z")  # 366 days
        parse_range("2024-02-29T12:00:00Z", "2025-02-28T12:00:00Z")
        for start, end in (("2024-02-29T12:00:00Z", "2025-02-28T12:00:01Z"),
                           ("2024-02-29T12:00:00Z", "2025-03-01T00:00:00Z"),
                           (FROM, "2027-10-28T00:00:01Z")):
            with self.subTest(start=start), self.assertRaises(ValueError):
                parse_range(start, end)


class HistoryRefreshQueue(unittest.TestCase):
    def setUp(self):
        self.db = MagicMock()
        self.db.history_enabled = True
        self.db.config.prefix = "test/private-source"
        self.connection = self.db.connection
        self.cursor = self.connection.cursor.return_value.__enter__.return_value
        self.stop = threading.Event()

    def test_keyset_256_prepared_source_range_and_minute_only(self):
        first = [(START + timedelta(minutes=i),) for i in range(256)]
        second = [(START + timedelta(minutes=256),)]
        self.cursor.fetchall.side_effect = [first, second]
        with patch("storage.history_refresh.dirty") as mark:
            self.assertEqual(refresh_history(self.db, FROM, TO, self.stop), 257)
        self.db.verify.assert_called_once_with()
        self.connection.begin.assert_has_calls([call(), call()])
        self.assertEqual(self.connection.commit.call_count, 3)
        self.connection.rollback.assert_not_called()
        calls = self.cursor.execute.call_args_list
        self.assertEqual(calls[0].args, ("SET SESSION max_statement_time=1",))
        selects = [call.args for call in calls if call.args[0].startswith("SELECT")]
        self.assertEqual(len(selects), 2)
        for sql, args in selects:
            self.assertIn("WHERE source=%s AND resolution_seconds=60", sql)
            self.assertIn("bucket_start>=%s AND bucket_start<%s", sql)
            self.assertTrue(sql.endswith("ORDER BY bucket_start LIMIT 256"))
            self.assertNotIn("OFFSET", sql)
            self.assertNotIn(self.db.config.prefix, sql)
            self.assertEqual(args[:3], (self.db.config.prefix, START, START + timedelta(days=1)))
        self.assertNotIn("AND bucket_start>%s", selects[0][0])
        self.assertIn("AND bucket_start>%s", selects[1][0])
        self.assertEqual(selects[1][1][3], first[-1][0])
        self.assertEqual(mark.call_args_list, [call(self.cursor, self.db.config.prefix, at, 60)
                                             for (at,) in first + second])

    def test_empty_range_never_creates_work(self):
        self.cursor.fetchall.return_value = []
        with patch("storage.history_refresh.dirty") as mark:
            self.assertEqual(refresh_history(self.db, FROM, TO, self.stop), 0)
        mark.assert_not_called()
        self.connection.begin.assert_called_once_with()
        self.connection.rollback.assert_not_called()

    def test_exact_page_requires_eof_select(self):
        self.cursor.fetchall.side_effect = [[(START + timedelta(minutes=i),) for i in range(256)], []]
        with patch("storage.history_refresh.dirty"):
            self.assertEqual(refresh_history(self.db, FROM, TO, self.stop), 256)
        self.assertEqual(self.connection.begin.call_count, 2)

    def test_invalid_range_never_accesses_db(self):
        with self.assertRaises(ValueError):
            refresh_history(self.db, TO, FROM, self.stop)
        self.assertEqual(self.db.mock_calls, [])

    def test_schema_one_is_rejected_without_writes(self):
        self.db.history_enabled = False
        with patch("storage.history_refresh.dirty") as mark, self.assertRaises(ValueError):
            refresh_history(self.db, FROM, TO, self.stop)
        mark.assert_not_called()
        self.connection.begin.assert_not_called()
        self.connection.rollback.assert_called_once_with()

    def test_stop_before_verification(self):
        self.stop.set()
        with self.assertRaises(HistoryRefreshStopped) as interrupted:
            refresh_history(self.db, FROM, TO, self.stop)
        self.assertEqual(interrupted.exception.count, 0)
        self.db.verify.assert_not_called()
        self.connection.rollback.assert_called_once_with()

    def test_stop_rolls_back_current_page_but_reports_only_prior_commits(self):
        first = [(START + timedelta(minutes=i),) for i in range(256)]
        self.cursor.fetchall.side_effect = [first, [(START + timedelta(minutes=256),)]]
        def mark(cursor, source, at, seconds):
            if at == START + timedelta(minutes=256):
                self.stop.set()
        with patch("storage.history_refresh.dirty", side_effect=mark), self.assertRaises(HistoryRefreshStopped) as interrupted:
            refresh_history(self.db, FROM, TO, self.stop)
        self.assertEqual(interrupted.exception.count, 256)
        self.assertEqual(self.connection.commit.call_count, 2)  # setup and first page
        self.connection.rollback.assert_called_once_with()

    def test_stop_after_select_does_not_dirty_page(self):
        def fetch():
            self.stop.set()
            return [(START,)]
        self.cursor.fetchall.side_effect = fetch
        with patch("storage.history_refresh.dirty") as mark, self.assertRaises(HistoryRefreshStopped):
            refresh_history(self.db, FROM, TO, self.stop)
        mark.assert_not_called()
        self.connection.rollback.assert_called_once_with()

    def test_database_error_rolls_back_without_retrying_new_generation(self):
        self.cursor.fetchall.return_value = [(START,)]
        with patch("storage.history_refresh.dirty", side_effect=pymysql.OperationalError(1205, "fixture")):
            with self.assertRaises(pymysql.OperationalError):
                refresh_history(self.db, FROM, TO, self.stop)
        self.connection.rollback.assert_called_once_with()


class HistoryRefreshCli(unittest.TestCase):
    def test_missing_and_misplaced_range_flags_fail_before_configuration(self):
        from storage.__main__ import main
        for flags in (["--refresh-history"], ["--refresh-history", "--history-from", FROM],
                      ["--history-from", FROM, "--history-to", TO],
                      ["--house", "--refresh-history", "--history-from", FROM, "--history-to", TO]):
            with self.subTest(flags=flags), patch("sys.argv", ["storage", *flags]), \
                    patch("storage.__main__.Config.from_environment") as configuration, \
                    patch("sys.stderr"), self.assertRaises(SystemExit) as result:
                main()
            self.assertEqual(result.exception.code, 2)
            configuration.assert_not_called()

    def test_dispatch_count_and_stop_exit_without_starting_other_services(self):
        from storage.__main__ import main
        flags = ["storage", "--refresh-history", "--history-from", FROM, "--history-to", TO]
        for outcome, code, text in ((7, 0, "queued=7"), (HistoryRefreshStopped(3), 130, "interrupted; queued=3")):
            with self.subTest(code=code), patch("sys.argv", flags), \
                    patch("storage.__main__.os.set_blocking"), patch("storage.__main__.signal.signal") as signals, \
                    patch("storage.__main__.Config.from_environment"), patch("storage.__main__.Database") as database, \
                    patch("storage.__main__.diagnostic") as diagnostic, \
                    patch("storage.__main__.run") as run, patch("storage.__main__.run_history") as worker, \
                    patch("storage.history_refresh.refresh_history") as refresh:
                if isinstance(outcome, Exception):
                    refresh.side_effect = outcome
                else:
                    refresh.return_value = outcome
                self.assertEqual(main(), code)
                database.return_value.connect.assert_called_once_with()
                database.return_value.close.assert_called_once_with()
                diagnostic.assert_called_once_with("storage history refresh: " + text)
                self.assertEqual(refresh.call_args.args[1:3], (FROM, TO))
                stop = refresh.call_args.args[3]
                self.assertFalse(stop.is_set())
                self.assertEqual(signals.call_count, 2)
                for call in signals.call_args_list:
                    call.args[1](None, None)
                    self.assertTrue(stop.is_set())
                    stop.clear()
                run.assert_not_called()
                worker.assert_not_called()


if __name__ == "__main__":
    unittest.main()
