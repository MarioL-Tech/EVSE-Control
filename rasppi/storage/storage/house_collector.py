"""Independent HTTP intake and materialization, in one storage background thread."""
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import time
import uuid
import pymysql
from .collector import event
from .config import Config
from .house_database import HouseDatabase
from .house_http import HouseConfig, fetch
from .house_protocol import decode
from .house_rollup import HouseWorker

HEALTH = Path('/tmp/evse-house-health.json')
WORK_INTERVAL = 0.25
WORK_STALE_SECONDS = 30


def configuration(env=None):
    return replace(Config.from_environment(env), prefix=HouseConfig.from_environment(env).source)


def health(ready, alive, materialization_ready=False, **stats):
    temporary = HEALTH.with_suffix('.tmp')
    temporary.write_text(json.dumps(dict(tick=time.monotonic(), database_ready=ready,
                                        alive=alive,
                                        materialization_ready=materialization_ready, **stats)))
    temporary.replace(HEALTH)


def healthcheck():
    try:
        data = json.loads(HEALTH.read_text())
        return 0 if (0 <= time.monotonic() - data['tick'] < 30 and
                     data['database_ready'] and data['alive'] and
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


def utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Observations:
    """One UUID epoch, u32 sequence and high-water clock per actual HTTP attempt."""
    def __init__(self):
        self.publisher = str(uuid.uuid4())
        self.sequence = 0
        self.latest = self.last_success = None

    def attempt(self, config):
        try:
            value, error = fetch(config), None
        except (OSError, ValueError):
            value, error = None, 'read_failed'
        at = utcnow()
        if self.latest is not None and at <= self.latest:
            value, error = None, 'clock_error'
        self.latest = max(at, self.latest) if self.latest is not None else at
        if error is None:
            self.last_success = at
        if self.sequence == 4294967295:
            self.publisher, self.sequence = str(uuid.uuid4()), 0
        self.sequence += 1
        stamp = lambda t: None if t is None else t.isoformat(timespec='microseconds') + 'Z'
        sample = decode(json.dumps(dict(schema_version=1, device='house_grid',
            publisher_id=self.publisher, sequence=self.sequence, timestamp=stamp(at),
            status='error' if error else 'ok', last_success_at=stamp(self.last_success),
            power_w=value, error=error), allow_nan=False).encode())
        return dict(kind='sample', sample=sample, source=config.source,
                    received_at=at, retained=False)


def run(config, stop, http_config=None):
    from .__main__ import diagnostic
    http_config = http_config or HouseConfig.from_environment()
    if not http_config.enabled:
        return
    db = HouseDatabase(config)
    from .retention import Policy, cleanup
    policy = Policy(os.environ)
    last_cleanup = time.monotonic()
    retention_ready = True
    from .minutes import Recorder, IntakeRejected
    recorder = Recorder(db, 'house') if config.recording_mode == 'minute' else None
    worker = HouseWorker(db)
    observations = Observations()
    pending = event(config.prefix, 'collector_started', coverage='unknown before startup', buffer='RAM only')
    last_event = pending['received_at']
    ready = work_ready = False
    retry, next_poll, last_work = 1, 0, 0
    written = duplicates = 0
    admitted = 0
    watch = WorkWatch()
    availability = None
    stopping = False
    deadline = None
    health(False, True)
    try:
        while True:
            if stop.is_set() and deadline is None:
                deadline = time.monotonic() + 8
            if deadline is not None and time.monotonic() >= deadline:
                diagnostic('house storage: shutdown deadline; remaining RAM data may be lost')
                break
            if pending is None and deadline is not None:
                if stopping:
                    if not recorder or not recorder.accumulator or not recorder.accumulator.open:
                        break
                else:
                    pending = event(config.prefix, 'collector_stopping', coverage='shutdown boundary')
                    pending['received_at'] = max(pending['received_at'], last_event + timedelta(microseconds=1))
                    stopping = True
            try:
                if not ready:
                    db.connect()
                    worker.acquire()  # HOUSE registry only, and exclusive source lock.
                    if recorder:
                        recorder.acquire()
                    ready, work_ready = True, False
                    watch = WorkWatch()
                if recorder:
                    if recorder.flush(shutdown=deadline is not None):
                        written += 1
                if pending is None and deadline is None and time.monotonic() >= next_poll:
                    pending = observations.attempt(http_config)
                    # Schedule from completion, never replay missed intervals.
                    next_poll = time.monotonic() + http_config.poll_seconds
                if pending is not None:
                    item = pending
                    at = item['sample']['fetched_at'] if item['kind'] == 'sample' else item['received_at']
                    if not policy.accepts(at):
                        pending = None
                        continue
                    if (recorder.write(item) if recorder else db.write(item)):
                        if recorder and item['kind'] == 'sample':
                            admitted += 1
                        else:
                            written += 1
                    else:
                        duplicates += 1
                    pending, retry = None, 1
                    if item['kind'] == 'sample':
                        state = 'online' if item['sample']['status'] == 'ok' else 'offline'
                        if state != availability:
                            # Persist this after the sample, before any new poll.
                            # Its stable UUID survives an ambiguous COMMIT as well.
                            pending = event(config.prefix, 'availability')
                            pending['availability'] = state
                            pending['received_at'] = max(pending['received_at'], last_event + timedelta(microseconds=1))
                            last_event = pending['received_at']
                            availability = state
                if deadline is None and time.monotonic() - last_work >= WORK_INTERVAL:
                    progressed = worker.turn()
                    work_ready = watch.update(worker.pending_keys(), progressed)
                    last_work = time.monotonic()
                if deadline is None and pending is None and time.monotonic() - last_cleanup >= 30:
                    last_cleanup = time.monotonic()
                    try:
                        cleanup(db, 'house', policy)
                        retention_ready = True
                    except (ValueError, OSError, pymysql.MySQLError):
                        diagnostic('house retention: bounded cleanup unavailable; no success assumed')
                        retention_ready = False
                health(True, True, work_ready, written=written, duplicates=duplicates, admitted_ram=admitted, retention_ready=retention_ready)
            except IntakeRejected:
                pending = event(config.prefix, 'ingestion_gap', missed_samples='unknown', reason='minute admission pressure')
            except (ValueError, ArithmeticError, OSError, pymysql.MySQLError):
                ready = work_ready = False
                db.close()
                health(False, True, False, written=written, duplicates=duplicates)
                diagnostic('house storage: database/schema/materialization unavailable; identity preserved')
                if deadline is not None:
                    time.sleep(min(0.1, max(0, deadline - time.monotonic())))
                else:
                    stop.wait(retry)
                    retry = min(30, retry * 2)
                continue
            if pending is None and deadline is None:
                stop.wait(min(WORK_INTERVAL, max(0, next_poll - time.monotonic())))
    finally:
        db.close()
        health(False, False, False, written=written, duplicates=duplicates)
