"""Independent append-only minute capture; open minutes are deliberately RAM-only.

MQTT ACK means successful bounded RAM admission, not durable SQL publication.
The single frozen publication survives uncertain COMMITs unchanged. No raw sample
is written by this module. Old raw data remains readable strictly before cutover.
"""
from datetime import datetime, timedelta
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import time

import pymysql
from .database import Database
from . import history

MIGRATION = Path(__file__).resolve().parent.parent / 'migrations/004_minutes.sql'
KINDS = "enum('wallbox','house')"
TABLES = {
    'evse_minute_schema_versions': ({'version': 'int', 'checksum': 'binary(32)',
        'applied_at': 'datetime(6)'}, set(), {('version',)}),
    'evse_minute_sources': ({'kind': KINDS, 'source': 'varbinary(240)',
        'started_at': 'datetime(6)'}, set(), {('kind', 'source')}),
    'evse_minute_records': ({'kind': KINDS, 'source': 'varbinary(240)',
        'bucket_start': 'datetime(6)', 'data_json': 'longtext', 'digest': 'binary(32)'},
        set(), {('kind', 'source', 'bucket_start')}),
}
MAX_ROWS = 128
MAX_BYTES = 32768
UTC = lambda: datetime.utcnow()


def verify(db, required=False):
    """One bounded existence probe per Database object; raw installs need no DDL."""
    if not hasattr(db, '_minute_present'):
        with db.connection.cursor() as c:
            c.execute('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=%s '
                      'AND TABLE_NAME IN (%s,%s,%s) LIMIT 3', (db.config.db_name, *TABLES))
            names = {r[0] for r in c.fetchall()}
        db._minute_present = 'evse_minute_schema_versions' in names
    if not db._minute_present:
        if required:
            raise ValueError('Minute migration required')
        return False
    # Explicit base-class call: HOUSE overrides verify_shape for its own registry.
    Database.verify_shape(db, tables=TABLES)
    with db.connection.cursor() as c:
        for name, (_, _, identities) in TABLES.items():
            primary = next(iter(identities))
            c.execute('SELECT COLUMN_NAME,SUB_PART FROM information_schema.STATISTICS '
                      'WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s AND INDEX_NAME=%s ORDER BY SEQ_IN_INDEX',
                      (db.config.db_name, name, 'PRIMARY'))
            if c.fetchall() != tuple((column, None) for column in primary):
                raise ValueError('Invalid minute primary key')
        c.execute('SELECT version,checksum FROM evse_minute_schema_versions ORDER BY version LIMIT 2')
        if c.fetchall() != ((1, hashlib.sha256(MIGRATION.read_bytes()).digest()),):
            raise ValueError('Unsupported minute registry')
    return True


def migrate(db):
    lock = 'evse-minute-schema-' + hashlib.sha256(db.config.db_name.encode()).hexdigest()[:40]
    with db.connection.cursor() as c:
        c.execute('SELECT GET_LOCK(%s,10)', (lock,))
        if c.fetchone()[0] != 1:
            raise ValueError('Minute migration already running')
        try:
            c.execute('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=%s '
                      'AND TABLE_NAME IN (%s,%s,%s) LIMIT 3', (db.config.db_name, *TABLES))
            existing = {r[0] for r in c.fetchall()}
            if existing:
                Database.verify_shape(db, names=existing, tables=TABLES)
            checksum = hashlib.sha256(MIGRATION.read_bytes()).digest()
            versions = ()
            if 'evse_minute_schema_versions' in existing:
                c.execute('SELECT version,checksum FROM evse_minute_schema_versions ORDER BY version LIMIT 2')
                versions = c.fetchall()
                if versions and versions != ((1, checksum),):
                    raise ValueError('Unsupported minute registry')
                if versions and existing != set(TABLES):
                    raise ValueError('Incomplete registered minute schema')
            for statement in MIGRATION.read_text().split(';'):
                if statement.strip():
                    c.execute(statement)
            Database.verify_shape(db, tables=TABLES)
            if not versions:
                c.execute('INSERT INTO evse_minute_schema_versions (version,checksum,applied_at) '
                          'VALUES (1,%s,UTC_TIMESTAMP(6))', (checksum,))
            db.connection.commit()
            db._minute_present = True
            verify(db, True)
            db.connection.commit()
        finally:
            c.execute('SELECT RELEASE_LOCK(%s)', (lock,))


