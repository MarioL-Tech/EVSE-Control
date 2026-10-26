<?php
declare(strict_types=1);

require '/app/vendor/autoload.php';

use EvseOverlay\Config;
use EvseOverlay\MqttTransport;

// Explicit checks remain active with zend.assertions=-1. Only ephemeral loopback
// listeners are used; this suite never reads production broker configuration.
function check(bool $condition, string $message): void
{
    if (!$condition) { throw new RuntimeException($message); }
}

function bytes($socket, int $count): string
{
    $result = '';
    while (strlen($result) < $count) {
        $part = fread($socket, $count - strlen($result));
        check($part !== false && $part !== '', 'Fake broker read failed.');
        $result .= $part;
    }
    return $result;
}

function packet($socket): array
{
    $header = ord(bytes($socket, 1));
    check(($header >> 4) !== 3, 'Transport must never send PUBLISH.');
    $length = 0;
    for ($i = 0; $i < 4; ++$i) {
        $b = ord(bytes($socket, 1));
        $length += ($b & 127) << (7 * $i);
        if (($b & 128) === 0) { return [$header, bytes($socket, $length)]; }
    }
    throw new RuntimeException('Malformed client packet.');
}

function sendBytes($socket, string $data): void
{
    while ($data !== '') {
        $n = fwrite($socket, $data);
        check($n !== false && $n > 0, 'Fake broker write failed.');
        $data = substr($data, $n);
    }
}

function wire(int $header, string $body): string
{
    $result = chr($header);
    $length = strlen($body);
    do {
        $b = $length % 128;
        $length = intdiv($length, 128);
        $result .= chr($b | ($length > 0 ? 128 : 0));
    } while ($length > 0);
    return $result . $body;
}

function publish(string $name, string $payload, bool $qos1 = false): string
{
    $topic = 'evse/test/' . $name;
    return wire($qos1 ? 0x33 : 0x31, pack('n', strlen($topic)) . $topic . ($qos1 ? "\x00\x71" : '') . $payload);
}

function handshake($socket, bool $fragment = false): void
{
    [$header, $body] = packet($socket);
    check($header === 0x10, 'Expected CONNECT.');
    check(substr($body, 0, 7) === "\x00\x04MQTT\x04", 'Expected MQTT 3.1.1.');
    check(ord($body[7]) === 2, 'Expected clean session without will/credentials.');
    check(substr($body, 8, 2) === "\x00\x0f", 'Expected 15 second keepalive.');
    if ($fragment) {
        foreach (str_split("\x20\x02\x00\x00") as $b) {
            sendBytes($socket, $b);
            usleep(5000);
        }
    } else {
        sendBytes($socket, "\x20\x02\x00\x00");
    }
}

function subscriptions($socket): array
{
    $ids = [];
    foreach (['state', 'availability'] as $name) {
        [$header, $body] = packet($socket);
        $topic = 'evse/test/' . $name;
        check($header === 0x82, 'Expected SUBSCRIBE.');
        check(substr($body, 2) === pack('n', strlen($topic)) . $topic . "\x01", 'Unexpected subscription.');
        $ids[] = substr($body, 0, 2);
    }
    check($ids[0] !== $ids[1], 'Subscription IDs must differ.');
    return $ids;
}

function acknowledge($socket, array $ids): void
{
    sendBytes($socket, wire(0x90, $ids[0] . "\x01") . wire(0x90, $ids[1] . "\x00"));
}

