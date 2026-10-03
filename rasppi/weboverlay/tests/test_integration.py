"""Real isolated MQTT broker -> production Gunicorn -> HTTP, inside Docker only."""

import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request

from test_state import sample


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class IntegrationTests(unittest.TestCase):
    def test_mqtt_http_lifecycle(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            path.chmod(0o755)
            mqtt_port, web_port = free_port(), free_port()
            config = path / "mosquitto.conf"
            config.write_text(f"listener {mqtt_port} 127.0.0.1\nallow_anonymous true\npersistence false\n")
            broker = None
            with (path / "web.log").open("w+") as log:
                env = dict(os.environ, MQTT_HOST="127.0.0.1", MQTT_PORT=str(mqtt_port),
                           MQTT_CLIENT_ID="isolated-web-test", MQTT_TOPIC_PREFIX="test/wallbox",
                           MQTT_USERNAME="", MQTT_PASSWORD="", MQTT_PASSWORD_FILE="", WEB_STALE_SECONDS="3")
                web = subprocess.Popen(["gunicorn", "--bind", f"127.0.0.1:{web_port}", "--workers", "1",
                                        "--threads", "4", "--graceful-timeout", "2", "overlay.app:create_app()"],
                                       env=env, stdout=log, stderr=log)
                try:
                    def get_state():
                        with urllib.request.urlopen(f"http://127.0.0.1:{web_port}/api/state", timeout=2) as result:
                            return json.load(result)

                    def expect(status, timeout=10):
                        deadline = time.monotonic() + timeout
                        last = None
                        while time.monotonic() < deadline:
                            try:
                                last = get_state()
                                if last["status"] == status:
                                    if status != "live":
                                        self.assertIsNone(last["values"])
                                    return last
                            except (OSError, urllib.error.URLError):
                                pass
                            time.sleep(0.05)
                        self.fail(f"Expected {status}, got {last}")

                    def start_broker():
                        proc = subprocess.Popen(["mosquitto", "-c", str(config)], stdout=log, stderr=log)
                        deadline = time.monotonic() + 3
                        while time.monotonic() < deadline:
                            try:
                                with socket.create_connection(("127.0.0.1", mqtt_port), timeout=0.1):
                                    return proc
                            except OSError:
                                time.sleep(0.05)
                        proc.terminate()
                        proc.wait(timeout=3)
                        self.fail("Isolated broker failed to start")

                    def publish(suffix, message):
                        payload = json.dumps(message) if isinstance(message, dict) else message
                        subprocess.run(["mosquitto_pub", "-h", "127.0.0.1", "-p", str(mqtt_port),
                                        "-t", "test/wallbox/" + suffix, "-m", payload, "-r", "-q", "1"],
                                       check=True, timeout=3)

                    expect("offline")  # Web/API must start even with absent broker.
                    broker = start_broker()
                    publish("state", sample(time.time() - 60))
                    publish("availability", "online")
                    expect("stale")  # Retained online + old successful sample is not live.
                    publish("state", sample(time.time()))
                    live = expect("live")
                    self.assertEqual(live["values"]["current_limit_a"], 6)
                    self.assertFalse(live["values"]["charging"])
                    expect("stale", timeout=5)  # No new MQTT messages, HTTP stays up.
                    publish("state", "not-json")
                    expect("invalid")
                    publish("state", sample(time.time()))
                    expect("live")
                    publish("availability", "offline")
                    expect("offline")
                    publish("availability", "online")
                    expect("live")
                    failed = sample(time.time())
                    failed.update(status="error", values=None, error="read: timeout")
                    publish("state", failed)
                    expect("read_error")
                    broker.terminate()
                    broker.wait(timeout=3)
                    broker = None
                    expect("offline")
                    broker = start_broker()
                    expect("waiting")  # Old sample and availability were cleared.
                    publish("state", sample(time.time()))
                    expect("waiting")
                    publish("availability", "online")
                    expect("live")
                    with urllib.request.urlopen(f"http://127.0.0.1:{web_port}/", timeout=2) as response:
                        self.assertIn(b"<!", response.read())
                finally:
                    web.send_signal(signal.SIGTERM)
                    try:
                        web.wait(timeout=7)
                    except subprocess.TimeoutExpired:
                        web.kill()
                        web.wait(timeout=3)
                        self.fail("Web server did not stop within grace period")
                    finally:
                        if broker:
                            broker.terminate()
                            broker.wait(timeout=3)
                        log.seek(0)
                        output = log.read()
                        if web.returncode != 0:
                            print(output)
                    self.assertEqual(web.returncode, 0, output)
