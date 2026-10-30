"""Docker-only: guarded upstream library, two MQTT clients, PTY-only reader.

Header-only attacks must close BEFORE any body arrives. RSS alone cannot prove
this: malloc may reserve virtual memory without committing resident pages.
"""

import ctypes
from pathlib import Path
import socket
import sys
import threading
import time

from mqtt_test import Reader
from rtu_test import check


def wait_for(predicate, seconds, message):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError(message)


def varint(value):
    encoded = bytearray()
    while True:
        value, digit = divmod(value, 128)
        encoded.append(digit | (128 if value else 0))
        if not value:
            return bytes(encoded)


def exact(connection, size):
    result = b""
    while len(result) < size:
        chunk = connection.recv(size - len(result))
        if not chunk:
            raise EOFError
        result += chunk
    return result


def packet(connection):
    command = exact(connection, 1)[0]
    remaining = 0
    for index in range(4):
        digit = exact(connection, 1)[0]
        remaining += (digit & 127) << (index * 7)
        check(remaining <= 8192, "Unexpected oversized client output")
        if digit < 128:
            return command, exact(connection, remaining)
    raise AssertionError("Malformed client remaining length")


class HeaderAttackBroker:
    def __init__(self, remaining):
        self.remaining = remaining
        self.socket = socket.socket()
        self.socket.bind(("127.0.0.1", 0))
        self.port = self.socket.getsockname()[1]
        self.socket.listen()
        self.socket.settimeout(0.1)
        self.done = threading.Event()
        self.attack = threading.Event()
        self.lock = threading.Lock()
        self.claimed = set()
        self.ready = set()
        self.closed = {}
        self.errors = []
        self.workers = []
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self):
        while not self.done.is_set():
            try:
                connection, _ = self.socket.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            with self.lock:
                measured_clients_connected = len(self.claimed) == 2
            if measured_clients_connected:
                # Later reconnects are intentionally not probe participants;
                # they may close even before sending CONNECT during teardown.
                connection.close()
                continue
            worker = threading.Thread(target=self.client, args=(connection,), daemon=True)
            self.workers.append(worker)
            worker.start()

    def client(self, connection):
        with connection:
            connection.settimeout(0.1)
            kind = "unidentified"
            stage = "connect"
            try:
                # CONNECT is small and immediately emitted by both clients.
                connection.settimeout(2)
                command, data = packet(connection)
                check(command == 0x10 and data[:7] == b"\x00\x04MQTT\x04",
                      "Expected MQTT 3.1.1 CONNECT")
                size = int.from_bytes(data[10:12], "big")
                client_id = data[12:12 + size].decode("ascii")
                kind = "control" if client_id.startswith("evse-control-") else "publisher"
                check(kind == "control" or client_id == "isolated-reader",
                      "Unexpected client identifier")
                with self.lock:
                    # Both clients normally reconnect after the deliberately
                    # rejected header. Only the FIRST socket per kind belongs
                    # to this measurement: a reconnect must neither replace
                    # its evidence nor start a second boundary handshake while
                    # the original attack flag is already set.
                    if kind in self.claimed:
                        return
                    self.claimed.add(kind)
                connection.sendall(b"\x20\x02\x00\x00")
                stage = "boundary"
                # Boundary-positive control: retained QoS1 PUBLISH with EXACTLY
                # 4096 remaining bytes must be accepted and PUBACKed by both.
                topic = b"test/wallbox/control/request"
                prefix = len(topic).to_bytes(2, "big") + topic + b"\x7f\x01"
                connection.sendall(b"\x33" + varint(4096) + prefix +
                                   b"x" * (4096 - len(prefix)))
                acknowledged = False
                subscribed = kind == "publisher"
                deadline = time.monotonic() + 3
                connection.settimeout(0.1)
                while not self.done.is_set():
                    with self.lock:
                        if acknowledged and subscribed:
                            self.ready.add(kind)
                    if self.attack.is_set():
                        break
                    check(time.monotonic() < deadline, "4096-byte boundary packet not accepted")
                    try:
                        command, data = packet(connection)
                    except socket.timeout:
                        continue
                    if command >> 4 == 8:
                        connection.sendall(b"\x90\x03" + data[:2] + b"\x01")
                        subscribed = True
                    elif command >> 4 == 4 and data == b"\x7f\x01":
                        acknowledged = True
                    elif command >> 4 == 3 and command & 6 == 2:
                        topic_size = int.from_bytes(data[:2], "big")
                        mid = data[2 + topic_size:4 + topic_size]
                        connection.sendall(b"\x40\x02" + mid)
                    elif command >> 4 == 12:
                        connection.sendall(b"\xd0\x00")
                if self.done.is_set():
                    return
                started = time.monotonic()
                stage = "oversize-header"
                # No variable header, topic, packet id or body follows this.
                # Retained QoS1 exercises the path before application checks.
                connection.sendall(b"\x33" + varint(self.remaining))
                connection.settimeout(1.5)
                try:
                    while connection.recv(4096):
                        check(time.monotonic() - started < 1.5, "Oversize close too slow")
                except ConnectionResetError:
                    pass
                elapsed = time.monotonic() - started
                check(elapsed < 1.5, "Oversize header did not promptly close connection")
                with self.lock:
                    # Reconnects cannot substitute for the first attacked socket.
                    self.closed.setdefault(kind, elapsed)
            except Exception as error:
                if not self.done.is_set():
                    with self.lock:
                        self.errors.append(f"{kind}/{stage}: {error!r}")

    def close(self):
        self.done.set()
        self.socket.close()
        self.thread.join(timeout=2)
        for worker in self.workers:
            worker.join(timeout=2)


