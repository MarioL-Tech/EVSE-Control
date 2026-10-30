"""Loopback-only fake HTTP fixtures. Invoked by CTest inside Docker, never hardware."""
import datetime
import http.server
import json
import subprocess
import sys
import threading
import time


def plan():
    profile = dict(max_import_w=0, max_current_ma=32000, adjust_seconds=1,
                   pause_seconds=2, resume_seconds=3)
    return dict(schema_version=1, status="ok", generated_at=time.time(),
                fresh_for_seconds=6, config_revision="a" * 64,
                activation=dict(mode="pv", id="b" * 32),
                config=dict(schema_version=1, timezone="Europe/Vienna",
                            manual=dict(current_ma=None), pv=profile,
                            custom=dict(profile, use_schedule=False, pv_enabled=False,
                                        weekdays=[], windows=[], outside_window=None),
                            installation=dict(phases=3, meter_includes_wallbox=True)))


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True


def run(case, expected, duration=600):
    stamp = time.time() - .1
    counts = {"plan": 0, "house": 0}

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            if self.path not in ("/api/charging-plan", "/api/smartmeter"):
                raise AssertionError("unexpected URL")
            is_plan = self.path.endswith("charging-plan")
            name = "plan" if is_plan else "house"
            counts[name] += 1
            now = time.time()
            value = plan() if is_plan else dict(
                schema_version=1, read_only=True, status="live", power_w=-7200,
                fetched_at=datetime.datetime.fromtimestamp(stamp, datetime.timezone.utc)
                .strftime("%Y-%m-%dT%H:%M:%S.%fZ"), age_seconds=now-stamp,
                fresh_for_seconds=10-(now-stamp))
            code = 200
            raw = None
            if case in ("403", "302"):
                code = int(case)
            elif case == "bad":
                raw = "not json"
            elif case == "duplicate":
                raw = '{"schema_version":1,"schema_version":1}'
            elif case == "nested_duplicate":
                raw = '{"a":{"x":1,"x":2}}'
            elif case == "nan":
                raw = '{"power_w":NaN}'
            elif case == "body":
                raw = " " * 16385
            elif case == "old" and not is_plan:
                value["fetched_at"] = "2000-01-01T00:00:00.000000Z"
            elif case == "future" and not is_plan:
                value["fetched_at"] = "2099-01-01T00:00:00.000000Z"
            elif case == "null" and not is_plan:
                value["power_w"] = None
            elif case == "disabled" and is_plan:
                value["status"] = "disabled"
            elif case == "same" and not is_plan:
                # Malicious heartbeat cannot renew the ORIGINAL 1-second TTL.
                value["fresh_for_seconds"] = 1 if counts[name] == 1 else 10
            elif case == "transport" and counts[name] > 1:
                self.connection.close()
                return
            elif case == "barrier" and not is_plan and counts[name] > 1:
                value["status"] = "read_error"
                value["power_w"] = None
            elif case == "slow":
                time.sleep(2)
            self.send_response(code)
            if code == 302:
                self.send_header("Location", "/must-not-follow")
            if case == "header":
                self.send_header("X-Large", "x" * 8193)
            self.end_headers()
            try:
                self.wfile.write((raw if raw is not None else json.dumps(value)).encode())
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = Server(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    started = time.monotonic()
    try:
        result = subprocess.run([sys.argv[1], "--http",
                                 f"http://127.0.0.1:{server.server_port}", str(duration)],
                                text=True, capture_output=True, timeout=duration/1000+5)
        if result.returncode or result.stdout.strip() != expected:
            raise AssertionError((case, result.returncode, result.stdout, result.stderr, expected))
        if time.monotonic()-started > duration/1000+3.5:
            raise AssertionError("shutdown exceeded request timeout bound")
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


run("ok", "ok ok 1 1")
for case in ("403", "302", "bad", "duplicate", "nested_duplicate", "nan", "body", "header"):
    run(case, "invalid_response invalid_response 0 0")
for case in ("old", "future", "null"):
    run(case, "ok invalid_response 1 0")
run("disabled", "disabled ok 0 1")
run("same", "ok ok 1 0", 2700)
run("transport", "transport_unavailable transport_unavailable 1 1", 2700)
run("barrier", "ok invalid_response 1 0", 2700)
# Destruction while the first request is blocked is bounded and never starts a second.
run("slow", "waiting waiting 0 0", 100)
bad = subprocess.run([sys.argv[1], "--http", "http://127.0.0.1:1/path?injected=1", "100"],
                     capture_output=True, text=True, timeout=4, check=True)
if bad.stdout.strip() != "invalid_base invalid_base 0 0":
    raise AssertionError(bad.stdout)
print("automation HTTP fixtures passed")
