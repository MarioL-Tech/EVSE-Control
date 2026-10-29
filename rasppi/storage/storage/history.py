"""Optional schema-2 materialization. Raw data is never updated or deleted.

All arithmetic is Decimal; work is replacement-based, not an accumulator.
UUIDs are keyset traversal keys only, never event chronology evidence.
"""
from datetime import datetime, timedelta
from decimal import Decimal, localcontext
import hashlib
import json
from pathlib import Path
import re
import time

import pymysql

FIELDS = (
    "active_power_w", "session_energy_wh", "current_limit_a",
    "current_l1_a", "current_l2_a", "current_l3_a",
    "voltage_l1_v", "voltage_l2_v", "voltage_l3_v",
    "plugged_in", "charging", "below_commanded_current", "error_code",
    "charging_state", "charging_state_raw", "socket_lock_state",
)
SUM_FIELDS = frozenset(("active_power_w", "current_l1_a", "current_l2_a", "current_l3_a",
                        "voltage_l1_v", "voltage_l2_v", "voltage_l3_v"))
FLAGS = frozenset(("plugged_in", "charging", "below_commanded_current"))
RESOLUTIONS = (60, 3600, 86400)
ROW_LIMIT = 2048
CHUNK = 128
EPOCH = datetime(1000, 1, 1)
ZERO_ID = bytes(16)
MAX_COUNT = 2**53 - 1


def floor(at, seconds=60):
    if seconds not in RESOLUTIONS or not isinstance(at, datetime) or at.tzinfo is not None:
        raise ValueError("Invalid UTC bucket")
    if seconds == 86400:
        return at.replace(hour=0, minute=0, second=0, microsecond=0)
    return at.replace(minute=0 if seconds == 3600 else at.minute, second=0, microsecond=0)


def stamp(at):
    return at.isoformat(timespec="microseconds") + "Z" if at is not None else None


def shifted(at, seconds):
    try:
        return max(EPOCH, at + timedelta(seconds=seconds))
    except OverflowError:
        return datetime.max


def decimal_string(value):
    value = Decimal(value)
    if not value.is_finite() or abs(value) > Decimal("1e40") or value.as_tuple().exponent < -12:
        raise ValueError("Invalid statistic")
    text = format(value, "f")
    return (text.rstrip("0").rstrip(".") if "." in text else text) if value else "0"


def metric_value(field, value):
    if value is None:
        return None
    if isinstance(value, float):
        raise ValueError("Floating point is not a DB decimal")
    value = Decimal(int(value) if isinstance(value, bool) else value)
    maximum, places = Decimal(4294967295), 0
    if field in FLAGS:
        maximum = Decimal(1)
    elif field.startswith("current_"):
        maximum, places = Decimal("4294967.295"), 3
    elif field.startswith("voltage_"):
        maximum, places = Decimal("429496729.5"), 1
    if not value.is_finite() or value < 0 or value > maximum or value != value.quantize(Decimal(1).scaleb(-places)):
        raise ValueError("Invalid typed raw value")
    return value


def empty():
    return {"schema_version": 1, "samples": 0, "valid_samples": 0, "error_samples": 0,
            "retained_samples": 0, "first_at": None, "last_at": None, "has_gap": True,
            "complete": True, "coverage_seconds": "0",
            "metrics": {f: {"n": 0, "nulls": 0, "sum": "0" if f in SUM_FIELDS else None,
                              "min": None, "max": None, "first": None, "last": None, "mixed": False}
                        for f in FIELDS}}


def availability_at(events, at):
    """Return known online/offline, or None for missing/ambiguous context."""
    preceding = [e for e in events if e["received_at"] <= at]
    if not preceding:
        return None
    latest = max(e["received_at"] for e in preceding)
    group = [e for e in preceding if e["received_at"] == latest]
    # Never resolve equal-time events using their random UUIDs.
    if (len(group) != 1 or group[0]["kind"] != "availability"
            or group[0]["retained"] or group[0]["availability"] not in ("online", "offline")):
        return None
    return group[0]["availability"] == "online"


def online_at(events, at):
    return availability_at(events, at) is True


