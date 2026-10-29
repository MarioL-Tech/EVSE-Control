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


def health(data, history=False):
    path = Path("/tmp/evse-history-health.json" if history else "/tmp/evse-storage-health.json")
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({**data, "tick": time.monotonic()}))
    temporary.replace(path)


def healthcheck(history=False):
    try:
        state = json.loads(Path("/tmp/evse-history-health.json" if history else "/tmp/evse-storage-health.json").read_text())
        ready = 0 <= time.monotonic() - state["tick"] < 30 and state["database_ready"] and (history or state["subscribed"])
        if ready and not history:
            from .house_http import HouseConfig
            if HouseConfig.from_environment().enabled:
                from .house_collector import healthcheck as house_healthcheck
                ready = house_healthcheck() == 0
        return 0 if ready else 1
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


def run_history(config, stop):
    from .history import HistoryWorker
    db = Database(config)
    retry = 1
    while not stop.is_set():
        health({"database_ready": False}, history=True)
        try:
            db.connect()
            worker = HistoryWorker(db)
            worker.acquire()
            while not stop.is_set():
                worker.turn()
                health({"database_ready": True}, history=True)
                retry = 1
                stop.wait(0.25)
        except (ValueError, ArithmeticError, OSError, pymysql.MySQLError):
            diagnostic("storage history: database, schema or materialization unavailable; retrying")
        finally:
            db.close()  # Also releases source GET_LOCK, including failed turns.
            health({"database_ready": False}, history=True)
        stop.wait(retry)
        retry = min(30, retry * 2)


def run_combined(config, stop):
    """Keep HOUSE DB/HTTP waits independent of the Wallbox DB retry loop."""
    from dataclasses import replace
    from .house_http import HouseConfig
    from .house_collector import run as run_house
    house = HouseConfig.from_environment()
    thread = None
    if house.enabled:
        thread = threading.Thread(target=run_house,
            args=(replace(config, prefix=house.source), stop, house),
            name='house-history', daemon=True)
        thread.start()
    try:
        run(config, stop)
    finally:
        stop.set()
        if thread is not None:
            thread.join(timeout=10)
            if thread.is_alive():
                diagnostic('house storage: thread shutdown deadline; in-flight I/O may remain')


def main():
    parser = argparse.ArgumentParser(description="Wallbox MQTT and optional house HTTP storage")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--migrate", action="store_true", help="Explicit schema initialization using DDL account")
    mode.add_argument("--migrate-history", action="store_true", help="Explicit additive schema-2 migration")
    mode.add_argument("--history-worker", action="store_true", help="Separate bounded materialization worker; no MQTT")
    mode.add_argument("--refresh-history", action="store_true", help="Explicitly requeue existing wallbox minute buckets; no raw writes")
    mode.add_argument("--healthcheck", action="store_true")
    mode.add_argument("--history-healthcheck", action="store_true")
    mode.add_argument("--migrate-house", action="store_true", help="Explicit independent HOUSE schema migration")
    parser.add_argument("--history-from", help="Inclusive UTC second, YYYY-MM-DDTHH:MM:SSZ; refresh only")
    parser.add_argument("--history-to", help="Exclusive UTC second, YYYY-MM-DDTHH:MM:SSZ; refresh only")
    args = parser.parse_args()
    if args.refresh_history:
        from .history_refresh import parse_range
        try:
            parse_range(args.history_from, args.history_to)
        except ValueError:
            parser.error("--refresh-history requires valid --history-from/--history-to UTC seconds, at most one calendar year")
    elif args.history_from is not None or args.history_to is not None:
        parser.error("--history-from/--history-to require --refresh-history")
    if args.healthcheck:
        return healthcheck()
    if args.history_healthcheck:
        return healthcheck(history=True)
    try:
        os.set_blocking(2, False)
        if args.migrate_house:
            from .house_collector import configuration
            from .house_database import HouseDatabase
            house_config = configuration()
            database = HouseDatabase(house_config)
            try:
                database.connect()
                database.migrate()
            finally:
                database.close()
            return 0
        config = Config.from_environment()
        if args.migrate or args.migrate_history:
            database = Database(config)
            try:
                database.connect()
                if args.migrate_history:
                    from .history import migrate_history
                    migrate_history(database)
                else:
                    database.migrate()
                database.verify()
                diagnostic(f"storage: schema version {2 if database.history_enabled else 1} ready")
            finally:
                database.close()
            return 0
        stop = threading.Event()
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
        signal.signal(signal.SIGINT, lambda *_: stop.set())
        if args.refresh_history:
            from .history_refresh import HistoryRefreshStopped, refresh_history
            database = Database(config)
            try:
                database.connect()
                try:
                    count = refresh_history(database, args.history_from, args.history_to, stop)
                except HistoryRefreshStopped as interrupted:
                    diagnostic(f"storage history refresh: interrupted; queued={interrupted.count}")
                    return 130
                diagnostic(f"storage history refresh: queued={count}")
                return 0
            finally:
                database.close()
        (run_history if args.history_worker else run_combined)(config, stop)
        return 0
    except (ValueError, ArithmeticError, OSError, pymysql.MySQLError):
        diagnostic("storage: configuration, migration or database error; check local configuration/grants")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