function brokerCase(string $name, callable $broker, callable $exercise): void
{
    $listener = stream_socket_server('tcp://127.0.0.1:0', $errno, $error);
    check($listener !== false, 'Cannot create isolated broker.');
    $address = stream_socket_get_name($listener, false);
    $port = (int) substr($address, strrpos($address, ':') + 1);
    $pid = pcntl_fork();
    check($pid !== -1, 'Cannot fork fake broker.');
    if ($pid === 0) {
        pcntl_async_signals(true);
        pcntl_signal(SIGALRM, static function (): void { exit(2); });
        pcntl_alarm(9);
        try {
            $socket = stream_socket_accept($listener, 3);
            check($socket !== false, 'Broker accept failed.');
            fclose($listener);
            stream_set_timeout($socket, 6);
            $broker($socket);
            // Observe all remaining client packets until close. No client PUBLISH
            // is allowed, including after a denial or malformed inbound frame.
            if (is_resource($socket)) {
                while (!feof($socket)) {
                    $read = [$socket];
                    $write = $except = [];
                    check(stream_select($read, $write, $except, 5) === 1, 'Transport did not close socket.');
                    $first = fread($socket, 1);
                    if ($first === '') { check(feof($socket), 'Broker drain stalled.'); break; }
                    check($first !== false, 'Broker drain failed.');
                    $type = ord($first) >> 4;
                    check(in_array($type, [4, 12, 14], true), 'Unexpected client command (possibly PUBLISH).');
                    $length = ord(bytes($socket, 1));
                    check($length < 128, 'Unexpected client packet size.');
                    bytes($socket, $length);
                }
                fclose($socket);
            }
            exit(0);
        } catch (Throwable) {
            // Never print packet bodies or credentials, even for failed tests.
            exit(1);
        }
    }
    fclose($listener);
    $client = null;
    $failure = null;
    try {
        $exercise(new Config(host: '127.0.0.1', port: $port, prefix: 'evse/test', clientId: 'transport-test'), $client);
    } catch (Throwable $e) {
        $failure = $e;
    } finally {
        $client?->close();
        pcntl_waitpid($pid, $status);
    }
    check(pcntl_wifexited($status) && pcntl_wexitstatus($status) === 0, $name . ': fake broker failed.');
    if ($failure !== null) { throw $failure; }
    print 'PASS ' . $name . "\n";
}

function pump(MqttTransport $client, callable $done, float $seconds = 5): void
{
    $deadline = hrtime(true) / 1e9 + $seconds;
    while (!$done()) {
        check(hrtime(true) / 1e9 < $deadline, 'Test pump deadline exceeded.');
        $client->tick();
        usleep(10000);
    }
}

function expectFailure(Config $config, ?MqttTransport &$client, string $message, bool $mayBeReady = false): void
{
    $ready = false;
    $delivered = false;
    $client = new MqttTransport($config, static function () use (&$ready): void { $ready = true; },
        static function () use (&$delivered): void { $delivered = true; },
        static function () use (&$delivered): void { $delivered = true; });
    $started = hrtime(true) / 1e9;
    $caught = null;
    try {
        $client->connect();
        pump($client, static fn(): bool => false);
    } catch (Throwable $e) { $caught = $e; }
    check($caught !== null && str_contains($caught->getMessage(), $message), 'Expected bounded transport failure: ' . $message);
    check(!$delivered && ($mayBeReady || !$ready), 'Failure exposed premature callbacks.');
    check(hrtime(true) / 1e9 - $started < 4.5, 'Failure exceeded time budget.');
    $client->close();
    $client->close();
}

brokerCase('clean handshake / both SUBACKs / retained latest / replay gate',
    static function ($s): void {
        handshake($s, true);
        $ids = subscriptions($s);
        sendBytes($s, publish('state', 'old') . publish('availability', 'online') . publish('state', 'latest', true)
            . wire(0x90, $ids[0] . "\x01") . wire(0x90, $ids[0] . "\x01") . wire(0x90, "\x7f\xff\x01"));
        usleep(200000);
        sendBytes($s, wire(0x90, $ids[1] . "\x00") . publish('state', 'live'));
    },
    static function (Config $config, ?MqttTransport &$client): void {
        $events = [];
        $started = hrtime(true) / 1e9;
        $client = new MqttTransport($config,
            static function () use (&$events, $started): void {
                check(hrtime(true) / 1e9 - $started >= 0.18, 'Unknown/replayed ACK falsely enabled readiness.');
                $events[] = 'ready';
            },
            static function (string $p) use (&$events): void { $events[] = 'state:' . $p; },
            static function (string $p) use (&$events): void { $events[] = 'availability:' . $p; });
        $client->connect();
        check($events === [], 'TCP connection alone must not be ready.');
        pump($client, static function () use (&$events): bool { return count($events) >= 4; });
        check($events === ['ready', 'state:latest', 'availability:online', 'state:live'], 'Retained lifecycle/order incorrect.');
    });

