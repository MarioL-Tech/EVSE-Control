"""Docker/Linux-only write-core simulation. No hardware, network or dependencies.

Invocation: python write_test.py <wallbox-write-probe>
Every exchange is checked, including the absence of retries and immediate readback.
"""

import errno
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import threading
import time


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def crc(data):
    value = 0xFFFF
    for byte in data:
        value ^= byte
        for _ in range(8):
            value = (value >> 1) ^ (0xA001 if value & 1 else 0)
    return struct.pack("<H", value)


def framed(data):
    return data + crc(data)


def read_request(address, count):
    return struct.pack(">BBHH", 9, 3, address, count)


def current_request(ma):
    return struct.pack(">BBHHBI", 9, 16, 0x4100, 2, 4, ma)


def stop_request(start=False):
    return struct.pack(">BBHH", 9, 6, 0x4105, 0 if start else 1)


def read_response(values):
    return bytes([9, 3, len(values) * 2]) + struct.pack(">" + "H" * len(values), *values)


def pair(value):
    return [value >> 16, value & 0xFFFF]


def telemetry(effective=10000, state=1, fault=0):
    words = [0] * 24
    words[0:2] = pair(fault)
    words[4:6] = pair(state << 8)
    words[6:8] = pair(effective)
    return read_response(words)


class Parser:
    """Independent bounded whole-frame parser; never resynchronizes past garbage."""
    def __init__(self):
        self.buffer = bytearray()

    def feed(self, data):
        self.buffer.extend(data)
        check(len(self.buffer) <= 512, "Unbounded/oversized request stream")
        frames = []
        while len(self.buffer) >= 2:
            check(self.buffer[0] == 9, "Unexpected slave")
            function = self.buffer[1]
            check(function in (3, 6, 16), "Unexpected function")
            size = 8
            if function == 16:
                if len(self.buffer) < 7:
                    break
                check(self.buffer[6] == 4, "FC16 must carry exactly two registers")
                check(self.buffer[4:6] == b"\x00\x02", "FC16 quantity must be two")
                size = 9 + self.buffer[6]
            if len(self.buffer) < size:
                break
            frame = bytes(self.buffer[:size])
            del self.buffer[:size]
            check(frame[-2:] == crc(frame[:-2]), "Request CRC incorrect")
            frames.append(frame[:-2])
        return frames


# Script entries are exact request payload + response action. None means lost ACK.
def exchange(request, response):
    return (request, response)


def prepare(ma=10000, effective=None, hardware=32000):
    if effective is None:
        effective = ma
    request = current_request(ma)
    return [exchange(read_request(0x4006, 2), read_response(pair(hardware))),
            exchange(request, request[:6]),
            exchange(read_request(0x400E, 2), read_response(pair(effective)))]


def recovery(effective=10000):
    return [exchange(read_request(0x4008, 24), telemetry(effective)),
            exchange(read_request(0x400E, 2), read_response(pair(effective)))]


def run(binary, name, scenario, script):
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)
    process = subprocess.Popen([binary, os.ttyname(slave), scenario],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    done = threading.Event()
    failures, seen = [], []
    parser = Parser()

    def serve():
        index = 0
        try:
            while True:
                readable = select.select([master], [], [], 0.01)[0]
                if not readable:
                    if done.is_set():
                        break
                    continue
                try:
                    data = os.read(master, 512)
                except OSError as error:
                    if error.errno == errno.EIO and done.is_set():
                        break
                    raise
                for request in parser.feed(data):
                    check(index < len(script), "Unexpected extra I/O: " + request.hex())
                    expected, response = script[index]
                    check(request == expected,
                          f"Exchange {index}: {request.hex()} != {expected.hex()}")
                    seen.append(request)
                    index += 1
                    if callable(response):
                        response(master, process, request)
                    elif response is not None:
                        os.write(master, framed(response))
            check(not parser.buffer, "Trailing partial request")
            check(index == len(script), f"Only {index}/{len(script)} exchanges observed")
        except BaseException as error:
            failures.append(error)
            if process.poll() is None:
                process.kill()

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    try:
        stdout, stderr = process.communicate(timeout=4)
        done.set()
        thread.join(timeout=1)
        check(not thread.is_alive(), name + ": simulator did not stop")
        if failures:
            raise AssertionError(name + ": " + str(failures[0]))
        check(process.returncode == 0, name + ": probe failed: " + stderr.decode(errors="replace"))
        check(not stderr, name + ": unexpected diagnostic")
        check(termios.tcgetattr(slave) == original, name + ": termios not restored")
        records = [json.loads(line) for line in stdout.splitlines()]
        check(len(records) == len({row["stage"] for row in records}), "Duplicate result stage")
        rows = {row["stage"]: row for row in records}
        check("result" in rows, name + ": missing result")
        for row in records:
            if "status" in row:
                check(row["response_us"] == 100000 and row["byte_us"] == 0,
                      name + ": core failed to restore timeout settings")
                check(row["acknowledged"] == (row["status"] == "acknowledged"),
                      name + ": inconsistent ACK/status")
        return rows, seen
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=2)
        done.set()
        thread.join(timeout=1)
        process.stdout.close()
        process.stderr.close()
        os.close(master)
        os.close(slave)


