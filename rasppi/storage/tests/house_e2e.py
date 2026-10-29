"""Docker-only real PHP publisher -> authenticated broker -> HOUSE collector -> SQL.

Not named test_*.py: unittest discovery must never run this without its Compose
fixture. No synthetic MQTT observations or direct SQL writes are made here;
only an exact, already observed PHP payload is replayed for deduplication.
"""
from collections import deque
from datetime import datetime, timezone
from decimal import Decimal
import http.client
import json
import os
import signal
import threading
import time
import uuid

import paho.mqtt.client as mqtt
import pymysql


PREFIX = 'evse/house-e2e'
TOPIC = PREFIX + '/state'
LEVELS = ('minute', 'hour', 'day')
POSITIVE = Decimal('1549.400000')
NEGATIVE = Decimal('-800.500000')


class FixtureFailure(RuntimeError):
    """Only fixed, non-sensitive test labels may be exposed to CI logs."""


def require(condition, message):
    if not condition:
        raise FixtureFailure(message)


def guard():
    expected = {
        'HOUSE_E2E_ISOLATED': '1', 'DB_HOST': 'db', 'DB_PORT': '3306',
        'DB_NAME': 'evse_house_e2e', 'DB_USERNAME': 'house_e2e',
        'DB_PASSWORD': 'dummy-only-house-db', 'MQTT_HOST': 'broker',
        'MQTT_PORT': '1883', 'MQTT_USERNAME': 'house_e2e',
        'MQTT_PASSWORD': 'dummy-only-house-mqtt',
        'HOUSE_MQTT_TOPIC_PREFIX': PREFIX,
        'HOUSE_STORAGE_CLIENT_ID': 'evse-house-e2e-storage',
    }
    require(all(os.environ.get(key) == value for key, value in expected.items()),
            'Disposable HOUSE E2E settings required')
    require(not os.environ.get('DB_PASSWORD_FILE') and not os.environ.get('MQTT_PASSWORD_FILE'),
            'External secret files are forbidden in this fixture')


def timestamp(text):
    require(isinstance(text, str) and text.endswith('Z'), 'UTC observation required')
    return datetime.fromisoformat(text[:-1] + '+00:00').replace(tzinfo=None)


