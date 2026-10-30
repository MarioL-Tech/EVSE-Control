"""Container-only real PTY, loopback Mosquitto, header-only hostile peer tests."""
import os
import json
import pty
import select
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import paho.mqtt.client as mqtt
import serial
from uart_gateway import CappedClient, Gateway
from uart_gateway_unit import STATUS


def wait_until(check, seconds=3):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(.01)
    return False


class PtyFirmware:
    def __init__(self):
        self.master, self.slave = pty.openpty()
        self.port = serial.Serial(os.ttyname(self.slave), 115200, timeout=.02,
                                  write_timeout=.2, exclusive=True)
        self.stop = threading.Event()
        self.count = 0
        self.thread = threading.Thread(target=self.run)
        self.thread.start()
    def run(self):
        buffer = bytearray()
        while not self.stop.is_set():
            if not select.select([self.master], [], [], .02)[0]:
                continue
            buffer.extend(os.read(self.master, 1024))
            while b"\n" in buffer:
                line, _, rest = buffer.partition(b"\n")
                buffer = bytearray(rest)
                parts = line.decode("ascii").split(":")
                self.count += 1
                if parts[2] == "HELLO":
                    response = f"EVSE:GATEWAY:HELLO:{parts[3]}:{'b'*32}:2\n"
                elif parts[-1] == "STATUS":
                    response = "\n".join(STATUS) + f"\nEVSE:GATEWAY:RESULT:{parts[2]}:{parts[3]}:STATUS:OK:{'c'*32}:8\n"
                else:
                    response = f"EVSE:GATEWAY:RESULT:{parts[2]}:{parts[3]}:{parts[5]}:OK\n"
                os.write(self.master, response.encode())
    def close(self):
        self.stop.set()
        self.thread.join(2)
        self.port.close()
        os.close(self.master)
        os.close(self.slave)


class PacketLimitTests(unittest.TestCase):
    def packet(self, length):
        encoded = bytearray([0x30])
        while True:
            digit = length % 128
            length //= 128
            encoded.append(digit | (128 if length else 0))
            if not length:
                return bytes(encoded)
    def test_oversize_header_never_reads_body_and_pty_keeps_working(self):
        firmware = PtyFirmware()
        gateway = Gateway(firmware.port)
        gateway.ready = True
        try:
            for length in (32769, 64*1024*1024):
                client = CappedClient(mqtt.CallbackAPIVersion.VERSION2)
                left, right = socket.socketpair()
                left.setblocking(False)
                client._sock = left
                try:
                    right.sendall(self.packet(length))  # HEADER ONLY; no body to allocate.
                    self.assertEqual(client._packet_read(), mqtt.MQTT_ERR_CONN_LOST)
                    self.assertEqual(len(client._in_packet["packet"]), 0)
                    self.assertLessEqual(len(client._in_packet["remaining_count"]), 4)
                    client._sock_close()
                    gateway.inspect()
                    self.assertTrue(gateway.state["store_ready"])
                finally:
                    left.close()
                    right.close()
            self.assertGreaterEqual(firmware.count, 3)
        finally:
            firmware.close()
    def test_4096_body_passes_upstream_framing(self):
        client = CappedClient(mqtt.CallbackAPIVersion.VERSION2)
        left, right = socket.socketpair()
        left.setblocking(False)
        client._sock = left
        received = []
        client.on_message = lambda c, u, m: received.append(m.payload)
        try:
            body = b"\x00\x01t" + b"x"*4096
            right.sendall(self.packet(len(body)) + body)
            self.assertEqual(client._packet_read(), mqtt.MQTT_ERR_SUCCESS)
            self.assertEqual(received, [b"x"*4096])
        finally:
            left.close()
            right.close()
    def test_library_version_and_structure_fail_closed(self):
        from unittest.mock import patch
        with patch("uart_gateway.importlib.metadata.version", return_value="9.0"):
            with self.assertRaises(RuntimeError):
                CappedClient(mqtt.CallbackAPIVersion.VERSION2)


