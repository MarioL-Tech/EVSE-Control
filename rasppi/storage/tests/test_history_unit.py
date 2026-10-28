"""Pure tests; executed by the Docker test stage, never on the host."""
import copy
from datetime import datetime, timedelta
from decimal import Decimal
import json
import unittest
from unittest.mock import MagicMock, patch

import pymysql

from storage.database import Database
from storage.history import (FIELDS, SUM_FIELDS, combine, decimal_string, dirty_sample,
                             empty, floor, minute, notify, online_at, validate)
from test_unit import config, sample_payload
from storage.collector import event
from storage.protocol import decode

START = datetime(2026, 10, 25, 1)


def row(second=0, identifier=1, **changes):
    at = START + timedelta(seconds=second)
    result = {"id": identifier, "measured_at": at, "received_at": at,
              "status": "ok", "retained": False, **{f: Decimal(1) for f in FIELDS}}
    result.update(changes)
    return result


def online(second=-60, **changes):
    result = {"received_at": START + timedelta(seconds=second), "kind": "availability",
              "availability": "online", "retained": False}
    result.update(changes)
    return result


class HistoryStatistics(unittest.TestCase):
    def test_exact_shape_and_decimal_strings(self):
        data = minute(START, [row(s, s + 3, current_l1_a=Decimal("0.123")) for s in range(-2, 62, 2)], [online()])
        self.assertEqual(set(data["metrics"]), set(FIELDS))
        self.assertEqual(data["samples"], 30)
        self.assertEqual(data["coverage_seconds"], "60")
        self.assertTrue(data["complete"])
        self.assertFalse(data["has_gap"])
        self.assertEqual(data["metrics"]["current_l1_a"]["sum"], "3.69")
        for field in set(FIELDS) - SUM_FIELDS:
            self.assertIsNone(data["metrics"][field]["sum"])
        self.assertEqual(decimal_string(Decimal("-0.000")), "0")
        self.assertEqual(decimal_string(Decimal("1000.000")), "1000")
        self.assertEqual(json.loads(json.dumps(data)), data)

    def test_order_by_measurement_id_not_receipt(self):
        rows = [row(4, 3, active_power_w=3), row(0, 9, active_power_w=9), row(0, 2, active_power_w=2)]
        data = minute(START, rows, [online()])
        metric = data["metrics"]["active_power_w"]
        self.assertEqual((metric["first"], metric["last"], metric["sum"]), ("2", "3", "14"))
        self.assertTrue(data["has_gap"])
        self.assertEqual(data, minute(START, list(reversed(rows)), [online()]))

    def test_error_and_null_counts_not_fake_zero(self):
        data = minute(START, [row(0, charging=None), row(2, status="error")], [online()])
        self.assertEqual((data["valid_samples"], data["error_samples"]), (1, 1))
        self.assertEqual(data["metrics"]["charging"]["n"], 0)
        self.assertEqual(data["metrics"]["charging"]["nulls"], 2)
        self.assertIsNone(data["metrics"]["charging"]["last"])
        self.assertEqual(data["metrics"]["active_power_w"]["nulls"], 1)
        self.assertTrue(data["has_gap"])

    def test_flags_false_and_session_reset_no_mean_or_counter_sum(self):
        data = minute(START, [row(0, charging=False, session_energy_wh=100), row(2, charging=True, session_energy_wh=0)], [online()])
        for field in ("charging", "session_energy_wh"):
            self.assertTrue(data["metrics"][field]["mixed"])
            self.assertIsNone(data["metrics"][field]["sum"])
        self.assertEqual(data["metrics"]["session_energy_wh"]["last"], "0")
        self.assertEqual(data["metrics"]["charging"]["first"], "0")

    def test_actual_null_and_error_endpoints_preserve_statistics(self):
        for endpoint in (dict(current_l1_a=None), dict(status="error")):
            for first in (True, False):
                with self.subTest(endpoint=endpoint, first=first):
                    rows = ([row(0, 1, **endpoint), row(2, 2, current_l1_a=Decimal("0.123"))]
                            if first else [row(0, 1, current_l1_a=Decimal("0.123")), row(2, 2, **endpoint)])
                    data = minute(START, list(reversed(rows)), [online()])
                    m = data["metrics"]["current_l1_a"]
                    self.assertEqual((m["n"], m["nulls"], m["sum"], m["min"], m["max"]),
                                     (1, 1, "0.123", "0.123", "0.123"))
                    self.assertEqual((m["first"], m["last"]),
                                     (None, "0.123") if first else ("0.123", None))
                    self.assertFalse(m["mixed"])
                    self.assertTrue(data["has_gap"])
                    validate(data, 60)

    def test_merge_keeps_null_endpoints_from_nonempty_children(self):
        positive = minute(START, [row(0, current_l1_a=Decimal("0.123"))], [online()])
        for changes in (dict(status="error"), {f: None for f in FIELDS}):
            null_child = minute(START + timedelta(minutes=1), [row(60, **changes)], [online()])
            earlier_null = minute(START - timedelta(minutes=1), [row(-60, **changes)], [online(-120)])
            for children, expected in (([positive, null_child], ("0.123", None)),
                                       ([earlier_null, positive], (None, "0.123"))):
                with self.subTest(changes=changes, expected=expected):
                    merged = combine(children, 3600)
                    m = merged["metrics"]["current_l1_a"]
                    self.assertEqual((m["first"], m["last"]), expected)
                    self.assertEqual((m["n"], m["nulls"], m["sum"]), (1, 1, "0.123"))
                    self.assertEqual(combine([empty(), merged, empty()], 86400)["metrics"]["current_l1_a"], m)

    def test_empty_children_never_erase_endpoints_or_fabricate_dates(self):
        positive = minute(START, [row()], [online()])
        merged = combine([empty(), positive, empty()], 3600)
        self.assertEqual(merged["metrics"], positive["metrics"])
        self.assertEqual((merged["first_at"], merged["last_at"]),
                         (positive["first_at"], positive["last_at"]))
        for data in (minute(START, [], [online()]), combine([empty()], 3600),
                     combine([combine([empty()], 3600)], 86400)):
            self.assertEqual(data["samples"], 0)
            self.assertIsNone(data["first_at"])
            self.assertIsNone(data["last_at"])
            for m in data["metrics"].values():
                self.assertIsNone(m["first"])
                self.assertIsNone(m["last"])

    def test_validator_rejects_unjustified_null_endpoints_and_empty_dates(self):
        positive = minute(START, [row()], [online()])
        for key in ("min", "max", "first", "last"):
            data = copy.deepcopy(positive)
            data["metrics"]["active_power_w"][key] = None
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate(data, 60)
        for key in ("first_at", "last_at"):
            data = empty()
            data[key] = positive[key]
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate(data, 60)
        data = empty()
        data["metrics"]["active_power_w"]["last"] = "1"
        with self.assertRaises(ValueError):
            validate(data, 60)

    def test_missing_availability_and_tied_events_fail_conservatively(self):
        reads = [row(0), row(2, 2)]
        for events in ([], [online(retained=True)], [online(), online(kind="broker_connected")],
                       [online(), online(1, kind="ingestion_gap")]):
            with self.subTest(events=events):
                data = minute(START, reads, events)
                self.assertTrue(data["has_gap"])
                self.assertEqual(data["coverage_seconds"], "0")
        self.assertFalse(online_at([online(), online(availability="offline")], START))
        self.assertFalse(minute(START, reads, [online(retained=True)])["complete"])

    def test_context_complete_distinct_from_physical_gap(self):
        data = minute(START, [row(0), row(20, 2)], [online()])
        self.assertTrue(data["complete"])
        self.assertTrue(data["has_gap"])
        self.assertEqual(data["coverage_seconds"], "0")
        self.assertFalse(minute(START, [row()], [online()], False)["complete"])

    def test_known_offline_is_materialized_but_unknown_context_is_not(self):
        reads = [row(0), row(2, 2)]
        data = minute(START, reads, [online(availability="offline")])
        self.assertTrue(data["complete"])
        self.assertTrue(data["has_gap"])
        self.assertEqual(data["coverage_seconds"], "0")
        self.assertEqual(data["samples"], 2)
        self.assertTrue(minute(START, [], [online(availability="offline")])["complete"])
        for events in ([], [online(retained=True)], [online(availability="offline", retained=True)],
                       [online(), online(availability="offline")], [online(kind="broker_disconnected")]):
            with self.subTest(events=events):
                unknown = minute(START, reads, events)
                self.assertFalse(unknown["complete"])
                self.assertTrue(unknown["has_gap"])
                self.assertEqual(unknown["coverage_seconds"], "0")

    def test_incomplete_event_context_cannot_claim_coverage(self):
        reads = [row(0), row(2, 2)]
        self.assertEqual(minute(START, reads, [online()])["coverage_seconds"], "2")
        data = minute(START, reads, [online()], context_complete=False)
        self.assertFalse(data["complete"])
        self.assertTrue(data["has_gap"])
        self.assertEqual(data["coverage_seconds"], "0")
        self.assertEqual(data["metrics"]["active_power_w"]["sum"], "2")

    def test_retained_clock_rollback_and_receipt_ambiguity(self):
        for right in (row(2, 2, retained=True), row(2, 2, received_at=START),
                      row(2, 2, received_at=START - timedelta(seconds=1)),
                      row(2, 2, received_at=START + timedelta(hours=1))):
            data = minute(START, [row(), right], [online()])
            self.assertTrue(data["has_gap"])
            self.assertEqual(data["coverage_seconds"], "0")

    def test_merge_is_sample_weighted_and_counter_is_last(self):
        a = minute(START, [row(0, active_power_w=10)], [online()])
        b = minute(START, [row(0, active_power_w=100), row(2, 2, active_power_w=100)], [online()])
        merged = combine([a, b], 3600)
        self.assertEqual(merged["metrics"]["active_power_w"]["sum"], "210")
        self.assertEqual(merged["metrics"]["active_power_w"]["n"], 3)
        self.assertIsNone(merged["metrics"]["session_energy_wh"]["sum"])
        self.assertFalse(merged["complete"])
        self.assertTrue(merged["has_gap"])
        self.assertEqual(combine([merged], 86400)["samples"], 3)

    def test_bad_stats_cannot_propagate(self):
        original = minute(START, [row()], [online()])
        for field, key, value in (("active_power_w", "sum", "1e0"), ("charging", "sum", "1"),
                                  ("active_power_w", "max", "4294967296"),
                                  ("charging", "last", "2"), ("active_power_w", "n", True)):
            data = copy.deepcopy(original)
            data["metrics"][field][key] = value
            with self.assertRaises(ValueError):
                combine([data], 3600)
        for value in (Decimal("NaN"), Decimal("Infinity"), -1, 4294967296, 1.25):
            with self.assertRaises(ValueError):
                minute(START, [row(active_power_w=value)], [online()])

    def test_utc_bins_do_not_follow_dst(self):
        for at in (datetime(2026, 3, 29, 1, 59), datetime(2026, 10, 25, 1, 59)):
            self.assertEqual(floor(at, 3600).hour, 1)
            self.assertEqual(floor(at, 86400).hour, 0)
            self.assertEqual(floor(at + timedelta(hours=24), 86400) - floor(at, 86400), timedelta(days=1))


