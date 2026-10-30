"""Opt-in UART owner. No hardware writes outside the ESP32 gateway protocol.

Callbacks only admit bounded work; the owner alone touches serial. Never log
exceptions/payloads: old firmware may report a UID in an unsolicited line.
"""
import hashlib
import importlib.metadata
import json
import math
import os
import queue
import re
import secrets
import signal
import threading
import time
from datetime import datetime

import paho.mqtt.client as mqtt
import serial

HEX = r"[0-9a-f]{32}"
ID = re.compile(HEX + r"\Z")
UID = re.compile(r"[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){3}(?:(?::[0-9A-Fa-f]{2}){3})?(?:(?::[0-9A-Fa-f]{2}){3})?\Z")
OPS = {"inspect", "lock", "unlock", "enroll", "cancel", "revoke"}
CODES = frozenset("OK NOT_READY STORAGE_ERROR INVALID_UID INVALID_ARGUMENT FULL "
                  "ALREADY_ALLOWED ENROLL_STARTED ENROLL_ACTIVE ENROLL_CANCELLED "
                  "ENROLL_INACTIVE ENROLL_EXPIRED ENROLLED REVOKED NOT_FOUND DENIED "
                  "DEBOUNCED LOCKED UNLOCKED MODE_CHANGED INVALID_SESSION "
                  "INVALID_LEASE BUSY DUPLICATE_MISMATCH SESSION_MISMATCH GATEWAY_UNAVAILABLE".split())
EMPTY = dict.fromkeys(("charging", "antitheft", "store_ready", "cards", "enrolling",
                       "reader_ready", "servo_ready"))


class CappedClient(mqtt.Client):
    """Paho 2.1.0 framing, with a guard BEFORE its body recv/bytearray growth.

    Upstream _packet_read decodes remaining_length one byte at a time, sets
    have_remaining, then calls _sock_recv(to_process) before appending packet.
    Do not silently support another implementation of these private internals.
    """
    def __init__(self, *args, **kwargs):
        if importlib.metadata.version("paho-mqtt") != "2.1.0":
            raise RuntimeError("unsupported MQTT library")
        super().__init__(*args, **kwargs)
        expected = {"command", "have_remaining", "remaining_count", "remaining_mult",
                    "remaining_length", "packet", "to_process", "pos"}
        if set(self._in_packet) != expected:
            raise RuntimeError("unsupported MQTT framing")

    def _sock_recv(self, bufsize):
        packet = self._in_packet
        if (type(packet.get("remaining_length")) is not int or
                packet["remaining_length"] > 32768 or
                (packet.get("have_remaining") == 1 and bufsize > 32768) or
                (packet.get("command", 0) & 0xf0 == 0x30 and
                 packet["command"] & 6 != 0)):
            raise ConnectionError("MQTT packet limit")
        return super()._sock_recv(bufsize)


def request(payload):
    if not isinstance(payload, bytes) or len(payload) > 192:
        raise ValueError("invalid request")
    text = payload.decode("ascii")
    fields = text.split("|")
    if len(fields) != 6:
        raise ValueError("invalid request")
    version, rid, session, lease, op, uid = fields
    if (version != "v1" or not ID.fullmatch(rid) or op not in OPS or
            (op == "inspect" and (session != "-" or lease != "-")) or
            (op != "inspect" and (not ID.fullmatch(session) or not ID.fullmatch(lease))) or
            (op != "revoke" and uid != "-") or
            (op == "revoke" and (len(uid) not in (11, 20, 29) or not UID.fullmatch(uid)))):
        raise ValueError("invalid request")
    return rid, session, lease, op, uid