def minute(start, rows, events, context_complete=True):
    end = shifted(start, 60)
    ordered = sorted(rows, key=lambda r: (r["measured_at"], r["id"]))
    selected = [r for r in ordered if start <= r["measured_at"] < end]
    result = empty()
    result["complete"] = bool(context_complete)
    result["samples"] = len(selected)
    result["valid_samples"] = sum(r["status"] == "ok" for r in selected)
    result["error_samples"] = len(selected) - result["valid_samples"]
    result["retained_samples"] = sum(bool(r["retained"]) for r in selected)
    if selected:
        result["first_at"], result["last_at"] = stamp(selected[0]["measured_at"]), stamp(selected[-1]["measured_at"])
    with localcontext() as ctx:
        ctx.prec = 60
        for field in FIELDS:
            values = [metric_value(field, r[field]) if r["status"] == "ok" else None for r in selected]
            observed = [v for v in values if v is not None]
            m = result["metrics"][field]
            m.update(n=len(observed), nulls=len(values) - len(observed))
            if values:
                m.update(first=decimal_string(values[0]) if values[0] is not None else None,
                         last=decimal_string(values[-1]) if values[-1] is not None else None)
            if observed:
                m.update(min=decimal_string(min(observed)), max=decimal_string(max(observed)),
                         mixed=min(observed) != max(observed))
            if field in SUM_FIELDS:
                m["sum"] = decimal_string(sum(observed, Decimal(0)))
        def usable(row):
            return (row["status"] == "ok" and not row["retained"]
                    and abs(row["received_at"] - row["measured_at"]) <= timedelta(seconds=10))
        # Coverage describes reception of valid observations, not knowledge of
        # every independent field. An unknown charging state must not break a
        # measured voltage curve. Per-metric null counts still break that
        # metric's plot; errors/retained/events/time gaps remain global barriers.
        coverage = Decimal(0)
        ambiguous = False
        event_counts = {}
        for event in events:
            at = event["received_at"]
            event_counts[at] = event_counts.get(at, 0) + 1
        def barrier(event):
            # The reader refreshes `online` alongside each new measurement.
            # Such a refresh does not constitute a physical outage. Ties,
            # retained messages and lifecycle/offline events remain barriers.
            return (event_counts[event["received_at"]] != 1
                    or event["kind"] != "availability" or event["retained"]
                    or event.get("availability") != "online")
        for left, right in zip(ordered, ordered[1:]):
            a, b = left["measured_at"], right["measured_at"]
            # A left-adjoining edge covers none of this bucket. Keep tied
            # samples at/inside the bucket, however: their ordering is unknown.
            if (b <= start and a < start) or a >= end:
                continue
            delta = b - a
            ra, rb = left["received_at"], right["received_at"]
            edge_ok = (context_complete and timedelta(0) < delta <= timedelta(seconds=10) and ra < rb
                       and usable(left) and usable(right)
                       and online_at(events, ra - timedelta(microseconds=1))
                       and not any(ra <= e["received_at"] <= rb and barrier(e) for e in events))
            if not edge_ok:
                ambiguous = True
                continue
            overlap = min(end, b) - max(start, a)
            if overlap > timedelta(0):
                coverage += Decimal(overlap.days * 86400 + overlap.seconds) + Decimal(overlap.microseconds) / 1000000
        if availability_at(events, start - timedelta(seconds=10)) is None:
            result["complete"] = False
        result["coverage_seconds"] = decimal_string(coverage)
        result["has_gap"] = (not result["complete"] or ambiguous or coverage < 60
                             or any(not usable(r) for r in selected))
    validate(result, 60)
    return result


