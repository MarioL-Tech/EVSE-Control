<?php
declare(strict_types=1);

require_once __DIR__ . '/../php/Config.php';
require_once __DIR__ . '/../php/StrictJson.php';
require_once __DIR__ . '/../php/StateStore.php';

use EvseOverlay\Config;
use EvseOverlay\StateStore;
use EvseOverlay\StrictJson;

function check(bool $condition, string $message = 'Check failed'): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

function rejects(callable $operation): void
{
    try {
        $operation();
    } catch (Throwable) {
        return;
    }
    throw new RuntimeException('Expected rejection');
}

function fixture(int $epoch = 1791061398): array
{
    $stamp = gmdate('Y-m-d\TH:i:s\Z', $epoch);
    return ['schema_version' => 1, 'device' => 'abb_terra_ac', 'timestamp' => $stamp,
        'last_success_at' => $stamp, 'status' => 'ok', 'error' => null,
        'values' => ['error_code' => 0, 'socket_lock_state' => 273, 'charging_state_raw' => 33024,
            'charging_state' => 1, 'below_commanded_current' => true, 'plugged_in' => true,
            'charging' => false, 'current_limit_a' => 6.0, 'current_a' => [0.0, 0.0, 0.0],
            'voltage_v' => [235.7, 233.4, 235.3], 'active_power_w' => 0, 'session_energy_wh' => 0]];
}

function wire(array $data): string
{
    return json_encode($data, JSON_THROW_ON_ERROR | JSON_PRESERVE_ZERO_FRACTION);
}

final class Harness
{
    public float $now = 1791061398;
    public float $mono = 100;
    public StateStore $store;
    public function __construct()
    {
        $this->store = new StateStore(10, fn() => $this->now, fn() => $this->mono);
    }
    public function load(?array $data = null): void
    {
        $this->store->connection(true);
        $this->store->acceptSample(wire($data ?? fixture((int) $this->now)));
        $this->store->acceptAvailability('online');
    }
    public function status(string $expected): void
    {
        $result = $this->store->snapshot();
        check($result['status'] === $expected, 'Unexpected state; expected ' . $expected);
        if ($expected !== 'live') {
            check($result['values'] === null && $result['fresh_for_seconds'] === 0);
        }
    }
    public function roundtrip(): void
    {
        $record = json_decode(json_encode($this->store->export(), JSON_THROW_ON_ERROR), true, 512, JSON_THROW_ON_ERROR);
        $this->store = StateStore::restore($record, 10, fn() => $this->now, fn() => $this->mono);
    }
}

function environment(array $overrides, callable $operation): void
{
    $keys = ['MQTT_HOST', 'MQTT_PORT', 'MQTT_TOPIC_PREFIX', 'MQTT_CLIENT_ID', 'MQTT_USERNAME',
        'MQTT_PASSWORD', 'MQTT_PASSWORD_FILE', 'WEB_STALE_SECONDS'];
    $old = [];
    foreach ($keys as $key) {
        $old[$key] = getenv($key);
        putenv($key);
    }
    try {
        foreach ($overrides as $key => $value) {
            putenv($key . '=' . $value);
        }
        $operation();
    } finally {
        foreach ($old as $key => $value) {
            putenv($value === false ? $key : $key . '=' . $value);
        }
    }
}

