"""Runs only in Dockerfile.uart test stage. No real devices or broker."""
import hashlib
import json
import queue
import re
import unittest
from unittest.mock import patch
from types import SimpleNamespace

import serial
from uart_gateway import Gateway, Mirror, SerialFailure, request, snapshot, EMPTY

A = "a" * 32
B = "b" * 32
C = "c" * 32
D = "d" * 32
STATUS = ["EVSE:STATUS:CHARGING:UNKNOWN:SRC:query",
          "EVSE:STATUS:ANTITHEFT:ACTIVE:SRC:query",
          "EVSE:STATUS:SECURITY:STORE:READY:FAULT:NONE:BOOT:RESTORE:CARDS:0:ENROLL:OFF:READER:SPI_OK:SERVO:PWM_OK"]


def payload(charging=True, timestamp="2026-10-30T12:00:00Z"):
    return json.dumps(dict(schema_version=1, device="abb_terra_ac", status="ok",
        timestamp=timestamp, last_success_at=timestamp, error=None,
        values=dict(error_code=0, socket_lock_state=0, charging_state_raw=0,
            charging_state=2, active_power_w=0, session_energy_wh=0,
            plugged_in=True, charging=charging, below_commanded_current=False,
            current_limit_a=6, current_a=[0, 0, 0], voltage_v=[230, 230, 230]))).encode()


class Clock:
    def __init__(self):
        self.now = 0
    def __call__(self):
        return self.now