def status(rows, expected, stage="result", attempted=False, reason=None):
    row = rows[stage]
    check(row["status"] == expected, f"{stage}: {row} expected {expected}")
    check(row["attempted"] is attempted, f"{stage}: incorrect send evidence")
    if reason:
        check(row["reason"] == reason, f"{stage}: incorrect reason: {row}")
    return row


def malformed(kind):
    def send(fd, process, request):
        ack = request[:6]
        if kind == "timeout":
            return
        if kind == "partial":
            os.write(fd, framed(ack)[:4])
        elif kind == "crc":
            packet = framed(ack)
            os.write(fd, packet[:-1] + bytes([packet[-1] ^ 0x80]))
        else:
            altered = bytearray(ack)
            if kind == "slave":
                altered[0] = 10
            elif kind == "function":
                altered[1] = 6 if ack[1] == 16 else 16
            elif kind == "address":
                altered[3] ^= 1
            elif kind == "argument":
                altered[5] ^= 1
            else:
                raise AssertionError("Unknown corruption")
            os.write(fd, framed(altered))
    return send


def cli(binary):
    # Even syntactically plausible real devices must fail before being opened.
    paths = ["/dev/null", "/dev/ttyS0", "/dev/ttyUSB0", "/dev/pts/ptmx",
             "/dev/pts/-1", "/dev/pts/0/../0", "/dev/pts/999999999999999999999"]
    for path in paths:
        result = subprocess.run([binary, path, "stop"], capture_output=True, timeout=2)
        check(result.returncode == 2 and not result.stdout, "Unsafe path accepted: " + path)
    master, slave = pty.openpty()
    try:
        path = os.ttyname(slave)
        for args in ([], [path], [path, "arbitrary"], [path, "stop", "extra"],
                     ["/dev/pts/0" + path[len('/dev/pts/'):], "stop"]):
            result = subprocess.run([binary, *args], capture_output=True, timeout=2)
            check(result.returncode == 2 and not result.stdout, "Invalid CLI accepted")
        # Do not create files in /dev; /proc/self/fd is an existing PTY alias.
        result = subprocess.run([binary, f"/proc/self/fd/{slave}", "stop"],
                                capture_output=True, timeout=2, pass_fds=(slave,))
        check(result.returncode == 2 and not result.stdout, "PTY fd alias accepted")
    finally:
        os.close(master)
        os.close(slave)


def successful(binary):
    for ma in (6000, 10000, 16000, 32000):
        rows, seen = run(binary, f"current-{ma}", f"set{ma // 1000}", prepare(ma))
        row = status(rows, "acknowledged", attempted=True)
        check(row["effective_ma"] == ma and row["hardware_ma"] == 32000, "Readback lost")
        check(sum(frame[1] in (6, 16) for frame in seen) == 1, "More than one write")
    rows, _ = run(binary, "lower-actual", "set10", prepare(effective=6000))
    check(status(rows, "acknowledged", attempted=True)["effective_ma"] == 6000,
          "Lower actual current must remain distinct from requested")
    rows, _ = run(binary, "exact-hardware-minimum", "set6", prepare(6000, hardware=6000))
    status(rows, "acknowledged", attempted=True)
    rows, _ = run(binary, "zero-actual", "set10", prepare(effective=0))
    check(status(rows, "acknowledged", attempted=True)["effective_ma"] == 0,
          "Zero actual current must not be replaced by requested current")
    for scenario, expected in (("disabled", "disabled"),
                               ("missing-installation", "invalid_request"),
                               ("above-installation", "invalid_request"),
                               ("unprepared", "preparation_required")):
        rows, _ = run(binary, scenario, scenario, [])
        status(rows, expected)
    for hardware, reason in ((6000, "above_hardware_limit"), (0, "invalid_hardware_limit"),
                             (5999, "invalid_hardware_limit"), (32001, "invalid_hardware_limit"),
                             (0xFFFFFFFF, "invalid_hardware_limit")):
        rows, _ = run(binary, f"hardware-{hardware}", "set10",
                      [exchange(read_request(0x4006, 2), read_response(pair(hardware)))])
        status(rows, "preflight_failed_not_sent", reason=reason)
    rows, _ = run(binary, "stop", "stop", [exchange(stop_request(), stop_request()),
                 exchange(read_request(0x400C, 2), read_response(pair(1 << 8)))])
    row = status(rows, "acknowledged", attempted=True)
    check(row["charging"] is False, "Stop observation missing")