brokerCase('fragmented multi-read state payload',
    static function ($s): void {
        handshake($s);
        acknowledge($s, subscriptions($s));
        $data = publish('state', str_repeat('a', 16384));
        foreach (str_split($data, 701) as $chunk) { sendBytes($s, $chunk); usleep(2000); }
    },
    static function (Config $config, ?MqttTransport &$client): void {
        $ready = false;
        $received = false;
        $client = new MqttTransport($config, static function () use (&$ready): void { $ready = true; },
            static function (string $p) use (&$ready, &$received): void {
                check($ready && $p === str_repeat('a', 16384), 'Fragmented payload corrupted.');
                $received = true;
            }, static function (): void {});
        $client->connect();
        pump($client, static function () use (&$received): bool { return $received; });
    });

foreach (["\x80", "\x02", "\x03", "\x01\x01", ''] as $qos) {
    brokerCase('SUBACK denied/invalid/count ' . bin2hex($qos),
        static function ($s) use ($qos): void {
            handshake($s);
            $ids = subscriptions($s);
            sendBytes($s, wire(0x90, $ids[0] . $qos));
        }, static function (Config $c, ?MqttTransport &$t): void {
            // An upstream parser rejection is also valid for a malformed packet.
            expectFailure($c, $t, '');
        });
}

brokerCase('missing SUBACK timeout', static function ($s): void {
    handshake($s);
    subscriptions($s);
}, static function (Config $c, ?MqttTransport &$t): void { expectFailure($c, $t, 'subscription acknowledgement timed out'); });

foreach (['state' => 16385, 'availability' => 17] as $topic => $size) {
    brokerCase('bounded retained ' . $topic, static function ($s) use ($topic, $size): void {
        handshake($s);
        subscriptions($s);
        sendBytes($s, publish($topic, str_repeat('x', $size)));
    }, static function (Config $c, ?MqttTransport &$t): void { expectFailure($c, $t, 'payload exceeds limit'); });
}

foreach ([
    'huge length before body' => "\x30\x81\x80\x02",
    'fourth continuation byte' => "\x30\x80\x80\x80\x80",
] as $name => $header) {
    foreach ([false, true] as $duringHandshake) {
        brokerCase($name . ($duringHandshake ? ' handshake' : ' tick'),
            static function ($s) use ($header, $duringHandshake): void {
                if ($duringHandshake) { packet($s); }
                else { handshake($s); acknowledge($s, subscriptions($s)); }
                // No body follows: rejection must not depend on receiving one.
                foreach (str_split($header) as $b) { sendBytes($s, $b); usleep(5000); }
            }, static function (Config $c, ?MqttTransport &$t) use ($duringHandshake): void {
                expectFailure($c, $t, 'remaining length', !$duringHandshake);
            });
    }
}

foreach (["\x30", "\x30\x80", "\x30\x05\x00"] as $partial) {
    brokerCase('partial frame deadline ' . bin2hex($partial), static function ($s) use ($partial): void {
        handshake($s);
        acknowledge($s, subscriptions($s));
        sendBytes($s, $partial);
    }, static function (Config $c, ?MqttTransport &$t): void { expectFailure($c, $t, 'partial frame timed out', true); });
}

brokerCase('EOF handshake', static function ($s): void {
    packet($s);
    stream_socket_shutdown($s, STREAM_SHUT_WR);
}, static function (Config $c, ?MqttTransport &$t): void { expectFailure($c, $t, 'EOF'); });

brokerCase('EOF connected', static function ($s): void {
    handshake($s);
    acknowledge($s, subscriptions($s));
    stream_socket_shutdown($s, STREAM_SHUT_WR);
}, static function (Config $c, ?MqttTransport &$t): void { expectFailure($c, $t, 'EOF', true); });

brokerCase('silent handshake bounded read', static function ($s): void {
    packet($s);
}, static function (Config $c, ?MqttTransport &$t): void { expectFailure($c, $t, 'socket read timed out'); });

brokerCase('partial handshake bounded read', static function ($s): void {
    packet($s);
    sendBytes($s, "\x20\x02\x00");
}, static function (Config $c, ?MqttTransport &$t): void { expectFailure($c, $t, 'socket read timed out'); });

print "MQTT transport tests complete.\n";
