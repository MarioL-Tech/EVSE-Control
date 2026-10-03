"""Isolated loopback Mosquitto + PTY tests, run inside the Docker build only."""

import errno
import json
import os
from pathlib import Path
import pty
import select
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time

from rtu_test import check, crc


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Broker:
    def __init__(self, directory, authenticated=False):
        self.port = free_port()
        self.config = directory / "mosquitto.conf"
        self.credentials = []
        access = "allow_anonymous true\n"
        if authenticated:
            # Public dummy credentials solely for this isolated test broker.
            password_file = directory / "broker-passwords"
            subprocess.run(["mosquitto_passwd", "-b", "-c", str(password_file),
                            "test-reader", "integration-test-only"], check=True)
            os.chmod(password_file, 0o644)
            access = f"allow_anonymous false\npassword_file {password_file}\n"
            self.credentials = ["-u", "test-reader", "-P", "integration-test-only"]
        self.config.write_text(
            f"listener {self.port} 127.0.0.1\n{access}persistence false\n")
        self.log = (directory / "broker.log").open("w+")
        self.process = None
        self.start()

    def start(self):
        self.process = subprocess.Popen(["mosquitto", "-c", str(self.config)],
                                        stdout=self.log, stderr=self.log)
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            check(self.process.poll() is None, "Isolated test broker exited")
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.1):
                    return
            except OSError:
                time.sleep(0.05)
        raise AssertionError("Test broker failed to start")

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=3)

    def receive(self, suffix, predicate):
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline:
            result = subprocess.run(
                ["mosquitto_sub", "-h", "127.0.0.1", "-p", str(self.port),
                 "-t", "test/wallbox/" + suffix, "-C", "1", "-W", "1", "-q", "1",
                 *self.credentials],
                # Actual credentials never enter these tests or production command lines.
                # Only the publicly known isolated-broker dummy credentials are used.
                env=os.environ,
                capture_output=True, text=True, timeout=2)
            if result.returncode == 0:
                value = result.stdout.strip()
                if predicate(value):
                    return value
            time.sleep(0.05)
        raise AssertionError("Expected MQTT " + suffix + " message not received")


class Reader:
    def __init__(self, binary, port, credentials=None, stderr=None):
        self.master, self.slave = pty.openpty()
        self.done = threading.Event()
        self.respond = threading.Event()
        self.respond.set()
        self.samples = []
        self.errors = []
        env = dict(os.environ, MQTT_ENABLED="true", MQTT_HOST="127.0.0.1",
                   MQTT_PORT=str(port), MQTT_TOPIC_PREFIX="test/wallbox",
                   MQTT_CLIENT_ID="isolated-reader", MQTT_USERNAME="", MQTT_PASSWORD="",
                   MQTT_PASSWORD_FILE="")
        if credentials:
            env.update(credentials)
        self.log = tempfile.TemporaryFile(mode="w+")
        self.process = subprocess.Popen(
            [binary, "--device", os.ttyname(self.slave), "--interval-ms", "200",
             "--timeout-ms", "100"], env=env, stdout=subprocess.PIPE,
            stderr=self.log if stderr is None else stderr, text=True)
        self.responder = threading.Thread(target=self.serve, daemon=True)
        self.output = threading.Thread(target=self.collect, daemon=True)
        self.responder.start()
        self.output.start()

    def collect(self):
        try:
            for line in self.process.stdout:
                self.samples.append(json.loads(line))
        except Exception as error:
            self.errors.append(error)

    def serve(self):
        received = b""
        try:
            while not self.done.is_set():
                if not select.select([self.master], [], [], 0.05)[0]:
                    continue
                try:
                    received += os.read(self.master, 8 - len(received))
                except OSError as error:
                    if error.errno == errno.EIO:
                        time.sleep(0.01)
                        continue
                    raise
                if len(received) != 8:
                    continue
                check(received[:6] == bytes.fromhex("09 03 40 08 00 18"),
                      "Reader must only issue FC03 reads")
                check(received[6:] == crc(received[:6]), "Bad Modbus request CRC")
                received = b""
                if self.respond.is_set():
                    registers = [0] * 24
                    registers[5] = 0x8400
                    registers[7] = 16000
                    registers[9] = 6123
                    import struct
                    payload = bytes([9, 3, 48]) + struct.pack(">24H", *registers)
                    os.write(self.master, payload + crc(payload))
        except Exception as error:
            self.errors.append(error)

    def stop(self, abrupt=False):
        self.done.set()
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGKILL if abrupt else signal.SIGTERM)
            self.process.wait(timeout=5)
        self.responder.join(timeout=2)
        self.output.join(timeout=2)
        self.process.stdout.close()
        os.close(self.master)
        os.close(self.slave)
        self.log.seek(0)
        logs = self.log.read()
        self.log.close()
        check(not self.errors, str(self.errors) + "\n" + logs)
        check(abrupt or self.process.returncode == 0, "Reader shutdown failed: " + logs)


