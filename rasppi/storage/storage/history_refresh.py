"""Explicit, bounded requeue of existing wallbox minute materializations only."""
from datetime import datetime
import re

from .history import dirty

PAGE_SIZE = 256
UTC_SECONDS = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z")


def parse_range(history_from, history_to):
    bounds = []
    for text in (history_from, history_to):
        if not isinstance(text, str) or not UTC_SECONDS.fullmatch(text):
            raise ValueError("UTC seconds required")
        at = datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ")
        if not datetime(1970, 1, 1) <= at < datetime(9999, 1, 1):
            raise ValueError("Unsupported history range")
        bounds.append(at)
    start, end = bounds
    # Calendar-year anniversary, not 365 days. Feb 29 clamps to Feb 28 in
    # the following non-leap year, preserving the time of day.
    try:
        anniversary = start.replace(year=start.year + 1)
    except ValueError:
        anniversary = start.replace(year=start.year + 1, day=28)
    if not start < end <= anniversary:
        raise ValueError("History range must be positive and at most one calendar year")
    return start, end


class HistoryRefreshStopped(Exception):
    """Only fully committed pages are included; the active page was rolled back."""
    def __init__(self, count):
        super().__init__("History refresh interrupted")
        self.count = count


def refresh_history(db, history_from, history_to, stop):
    """Queue existing minutes in [from,to); do not rebuild or touch raw/state.

    The ordinary worker reconstructs each minute and dirties its parents.
    Repeating this operation may advance generations but never accumulates
    measurements. Earlier committed pages remain queued after cancellation.
    """
    start, end = parse_range(history_from, history_to)
    connection = db.connection
    count, after = 0, None

    def check_stop():
        if stop.is_set():
            raise HistoryRefreshStopped(count)

    try:
        check_stop()
        with connection.cursor() as c:
            c.execute("SET SESSION max_statement_time=1")
        db.verify()
        if not db.history_enabled:
            raise ValueError("History schema 2 required")
        connection.commit()
        while True:
            check_stop()
            connection.begin()
            with connection.cursor() as c:
                c.execute("SELECT bucket_start FROM evse_history_buckets "
                          "WHERE source=%s AND resolution_seconds=60 "
                          "AND bucket_start>=%s AND bucket_start<%s "
                          + ("AND bucket_start>%s " if after is not None else "")
                          + "ORDER BY bucket_start LIMIT 256",
                          (db.config.prefix, start, end, *((after,) if after is not None else ())))
                rows = c.fetchall()
                check_stop()
                for (at,) in rows:
                    dirty(c, db.config.prefix, at, 60)
                check_stop()
            connection.commit()
            count += len(rows)
            check_stop()
            if len(rows) < PAGE_SIZE:
                return count
            after = rows[-1][0]
    except Exception:
        connection.rollback()
        raise
