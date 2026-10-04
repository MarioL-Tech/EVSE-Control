"""Validate schema 1 without applying live-display freshness to historical data."""
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import json
import re

INTEGER_FIELDS = ("error_code", "socket_lock_state", "charging_state_raw", "charging_state",
                  "active_power_w", "session_energy_wh")
MEASUREMENT_COLUMNS = ("error_code", "socket_lock_state", "charging_state_raw", "charging_state",
                       "below_commanded_current", "plugged_in", "charging", "current_limit_a",
                       "current_l1_a", "current_l2_a", "current_l3_a", "voltage_l1_v", "voltage_l2_v",
                       "voltage_l3_v", "active_power_w", "session_energy_wh")


def utc(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)", value):
        raise ValueError("Invalid UTC timestamp")
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.year < 1000:
        raise ValueError("Timestamp outside MariaDB range")
    return result.astimezone(timezone.utc).replace(tzinfo=None)


def timestamp(value):
    return value.isoformat(timespec="microseconds") + "Z"


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def reject(_):
    raise ValueError("Invalid JSON constant")


def measurement(value, scale):
    if type(value) not in (int, Decimal):
        raise ValueError("Invalid measurement")
    value = Decimal(value)
    # These are decoded uint32 device registers, not arbitrary floating data.
    if not value.is_finite() or value < 0 or value > Decimal(0xFFFFFFFF) / scale:
        raise ValueError("Measurement outside register range")
    if value != value.quantize(Decimal(1) / scale):
        raise ValueError("Invalid register precision")
    return Decimal(0) if value == 0 else value


def decode(payload):
    if not isinstance(payload, bytes) or not 0 < len(payload) <= 16384:
        raise ValueError("Invalid payload size")
    try:
        data = json.loads(payload.decode("utf-8"), object_pairs_hook=unique, parse_float=Decimal, parse_constant=reject)
        if not isinstance(data, dict) or type(data.get("schema_version")) is not int or data["schema_version"] != 1:
            raise ValueError("Unknown schema")
        if data["device"] != "abb_terra_ac" or data["status"] not in ("ok", "error"):
            raise ValueError("Unknown device/status")
        measured = utc(data["timestamp"])
        last = utc(data["last_success_at"]) if data["last_success_at"] is not None else None
        error = data["error"]
        if error is not None and (not isinstance(error, str) or not 0 < len(error) <= 1024):
            raise ValueError("Invalid error")
        values = data["values"]
        clean, columns = None, [None] * len(MEASUREMENT_COLUMNS)
        if data["status"] == "error":
            if values is not None or not error:
                raise ValueError("Invalid error sample")
        else:
            if not isinstance(values, dict) or error is not None or last != measured:
                raise ValueError("Invalid successful sample")
            clean = {}
            for key in INTEGER_FIELDS:
                val = values[key]
                if type(val) is not int or not 0 <= val <= 0xFFFFFFFF:
                    raise ValueError("Invalid uint32")
                clean[key] = val
            for key in ("plugged_in", "charging"):
                if values[key] is not None and type(values[key]) is not bool:
                    raise ValueError("Invalid boolean")
                clean[key] = values[key]
            if type(values["below_commanded_current"]) is not bool:
                raise ValueError("Invalid reduction flag")
            clean["below_commanded_current"] = values["below_commanded_current"]
            limit = measurement(values["current_limit_a"], 1000)
            arrays = {}
            for key, scale in (("current_a", 1000), ("voltage_v", 10)):
                if not isinstance(values[key], list) or len(values[key]) != 3:
                    raise ValueError("Invalid phase array")
                arrays[key] = [measurement(val, scale) for val in values[key]]
                clean[key] = [float(val) for val in arrays[key]]
            clean["current_limit_a"] = float(limit)
            flat = {**clean, "current_limit_a": limit}
            for phase in range(3):
                flat[f"current_l{phase + 1}_a"] = arrays["current_a"][phase]
                flat[f"voltage_l{phase + 1}_v"] = arrays["voltage_v"][phase]
            columns = [flat[key] for key in MEASUREMENT_COLUMNS]
        canonical = json.dumps({"schema_version": 1, "device": "abb_terra_ac", "timestamp": timestamp(measured),
                                "last_success_at": timestamp(last) if last else None, "status": data["status"],
                                "values": clean, "error": error}, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        return {"measured_at": measured, "last_success_at": last, "status": data["status"], "error": error,
                "columns": columns, "payload": canonical, "hash": hashlib.sha256(canonical.encode()).digest()}
    except (KeyError, TypeError, UnicodeError, OverflowError, RecursionError, InvalidOperation) as exc:
        raise ValueError("Invalid schema 1 sample") from exc