def validate(data, seconds):
    """Validate persisted child data before allowing it to influence a parent."""
    if not isinstance(data, dict) or set(data) != set(empty()) or type(data["schema_version"]) is not int or data["schema_version"] != 1:
        raise ValueError("Invalid history shape")
    for key in ("samples", "valid_samples", "error_samples", "retained_samples"):
        if type(data[key]) is not int or not 0 <= data[key] <= MAX_COUNT:
            raise ValueError("Invalid history count")
    if data["valid_samples"] + data["error_samples"] != data["samples"] or data["retained_samples"] > data["samples"]:
        raise ValueError("Invalid sample counts")
    if type(data["complete"]) is not bool or type(data["has_gap"]) is not bool:
        raise ValueError("Invalid history flags")
    def number(value):
        if (not isinstance(value, str) or len(value) > 80
                or not re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", value)
                or decimal_string(value) != value):
            raise ValueError("Noncanonical decimal")
        return Decimal(value)
    if not 0 <= number(data["coverage_seconds"]) <= seconds:
        raise ValueError("Invalid coverage")
    for key in ("first_at", "last_at"):
        value = data[key]
        if value is not None:
            if not isinstance(value, str):
                raise ValueError("Invalid history timestamp")
            parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ")
            if stamp(parsed) != value:
                raise ValueError("Invalid history timestamp")
    if ((data["samples"] == 0 and (data["first_at"] is not None or data["last_at"] is not None))
            or (data["samples"] > 0 and (data["first_at"] is None or data["last_at"] is None))):
        raise ValueError("Invalid sample bounds")
    if data["first_at"] is not None and data["first_at"] > data["last_at"]:
        raise ValueError("Reversed history bounds")
    if not isinstance(data["metrics"], dict) or set(data["metrics"]) != set(FIELDS):
        raise ValueError("Invalid metrics")
    for field, m in data["metrics"].items():
        if not isinstance(m, dict) or set(m) != set(empty()["metrics"][field]):
            raise ValueError("Invalid statistic shape")
        if any(type(m[k]) is not int or not 0 <= m[k] <= MAX_COUNT for k in ("n", "nulls")) or m["n"] + m["nulls"] != data["samples"]:
            raise ValueError("Invalid metric counts")
        if type(m["mixed"]) is not bool:
            raise ValueError("Invalid mixed flag")
        vals = []
        for key in ("min", "max", "first", "last"):
            v = m[key]
            if key in ("min", "max"):
                invalid_null = (v is None) != (m["n"] == 0)
            else:
                invalid_null = ((v is not None and m["n"] == 0)
                                or (v is None and m["n"] > 0 and m["nulls"] == 0))
            if invalid_null:
                raise ValueError("Invalid null statistic")
            if v is not None:
                vals.append(metric_value(field, number(v)))
        if vals and (vals[0] > vals[1] or not all(vals[0] <= v <= vals[1] for v in vals[2:]) or m["mixed"] != (vals[0] != vals[1])):
            raise ValueError("Invalid metric bounds")
        if not vals and m["mixed"]:
            raise ValueError("Invalid empty mixed flag")
        if field not in SUM_FIELDS:
            if m["sum"] is not None:
                raise ValueError("Counter/flag/code sum forbidden")
        else:
            total = number(m["sum"])
            if total < 0 or (not vals and total != 0) or (vals and not vals[0] * m["n"] <= total <= vals[1] * m["n"]):
                raise ValueError("Invalid metric sum")


def combine(children, seconds):
    child_seconds = 60 if seconds == 3600 else 3600
    if seconds not in (3600, 86400) or len(children) > seconds // child_seconds:
        raise ValueError("Invalid child count")
    result = empty()
    for child in children:
        validate(child, child_seconds)
    with localcontext() as ctx:
        ctx.prec = 60
        for key in ("samples", "valid_samples", "error_samples", "retained_samples"):
            result[key] = sum(c[key] for c in children)
        for key in ("first_at", "last_at"):
            values = [c[key] for c in children if c[key] is not None]
            result[key] = (min(values) if key == "first_at" else max(values)) if values else None
        result["coverage_seconds"] = decimal_string(sum((Decimal(c["coverage_seconds"]) for c in children), Decimal(0)))
        result["complete"] = len(children) == seconds // child_seconds and all(c["complete"] for c in children)
        result["has_gap"] = not result["complete"] or any(c["has_gap"] for c in children)
        for field in FIELDS:
            m = result["metrics"][field]
            parts = [c["metrics"][field] for c in children]
            m["n"], m["nulls"] = sum(p["n"] for p in parts), sum(p["nulls"] for p in parts)
            present = [p for p in parts if p["n"]]
            endpoints = [c["metrics"][field] for c in children if c["samples"] > 0]
            if endpoints:
                m.update(first=endpoints[0]["first"], last=endpoints[-1]["last"])
            if present:
                m.update(min=decimal_string(min(Decimal(p["min"]) for p in present)),
                         max=decimal_string(max(Decimal(p["max"]) for p in present)))
                m["mixed"] = m["min"] != m["max"]
            if field in SUM_FIELDS:
                m["sum"] = decimal_string(sum((Decimal(p["sum"]) for p in parts), Decimal(0)))
    validate(result, seconds)
    return result