def starts(binary):
    for scenario in ("start",):
        script = prepare(effective=6000) + [
            exchange(read_request(0x4006, 2), read_response(pair(32000))),
            exchange(read_request(0x4008, 24), telemetry(effective=6000)),
            exchange(stop_request(True), stop_request(True)),
            exchange(read_request(0x400C, 2), read_response(pair(4 << 8)))]
        rows, seen = run(binary, scenario, scenario, script)
        status(rows, "acknowledged", "prepare", True)
        check(status(rows, "acknowledged", attempted=True)["charging"] is True,
              "Start observation missing")
        status(rows, "preparation_required", "consumed")
        check(sum(frame[1] in (6, 16) for frame in seen) == 2, "Implicit extra start write")
    for scenario, stage, expected in (("mismatch", "mismatch", "preparation_required"),
            ("rejected-replacement", "replacement", "invalid_request"),
            ("expired-replacement", "replacement", "expired_not_sent")):
        rows, _ = run(binary, scenario, scenario, prepare())
        status(rows, expected, stage)
        status(rows, "preparation_required")
        status(rows, "preparation_required", "consumed")
    rows, _ = run(binary, "expires-during-preflight", "expires-during-preflight", prepare() + [
        exchange(read_request(0x4006, 2), read_response(pair(32000))),
        exchange(read_request(0x4008, 24), telemetry())])
    status(rows, "preparation_required", reason="fresh_limit_ack_required")
    status(rows, "preparation_required", "consumed")
    # A valid transport ACK never invents physical success. Keep noncharging,
    # unknown, and still-charging observations independently visible after ACK.
    for raw, observed in ((0, False), (1 << 8, False), (5 << 8, None),
                          (0x8400, True)):
        rows, _ = run(binary, f"start-observed-{raw}", "start", prepare() + [
            exchange(read_request(0x4006, 2), read_response(pair(32000))),
            exchange(read_request(0x4008, 24), telemetry()),
            exchange(stop_request(True), stop_request(True)),
            exchange(read_request(0x400C, 2), read_response(pair(raw)))])
        row = status(rows, "acknowledged", attempted=True)
        check(row["charging"] is observed and row["state_raw"] == raw,
              "Start ACK must not invent active charging or turn unknown into false")
        status(rows, "preparation_required", "consumed")
    for raw, observed in ((4 << 8, True), (5 << 8, None)):
        rows, _ = run(binary, f"stop-observed-{raw}", "stop", [
            exchange(stop_request(), stop_request()),
            exchange(read_request(0x400C, 2), read_response(pair(raw)))])
        check(status(rows, "acknowledged", attempted=True)["charging"] is observed,
              "Stop ACK must not invent a completed physical stop")
    for fault, state, effective, reason in ((1, 1, 10000, "active_wallbox_fault"),
            (0, 5, 10000, "charging_state_unknown"),
            (0, 1, 10001, "effective_limit_above_request")):
        rows, _ = run(binary, reason, "start", prepare() + [
            exchange(read_request(0x4006, 2), read_response(pair(32000))),
            exchange(read_request(0x4008, 24), telemetry(effective, state, fault))])
        status(rows, "preflight_failed_not_sent", reason=reason)
        status(rows, "preparation_required", "consumed")
    rows, _ = run(binary, "bad-preparation-readback", "start", prepare(effective=10001))
    status(rows, "acknowledged", "prepare", True, "effective_limit_above_request")
    status(rows, "preparation_required")
    for scenario, expected in (("expired-preparation", "preparation_required"),
                               ("invalidate", "recovery_required")):
        rows, _ = run(binary, scenario, scenario, prepare())
        status(rows, expected)
        status(rows, expected, "consumed")
    rows, _ = run(binary, "prepared-stop", "prepared-stop", prepare() + [
        exchange(stop_request(), stop_request()),
        exchange(read_request(0x400C, 2), read_response(pair(0)))])
    status(rows, "acknowledged", attempted=True)
    status(rows, "preparation_required", "consumed")
    rows, _ = run(binary, "preparation-read-failed", "start", prepare()[:-1] + [
        exchange(read_request(0x400E, 2), None)])
    status(rows, "acknowledged", "prepare", True, "observation_read_failed")
    status(rows, "recovery_required")
    status(rows, "recovery_required", "consumed")
    rows, _ = run(binary, "start-preflight-read-failed", "start", prepare() + [
        exchange(read_request(0x4006, 2), None)])
    status(rows, "preflight_failed_not_sent", reason="observation_read_failed")
    status(rows, "recovery_required", "consumed")
    status(rows, "recovery_required", "read_failure_latched")


