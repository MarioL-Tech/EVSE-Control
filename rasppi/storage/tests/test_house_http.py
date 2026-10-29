"""Strict HTTP source contract; stdlib loopback fixtures run only in Docker."""
import os
import ssl
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from storage.house_http import HouseConfig, fetch, parse

BODY = b'1 2 3 4 5 6 -800.5\n'


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.server.paths.append(self.path)
        if self.path == '/slow-header':
            try:
                self.wfile.write(b'HTTP/1.1 200 OK\r\n')
                self.drip(b'X-Drip: abcdefghijklmnop\r\n\r\n')
                self.wfile.write(BODY)
            except OSError:
                pass
            return
        if self.path == '/redirect':
            self.send_response(302)
            self.send_header('Location', '/ok')
            self.end_headers()
            return
        self.send_response(503 if self.path == '/error' else 200)
        if self.path == '/headers':
            for i in range(24):
                self.send_header('X-Padding-' + str(i), 'x' * 400)
        if self.path == '/length':
            self.send_header('Content-Length', str(len(BODY)))
            # Keep the connection open: success must follow the final declared
            # byte, not EOF or a later read/socket access after fp closes.
            self.send_header('Connection', 'keep-alive')
            self.close_connection = False
        if self.path in ('/chunked', '/slow-chunk-size', '/slow-trailer'):
            self.send_header('Transfer-Encoding', 'chunked')
        self.end_headers()
        try:
            if self.path == '/slow':
                self.drip(BODY)
            elif self.path == '/slow-chunk-size':
                self.drip(('%016x\r\n' % len(BODY)).encode('ascii'))
                self.wfile.write(BODY + b'\r\n0\r\n\r\n')
            elif self.path == '/slow-trailer':
                self.wfile.write(('%x\r\n' % len(BODY)).encode('ascii') + BODY + b'\r\n0\r\n')
                self.wfile.flush()
                self.drip(b'X-Drip: abcdefghijklmnop\r\n\r\n')
            elif self.path == '/chunked':
                for chunk in (BODY[:5], BODY[5:]):
                    self.wfile.write(('%x\r\n' % len(chunk)).encode('ascii') + chunk + b'\r\n')
                self.wfile.write(b'0\r\nX-Fixture: complete\r\n\r\n')
            else:
                self.wfile.write(BODY + b' ' * 4096 if self.path == '/body' else BODY)
        except (OSError, ssl.SSLError):
            pass

    def drip(self, data):
        for byte in data:
            self.wfile.write(bytes([byte]))
            self.wfile.flush()
            time.sleep(0.15)  # Progress must not reset the total timeout.


