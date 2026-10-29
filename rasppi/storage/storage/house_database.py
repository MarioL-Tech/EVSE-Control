"""Independent HOUSE registry and append-only intake; never verifies Wallbox."""
import hashlib
import json
from pathlib import Path
import pymysql
from .database import Database

LEVEL = "enum('minute','hour','day')"
KINDS = "enum('availability','collector_started','broker_connected','broker_disconnected','ingestion_gap','collector_stopping')"
KEY = {'source': 'varbinary(240)', 'level': LEVEL, 'bucket_start': 'datetime(6)'}
BUCKET_TYPES = {**KEY, 'bucket_end': 'datetime(6)',
                **{k: 'bigint unsigned' for k in ('samples', 'valid_count', 'null_count', 'coverage_ms')},
                'sum_w': 'decimal(38,6)',
                **{k: 'decimal(24,6)' for k in ('min_w', 'max_w', 'first_w', 'last_w')},
                'first_at': 'datetime(6)', 'last_at': 'datetime(6)',
                'has_gap': 'tinyint(1)', 'complete': 'tinyint(1)'}
TABLES = {
    'evse_house_schema_versions': ({'version': 'int', 'checksum': 'binary(32)', 'applied_at': 'datetime(6)'}, set(), {('version',)}),
    'evse_house_samples': ({'id': 'bigint unsigned', 'source': 'varbinary(240)', 'publisher_id': 'binary(16)',
                           'sequence': 'int unsigned', 'fetched_at': 'datetime(6)', 'received_at': 'datetime(6)',
                           'status': "enum('ok','error')", 'last_success_at': 'datetime(6)', 'power_w': 'decimal(24,6)',
                           'error_code': "enum('read_failed','startup','stale','clock_error')",
                           'retained': 'tinyint(1)', 'digest': 'binary(32)'},
                          {'last_success_at', 'power_w', 'error_code'}, {('id',), ('source', 'publisher_id', 'sequence')}),
    'evse_house_events': ({'id': 'bigint unsigned', 'source': 'varbinary(240)', 'event_id': 'binary(16)',
                          'kind': KINDS, 'received_at': 'datetime(6)', 'retained': 'tinyint(1)',
                          'availability': "enum('online','offline')", 'details': 'varchar(1024)'},
                         {'availability'}, {('id',), ('source', 'event_id')}),
    'evse_house_buckets': (BUCKET_TYPES, {'sum_w', 'min_w', 'max_w', 'first_w', 'last_w', 'first_at', 'last_at'},
                          {('source', 'level', 'bucket_start')}),
    'evse_house_work': ({**KEY, 'generation': 'bigint unsigned', 'processed_generation': 'bigint unsigned',
                        'pending': 'tinyint(1)'}, set(), {('source', 'level', 'bucket_start')}),
}
INDEXES = {'evse_house_samples': ('sample_time', ('source', 'fetched_at', 'id')),
           'evse_house_events': ('event_time', ('source', 'received_at', 'id')),
           'evse_house_work': ('pending_work', ('source', 'pending', 'level', 'bucket_start'))}
MIGRATION = Path(__file__).resolve().parent.parent / 'migrations/003_house.sql'


