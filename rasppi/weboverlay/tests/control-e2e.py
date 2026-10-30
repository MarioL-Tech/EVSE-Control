"""Disposable Docker-only HTTP -> PHP -> real broker -> C++ -> PTY integration.

No production networks, device mounts, credentials, database or external endpoints.
"""
import errno
import hashlib
import http.cookiejar
import json
import os
import pty
import select
import signal
import socket
import struct
import subprocess
import tempfile
import termios
import threading
import time
import urllib.error
import urllib.request


def check(ok, message):
    if not ok:
        raise AssertionError(message)


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def wait(predicate, message, seconds=5):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        if predicate():
            return
        time.sleep(0.03)
    raise AssertionError(message)


def crc(data):
    value = 0xFFFF
    for byte in data:
        value ^= byte
        for _ in range(8):
            value = (value >> 1) ^ (0xA001 if value & 1 else 0)
    return struct.pack('<H', value)


class Simulator:
    def __init__(self):
        self.master, self.slave = pty.openpty()
        self.original = termios.tcgetattr(self.slave)
        self.path = os.ttyname(self.slave)
        self.closed = threading.Event()
        self.lock = threading.Lock()
        self.frames, self.writes, self.errors = [], [], []
        self.limit, self.state = 6000, 1
        self.drop_ack = False
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def count(self):
        with self.lock:
            return len(self.writes)

    def serve(self):
        buffer = bytearray()
        try:
            while not self.closed.is_set():
                if not select.select([self.master], [], [], .05)[0]:
                    continue
                try:
                    buffer.extend(os.read(self.master, 256))
                except OSError as error:
                    if error.errno == errno.EIO:
                        continue
                    raise
                while len(buffer) >= 2:
                    function = buffer[1]
                    check(function in (3, 6, 16), 'Unexpected function')
                    if function == 16 and len(buffer) < 7:
                        break
                    size = 9 + buffer[6] if function == 16 else 8
                    check(size <= 32, 'Frame too large')
                    if len(buffer) < size:
                        break
                    frame = bytes(buffer[:size]); del buffer[:size]
                    check(frame[0] == 9 and crc(frame[:-2]) == frame[-2:], 'Bad request/slave CRC')
                    address, count = struct.unpack('>HH', frame[2:6])
                    self.frames.append((function, address, count))
                    if function == 3:
                        if (address, count) == (0x4004, 4):
                            words = [0, 0x0107, 0, 16000]
                        elif (address, count) == (0x4006, 2):
                            words = [0, 16000]
                        elif (address, count) == (0x400E, 2):
                            words = [0, self.limit]
                        elif (address, count) == (0x400C, 2):
                            words = [0, self.state << 8]
                        elif (address, count) == (0x4008, 24):
                            words = [0] * 24
                            words[5], words[7] = self.state << 8, self.limit
                        else:
                            raise AssertionError('Unexpected read register range')
                        response = bytes([9, 3, len(words) * 2]) + struct.pack('>' + 'H' * len(words), *words)
                    else:
                        with self.lock:
                            self.writes.append(frame[:-2])
                        if function == 16:
                            check(address == 0x4100 and count == 2 and frame[6] == 4,
                                  'Current must use exact FC16 pair')
                            self.limit = struct.unpack('>I', frame[7:11])[0]
                            check(6000 <= self.limit <= 16000, 'Install/hardware limit exceeded')
                        else:
                            check(address == 0x4105 and count in (0, 1), 'Start/Stop address or value')
                            self.state = 4 if count == 0 else 1
                        if self.drop_ack:
                            self.drop_ack = False
                            continue  # Device applied it; client MUST NOT blindly resend.
                        response = frame[:6]
                    os.write(self.master, response + crc(response))
        except BaseException as error:
            self.errors.append(str(error))

    def close(self):
        self.closed.set(); self.thread.join(timeout=2)
        check(not self.thread.is_alive(), 'Simulator leaked')
        check(not self.errors, 'Simulator errors: ' + repr(self.errors))
        check(termios.tcgetattr(self.slave) == self.original, 'Serial ownership/settings not restored')
        os.close(self.master); os.close(self.slave)


