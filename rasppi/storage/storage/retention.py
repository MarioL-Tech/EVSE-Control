"""Explicit, source-local EVSE expiry; no runtime DDL or configuration mutation.

Integration: construct Policy(raw_env), call accepts(at, now) BEFORE admitting
samples/events, and action(kind, level, bucket_start, now) BEFORE rollup work.
For ``expire`` discard the job; for ``freeze`` acknowledge only that job, without
rewriting its bucket or dirtying parents. Only ``recompute`` may rebuild parents.
Call cleanup only on an idle, exclusively owned DB connection, after intake/work
commits. Admission, workers and cleanup must share the same policy. This module
does not wire these operations into runtime or alter existing backfill cursors.
"""
from datetime import datetime, timedelta, timezone
import re
import time


LEVELS = {'minute': 60, 'hour': 3600, 'day': 86400}
MAX_DELETIONS = 128
PAGE_SIZE = 16


def _utc(value=None):
    if value is None:
        return datetime.now(timezone.utc).replace(tzinfo=None)
    if not isinstance(value, datetime):
        raise ValueError('Expected UTC datetime')
    return value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo else value


def _level(value):
    # Existing Wallbox workers use seconds, HOUSE workers use named levels.
    if type(value) is int:
        value = next((name for name, seconds in LEVELS.items() if seconds == value), None)
    if value not in LEVELS:
        raise ValueError('Invalid retention level')
    return value


def _kind(kind):
    if kind not in ('wallbox', 'house'):
        raise ValueError('Invalid retention kind')


class Policy:
    """Strict raw env strings; 0 is unlimited, never an immediate-delete switch.

    Positive day counts are 1..36500. Parent lifetimes cannot be shorter than
    child lifetimes; an unlimited child requires unlimited parents. Naive dates
    are UTC; aware dates are converted to UTC, never local wall time.
    """
    def __init__(self, env=None):
        env = {} if env is None else env
        days = {}
        for level in LEVELS:
            key = 'STORAGE_RETENTION_' + level.upper() + '_DAYS'
            value = env.get(key, '0')
            if not isinstance(value, str) or not re.fullmatch(r'[0-9]{1,5}', value):
                raise ValueError('Invalid ' + key)
            number = int(value)
            if number > 36500:
                raise ValueError('Invalid ' + key)
            days[level] = number
        for child, parent in (('minute', 'hour'), ('hour', 'day')):
            if days[parent] and (not days[child] or days[parent] < days[child]):
                raise ValueError('Retention parents must outlive children')
        self.minute_days, self.hour_days, self.day_days = (days[x] for x in LEVELS)

    def cutoff(self, level, now=None):
        """Exclusive retained-bucket frontier, floored to the level in UTC.

        None means unlimited. A bucket expires only when its *end* <= this
        frontier; raw samples/events expire at timestamp <= minute frontier.
        """
        level = _level(level)
        days = getattr(self, level + '_days')
        if not days:
            return None
        try:
            at = _utc(now) - timedelta(days=days)
        except OverflowError:
            return datetime.min
        at = at.replace(second=0, microsecond=0)
        if level != 'minute':
            at = at.replace(minute=0)
        if level == 'day':
            at = at.replace(hour=0)
        return at

    def accepts(self, timestamp, now=None):
        """Reject late samples/events at or before the minute cutoff explicitly."""
        if timestamp is None:
            raise ValueError('Expected measurement/event datetime')
        timestamp = _utc(timestamp)
        cutoff = self.cutoff('minute', now)
        return cutoff is None or timestamp > cutoff

    def action(self, kind, level, start, now=None):
        """Return expire/freeze/recompute; never partially expire a parent.

        A retained parent freezes if even one lower-resolution child interval
        has expired, regardless of whether that child has physically been deleted
        yet. This preserves existing aggregates during incremental cleanup.
        """
        _kind(kind)
        if start is None:
            raise ValueError('Expected bucket datetime')
        level, start, now = _level(level), _utc(start), _utc(now)
        seconds = LEVELS[level]
        if start.microsecond or start.second or (seconds >= 3600 and start.minute) or (seconds == 86400 and start.hour):
            raise ValueError('Unaligned retention bucket')
        cutoff = self.cutoff(level, now)
        end = start + timedelta(seconds=seconds)
        if cutoff is not None and end <= cutoff:
            return 'expire'
        for child, duration in LEVELS.items():
            if duration >= seconds:
                break
            frontier = self.cutoff(child, now)
            if frontier is not None and start + timedelta(seconds=duration) <= frontier:
                return 'freeze'
        return 'recompute'