def snapshot(lines):
    if len(lines) != 3:
        raise ValueError("incomplete status")
    charge = re.fullmatch(r"EVSE:STATUS:CHARGING:(ON|OFF|UNKNOWN):SRC:query", lines[0])
    lock = re.fullmatch(r"EVSE:STATUS:ANTITHEFT:(ACTIVE|INACTIVE):SRC:query", lines[1])
    security = re.fullmatch(r"EVSE:STATUS:SECURITY:STORE:(READY|FAULT):FAULT:(NONE|UNAVAILABLE|CORRUPT|WRITE):BOOT:(RESTORE|LOCKED|UNLOCKED):CARDS:(\d{1,2}):ENROLL:(ON|OFF):READER:(SPI_OK|FAULT):SERVO:(PWM_OK|FAULT)", lines[2])
    if not charge or not lock or not security or int(security[4]) > 16:
        raise ValueError("invalid status")
    if (security[1] == "READY") != (security[2] == "NONE"):
        raise ValueError("incoherent status")
    return dict(charging={"ON": True, "OFF": False, "UNKNOWN": None}[charge[1]],
                antitheft=lock[1] == "ACTIVE", store_ready=security[1] == "READY",
                cards=int(security[4]), enrolling=security[5] == "ON",
                reader_ready=security[6] == "SPI_OK", servo_ready=security[7] == "PWM_OK")


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