def rss_kib(pid):
    status = Path(f"/proc/{pid}/status").read_text()
    return int(next(line.split()[1] for line in status.splitlines()
                    if line.startswith("VmRSS:")))


def test(binary, remaining):
    broker = HeaderAttackBroker(remaining)
    reader = None
    try:
        # Reader options contain no real endpoint/device: only loopback and PTY.
        reader = Reader(binary, broker.port)
        wait_for(lambda: len(broker.ready) == 2 or broker.errors, 5,
                 "Publisher and ControlChannel did not both complete boundary probe")
        check(not broker.errors, str(broker.errors))
        maps = Path(f"/proc/{reader.process.pid}/maps").read_text()
        libraries = {line.split()[-1] for line in maps.splitlines()
                     if "/libmosquitto.so" in line}
        check(libraries and all(path.startswith("/usr/local/lib/") for path in libraries),
              "Reader did not load the guarded runtime library: " + repr(libraries))
        before_samples = len(reader.samples)
        baseline_rss = rss_kib(reader.process.pid)
        peak_rss = baseline_rss
        broker.attack.set()
        started = time.monotonic()
        while time.monotonic() - started < 1.6:
            check(reader.process.poll() is None, "Reader exited during oversized MQTT header")
            peak_rss = max(peak_rss, rss_kib(reader.process.pid))
            time.sleep(0.02)
        check(not broker.errors, str(broker.errors))
        check(set(broker.closed) == {"publisher", "control"},
              "Both clients must reject the header without waiting for its body")
        check(len(reader.samples) >= before_samples + 3,
              "Oversized MQTT header blocked normal Modbus polling")
        check(all(sample["status"] == "ok" for sample in reader.samples[before_samples:]),
              "PTY telemetry failed during MQTT rejection")
        check(peak_rss - baseline_rss < 16 * 1024, "Unexpected resident-memory growth")
        print(f"remaining={remaining}: close seconds={broker.closed}, "
              f"RSS growth={peak_rss - baseline_rss} KiB")
    finally:
        broker.close()
        if reader is not None:
            reader.stop()


if __name__ == "__main__":
    # Deliberately do not use find_library/SONAME lookup here: on ARM64 the
    # distro library can win that lookup despite the reader's build RUNPATH.
    # Require the artifact installed by our Dockerfile, with NO fallback.
    # test() independently checks the actual reader's /proc maps, so pinning
    # this probe cannot conceal a reader loading the unguarded system copy.
    library = ctypes.CDLL("/usr/local/lib/libmosquitto.so.1")
    marker = library.evse_mosquitto_incoming_limit  # Missing symbol is a hard failure.
    marker.restype = ctypes.c_int
    marker.argtypes = []
    check(marker() == 4096, "Unpatched/wrong incoming allocation limit")
    version = library.mosquitto_lib_version
    version.argtypes = [ctypes.POINTER(ctypes.c_int)] * 3
    version.restype = ctypes.c_int
    major, minor, revision = ctypes.c_int(), ctypes.c_int(), ctypes.c_int()
    version(ctypes.byref(major), ctypes.byref(minor), ctypes.byref(revision))
    check((major.value, minor.value, revision.value) == (2, 0, 21), "Wrong pinned library")
    print("Guarded upstream libmosquitto 2.0.21, incoming remaining-length cap 4096")
    for cycle in range(3):
        print(f"Original-socket rejection and reconnect isolation cycle {cycle + 1}/3")
        test(sys.argv[1], 4097)
        test(sys.argv[1], 64 * 1024 * 1024)
