<?php
declare(strict_types=1);

// Pure fixtures only. Execute in the Docker PHP test image, never against production.
require_once dirname(__DIR__) . '/php/MinuteHistory.php';
use EvseOverlay\MinuteHistory as Minute;

$checks = 0;
set_exception_handler(static function (Throwable $error): void {
    global $checks;
    fwrite(STDERR, 'Minute history failure after check ' . $checks . ': ' . get_class($error) . ' at line ' . $error->getLine() . PHP_EOL);
    exit(1);
});
function minuteCheck(bool $ok): void
{
    global $checks;
    if (!$ok) { throw new RuntimeException('Minute fixture failed'); }
    ++$checks;
}
function minuteReject(callable $call): void
{
    try { $call(); } catch (UnexpectedValueException|JsonException) { minuteCheck(true); return; }
    minuteCheck(false);
}
function minuteWallbox(): array
{
    $metrics = [];
    foreach (Minute::FIELDS as $f) {
        $mean = in_array($f, ['active_power_w','current_l1_a','current_l2_a','current_l3_a','voltage_l1_v','voltage_l2_v','voltage_l3_v'], true);
        $value = str_starts_with($f, 'voltage_') ? '230' : ($f === 'current_limit_a' ? '6' : '0');
        $metrics[$f] = ['n' => 2, 'nulls' => 0, 'sum' => $mean ? (string) ((int) $value * 2) : null,
            'min' => $value, 'max' => $value, 'first' => $value, 'last' => $value, 'mixed' => false];
    }
    return ['schema_version' => 1, 'samples' => 2, 'valid_samples' => 2, 'error_samples' => 0, 'retained_samples' => 0,
        'first_at' => '2026-10-29T12:00:01.000000Z', 'last_at' => '2026-10-29T12:00:59.000000Z',
        'has_gap' => false, 'complete' => true, 'coverage_seconds' => '60', 'metrics' => $metrics];
}
function minuteHouse(): array
{
    return ['bucket_start' => '2026-10-29T12:00:00.000000Z', 'bucket_end' => '2026-10-29T12:01:00.000000Z',
        'samples' => 2, 'valid_count' => 2, 'null_count' => 0, 'sum_w' => '-1000', 'min_w' => '-1000', 'max_w' => '0',
        'first_w' => '-1000', 'last_w' => '0', 'first_at' => '2026-10-29T12:00:01.000000Z',
        'last_at' => '2026-10-29T12:00:59.000000Z', 'coverage_ms' => 60000, 'has_gap' => false, 'complete' => true];
}
function minuteRow(array $d): array
{
    $json = json_encode($d, JSON_THROW_ON_ERROR);
    return ['bucket_start' => '2026-10-29 12:00:00.000000', 'data_json' => $json, 'digest' => hash('sha256', $json, true)];
}
$sample = Minute::sample('wallbox', minuteRow(minuteWallbox()));
minuteCheck($sample['timestamp'] === '2026-10-29T12:00:30.000000Z' && $sample['received_at'] === '2026-10-29T12:01:00.000000Z');
minuteCheck($sample['id'] === (string) (intdiv(strtotime('2026-10-29T12:00:00Z'), 60) + 1));
minuteCheck($sample['values']['active_power_w'] === 0.0 && $sample['values']['current_limit_a'] === 6.0);
minuteCheck($sample['values']['below_commanded_current'] === false && $sample['values']['voltage_v'] === [230.0,230.0,230.0]);
$d = minuteWallbox(); $d['metrics']['active_power_w'] = ['n' => 1, 'nulls' => 1, 'sum' => '100', 'min' => '100', 'max' => '100', 'first' => null, 'last' => '100', 'mixed' => false];
$sample = Minute::sample('wallbox', minuteRow($d));
minuteCheck($sample['values']['active_power_w'] === 100.0 && $sample['interval']['break_fields'] === ['active_power_w']);
$d = minuteWallbox();
$d['metrics']['current_limit_a'] = ['n' => 2, 'nulls' => 0, 'sum' => null, 'min' => '6', 'max' => '16', 'first' => '6', 'last' => '16', 'mixed' => true];
$sample = Minute::sample('wallbox', minuteRow($d));
minuteCheck($sample['values']['current_limit_a'] === 16.0 && $sample['interval']['break_fields'] === ['current_limit_a']);
$sample = Minute::sample('house', minuteRow(minuteHouse()));
minuteCheck($sample['power_w'] === -500.0 && $sample['interval']['break_fields'] === []);
$d = minuteHouse(); $d['valid_count'] = 0; $d['null_count'] = 2;
foreach (['sum_w','min_w','max_w','first_w','last_w'] as $key) { $d[$key] = null; }
$sample = Minute::sample('house', minuteRow($d));
minuteCheck($sample['power_w'] === null && $sample['interval']['break_fields'] === ['power_w']);
foreach (['wallbox','house'] as $kind) {
    $d = $kind === 'wallbox' ? minuteWallbox() : minuteHouse();
    $row = minuteRow($d); $row['digest'] = str_repeat('x', 32); minuteReject(fn() => Minute::sample($kind, $row));
    $row = minuteRow($d); $row['bucket_start'] = '2026-10-29 12:00:00.000001'; minuteReject(fn() => Minute::sample($kind, $row));
    $row = minuteRow($d); $row['data_json'] = str_repeat(' ', 32769); minuteReject(fn() => Minute::sample($kind, $row));
    $d['samples'] = 129; minuteReject(fn() => Minute::sample($kind, minuteRow($d)));
}
foreach ([static function (&$d) { $d['metrics']['active_power_w']['sum'] = '0.000001'; },
    static function (&$d) { $d['metrics']['plugged_in']['last'] = '0.1'; },
    static function (&$d) { $d['metrics']['charging']['mixed'] = true; },
    static function (&$d) { $d['metrics']['session_energy_wh']['sum'] = '0'; },
    static function (&$d) { $d['metrics']['current_l1_a']['nulls'] = 1; },
    static function (&$d) { $d['last_at'] = '2026-10-29T12:01:00.000000Z'; }] as $mutate) {
    $d = minuteWallbox(); $mutate($d); minuteReject(fn() => Minute::sample('wallbox', minuteRow($d)));
}
$d = minuteHouse(); $d['max_w'] = '9007199254740991.000001'; minuteReject(fn() => Minute::sample('house', minuteRow($d)));
$d = minuteHouse(); $d['sum_w'] = '-2000.000001'; minuteReject(fn() => Minute::sample('house', minuteRow($d)));