def ensure_state(cursor, source):
    cursor.execute("INSERT INTO evse_history_state (source,algorithm_version,sample_cursor,sample_highwater,"
                   "samples_done,events_done,updated_at,initialized,event_cursor_at,event_cursor_id,"
                   "event_highwater_at,event_highwater_id) VALUES (%s,1,0,0,0,0,UTC_TIMESTAMP(6),0,%s,%s,%s,%s) "
                   "ON DUPLICATE KEY UPDATE source=VALUES(source)", (source, EPOCH, ZERO_ID, EPOCH, ZERO_ID))


def dirty(cursor, source, at, resolution=60):
    cursor.execute("INSERT INTO evse_history_work (source,resolution_seconds,bucket_start,generation,done_generation,pending) "
                   "VALUES (%s,%s,%s,1,0,1) ON DUPLICATE KEY UPDATE generation=generation+1,pending=1",
                   (source, resolution, floor(at, resolution)))


def dirty_sample(cursor, source, at):
    for offset in (-60, 0, 60):
        try:
            target = at + timedelta(seconds=offset)
            if target >= EPOCH:
                dirty(cursor, source, target)
        except OverflowError:
            pass


def invalidate(cursor, source, at):
    ensure_state(cursor, source)
    # Reset on backdated events behind the cursor, but let concurrent later
    # notifications preserve forward progress through an older invalidation.
    at = floor(shifted(at, -60))
    cursor.execute("UPDATE evse_history_state SET invalidate_from=IF(invalidate_from IS NULL,%s,LEAST(invalidate_from,%s)),"
                   "invalidate_cursor=IF(invalidate_cursor IS NOT NULL AND %s>invalidate_cursor,invalidate_cursor,NULL),"
                   "events_done=0,updated_at=UTC_TIMESTAMP(6) WHERE source=%s", (at, at, at, source))


def notify(cursor, item):
    if item["kind"] == "sample":
        dirty_sample(cursor, item["source"], item["sample"]["measured_at"])
    else:
        # O(1) notification. The collector never scans historical ranges.
        invalidate(cursor, item["source"], item["received_at"])


def history_types():
    key = {"source": "varbinary(240)", "resolution_seconds": "int unsigned", "bucket_start": "datetime(6)"}
    identity = {("source", "resolution_seconds", "bucket_start")}
    return {
        "evse_history_buckets": ({**key, "data_json": "longtext", "updated_at": "datetime(6)"}, set(), identity),
        "evse_history_work": ({**key, "generation": "bigint unsigned", "done_generation": "bigint unsigned", "pending": "tinyint unsigned"}, set(), identity),
        "evse_history_state": ({"source": "varbinary(240)", "algorithm_version": "int unsigned", "sample_cursor": "bigint unsigned",
                                "sample_highwater": "bigint unsigned", "samples_done": "tinyint unsigned", "events_done": "tinyint unsigned",
                                "updated_at": "datetime(6)", "initialized": "tinyint unsigned", "event_cursor_at": "datetime(6)",
                                "event_cursor_id": "binary(16)", "event_highwater_at": "datetime(6)", "event_highwater_id": "binary(16)",
                                "invalidate_from": "datetime(6)", "invalidate_cursor": "datetime(6)"},
                               {"invalidate_from", "invalidate_cursor"}, {("source",)}),
    }


def verify_history_shape(db):
    # Use the same strict engine, types, nullability and unique-key checks as v1,
    # without modifying the shared v1 registry (default migration stays v1).
    additions = history_types()
    db.verify_shape(tables=additions)
    with db.connection.cursor() as c:
        c.execute("SELECT COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=%s "
                  "AND TABLE_NAME='evse_history_buckets' AND COLUMN_NAME='data_json'", (db.config.db_name,))
        if c.fetchone() != ("utf8mb4_bin",):
            raise ValueError("Incompatible history JSON collation")
        c.execute("SELECT COLUMN_NAME,SUB_PART FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=%s "
                  "AND TABLE_NAME='evse_history_work' AND INDEX_NAME='pending_work' ORDER BY SEQ_IN_INDEX", (db.config.db_name,))
        if c.fetchall() != tuple((x, None) for x in ("source", "pending", "resolution_seconds", "bucket_start")):
            raise ValueError("Missing pending work index")


