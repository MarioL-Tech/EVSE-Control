import argparse
import json
import os
from pathlib import Path
import queue
import signal
import threading
import time
import pymysql
from .collector import Inbox, Subscriber, event
from .config import Config
from .database import Database


def diagnostic(text):
    # Full Docker log pipes must not stall intake/shutdown; no payloads/secrets.
    try:
        os.write(2, (text + "\n").encode()[:1024])
    except (OSError, BlockingIOError):
        pass


def health(data):
    path = Path("/tmp/evse-storage-health.json")
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({**data, "tick": time.monotonic()}))
    temporary.replace(path)


def healthcheck():
    try:
        state = json.loads(Path("/tmp/evse-storage-health.json").read_text())
        return 0 if 0 <= time.monotonic() - state["tick"] < 30 and state["database_ready"] and state["subscribed"] else 1
    except (OSError, ValueError, KeyError, TypeError):
        return 1


def run(config, stop):
    inbox = Inbox(config.prefix, config.queue_size)
    subscriber, db = Subscriber(config, inbox), Database(config)
    pending = event(config.prefix, "collector_started", coverage="unknown before startup", buffer="RAM only")
    ready, written, duplicates, retry, last_log, last_ping = False, 0, 0, 1, 0, 0
    next_mqtt_start, mqtt_retry = 0, 1
    deadline = None
    health({"database_ready": False, "subscribed": False, "written": 0, "duplicates": 0, **inbox.stats()})
    try:
        while True:
            if stop.is_set() and deadline is None:
                subscriber.accepting = False
                deadline = time.monotonic() + 8
                inbox.put(event(config.prefix, "collector_stopping", coverage="shutdown boundary"))
            if deadline is not None and time.monotonic() >= deadline:
                diagnostic("storage: shutdown deadline; remaining RAM data may be lost")
                break
            if not ready:
                try:
                    db.connect()
                    db.verify()
                    ready, last_ping = True, time.monotonic()
                except (pymysql.MySQLError, OSError, ValueError):
                    db.close()
                    health({"database_ready": False, "subscribed": False, "written": written, "duplicates": duplicates, **inbox.stats()})
                    if deadline is not None:
                        break
                    if time.monotonic() - last_log > 30:
                        diagnostic("storage: database unavailable or schema not initialized; intake paused")
                        last_log = time.monotonic()
                    stop.wait(retry)
                    retry = min(30, retry * 2)
                    continue
            # Reconnect only with available database and after pressure drains.
            if inbox.pressure.is_set():
                if subscriber.client is not None:
                    subscriber.stop()
                    next_mqtt_start = time.monotonic() + mqtt_retry
                    mqtt_retry = min(30, mqtt_retry * 2)
                if inbox.queue.qsize() <= config.queue_size // 2:
                    inbox.pressure.clear()
            if pending is None:
                pending = inbox.gap()
            if pending is None:
                try:
                    pending = inbox.queue.get(timeout=0.2)
                except queue.Empty:
                    if deadline is not None:
                        break
            if pending is not None:
                try:
                    if db.write(pending):
                        written += 1
                    else:
                        duplicates += 1
                    subscriber.ack(pending.get("ack"))
                    pending, retry = None, 1
                except (pymysql.MySQLError, OSError):
                    # Unknown COMMIT outcome: retry identical hash/UUID, not a
                    # fresh event. Pause MQTT so broker backlog cannot grow.
                    ready = False
                    db.close()
                    subscriber.stop()
                    diagnostic("storage: database write failed; same identity will be retried")
                    if deadline is None:
                        stop.wait(retry)
                        retry = min(30, retry * 2)
                    else:
                        time.sleep(0.1)
            if ready and time.monotonic() - last_ping > 5:
                try:
                    db.connection.ping(reconnect=False)
                    last_ping = time.monotonic()
                except (pymysql.MySQLError, OSError):
                    ready = False
                    db.close()
                    subscriber.stop()
            if subscriber.subscribed:
                mqtt_retry = 1
            if ready and deadline is None and subscriber.client is None and not inbox.pressure.is_set() and time.monotonic() >= next_mqtt_start:
                subscriber.start()
            health({"database_ready": ready, "subscribed": subscriber.subscribed, "written": written,
                    "duplicates": duplicates, **inbox.stats()})
            if time.monotonic() - last_log > 30:
                diagnostic(f"storage: written={written} duplicates={duplicates} queue={inbox.queue.qsize()} invalid={inbox.invalid} dropped={inbox.dropped}")
                last_log = time.monotonic()
    finally:
        subscriber.accepting = False
        subscriber.stop()
        db.close()
        health({"database_ready": False, "subscribed": False, "written": written, "duplicates": duplicates, **inbox.stats()})


def main():
    parser = argparse.ArgumentParser(description="Subscribe-only wallbox history collector")
    parser.add_argument("--migrate", action="store_true", help="Explicit schema initialization using DDL account")
    parser.add_argument("--healthcheck", action="store_true")
    args = parser.parse_args()
    if args.healthcheck:
        return healthcheck()
    try:
        os.set_blocking(2, False)
        config = Config.from_environment()
        if args.migrate:
            database = Database(config)
            try:
                database.connect()
                database.migrate()
                database.verify()
                diagnostic("storage: schema version 1 ready")
            finally:
                database.close()
            return 0
        stop = threading.Event()
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
        signal.signal(signal.SIGINT, lambda *_: stop.set())
        run(config, stop)
        return 0
    except (ValueError, OSError, pymysql.MySQLError):
        diagnostic("storage: configuration, migration or database error; check local configuration/grants")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
