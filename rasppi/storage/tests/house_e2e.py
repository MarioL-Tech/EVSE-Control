"""Docker-only HTTP + Wallbox MQTT -> one default storage runtime -> SQL.

No HOUSE MQTT publisher, synthetic HOUSE inserts, or extra collector process.
Immutable ambiguous-commit/retry identity stays in test_house_integration.
CI stops/starts the actual disposable broker between explicit phases.
"""
from decimal import Decimal
import http.client
import os
import signal
import sys
import time

import paho.mqtt.client as mqtt
import pymysql
from test_integration import payload

PREFIX = 'evse/house-e2e'
WALLBOX = 'evse/wallbox-e2e'
LEVELS = ('minute', 'hour', 'day')
POSITIVE = Decimal('1549.400000')
NEGATIVE = Decimal('-800.500000')


class FixtureFailure(RuntimeError):
    pass


def require(condition, label):
    if not condition:
        raise FixtureFailure(label)


def guard():
    expected = {'HOUSE_E2E_ISOLATED': '1', 'DB_HOST': 'db', 'DB_PORT': '3306',
                'DB_NAME': 'evse_house_e2e', 'DB_USERNAME': 'house_e2e',
                'DB_PASSWORD': 'dummy-only-house-db', 'MQTT_HOST': 'broker',
                'MQTT_PORT': '1883', 'MQTT_USERNAME': 'house_e2e',
                'MQTT_PASSWORD': 'dummy-only-house-mqtt',
                'HOUSE_HISTORY_SOURCE': PREFIX, 'MQTT_TOPIC_PREFIX': WALLBOX,
                'SMARTMETER_URL': 'http://source:8089/dev/powerValue.txt'}
    require(all(os.environ.get(k) == v for k, v in expected.items()), 'Disposable settings required')
    require(not os.environ.get('DB_PASSWORD_FILE') and not os.environ.get('MQTT_PASSWORD_FILE'),
            'External secrets forbidden')