def invalid_options(binary, directory):
    cases = [{"MQTT_PORT": "0"}, {"MQTT_PORT": "12x"},
             {"MQTT_TOPIC_PREFIX": "evse/+"}, {"MQTT_TOPIC_PREFIX": "evse/"},
             {"MQTT_ENABLED": "sometimes"}, {"MQTT_PASSWORD": "test-only"},
             {"MQTT_PASSWORD_FILE": str(directory / "missing"), "MQTT_USERNAME": "test"}]
    for changes in cases:
        env = dict(os.environ, MQTT_ENABLED="true", MQTT_PASSWORD="", MQTT_USERNAME="",
                   MQTT_PASSWORD_FILE="")
        env.update(changes)
        result = subprocess.run([binary, "--once"], env=env,
                                capture_output=True, timeout=3)
        check(result.returncode == 2 and not result.stdout, "Invalid MQTT config accepted")
        check(b"test-only" not in result.stderr, "Password leaked in diagnostics")


def test(binary, directory):
    invalid_options(binary, directory)
    broker = Broker(directory)
    reader = None
    try:
        reader = Reader(binary, broker.port)
        healthy = broker.receive("state", lambda raw: json.loads(raw)["status"] == "ok")
        sample = json.loads(healthy)
        check(sample["values"]["current_a"] == [6.123, 0, 0], "MQTT values not decoded")
        check(sample["values"]["charging"] is True, "MQTT charging flag incorrect")
        broker.receive("availability", lambda raw: raw == "online")
        # Subscriptions started after publication above: delivery proves retained messages.
        reader.respond.clear()
        error = broker.receive("state", lambda raw: json.loads(raw)["status"] == "error")
        check(json.loads(error)["values"] is None, "MQTT errors must invalidate values")
        broker.receive("availability", lambda raw: raw == "offline")
        reader.respond.set()
        broker.receive("state", lambda raw: json.loads(raw)["status"] == "ok")
        broker.receive("availability", lambda raw: raw == "online")

        broker.stop()
        before = len(reader.samples)
        time.sleep(1.5)
        check(len(reader.samples) >= before + 3, "Broker outage blocked Modbus polling")
        broker.start()
        broker.receive("state", lambda raw: json.loads(raw)["status"] == "ok")
        broker.receive("availability", lambda raw: raw == "online")

        reader.stop()
        reader = None
        broker.receive("availability", lambda raw: raw == "offline")

        reader = Reader(binary, broker.port)
        broker.receive("availability", lambda raw: raw == "online")
        reader.stop(abrupt=True)
        reader = None
        broker.receive("availability", lambda raw: raw == "offline")
    finally:
        if reader is not None:
            reader.stop(abrupt=True)
        broker.stop()
        broker.log.close()


