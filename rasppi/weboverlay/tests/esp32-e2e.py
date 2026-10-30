"""Disposable Linux/Docker full-path test; never run against a deployed service.

Real HTTP public router -> PHP MQTT -> Mosquitto -> production Python Gateway
-> Linux PTY -> unchanged native firmware Gateway/Security/ChargeMirror.
The C++ adapter substitutes memory storage, entropy, clock and hardware IO only.
No ESP32 flashing, electrical/servo/NVS/presence or ARM claim is made.
An outer 120-second watchdog includes cache admission pacing and cleanup.
"""
import collections
import datetime
import http.cookiejar
import json
import os
import pty
import select
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import tty
import urllib.error
import urllib.request
import uuid

import paho.mqtt.client as mqtt

ROOT = "/esp32-e2e"
UID = "01:23:45:67"  # Synthetic fixture, never printed or retained in traces.


def check(condition, label):
    if not condition:
        raise RuntimeError(label)


def until(predicate, seconds=5):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(0.02)
    raise RuntimeError("bounded condition not met")


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Fixture:
    def __init__(self):
        self.children = []
        self.done = threading.Event()
        self.guard = threading.RLock()
        self.write_guard = threading.Lock()
        self.threads = []
        self.admissions = collections.deque(maxlen=128)
        self.operations = collections.Counter()
        self.last_mirror = -100
        self.state = None
        self.state_version = 0
        self.drop_lock = False
        self.dropped = 0
        self.unsupported = False
        self.bad = False
        self.replies = {}
        self.client = None
        self.stage = "startup"
        self.master = self.slave = None
        self.temp = tempfile.TemporaryDirectory(prefix="evse-esp32-e2e-")

    def spawn(self, args, **kwargs):
        child = subprocess.Popen(args, stderr=subprocess.DEVNULL, **kwargs)
        self.children.append(child)
        return child

    def send_probe(self, line):
        with self.write_guard:
            self.probe.stdin.write((line + "\n").encode("ascii"))
            self.probe.stdin.flush()

    def task(self, function):
        def guarded():
            try:
                function()
            except Exception:
                if not self.done.is_set():
                    self.bad = True
        thread = threading.Thread(target=guarded, daemon=True)
        self.threads.append(thread)
        thread.start()

    def relay_uart(self):
        pending = b""
        while not self.done.is_set():
            if not select.select([self.master], [], [], 0.05)[0]:
                continue
            data = os.read(self.master, 512)
            if not data:
                return
            pending += data
            check(len(pending) <= 1024, "PTY frame budget")
            while b"\n" in pending:
                wire, pending = pending.split(b"\n", 1)
                line = wire.rstrip(b"\r").decode("ascii")
                check(len(line) <= 192, "UART frame budget")
                parts = line.split(":")
                check(parts[:2] == ["CMD", "GATEWAY"], "no legacy fallback")
                op = "HELLO" if parts[2] == "HELLO" else parts[4] if parts[4] == "STATUS" else parts[5]
                with self.guard:
                    self.admissions.append(time.monotonic())
                    self.operations[op] += 1
                    if op == "MIRROR":
                        self.last_mirror = time.monotonic()
                if self.unsupported and op == "HELLO":
                    os.write(self.master, b"EVSE:ERROR:UNKNOWN_CMD\n")
                else:
                    self.send_probe(line)

    def relay_probe(self):
        while not self.done.is_set():
            data = self.probe.stdout.readline(513)
            if not data:
                return
            check(len(data) <= 512 and data.endswith(b"\n"), "native frame budget")
            text = data.decode("ascii").rstrip("\n")
            if text.startswith("STATE|"):
                with self.guard:
                    self.state = text.split("|")[1:]
                    self.state_version += 1
            else:
                check(text.startswith("UART|"), "native output vocabulary")
                wire = text[5:]
                check(UID not in wire, "UID leaked by firmware adapter")
                if self.drop_lock and ":LOCK:" in wire:
                    self.drop_lock = False
                    self.dropped += 1
                else:
                    os.write(self.master, (wire + "\n").encode("ascii"))

    def native_state(self):
        old = self.state_version
        self.send_probe("@STATE")
        until(lambda: self.state_version > old, 1)
        return self.state

    def headroom(self, needed):
        # Observe actual writes; do not alter clocks, limits or production Gateway.
        # Leave room for its periodic two-command mirror transaction as well.
        def available():
            check(not self.bad, "relay/observer failure")
            with self.guard:
                recent = sum(time.monotonic() - t < 10.3 for t in self.admissions)
                return recent <= 8 - needed - 2
        until(available, 15)

    def start_gateway(self):
        self.gateway = self.spawn([sys.executable, "-c",
            "import uart_gateway; raise SystemExit(uart_gateway.main())"],
            cwd=ROOT, env=self.env, stdout=subprocess.DEVNULL)

    def stop_gateway(self):
        self.gateway.terminate()
        try:
            self.gateway.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.gateway.kill()
            self.gateway.wait(timeout=1)
            raise RuntimeError("gateway shutdown deadline")
        check(self.gateway.returncode == 0, "gateway graceful exit")

    def start(self):
        broker_port, web_port = free_port(), free_port()
        while web_port == broker_port:
            web_port = free_port()
        self.origin = f"http://127.0.0.1:{web_port}"
        self.endpoint = self.origin + "/api/esp32-control"
        config = os.path.join(self.temp.name, "mosquitto.conf")
        with open(config, "w", encoding="ascii") as stream:
            stream.write(f"listener {broker_port} 127.0.0.1\nallow_anonymous true\npersistence false\nlog_type none\n")
        self.spawn(["mosquitto", "-c", config], stdout=subprocess.DEVNULL)
        def listening():
            try:
                with socket.create_connection(("127.0.0.1", broker_port), 0.1):
                    return True
            except OSError:
                return False
        until(listening)
        self.master, self.slave = pty.openpty()
        tty.setraw(self.slave)
        self.env = dict(os.environ, MQTT_HOST="127.0.0.1", MQTT_PORT=str(broker_port),
            MQTT_USERNAME="", MQTT_PASSWORD="", MQTT_PASSWORD_FILE="",
            MQTT_TOPIC_PREFIX="fixture/wallbox", WALLBOX_MQTT_TOPIC_PREFIX="fixture/wallbox",
            ESP32_MQTT_TOPIC_PREFIX="fixture/esp32", ESP32_MQTT_CLIENT_ID="fixture-uart",
            UART_MODE="gateway", UART_PORT=os.ttyname(self.slave), WEB_CONTROL_ORIGIN=self.origin)
        self.probe = self.spawn([ROOT + "/firmware-probe"], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, bufsize=0)
        self.task(self.relay_uart)
        self.task(self.relay_probe)
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
                                  client_id="fixture-observer", protocol=mqtt.MQTTv311)
        self.subscribed = False
        def connected(client, userdata, flags, reason, properties):
            client.subscribe("fixture/esp32/control/result/+", qos=1)
        def subscribed(client, userdata, mid, codes, properties):
            self.subscribed = len(codes) == 1 and codes[0].value <= 1
        def message(client, userdata, msg):
            try:
                check(UID.encode() not in msg.payload and b'"uid"' not in msg.payload,
                      "UID leaked in MQTT result")
                result = json.loads(msg.payload)
                check(len(msg.payload) <= 4096 and not msg.retain, "MQTT result envelope")
                with self.guard:
                    # Bounded result observer, never stores request payload/UID.
                    if len(self.replies) >= 128:
                        self.replies.pop(next(iter(self.replies)))
                    self.replies[result["id"]] = result
            except Exception:
                self.bad = True
        self.client.on_connect = connected
        self.client.on_subscribe = subscribed
        self.client.on_message = message
        self.client.connect("127.0.0.1", broker_port, 15)
        self.client.loop_start()
        until(lambda: self.subscribed)
        self.start_gateway()
        until(lambda: self.operations["MIRROR"] >= 1)
        check(os.path.isfile("/app/public/index.php"), "integrated Web image missing")
        self.spawn(["php", "-d", "display_errors=0", "-S", f"127.0.0.1:{web_port}",
                    "-t", "/app/public", "/app/public/index.php"],
                   cwd="/app", env=self.env, stdout=subprocess.DEVNULL)
        self.cookies = http.cookiejar.CookieJar()
        self.http = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies))
        def ready():
            try:
                return self.request(method="OPTIONS")[0] == 405
            except OSError:
                return False
        until(ready)

    def request(self, operation=None, method=None, headers=None, suffix="", body=None):
        h = {} if headers is None else headers.copy()
        if operation:
            h.update(Origin=self.origin, **{"X-CSRF-Token": self.csrf,
                                          "Content-Type": "application/json"})
            body = json.dumps(operation).encode("ascii")
        req = urllib.request.Request(self.endpoint + suffix, data=body, headers=h,
                                     method=method or ("POST" if body is not None else "GET"))
        try:
            response = self.http.open(req, timeout=13)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            payload = response.read(8193)
            check(len(payload) <= 8192 and UID.encode() not in payload and b'"uid"' not in payload,
                  "HTTP redaction/size")
            data = json.loads(payload) if payload else None
            if data and data.get("csrf"):
                self.csrf = data["csrf"]
            return response.status, data

    def inspect(self):
        self.headroom(1)
        code, data = self.request()
        check(code == 200 and data["status"] == "ok", "real GET inspection")
        check(data["command_sent"] is False and data["inspection"]["command_sent"] is False,
              "read-only inspection is not a mutation")
        return data["inspection"]

    def post(self, op, uid=None):
        self.headroom(2)
        code, data = self.request({"operation": op, **({"uid": uid} if uid else {})})
        check(code == 200 and data["status"] == "ok" and data["command_sent"] is True,
              "real POST acknowledgement: " + op)
        check(data["command"]["status"] == "acknowledged", "strict firmware ACK")
        return data

    def sample(self):
        stamp = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="microseconds")
        return json.dumps(dict(schema_version=1, device="abb_terra_ac", status="ok", error=None,
            timestamp=stamp, last_success_at=stamp, values=dict(error_code=0, socket_lock_state=257,
            charging_state_raw=768, charging_state=3, active_power_w=4140, session_energy_wh=0,
            charging=True, plugged_in=True, below_commanded_current=False,
            current_limit_a=6, current_a=[6, 6, 6], voltage_v=[230, 230, 230])))

    def publish(self, topic, payload):
        info = self.client.publish(topic, payload, qos=0, retain=False)
        info.wait_for_publish(timeout=1)
        check(info.is_published(), "fixture publish deadline")

    def close(self):
        self.done.set()
        if self.client:
            self.client.disconnect()
            self.client.loop_stop()
        for child in reversed(self.children):
            if child.poll() is None:
                child.terminate()
        deadline = time.monotonic() + 3
        for child in reversed(self.children):
            try:
                child.wait(timeout=max(0.01, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=1)
        for thread in self.threads:
            thread.join(timeout=0.2)
        for fd in (self.master, self.slave):
            if fd is not None:
                os.close(fd)
        self.temp.cleanup()


def run(f):
    f.start()
    f.stage = "inspection-and-http-rejections"
    initial = f.inspect()
    check(initial["state"]["charging"] is None and initial["lease"],
          "unknown charging preserves management lease")
    before = sum(f.operations.values())
    for kwargs, expected in [
        ({"method": "POST", "body": b'{"operation":"lock"}',
          "headers": {"Origin": "http://foreign.invalid"}}, 403),
        ({"method": "POST", "body": b'{"operation":"lock"}',
          "headers": {"Origin": f.origin, "X-CSRF-Token": "wrong",
                      "Content-Type": "application/json"}}, 403),
        ({"suffix": "?invalid=1"}, 400),
    ]:
        check(f.request(**kwargs)[0] == expected, "HTTP rejection")
    # Periodic MIRROR/STATUS traffic may continue; management must not.
    check(f.operations["LOCK"] == f.operations["UNLOCK"] == 0, "invalid HTTP mutated UART")
    check(sum(f.operations.values()) >= before, "monotonic trace")
    f.stage = "native-management"
    f.post("unlock")
    check(f.native_state()[0] == "0", "native unlocked target")
    f.post("lock")
    check(f.native_state()[0] == "1", "native locked target")
    f.post("enroll")
    check(f.native_state()[2] == "1", "native enrollment active")
    f.send_probe("@CARD")
    until(lambda: f.native_state()[1] == "1")
    f.post("revoke", UID)
    check(f.native_state()[1:3] == ["0", "0"], "native revocation")
    f.post("enroll")
    f.post("cancel")
    check(f.native_state()[2] == "0", "native enrollment cancelled")

    # Real Wallbox MQTT -> production mirror -> native ChargeMirror. Repeating
    # the identical timestamp/payload must NOT postpone its original expiry.
    f.stage = "mirror-expiry"
    f.publish("fixture/wallbox/availability", "online")
    sample = f.sample()
    published = time.monotonic()
    f.publish("fixture/wallbox/state", sample)
    until(lambda: f.native_state()[3] == "ON", 9)
    while time.monotonic() - published < 11:
        f.publish("fixture/wallbox/state", sample)
        time.sleep(0.25)
    until(lambda: f.native_state()[3] == "UNKNOWN", 5)
    f.publish("fixture/wallbox/availability", "offline")
    check(f.inspect()["state"]["charging"] is None, "offline is UNKNOWN not OFF")
    f.post("unlock")  # Unknown/offline charging does not disable management.
    check(f.native_state()[0] == "0", "offline management allowed")

    f.stage = "lost-ack-and-read-only-recovery"
    f.headroom(2)
    count = f.operations["LOCK"]
    f.drop_lock = True
    code, data = f.request({"operation": "lock"})
    check(code == 504 and data["status"] == "outcome_unknown" and data["command_sent"],
          "lost real UART ACK has unknown outcome")
    check(f.dropped == 1 and f.native_state()[0] == "1", "action happened before dropped ACK")
    recovered = f.inspect()
    check(f.operations["LOCK"] == count + 1, "GET never resends unknown mutation")
    check(recovered["state"]["antitheft"] is True, "read-only recovery sees native target")

    # Restart invalidates the gateway lease/session, even while native boot stays.
    f.stage = "restart-stale-session"
    f.stop_gateway()
    f.start_gateway()
    until(lambda: f.operations["HELLO"] >= 3)
    rid = uuid.uuid4().hex
    old_count = f.operations["UNLOCK"]
    f.publish("fixture/esp32/control/request",
              f"v1|{rid}|{recovered['session']}|{recovered['lease']}|unlock|-")
    until(lambda: rid in f.replies)
    check(f.replies[rid]["reason"] == "invalid_session" and
          f.replies[rid]["command_sent"] is False, "old session rejected after restart")
    check(f.operations["UNLOCK"] == old_count, "stale session never reaches UART mutation")
    check(f.operations["LOCK"] == count + 1, "unknown mutation never replayed after restart")

    # Old firmware emulation is ONLY this negative branch, not the normal path.
    f.stage = "unsupported-firmware"
    f.stop_gateway()
    f.unsupported = True
    f.start_gateway()
    f.headroom(1)
    code, data = f.request()
    check(code == 503 and data["command_sent"] is False and
          data["inspection"]["reason"] == "firmware_unsupported", "unsupported firmware fails closed")
    check(not f.bad, "redaction/relay observer")
    f.stop_gateway()


def main():
    def expired(signum, frame):
        raise RuntimeError("suite deadline")
    signal.signal(signal.SIGALRM, expired)
    signal.alarm(120)
    fixture = Fixture()
    try:
        run(fixture)
        print("ESP32 disposable full-path/native-core checks passed; no hardware claim", flush=True)
        return 0
    except Exception:
        # Never emit exception repr, HTTP bodies, MQTT payloads or UART frames.
        print("ESP32 disposable full-path checks failed at " + fixture.stage +
              " (payloads and exception details redacted)", file=sys.stderr)
        return 1
    finally:
        fixture.close()
        signal.alarm(0)


if __name__ == "__main__":
    raise SystemExit(main())