class Port:
    def __init__(self, clock):
        self.clock = clock
        self.writes = []
        self.data = bytearray()
        self.lost = False
        self.failure = False
        self.boot = B
        self.closed = False
        self.reject_code = None
        self.old_firmware = False
    def write(self, data):
        self.writes.append(data)
        if self.failure:
            raise serial.SerialTimeoutException("private data must never escape")
        wire = data.decode().strip().split(":")
        if wire[2] == "HELLO":
            response = "EVSE:ERROR:UNKNOWN_CMD\n" if self.old_firmware else f"EVSE:GATEWAY:HELLO:{wire[3]}:{self.boot}:2\n"
        elif self.reject_code:
            op = "STATUS" if wire[-1] == "STATUS" else wire[5]
            response = f"EVSE:GATEWAY:RESULT:{wire[2]}:{wire[3]}:{op}:{self.reject_code}\n"
        elif wire[-1] == "STATUS":
            response = "\n".join(STATUS) + f"\nEVSE:GATEWAY:RESULT:{wire[2]}:{wire[3]}:STATUS:OK:{C}:8\n"
        else:
            response = "" if self.lost else f"EVSE:GATEWAY:RESULT:{wire[2]}:{wire[3]}:{wire[5]}:OK\n"
        self.data.extend(response.encode())
        return len(data)
    def read(self, size):
        self.clock.now += .001
        result = self.data[:size]
        del self.data[:size]
        return bytes(result)
    def close(self):
        self.closed = True


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.port = Port(self.clock)
        self.gateway = Gateway(self.port, self.clock, lambda: 1793361600 + self.clock())
        self.gateway.ready = True
    def item(self, rid=A, op="inspect", session="-", lease="-", uid="-"):
        wire = f"v1|{rid}|{session}|{lease}|{op}|{uid}".encode()
        return self.clock(), self.gateway.epoch, request(wire), hashlib.sha256(wire).digest()
    def inspect(self):
        return self.gateway.handle(self.item())
    def command(self, inspected, rid=D, op="unlock", uid="-"):
        return self.item(rid, op, inspected["session"], inspected["lease"], uid)
    def test_six_fields_only(self):
        self.assertEqual(request(f"v1|{A}|-|-|inspect|-".encode())[3], "inspect")
        for value in [f"v1|{A}|-|-|inspect|-|-", f"v1|{A}|-|-|unlock|-",
                      f"v1|{A}|-|-|inspect|00:11:22:33", "x"*193]:
            with self.assertRaises(ValueError):
                request(value.encode())
    def test_inspect_snapshot_and_no_unknown_to_false(self):
        answer = self.inspect()
        self.assertEqual(answer["reason"], "inspection_complete")
        self.assertIsNone(answer["state"]["charging"])
        self.assertTrue(answer["state"]["antitheft"])
        self.assertEqual(answer["firmware_version"], 2)
    def test_snapshot_rejects_unknown_codes_counts_and_order(self):
        for lines in [STATUS[:2], list(reversed(STATUS)),
                      [*STATUS[:2], STATUS[2].replace("CARDS:0", "CARDS:17")],
                      [*STATUS[:2], STATUS[2].replace("FAULT:NONE", "FAULT:WRITE")]]:
            with self.assertRaises(ValueError):
                snapshot(lines)
        self.assertFalse(snapshot([*STATUS[:2], STATUS[2].replace("READER:SPI_OK", "READER:FAULT")])["reader_ready"])
    def test_lease_is_one_shot_and_dedup_never_writes(self):
        inspected = self.inspect()
        item = self.command(inspected)
        answer = self.gateway.handle(item)
        self.assertEqual(answer["status"], "acknowledged")
        writes = len(self.port.writes)
        self.assertEqual(self.gateway.handle(item)["status"], "acknowledged")
        self.assertEqual(len(self.port.writes), writes)
        self.assertEqual(self.gateway.handle(self.command(inspected, rid="e"*32))["reason"], "invalid_lease")
    def test_duplicate_mismatch_rejected_without_execution(self):
        inspected = self.inspect()
        self.gateway.handle(self.command(inspected))
        writes = len(self.port.writes)
        result = self.gateway.handle(self.command(inspected, op="lock"))
        self.assertEqual(result["status"], "rejected")
        self.assertEqual(len(self.port.writes), writes)
    def test_expired_lease_and_receipt(self):
        inspected = self.inspect()
        stale = self.command(inspected)
        self.clock.now += 9
        self.assertEqual(self.gateway.handle(stale)["reason"], "deadline_elapsed")
        self.assertEqual(self.gateway.handle(self.command(inspected))["reason"], "invalid_lease")
    def test_unknown_ack_never_retried_even_after_recovery(self):
        inspected = self.inspect()
        item = self.command(inspected)
        self.port.lost = True
        result = self.gateway.handle(item)
        self.assertEqual(result["status"], "outcome_unknown")
        self.assertTrue(result["command_sent"])
        self.assertNotEqual(result["session"], inspected["session"])
        self.port.lost = False
        self.gateway.handle(self.item(rid="e"*32))
        before = len(self.port.writes)
        self.gateway.handle(item)
        self.assertEqual(before, len(self.port.writes))
    def test_write_timeout_has_unknown_outcome(self):
        inspected = self.inspect()
        self.port.failure = True
        self.assertEqual(self.gateway.handle(self.command(inspected))["status"], "outcome_unknown")
        self.assertFalse(self.gateway.leases)
    def test_boot_change_requires_new_inspection(self):
        inspected = self.inspect()
        self.port.boot = "e"*32
        # Simulate reset refusing old session (no correlated ACK).
        self.port.lost = True
        self.gateway.handle(self.command(inspected))
        self.port.lost = False
        self.gateway.handle(self.item(rid="f"*32))
        self.assertEqual(self.gateway.boot, self.port.boot)
    def test_actual_firmware_session_mismatch_has_fixed_reason(self):
        inspected = self.inspect()
        self.port.reject_code = "SESSION_MISMATCH"
        answer = self.gateway.handle(self.command(inspected))
        self.assertEqual(answer["reason"], "invalid_session")
        self.assertEqual(answer["result_code"], "SESSION_MISMATCH")
        self.assertNotEqual(answer["session"], inspected["session"])
        self.assertFalse(self.gateway.leases)
    def test_status_busy_is_not_mistaken_for_lost_ack(self):
        self.port.reject_code = "BUSY"
        answer = self.inspect()
        self.assertEqual(answer["status"], "busy")
        self.assertEqual(answer["reason"], "busy")
        self.assertIsNotNone(self.gateway.boot)
    def test_old_firmware_has_no_legacy_fallback(self):
        self.port.old_firmware = True
        answer = self.inspect()
        self.assertEqual(answer["status"], "unavailable")
        self.assertEqual(answer["reason"], "firmware_unsupported")
        self.assertEqual(len(self.port.writes), 1)
        self.assertTrue(self.port.writes[0].startswith(b"CMD:GATEWAY:HELLO:"))
    def test_gateway_session_is_required_before_mutation(self):
        inspected = self.inspect()
        writes = len(self.port.writes)
        wrong = dict(inspected, session="f"*32)
        self.assertEqual(self.gateway.handle(self.command(wrong))["reason"], "invalid_session")
        self.assertEqual(len(self.port.writes), writes)
    def test_firmware_admission_limit_preserves_live_cache(self):
        self.gateway.firmware_admissions = [self.clock()] * 8
        self.assertEqual(self.inspect()["status"], "busy")
        self.assertFalse(self.port.writes)
    def test_disconnect_before_write_attempt_cannot_execute(self):
        inspected = self.inspect()
        self.gateway.ready = False
        before = len(self.port.writes)
        answer = self.gateway.handle(self.command(inspected))
        self.assertFalse(answer["command_sent"])
        self.assertEqual(before, len(self.port.writes))
    def test_result_puback_timeout_does_not_republish(self):
        inspected = self.inspect()
        calls = []
        info = SimpleNamespace(rc=0, is_published=lambda: False)
        self.gateway.client = SimpleNamespace(publish=lambda *a, **k: calls.append((a, k)) or info)
        self.gateway.results.append(inspected)
        self.assertTrue(self.gateway.publish_tick())
        self.clock.now += 3
        self.assertFalse(self.gateway.publish_tick())
        self.assertEqual(len(calls), 1)
    def test_mirror_expiry_sends_unknown_without_waiting_extra_four_seconds(self):
        self.gateway.mirror.availability(b"online", False)
        self.gateway.mirror.sample(payload(), False, 0, 1793361600)
        self.gateway.mirror_tick()
        self.assertTrue(self.port.writes[-1].endswith(b":MIRROR:ON\n"))
        self.clock.now = 8
        self.gateway.mirror_tick()
        self.assertLessEqual(self.gateway.next_mirror, 10)
        self.clock.now = 10
        self.gateway.mirror_tick()
        self.assertTrue(self.port.writes[-1].endswith(b":MIRROR:UNKNOWN\n"))
    def test_mirror_offline_prioritizes_unknown_over_periodic_timer(self):
        self.gateway.mirror.availability(b"online", False)
        self.gateway.mirror.sample(payload(), False, 0, 1793361600)
        self.gateway.mirror_tick()
        self.gateway.mirror.availability(b"offline", False)
        self.gateway.mirror_tick()
        self.assertTrue(self.port.writes[-1].endswith(b":MIRROR:UNKNOWN\n"))
    def test_no_uid_in_ledger_state_or_result(self):
        inspected = self.inspect()
        uid = "01:23:45:67"
        answer = self.gateway.handle(self.command(inspected, op="revoke", uid=uid))
        self.assertNotIn(uid, json.dumps(answer))
        self.assertNotIn(uid, repr(self.gateway.ledger))
        self.assertNotIn(uid, repr(self.gateway.state))
    def test_unsolicited_uid_lines_are_discarded(self):
        self.port.data.extend(b"EVSE:RESULT:RFID:ENROLLED:01:23:45:67\n")
        self.assertEqual(self.inspect()["status"], "ok")
    def test_queue_retained_and_qos_admission(self):
        msg = SimpleNamespace(topic=self.gateway.prefix+"/control/request", payload=f"v1|{A}|-|-|inspect|-".encode(), retain=True, qos=0)
        self.gateway.on_message(None, None, msg)
        self.assertTrue(self.gateway.requests.empty())
        msg.retain = False
        msg.qos = 1
        self.gateway.on_message(None, None, msg)
        self.assertTrue(self.gateway.requests.empty())
        msg.qos = 0
        for _ in range(20):
            self.gateway.on_message(None, None, msg)
        self.assertEqual(self.gateway.requests.qsize(), 4)
    def test_disconnect_invalidates_pending_work(self):
        inspected = self.inspect()
        queued = self.command(inspected)
        self.gateway.on_disconnect(None, None, None, None, None)
        self.gateway.invalidate()
        self.assertEqual(self.gateway.handle(queued)["reason"], "deadline_elapsed")
        self.assertEqual(self.gateway.state, EMPTY)
    def test_ledger_never_evicts_valid_entry(self):
        for n in range(128):
            self.gateway.ledger[f"{n:032x}"] = (100, b"hash", {})
        before = len(self.port.writes)
        self.assertEqual(self.inspect()["reason"], "busy")
        self.assertEqual(before, len(self.port.writes))
    def test_shutdown_aborts_serial_wait(self):
        self.gateway.stopping = True
        with self.assertRaises(SerialFailure):
            self.gateway.line(100, self.gateway.epoch)
    def test_absolute_frame_deadline_and_oversize(self):
        self.port.data.extend(b"X"*193 + b"\nGOOD\n")
        self.assertEqual(self.gateway.line(2, self.gateway.epoch), "GOOD")
        self.gateway.rx_start = self.clock()-3
        self.gateway.rx.extend(b"PARTIAL")
        self.port.data.extend(b"\nNEXT\n")
        self.assertEqual(self.gateway.line(self.clock()+2, self.gateway.epoch), "NEXT")
    def test_crlf_exactly_once_and_full_192_character_frame(self):
        self.port.data.extend(b"X"*192 + b"\r\n")
        self.assertEqual(self.gateway.line(2, self.gateway.epoch), "X"*192)
        self.port.data.extend(b"BAD\r\r\nGOOD\r\n")
        self.assertEqual(self.gateway.line(2, self.gateway.epoch), "GOOD")