def _targets(kind, history_enabled, minute_present, policy, now):
    """All SQL identifiers are literals from this closed schema registry."""
    minute = policy.cutoff('minute', now)
    if minute is not None:
        if kind == 'wallbox':
            yield ('evse_wallbox_samples', 'source_measurement', 'measured_at', 'id', (), minute)
            yield ('evse_ingest_events', 'source_receipt', 'received_at', 'event_id', (), minute)
        else:
            yield ('evse_house_samples', 'sample_time', 'fetched_at', 'id', (), minute)
            yield ('evse_house_events', 'event_time', 'received_at', 'id', (), minute)
        if minute_present and minute >= datetime.min + timedelta(minutes=1):
            yield ('evse_minute_records', 'PRIMARY', 'bucket_start', None, (('kind', kind),), minute - timedelta(minutes=1))
    if kind == 'wallbox' and not history_enabled:
        return
    for level, seconds in LEVELS.items():
        cutoff = policy.cutoff(level, now)
        if cutoff is None or cutoff < datetime.min + timedelta(seconds=seconds):
            continue
        extra = (('resolution_seconds', seconds),) if kind == 'wallbox' else (('level', level),)
        tables = ('evse_history_buckets', 'evse_history_work') if kind == 'wallbox' else ('evse_house_buckets', 'evse_house_work')
        for table in tables:
            # Pending work is intentionally included: its interval has expired.
            yield (table, 'PRIMARY', 'bucket_start', None, extra, cutoff - timedelta(seconds=seconds))


class Cleaner:
    """Rotating, bounded turns; one transaction, <=128 deleted rows per call.

    Each keyset SELECT forces its source/time index and a <=16-row LIMIT;
    subsequent DELETEs address exact selected keys with LIMIT 1. There is no
    OFFSET, COUNT, raw scan or unbounded DELETE.
    Rotation prevents a huge raw backlog from starving work/other resolutions.
    Optional minute capture table presence is probed once per live connection
    after a successful enabled turn. Reconnects invalidate the presence cache.
    """
    def __init__(self):
        self._connection = None
        self._minute_present = False
        self._turn = {'wallbox': 0, 'house': 0}

    def cleanup(self, db, kind, policy, now=None):
        _kind(kind)
        now = _utc(now)
        if policy.minute_days == 0:
            return {}  # Hierarchy guarantees all levels unlimited; no SQL at all.
        source = db.config.prefix
        if isinstance(source, str):
            source = source.encode('utf-8')
        if not isinstance(source, bytes) or not 1 <= len(source) <= 240:
            raise ValueError('Invalid retention source')
        connection = db.connection
        counts, remaining = {}, MAX_DELETIONS
        deadline = time.monotonic() + 0.25
        minute_present = self._minute_present
        try:
            connection.begin()
            with connection.cursor() as cursor:
                if self._connection is not connection:
                    cursor.execute('SELECT TABLE_NAME FROM information_schema.TABLES '
                                   'WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s LIMIT 1',
                                   (db.config.db_name, 'evse_minute_records'))
                    minute_present = cursor.fetchone() is not None
                targets = list(_targets(kind, db.history_enabled, minute_present, policy, now))
                offset = self._turn[kind] % len(targets)
                targets = targets[offset:] + targets[:offset]
                visited = 0
                for table, index, stamp, identity, extra, frontier in targets:
                    predicates = ['source=%s'] + [column + '=%s' for column, _ in extra]
                    predicates.append(stamp + '<=%s')
                    order = stamp + (',' + identity if identity else '')
                    limit = min(PAGE_SIZE, remaining)
                    # MariaDB single-table DELETE does not accept FORCE INDEX.
                    # Select bounded identities through the time index first;
                    # deletes below are exact unique/primary-key lookups.
                    cursor.execute('SELECT ' + order + ' FROM ' + table + ' FORCE INDEX (' + index + ') WHERE '
                                   + ' AND '.join(predicates) + ' ORDER BY ' + order + ' LIMIT %s',
                                   (source, *(value for _, value in extra), frontier, limit))
                    rows = cursor.fetchall()
                    if len(rows) > limit:
                        raise ValueError('Invalid retention selection count')
                    deleted = 0
                    for row in rows:
                        if time.monotonic() >= deadline:
                            break
                        keys = [stamp] + ([identity] if identity else [])
                        cursor.execute('DELETE FROM ' + table + ' WHERE '
                                       + ' AND '.join(predicates[:-1] + [key + '=%s' for key in keys])
                                       + ' LIMIT 1', (source, *(value for _, value in extra), *row))
                        if not 0 <= cursor.rowcount <= 1:
                            raise ValueError('Invalid retention delete count')
                        deleted += cursor.rowcount
                    counts[table] = counts.get(table, 0) + deleted
                    remaining -= deleted
                    visited += 1
                    if not remaining or time.monotonic() >= deadline:
                        break
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        self._connection, self._minute_present = connection, minute_present
        self._turn[kind] = (offset + visited) % len(targets)
        return counts


def cleanup(db, kind, policy, now=None):
    """Convenience API retaining fair rotation/cache on this Database instance.

    Returns per-table deletion counts (no source identifiers or sample values).
    No commit or SQL is performed for an unlimited policy. Errors roll back the
    entire turn; callers own retry scheduling and must not log secret DB details.
    """
    cleaner = getattr(db, '_retention_cleaner', None)
    if cleaner is None:
        cleaner = db._retention_cleaner = Cleaner()
    return cleaner.cleanup(db, kind, policy, now)