class Mirror:
    def __init__(self):
        self.stamp = None
        self.anchor = None
        self.digest = None
        self.until = 0
        self.reset()

    def reset(self):
        # Transport loss revokes authorization, not measurement/clock history.
        # Replaying the same device timestamp must never revive its old lease.
        self.online = False
        self.value = None

    def availability(self, payload, retained):
        # Retained availability is not a fresh proof either.
        self.online = not retained and payload == b"online"
        if not self.online:
            self.value = None

    def sample(self, payload, retained, now, wall):
        self.current(now, wall)  # Detect clock discontinuities before dedupe.
        digest = hashlib.sha256(payload).digest()
        if not retained and digest == self.digest:
            return  # Same observed measurement never renews monotonic freshness.
        self.value = None
        if retained or len(payload) > 16384:
            return
        try:
            data = json.loads(payload, object_pairs_hook=unique_pairs,
                              parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            if (type(data) is not dict or type(data.get("schema_version")) is not int or
                    data["schema_version"] != 1 or data.get("device") != "abb_terra_ac" or
                    data.get("status") != "ok" or data.get("error") is not None):
                return
            stamp = data["timestamp"]
            if (not isinstance(stamp, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)", stamp)
                    or data["last_success_at"] != stamp):
                return
            epoch = datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()
            age = wall - epoch
            if not 0 <= age < 10 or (self.stamp is not None and epoch <= self.stamp):
                return
            values = data["values"]
            if type(values) is not dict:
                return
            for key in ("error_code", "socket_lock_state", "charging_state_raw", "charging_state", "active_power_w", "session_energy_wh"):
                if type(values.get(key)) is not int or not 0 <= values[key] <= 0xffffffff:
                    return
            for key in ("charging", "plugged_in", "below_commanded_current"):
                if key not in values or (type(values[key]) is not bool and
                        (values[key] is not None or key == "below_commanded_current")):
                    return
            for key, size in (("current_limit_a", 1), ("current_a", 3), ("voltage_v", 3)):
                numbers = [values.get(key)] if size == 1 else values.get(key)
                if type(numbers) is not list or len(numbers) != size:
                    return
                if any(type(n) not in (int, float) or not math.isfinite(n) or n < 0 for n in numbers):
                    return
            self.stamp = epoch
            self.digest = digest
            self.value = values["charging"]
            self.until = now + 10 - age
            self.anchor = (now, wall)
        except (ValueError, TypeError, KeyError, OverflowError, RecursionError):
            return

    def current(self, now, wall):
        if self.anchor and abs((wall - self.anchor[1]) - (now - self.anchor[0])) > 1:
            self.value = None
        if not self.online or now >= self.until:
            return "UNKNOWN"
        return "ON" if self.value is True else "OFF" if self.value is False else "UNKNOWN"


class SerialFailure(Exception):
    pass


class FirmwareUnsupported(SerialFailure):
    pass


class DeviceRejected(Exception):
    def __init__(self, code):
        self.code = code


class Gateway:
    def __init__(self, port, clock=time.monotonic, wall=time.time):
        self.port, self.clock, self.wall = port, clock, wall
        self.lock = threading.Lock()
        self.requests = queue.Queue(4)
        self.events = queue.Queue(8)
        self.results = []
        self.inflight = None
        self.ledger = {}
        self.leases = {}
        self.mirror = Mirror()
        self.session = secrets.token_hex(16)
        self.boot = None
        self.state = EMPTY.copy()
        self.connected = False
        self.ready = False
        self.epoch = 0
        self.operation_epoch = 0
        self.attempted = False
        self.transport_attempted = False
        self.firmware_admissions = []
        self.submid = None
        self.stopping = False
        self.client = None
        self.next_mirror = 0
        self.mirror_retry_after = 0
        self.last_mirror = "UNKNOWN"
        self.rx = bytearray()
        self.rx_start = None
        self.discard = False
        self.prefix = topic(os.getenv("ESP32_MQTT_TOPIC_PREFIX", "evse/esp32"))
        self.wallprefix = topic(os.getenv("WALLBOX_MQTT_TOPIC_PREFIX", os.getenv("MQTT_TOPIC_PREFIX", "evse/wallbox")))

    def invalidate(self):
        self.session = secrets.token_hex(16)
        self.boot = None
        self.state = EMPTY.copy()
        self.leases.clear()
        self.mirror.reset()
        self.next_mirror = 0
        self.mirror_retry_after = 0
        self.last_mirror = "UNKNOWN"
        while True:
            try:
                self.requests.get_nowait()
            except queue.Empty:
                break

    def on_connect(self, client, userdata, flags, reason, properties):
        with self.lock:
            self.epoch += 1
            self.connected = not reason.is_failure
            self.ready = False
            if self.connected:
                rc, self.submid = client.subscribe([(self.prefix + "/control/request", 0),
                    (self.wallprefix + "/state", 0), (self.wallprefix + "/availability", 0)])
                if rc != mqtt.MQTT_ERR_SUCCESS:
                    self.connected = False

    def on_subscribe(self, client, userdata, mid, codes, properties):
        with self.lock:
            self.ready = self.connected and mid == self.submid and len(codes) == 3 and all(c.value == 0 for c in codes)

    def on_disconnect(self, client, userdata, flags, reason, properties):
        with self.lock:
            self.connected = self.ready = False
            self.epoch += 1

    def on_message(self, client, userdata, message):
        with self.lock:
            if not self.ready:
                return
            if message.topic == self.prefix + "/control/request":
                if message.retain or message.qos != 0:
                    return
                try:
                    parsed = request(message.payload)
                    # Store only the digest in the ledger, not the UID.
                    self.requests.put_nowait((self.clock(), self.epoch, parsed,
                                             hashlib.sha256(message.payload).digest()))
                except (ValueError, UnicodeError, queue.Full):
                    pass
            elif message.topic in (self.wallprefix + "/state", self.wallprefix + "/availability"):
                try:
                    if len(message.payload) > 16384:
                        raise queue.Full
                    self.events.put_nowait((self.epoch, message.topic, message.payload, message.retain,
                                           self.clock(), self.wall()))
                except queue.Full:
                    self.epoch += 1  # Lost freshness evidence: fail closed, never reuse leases.
                    self.ready = False

    def drain_events(self):
        while True:
            try:
                epoch, name, payload, retained, now, wall = self.events.get_nowait()
            except queue.Empty:
                return
            if epoch != self.epoch:
                continue
            if name.endswith("/availability"):
                self.mirror.availability(payload, retained)
            else:
                self.mirror.sample(payload, retained, now, wall)

    def line(self, deadline, epoch):
        while self.clock() < deadline and not self.stopping:
            if epoch != self.epoch or not self.ready:
                raise SerialFailure()
            now = self.clock()
            if self.rx_start is not None and now - self.rx_start >= 2:
                self.discard = True
                self.rx.clear()
            char = self.port.read(1)
            if not char:
                continue
            if char == b"\n":
                data = bytes(self.rx)
                if data.endswith(b"\r"):
                    data = data[:-1]
                bad = self.discard or b"\r" in data
                self.rx.clear()
                self.rx_start = None
                self.discard = False
                if bad:
                    continue
                try:
                    return data.decode("ascii")
                except UnicodeError:
                    continue
            if self.rx_start is None:
                self.rx_start = now
            if (len(self.rx) >= 193 or (len(self.rx) >= 192 and char != b"\r") or
                    self.rx[-1:] == b"\r" or
                    (char != b"\r" and not 32 <= char[0] <= 126)):
                self.discard = True
                self.rx.clear()
            elif not self.discard:
                self.rx.extend(char)
        raise SerialFailure()

    def exchange(self, wire, match, statuses=False):
        # Never retry a write, including a partial write or timed-out flush.
        epoch = self.operation_epoch
        data = (wire + "\n").encode("ascii")
        if len(data) > 193:
            raise SerialFailure()
        parts = wire.split(":")
        hello = parts[2] == "HELLO"
        rid, boot = (parts[3], HEX) if hello else (parts[2], parts[3])
        op = "HELLO" if hello else "STATUS" if parts[4] == "STATUS" else parts[5]
        reject = re.compile(f"EVSE:GATEWAY:RESULT:{rid}:{boot}:{op}:([A-Z_]+)")
        try:
            with self.lock:
                if epoch != self.epoch or not self.ready or self.stopping:
                    raise SerialFailure()
                # HELLO/STATUS also occupy firmware cache slots for ten seconds.
                # Keep a conservative local admission window; never evict live IDs.
                now = self.clock()
                self.firmware_admissions = [t for t in self.firmware_admissions if now-t < 10.2]
                if len(self.firmware_admissions) >= 8:
                    raise DeviceRejected("BUSY")
                self.firmware_admissions.append(now)
                # No stale buffered query sequence may become the new snapshot.
                self.port.reset_input_buffer()
                self.rx.clear()
                self.rx_start = None
                self.discard = False
                self.transport_attempted = True
                if op not in {"HELLO", "STATUS"}:
                    self.attempted = True
                if self.port.write(data) != len(data):
                    raise SerialFailure()
            deadline = self.clock() + 2
            lines = []
            count = 0
            while True:
                text = self.line(deadline, epoch)
                count += 1
                if count > 64:
                    raise SerialFailure()
                if text == "EVSE:ERROR:UNKNOWN_CMD" and ":HELLO:" in wire:
                    raise FirmwareUnsupported()
                if text == "EVSE:ERROR:GATEWAY_UNAVAILABLE" and hello:
                    raise DeviceRejected("GATEWAY_UNAVAILABLE")
                found = match.fullmatch(text)
                if found:
                    return found, snapshot(lines) if statuses else None
                failed = reject.fullmatch(text)
                if failed and failed[1] in CODES:
                    raise DeviceRejected(failed[1])
                if statuses:
                    # A foreign result is a sequence barrier, never splice its
                    # untagged snapshot onto the current request's result.
                    if text.startswith("EVSE:GATEWAY:"):
                        raise SerialFailure()
                    query_charge = text.startswith("EVSE:STATUS:CHARGING:") and text.endswith(":SRC:query")
                    query_lock = text.startswith("EVSE:STATUS:ANTITHEFT:") and text.endswith(":SRC:query")
                    security = text.startswith("EVSE:STATUS:SECURITY:")
                    if query_charge or query_lock or (security and lines):
                        expected = (query_charge, query_lock, security)
                        if len(lines) >= 3 or not expected[len(lines)]:
                            raise SerialFailure()
                        lines.append(text)
                # All other lines, particularly legacy ENROLLED:<uid>, discarded.
        except (OSError, serial.SerialException, ValueError) as error:
            raise SerialFailure() from None

    def inspect(self):
        if self.boot is None:
            rid = secrets.token_hex(16)
            ack, _ = self.exchange("CMD:GATEWAY:HELLO:" + rid,
                re.compile(r"EVSE:GATEWAY:HELLO:" + rid + r":(" + HEX + r"):2"))
            self.boot = ack[1]
        rid = secrets.token_hex(16)
        ack, state = self.exchange(f"CMD:GATEWAY:{rid}:{self.boot}:STATUS",
            re.compile(f"EVSE:GATEWAY:RESULT:{rid}:{self.boot}:STATUS:OK:(" + HEX + r"):8"), True)
        self.state = state
        return ack[1], self.clock() + 8

    def management(self, firmware_lease, op, argument="-"):
        rid = secrets.token_hex(16)
        suffix = op + (":" + argument if op in ("REVOKE", "MIRROR") else "")
        ack, _ = self.exchange(f"CMD:GATEWAY:{rid}:{self.boot}:{firmware_lease}:{suffix}",
            re.compile(f"EVSE:GATEWAY:RESULT:{rid}:{self.boot}:{op}:([A-Z_]+)"))
        if ack[1] not in CODES:
            raise SerialFailure()
        return ack[1]

    def result(self, rid, op, status, reason, sent=False, code=None, lease=None):
        if op == "inspect":
            sent = False
            if status == "outcome_unknown":
                status, reason = "unavailable", "serial_timeout"
        return dict(schema_version=1, id=rid, operation=op, status=status, reason=reason,
                    session=self.session, lease=lease, fresh_for_seconds=8 if lease else 0,
                    firmware_version=2 if self.boot else None, state=self.state.copy(),
                    command_sent=sent, result_code=code)

    def handle(self, item):
        received, epoch, parsed, digest = item
        rid, session, lease, op, uid = parsed
        now = self.clock()
        self.ledger = {k: v for k, v in self.ledger.items() if v[0] > now}
        self.leases = {k: v for k, v in self.leases.items() if v[0] > now}
        if epoch != self.epoch or now - received >= 3:
            return self.result(rid, op, "rejected", "deadline_elapsed")
        if rid in self.ledger:
            old = self.ledger[rid]
            if old[1] != digest:
                return self.result(rid, op, "rejected", "invalid_request")
            cached = old[2].copy()
            # A replay is evidence of an old outcome, never a new lease/snapshot.
            cached.update(lease=None, fresh_for_seconds=0)
            return cached
        if len(self.ledger) >= 128:
            return self.result(rid, op, "rejected", "busy")
        self.ledger[rid] = (now + 30, digest, self.result(rid, op, "rejected", "busy"))
        self.operation_epoch = epoch
        self.attempted = False
        self.transport_attempted = False
        sent = False
        try:
            if op == "inspect":
                if len(self.leases) >= 64:
                    answer = self.result(rid, op, "rejected", "busy")
                else:
                    self.reserve(2 if self.boot is None else 1, 7)
                    fwlease, expiry = self.inspect()
                    lease = secrets.token_hex(16)
                    self.leases[lease] = (expiry, fwlease)
                    answer = self.result(rid, op, "ok", "inspection_complete", lease=lease)
            elif session != self.session:
                answer = self.result(rid, op, "rejected", "invalid_session")
            elif lease not in self.leases:
                answer = self.result(rid, op, "rejected", "invalid_lease")
            else:
                _, fwlease = self.leases.pop(lease)  # Consume BEFORE attempting serial.
                code = self.management(fwlease, op.upper(), uid)
                self.state = EMPTY.copy()  # ACK is not a fresh mechanical snapshot.
                rejected = code in {"INVALID_SESSION", "SESSION_MISMATCH", "GATEWAY_UNAVAILABLE", "INVALID_LEASE", "BUSY", "DUPLICATE_MISMATCH", "NOT_READY", "STORAGE_ERROR", "DENIED", "INVALID_ARGUMENT", "INVALID_UID", "FULL", "NOT_FOUND"}
                answer = self.result(rid, op, "rejected" if rejected else "acknowledged",
                                     "rejected_by_device" if rejected else "protocol_ack_only", sent=True, code=code)
                if code in {"BUSY", "NOT_READY", "INVALID_LEASE"}:
                    answer.update(reason={"BUSY": "busy", "NOT_READY": "not_ready", "INVALID_LEASE": "invalid_lease"}[code])
                if code == "BUSY":
                    answer.update(status="busy")
                if code in {"INVALID_SESSION", "SESSION_MISMATCH", "GATEWAY_UNAVAILABLE"}:
                    self.invalidate()
                    answer.update(session=self.session, firmware_version=None,
                                  reason="gateway_unavailable" if code == "GATEWAY_UNAVAILABLE" else "invalid_session",
                                  status="unavailable" if code == "GATEWAY_UNAVAILABLE" else "rejected")
        except DeviceRejected as error:
            reason = {"BUSY": "busy", "SESSION_MISMATCH": "invalid_session",
                      "INVALID_SESSION": "invalid_session", "GATEWAY_UNAVAILABLE": "gateway_unavailable",
                      "INVALID_LEASE": "invalid_lease"}.get(error.code, "rejected_by_device")
            if error.code in {"SESSION_MISMATCH", "INVALID_SESSION", "GATEWAY_UNAVAILABLE"}:
                self.invalidate()
            answer = self.result(rid, op, "busy" if error.code == "BUSY" else "unavailable" if error.code == "GATEWAY_UNAVAILABLE" else "rejected",
                                 reason, sent=self.attempted, code=error.code)
        except FirmwareUnsupported:
            self.invalidate()
            answer = self.result(rid, op, "unavailable", "firmware_unsupported", sent=self.attempted)
        except SerialFailure:
            sent = self.attempted
            self.invalidate()
            answer = self.result(rid, op, "outcome_unknown" if sent else "unavailable",
                                 "outcome_unknown" if sent else "serial_timeout", sent=sent)
        self.ledger[rid] = (now + 30, digest, answer)
        return answer

    def reserve(self, count, limit):
        now = self.clock()
        self.firmware_admissions = [t for t in self.firmware_admissions if now-t < 10.2]
        if len(self.firmware_admissions) + count > limit:
            raise DeviceRejected("BUSY")

    def mirror_tick(self):
        now = self.clock()
        self.drain_events()
        desired = self.mirror.current(now, self.wall())
        urgent_unknown = self.last_mirror != "UNKNOWN" and desired == "UNKNOWN"
        if now < self.next_mirror and not (urgent_unknown and now >= self.mirror_retry_after):
            return
        self.next_mirror = now + 4
        self.mirror_retry_after = now + 4
        self.operation_epoch = self.epoch
        try:
            # Idle work leaves two slots for a fresh HTTP inspect + mutation.
            # An urgent UNKNOWN may use the reserve to revoke a previous ON.
            self.reserve(3 if self.boot is None else 2, 8 if urgent_unknown else 6)
            lease, expiry = self.inspect()
            self.drain_events()
            # Query/ACK delays must not extend the Wallbox freshness window.
            if self.clock() < expiry:
                desired = self.mirror.current(self.clock(), self.wall())
                code = self.management(lease, "MIRROR", desired)
                if code == "OK":
                    self.last_mirror = desired
                    self.mirror_retry_after = 0
                    if desired != "UNKNOWN":
                        self.next_mirror = min(self.next_mirror, self.mirror.until)
                if code in {"INVALID_SESSION", "SESSION_MISMATCH", "GATEWAY_UNAVAILABLE"}:
                    raise SerialFailure()
        except DeviceRejected as error:
            if error.code in {"SESSION_MISMATCH", "INVALID_SESSION", "GATEWAY_UNAVAILABLE"}:
                self.invalidate()
            self.next_mirror = self.clock() + 4
        except SerialFailure:
            self.invalidate()
            self.next_mirror = self.clock() + 4

    def publish_tick(self):
        if self.inflight:
            info, deadline = self.inflight
            if info.is_published():
                self.inflight = None
            elif self.clock() >= deadline:
                return False
        if self.results and self.inflight is None:
            answer = self.results.pop(0)
            lease = answer["lease"]
            if lease and (answer["session"] != self.session or lease not in self.leases or
                          self.leases[lease][0] <= self.clock()):
                answer = dict(answer, lease=None, fresh_for_seconds=0, state=EMPTY.copy())
            payload = json.dumps(answer, separators=(",", ":"), allow_nan=False)
            if len(payload) > 4096:
                raise RuntimeError("result limit")
            info = self.client.publish(self.prefix + "/control/result/" + answer["id"], payload, qos=1, retain=False)
            if info.rc != mqtt.MQTT_ERR_SUCCESS:
                return False
            self.inflight = (info, self.clock() + 3)
        return True

    def run(self):
        seen_epoch = -1
        try:
            while not self.stopping:
                self.client = make_client(self)
                self.client.connect_async(os.getenv("MQTT_HOST", "mqtt-broker"), int(os.getenv("MQTT_PORT", "1883")), 15)
                self.client.loop_start()
                started = self.clock()
                try:
                    while not self.stopping:
                        if seen_epoch != self.epoch:
                            seen_epoch = self.epoch
                            self.invalidate()
                            self.results.clear()
                            self.inflight = None
                        if not self.connected and self.clock() - started > 3:
                            break
                        if self.connected and not self.ready and self.clock() - started > 3:
                            break
                        if self.ready:
                            self.drain_events()
                            if len(self.results) < 8:
                                try:
                                    self.results.append(self.handle(self.requests.get_nowait()))
                                except queue.Empty:
                                    self.mirror_tick()
                            if not self.publish_tick():
                                break
                        time.sleep(0.01)
                finally:
                    # Discard Paho's outbound QoS1 retransmit state on reconnect.
                    self.client.disconnect()
                    self.client.loop_stop()
                    self.connected = self.ready = False
                    self.invalidate()
                if not self.stopping:
                    time.sleep(0.5)
        finally:
            self.port.close()


def topic(value):
    if not re.fullmatch(r"[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*", value) or len(value) > 128:
        raise ValueError("invalid topic prefix")
    return value


def make_client(gateway):
    client = CappedClient(mqtt.CallbackAPIVersion.VERSION2,
        client_id=os.getenv("ESP32_MQTT_CLIENT_ID", "evse-uart-gateway"),
        clean_session=True, protocol=mqtt.MQTTv311, reconnect_on_failure=False)
    client.max_inflight_messages_set(1)
    client.max_queued_messages_set(8)
    client.connect_timeout = 2.0
    client.on_connect = gateway.on_connect
    client.on_subscribe = gateway.on_subscribe
    client.on_disconnect = gateway.on_disconnect
    client.on_message = gateway.on_message
    username = os.getenv("MQTT_USERNAME", "")
    password_file = os.getenv("MQTT_PASSWORD_FILE", "")
    password = os.getenv("MQTT_PASSWORD", "")
    if password_file:
        with open(password_file, "rb") as stream:
            data = stream.read(4097)
        if len(data) > 4096:
            raise ValueError("credential limit")
        password = data.decode("utf-8").rstrip("\r\n")
    if username:
        client.username_pw_set(username, password)
    return client


def main():
    try:
        port = serial.Serial(os.getenv("UART_PORT", "/dev/serial0"), 115200,
                             timeout=0.02, write_timeout=0.2, exclusive=True)
        gateway = Gateway(port)
        def stop(signum, frame):
            gateway.stopping = True
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        gateway.run()
    except Exception:
        # No exception repr: serial/library exceptions may contain private data.
        print("UART gateway stopped: configuration or transport failure", flush=True)
        return 1
    return 0