def migrate_history(db):
    db.verify()  # Never create or bless raw tables here.
    lock = "evse-schema-" + hashlib.sha256(db.config.db_name.encode()).hexdigest()[:40]
    with db.connection.cursor() as c:
        c.execute("SELECT GET_LOCK(%s,10)", (lock,))
        if c.fetchone()[0] != 1:
            raise ValueError("Migration is already running")
        try:
            sql = (Path(__file__).resolve().parent.parent / "migrations/002_newhistory.sql").read_text()
            for statement in sql.split(";"):
                if statement.strip():
                    c.execute(statement)
            verify_history_shape(db)
            c.execute("INSERT INTO evse_schema_versions (version,applied_at) VALUES (2,UTC_TIMESTAMP(6)) "
                      "ON DUPLICATE KEY UPDATE version=VALUES(version)")
            db.connection.commit()
        finally:
            c.execute("SELECT RELEASE_LOCK(%s)", (lock,))
    db.verify()


class HistoryWorker:
    """One source, bounded keyset turns, separate connection from raw intake."""
    def __init__(self, db):
        self.db = db
        self.source = db.config.prefix
        self.lock = "evse-history-" + hashlib.sha256(
            db.config.db_name.encode() + b"\0" + self.source.encode()).hexdigest()[:48]

    def acquire(self):
        self.db.verify()
        if not self.db.history_enabled:
            raise ValueError("History migration must be explicit")
        with self.db.connection.cursor() as c:
            # Cooperatively bounded jobs plus a server-side per-SELECT budget.
            c.execute("SET SESSION max_statement_time=1")
            c.execute("SELECT GET_LOCK(%s,0)", (self.lock,))
            if c.fetchone()[0] != 1:
                raise ValueError("History worker already active for source")
        self.db.connection.commit()

    def backfill(self):
        connection = self.db.connection
        deadline = time.monotonic() + 0.5
        with connection.cursor(pymysql.cursors.DictCursor) as c:
            ensure_state(c, self.source)
            c.execute("SELECT * FROM evse_history_state WHERE source=%s FOR UPDATE", (self.source,))
            state = c.fetchone()
            if state["algorithm_version"] != 1:
                raise ValueError("Unsupported materialization algorithm")
            if not state["initialized"]:
                c.execute("SELECT COALESCE(MAX(id),0) AS hi FROM evse_wallbox_samples")
                high = c.fetchone()["hi"]
                c.execute("SELECT received_at,event_id FROM evse_ingest_events WHERE source=%s "
                          "ORDER BY received_at DESC,event_id DESC LIMIT 1", (self.source,))
                row = c.fetchone()
                event_at, event_id = (row["received_at"], row["event_id"]) if row else (EPOCH, ZERO_ID)
                c.execute("UPDATE evse_history_state SET initialized=1,sample_highwater=%s,"
                          "event_highwater_at=%s,event_highwater_id=%s WHERE source=%s",
                          (high, event_at, event_id, self.source))
                state.update(sample_highwater=high, event_highwater_at=event_at, event_highwater_id=event_id)
            if not state["samples_done"]:
                # PK interval (not OFFSET or an unbounded source-filtered PK scan).
                upper = min(state["sample_cursor"] + CHUNK, state["sample_highwater"])
                c.execute("SELECT id,source,measured_at FROM evse_wallbox_samples WHERE id>%s AND id<=%s ORDER BY id LIMIT %s",
                          (state["sample_cursor"], upper, CHUNK))
                rows = c.fetchall()
                scanned = upper
                for index, row in enumerate(rows):
                    if row["source"] == self.source.encode():
                        dirty_sample(c, self.source, row["measured_at"])
                    if index + 1 < len(rows) and time.monotonic() >= deadline:
                        scanned = row["id"]
                        break
                c.execute("UPDATE evse_history_state SET sample_cursor=%s,samples_done=%s,updated_at=UTC_TIMESTAMP(6) WHERE source=%s",
                          (scanned, int(scanned >= state["sample_highwater"]), self.source))
            if not state["events_done"]:
                # Tuple order is traversal only. Recompute observes ALL events at
                # an equal timestamp and never picks a winning UUID.
                c.execute("SELECT received_at,event_id FROM evse_ingest_events WHERE source=%s "
                          "AND (received_at>%s OR (received_at=%s AND event_id>%s)) "
                          "AND (received_at<%s OR (received_at=%s AND event_id<=%s)) "
                          "ORDER BY received_at,event_id LIMIT %s",
                          (self.source, state["event_cursor_at"], state["event_cursor_at"], state["event_cursor_id"],
                           state["event_highwater_at"], state["event_highwater_at"], state["event_highwater_id"], CHUNK))
                rows = c.fetchall()
                if rows:
                    # One earliest boundary invalidates all following existing
                    # minute jobs in resumable chunks, including backdated gaps.
                    invalidate(c, self.source, rows[0]["received_at"])
                    at, identifier = rows[-1]["received_at"], rows[-1]["event_id"]
                    c.execute("UPDATE evse_history_state SET event_cursor_at=%s,event_cursor_id=%s WHERE source=%s",
                              (at, identifier, self.source))
                if len(rows) < CHUNK:
                    c.execute("UPDATE evse_history_state SET events_done=IF(invalidate_from IS NULL,1,0) WHERE source=%s", (self.source,))
        connection.commit()

    def invalidations(self):
        connection = self.db.connection
        deadline = time.monotonic() + 0.5
        with connection.cursor(pymysql.cursors.DictCursor) as c:
            c.execute("SELECT invalidate_from,invalidate_cursor FROM evse_history_state WHERE source=%s FOR UPDATE", (self.source,))
            state = c.fetchone()
            if state and state["invalidate_from"] is not None:
                after = state["invalidate_cursor"]
                c.execute("SELECT bucket_start FROM evse_history_work WHERE source=%s AND resolution_seconds=60 "
                          "AND bucket_start>=%s " + ("AND bucket_start>%s " if after is not None else "") +
                          "ORDER BY bucket_start LIMIT %s",
                          (self.source, state["invalidate_from"], *((after,) if after is not None else ()), CHUNK))
                rows = c.fetchall()
                processed = []
                for row in rows:
                    dirty(c, self.source, row["bucket_start"])
                    processed.append(row)
                    if time.monotonic() >= deadline:
                        break
                if len(rows) < CHUNK and len(processed) == len(rows):
                    c.execute("UPDATE evse_history_state SET invalidate_from=NULL,invalidate_cursor=NULL,"
                              "events_done=IF(event_cursor_at>event_highwater_at OR "
                              "(event_cursor_at=event_highwater_at AND event_cursor_id>=event_highwater_id),1,events_done),"
                              "updated_at=UTC_TIMESTAMP(6) WHERE source=%s", (self.source,))
                else:
                    c.execute("UPDATE evse_history_state SET invalidate_cursor=%s,updated_at=UTC_TIMESTAMP(6) WHERE source=%s",
                              (processed[-1]["bucket_start"], self.source))
        connection.commit()

    def raw_minute(self, c, start):
        end = shifted(start, 60)
        c.execute("SELECT id,measured_at,received_at,status,retained," + ",".join(FIELDS) +
                  " FROM evse_wallbox_samples WHERE source=%s AND measured_at>=%s AND measured_at<%s "
                  "ORDER BY measured_at,id LIMIT %s", (self.source, shifted(start, -10), shifted(end, 10), ROW_LIMIT + 1))
        rows = c.fetchall()
        complete = len(rows) <= ROW_LIMIT
        # Dense data is explicitly incomplete; do not publish arbitrary partial
        # sums as exact statistics for a minute that exceeded its bound.
        if not complete:
            result = empty()
            result["complete"] = False
            return result
        low, high = shifted(start, -20), shifted(end, 20)
        c.execute("SELECT received_at FROM evse_ingest_events WHERE source=%s AND received_at<%s "
                  "ORDER BY received_at DESC,event_id DESC LIMIT 1", (self.source, low))
        baseline = c.fetchone()
        lower = baseline["received_at"] if baseline else low
        c.execute("SELECT received_at,kind,availability,retained FROM evse_ingest_events WHERE source=%s "
                  "AND received_at>=%s AND received_at<=%s ORDER BY received_at,event_id LIMIT %s",
                  (self.source, lower, high, ROW_LIMIT + 1))
        events = c.fetchall()
        complete = len(events) <= ROW_LIMIT
        return minute(start, rows, events[:ROW_LIMIT], complete)

    def job(self):
        connection = self.db.connection
        try:
            with connection.cursor(pymysql.cursors.DictCursor) as c:
                c.execute("SELECT resolution_seconds,bucket_start,generation FROM evse_history_work "
                          "WHERE source=%s AND pending=1 ORDER BY resolution_seconds,bucket_start LIMIT 1", (self.source,))
                work = c.fetchone()
                if not work:
                    connection.commit()
                    return False
                seconds, start, generation = work["resolution_seconds"], work["bucket_start"], work["generation"]
                if seconds not in RESOLUTIONS:
                    raise ValueError("Invalid work resolution")
                if seconds == 60:
                    result = self.raw_minute(c, start)
                else:
                    child_seconds = 60 if seconds == 3600 else 3600
                    c.execute("SELECT 1 FROM evse_history_work WHERE source=%s AND pending=1 AND resolution_seconds=%s "
                              "AND bucket_start>=%s AND bucket_start<%s LIMIT 1",
                              (self.source, child_seconds, start, shifted(start, seconds)))
                    if c.fetchone():
                        connection.rollback()
                        return False
                    c.execute("SELECT IF(OCTET_LENGTH(data_json)<=32768,data_json,NULL) AS data_json "
                              "FROM evse_history_buckets WHERE source=%s AND resolution_seconds=%s "
                              "AND bucket_start>=%s AND bucket_start<%s ORDER BY bucket_start LIMIT 61",
                              (self.source, child_seconds, start, shifted(start, seconds)))
                    children = c.fetchall()
                    if any(row["data_json"] is None for row in children):
                        raise ValueError("Oversized child summary")
                    result = combine([json.loads(row["data_json"]) for row in children], seconds)
                validate(result, seconds)
                payload = json.dumps(result, ensure_ascii=True, separators=(",", ":"), allow_nan=False)
                if len(payload) > 32768:
                    raise ValueError("History JSON budget exceeded")
                # No row lock during raw/statistical computation. Compare the
                # generation with a current locking read just before publication.
                c.execute("SELECT generation FROM evse_history_work WHERE source=%s AND resolution_seconds=%s AND bucket_start=%s FOR UPDATE",
                          (self.source, seconds, start))
                if c.fetchone()["generation"] != generation:
                    connection.rollback()
                    return True
                c.execute("INSERT INTO evse_history_buckets (source,resolution_seconds,bucket_start,data_json,updated_at) "
                          "VALUES (%s,%s,%s,%s,UTC_TIMESTAMP(6)) ON DUPLICATE KEY UPDATE data_json=VALUES(data_json),updated_at=VALUES(updated_at)",
                          (self.source, seconds, start, payload))
                c.execute("UPDATE evse_history_work SET done_generation=%s,pending=0 WHERE source=%s AND resolution_seconds=%s AND bucket_start=%s AND generation=%s",
                          (generation, self.source, seconds, start, generation))
                if seconds != 86400:
                    dirty(c, self.source, start, 3600 if seconds == 60 else 86400)
            connection.commit()
            return True
        except pymysql.OperationalError as error:
            connection.rollback()
            # A concurrent generation update can make MariaDB 11.8 reject the
            # optimistic snapshot's locking read with ER_CHECKREAD (1020).
            # Retry the still-pending job in a fresh transaction; never publish
            # the obsolete result or hide non-transient database failures.
            if error.args and error.args[0] in (1020, 1205, 1213):
                return True
            raise
        except Exception:
            connection.rollback()
            raise

    def turn(self):
        deadline = time.monotonic() + 2
        self.backfill()
        self.invalidations()
        for _ in range(8):
            if time.monotonic() >= deadline or not self.job():
                break