class HouseDatabase(Database):
    def verify_shape(self, names=None, tables=None):
        super().verify_shape(names=names, tables=TABLES)
        with self.connection.cursor() as c:
            for table in names or TABLES:
                primary = ('version',) if table.endswith('versions') else (
                    ('id',) if table.endswith(('samples', 'events')) else ('source', 'level', 'bucket_start'))
                checks = [('PRIMARY', primary)]
                if table in INDEXES:
                    checks.append(INDEXES[table])
                for name, columns in checks:
                    c.execute('SELECT COLUMN_NAME,SUB_PART FROM information_schema.STATISTICS '
                              'WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s AND INDEX_NAME=%s ORDER BY SEQ_IN_INDEX',
                              (self.config.db_name, table, name))
                    if c.fetchall() != tuple((column, None) for column in columns):
                        raise ValueError('Incompatible HOUSE index')

    def verify(self):
        self.verify_shape()
        with self.connection.cursor() as c:
            c.execute('SELECT version,checksum FROM evse_house_schema_versions ORDER BY version')
            if c.fetchall() != ((1, hashlib.sha256(MIGRATION.read_bytes()).digest()),):
                raise ValueError('Unsupported HOUSE registry')
        self.connection.commit()

        from .minutes import verify
        verify(self, self.config.recording_mode == 'minute')
        self.connection.commit()

    def migrate(self):
        lock = 'evse-house-schema-' + hashlib.sha256(self.config.db_name.encode()).hexdigest()[:40]
        with self.connection.cursor() as c:
            c.execute('SELECT GET_LOCK(%s,10)', (lock,))
            if c.fetchone()[0] != 1:
                raise ValueError('HOUSE migration already running')
            try:
                # Refuse wrong existing shapes BEFORE adding any missing tables.
                c.execute('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=%s',
                          (self.config.db_name,))
                existing = {r[0] for r in c.fetchall()} & TABLES.keys()
                if existing:
                    self.verify_shape(names=existing)
                checksum = hashlib.sha256(MIGRATION.read_bytes()).digest()
                if 'evse_house_schema_versions' in existing:
                    c.execute('SELECT version,checksum FROM evse_house_schema_versions ORDER BY version')
                    versions = c.fetchall()
                    if versions:
                        if versions != ((1, checksum),):
                            raise ValueError('Incompatible HOUSE registry')
                        self.verify()
                        return
                for statement in MIGRATION.read_text().split(';'):
                    if statement.strip():
                        c.execute(statement)
                self.verify_shape()
                c.execute('INSERT INTO evse_house_schema_versions (version,checksum,applied_at) VALUES (1,%s,UTC_TIMESTAMP(6))',
                          (checksum,))
                self.connection.commit()
            finally:
                c.execute('SELECT RELEASE_LOCK(%s)', (lock,))
        self.verify()

    def write(self, item):
        from .house_rollup import dirty_observation
        try:
            with self.connection.cursor() as c:
                if item['kind'] == 'sample':
                    s = item['sample']
                    columns = ('source', 'publisher_id', 'sequence', 'fetched_at', 'received_at', 'status',
                               'last_success_at', 'power_w', 'error_code', 'retained', 'digest')
                    values = {**s, **{k: item[k] for k in ('source', 'received_at', 'retained')}}
                    c.execute('INSERT INTO evse_house_samples (' + ','.join(columns) + ') VALUES (' +
                              ','.join(['%s'] * len(columns)) + ')', [values[k] for k in columns])
                    dirty_observation(c, item['source'], s['fetched_at'])
                else:
                    # Only fixed, generated event details enter storage, never a payload/exception.
                    allowed = {'rejected_deliveries', 'queue_rejected_records', 'missed_samples', 'coverage',
                               'buffer', 'reason', 'measurement_time'}
                    details = json.loads(item['details'])
                    if (not isinstance(details, dict) or not set(details) <= allowed or
                            len(item['details'].encode()) > 1024):
                        raise ValueError('Invalid HOUSE event details')
                    c.execute('INSERT INTO evse_house_events (source,event_id,kind,received_at,retained,availability,details) '
                              'VALUES (%s,%s,%s,%s,%s,%s,%s)',
                              (item['source'], item['id'], item['kind'], item['received_at'], item['retained'],
                               item.get('availability'), item['details']))
                    dirty_observation(c, item['source'], item['received_at'])
            self.connection.commit()
            return True
        except pymysql.IntegrityError as error:
            self.connection.rollback()
            if error.args[0] != 1062:
                raise
            with self.connection.cursor() as c:
                if item['kind'] == 'sample':
                    c.execute('SELECT digest FROM evse_house_samples WHERE source=%s AND publisher_id=%s AND sequence=%s',
                              (item['source'], item['sample']['publisher_id'], item['sample']['sequence']))
                    if c.fetchone() != (item['sample']['digest'],):
                        self.connection.rollback()
                        raise ValueError('Conflicting HOUSE identity') from None
                else:
                    c.execute('SELECT kind,received_at,retained,availability,details FROM evse_house_events '
                              'WHERE source=%s AND event_id=%s',
                              (item['source'], item['id']))
                    expected = (item['kind'], item['received_at'], int(bool(item['retained'])),
                                item.get('availability'), item['details'])
                    if c.fetchone() != expected:
                        self.connection.rollback()
                        raise ValueError('Conflicting HOUSE event identity') from None
            self.connection.commit()
            return False
        except Exception:
            self.connection.rollback()
            raise