def write_failures(binary):
    for scenario, request in (("set10", current_request(10000)), ("stop", stop_request())):
        prefix = [exchange(read_request(0x4006, 2), read_response(pair(32000)))] if scenario == "set10" else []
        for kind in ("crc", "partial", "timeout", "slave", "function", "address", "argument"):
            rows, seen = run(binary, scenario + "-" + kind, scenario,
                             prefix + [exchange(request, malformed(kind))] + recovery())
            status(rows, "outcome_unknown", attempted=True)
            status(rows, "recovery_required", "latched")
            status(rows, "recovery_required", "still_latched")
            check(rows["recovery_observation"]["ok"], "Explicit recovery reads failed")
            check(sum(frame[1] in (6, 16) for frame in seen) == 1,
                  "Unknown/committed write was repeated")
        for code in (1, 2, 3, 4, 5, 6, 10, 11):
            rows, _ = run(binary, f"{scenario}-exception-{code}", scenario, prefix + [
                exchange(request, bytes([9, request[1] | 0x80, code]))] + recovery())
            status(rows, "rejected_by_device" if code <= 3 else "outcome_unknown",
                   attempted=True, reason="device_exception")
            status(rows, "recovery_required", "latched")
            status(rows, "recovery_required", "still_latched")
    # A valid ACK followed by a lost observation is still acknowledged, not unknown/unsent.
    for scenario, script in (("set10", prepare()[:-1] + [exchange(read_request(0x400E, 2), None)]),
                            ("stop", [exchange(stop_request(), stop_request()),
                                      exchange(read_request(0x400C, 2), None)])):
        rows, _ = run(binary, scenario + "-ack-read-failure", scenario, script)
        status(rows, "acknowledged", attempted=True, reason="observation_read_failed")
        status(rows, "recovery_required", "read_failure_latched")
    rows, _ = run(binary, "preflight-read-timeout", "set10", [
        exchange(read_request(0x4006, 2), None)])
    status(rows, "preflight_failed_not_sent", reason="observation_read_failed")
    status(rows, "recovery_required", "read_failure_latched")


def cancellation_and_deadline(binary):
    def terminate_pending(fd, process, request):
        process.send_signal(signal.SIGTERM)  # Deliberately lose this write ACK.

    for scenario, request in (("stop", stop_request()), ("set10", current_request(10000))):
        prefix = [exchange(read_request(0x4006, 2), read_response(pair(32000)))] if scenario == "set10" else []
        rows, seen = run(binary, scenario + "-sigterm-pending-ack", scenario,
                         prefix + [exchange(request, terminate_pending)])
        status(rows, "outcome_unknown", attempted=True)
        status(rows, "recovery_required", "latched")
        check(sum(frame[1] in (6, 16) for frame in seen) == 1, "Write after SIGTERM")

    def terminate_observation(fd, process, request):
        process.send_signal(signal.SIGTERM)

    # The ACK has already been received: cancellation/failure of the following
    # observation must not erase it or misclassify the write as CancelledNotSent.
    rows, _ = run(binary, "sigterm-after-ack", "stop", [
        exchange(stop_request(), stop_request()),
        exchange(read_request(0x400C, 2), terminate_observation)])
    status(rows, "acknowledged", attempted=True, reason="observation_read_failed")
    status(rows, "recovery_required", "read_failure_latched")

    def delayed_hardware(fd, process, request):
        time.sleep(0.015)
        os.write(fd, framed(read_response(pair(32000))))

    rows, _ = run(binary, "remaining-deadline", "deadline", [
        exchange(read_request(0x4006, 2), delayed_hardware),
        exchange(current_request(10000), None)] + recovery())
    row = status(rows, "outcome_unknown", attempted=True)
    check(25000 <= row["elapsed_us"] < 95000,
          "Write receive timeout not clamped to remaining 40ms budget")
    status(rows, "recovery_required", "still_latched")


if __name__ == "__main__":
    check(len(sys.argv) == 2, "Usage: write_test.py <wallbox-write-probe>")
    binary = sys.argv[1]
    cli(binary)
    successful(binary)
    starts(binary)
    write_failures(binary)
    cancellation_and_deadline(binary)
    print("PTY-only write simulation: wire sequences, preparation, limits, strict ACKs, "
          "exceptions, caller recovery, SIGTERM, termios and remaining deadlines passed")
