"""Docker-only real reader + isolated broker, PTY and loopback HTTP. No hardware."""
import datetime
import http.server
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid

from mqtt_test import Broker
from write_test import Parser, check, framed, pair, read_response


def wait(predicate, message, seconds=7):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.03)
    raise AssertionError(message)


class Fixture:
    def __init__(self, binary, directory, interval_ms=300, timeout_ms=200):
        self.lock = threading.Lock()
        self.activation = uuid.uuid4().hex
        self.guard = "1" * 32
        self.topology = None
        self.mode = "pv"
        self.house = "live"
        self.stamp = None
        self.import_w = 0
        self.power = -4500  # three phases * 230 V => conservative 6 A
        self.limit = 32000
        self.effective = 6000
        self.running = False
        self.drop = False
        self.drop_start = False
        self.mismatch = False
        self.delay_preparation = False
        self.prepared = False
        self.change_on_prepare = self.preflight_state = None
        self.changed_reads = []
        self.ignore_reduction = None
        self.omit_effective = False
        self.lost_readback = threading.Event()
        self.slow_invalid_cap = False
        self.fail_next_cap = False
        self.gate_poll = threading.Event()
        self.gate_after_effective = False
        self.at_frame = threading.Event()
        self.published = threading.Event()
        self.writes = []
        self.reads = []
        self.errors = []
        self.done = threading.Event()
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                now = time.time()
                with fixture.lock:
                    if self.path == "/api/charging-plan":
                        p = dict(max_import_w=fixture.import_w, max_current_ma=fixture.limit,
                                 adjust_seconds=0, pause_seconds=0, resume_seconds=0)
                        value = dict(schema_version=1, status="ok", generated_at=now,
                                     fresh_for_seconds=6, config_revision="a" * 64,
                                     activation=dict(mode=fixture.mode, id=fixture.activation, guard=fixture.guard),
                                     config=dict(schema_version=1, timezone="Europe/Vienna",
                                                 manual=dict(current_ma=None), pv=p,
                                                 custom=dict(p, use_schedule=False, pv_enabled=True,
                                                             weekdays=[], windows=[], outside_window="pause"),
                                                 installation=fixture.topology))
                    elif self.path == "/api/smartmeter":
                        stamp = fixture.stamp if fixture.stamp is not None else now - .05
                        value = dict(schema_version=1, status=fixture.house,
                                     power_w=fixture.power if fixture.house == "live" else None,
                                     fetched_at=datetime.datetime.fromtimestamp(stamp, datetime.timezone.utc)
                                     .strftime("%Y-%m-%dT%H:%M:%S.%fZ"), age_seconds=now-stamp,
                                     fresh_for_seconds=10-(now-stamp))
                    else:
                        fixture.errors.append("unexpected HTTP path")
                        self.send_error(404)
                        return
                self.send_response(200)
                self.end_headers()
                try:
                    self.wfile.write(json.dumps(value).encode())
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.http = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.http.start()
        self.broker = Broker(directory)
        self.master, self.slave = pty.openpty()
        self.log = tempfile.TemporaryFile(mode="w+")
        env = dict(os.environ, MQTT_ENABLED="true", MQTT_HOST="127.0.0.1",
                   MQTT_PORT=str(self.broker.port), MQTT_TOPIC_PREFIX="test/wallbox",
                   MQTT_CLIENT_ID="automation-owner-test", MQTT_USERNAME="", MQTT_PASSWORD="",
                   MQTT_PASSWORD_FILE="", WALLBOX_INSTALLATION_MAX_MA="32000",
                   WALLBOX_AUTOMATION_WEB_URL=f"http://127.0.0.1:{self.server.server_port}")
        self.process = subprocess.Popen([binary, "--device", os.ttyname(self.slave),
                                         "--interval-ms", str(interval_ms), "--timeout-ms", str(timeout_ms)],
                                        env=env, stdout=self.log, stderr=self.log)
        self.serial = threading.Thread(target=self.serve, daemon=True)
        self.serial.start()
        self.reply = None

    def serve(self):
        parser = Parser()
        try:
            while not self.done.is_set():
                if not select.select([self.master], [], [], .03)[0]:
                    continue
                for request in parser.feed(os.read(self.master, 512)):
                    gated = False
                    delay = 0
                    with self.lock:
                        function = request[1]
                        address = int.from_bytes(request[2:4], "big")
                        if function == 3:
                            self.reads.append((time.monotonic(), address))
                            if address == 0x4008:
                                words = [0] * 24
                                state = 4 if self.running else 1
                                decivolts = 2300
                                if self.preflight_state is not None:
                                    check(self.reads[-2][1] == 0x4006, "changed ordinary poll instead of Start preflight")
                                    state, decivolts = self.preflight_state
                                    self.preflight_state = None
                                    self.changed_reads.append((state, decivolts))
                                words[4:6] = pair(state << 8)
                                words[6:8] = pair(self.effective)
                                # U1..U3 are 0x4016..401B, scaled 0.1 V.
                                for index in (14, 16, 18):
                                    words[index:index+2] = pair(decivolts)
                                response = read_response(words)
                            elif address == 0x4004:
                                if self.fail_next_cap:
                                    self.fail_next_cap = False
                                    continue
                                response = read_response(pair(1) + pair(0 if self.slow_invalid_cap else 32000))
                            elif address == 0x4006:
                                response = read_response(pair(32000))
                            elif address == 0x400E:
                                if self.omit_effective:
                                    self.omit_effective = False
                                    self.lost_readback.set()
                                    continue  # FC16 already acknowledged; NO effective-limit observation
                                if self.gate_after_effective:
                                    self.gate_after_effective = False
                                    self.gate_poll.set()
                                response = read_response(pair(self.effective + (1000 if self.mismatch else 0)))
                            elif address == 0x400C:
                                response = read_response(pair((4 if self.running else 1) << 8))
                            else:
                                raise AssertionError("unexpected read " + hex(address))
                            if address == 0x4008 and self.gate_poll.is_set():
                                # Subscriber is already ready. Deliver Inspect during
                                # this full read, then leave ample time for optional
                                # cap I/O so the queue, not merely slack, must win.
                                self.gate_poll.clear()
                                self.at_frame.set()
                                gated = True
                                delay = .03
                            elif self.slow_invalid_cap and address in (0x4008, 0x4004):
                                delay = .37  # within 450 ms apiece; two exceed a 700-ms cycle
                        else:
                            self.writes.append((time.monotonic(), request))
                            if function == 16:
                                check(address == 0x4100, "arbitrary write")
                                target = struct.unpack(">I", request[7:11])[0]
                                if self.ignore_reduction:
                                    check(target < self.effective, "fixture did not request a reduction")
                                    self.omit_effective = self.ignore_reduction == "timeout"
                                    self.ignore_reduction = None  # keep higher physical limit despite the FC16 ACK
                                else:
                                    self.effective = target
                                self.prepared = True
                                self.preflight_state, self.change_on_prepare = self.change_on_prepare, None
                                if self.delay_preparation:
                                    self.delay_preparation = False
                                    self.at_frame.set()
                                    gated = True
                                    delay = .03
                            else:
                                check(address == 0x4105, "arbitrary command")
                                start = request[4:6] == b"\x00\x00"
                                check(not start or self.prepared, "Start without current preparation")
                                self.running = start
                                self.prepared = False
                            if self.drop:
                                self.drop = False
                                continue
                            if self.drop_start and function == 6 and request[4:6] == b"\x00\x00":
                                self.drop_start = False
                                continue
                            response = request[:6]
                    # Delay only the serial response, never the independent HTTP sources.
                    if gated:
                        check(self.published.wait(.14), "control request not published during held RTU frame")
                    if delay:
                        time.sleep(delay)
                    os.write(self.master, framed(response))
        except BaseException as error:
            self.errors.append(str(error))

    def command(self, operation="inspect", current=0, queue_at=None):
        identity = uuid.uuid4().hex
        session = self.reply["session"] if operation != "inspect" else "-"
        lease = self.reply["lease"] if operation != "inspect" else "-"
        sub = subprocess.Popen(["mosquitto_sub", "-h", "127.0.0.1", "-p", str(self.broker.port),
                                "-t", "test/wallbox/control/result/" + identity, "-C", "1", "-W",
                                "12" if queue_at else "4"],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            time.sleep(.08)
            if queue_at:
                self.at_frame.clear()
                self.published.clear()
                queue_at()
                check(self.at_frame.wait(6), "no RTU frame to queue request in")
            subprocess.run(["mosquitto_pub", "-h", "127.0.0.1", "-p", str(self.broker.port),
                            "-t", "test/wallbox/control/request", "-m",
                            f"v1|{identity}|{session}|{lease}|{operation}|{current}"], check=True, timeout=2)
            if queue_at:
                self.published.set()
            output, error = sub.communicate(timeout=5)
            check(sub.returncode == 0, "no correlated owner reply: " + error)
            self.reply = json.loads(output)
            return self.reply
        finally:
            if sub.poll() is None:
                sub.kill()
                sub.wait()

    def arm(self, topology=True):
        self.activate(self.command(), topology)

    def activate(self, reply, topology=True):
        check(reply["status"] == "ok", "inspect failed")
        with self.lock:
            self.guard = reply["automation"]["guard"]
            self.activation = uuid.uuid4().hex
            self.topology = dict(phases=3, meter_includes_wallbox=True) if topology else None

    def close(self):
        self.process.terminate()
        self.process.wait(timeout=5)
        self.done.set()
        self.serial.join(timeout=2)
        self.server.shutdown()
        self.server.server_close()
        self.http.join(timeout=2)
        self.broker.stop()
        self.broker.log.close()
        os.close(self.master)
        os.close(self.slave)
        self.log.seek(0)
        diagnostic = self.log.read()
        self.log.close()
        check(not self.errors, str(self.errors))
        check(self.process.returncode == 0, diagnostic)


def run(binary, directory):
    f = Fixture(binary, directory)
    try:
        time.sleep(2.6)
        baseline = f.command()
        with f.lock:
            f.guard = baseline["automation"]["guard"]
            f.topology = dict(phases=3, meter_includes_wallbox=True)
        time.sleep(2.3)
        check(not f.writes, "persisted activation ran at startup")
        f.arm(topology=False)
        time.sleep(2.5)
        check(not f.writes, "missing topology permitted automatic writes")
        f.arm()
        wait(lambda: len(f.writes) >= 2, "fresh guarded PV did not start")
        first = [r for _, r in f.writes[:2]]
        check(first[0][1] == 16 and first[1] == bytes.fromhex("090641050000"), "compound order")
        check(struct.unpack(">I", first[0][7:11])[0] == 6000, "PV whole-amp calculation")
        # Cross the original 10 s cap TTL without a browser/manual inspection.
        # Stable healthy inputs must not cause Stop/restart oscillation; verify
        # an actual owner capability read, not a synthetic freshness extension.
        start_time = f.writes[1][0]
        wait(lambda: any(a == 0x4008 and t > start_time + 11 for t, a in f.reads),
             "no normal polls across capability TTL", seconds=15)
        check(any(a == 0x4004 and t > start_time for t, a in f.reads), "cap not reacquired")
        check(len(f.writes) == 2, "stable autonomous charging stopped/restarted on cap renewal")
        # Source loss while known running allows ONE protective Stop, never a restart.
        with f.lock:
            f.house = "unavailable"
        wait(lambda: any(r == bytes.fromhex("090641050001") for _, r in f.writes), "missing protective Stop")
        time.sleep(2.5)
        count = len(f.writes)
        time.sleep(.7)
        check(len(f.writes) == count, "source outage caused a write loop")
        old_guard = f.guard
        reply = f.command()
        f.reply = reply
        stopped = f.command("stop")
        new_guard = stopped["automation"]["guard"]
        check(new_guard != old_guard, "manual Stop did not rotate guard")
        with f.lock:
            f.house = "live"
            f.activation = uuid.uuid4().hex
            f.guard = old_guard
        count = len(f.writes)
        time.sleep(2.6)
        check(len(f.writes) == count, "delayed old guard overrode manual Stop")
        # New fetchedAt is mandatory; a heartbeat on an old observation cannot rearm.
        with f.lock:
            f.stamp = time.time() - 10
        f.arm()
        time.sleep(2.7)
        check(len(f.writes) == count, "expired same fetchedAt allowed IO")
        # Deliberately lose FC16 ACK: no Start, no resend, inspect cannot unfreeze.
        with f.lock:
            f.stamp = None
            f.drop = True
        f.arm()
        wait(lambda: len(f.writes) > count, "unknown-ACK case did not attempt")
        time.sleep(.7)
        unknown_count = len(f.writes)
        check(unknown_count == count + 1, "lost ACK retried or started")
        reply = f.command()
        check(reply["status"] == "ok", "explicit transport recovery failed")
        time.sleep(2.5)
        check(len(f.writes) == unknown_count, "Inspect unlatched automation freeze")
        check(f.command()["automation"]["state"] == "frozen", "unknown outcome not frozen")
        # Fresh guarded custom activation can recover deliberately. Higher readback
        # after acknowledged preparation must not send Start or claim aggregate ACK.
        with f.lock:
            f.mode = "custom"
            f.mismatch = True
        f.arm()
        wait(lambda: len(f.writes) > unknown_count, "custom action missing")
        time.sleep(.7)
        check(len(f.writes) == unknown_count + 1, "mismatched preparation sent Start")
        # Previous regular poll is plugged and NOT charging; only the actual
        # post-FC16, pre-FC06 full-block read changes. Check the wire and the
        # frozen aggregate outcome after later normal polls, not just a reason.
        # With 4500 W budget the ordinary 230 V poll permits 6 A; three
        # 260 V phases in the final full read no longer do (4680 W needed).
        for sample in ((0, 2300), (4, 2300), (1, 2600)):
            with f.lock:
                f.mismatch = False
                f.change_on_prepare = sample
            before = len(f.writes)
            f.arm()
            wait(lambda: sample in f.changed_reads, "changed Start preflight missing")
            check(f.command()["automation"]["state"] == "frozen", "partial preparation not frozen")
            check([r[1] for _, r in f.writes[before:]] == [16], "changed preflight issued FC06 or retried")
        # Manual Stop arriving DURING preparation cancels every subsequent IO.
        # A safely acknowledged partial preparation may freeze automation but
        # must not invalidate/drop that pending manual request.
        lease = f.command()
        def arm_preparation():
            with f.lock:
                f.delay_preparation = True
            f.activate(lease)
        before_race = len(f.writes)
        manual = f.command("stop", queue_at=arm_preparation)
        check(manual["status"] == "acknowledged", "queued manual Stop was lost")
        race = [r for _, r in f.writes[before_race:]]
        check(len(race) == 2 and race[0][1] == 16 and race[1] == bytes.fromhex("090641050001"),
              "manual Stop did not cancel compound Start")
        # Profile fractional amps clamp DOWN. Losing only the second compound
        # ACK must remain unknown overall, with no Start resend or automatic loop.
        with f.lock:
            f.limit = 16500
            f.power = -23000
            f.drop_start = True
        before_second_ack = len(f.writes)
        f.arm()
        wait(lambda: len(f.writes) >= before_second_ack + 2, "clamped compound Start missing")
        check(struct.unpack(">I", f.writes[before_second_ack][1][7:11])[0] == 16000,
              "profile was not whole-amp clamped down")
        time.sleep(.7)
        check(f.command()["status"] == "ok", "second-ACK transport recovery failed")
        time.sleep(2.4)
        check(len(f.writes) == before_second_ack + 2, "second compound ACK loss retried")
        check(f.command()["automation"]["state"] == "frozen", "partial Start incorrectly succeeded")
        # HTTP/Modbus regulation, especially protective Stop, cannot depend on
        # the manual MQTT transport being connected.
        with f.lock:
            f.mode = "pv"
            f.drop_start = False
        before_broker_loss = len(f.writes)
        f.arm()
        wait(lambda: len(f.writes) > before_broker_loss, "fresh activation before broker loss missing")
        # While charging at the acknowledged higher limit, lower the PV budget.
        # Return the exact FC16 echo but no 0x400E; later regular polls still
        # show the old effective limit. Do not treat a wire ACK as a reduction.
        with f.lock:
            check(f.running and f.effective == 16000, "missing higher running limit")
            f.ignore_reduction = "timeout"
            before_reduction = len(f.writes)
            f.power = -4500
        wait(f.lost_readback.is_set, "no reduction readback lost after FC16 ACK")
        wait(lambda: any(a == 0x4008 and t > f.writes[before_reduction][0] + .5 for t, a in f.reads),
             "no subsequent telemetry after readback timeout")
        check(f.command()["automation"]["state"] == "frozen", "unconfirmed reduction not frozen")
        check(len(f.writes) == before_reduction + 1 and f.effective == 16000 and
              f.writes[-1][1] == bytes.fromhex("0910410000020400001770"), "reduction repeated or effective limit invented")
        f.arm()  # new automatic plan alone cannot clear unconfirmed reduction under load
        time.sleep(2.5)
        check(len(f.writes) == before_reduction + 1 and f.command()["automation"]["state"] == "frozen",
              "automatic activation rearmed after an unconfirmed reduction")
        check(f.command("stop")["status"] == "acknowledged", "manual recovery failed")
        f.arm()
        wait(lambda: f.running and f.effective == 6000, "fresh activation after manual Stop failed")
        f.broker.stop()
        with f.lock:
            before_protection = len(f.writes)
            f.house = "unavailable"
        wait(lambda: any(r == bytes.fromhex("090641050001") for _, r in f.writes[before_protection:]),
             "broker loss blocked autonomous protective Stop")
        time.sleep(2.5)
        after_protection = len(f.writes)
        time.sleep(.7)
        check(len(f.writes) == after_protection, "broker loss caused automatic retries")
        # One serial owner: every auto write sequence is separated by normal polls.
        check(sum(a == 0x4008 for _, a in f.reads) > 20, "automation starved telemetry")
    finally:
        f.close()


def slow_cap(binary, directory):
    f = Fixture(binary, directory, interval_ms=700, timeout_ms=450)
    try:
        time.sleep(2.6)
        with f.lock:
            f.power = -11040  # 16 A at 3 x 230 V
        f.arm()
        wait(lambda: f.running and f.effective == 16000, "slow-cap fixture never started")
        # Contrast a valid but still-too-high readback with transport timeout:
        # on this healthy bus, exactly one protective Stop is possible.
        stop = bytes.fromhex("090641050001")
        before = len(f.writes)
        def reduce_after_subscribe():
            with f.lock:
                f.ignore_reduction = "stays_high"
                f.gate_after_effective = True
                f.power = -4500
        # Queue a passive Inspect on the decision that has the one-shot Stop.
        # Neither that ticket nor the Inspect may be lost.
        check(f.command(queue_at=reduce_after_subscribe)["status"] == "ok",
              "Inspect lost while one-shot protection was due")
        check(not f.running, "passive Inspect discarded the one-shot protective Stop")
        wait(lambda: any(a == 0x4008 and t > f.writes[-1][0] for t, a in f.reads), "no post-Stop poll")
        check([r for _, r in f.writes[before:]] == [bytes.fromhex("0910410000020400001770"), stop]
              and f.effective == 16000, "incorrect reduction recovery on healthy transport")
        f.arm()
        wait(lambda: f.running, "new activation after observed Stop failed")
        with f.lock:
            f.slow_invalid_cap = True
            start = time.monotonic()
        # Both the full poll and the cap return legally but together take
        # longer than the poll interval. No optional read fits this slot.
        invalid = f.command()
        check(invalid["status"] == "ok" and invalid["hardware_max_ma"] == 0, "invalid cap not exercised")
        wait(lambda: any(t > start and r == stop for t, r in f.writes), "cap refresh starved protective Stop")
        check(f.command(queue_at=f.gate_poll.set)["status"] == "ok", "optional cap starved manual pre-Stop Inspect")
        check(f.command("stop")["status"] == "acknowledged", "manual Stop lost after Inspect")
        check([r for t, r in f.writes if t > start] == [stop, stop], "unexpected slow-cap writes")
        check(sum(t > start and a == 0x4004 for t, a in f.reads) == 2,
              "optional cap used an occupied slot; expected only two explicit inspections")
        # Losing the read in the explicit Inspect slot must be visible to
        # the engine before the next ordinary poll successfully reconnects.
        with f.lock:
            f.slow_invalid_cap = False
        f.arm()
        wait(lambda: f.running, "missing running session before inspection failure")
        with f.lock:
            before_failure = len(f.writes)
            f.fail_next_cap = True  # just armed: cached cap is not due for idle refresh
        failed = f.command()
        check(failed["reason"] == "inspection_read_failed" and failed["automation"]["state"] == "frozen",
              "explicit inspection hid the bus loss")
        recovered = f.command()
        check(recovered["status"] == "ok" and recovered["automation"]["state"] == "frozen"
              and len(f.writes) == before_failure, "reconnect or Inspect bypassed freeze")
    finally:
        f.close()


with tempfile.TemporaryDirectory(prefix="evse-auto-owner-") as temp:
    run(sys.argv[1], Path(temp))
    slow_cap(sys.argv[1], Path(temp))
print("automation owner integration fixtures passed")
