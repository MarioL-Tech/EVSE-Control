"""Linux PTY Modbus-RTU simulator; Python stdlib only, no real hardware."""

import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
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


def request(fd):
    received = b""
    deadline = time.monotonic() + 3
    while len(received) < 8 and time.monotonic() < deadline:
        if select.select([fd], [], [], 0.1)[0]:
            try:
                received += os.read(fd, 8 - len(received))
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                time.sleep(0.01)
    check(len(received) == 8, "Modbus request missing")
    check(received[:6] == bytes.fromhex("09 03 40 08 00 18"),
          "Expected slave 9, FC03, start 0x4008, 24 registers; no writes allowed")
    check(received[6:] == crc(received[:6]), "Request CRC incorrect")


def response(fd):
    registers = [0] * 24
    registers[5] = 0x8400  # state C2, reduced current flag
    registers[7] = 16000
    registers[9] = 6123
    payload = bytes([9, 3, 48]) + struct.pack(">24H", *registers)
    os.write(fd, payload + crc(payload))


def line(process):
    # Tests run with unbuffered binary pipes; one flushed JSON object per cycle.
    received = b""
    deadline = time.monotonic() + 3
    while b"\n" not in received and time.monotonic() < deadline:
        if select.select([process.stdout], [], [], 0.1)[0]:
            part = os.read(process.stdout.fileno(), 1)
            check(bool(part), "Service exited without JSON")
            received += part
    check(received.endswith(b"\n"), "JSON line missing")
    return json.loads(received)


def simulated_service(binary):
    master, slave = pty.openpty()
    process = subprocess.Popen(
        [binary, "--device", os.ttyname(slave), "--interval-ms", "200",
         "--timeout-ms", "100"], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        bufsize=0)
    try:
        request(master)
        response(master)
        good = line(process)
        check(good["status"] == "ok", "Successful response marked as error")
        values = good["values"]
        check(values["charging"] is True and values["plugged_in"] is True,
              "Charging state not decoded")
        check(values["below_commanded_current"] is True, "Reduction flag missing")
        check(values["current_a"] == [6.123, 0, 0], "Current not scaled")

        request(master)  # Deliberately withhold the response.
        failed = line(process)
        check(failed["status"] == "error" and failed["values"] is None,
              "Timeout must invalidate values")
        check(failed["last_success_at"] == good["last_success_at"],
              "Last success timestamp must survive failure")
        check(failed["error"].startswith("read:"), "Timeout diagnostic missing")

        request(master)
        response(master)
        recovered = line(process)
        check(recovered["status"] == "ok", "Recovery after timeout failed")

        request(master)
        exception = bytes([9, 0x83, 1])  # Illegal function; never silently use FC04.
        os.write(master, exception + crc(exception))
        rejected = line(process)
        check(rejected["status"] == "error" and rejected["values"] is None,
              "Modbus exception must invalidate values")

        request(master)
        response(master)
        check(line(process)["status"] == "ok", "Recovery after Modbus exception failed")

        process.send_signal(signal.SIGTERM)
        check(process.wait(timeout=3) == 0, "SIGTERM shutdown failed")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        process.stdout.close()
        process.stderr.close()
        os.close(master)
        os.close(slave)


def cli(binary):
    for arguments in (["--slave", "0"], ["--slave", "248"],
                      ["--interval-ms", "99"], ["--timeout-ms", "-1"],
                      ["--parity", "X"], ["--baud", "12345"],
                      ["--device"], ["--write"], ["--slave", "9x"],
                      ["--interval-ms", "200", "--timeout-ms", "200"]):
        result = subprocess.run([binary, *arguments], capture_output=True, timeout=3)
        check(result.returncode == 2 and not result.stdout,
              "Invalid arguments must fail before hardware access")
    result = subprocess.run([binary, "--help"], capture_output=True, timeout=3)
    check(result.returncode == 0 and b"Read-only" in result.stdout, "Help failed")
    result = subprocess.run(
        [binary, "--once", "--device", "/dev/evse-nonexistent-test-device"],
        capture_output=True, timeout=3)
    check(result.returncode == 1, "Failed one-shot read must exit 1")
    sample = json.loads(result.stdout)
    check(sample["status"] == "error" and sample["last_success_at"] is None,
          "Initial connection failure must have no valid values")


def outstanding_read_shutdown(binary):
    master, slave = pty.openpty()
    process = subprocess.Popen(
        [binary, "--device", os.ttyname(slave), "--interval-ms", "1000",
         "--timeout-ms", "500"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        request(master)
        process.send_signal(signal.SIGTERM)
        check(process.wait(timeout=2) == 0, "SIGTERM during pending read failed")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        process.stdout.close()
        process.stderr.close()
        os.close(master)
        os.close(slave)


def blocked_output(binary, terminate):
    master, slave = pty.openpty()
    original_settings = termios.tcgetattr(slave)
    read_fd, write_fd = os.pipe()
    flags = fcntl.fcntl(write_fd, fcntl.F_GETFL)
    fcntl.fcntl(write_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
    try:
        while True:
            os.write(write_fd, b"x" * 4096)
    except BlockingIOError:
        pass
    process = subprocess.Popen(
        [binary, "--once", "--device", os.ttyname(slave)],
        stdout=write_fd, stderr=subprocess.PIPE)
    try:
        request(master)
        response(master)
        if terminate:
            time.sleep(0.1)
            process.send_signal(signal.SIGTERM)
        check(process.wait(timeout=3) == (0 if terminate else 2),
              "Full stdout pipe must permit shutdown or fail with bounded deadline")
        check(termios.tcgetattr(slave) == original_settings,
              "Port settings must be restored on output failure/shutdown")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        process.stderr.close()
        os.close(read_fd)
        os.close(write_fd)
        os.close(master)
        os.close(slave)


def fragmented_deadline(binary):
    master, slave = pty.openpty()
    process = subprocess.Popen(
        [binary, "--device", os.ttyname(slave), "--timeout-ms", "100", "--once"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        request(master)
        started = time.monotonic()
        # A partial frame must not turn into an unbounded read for remaining bytes.
        os.write(master, bytes([9, 3, 48, 0]))
        result = line(process)
        check(time.monotonic() - started < 0.5, "Partial-frame deadline exceeded")
        check(result["status"] == "error" and result["values"] is None,
              "Partial response must not produce measurements")
        check(process.wait(timeout=2) == 1, "Partial frame must fail one-shot read")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        process.stdout.close()
        process.stderr.close()
        os.close(master)
        os.close(slave)


if __name__ == "__main__":
    cli(sys.argv[1])
    simulated_service(sys.argv[1])
    outstanding_read_shutdown(sys.argv[1])
    fragmented_deadline(sys.argv[1])
    blocked_output(sys.argv[1], terminate=False)
    blocked_output(sys.argv[1], terminate=True)
    print("CLI, RTU, recovery, partial frame, pending-read shutdown and output tests passed")