$tests = [];
$tests['topic ordering and reconnect'] = static function (): void {
    $h = new Harness();
    $h->status('offline');
    $h->store->connection(true);
    $h->store->acceptAvailability('online');
    $h->status('waiting');
    $h->store->acceptSample(wire(fixture()));
    $h->status('live');
    $h->store->connection(false);
    $h->status('offline');
    $h->store->connection(true);
    $h->store->acceptSample(wire(fixture()));
    $h->status('waiting');
    $h->store->acceptAvailability('online');
    $h->status('live');
};
$tests['staleness retained and exact boundary'] = static function (): void {
    $h = new Harness();
    $h->load(fixture((int) $h->now - 30));
    $h->status('stale');
    $h->load();
    $h->now -= 1;
    $h->mono += 10;
    $h->status('stale');
    check($h->store->snapshot()['age_seconds'] === 10.0);
};
$tests['duplicate invalid payload and rollback preserve age'] = static function (): void {
    $h = new Harness();
    $h->load();
    $h->mono += 11;
    $h->now -= 1;
    $h->store->acceptSample('broken-json');
    $h->status('invalid');
    $h->roundtrip();
    $h->store->acceptSample(wire(fixture()));
    $h->status('stale');
};
$tests['future sample recovery permits older timestamp'] = static function (): void {
    $h = new Harness();
    $h->load(fixture((int) $h->now + 20));
    $h->status('clock_error');
    $h->now += 18;
    $h->roundtrip();
    $h->status('clock_error');
    $h->store->acceptSample(wire(fixture((int) $h->now)));
    $h->status('live');
};
$tests['future latch observed after ingestion survives persistence'] = static function (): void {
    $h = new Harness();
    $h->load();
    $h->now -= 6;
    // export must itself observe rollback, not only a preceding API request.
    $h->roundtrip();
    $h->now += 7;
    $h->status('clock_error');
    $h->store->acceptSample('invalid');
    $h->roundtrip();
    $h->store->acceptSample(wire(fixture()));
    $h->status('clock_error');
    $h->store->acceptSample(wire(fixture((int) $h->now)));
    $h->status('live');
};
$tests['read errors availability priority recovery'] = static function (): void {
    $h = new Harness();
    $h->load();
    foreach (['offline' => 'offline', 'ONLINE' => 'invalid', '' => 'invalid'] as $payload => $status) {
        $h->store->acceptAvailability($payload);
        $h->status($status);
    }
    $h->store->acceptAvailability('online');
    $bad = fixture((int) $h->now + 1);
    $bad['status'] = 'error';
    $bad['values'] = null;
    $bad['error'] = 'read: Connection timed out';
    $h->store->acceptSample(wire($bad));
    $h->status('read_error');
    $h->store->acceptAvailability('offline');
    $h->status('read_error');
    $h->store->acceptAvailability('online');
    $h->store->acceptSample(wire(fixture((int) $h->now + 2)));
    $h->status('live');
};
$tests['whitelist null flags ownership and out of order'] = static function (): void {
    $h = new Harness();
    $data = fixture();
    $data['private_extra'] = 'private-test';
    $data['values']['private_extra'] = 'private-test';
    $data['values']['charging'] = $data['values']['plugged_in'] = null;
    $data['values']['error_code'] = 7;
    $data['values']['charging_state'] = 5;
    $h->load($data);
    $h->store->acceptSample(wire(fixture((int) $h->now - 2)));
    $result = $h->store->snapshot();
    check($result['values']['charging'] === null && $result['values']['error_code'] === 7);
    check(!str_contains(wire($result), 'private-test'));
    $result['values']['current_a'][0] = 999;
    check($h->store->snapshot()['values']['current_a'][0] === 0.0);
    $expected = ['schema_version', 'read_only', 'status', 'reason', 'broker_connected', 'availability',
        'timestamp', 'last_success_at', 'age_seconds', 'fresh_for_seconds', 'values', 'error'];
    check(array_keys($result) === $expected);
};
$tests['Others keeps independently known EV connection and unknown charging'] = static function (): void {
    $h = new Harness(); $data = fixture();
    $data['values']['socket_lock_state'] = 257;
    $data['values']['charging_state_raw'] = 34048;
    $data['values']['charging_state'] = 5;
    $data['values']['plugged_in'] = true;
    $data['values']['charging'] = null;
    $h->load($data);
    $result = $h->store->snapshot();
    check($result['status'] === 'live');
    check($result['values']['plugged_in'] === true && $result['values']['charging'] === null);
};
$tests['malformed sample matrix'] = static function (): void {
    $cases = ['', '{', 'null', '[]', "\xff", str_repeat(' ', 16385), '{"schema_version":1,"schema_version":1}'];
    foreach ([['schema_version', 2], ['schema_version', true], ['device', 'other'], ['timestamp', '2026-10-03T12:00:00'], ['values', null], ['values', []], ['error', 1]] as [$key, $value]) {
        $data = fixture(); $data[$key] = $value; $cases[] = wire($data);
    }
    foreach ([['current_a', [0, 0]], ['current_a', (object) ['0' => 0, '1' => 0, '2' => 0]],
        ['current_a', []], ['current_limit_a', true], ['charging', 'false'], ['active_power_w', -1],
        ['active_power_w', 1.0], ['error_code', true], ['session_energy_wh', 4294967296],
        ['below_commanded_current', null], ['voltage_v', [0, -1, 0]]] as [$key, $value]) {
        $data = fixture(); $data['values'][$key] = $value; $cases[] = wire($data);
    }
    $cases[] = str_replace('6.0', '1e999', wire(fixture()));
    $data = fixture(); unset($data['values']['charging']); $cases[] = wire($data);
    $data = fixture(); $data['last_success_at'] = null; $cases[] = wire($data);
    foreach ($cases as $payload) {
        $h = new Harness(); $h->load(); $h->store->acceptSample($payload); $h->status('invalid');
    }
    $h = new Harness(); $data = fixture(); $data['values']['active_power_w'] = 4294967295;
    $h->load($data); $h->status('live');
};
$tests['UTC syntax and calendar validation'] = static function (): void {
    foreach (['2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-10-03T24:00:00Z',
        '2026-10-03T00:60:00Z', '2026-10-03T00:00:60Z', '2026-10-03 00:00:00Z',
        '2026-10-03T00:00:00+01:00', '2026-10-03T00:00:00.1234567Z', '0000-01-01T00:00:00Z'] as $stamp) {
        $h = new Harness(); $data = fixture();
        $data['timestamp'] = $data['last_success_at'] = $stamp;
        $h->load($data); $h->status('invalid');
    }
    foreach (['Z', '+00:00', '.1Z', '.123456+00:00'] as $suffix) {
        $h = new Harness(); $data = fixture();
        $data['timestamp'] = $data['last_success_at'] = substr($data['timestamp'], 0, -1) . $suffix;
        $h->load($data); $h->status('live');
    }
};
$tests['Unicode error length and zero error string'] = static function (): void {
    foreach ([1024 => 'read_error', 1025 => 'invalid'] as $length => $status) {
        $h = new Harness(); $data = fixture();
        $data['status'] = 'error'; $data['values'] = null; $data['error'] = str_repeat('ä', $length);
        $h->load($data); $h->status($status);
    }
    $h = new Harness(); $data = fixture();
    $data['status'] = 'error'; $data['values'] = null; $data['error'] = '0';
    $h->load($data); $h->status('read_error');
};
$tests['strict JSON duplicate equivalence UTF8 depth nonfinite'] = static function (): void {
    foreach (['{"x":1,"x":2}', '{"x":{"a":1,"\\u0061":2}}', '[{"😀":0,"\\ud83d\\ude00":1}]',
        "{\"x\":\"\xff\"}", 'NaN', 'Infinity', '-Infinity', '1e999', '[1e999]',
        str_repeat('[', 65) . '0' . str_repeat(']', 65), '{"a":1} trailing'] as $payload) {
        rejects(static fn() => StrictJson::decode($payload));
    }
    check(StrictJson::decode('[]') === []);
    check(StrictJson::decode('{}') instanceof stdClass);
    StrictJson::decode(str_repeat('[', 64) . '0' . str_repeat(']', 64));
    StrictJson::decode(json_encode(['a"b' => [true, false, null, '\\', (object) ['x' => 1]], 'a' => 2], JSON_THROW_ON_ERROR));
};
$tests['persistence roundtrip and elapsed age'] = static function (): void {
    $h = new Harness(); $h->load();
    $before = $h->store->snapshot(); $h->roundtrip();
    check($before == $h->store->snapshot());
    $h->mono += 10; $h->now -= 1; $h->roundtrip(); $h->status('stale');
    $h = new Harness(); $h->store->connection(true); $h->roundtrip(); $h->status('waiting');
};
$tests['corrupt export fail closed'] = static function (): void {
    $h = new Harness(); $h->load(); $original = $h->store->export();
    $cases = [[]];
    foreach (['version' => 2, 'connected' => 1, 'availability' => 'ONLINE', 'invalid' => 0,
        'availability_invalid' => true, 'future_sample' => 'false', 'received_at' => 101,
        'initial_age' => -1, 'sample' => [], 'extra' => 'bad'] as $key => $value) {
        $record = $original; $record[$key] = $value; $cases[] = $record;
    }
    $record = $original; unset($record['invalid']); $cases[] = $record;
    $record = $original; $record['sample']['values']['charging'] = 0; $cases[] = $record;
    $record = $original; $record['sample']['values']['extra'] = 'bad'; $cases[] = $record;
    $record = $original; $record['sample']['timestamp'] = 'bad'; $cases[] = $record;
    $record = $original; $record['sample'] = null; $cases[] = $record;
    foreach ($cases as $record) {
        $restored = StateStore::restore($record, 10, fn() => $h->now, fn() => $h->mono);
        check($restored->snapshot()['status'] === 'offline');
        check($restored->snapshot()['values'] === null);
    }
};
$tests['config defaults and valid overrides'] = static function (): void {
    environment([], static function (): void {
        $c = Config::fromEnvironment();
        check($c->host === 'mqtt-broker' && $c->port === 1883 && $c->prefix === 'evse/wallbox');
        check($c->clientId === 'evse-weboverlay' && $c->staleSeconds === 10 && $c->password() === '');
    });
    environment(['MQTT_PORT' => '0001883', 'WEB_STALE_SECONDS' => '120', 'MQTT_USERNAME' => 'test-user',
        'MQTT_PASSWORD' => 'test-secret'], static function (): void {
        $c = Config::fromEnvironment();
        check($c->port === 1883 && $c->staleSeconds === 120 && $c->password() === 'test-secret');
        ob_start(); var_dump($c); $debug = ob_get_clean();
        check(!str_contains($debug, 'test-secret') && !str_contains($debug, 'test-user'));
        check(!str_contains(json_encode($c, JSON_THROW_ON_ERROR), 'test-secret'));
    });
};
$tests['config invalid ASCII integers and field bounds'] = static function (): void {
    foreach (['0', '65536', '1x', '+1', '-1', ' 1883', '1883 ', '1.0', '1e3', '١٨٨٣', '', str_repeat('9', 100)] as $value) {
        environment(['MQTT_PORT' => $value], static fn() => rejects(static fn() => Config::fromEnvironment()));
    }
    foreach ([['MQTT_HOST', ''], ['MQTT_CLIENT_ID', ''], ['MQTT_CLIENT_ID', str_repeat('ä', 65)],
        ['MQTT_TOPIC_PREFIX', ''], ['MQTT_TOPIC_PREFIX', '/evse'], ['MQTT_TOPIC_PREFIX', 'evse/'],
        ['MQTT_TOPIC_PREFIX', 'evse/#'], ['MQTT_TOPIC_PREFIX', 'evse/+'], ['MQTT_TOPIC_PREFIX', str_repeat('x', 241)],
        ['MQTT_PASSWORD', 'test-secret'], ['WEB_STALE_SECONDS', '2'], ['WEB_STALE_SECONDS', '121'],
        ['MQTT_PASSWORD_FILE', '/does/not/exist']] as [$key, $value]) {
        environment([$key => $value], static function (): void {
            try { Config::fromEnvironment(); } catch (Throwable $e) {
                check(!str_contains($e->getMessage(), 'test-secret')); return;
            }
            throw new RuntimeException('Invalid configuration accepted');
        });
    }
};
$tests['secretfile UTF8 regular one-line bounds and diagnostics'] = static function (): void {
    $path = tempnam(sys_get_temp_dir(), 'evse-unit-');
    check($path !== false);
    try {
        foreach (['test-secret', "test-secret\n", "test-secret\r\n", str_repeat('😀', 4096)] as $content) {
            file_put_contents($path, $content);
            environment(['MQTT_USERNAME' => 'test', 'MQTT_PASSWORD_FILE' => $path], static function () use ($content): void {
                check(Config::fromEnvironment()->password() === rtrim($content, "\r\n"));
            });
        }
        foreach (['', "\n", "a\nb", "a\n\n", "a\rb", "\xff", str_repeat('a', 4097), str_repeat('😀', 4097)] as $content) {
            file_put_contents($path, $content);
            environment(['MQTT_USERNAME' => 'test', 'MQTT_PASSWORD_FILE' => $path], static fn() => rejects(static fn() => Config::fromEnvironment()));
        }
        file_put_contents($path, 'test-secret');
        environment(['MQTT_USERNAME' => 'test', 'MQTT_PASSWORD_FILE' => $path, 'MQTT_PASSWORD' => 'other-secret'],
            static fn() => rejects(static fn() => Config::fromEnvironment()));
        environment(['MQTT_PASSWORD_FILE' => $path], static fn() => rejects(static fn() => Config::fromEnvironment()));
        foreach ([sys_get_temp_dir(), 'php://memory', '/dev/null'] as $invalid) {
            environment(['MQTT_USERNAME' => 'test', 'MQTT_PASSWORD_FILE' => $invalid], static fn() => rejects(static fn() => Config::fromEnvironment()));
        }
    } finally {
        unlink($path);
    }
};

$failed = 0;
foreach ($tests as $name => $test) {
    try {
        $test();
        fwrite(STDOUT, 'PASS ' . $name . "\n");
    } catch (Throwable $error) {
        ++$failed;
        // Do not emit traces, payloads or credentials from exception arguments.
        fwrite(STDERR, 'FAIL ' . $name . ' (' . get_class($error) . ")\n");
    }
}
fwrite(STDOUT, count($tests) . ' cases, ' . $failed . " failures\n");
exit($failed === 0 ? 0 : 1);