class HouseHTTP(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.server.daemon_threads = True
        cls.server.paths = []
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def config(self, path='/ok', **changes):
        return HouseConfig.from_environment({
            'SMARTMETER_URL': 'http://127.0.0.1:%s%s' % (self.server.server_port, path),
            'SMARTMETER_POLL_SECONDS': '1', 'SMARTMETER_TIMEOUT_SECONDS': '1', **changes})

    def test_config_disabled_source_and_limits(self):
        disabled = HouseConfig.from_environment({})
        self.assertFalse(disabled.enabled)
        self.assertEqual(disabled.url, '')
        self.assertEqual(disabled.source, 'evse/house')
        self.assertEqual(HouseConfig.from_environment({'HOUSE_MQTT_TOPIC_PREFIX': 'legacy/house'}).source,
                         'legacy/house')
        config = self.config(HOUSE_HISTORY_SOURCE='actual/house', HOUSE_MQTT_TOPIC_PREFIX='legacy/house',
                             MQTT_TOPIC_PREFIX='poison/wallbox')
        self.assertEqual(config.source, 'actual/house')
        self.assertTrue(config.enabled)
        self.assertEqual((config.poll_seconds, config.timeout_seconds), (1, 1))
        for key, values in [('SMARTMETER_TIMEOUT_SECONDS', ('0', '6', '1.5', '-1')),
                            ('SMARTMETER_POLL_SECONDS', ('0', '61', '1.5'))]:
            for value in values:
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    self.config(**{key: value})
        for url in ('file:///tmp/source', 'ftp://example.invalid/value',
                    'http://user:private@example.invalid/value', 'http://example.invalid/#',
                    'http://example.invalid:65536/value', 'http://example.invalid:0/value',
                    'http://example.invalid/with space', 'http://example.invalid/\\value'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.config(SMARTMETER_URL=url)
        with self.assertRaises(Exception):
            fetch(disabled)
        self.assertNotIn('127.0.0.1', repr(self.config()))

    def test_ascii_numeric_entire_list_and_seventh_signed_value(self):
        for token, expected in [(b'-800.5', -800.5), (b'+1549.40', 1549.4), (b'0', 0),
                                (b'-0', 0), (b'.5e2', 50), (b'2.', 2)]:
            with self.subTest(token=token):
                self.assertEqual(parse(b' \t1\r2\n3\v4\f5 6 ' + token + b' 999\n'), expected)
        invalid = [b'', b'1 2 3 4 5 6', b'\xef\xbb\xbf' + BODY, BODY + b'\x00',
                   BODY + b'\xc2\xa0', BODY + b' garbage', BODY + b' 1,2',
                   BODY + b' NaN', BODY + b' Infinity', BODY + b' 1e309',
                   BODY + b' 1e-999', BODY + b' 1e-310', BODY + b' ' + b'0' * 65,
                   b'bad 2 3 4 5 6 0', b'1 2 3 4 5 6 0x10',
                   b'1 2 3 4 5 6 9007199254740992', BODY + b' ' * 4096]
        for body in invalid:
            with self.subTest(body=body[:50]), self.assertRaises(Exception):
                parse(body)
        self.assertEqual(parse(BODY + b' ' * (4096 - len(BODY))), -800.5)

    def test_fetch_ignores_proxy_environment(self):
        with patch.dict(os.environ, {'http_proxy': 'http://127.0.0.1:1',
                                    'HTTP_PROXY': 'http://127.0.0.1:1',
                                    'ALL_PROXY': 'http://127.0.0.1:1',
                                    'NO_PROXY': '', 'no_proxy': ''}):
            self.assertEqual(fetch(self.config()), -800.5)

    def test_content_length_and_chunked_success(self):
        for path in ('/length', '/chunked'):
            with self.subTest(path=path):
                self.assertEqual(fetch(self.config(path)), -800.5)

    def test_non_200_redirect_headers_and_body_bounds(self):
        for path in ('/error', '/redirect', '/headers', '/body'):
            before = len(self.server.paths)
            with self.subTest(path=path), self.assertRaises(Exception):
                fetch(self.config(path))
            self.assertEqual(self.server.paths[before:], [path], 'No redirect follow-up allowed')

    def test_slow_progress_obeys_total_timeout(self):
        for path in ('/slow', '/slow-header', '/slow-chunk-size', '/slow-trailer'):
            with self.subTest(path=path):
                started = time.monotonic()
                with self.assertRaises(ValueError):
                    fetch(self.config(path))
                self.assertLess(time.monotonic() - started, 2.5,
                                'Total deadline, not per-read idle timeout')

    def test_tls_requires_peer_and_hostname_verification(self):
        checked = []

        def inspect(context, *args, **kwargs):
            checked.append((context.verify_mode, context.check_hostname))
            raise ssl.SSLError('isolated handshake stopped')

        config = self.config(SMARTMETER_URL='https://127.0.0.1:%s/ok' % self.server.server_port)
        with patch.object(ssl.SSLContext, 'wrap_socket', inspect), self.assertRaises(Exception):
            fetch(config)
        self.assertEqual(checked, [(ssl.CERT_REQUIRED, True)])