class BrokerTests(unittest.TestCase):
    def test_loopback_broker_and_real_pty_with_clean_shutdown(self):
        firmware = PtyFirmware()
        gateway = Gateway(firmware.port)
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "mosquitto.conf")
            # Isolated loopback listener, never a production broker/network.
            with socket.socket() as reservation:
                reservation.bind(("127.0.0.1", 0))
                port = reservation.getsockname()[1]
            with open(path, "w", encoding="ascii") as stream:
                stream.write(f"listener {port} 127.0.0.1\nallow_anonymous true\npersistence false\n")
            os.chmod(folder, 0o755)
            process = subprocess.Popen(["mosquitto", "-c", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            client = CappedClient(mqtt.CallbackAPIVersion.VERSION2, client_id="isolated-uart-tests", clean_session=True)
            client.on_connect = gateway.on_connect
            client.on_subscribe = gateway.on_subscribe
            client.on_disconnect = gateway.on_disconnect
            client.on_message = gateway.on_message
            publisher = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="isolated-test-publisher")
            try:
                def listening():
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=.05):
                            return True
                    except OSError:
                        return False
                self.assertTrue(wait_until(listening))
                client.connect("127.0.0.1", port, 10)
                client.loop_start()
                publisher.connect("127.0.0.1", port, 10)
                publisher.loop_start()
                self.assertTrue(wait_until(lambda: gateway.ready))
                request = f"v1|{'a'*32}|-|-|inspect|-"
                publisher.publish(gateway.prefix+"/control/request", request, qos=0).wait_for_publish(2)
                self.assertTrue(wait_until(lambda: not gateway.requests.empty()))
                answer = gateway.handle(gateway.requests.get_nowait())
                self.assertEqual(answer["reason"], "inspection_complete")
                self.assertGreaterEqual(firmware.count, 2)
                # Valid transport frame, invalid application body: no work admitted.
                publisher.publish(gateway.prefix+"/control/request", b"x"*4096, qos=0).wait_for_publish(2)
                time.sleep(.05)
                self.assertTrue(gateway.requests.empty())
                client.disconnect()
                self.assertTrue(wait_until(lambda: not gateway.ready))
                gateway.invalidate()
                self.assertFalse(gateway.leases)
            finally:
                publisher.disconnect()
                publisher.loop_stop()
                client.disconnect()
                client.loop_stop()
                process.terminate()
                process.wait(timeout=3)
                firmware.close()

    def test_full_owner_loop_result_dedupe_retained_and_shutdown(self):
        firmware = PtyFirmware()
        gateway = Gateway(firmware.port)
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "mosquitto.conf")
            with socket.socket() as reservation:
                reservation.bind(("127.0.0.1", 0))
                port = reservation.getsockname()[1]
            with open(path, "w", encoding="ascii") as stream:
                stream.write(f"listener {port} 127.0.0.1\nallow_anonymous true\npersistence false\n")
            os.chmod(folder, 0o755)
            process = subprocess.Popen(["mosquitto", "-c", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            publisher = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="owner-loop-publisher")
            subscribed = threading.Event()
            answers = []
            publisher.on_subscribe = lambda *args: subscribed.set()
            publisher.on_message = lambda c, u, m: answers.append(json.loads(m.payload))
            owner = threading.Thread(target=gateway.run, daemon=True)
            try:
                def listening():
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=.05):
                            return True
                    except OSError:
                        return False
                self.assertTrue(wait_until(listening))
                publisher.connect("127.0.0.1", port, 10)
                publisher.loop_start()
                publisher.subscribe(gateway.prefix+"/control/result/+", qos=1)
                self.assertTrue(subscribed.wait(2))
                request_topic = gateway.prefix+"/control/request"
                # Stored before subscription, this must be rejected as retained.
                publisher.publish(request_topic, f"v1|{'f'*32}|-|-|inspect|-", retain=True).wait_for_publish(2)
                with patch.dict(os.environ, {"MQTT_HOST": "127.0.0.1", "MQTT_PORT": str(port),
                        "ESP32_MQTT_CLIENT_ID": "isolated-owner-loop", "MQTT_USERNAME": "",
                        "MQTT_PASSWORD_FILE": "", "MQTT_PASSWORD": ""}):
                    owner.start()
                    self.assertTrue(wait_until(lambda: gateway.ready and firmware.count >= 3))
                    gateway.next_mirror = time.monotonic() + 60  # Isolate dedupe assertion from periodic refresh.
                    publisher.publish(request_topic, b"", retain=True).wait_for_publish(2)
                    publisher.publish(request_topic, f"v1|{'a'*32}|-|-|inspect|-").wait_for_publish(2)
                    self.assertTrue(wait_until(lambda: len(answers) >= 1))
                    inspected = next(a for a in answers if a["id"] == "a"*32)
                    self.assertEqual(inspected["reason"], "inspection_complete")
                    command = f"v1|{'d'*32}|{inspected['session']}|{inspected['lease']}|unlock|-"
                    publisher.publish(request_topic, command).wait_for_publish(2)
                    self.assertTrue(wait_until(lambda: any(a["id"] == "d"*32 for a in answers)))
                    self.assertEqual(next(a for a in answers if a["id"] == "d"*32)["status"], "acknowledged")
                    before = firmware.count
                    length = len(answers)
                    publisher.publish(request_topic, command).wait_for_publish(2)
                    self.assertTrue(wait_until(lambda: len(answers) > length))
                    self.assertEqual(firmware.count, before)
                    self.assertFalse(any(a["id"] == "f"*32 for a in answers))
                    gateway.stopping = True
                    owner.join(4)
                    self.assertFalse(owner.is_alive())
                    self.assertFalse(firmware.port.is_open)
            finally:
                gateway.stopping = True
                if owner.ident:
                    owner.join(4)
                publisher.disconnect()
                publisher.loop_stop()
                process.terminate()
                process.wait(timeout=3)
                firmware.close()


if __name__ == "__main__":
    unittest.main()
