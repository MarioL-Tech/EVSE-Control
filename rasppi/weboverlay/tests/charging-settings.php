<?php
declare(strict_types=1);
require __DIR__ . '/../vendor/autoload.php';
use EvseOverlay\ChargingSettings;
use EvseOverlay\StrictJson;

$checks = 0;
function expect(bool $ok): void { global $checks; ++$checks; if (!$ok) throw new RuntimeException('Charging settings validation failed'); }
function asObject(array $a): stdClass { return json_decode(json_encode($a, JSON_THROW_ON_ERROR), false, 16, JSON_THROW_ON_ERROR); }
$defaults = ChargingSettings::defaults();
expect(ChargingSettings::validate(asObject($defaults)) === $defaults);
expect($defaults['pv']['max_import_w'] === null && $defaults['custom']['pv_enabled'] === null);
$valid = $defaults;
$valid['manual']['current_ma'] = 6000;
$valid['pv'] = ['max_import_w' => 123, 'max_current_ma' => 10000, 'adjust_seconds' => 7, 'pause_seconds' => 9, 'resume_seconds' => 11];
$valid['custom'] = [...$valid['pv'], 'use_schedule' => true, 'pv_enabled' => true, 'weekdays' => [1, 3, 7],
    'windows' => [['from' => '07:15', 'to' => '09:00'], ['from' => '22:30', 'to' => '06:00']], 'outside_window' => 'pause'];
expect(ChargingSettings::validate(asObject($valid)) === $valid);
$bad = [];
foreach ([null, [], ['phases' => 0, 'meter_includes_wallbox' => null],
    ['phases' => 4, 'meter_includes_wallbox' => null], ['phases' => '3', 'meter_includes_wallbox' => null],
    ['phases' => 3, 'meter_includes_wallbox' => 1], ['phases' => null],
    ['phases' => 3, 'meter_includes_wallbox' => true, 'current_ma' => 32000]] as $installation) {
    $b = $defaults; $b['installation'] = $installation; $bad[] = $b;
}
foreach ([1, 2, 3] as $phases) foreach ([true, false, null] as $includes) {
    $b = $defaults; $b['installation'] = ['phases' => $phases, 'meter_includes_wallbox' => $includes];
    expect(ChargingSettings::validate(asObject($b)) === $b);
}
foreach ([['schema_version', 2], ['timezone', 'UTC'], ['extra', 'rejected']] as [$key, $value]) { $b = $defaults; $b[$key] = $value; $bad[] = $b; }
foreach (['max_import_w' => [-1, 100001, '100', 1.5, false], 'max_current_ma' => [5999, 32001, '6000'],
    'pause_seconds' => [-1, 3601, 1.5]] as $key => $values) foreach ($values as $value) { $b = $defaults; $b['pv'][$key] = $value; $bad[] = $b; }
foreach (['weekdays' => [[0], [8], [1, 1], ['1']], 'pv_enabled' => [0, 'false'],
    'outside_window' => ['start', 'shell'], 'windows' => [[['from' => '24:00', 'to' => '05:00']],
    [['from' => '00:00', 'to' => '00:00']], [['from' => '07:00', 'to' => '08:00', 'extra' => 1]],
    array_fill(0, 17, ['from' => '01:00', 'to' => '02:00'])]] as $key => $values)
    foreach ($values as $value) { $b = $defaults; $b['custom'][$key] = $value; $bad[] = $b; }
foreach ($bad as $b) {
    $rejected = false; try { ChargingSettings::validate(asObject($b)); } catch (Throwable) { $rejected = true; }
    expect($rejected);
}
$rejected = false;
try { StrictJson::decode('{"schema_version":1,"schema_version":1}'); } catch (Throwable) { $rejected = true; }
expect($rejected);
$root = sys_get_temp_dir() . '/evse-charging-test-' . bin2hex(random_bytes(8));
mkdir($root, 0700); mkdir($root . '/weboverlay', 0700);
$path = $root . '/weboverlay/charging.json';
try {
    $store = new ChargingSettings($root, true);
    $r = $store->operate(); expect($r['status'] === 'ok' && $r['revision'] === null && !file_exists($path));
    file_put_contents($root . '/weboverlay/.env', '# untouched');
    $saved = $store->operate(null, $valid); expect($saved['status'] === 'ok' && $saved['config'] === $valid);
    expect($store->operate()['config'] === $valid);
    expect((fileperms($path) & 0777) === 0640);
    expect(file_get_contents($root . '/weboverlay/.env') === '# untouched');
    expect($store->operate(null, $defaults)['status'] === 'conflict');
    $again = $store->operate($saved['revision'], $defaults); expect($again['status'] === 'ok');
    expect($again['revision'] !== $saved['revision']);
    $lock = fopen($root . '/weboverlay/charging.lock', 'r+b'); flock($lock, LOCK_EX);
    expect($store->operate()['status'] === 'busy'); flock($lock, LOCK_UN); fclose($lock);
    unlink($path); file_put_contents($root . '/outside', 'untouched'); symlink($root . '/outside', $path);
    expect($store->operate()['status'] === 'unavailable' && file_get_contents($root . '/outside') === 'untouched');
    unlink($path); link($root . '/outside', $path); expect($store->operate()['status'] === 'unavailable'); unlink($path);
    file_put_contents($path, str_repeat('x', 16385)); expect($store->operate()['status'] === 'unavailable');
    expect((new ChargingSettings('/does-not-exist', false))->operate()['status'] === 'disabled');
} finally {
    foreach (glob($root . '/weboverlay/*') as $file) unlink($file);
    unlink($root . '/weboverlay/.env'); rmdir($root . '/weboverlay'); unlink($root . '/outside'); rmdir($root);
}
echo "Charging settings: $checks checks passed (Docker only; no hardware)\n";
