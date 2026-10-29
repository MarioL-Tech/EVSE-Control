"""Strict HOUSE wire decoder. Decimal storage is rounded once to six places."""
from datetime import datetime
from decimal import Decimal, InvalidOperation, localcontext
import hashlib
import json
import re
import uuid
from .protocol import unique, reject

KEYS = {'schema_version', 'device', 'publisher_id', 'sequence', 'timestamp',
        'status', 'last_success_at', 'power_w', 'error'}
ERRORS = {'read_failed', 'startup', 'stale', 'clock_error'}


def utc(value):
    if not isinstance(value, str) or not re.fullmatch(
            r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z', value):
        raise ValueError('Invalid HOUSE time')
    result = datetime.fromisoformat(value[:-1])
    if not 1970 <= result.year <= 9998:
        raise ValueError('Invalid HOUSE time range')
    return result


def decode(payload):
    if not isinstance(payload, bytes) or not 0 < len(payload) <= 8192:
        raise ValueError('Invalid HOUSE size')
    try:
        d = json.loads(payload.decode('utf-8'), object_pairs_hook=unique,
                       parse_float=Decimal, parse_constant=reject)
        if (not isinstance(d, dict) or set(d) != KEYS or type(d['schema_version']) is not int
                or d['schema_version'] != 1 or d['device'] != 'house_grid'):
            raise ValueError('Invalid HOUSE schema')
        if not isinstance(d['publisher_id'], str):
            raise ValueError('Invalid HOUSE epoch')
        publisher = uuid.UUID(d['publisher_id'])
        if str(publisher) != d['publisher_id'] or publisher.version != 4 or publisher.variant != uuid.RFC_4122:
            raise ValueError('Invalid HOUSE epoch')
        sequence = d['sequence']
        if type(sequence) is not int or not 1 <= sequence <= 4294967295:
            raise ValueError('Invalid HOUSE sequence')
        at = utc(d['timestamp'])
        last = None if d['last_success_at'] is None else utc(d['last_success_at'])
        value = d['power_w']
        if d['status'] == 'ok':
            if type(value) not in (int, Decimal) or last != at or d['error'] is not None:
                raise ValueError('Invalid HOUSE success')
            value = Decimal(value)
            if not value.is_finite() or abs(value) > 9007199254740991:
                raise ValueError('Invalid HOUSE watts')
            with localcontext() as ctx:
                ctx.prec = 40
                value = value.quantize(Decimal('0.000001'))
                # MariaDB DECIMAL has no distinct negative zero. Keep the
                # semantic retry digest identical to the stored value.
                if not value:
                    value = Decimal('0.000000')
        elif d['status'] == 'error':
            if value is not None or d['error'] not in ERRORS or (last is not None and last > at and d['error'] != 'clock_error'):
                raise ValueError('Invalid HOUSE error')
        else:
            raise ValueError('Invalid HOUSE status')
        canonical = [str(publisher), sequence, at.isoformat(), d['status'],
                     last.isoformat() if last else None, str(value) if value is not None else None, d['error']]
        return dict(publisher_id=publisher.bytes, sequence=sequence, fetched_at=at,
                    status=d['status'], last_success_at=last, power_w=value,
                    error_code=d['error'], digest=hashlib.sha256(json.dumps(canonical).encode()).digest())
    except (KeyError, TypeError, UnicodeError, OverflowError, RecursionError, InvalidOperation, AttributeError) as exc:
        raise ValueError('Invalid HOUSE sample') from exc