def encode(data):
    def typed(value):
        if isinstance(value, datetime):
            return history.stamp(value)
        if isinstance(value, Decimal):
            return format(value, 'f') if value else '0'
        raise TypeError('Unsupported minute value')
    payload = json.dumps(data, default=typed, sort_keys=True, separators=(',', ':'),
                         ensure_ascii=True, allow_nan=False)
    if len(payload.encode()) > MAX_BYTES:
        raise ValueError('Minute payload too large')
    return payload


def decode(kind, payload, start):
    if kind not in ('wallbox', 'house'):
        raise ValueError('Invalid capture kind')
    if not isinstance(payload, str) or len(payload.encode()) > MAX_BYTES:
        raise ValueError('Invalid minute payload budget')
    data = json.loads(payload)
    if kind == 'wallbox':
        history.validate(data, 60)
        if data['samples'] > MAX_ROWS or encode(data) != payload:
            raise ValueError('Invalid canonical Wallbox capture')
        if data['samples'] and not history.stamp(start) <= data['first_at'] <= data['last_at'] < history.stamp(start + timedelta(minutes=1)):
            raise ValueError('Invalid Wallbox capture time bounds')
        return data
    from .house_rollup import empty
    template = empty(start, 'minute')
    if not isinstance(data, dict) or set(data) != set(template):
        raise ValueError('Invalid HOUSE capture shape')
    for key in ('bucket_start', 'bucket_end', 'first_at', 'last_at'):
        if data[key] is not None:
            value = datetime.strptime(data[key], '%Y-%m-%dT%H:%M:%S.%fZ')
            if history.stamp(value) != data[key]:
                raise ValueError('Invalid HOUSE capture date')
            data[key] = value
    if data['bucket_start'] != start or data['bucket_end'] != start + timedelta(minutes=1):
        raise ValueError('Invalid HOUSE capture boundary')
    for key in ('samples', 'valid_count', 'null_count', 'coverage_ms'):
        if type(data[key]) is not int or not 0 <= data[key] <= (60000 if key == 'coverage_ms' else MAX_ROWS):
            raise ValueError('Invalid HOUSE capture count')
    if data['valid_count'] + data['null_count'] != data['samples']:
        raise ValueError('Invalid HOUSE capture counts')
    for key in ('has_gap', 'complete'):
        if type(data[key]) is not bool:
            raise ValueError('Invalid HOUSE capture flag')
    for key in ('sum_w', 'min_w', 'max_w', 'first_w', 'last_w'):
        if data[key] is not None:
            if not isinstance(data[key], str) or len(data[key]) > 80:
                raise ValueError('Invalid HOUSE capture decimal')
            data[key] = Decimal(data[key])
            maximum = Decimal(9007199254740991) * (MAX_ROWS if key == 'sum_w' else 1)
            if not data[key].is_finite() or abs(data[key]) > maximum or data[key].as_tuple().exponent < -6:
                raise ValueError('Invalid HOUSE capture decimal')
    present = data['valid_count'] > 0
    if any((data[k] is not None) != present for k in ('sum_w', 'min_w', 'max_w')):
        raise ValueError('Invalid HOUSE capture statistics')
    if present and not (data['min_w'] <= data['max_w'] and
                       data['min_w'] * data['valid_count'] <= data['sum_w'] <= data['max_w'] * data['valid_count']):
        raise ValueError('Invalid HOUSE capture sum')
    if ((data['samples'] == 0) != (data['first_at'] is None) or
            (data['samples'] == 0) != (data['last_at'] is None)):
        raise ValueError('Invalid HOUSE capture observation bounds')
    if data['samples'] and not start <= data['first_at'] <= data['last_at'] < start + timedelta(minutes=1):
        raise ValueError('Invalid HOUSE capture time order')
    for key in ('first_w', 'last_w'):
        if data[key] is not None and (not present or not data['min_w'] <= data[key] <= data['max_w']):
            raise ValueError('Invalid HOUSE capture endpoint')
    if encode(data) != payload:
        raise ValueError('Noncanonical HOUSE capture')
    return data