$from = Minute::date('2026-10-29 12:00:00.000000'); $to = $from->modify('+1 minute');
minuteCheck(Minute::read(static fn() => [], 'wallbox', 'fixture', $from, $to) === null);
$calls = [];
$reader = static function (string $sql, array $params = []) use (&$calls): array {
    $calls[] = [$sql, $params];
    minuteCheck(str_starts_with($sql, 'SELECT '));
    if (str_contains($sql, 'information_schema.TABLES')) {
        return array_map(static fn($name) => ['TABLE_NAME' => $name, 'ENGINE' => 'InnoDB'],
            ['evse_minute_records','evse_minute_schema_versions','evse_minute_sources']);
    }
    if (str_contains($sql, 'FROM evse_minute_schema_versions')) { return [['version' => '1', 'checksum' => strtoupper(Minute::SCHEMA_SHA256), 'applied_at' => '2026-10-29 11:00:00.000000']]; }
    if (str_contains($sql, 'FROM evse_minute_sources')) { minuteCheck($params === ['wallbox','fixture']); return [['started_at' => '2026-10-29 12:00:00.000000']]; }
    if (str_contains($sql, 'FROM evse_minute_records')) { minuteCheck($params[0] === 'wallbox' && $params[1] === 'fixture'); return [minuteRow(minuteWallbox())]; }
    if (str_contains($sql, 'FROM evse_ingest_events')) { return []; }
    throw new RuntimeException('Unexpected minute SQL');
};
$capture = Minute::read($reader, 'wallbox', 'fixture', $from, $to);
minuteCheck($capture['complete'] && count($capture['samples']) === 1 && count($calls) === 6);
minuteCheck(str_contains($calls[5][0], 'source = CAST(? AS BINARY)') && str_contains($calls[5][0], 'ORDER BY received_at DESC LIMIT 2'));
minuteCheck($calls[5][1] === ['fixture', '2026-10-29 11:59:50.000000']);
$raw = ['complete' => true, 'samples' => [['timestamp' => '2026-10-29T11:59:59.000000Z'], ['timestamp' => '2026-10-29T12:00:01.000000Z']]];
minuteCheck(Minute::merge($raw, null) === $raw);
$merged = Minute::merge($raw, $capture);
minuteCheck($merged['schema_version'] === 3 && count($merged['samples']) === 2 && $merged['samples'][0]['interval'] === null);
minuteCheck($merged['samples'][0]['break_before'] && $merged['samples'][1]['break_before']);
// Post-capture loss evidence must still invalidate otherwise immutable captures.
$late = static function ($sql, $params = []) use ($reader): array {
    if (str_contains($sql, 'received_at < ?')) { return []; }
    if (str_contains($sql, 'FROM evse_ingest_events')) { return [['received_at' => '2026-10-29 12:00:50.000000', 'kind' => 'ingestion_gap', 'availability' => null, 'retained' => '0']]; }
    return $reader($sql, $params);
};
minuteCheck(Minute::read($late, 'wallbox', 'fixture', $from, $to)['samples'][0]['interval']['has_gap']);
$missing = static fn($sql, $params = []) => str_contains($sql, 'FROM evse_minute_records') ? [] : $reader($sql, $params);
$empty = Minute::read($missing, 'wallbox', 'fixture', $from, $to);
minuteCheck(!$empty['complete'] && $empty['samples'] === []);
$tooMany = static fn($sql, $params = []) => str_contains($sql, 'FROM evse_minute_records') ? array_fill(0, 17, minuteRow(minuteWallbox())) : $reader($sql, $params);
minuteReject(fn() => Minute::read($tooMany, 'wallbox', 'fixture', $from, $to));
$badRegistry = static fn($sql, $params = []) => str_contains($sql, 'FROM evse_minute_schema_versions') ? [['version' => '1', 'checksum' => str_repeat('0', 64), 'applied_at' => '2026-10-29 11:00:00.000000']] : $reader($sql, $params);
minuteReject(fn() => Minute::read($badRegistry, 'wallbox', 'fixture', $from, $to));