class HistoryNotifications(unittest.TestCase):
    def test_schema_one_stays_insert_only(self):
        db = Database(config())
        db.connection = MagicMock()
        with patch("storage.history.notify") as notification:
            db.write(event("source", "collector_started"))
            notification.assert_not_called()

    def test_notify_only_after_fresh_insert_before_commit(self):
        db = Database(config())
        db.connection = MagicMock()
        db.history_enabled = True
        item = {"kind": "sample", "source": "source", "sample": decode(sample_payload()),
                "received_at": START, "retained": False}
        order = []
        c = db.connection.cursor.return_value.__enter__.return_value
        c.execute.side_effect = lambda *args: order.append("insert")
        db.connection.commit.side_effect = lambda: order.append("commit")
        with patch("storage.history.notify", side_effect=lambda *_: order.append("notify")):
            db.write(item)
        self.assertEqual(order, ["insert", "notify", "commit"])
        c.execute.side_effect = [pymysql.IntegrityError(1062, "duplicate"), None]
        c.fetchone.return_value = (1,)
        with patch("storage.history.notify") as notification:
            self.assertFalse(db.write(item))
            notification.assert_not_called()

    def test_notification_failure_prevents_commit(self):
        db = Database(config())
        db.connection = MagicMock()
        db.history_enabled = True
        with patch("storage.history.notify", side_effect=pymysql.OperationalError(1205, "timeout")):
            with self.assertRaises(pymysql.OperationalError):
                db.write(event("source", "collector_started"))
        db.connection.commit.assert_not_called()

    def test_three_sample_boundaries_and_constant_cost_event(self):
        cursor = MagicMock()
        dirty_sample(cursor, "source", START)
        self.assertEqual(cursor.execute.call_count, 3)
        cursor.reset_mock()
        notify(cursor, {"kind": "availability", "source": "source", "received_at": START})
        self.assertEqual(cursor.execute.call_count, 2)
        for call in cursor.execute.call_args_list:
            self.assertNotIn("evse_wallbox_samples", call.args[0])
            self.assertNotIn("DELETE", call.args[0])


if __name__ == "__main__":
    unittest.main()