def captured(db, c, kind, source, start):
    """None alone means legacy. Missing post-cutover data is explicitly a gap."""
    if not getattr(db, '_minute_present', False):
        return None
    c.execute('SELECT started_at FROM evse_minute_sources WHERE kind=%s AND source=%s', (kind, source))
    cutover = c.fetchone()
    if cutover is not None and history.floor(cutover['started_at']) != cutover['started_at']:
        raise ValueError('Invalid capture cutover')
    if cutover is None or start < cutover['started_at']:
        return None
    c.execute('SELECT IF(OCTET_LENGTH(data_json)<=32768,data_json,NULL) AS data_json,digest '
              'FROM evse_minute_records WHERE kind=%s AND source=%s AND bucket_start=%s', (kind, source, start))
    row = c.fetchone()
    if row is None:
        if kind == 'wallbox':
            data = history.empty()
            data['complete'] = False
        else:
            from .house_rollup import empty
            data = empty(start, 'minute')
    else:
        if row['data_json'] is None or hashlib.sha256(row['data_json'].encode()).digest() != row['digest']:
            raise ValueError('Corrupt minute digest')
        data = decode(kind, row['data_json'], start)
    # Immutable capture cannot absorb late global lifecycle events. Recompute
    # must remain fail-closed rather than silently restoring stale coverage.
    table = 'evse_ingest_events' if kind == 'wallbox' else 'evse_house_events'
    c.execute('SELECT received_at,kind,availability,retained FROM ' + table +
              ' WHERE source=%s AND received_at>=%s AND received_at<=%s ORDER BY received_at LIMIT 129',
              (source, start - timedelta(seconds=10), start + timedelta(seconds=70)))
    events = c.fetchall()
    c.execute('SELECT received_at,kind,availability,retained FROM ' + table +
              ' WHERE source=%s AND received_at<%s ORDER BY received_at DESC LIMIT 2',
              (source, start - timedelta(seconds=10)))
    preceding = c.fetchall()
    baseline_bad = bool(preceding) and (
        len(preceding) > 1 and preceding[0]['received_at'] == preceding[1]['received_at'] or
        preceding[0]['kind'] != 'availability' or preceding[0]['availability'] != 'online' or preceding[0]['retained'])
    if (len(events) > 128 or len({e['received_at'] for e in events}) != len(events) or
            baseline_bad or any(e['kind'] != 'availability' or e['availability'] != 'online' or e['retained'] for e in events)):
        data['has_gap'] = True
        if kind == 'wallbox':
            data['coverage_seconds'] = '0'
        else:
            data['coverage_ms'] = 0
    return data


def require_raw_source(db, kind):
    """A one-way cutover cannot be silently rolled back to hidden raw writes."""
    if getattr(db, '_minute_present', False) is not True:
        return
    with db.connection.cursor() as c:
        c.execute('SELECT started_at FROM evse_minute_sources WHERE kind=%s AND source=%s',
                  (kind, db.config.prefix))
        present = c.fetchone() is not None
    db.connection.commit()
    if present:
        raise ValueError('Minute source cannot resume raw intake')


class IntakeRejected(ValueError):
    """Bounded admission failed: withhold ACK and mark a gap, never raw-write."""