class Harness:
    def __init__(self):
        self.db = pymysql.connect(host='db', database='evse_house_e2e', user='house_e2e',
                                  password='dummy-only-house-db', charset='utf8mb4', autocommit=True,
                                  connect_timeout=2, read_timeout=2, write_timeout=2,
                                  cursorclass=pymysql.cursors.DictCursor)
        self.client = None
        self.query("SET time_zone='+00:00'")

    def query(self, sql, args=()):
        with self.db.cursor() as cursor:
            cursor.execute(sql, args)
            return cursor.fetchall()

    def wait(self, predicate, label, timeout=40):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            result = predicate()
            if result:
                return result
            time.sleep(0.1)
        raise FixtureFailure(label)

    def connect_mqtt(self):
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id='combined-e2e-assertions')
        self.client.username_pw_set('house_e2e', 'dummy-only-house-mqtt')
        self.client.max_queued_messages_set(4)
        self.client.connect('broker', 1883, keepalive=10)
        self.client.loop_start()
        self.wait(self.client.is_connected, 'Fixture MQTT connection deadline')

    def publish(self, topic, body):
        result = self.client.publish(WALLBOX + '/' + topic, body, qos=1, retain=True)
        result.wait_for_publish(timeout=3)
        require(result.is_published(), 'Fixture PUBACK deadline')

    def wallbox_sample(self):
        before = self.query('SELECT COUNT(*) AS n FROM evse_wallbox_samples WHERE source=%s', (WALLBOX,))[0]['n']
        self.publish('state', payload())
        self.wait(lambda: self.query('SELECT COUNT(*) AS n FROM evse_wallbox_samples WHERE source=%s',
                                     (WALLBOX,))[0]['n'] > before, 'Wallbox SQL did not advance')

    def mode(self, mode):
        connection = http.client.HTTPConnection('source', 8089, timeout=2)
        try:
            connection.request('POST', '/mode/' + mode, body=b'')
            response = connection.getresponse()
            require(response.status == 204 and response.read(128) == b'', 'Source mode acknowledgement')
        finally:
            connection.close()

    def latest(self):
        rows = self.query('SELECT * FROM evse_house_samples WHERE source=%s ORDER BY id DESC LIMIT 1', (PREFIX,))
        return rows[0] if rows else None

    def sample(self, mode, power):
        previous = self.latest()
        self.mode(mode)

        def arrived():
            row = self.latest()
            if row and (not previous or row['id'] > previous['id']) and row['power_w'] == power:
                require(row['status'] == ('error' if power is None else 'ok'), 'HOUSE SQL status')
                require(row['error_code'] == ('read_failed' if power is None else None), 'Static error code')
                if power is not None:
                    require(row['last_success_at'] == row['fetched_at'], 'HTTP observation timestamp')
                return row
            return None

        return self.wait(arrived, 'Direct HTTP observation SQL deadline')

    def rollups(self):
        self.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
        try:
            work = self.query('SELECT level,generation,processed_generation,pending FROM evse_house_work '
                              'WHERE source=%s', (PREFIX,))
            if not work or any(r['pending'] or r['generation'] != r['processed_generation'] for r in work):
                return None
            rows = self.query('SELECT * FROM evse_house_buckets WHERE source=%s', (PREFIX,))
            total = self.query('SELECT COUNT(*) AS n FROM evse_house_samples WHERE source=%s', (PREFIX,))[0]['n']
            for bucket in rows:
                raw = self.query('SELECT COUNT(*) AS samples,COUNT(power_w) AS valid_count,'
                                 'SUM(power_w IS NULL) AS null_count,SUM(power_w) AS sum_w,'
                                 'MIN(power_w) AS min_w,MAX(power_w) AS max_w FROM evse_house_samples '
                                 'WHERE source=%s AND fetched_at>=%s AND fetched_at<%s',
                                 (PREFIX, bucket['bucket_start'], bucket['bucket_end']))[0]
                raw['null_count'] = raw['null_count'] or 0
                require(all(bucket[k] == raw[k] for k in raw), 'Raw/rollup exact counts and values')
            result = {}
            for level in LEVELS:
                subset = [r for r in rows if r['level'] == level]
                if not subset or sum(r['samples'] for r in subset) != total:
                    return None
                require(min(r['min_w'] for r in subset if r['min_w'] is not None) == NEGATIVE,
                        'Rollup preserves negative sign')
                require(max(r['max_w'] for r in subset if r['max_w'] is not None) == POSITIVE,
                        'Rollup preserves positive sign')
                require(sum(r['null_count'] for r in subset) > 0, 'HTTP errors remain NULL in rollups')
                require(any(r['has_gap'] for r in subset), 'HTTP error remains a gap')
                result[level] = (sum(r['processed_generation'] for r in work if r['level'] == level), total)
            return result
        finally:
            self.db.commit()

    def main(self):
        self.connect_mqtt()
        self.publish('availability', b'online')
        self.wallbox_sample()
        self.sample('positive', POSITIVE)
        self.sample('negative', NEGATIVE)
        zero = self.sample('zero', Decimal(0))
        failure = self.sample('error', None)
        require(zero['power_w'] == 0 and failure['power_w'] is None, 'Zero distinct from missing')
        # Source remains HTTP503 while independent Wallbox writes advance twice.
        self.wallbox_sample()
        self.wallbox_sample()
        self.sample('positive', POSITIVE)
        before = self.latest()['id']
        self.publish('availability', b'offline')
        self.wait(lambda: self.query("SELECT COUNT(*) AS n FROM evse_ingest_events WHERE source=%s "
                                     "AND kind='availability' AND availability='offline'", (WALLBOX,))[0]['n'],
                  'Wallbox offline boundary persisted')
        self.wait(lambda: self.latest()['id'] > before + 1, 'Wallbox offline blocked HTTP intake')
        self.publish('availability', b'online')
        self.wallbox_sample()
        settled = self.wait(self.rollups, 'Initial three-level rollup deadline')
        for _ in range(2):
            previous = settled

            def progressed():
                current = self.rollups()
                return current if current and all(current[k][0] > previous[k][0]
                                                  and current[k][1] >= previous[k][1] + 2 for k in LEVELS) else None

            settled = self.wait(progressed, 'Continuous HTTP intake starved a rollup level')
        print('Combined runtime: signs/zero/error NULL, independent HTTP failure/offline, live rollups passed')

    def broker_outage(self):
        # CI has stopped the actual broker, not just sent availability=offline.
        probe = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id='outage-probe')
        probe.username_pw_set('house_e2e', 'dummy-only-house-mqtt')
        try:
            probe.connect('broker', 1883, keepalive=5)
        except OSError:
            pass
        else:
            probe.disconnect()
            raise FixtureFailure('Broker must be genuinely unreachable')
        before = self.latest()['id']
        self.sample('negative', NEGATIVE)
        self.sample('positive', POSITIVE)
        self.wait(lambda: self.latest()['id'] >= before + 3, 'Broker outage blocked HTTP SQL')
        print('Real broker outage: direct HOUSE SQL continued')

    def recovery(self):
        self.connect_mqtt()
        self.publish('availability', b'online')
        self.wallbox_sample()
        self.sample('zero', Decimal(0))
        print('Broker recovery: both independent sources persisted')

    def close(self):
        if self.client:
            self.client.disconnect()
            self.client.loop_stop()
        self.db.close()


def expired(*args):
    raise FixtureFailure('Combined E2E global deadline')


if __name__ == '__main__':
    harness = None
    try:
        guard()
        signal.signal(signal.SIGALRM, expired)
        signal.alarm(150)
        phase = sys.argv[1] if len(sys.argv) > 1 else 'main'
        require(phase in ('main', 'broker-outage', 'recovery'), 'Fixed test phase required')
        harness = Harness()
        {'main': harness.main, 'broker-outage': harness.broker_outage, 'recovery': harness.recovery}[phase]()
    except Exception as error:
        print('Combined HOUSE E2E failed: ' + (str(error) if isinstance(error, FixtureFailure)
                                               else 'fixture operation failed'), flush=True)
        raise SystemExit(1) from None
    finally:
        try:
            if harness:
                harness.close()
        except Exception:
            print('Combined HOUSE E2E cleanup failed (diagnostics withheld)', flush=True)
            raise SystemExit(1) from None
        finally:
            signal.alarm(0)
