"""Bounded HOUSE materialization. Parents read children, never historical raw ranges."""
from datetime import datetime, timedelta
from decimal import Decimal, localcontext
import hashlib
import os
import time
import pymysql
from .house_database import BUCKET_TYPES

SECONDS = {'minute': 60, 'hour': 3600, 'day': 86400}
LIMIT = 2048
EPOCH = datetime(1970, 1, 1)


def floor(at, level):
    seconds = SECONDS[level]
    delta = at - EPOCH
    return EPOCH + timedelta(seconds=(delta.days * 86400 + delta.seconds) // seconds * seconds)


def dirty(c, source, at, level):
    c.execute('INSERT INTO evse_house_work (source,level,bucket_start,generation,processed_generation,pending) '
              'VALUES (%s,%s,%s,1,0,1) ON DUPLICATE KEY UPDATE generation=generation+1,pending=1',
              (source, level, floor(at, level)))


def dirty_observation(c, source, at):
    # Both neighboring minutes can consume this observation as context. Refresh
    # an already-known next minute, but never create future work just for context:
    # that would keep parents from catching up during continuous intake.
    current = floor(at, 'minute')
    minutes = {current}
    if current >= EPOCH + timedelta(minutes=1):
        minutes.add(current - timedelta(minutes=1))
    following = current + timedelta(minutes=1)
    c.execute('SELECT 1 FROM evse_house_work WHERE source=%s AND level=%s '
              'AND bucket_start=%s FOR UPDATE', (source, 'minute', following))
    if c.fetchone() is not None:
        minutes.add(following)
    work = {('minute', start) for start in minutes}
    work.update(('hour', floor(start, 'hour')) for start in minutes)
    work.update(('day', floor(start, 'day')) for start in minutes)
    for level, start in sorted(work, key=lambda item: (SECONDS[item[0]], item[1])):
        dirty(c, source, start, level)


def empty(start, level):
    return dict(bucket_start=start, bucket_end=start + timedelta(seconds=SECONDS[level]),
                samples=0, valid_count=0, null_count=0, sum_w=None, min_w=None, max_w=None,
                first_w=None, last_w=None, first_at=None, last_at=None,
                coverage_ms=0, has_gap=True, complete=False)


def barrier(event):
    return event['kind'] != 'availability' or event.get('availability') != 'online' or event['retained']


def minute(start, rows, events, bounded=True):
    result = empty(start, 'minute')
    if not bounded:
        return result
    end = result['bucket_end']
    rows = sorted(rows, key=lambda r: (r['fetched_at'], r['id']))
    events = sorted(events, key=lambda e: (e['received_at'],
                                           e.get('id', b'')))
    event_counts = {}
    for event in events:
        at = event['received_at']
        event_counts[at] = event_counts.get(at, 0) + 1
    inside = [r for r in rows if start <= r['fetched_at'] < end]
    valid = [r['power_w'] for r in inside if r['status'] == 'ok' and r['power_w'] is not None]
    result.update(samples=len(inside), valid_count=len(valid), null_count=len(inside) - len(valid))
    if inside:
        result.update(first_w=inside[0]['power_w'], last_w=inside[-1]['power_w'],
                      first_at=inside[0]['fetched_at'], last_at=inside[-1]['fetched_at'])
    if valid:
        with localcontext() as ctx:
            ctx.prec = 60
            result.update(sum_w=sum(valid, Decimal(0)), min_w=min(valid), max_w=max(valid))
    coverage_us = 0
    for a, b in zip(rows, rows[1:]):
        left, right = a['fetched_at'], b['fetched_at']
        if not (0 < (right - left).total_seconds() <= 10 and
                a['publisher_id'] == b['publisher_id'] and b['sequence'] == a['sequence'] + 1 and
                a['id'] < b['id'] and a['received_at'] < b['received_at'] and
                all(r['status'] == 'ok' and r['power_w'] is not None and not r['retained'] and
                    abs((r['received_at'] - r['fetched_at']).total_seconds()) <= 10 for r in (a, b))):
            continue
        # Events have reception times, samples have HTTP times. Both time domains
        # are checked; uncertain clocks cannot be used to bypass a barrier.
        low = min(left, a['received_at'])
        high = max(right, b['received_at'])
        preceding = [e for e in events if e['received_at'] < low]
        if preceding:
            latest = max(e['received_at'] for e in preceding)
            baseline = [e for e in preceding if e['received_at'] == latest]
            # A known offline/ambiguous lifecycle remains unknown until a new
            # unambiguous non-retained online event, not just until its timestamp
            # falls outside this individual sample edge.
            if len(baseline) != 1 or barrier(baseline[0]):
                continue
        if any(low <= e['received_at'] <= high and
               (barrier(e) or event_counts[e['received_at']] != 1) for e in events):
            continue
        lo, hi = max(start, left), min(end, right)
        if hi > lo:
            coverage_us += (hi - lo) // timedelta(microseconds=1)
    result['coverage_ms'] = coverage_us // 1000
    result['has_gap'] = coverage_us < 60000000
    # Complete means bounded two-sided computation, not absence of physical gaps.
    result['complete'] = any(r['fetched_at'] <= start for r in rows) and any(r['fetched_at'] >= end for r in rows)
    return result


def combine(start, level, children):
    result = empty(start, level)
    child_level = 'minute' if level == 'hour' else 'hour'
    expected = SECONDS[level] // SECONDS[child_level]
    children = sorted(children, key=lambda child: child['bucket_start'])
    for c in children:
        if (not start <= c['bucket_start'] < result['bucket_end'] or
                c['bucket_start'] != floor(c['bucket_start'], child_level) or
                c['bucket_end'] != c['bucket_start'] + timedelta(seconds=SECONDS[child_level])):
            raise ValueError('Invalid HOUSE child boundary')
    if len({c['bucket_start'] for c in children}) != len(children):
        raise ValueError('Duplicate HOUSE child')
    result['complete'] = len(children) == expected and all(c['complete'] for c in children)
    result['has_gap'] = not result['complete'] or any(c['has_gap'] for c in children)
    for key in ('samples', 'valid_count', 'null_count', 'coverage_ms'):
        result[key] = sum(c[key] for c in children)
    present = [c for c in children if c['valid_count']]
    if present:
        with localcontext() as ctx:
            ctx.prec = 60
            result.update(sum_w=sum((c['sum_w'] for c in present), Decimal(0)),
                          min_w=min(c['min_w'] for c in present), max_w=max(c['max_w'] for c in present))
    observed = [c for c in children if c['samples']]
    if observed:
        result.update(first_w=observed[0]['first_w'], first_at=observed[0]['first_at'],
                      last_w=observed[-1]['last_w'], last_at=observed[-1]['last_at'])
    return result


class HouseWorker:
    def __init__(self, db):
        self.db, self.source = db, db.config.prefix
        from .retention import Policy
        self.retention = Policy(os.environ)
        self.progress = {level: 0 for level in SECONDS}

    def acquire(self):
        self.db.verify()
        lock = 'evse-house-worker-' + hashlib.sha256(
            (self.db.config.db_name + '\0' + self.source).encode()).hexdigest()[:40]
        with self.db.connection.cursor() as c:
            c.execute('SET SESSION max_statement_time=1')
            c.execute('SELECT GET_LOCK(%s,0)', (lock,))
            if c.fetchone()[0] != 1:
                raise ValueError('HOUSE worker already active')
        self.db.connection.commit()

    def raw_minute(self, c, start):
        from .minutes import captured
        capture = captured(self.db, c, 'house', self.source, start)
        if capture is not None:
            return capture
        end = start + timedelta(minutes=1)
        # Both context sides are bounded by the maximum continuity freshness.
        c.execute('SELECT id,publisher_id,sequence,fetched_at,received_at,status,power_w,retained '
                  'FROM evse_house_samples WHERE source=%s AND fetched_at>=%s AND fetched_at<=%s '
                  'ORDER BY fetched_at,id LIMIT %s',
                  (self.source, start - timedelta(seconds=10), end + timedelta(seconds=10), LIMIT + 1))
        rows = c.fetchall()
        c.execute('SELECT kind,received_at,retained,availability FROM evse_house_events WHERE source=%s '
                  'AND received_at>=%s AND received_at<=%s ORDER BY received_at,id LIMIT %s',
                  (self.source, start - timedelta(seconds=20), end + timedelta(seconds=20), LIMIT + 1))
        events = list(c.fetchall())
        bounded = len(rows) <= LIMIT and len(events) <= LIMIT
        # Preserve the last lifecycle before the bounded event window; two
        # rows are enough to detect an ambiguous latest-timestamp tie.
        c.execute('SELECT kind,received_at,retained,availability FROM evse_house_events WHERE source=%s '
                  'AND received_at<%s ORDER BY received_at DESC,id DESC LIMIT 2',
                  (self.source, start - timedelta(seconds=20)))
        events.extend(c.fetchall())
        return minute(start, rows, events, bounded)

    def job(self):
        connection = self.db.connection
        try:
            with connection.cursor(pymysql.cursors.DictCursor) as c:
                c.execute('SELECT level,bucket_start,generation FROM evse_house_work WHERE source=%s AND pending=1 '
                          'ORDER BY level,bucket_start LIMIT 1', (self.source,))
                work = c.fetchone()
                if work is None:
                    connection.commit()
                    return False
                level, start, generation = work['level'], work['bucket_start'], work['generation']
                if level not in SECONDS or floor(start, level) != start:
                    raise ValueError('Invalid HOUSE work')
                action = self.retention.action('house', level, start)
                if action != 'recompute':
                    c.execute('SELECT generation FROM evse_house_work WHERE source=%s AND level=%s AND bucket_start=%s FOR UPDATE',
                              (self.source, level, start))
                    current = c.fetchone()
                    if current is None or current['generation'] != generation:
                        connection.rollback()
                        return True
                    if action == 'expire':
                        c.execute('DELETE FROM evse_house_buckets WHERE source=%s AND level=%s AND bucket_start=%s LIMIT 1',
                                  (self.source, level, start))
                    c.execute('UPDATE evse_house_work SET processed_generation=%s,pending=0 WHERE source=%s AND level=%s AND bucket_start=%s AND generation=%s',
                              (generation, self.source, level, start, generation))
                    connection.commit()
                    self.progress[level] += 1
                    return True
                if level == 'minute':
                    result = self.raw_minute(c, start)
                else:
                    child = 'minute' if level == 'hour' else 'hour'
                    end = start + timedelta(seconds=SECONDS[level])
                    c.execute('SELECT 1 FROM evse_house_work WHERE source=%s AND level=%s AND pending=1 '
                              'AND bucket_start>=%s AND bucket_start<%s LIMIT 1', (self.source, child, start, end))
                    if c.fetchone():
                        connection.rollback()
                        return False
                    c.execute('SELECT ' + ','.join(BUCKET_TYPES) + ' FROM evse_house_buckets WHERE source=%s '
                              'AND level=%s AND bucket_start>=%s AND bucket_start<%s ORDER BY bucket_start LIMIT 61',
                              (self.source, child, start, end))
                    result = combine(start, level, c.fetchall())
                c.execute('SELECT generation FROM evse_house_work WHERE source=%s AND level=%s AND bucket_start=%s FOR UPDATE',
                          (self.source, level, start))
                current = c.fetchone()
                if current is None or current['generation'] != generation:
                    connection.rollback()
                    return True
                values = dict(source=self.source, level=level, **result)
                columns = list(BUCKET_TYPES)
                c.execute('INSERT INTO evse_house_buckets (' + ','.join(columns) + ') VALUES (' +
                          ','.join(['%s'] * len(columns)) + ') ON DUPLICATE KEY UPDATE ' +
                          ','.join(k + '=VALUES(' + k + ')' for k in columns if k not in ('source', 'level', 'bucket_start')),
                          [values[k] for k in columns])
                c.execute('UPDATE evse_house_work SET processed_generation=%s,pending=0 '
                          'WHERE source=%s AND level=%s AND bucket_start=%s AND generation=%s',
                          (generation, self.source, level, start, generation))
                if level != 'day':
                    dirty(c, self.source, start, 'hour' if level == 'minute' else 'day')
            connection.commit()
            self.progress[level] += 1
            return True
        except pymysql.OperationalError as error:
            connection.rollback()
            if error.args and error.args[0] in (1020, 1205, 1213):
                return True
            raise
        except Exception:
            connection.rollback()
            raise

    def turn(self):
        deadline = time.monotonic() + 0.5
        before = dict(self.progress)
        # Two minute contexts plus their parents must be able to settle faster
        # than the normal observation stream, while both count and wall time
        # remain strictly bounded.
        for _ in range(8):
            if time.monotonic() >= deadline or not self.job():
                break
        return {level for level, count in self.progress.items() if count != before[level]}

    def pending_keys(self):
        """At most one oldest key per level, solely for bounded liveness."""
        with self.db.connection.cursor() as c:
            c.execute('SELECT level,MIN(bucket_start) FROM evse_house_work '
                      'WHERE source=%s AND pending=1 GROUP BY level ORDER BY level',
                      (self.source,))
            rows = c.fetchall()
        self.db.connection.commit()
        return dict(rows)