class Accumulator:
    def __init__(self, kind, source, started_at, at=None, monotonic=None):
        if kind not in ('wallbox', 'house') or not source or len(source.encode()) > 240:
            raise ValueError('Invalid minute source')
        self.kind, self.source, self.started_at = kind, source, started_at
        self.open = {}
        self.rows, self.events = [], []
        self.frozen = None
        self.closed = None
        self.serial = 0
        self.last_received = self.last_at = None
        self.restart_at = at or UTC()
        self.monotonic = monotonic or time.monotonic

    def damage(self):
        for state in self.open.values():
            state['gap'] = True

    def admit(self, item):
        if self.frozen is not None:
            raise IntakeRejected('Publication pending')
        received = item['received_at']
        if item['kind'] != 'sample':
            # Bound recent lifecycle context plus the last preceding event.
            boundary = min(self.open) - timedelta(seconds=10) if self.open else received - timedelta(seconds=80)
            old = [e for e in self.events if e['received_at'] < boundary]
            latest = max((e['received_at'] for e in old), default=None)
            self.events = ([e for e in old if e['received_at'] == latest][:2] +
                           [e for e in self.events if e['received_at'] >= boundary])
            if len(self.events) >= 257:
                self.damage()
                # Collapse overflow to an explicit unknown lifecycle; do not
                # deadlock intake on a full context with no open sample minute.
                self.events = [dict(received_at=received, kind='ingestion_gap',
                                    availability=None, retained=False)]
                return True
            self.events.append({k: item.get(k) for k in ('received_at', 'kind', 'availability', 'retained')})
            return True
        sample = item['sample']
        at = sample['measured_at' if self.kind == 'wallbox' else 'fetched_at']
        start = history.floor(at)
        backwards = (self.last_at is not None and at < self.last_at or
                     self.last_received is not None and received <= self.last_received)
        if backwards:
            self.damage()
        self.last_at = max(at, self.last_at) if self.last_at else at
        self.last_received = max(received, self.last_received) if self.last_received else received
        if (start < self.started_at or (self.closed is not None and start <= self.closed) or
                at > received + timedelta(seconds=10) or at < received - timedelta(seconds=70)):
            self.damage()
            raise IntakeRejected('Observation outside open minutes')
        if start not in self.open:
            if len(self.open) >= 2:
                self.damage()
                raise IntakeRejected('Open minute budget exceeded')
            self.open[start] = dict(keys=set(), identities={}, gap=backwards or start <= history.floor(self.restart_at),
                deadline=self.monotonic() + min(70, max(0, (start + timedelta(seconds=70) - received).total_seconds())))
        state = self.open[start]
        # Retained delivery is independent evidence, not a benign duplicate.
        identity = (sample['hash' if self.kind == 'wallbox' else 'digest'], bool(item['retained']))
        if self.kind == 'house':
            delivery = (sample['publisher_id'], sample['sequence'])
            previous = state['identities'].get(delivery)
            if previous is not None and previous != sample['digest']:
                self.damage()
                raise IntakeRejected('Conflicting HOUSE observation identity')
        if identity in state['keys']:
            if backwards:
                state['gap'] = True
            return False
        if len(state['keys']) >= MAX_ROWS:
            self.damage()
            raise IntakeRejected('Observation budget exceeded')
        self.serial += 1
        row = dict(id=self.serial, received_at=received, status=sample['status'], retained=item['retained'])
        if self.kind == 'wallbox':
            from .protocol import MEASUREMENT_COLUMNS
            row.update(zip(MEASUREMENT_COLUMNS, sample['columns']))
            row['measured_at'] = at
        else:
            row.update({k: sample[k] for k in ('fetched_at', 'power_w', 'publisher_id', 'sequence')})
        state['keys'].add(identity)
        if self.kind == 'house':
            state['identities'][delivery] = sample['digest']
        state['gap'] |= backwards
        self.rows.append(row)
        return True

    def freeze(self, at=None, shutdown=False):
        if self.frozen is not None:
            return self.frozen
        if not self.open:
            return None
        at = at or UTC()
        start = min(self.open)
        state = self.open[start]
        if not shutdown and at < start + timedelta(seconds=70) and self.monotonic() < state['deadline']:
            return None
        time_key = 'measured_at' if self.kind == 'wallbox' else 'fetched_at'
        rows = [r for r in self.rows if start - timedelta(seconds=10) <= r[time_key] <= start + timedelta(seconds=70)]
        if self.kind == 'wallbox':
            data = history.minute(start, rows, self.events)
        else:
            from .house_rollup import minute
            data = minute(start, rows, self.events)
        if shutdown or state['gap']:
            data['has_gap'] = True
            data['complete'] = False
        payload = encode(data)
        # Validate the exact serialized shape before freezing any retry identity.
        decode(self.kind, payload, start)
        self.frozen = (start, payload, hashlib.sha256(payload.encode()).digest())
        return self.frozen

    def published(self):
        start = self.frozen[0]
        del self.open[start]
        self.closed = start
        self.frozen = None
        # Keep only bounded 10-second left context for the next minute.
        boundary = start + timedelta(seconds=50)
        key = 'measured_at' if self.kind == 'wallbox' else 'fetched_at'
        self.rows = [r for r in self.rows if r[key] >= boundary]
        old = [e for e in self.events if e['received_at'] < boundary]
        latest = max((e['received_at'] for e in old), default=None)
        baseline = [e for e in old if e['received_at'] == latest][:2]
        self.events = baseline + [e for e in self.events if e['received_at'] >= boundary]