def authenticated_test(binary, directory):
    broker = Broker(directory, authenticated=True)
    password = directory / "client-password"
    password.write_text("integration-test-only\n")
    reader = None
    try:
        reader = Reader(binary, broker.port,
                        {"MQTT_USERNAME": "test-reader", "MQTT_PASSWORD_FILE": str(password)})
        broker.receive("state", lambda raw: json.loads(raw)["status"] == "ok")
        broker.receive("availability", lambda raw: raw == "online")
        reader.stop()
        reader = Reader(binary, broker.port,
                        {"MQTT_USERNAME": "test-reader", "MQTT_PASSWORD": "wrong-test-only"})
        time.sleep(1)
        check(len(reader.samples) >= 3, "Rejected MQTT credentials blocked Modbus")
        broker.receive("availability", lambda raw: raw == "offline")
        reader.stop()
        reader = None
    finally:
        if reader is not None:
            reader.stop(abrupt=True)
        broker.stop()
        broker.log.close()


class NoAckBroker:
    """Minimal loopback MQTT endpoint that accepts CONNECT but withholds PUBACK."""
    def __init__(self):
        self.socket = socket.socket()
        self.socket.bind(("127.0.0.1", 0))
        self.port = self.socket.getsockname()[1]
        self.socket.listen()
        self.socket.settimeout(0.1)
        self.done = threading.Event()
        self.counts = []
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    @staticmethod
    def packet(connection):
        def exact(size):
            data = b""
            while len(data) < size:
                chunk = connection.recv(size - len(data))
                if not chunk:
                    raise EOFError
                data += chunk
            return data
        header = exact(1)[0]
        remaining = 0
        multiplier = 1
        for _ in range(4):
            byte = exact(1)[0]
            remaining += (byte & 127) * multiplier
            if byte < 128:
                break
            multiplier *= 128
        exact(remaining)
        return header >> 4

    def serve(self):
        while not self.done.is_set():
            try:
                connection, _ = self.socket.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            with connection:
                connection.settimeout(0.2)
                try:
                    if self.packet(connection) != 1:
                        continue
                    connection.sendall(b"\x20\x02\x00\x00")
                    self.counts.append(0)
                    while not self.done.is_set():
                        try:
                            if self.packet(connection) == 3:
                                self.counts[-1] += 1
                        except socket.timeout:
                            continue
                except (EOFError, OSError):
                    pass

    def close(self):
        self.done.set()
        self.socket.close()
        self.thread.join(timeout=2)


def bounded_queue_test(binary):
    broker = NoAckBroker()
    reader = None
    try:
        reader = Reader(binary, broker.port)
        time.sleep(5.5)
        check(len(reader.samples) >= 15, "Missing ACKs blocked Modbus polling")
        check(len(broker.counts) >= 2, "Missing ACKs did not trigger reconnect")
        check(all(count <= 2 for count in broker.counts), "Unbounded publish queue")
        reader.stop()
        reader = None
    finally:
        if reader is not None:
            reader.stop(abrupt=True)
        broker.close()


def blocked_diagnostics_test(binary):
    broker = NoAckBroker()
    read_fd, write_fd = os.pipe()
    reader = None
    try:
        os.set_blocking(write_fd, False)
        try:
            while True:
                os.write(write_fd, b"x" * 4096)
        except BlockingIOError:
            pass
        os.set_blocking(write_fd, True)
        reader = Reader(binary, broker.port, stderr=write_fd)
        time.sleep(1.5)
        check(len(reader.samples) >= 4, "Full stderr blocked MQTT/Modbus mutex")
        reader.stop()
        reader = None
    finally:
        if reader is not None:
            reader.stop(abrupt=True)
        os.close(read_fd)
        os.close(write_fd)
        broker.close()


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="evse-mqtt-test-") as directory:
        # Mosquitto drops privileges when started by root inside the build container.
        os.chmod(directory, 0o755)
        test(sys.argv[1], Path(directory))
        authenticated_test(sys.argv[1], Path(directory))
        bounded_queue_test(sys.argv[1])
        blocked_diagnostics_test(sys.argv[1])
    print("MQTT state, health, reconnect, auth, bounded queue, shutdown and Will tests passed")