class Harness:
    def __init__(self):
        self.deadline = time.monotonic() + 80
        self.messages = deque(maxlen=512)
        self.lock = threading.Lock()
        self.subscribed = threading.Event()
        self.invalid = False
        self.db = None
        self.client = None

    def wait(self, predicate, label, timeout=15):
        end = min(self.deadline, time.monotonic() + timeout)
        while time.monotonic() < end:
            require(not self.invalid, 'Invalid observer delivery')
            result = predicate()
            if result:
                return result
            time.sleep(0.1)
        raise FixtureFailure(label)

    def connect(self):
        self.db = pymysql.connect(host='db', port=3306, database='evse_house_e2e',
                                  user='house_e2e', password='dummy-only-house-db',
                                  charset='utf8mb4', autocommit=True,
                                  connect_timeout=2, read_timeout=2, write_timeout=2,
                                  cursorclass=pymysql.cursors.DictCursor)
        self.query("SET time_zone='+00:00'")
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
                                  client_id='evse-house-e2e-assertions',
                                  clean_session=True, protocol=mqtt.MQTTv311)
        self.client.username_pw_set('house_e2e', 'dummy-only-house-mqtt')
        self.client.max_inflight_messages_set(2)
        self.client.max_queued_messages_set(4)
        self.client.on_connect = self.on_connect
        self.client.on_subscribe = self.on_subscribe
        self.client.on_message = self.on_message
        self.client.connect('broker', 1883, keepalive=10)
        self.client.loop_start()
        self.wait(self.subscribed.is_set, 'Observer SUBACK deadline')

    def on_connect(self, client, userdata, flags, reason, properties):
        if reason.is_failure:
            self.invalid = True
        else:
            client.subscribe(TOPIC, qos=1)

    def on_subscribe(self, client, userdata, mid, reasons, properties):
        if len(reasons) != 1 or reasons[0].value != 1:
            self.invalid = True
        else:
            self.subscribed.set()

    def on_message(self, client, userdata, message):
        try:
            require(message.topic == TOPIC and message.qos == 1, 'Real QoS-1 state required')
            require(len(message.payload) <= 8192, 'Bounded HOUSE payload required')
            document = json.loads(message.payload, parse_float=Decimal)
            require(set(document) == {'schema_version', 'device', 'publisher_id', 'sequence', 'timestamp',
                                      'status', 'last_success_at', 'power_w', 'error'}, 'Wire contract')
            require(document['schema_version'] == 1 and document['device'] == 'house_grid', 'HOUSE wire identity')
            publisher = uuid.UUID(document['publisher_id'])
            require(publisher.version == 4 and str(publisher) == document['publisher_id'], 'UUID-4 wire identity')
            require(type(document['sequence']) is int and 1 <= document['sequence'] <= 4294967295,
                    'Bounded wire sequence')
            timestamp(document['timestamp'])
            with self.lock:
                self.messages.append({'wire': bytes(message.payload), 'document': document,
                                      'retained': message.retain, 'observed_at': time.monotonic()})
        except Exception:
            self.invalid = True

    def captured(self):
        with self.lock:
            return list(self.messages)

    def query(self, statement, args=()):
        with self.db.cursor() as cursor:
            cursor.execute(statement, args)
            return cursor.fetchall()

    def mode(self, mode):
        require(mode in ('positive', 'negative', 'zero', 'error'), 'Fixed fixture mode required')
        connection = http.client.HTTPConnection('source', 8089, timeout=2)
        try:
            connection.request('POST', '/mode/' + mode, body=b'')
            response = connection.getresponse()
            require(response.status == 204 and response.read(128) == b'', 'Source mode acknowledgement')
        finally:
            connection.close()

    def sample(self, power, error=False):
        after = time.monotonic()
        self.mode('error' if error else 'zero' if power == 0 else 'negative' if power < 0 else 'positive')

        def received():
            for item in self.captured():
                doc = item['document']
                if item['retained'] or item['observed_at'] <= after:
                    continue
                if error:
                    matches = doc['status'] == 'error' and doc['error'] == 'read_failed' and doc['power_w'] is None
                else:
                    matches = (doc['status'] == 'ok' and doc['power_w'] == power and doc['error'] is None
                               and doc['last_success_at'] == doc['timestamp'])
                if matches:
                    return item
            return None

        item = self.wait(received, 'Live PHP observation deadline')
        self.wait(lambda: self.identity(item), 'Collector SQL commit deadline')
        return item

    def identity(self, item):
        doc = item['document']
        rows = self.query('SELECT id,publisher_id,sequence,fetched_at,received_at,status,last_success_at,'
                          'power_w,error_code,retained,digest FROM evse_house_samples '
                          'WHERE source=%s AND publisher_id=%s AND sequence=%s',
                          (PREFIX, uuid.UUID(doc['publisher_id']).bytes, doc['sequence']))
        if not rows:
            return None
        require(len(rows) == 1, 'Exactly one SQL identity required')
        row = rows[0]
        require(row['fetched_at'] == timestamp(doc['timestamp']) and row['status'] == doc['status']
                and row['power_w'] == doc['power_w'] and row['error_code'] == doc['error'],
                'Real wire values must survive SQL unchanged')
        expected_success = timestamp(doc['last_success_at']) if doc['last_success_at'] else None
        require(row['last_success_at'] == expected_success, 'Last success must survive SQL unchanged')
        return row

    def rollups(self, reference):
        """One read-only snapshot: compare settled materializations to actual raw.

        The publisher stays at 1 Hz throughout. A snapshot may briefly have dirty
        work; retry instead of comparing new raw rows to an older generation.
        Counts/sums prove replay did not inflate aggregate materialization.
        """
        self.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
        try:
            work = self.query('SELECT level,bucket_start,generation,processed_generation,pending '
                              'FROM evse_house_work WHERE source=%s ORDER BY level,bucket_start', (PREFIX,))
            if not work or any(row['pending'] or row['generation'] != row['processed_generation'] for row in work):
                return None
            rows = self.query('SELECT level,bucket_start,bucket_end,samples,valid_count,null_count,'
                              'sum_w,min_w,max_w,has_gap FROM evse_house_buckets WHERE source=%s', (PREFIX,))
            for bucket in rows:
                raw = self.query('SELECT COUNT(*) AS samples,COUNT(power_w) AS valid_count,'
                                 'SUM(power_w IS NULL) AS null_count,SUM(power_w) AS sum_w,'
                                 'MIN(power_w) AS min_w,MAX(power_w) AS max_w FROM evse_house_samples '
                                 'WHERE source=%s AND fetched_at>=%s AND fetched_at<%s',
                                 (PREFIX, bucket['bucket_start'], bucket['bucket_end']))[0]
                # SQL SUM over an empty interval is NULL; bucket counts are 0.
                raw['null_count'] = raw['null_count'] or 0
                require(all(bucket[key] == raw[key] for key in raw), 'Raw/rollup counts and values must agree exactly')
            total = self.query('SELECT COUNT(*) AS n FROM evse_house_samples WHERE source=%s', (PREFIX,))[0]['n']
            matched = {}
            for level in LEVELS:
                candidates = [row for row in rows if row['level'] == level
                              and row['bucket_start'] <= reference < row['bucket_end']]
                if len(candidates) != 1:
                    return None
                bucket = candidates[0]
                if bucket['min_w'] != NEGATIVE or bucket['max_w'] != POSITIVE or bucket['null_count'] < 1:
                    return None
                require(bucket['has_gap'] == 1, 'HTTP failure remains a materialized gap')
                count = sum(row['samples'] for row in rows if row['level'] == level)
                require(count == total, 'Every raw observation must appear exactly once per rollup level')
                # Sum across keys so a real minute/hour/day boundary is not
                # mistaken for starvation when the active bucket changes.
                generation = sum(row['processed_generation'] for row in work if row['level'] == level)
                matched[level] = (generation, count)
            return matched
        finally:
            self.db.commit()

    def run(self):
        self.connect()
        # Avoid straddling a minute between the signed/zero/error mode switches.
        # At worst wait 25 s; all observations still originate at real HTTP polls.
        self.wait(lambda: datetime.now(timezone.utc).second < 35, 'Minute alignment deadline', timeout=27)
        positive = self.sample(POSITIVE)
        negative = self.sample(NEGATIVE)
        zero = self.sample(Decimal(0))
        offline_before = self.query("SELECT COUNT(*) AS n FROM evse_house_events WHERE source=%s "
                                    "AND kind='availability' AND availability='offline'", (PREFIX,))[0]['n']
        failure = self.sample(None, error=True)
        self.wait(lambda: self.query("SELECT COUNT(*) AS n FROM evse_house_events WHERE source=%s "
                                     "AND kind='availability' AND availability='offline'", (PREFIX,))[0]['n'] > offline_before,
                  'Error availability SQL deadline')
        recovered = self.sample(POSITIVE)
        require(self.identity(zero)['power_w'] == 0 and self.identity(failure)['power_w'] is None,
                'Zero and failure NULL must remain distinct')
        require(self.identity(positive)['power_w'] > 0 and self.identity(negative)['power_w'] < 0,
                'Both real power signs required')
        reference = timestamp(negative['document']['timestamp'])
        settled = self.wait(lambda: self.rollups(reference), 'All three rollup levels deadline')

        original = self.identity(recovered)
        # Replay byte-for-byte the real PHP UUID/sequence/payload, not a freshly
        # generated observation. Retain=false must not rewrite first metadata.
        before = len([item for item in self.captured() if item['wire'] == recovered['wire']])
        publication = self.client.publish(TOPIC, recovered['wire'], qos=1, retain=False)
        require(publication.rc == mqtt.MQTT_ERR_SUCCESS, 'Replay enqueue failed')
        publication.wait_for_publish(timeout=3)
        require(publication.is_published(), 'Replay PUBACK deadline')
        self.wait(lambda: len([item for item in self.captured() if item['wire'] == recovered['wire']]) > before,
                  'Replay observer deadline')
        # A subsequent genuine source poll is ordered after the replay on the
        # collector subscription. Its SQL commit proves intake reached the replay.
        later = self.sample(POSITIVE)
        require(later['document']['publisher_id'] == recovered['document']['publisher_id']
                and later['document']['sequence'] > recovered['document']['sequence'], 'New real observation required')
        require(self.identity(recovered) == original, 'Replay changed original SQL identity/received_at')

        # Catch up repeatedly without stopping/pausing the 1 Hz PHP publisher.
        # All levels must advance, and every settled count/sum must equal raw SQL.
        for _ in range(2):
            previous = settled

            def progressed():
                current = self.rollups(reference)
                return current if current and all(current[level][0] > previous[level][0]
                                                  and current[level][1] >= previous[level][1] + 2
                                                  for level in LEVELS) else None

            settled = self.wait(progressed, 'Continuous intake must not starve a rollup level')
        require(self.identity(recovered) == original, 'Duplicate metadata must remain immutable')
        require(not self.invalid, 'Observer validation failed')
        print('HOUSE PHP -> MQTT -> Python -> SQL E2E passed: signs, zero, error NULL, QoS1, dedupe, three live rollup levels')

    def close(self):
        if self.client is not None:
            self.client.disconnect()
            self.client.loop_stop()
        if self.db is not None:
            self.db.close()


def deadline(signum, frame):
    raise FixtureFailure('HOUSE E2E global deadline')


if __name__ == '__main__':
    harness = None
    try:
        guard()  # Before opening any DB, MQTT or HTTP connection.
        signal.signal(signal.SIGALRM, deadline)
        signal.alarm(90)
        harness = Harness()
        harness.run()
    except Exception as error:
        # Only our fixed assertion labels may be printed, never a driver/HTTP
        # exception, raw payload, target address, SQL text, or credential.
        label = str(error) if isinstance(error, FixtureFailure) else 'fixture operation failed'
        print('HOUSE E2E failed: ' + label, flush=True)
        raise SystemExit(1) from None
    finally:
        try:
            if harness is not None:
                harness.close()
        except Exception:
            print('HOUSE E2E cleanup failed (diagnostics withheld)', flush=True)
            raise SystemExit(1) from None
        finally:
            signal.alarm(0)
