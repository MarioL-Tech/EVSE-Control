"""Bounded, validated latest snapshot with fail-closed freshness semantics."""

from copy import deepcopy
from datetime import datetime, timezone
import json
import math
import threading
import time


def utc_timestamp(value):
    if not isinstance(value, str) or len(value) > 40:
        raise ValueError("Invalid timestamp")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.utcoffset() is None or parsed.utcoffset().total_seconds() != 0:
        raise ValueError("Timestamp must be UTC")
    return parsed.timestamp()


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def reject_constant(_):
    raise ValueError("Non-finite JSON number")


def decode_sample(payload):
    if not isinstance(payload, bytes) or len(payload) > 16384:
        raise ValueError("Payload too large")
    data = json.loads(payload.decode("utf-8"), object_pairs_hook=unique_keys, parse_constant=reject_constant)
    if not isinstance(data, dict) or type(data.get("schema_version")) is not int or data["schema_version"] != 1:
        raise ValueError("Unknown schema")
    if data.get("device") != "abb_terra_ac" or data.get("status") not in ("ok", "error"):
        raise ValueError("Unknown device/status")
    utc_timestamp(data["timestamp"])
    if data["last_success_at"] is not None:
        utc_timestamp(data["last_success_at"])
    error = data["error"]
    if error is not None and (not isinstance(error, str) or len(error) > 1024):
        raise ValueError("Invalid error")
    values = data["values"]
    if data["status"] == "error":
        if values is not None or not error:
            raise ValueError("Invalid error sample")
    else:
        if not isinstance(values, dict) or error is not None or data["last_success_at"] != data["timestamp"]:
            raise ValueError("Invalid successful sample")
        clean = {}
        for key in ("error_code", "socket_lock_state", "charging_state_raw", "charging_state",
                    "active_power_w", "session_energy_wh"):
            value = values[key]
            if type(value) is not int or not 0 <= value <= 0xFFFFFFFF:
                raise ValueError("Invalid unsigned measurement")
            clean[key] = value
        for key in ("plugged_in", "charging"):
            value = values[key]
            if value is not None and type(value) is not bool:
                raise ValueError("Invalid boolean")
            clean[key] = value
        if type(values["below_commanded_current"]) is not bool:
            raise ValueError("Invalid current flag")
        clean["below_commanded_current"] = values["below_commanded_current"]
        for key, length in (("current_limit_a", 1), ("current_a", 3), ("voltage_v", 3)):
            value = values[key]
            array = [value] if length == 1 else value
            if not isinstance(array, list) or len(array) != length:
                raise ValueError("Invalid phase array")
            if any(type(item) not in (int, float) or not math.isfinite(item) or item < 0 for item in array):
                raise ValueError("Invalid numeric measurement")
            clean[key] = value
        values = clean
    # Never expose unknown input fields or unbounded payloads in the API.
    return {"timestamp": data["timestamp"], "last_success_at": data["last_success_at"],
            "status": data["status"], "values": values, "error": error}


class StateStore:
    def __init__(self, stale_seconds=10, wall_clock=time.time, monotonic=time.monotonic):
        self.stale_seconds = stale_seconds
        self.wall_clock = wall_clock
        self.monotonic = monotonic
        self.lock = threading.Lock()
        self.connected = False
        self.availability = None
        self.availability_invalid = False
        self.invalid = False
        self.sample = None
        self.received_at = 0
        self.initial_age = 0
        self.future_sample = False

    def connection(self, connected):
        with self.lock:
            self.connected = connected
            # New MQTT session must supply both topics; never reuse old online state.
            self.availability = None
            self.availability_invalid = False
            self.sample = None
            self.invalid = False
            self.future_sample = False

    def accept_availability(self, payload):
        with self.lock:
            self.availability = {b"online": "online", b"offline": "offline"}.get(payload)
            self.availability_invalid = self.availability is None

    def accept_sample(self, payload):
        try:
            sample = decode_sample(payload)
        except (ValueError, KeyError, TypeError, OverflowError, RecursionError):
            with self.lock:
                # Keep timestamp/age identity while hiding values: a later QoS
                # duplicate must not rejuvenate an expired or future snapshot.
                self.invalid = True
            return
        with self.lock:
            # Delayed QoS duplicates must not replace a newer snapshot or reset its age.
            if self.sample and not self.future_sample and utc_timestamp(sample["timestamp"]) < utc_timestamp(self.sample["timestamp"]):
                return
            duplicate_time = self.sample and self.sample["timestamp"] == sample["timestamp"]
            self.sample = sample
            self.invalid = False
            if not duplicate_time:
                self.received_at = self.monotonic()
                wall_age = self.wall_clock() - utc_timestamp(sample["timestamp"])
                self.initial_age = max(0, wall_age)
                self.future_sample = wall_age < -5

    def snapshot(self):
        with self.lock:
            sample = self.sample
            age = None
            clock_error = False
            if sample:
                wall_age = self.wall_clock() - utc_timestamp(sample["timestamp"])
                # A backwards local clock change must not rejuvenate cached data.
                age = max(0, wall_age, self.initial_age + self.monotonic() - self.received_at)
                if wall_age < -5:
                    self.future_sample = True
                clock_error = self.future_sample
            if not self.connected:
                status, reason = "offline", "Keine Verbindung zum MQTT-Broker"
            elif self.invalid or self.availability_invalid:
                status, reason = "invalid", "Ungültige MQTT-Daten – Messwerte ausgeblendet"
            elif sample and sample["status"] == "error":
                status, reason = "read_error", "Wallbox konnte nicht ausgelesen werden"
            elif self.availability == "offline":
                status, reason = "offline", "Wallbox-Reader meldet offline"
            elif clock_error:
                status, reason = "clock_error", "Messzeit liegt in der Zukunft – Uhrzeiten prüfen"
            elif sample and age >= self.stale_seconds:
                status, reason = "stale", "Messdaten veraltet"
            elif self.availability is None or sample is None:
                status, reason = "waiting", "Warte auf Messdaten und Verfügbarkeit"
            else:
                status, reason = "live", "Aktuelle Wallbox-Messdaten"
            live = status == "live"
            return {"schema_version": 1, "read_only": True, "status": status, "reason": reason,
                    "broker_connected": self.connected, "availability": self.availability,
                    "timestamp": sample["timestamp"] if sample else None,
                    "last_success_at": sample["last_success_at"] if sample else None,
                    "age_seconds": round(age, 3) if age is not None else None,
                    "fresh_for_seconds": max(0, self.stale_seconds - age) if live else 0,
                    "values": deepcopy(sample["values"]) if live else None,
                    "error": sample["error"] if sample else None}
