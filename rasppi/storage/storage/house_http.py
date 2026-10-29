"""Bounded, private HTTP acquisition for the existing storage process."""
from dataclasses import dataclass, field
import functools
import http.client
import math
import os
import re
import ssl
import sys
import time
from urllib.parse import urlsplit
from .config import number

BODY_LIMIT = 4096
HEADER_LIMIT = 8192
MAX_WATTS = 9007199254740991
NUMBER = re.compile(rb'[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z')


@dataclass(frozen=True)
class HouseConfig:
    url: str = field(default='', repr=False)
    poll_seconds: int = 2
    timeout_seconds: int = 2
    source: str = 'evse/house'

    def __post_init__(self):
        if (type(self.poll_seconds) is not int or not 1 <= self.poll_seconds <= 60 or
                type(self.timeout_seconds) is not int or not 1 <= self.timeout_seconds <= 5):
            raise ValueError('Invalid smartmeter interval')
        if (not isinstance(self.source, str) or not self.source or len(self.source.encode()) > 240 or
                self.source.startswith('/') or self.source.endswith('/') or
                any(c in self.source for c in '+#\x00\r\n')):
            raise ValueError('Invalid house history source')
        if not isinstance(self.url, str):
            raise ValueError('Invalid smartmeter configuration')
        if not self.url:
            return
        try:
            parts = urlsplit(self.url)
            if (len(self.url) > 2048 or not self.url.isascii() or
                    re.search(r'[\x00-\x20\x7f\\]', self.url) or '#' in self.url or
                    parts.scheme not in ('http', 'https') or not parts.hostname or
                    parts.username is not None or parts.password is not None or
                    (parts.port is not None and not 1 <= parts.port <= 65535)):
                raise ValueError()
        except (ValueError, UnicodeError):
            raise ValueError('Invalid smartmeter configuration') from None

    @property
    def enabled(self):
        return bool(self.url)

    @classmethod
    def from_environment(cls, env=None):
        env = os.environ if env is None else env
        return cls(url=env.get('SMARTMETER_URL', ''),
                   poll_seconds=number(env, 'SMARTMETER_POLL_SECONDS', 2, 1, 60),
                   timeout_seconds=number(env, 'SMARTMETER_TIMEOUT_SECONDS', 2, 1, 5),
                   source=env.get('HOUSE_HISTORY_SOURCE', env.get('HOUSE_MQTT_TOPIC_PREFIX', 'evse/house')))


def parse(body):
    """Validate every ASCII token; only token seven is signed grid watts."""
    if (not isinstance(body, bytes) or len(body) > BODY_LIMIT or
            re.search(rb'[^\x09-\x0d\x20-\x7e]', body)):
        raise ValueError('Invalid smartmeter response')
    tokens = body.split()
    if len(tokens) < 7:
        raise ValueError('Invalid smartmeter response')
    values = []
    for token in tokens:
        if len(token) > 64 or not NUMBER.fullmatch(token):
            raise ValueError('Invalid smartmeter response')
        value = float(token)
        mantissa = re.split(rb'[eE]', token)[0]
        if (not math.isfinite(value) or
                (value == 0 and re.search(rb'[1-9]', mantissa)) or
                (value != 0 and abs(value) < sys.float_info.min)):
            raise ValueError('Invalid smartmeter response')
        values.append(value)
    if abs(values[6]) > MAX_WATTS:
        raise ValueError('Invalid smartmeter response')
    return values[6]


def remaining(deadline):
    duration = deadline - time.monotonic()
    if duration <= 0:
        raise TimeoutError('Smartmeter deadline')
    return duration


class _Reader:
    """Bound header/framing lines and each underlying I/O against one deadline."""
    def __init__(self, stream, sock, deadline):
        self.stream, self.sock, self.deadline = stream, sock, deadline
        self.left = HEADER_LIMIT

    def readline(self, limit=-1):
        line = bytearray()
        maximum = min(self.left + 1, limit) if limit >= 0 else self.left + 1
        while len(line) < maximum:
            self.sock.settimeout(remaining(self.deadline))
            part = self.stream.read1(1)
            remaining(self.deadline)
            if not part:
                break
            line.extend(part)
            self.left -= len(part)
            if self.left < 0:
                raise ValueError('Smartmeter header limit')
            if part == b'\n':
                break
        return bytes(line)

    def read1(self, size=-1):
        self.sock.settimeout(remaining(self.deadline))
        part = self.stream.read1(size)
        remaining(self.deadline)
        return part

    def read(self, size=-1):
        # http.client uses this for exact chunk framing, which must not gain a
        # fresh inactivity timeout for every byte of a slowly streamed delimiter.
        maximum = BODY_LIMIT + 1 if size < 0 else size
        result = bytearray()
        while len(result) < maximum:
            part = self.read1(min(1024, maximum - len(result)))
            if not part:
                break
            result.extend(part)
        return bytes(result)

    def __getattr__(self, name):
        return getattr(self.stream, name)


class _Response(http.client.HTTPResponse):
    def __init__(self, sock, *args, deadline, **kwargs):
        self._socket, self._deadline = sock, deadline
        super().__init__(sock, *args, **kwargs)
        self.fp = _Reader(self.fp, sock, deadline)


class _HTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, *args, deadline, **kwargs):
        self._deadline = deadline
        super().__init__(*args, **kwargs)

    def connect(self):
        http.client.HTTPConnection.connect(self)
        self.sock.settimeout(remaining(self._deadline))
        self.sock = self._context.wrap_socket(self.sock, server_hostname=self.host)


def fetch(config):
    """No proxy/redirects; verified TLS and one total I/O budget per attempt.

    OS hostname resolution can exceed socket deadlines; container stop remains
    the outer process boundary. Neither addresses nor response bodies escape.
    """
    connection = None
    try:
        if not config.enabled:
            raise ValueError()
        parts = urlsplit(config.url)
        deadline = time.monotonic() + config.timeout_seconds
        options = dict(timeout=remaining(deadline))
        if parts.scheme == 'https':
            connection = _HTTPSConnection(parts.hostname, parts.port, deadline=deadline,
                                           context=ssl.create_default_context(), **options)
        else:
            connection = http.client.HTTPConnection(parts.hostname, parts.port, **options)
        connection.response_class = functools.partial(_Response, deadline=deadline)
        target = parts.path or '/'
        if parts.query:
            target += '?' + parts.query
        connection.connect()
        connection.sock.settimeout(remaining(deadline))
        connection.request('GET', target, headers={'Connection': 'close', 'Accept-Encoding': 'identity'})
        connection.sock.settimeout(remaining(deadline))
        response = connection.getresponse()
        if response.status != 200 or response.getheader('Content-Encoding', 'identity').lower() != 'identity':
            raise ValueError()
        length = response.getheader('Content-Length')
        if length is not None and (not length.isascii() or not length.isdecimal() or int(length) > BODY_LIMIT):
            raise ValueError()
        body = bytearray()
        while not response.isclosed():
            chunk = response.read1(min(1024, BODY_LIMIT + 1 - len(body)))
            remaining(deadline)
            if not chunk:
                break
            body.extend(chunk)
            if len(body) > BODY_LIMIT:
                raise ValueError()
        if response.length not in (None, 0):
            raise ValueError()
        return parse(bytes(body))
    except (OSError, ValueError, http.client.HTTPException, UnicodeError):
        raise ValueError('Smartmeter acquisition failed') from None
    finally:
        if connection is not None:
            connection.close()
