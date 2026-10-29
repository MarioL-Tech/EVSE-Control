"""HOUSE runtime: shared bounded inbox/MID ownership; dedicated schema and health."""
import json
import os
from pathlib import Path
import queue
import time
import pymysql
from .collector import Inbox, Subscriber, event
from .config import Config
from .house_database import HouseDatabase
from .house_protocol import decode
from .house_rollup import HouseWorker

HEALTH = Path('/tmp/evse-house-health.json')
WORK_INTERVAL = 0.25
WORK_STALE_SECONDS = 30


def configuration(env=None):
    env = dict(os.environ if env is None else env)
    # Never inherit the Wallbox collector's generic topic/client identity.
    # Broker address and credentials deliberately remain shared generic MQTT_*
    # settings, while these two HOUSE names are an independent namespace.
    env['MQTT_TOPIC_PREFIX'] = env.get('HOUSE_MQTT_TOPIC_PREFIX', 'evse/house')
    env['MQTT_CLIENT_ID'] = env.get('HOUSE_STORAGE_CLIENT_ID', 'evse-house-storage')
    return Config.from_environment(env)


def health(ready, subscribed, materialization_ready=False, **stats):
    temporary = HEALTH.with_suffix('.tmp')
    temporary.write_text(json.dumps(dict(tick=time.monotonic(), database_ready=ready,
                                        subscribed=subscribed,
                                        materialization_ready=materialization_ready, **stats)))
    temporary.replace(HEALTH)


def healthcheck():
    try:
        data = json.loads(HEALTH.read_text())
        return 0 if (0 <= time.monotonic() - data['tick'] < 30 and
                     data['database_ready'] and data['subscribed'] and
                     data['materialization_ready']) else 1
    except (OSError, ValueError, KeyError, TypeError):
        return 1


class WorkWatch:
    """Fail health if one level's oldest pending key makes no progress."""
    def __init__(self):
        self.pending = {}

    def update(self, keys, progressed=(), now=None):
        now = time.monotonic() if now is None else now
        progressed = set(progressed)
        updated = {}
        for level, key in keys.items():
            previous = self.pending.get(level)
            since = now if previous is None or previous[0] != key or level in progressed else previous[1]
            updated[level] = (key, since)
        self.pending = updated
        return all(now - since < WORK_STALE_SECONDS for _, since in updated.values())


def run(config, stop):
    from .__main__ import diagnostic
    inbox = Inbox(config.prefix, config.queue_size)
    subscriber = Subscriber(config, inbox, decoder=decode)
    db = HouseDatabase(config)
    worker = HouseWorker(db)
    pending = event(config.prefix, 'collector_started', coverage='unknown before startup', buffer='RAM only')
    stopping = None
    ready, work_ready, retry, mqtt_retry, next_mqtt, last_ping, last_work = False, False, 1, 1, 0, 0, 0
    watch = WorkWatch()
    written = duplicates = 0
    deadline = None
    health(False, False, False)
    try:
        while True:
            if stop.is_set() and deadline is None:
                # Serialize with on_message so no accepted delivery can be
                # timestamped after the persisted stopping boundary.
                with subscriber.lock:
                    subscriber.accepting = False
                deadline = time.monotonic() + 8
                # Keep this local boundary outside a possibly full inbox. It is
                # written after already accepted deliveries and keeps one stable
                # UUID across an ambiguous COMMIT retry.
                stopping = event(config.prefix, 'collector_stopping', coverage='shutdown boundary')
            if deadline is not None and time.monotonic() >= deadline:
                diagnostic('house storage: shutdown deadline; remaining RAM data may be lost')
                break
            if not ready:
                try:
                    db.connect()
                    worker.acquire()  # Own registry only; no Wallbox verification.
                    ready, work_ready, last_ping = True, False, time.monotonic()
                    watch = WorkWatch()
                except (ValueError, OSError, pymysql.MySQLError):
                    db.close()
                    health(False, False, False, **inbox.stats())
                    if deadline is not None:
                        break
                    diagnostic('house storage: database/schema unavailable; intake paused')
                    stop.wait(retry)
                    retry = min(30, retry * 2)
                    continue
            if inbox.pressure.is_set():
                if subscriber.client is not None:
                    subscriber.stop()
                    next_mqtt = time.monotonic() + mqtt_retry
                    mqtt_retry = min(30, mqtt_retry * 2)
                if inbox.queue.qsize() <= config.queue_size // 2:
                    inbox.pressure.clear()
            if pending is None:
                pending = inbox.gap()
            if pending is None:
                try:
                    pending = inbox.queue.get(timeout=0.2)
                except queue.Empty:
                    if stopping is not None:
                        pending, stopping = stopping, None
                    elif deadline is not None:
                        break
            try:
                if pending is not None:
                    if db.write(pending):
                        written += 1
                    else:
                        duplicates += 1
                    subscriber.ack(pending.get('ack'))  # Raw/event AND dirty committed.
                    pending, retry = None, 1
                if deadline is None and time.monotonic() - last_work >= WORK_INTERVAL:
                    progressed = worker.turn()  # Main thread only, never a callback.
                    work_ready = watch.update(worker.pending_keys(), progressed)
                    last_work = time.monotonic()
                if time.monotonic() - last_ping > 5:
                    db.connection.ping(reconnect=False)
                    last_ping = time.monotonic()
            except (OSError, pymysql.MySQLError):
                ready, work_ready = False, False
                db.close()
                subscriber.stop()
                diagnostic('house storage: database operation failed; identity preserved for retry')
                if deadline is None:
                    stop.wait(retry)
                    retry = min(30, retry * 2)
            if subscriber.subscribed:
                mqtt_retry = 1
            if ready and deadline is None and subscriber.client is None and not inbox.pressure.is_set() and time.monotonic() >= next_mqtt:
                try:
                    subscriber.start()
                except (OSError, ValueError):
                    subscriber.stop()
                    next_mqtt = time.monotonic() + mqtt_retry
                    mqtt_retry = min(30, mqtt_retry * 2)
            health(ready, subscriber.subscribed, work_ready,
                   written=written, duplicates=duplicates, **inbox.stats())
    finally:
        with subscriber.lock:
            subscriber.accepting = False
        subscriber.stop()
        db.close()
        health(False, False, False, written=written, duplicates=duplicates, **inbox.stats())