class Recorder:
    def __init__(self, db, kind):
        self.db, self.kind = db, kind
        self.accumulator = None
        self.availability = None

    def acquire(self):
        db, kind, source = self.db, self.kind, self.db.config.prefix
        verify(db, True)
        lock = 'evse-minute-source-' + hashlib.sha256((db.config.db_name + '\0' + kind + '\0' + source).encode()).hexdigest()[:40]
        with db.connection.cursor() as c:
            c.execute('SELECT GET_LOCK(%s,0)', (lock,))
            if c.fetchone()[0] != 1:
                raise ValueError('Minute source already active')
            c.execute('SELECT started_at FROM evse_minute_sources WHERE kind=%s AND source=%s', (kind, source))
            existing = c.fetchone()
            if existing is None:
                # The source advisory lock serializes conforming writers. No
                # no-op UPDATE: immutable cutovers need SELECT/INSERT only.
                started = history.floor(UTC())
                c.execute('INSERT INTO evse_minute_sources (kind,source,started_at) VALUES (%s,%s,%s)',
                          (kind, source, started))
            else:
                started = existing[0]
            if history.floor(started) != started:
                raise ValueError('Invalid minute cutover')
            c.execute('SELECT bucket_start FROM evse_minute_records WHERE kind=%s AND source=%s '
                      'ORDER BY bucket_start DESC LIMIT 1', (kind, source))
            last = c.fetchone()
        db.connection.commit()
        if self.accumulator is None:
            self.accumulator = Accumulator(kind, source, started)
            self.accumulator.closed = last[0] if last else None
        elif self.accumulator.started_at != started:
            raise ValueError('Minute source cutover changed')

    def write(self, item):
        if item['kind'] == 'sample':
            return self.accumulator.admit(item)
        state = (item.get('availability'), bool(item['retained']))
        if item['kind'] == 'availability' and self.availability == state:
            return False
        # SQL event UUID remains identical on ambiguous commit; RAM admission
        # follows durable event storage and therefore cannot falsely ACK it.
        result = self.db.write(item)
        self.accumulator.admit(item)
        self.availability = state if item['kind'] == 'availability' else None
        return result

    def flush(self, shutdown=False):
        frozen = self.accumulator.freeze(shutdown=shutdown)
        if frozen is None:
            return False
        start, payload, digest = frozen
        db, source = self.db, self.db.config.prefix
        try:
            with db.connection.cursor() as c:
                c.execute('INSERT INTO evse_minute_records (kind,source,bucket_start,data_json,digest) '
                          'VALUES (%s,%s,%s,%s,%s)', (self.kind, source, start, payload, digest))
                if self.kind == 'house':
                    from .house_rollup import dirty
                    for level in ('minute', 'hour', 'day'):
                        dirty(c, source, start, level)
                elif db.history_enabled:
                    for seconds in history.RESOLUTIONS:
                        history.dirty(c, source, start, seconds)
            db.connection.commit()
        except pymysql.IntegrityError as error:
            db.connection.rollback()
            if error.args[0] != 1062:
                raise
            with db.connection.cursor() as c:
                c.execute('SELECT IF(OCTET_LENGTH(data_json)<=32768,data_json,NULL),digest '
                          'FROM evse_minute_records WHERE kind=%s AND source=%s AND bucket_start=%s',
                          (self.kind, source, start))
                if c.fetchone() != (payload, digest):
                    db.connection.rollback()
                    raise ValueError('Conflicting immutable minute') from None
            db.connection.commit()
        except Exception:
            db.connection.rollback()
            raise
        self.accumulator.published()
        return True