class MirrorTests(unittest.TestCase):
    WALL = 1793361600  # 2026-10-30 12:00 UTC
    def setUp(self):
        self.mirror = Mirror()
    def test_requires_online_and_fresh_nonretained_sample(self):
        self.assertEqual(self.mirror.current(0, self.WALL), "UNKNOWN")
        self.mirror.availability(b"online", True)
        self.mirror.sample(payload(), True, 0, self.WALL)
        self.assertEqual(self.mirror.current(0, self.WALL), "UNKNOWN")
        self.mirror.availability(b"online", False)
        self.mirror.sample(payload(), False, 0, self.WALL)
        self.assertEqual(self.mirror.current(0, self.WALL), "ON")
        self.assertEqual(self.mirror.current(10, self.WALL+10), "UNKNOWN")
    def test_zero_power_does_not_override_actual_charging(self):
        self.mirror.availability(b"online", False)
        self.mirror.sample(payload(True), False, 0, self.WALL)
        self.assertEqual(self.mirror.current(0, self.WALL), "ON")
        self.mirror.sample(payload(False, "2026-10-30T12:00:01Z"), False, 1, self.WALL+1)
        self.assertEqual(self.mirror.current(1, self.WALL+1), "OFF")
    def test_duplicate_does_not_renew_freshness(self):
        self.mirror.availability(b"online", False)
        self.mirror.sample(payload(), False, 0, self.WALL)
        self.mirror.sample(payload(), False, 9, self.WALL+9)
        self.assertEqual(self.mirror.current(10, self.WALL+10), "UNKNOWN")
    def test_unknown_bad_schema_offline_and_clock_jump(self):
        self.mirror.availability(b"online", False)
        self.mirror.sample(payload(None), False, 0, self.WALL)
        self.assertEqual(self.mirror.current(0, self.WALL), "UNKNOWN")
        self.mirror.sample(payload(), False, 0, self.WALL)
        self.assertEqual(self.mirror.current(1, self.WALL-10), "UNKNOWN")
        self.mirror.reset()
        self.mirror.availability(b"online", False)
        self.mirror.sample(payload(), False, 0, self.WALL)
        self.mirror.availability(b"offline", False)
        self.assertEqual(self.mirror.current(0, self.WALL), "UNKNOWN")
        for bad in [b"{}", payload().replace(b'"charging": true', b'"charging": 1'),
                    payload().replace(b'230', b'NaN'), b"["*2000]:
            self.mirror.sample(bad, False, 0, self.WALL)
            self.assertEqual(self.mirror.current(0, self.WALL), "UNKNOWN")


if __name__ == "__main__":
    unittest.main()
