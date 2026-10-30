<?php
declare(strict_types=1);
require __DIR__ . '/../vendor/autoload.php';
require_once __DIR__ . '/../php/ChargingModeStore.php';
use EvseOverlay\ChargingSettings;
use EvseOverlay\ChargingModeStore;

$checks = 0;
function check(bool $ok): void { global $checks; ++$checks; if (!$ok) throw new RuntimeException('Charging mode fixture failed'); }
$root = sys_get_temp_dir() . '/evse-mode-' . bin2hex(random_bytes(8));
mkdir($root, 0700); mkdir($root . '/weboverlay', 0700);
$path = $root . '/weboverlay/charging-active.json';
$settingsPath = $root . '/weboverlay/charging.json';
$guard = str_repeat('a', 32);
try {
    $drafts = new ChargingSettings($root, true); $store = new ChargingModeStore($root, true);
    $initial = $store->read();
    check($initial['status'] === 'ok' && $initial['mode_revision'] === null && !file_exists($path));
    check($initial['active']['mode'] === 'manual' && $initial['active']['id'] === str_repeat('0', 32));
    check($initial['active']['guard'] === str_repeat('0', 32));
    $sha = ChargingModeStore::draftRevision($drafts->operate());
    $missing = $store->activate('pv', null, $sha, $guard);
    check($missing['status'] === 'invalid' && $missing['reason'] === 'missing_configuration');
    check($missing['required'] === ['installation.phases', 'installation.meter_includes_wallbox', 'pv.max_import_w',
        'pv.max_current_ma', 'pv.adjust_seconds', 'pv.pause_seconds', 'pv.resume_seconds']);
    check(!file_exists($path));
    check($store->activate('manual', null, $sha, 'bad')['status'] === 'invalid');
    $first = $store->activate('manual', null, $sha, $guard);
    check($first['status'] === 'ok' && $first['active']['guard'] === $guard);
    check((fileperms($path) & 0777) === 0640);
    check($first['mode_revision'] === hash_file('sha256', $path));
    $second = $store->activate('manual', $first['mode_revision'], $sha, $guard);
    check($second['active']['id'] !== $first['active']['id'] && $second['mode_revision'] !== $first['mode_revision']);
    check($store->activate('manual', $first['mode_revision'], $sha, $guard)['status'] === 'conflict');
    $c = ChargingSettings::defaults();
    $c['installation'] = ['phases' => 3, 'meter_includes_wallbox' => true];
    $c['pv'] = ['max_import_w' => 0, 'max_current_ma' => 32000, 'adjust_seconds' => 0, 'pause_seconds' => 0, 'resume_seconds' => 0];
    $saved = $drafts->operate(null, $c); check($saved['status'] === 'ok');
    check($store->read() === $second);
    check($store->activate('pv', $second['mode_revision'], $sha, $guard)['status'] === 'conflict');
    $pv = $store->activate('pv', $second['mode_revision'], $saved['revision'], $guard);
    check($pv['status'] === 'ok' && $pv['active']['config'] === $c);
    $legacy = $c; unset($legacy['installation']);
    check($drafts->operate($saved['revision'], $legacy)['status'] === 'invalid');
    // Legacy raw SHA remains unchanged despite normalized nullable installation on read.
    $legacyBody = ChargingModeStore::encode($legacy); file_put_contents($settingsPath, $legacyBody);
    $read = $drafts->operate();
    check($read['revision'] === hash('sha256', $legacyBody));
    check($read['config']['installation'] === ChargingSettings::defaults()['installation']);
    check(file_get_contents($settingsPath) === $legacyBody && $store->read() === $pv);
    $custom = ChargingSettings::defaults();
    $custom['installation']['phases'] = 1;
    $custom['custom'] = [...$c['pv'], 'max_import_w' => null, 'use_schedule' => false, 'pv_enabled' => false,
        'weekdays' => [], 'windows' => [], 'outside_window' => null];
    check(ChargingModeStore::required('custom', $custom) === []);
    $custom['custom']['use_schedule'] = true;
    check(ChargingModeStore::required('custom', $custom) === ['custom.weekdays', 'custom.windows', 'custom.outside_window']);
    $custom['custom']['pv_enabled'] = true;
    check(in_array('installation.meter_includes_wallbox', ChargingModeStore::required('custom', $custom), true));
    $lock = fopen($root . '/weboverlay/charging.lock', 'r+b'); flock($lock, LOCK_EX);
    check($store->activate('manual', $pv['mode_revision'], $read['revision'], $guard)['status'] === 'busy');
    flock($lock, LOCK_UN); fclose($lock);
    $lock = fopen($root . '/weboverlay/charging-active.lock', 'r+b'); flock($lock, LOCK_EX);
    check($store->read()['status'] === 'busy'); flock($lock, LOCK_UN); fclose($lock);
    file_put_contents($path, '{"schema_version":1,"schema_version":1}');
    check($store->read()['status'] === 'unavailable');
    check($store->activate('manual', hash_file('sha256', $path), $read['revision'], $guard)['status'] === 'unavailable');
    unlink($path); file_put_contents($root . '/outside', 'untouched');
    symlink($root . '/outside', $path); check($store->read()['status'] === 'unavailable'); unlink($path);
    link($root . '/outside', $path); check($store->read()['status'] === 'unavailable'); unlink($path);
    check(file_get_contents($root . '/outside') === 'untouched');
    file_put_contents($path, str_repeat('x', 16385)); check($store->read()['status'] === 'unavailable'); unlink($path);
    chmod($root . '/weboverlay', 0770); check($store->read()['status'] === 'unavailable'); chmod($root . '/weboverlay', 0700);
    unlink($root . '/weboverlay/charging-active.lock'); symlink($root . '/outside', $root . '/weboverlay/charging-active.lock');
    check($store->read()['status'] === 'unavailable');
    check((new ChargingModeStore('/does-not-exist', false))->read()['status'] === 'disabled');
} finally {
    foreach (glob($root . '/weboverlay/*') as $file) unlink($file);
    rmdir($root . '/weboverlay'); if (file_exists($root . '/outside')) unlink($root . '/outside'); rmdir($root);
}
echo "Charging mode: $checks checks passed (Docker only; no hardware)\n";