// A foreign false has_gap never overrides deficient coverage in either product.
foreach (['wallbox','house'] as $kind) {
    foreach ([0, 59] as $seconds) {
        $d = $kind === 'wallbox' ? minuteWallbox() : minuteHouse();
        $d[$kind === 'wallbox' ? 'coverage_seconds' : 'coverage_ms'] = $kind === 'wallbox' ? (string) $seconds : $seconds * 1000;
        minuteCheck(Minute::sample($kind, minuteRow($d))['interval']['has_gap']);
    }
}
$event = static fn(string $time, string $kind = 'availability', ?string $availability = 'online', string $retained = '0'): array =>
    ['received_at' => '2026-10-29 ' . $time . '.000000', 'kind' => $kind, 'availability' => $availability, 'retained' => $retained];
$eventReader = static function (array $baseline, array $events = [], bool $second = false) use ($reader): Closure {
    return static function ($sql, $params = []) use ($reader, $baseline, $events, $second): array {
        if (str_contains($sql, 'FROM evse_ingest_events')) { return str_contains($sql, 'received_at < ?') ? $baseline : $events; }
        if ($second && str_contains($sql, 'FROM evse_minute_records')) {
            $d = minuteWallbox();
            foreach (['first_at','last_at'] as $key) { $d[$key] = str_replace('12:00:', '12:01:', $d[$key]); }
            $row = minuteRow($d); $row['bucket_start'] = '2026-10-29 12:01:00.000000';
            return [minuteRow(minuteWallbox()), $row];
        }
        return $reader($sql, $params);
    };
};
minuteCheck(!Minute::read($eventReader([]), 'wallbox', 'fixture', $from, $to)['samples'][0]['interval']['has_gap']);
minuteCheck(!Minute::read($eventReader([$event('11:59:40')]), 'wallbox', 'fixture', $from, $to)['samples'][0]['interval']['has_gap']);
foreach ([$event('11:59:40', 'availability', 'offline'), $event('11:59:40', 'broker_disconnected', null),
    $event('11:59:40', 'availability', 'online', '1')] as $bad) {
    minuteCheck(Minute::read($eventReader([$bad]), 'wallbox', 'fixture', $from, $to)['samples'][0]['interval']['has_gap']);
    // A newer unique online predecessor resolves only the earlier baseline state.
    minuteCheck(!Minute::read($eventReader([$event('11:59:45'), $bad]), 'wallbox', 'fixture', $from, $to)['samples'][0]['interval']['has_gap']);
}
foreach ([[$event('11:59:40'), $event('11:59:40', 'availability', 'offline')],
    [$event('11:59:40'), $event('11:59:40')]] as $tie) {
    foreach ([$tie, array_reverse($tie)] as $order) {
        minuteCheck(Minute::read($eventReader($order), 'wallbox', 'fixture', $from, $to)['samples'][0]['interval']['has_gap']);
    }
}
$later = $from->modify('+2 minutes');
$offline = $event('12:00:40', 'availability', 'offline');
$result = Minute::read($eventReader([], [$offline], true), 'wallbox', 'fixture', $from, $later);
minuteCheck($result['samples'][0]['interval']['has_gap'] && $result['samples'][1]['interval']['has_gap']);
$result = Minute::read($eventReader([], [$offline, $event('12:00:45')], true), 'wallbox', 'fixture', $from, $later);
minuteCheck($result['samples'][0]['interval']['has_gap'] && !$result['samples'][1]['interval']['has_gap']);
// Bad state within the local +/- context is not cleared by a later online there.
$result = Minute::read($eventReader([], [$event('12:00:55', 'availability', 'offline'), $event('12:00:56')], true), 'wallbox', 'fixture', $from, $later);
minuteCheck($result['samples'][1]['interval']['has_gap']);
$truncated = array_fill(0, 2401, $event('12:00:01'));
$result = Minute::read($eventReader([], $truncated), 'wallbox', 'fixture', $from, $to);
minuteCheck(!$result['complete'] && $result['samples'][0]['interval']['has_gap']);
$truncated[2400]['received_at'] = [];
minuteReject(fn() => Minute::read($eventReader([], $truncated), 'wallbox', 'fixture', $from, $to));
minuteReject(fn() => Minute::read($eventReader([$event('12:00:00')]), 'wallbox', 'fixture', $from, $to));
print('Minute history: ' . $checks . " fixture checks passed\n");