def main():
    mqtt_port, web_port = port(), port()
    origin = f'http://127.0.0.1:{web_port}'
    simulator = Simulator()
    processes = []
    try:
        with tempfile.TemporaryDirectory(prefix='evse-control-test-') as root:
            config = root + '/broker.conf'
            with open(config, 'w') as file:
                file.write(f'listener {mqtt_port} 127.0.0.1\nallow_anonymous true\npersistence false\n')
            broker = subprocess.Popen(['mosquitto', '-c', config], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            processes.append(broker)
            def broker_ready():
                try:
                    with socket.create_connection(('127.0.0.1', mqtt_port), timeout=.1):
                        return True
                except OSError:
                    return False
            wait(broker_ready, 'Broker startup')
            env = {**os.environ, 'MQTT_HOST': '127.0.0.1', 'MQTT_PORT': str(mqtt_port),
                   'MQTT_ENABLED': 'true', 'MQTT_TOPIC_PREFIX': 'evse/test',
                   'MQTT_CLIENT_ID': 'control-e2e-reader', 'MQTT_USERNAME': '',
                   'MQTT_PASSWORD': '', 'MQTT_PASSWORD_FILE': '',
                   'WALLBOX_INSTALLATION_MAX_MA': '16000', 'WEB_CONTROL_ORIGIN': origin}
            reader = subprocess.Popen(['/usr/local/bin/evse-wallbox', '--device', simulator.path,
                                       '--interval-ms', '200', '--timeout-ms', '100'], env=env,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            processes.append(reader)
            web = subprocess.Popen(['php', '-S', f'127.0.0.1:{web_port}', '-t', '/app/public', '/app/public/index.php'],
                                   env=env, cwd='/app', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            processes.append(web)
            jar = http.cookiejar.CookieJar()
            client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), urllib.request.ProxyHandler({}))
            def request(path='/api/wallbox-control', body=None, token=None):
                headers = {'Origin': origin}
                if body is not None:
                    headers.update({'Content-Type': 'application/json', 'X-CSRF-Token': token})
                req = urllib.request.Request(origin + path, data=json.dumps(body).encode() if body is not None else None,
                                             headers=headers)
                try:
                    with client.open(req, timeout=15) as response:
                        return response.status, json.load(response)
                except urllib.error.HTTPError as error:
                    return error.code, json.load(error)
            def web_ready():
                try:
                    return request('/healthz')[0] == 200
                except OSError:
                    return False
            wait(web_ready, 'PHP startup')
            wait(lambda: len(simulator.frames) >= 3, 'Unchanged telemetry polls')
            check(simulator.count() == 0, 'Startup emitted write')
            code, initial = request()
            check(code == 200 and initial['status'] == 'ok', 'Read-only inspection failed: ' + repr(initial))
            check(initial['inspection']['hardware_max_ma'] == 16000, 'Hardware cap missing')
            check(initial['inspection']['installation_max_ma'] == 16000, 'Explicit synthetic installation cap missing')
            token = initial['csrf']
            check(simulator.count() == 0, 'GET emitted write')
            code, invalid = request(body={'operation': 'set_current', 'current_ma': 17000}, token=token)
            check(simulator.count() == 0, 'Over-installation request wrote')
            code, result = request(body={'operation': 'set_current', 'current_ma': 10000}, token=token)
            check(code == 200 and result['command']['write']['acknowledged'], 'Apply not acknowledged: ' + repr(result))
            check(simulator.count() == 1 and simulator.limit == 10000, 'Apply exact-once/value')
            code, result = request(body={'operation': 'start', 'current_ma': 10000}, token=token)
            command = result['command']
            check(code == 200 and command['preparation']['acknowledged'] and command['write']['acknowledged'],
                  'Start sequence failed: ' + repr(result))
            check(command['write']['charging_observed'] is True and simulator.count() == 3,
                  'Start must report both current preparation and observed charge')
            code, result = request(body={'operation': 'stop', 'current_ma': 0}, token=token)
            check(code == 200 and result['command']['write']['acknowledged'] and simulator.state == 1, 'Stop failed')
            check(simulator.count() == 4, 'Stop duplicate')
            simulator.drop_ack = True
            code, result = request(body={'operation': 'set_current', 'current_ma': 6000}, token=token)
            check(result['command']['write']['status'] == 'outcome_unknown', 'Lost ACK must remain unknown')
            check(simulator.limit == 6000 and simulator.count() == 5, 'Unknown commit was retried')
            code, recovered = request()
            check(code == 200 and recovered['status'] == 'ok', 'Explicit inspection recovery')
            check(simulator.count() == 5, 'Recovery GET resent command')
            # Retained commands MUST NOT affect even a valid lease. A stale
            # wrong session likewise cannot enter the serial write path.
            inspect = recovered['inspection']
            # MQTT 3.1.1 clears RETAIN for live subscription deliveries. Therefore
            # only reader-issued leases/current sessions authorize an action;
            # the retained-delivery bit additionally rejects stored replays.
            for retained, session in ((True, '0' * 32), (False, '0' * 32)):
                ident = hashlib.sha256(str((retained, session)).encode()).hexdigest()[:32]
                payload = f'v1|{ident}|{session}|{inspect["lease"]}|stop|0'
                args = ['mosquitto_pub', '-h', '127.0.0.1', '-p', str(mqtt_port),
                        '-t', 'evse/test/control/request', '-m', payload]
                if retained:
                    args.append('-r')
                subprocess.run(args, check=True, capture_output=True, timeout=3)
            time.sleep(.5)
            check(simulator.count() == 5, 'Retained/stale session accepted')
            check(reader.poll() is None and broker.poll() is None and web.poll() is None, 'Process unexpectedly exited')
            print('HTTP -> PHP -> MQTT -> C++ -> PTY: inspect, limits, Apply/Start/Stop, unknown commit, recovery, retained/stale rejection passed')
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
                try:
                    process.wait(timeout=4)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait(timeout=2)
        simulator.close()


if __name__ == '__main__':
    main()
