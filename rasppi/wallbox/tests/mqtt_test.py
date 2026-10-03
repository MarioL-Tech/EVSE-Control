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
    def __init__(self, directory):
        self.port = free_port()
        self.config = directory / "mosquitto.conf"
        self.config.write_text(
            f"listener {self.port} 127.0.0.1\nallow_anonymous true\npersistence false\n")
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
                 "-t", "test/wallbox/" + suffix, "-C", "1", "-W", "1", "-q", "1"],
                capture_output=True, text=True, timeout=2)
            if result.returncode == 0:
                value = result.stdout.strip()
                if predicate(value):
                    return value
            time.sleep(0.05)
        raise AssertionError("Expected MQTT " + suffix + " message not received")


class Reader:
    def __init__(self, binary, port):
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
        self.log = tempfile.TemporaryFile(mode="w+")
        self.process = subprocess.Popen(
            [binary, "--device", os.ttyname(self.slave), "--interval-ms", "200",
             "--timeout-ms", "100"], env=env, stdout=subprocess.PIPE,
            stderr=self.log, text=True)
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


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="evse-mqtt-test-") as directory:
        # Mosquitto drops privileges when started by root inside the build container.
        os.chmod(directory, 0o755)
        test(sys.argv[1], Path(directory))
    print("MQTT retained state, health, reconnect, polling independence, shutdown and Will tests passed")
