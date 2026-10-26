<?php
declare(strict_types=1);
require dirname(__DIR__) . '/vendor/autoload.php';

use EvseOverlay\SharedState;
use EvseOverlay\StateStore;

function expectShared(bool $condition, string $label): void
{
    if (!$condition) { throw new RuntimeException($label); }
}

$directory = sys_get_temp_dir() . '/evse-shared-' . bin2hex(random_bytes(8));
$store = new SharedState($directory, 10);
$path = $directory . '/state.json';
try {
    expectShared($store->snapshot()['status'] === 'offline', 'Missing record must be offline');
    $store->reset();
    $timestamp = gmdate('Y-m-d\TH:i:s\Z');
    $sample = ['schema_version' => 1, 'device' => 'abb_terra_ac', 'timestamp' => $timestamp,
        'last_success_at' => $timestamp, 'status' => 'ok', 'error' => null,
        'values' => ['error_code' => 0, 'socket_lock_state' => 273, 'charging_state_raw' => 33024,
            'charging_state' => 1, 'below_commanded_current' => true, 'plugged_in' => null,
            'charging' => false, 'current_limit_a' => 6, 'current_a' => [0, 0, 0],
            'voltage_v' => [230, 231, 232], 'active_power_w' => 0, 'session_energy_wh' => 0]];
    $store->update(static function (StateStore $s) use ($sample): void {
        $s->connection(true);
        $s->acceptAvailability('online');
        $s->acceptSample(json_encode($sample, JSON_THROW_ON_ERROR));
    });
    $otherReader = new SharedState($directory, 10);
    expectShared($otherReader->snapshot()['status'] === 'live', 'Cross-instance live snapshot');
    expectShared($otherReader->snapshot()['values']['plugged_in'] === null, 'Unknown remains null');
    $original = json_decode(file_get_contents($path), true, 64, JSON_THROW_ON_ERROR);
    $otherReader->snapshot();
    $after = json_decode(file_get_contents($path), true, 64, JSON_THROW_ON_ERROR);
    expectShared($original['heartbeat'] === $after['heartbeat'], 'HTTP must not renew heartbeat');

    // A briefly backwards wall clock must stay latched across independent readers.
    $future = $original;
    $futureTime = gmdate('Y-m-d\TH:i:s\Z', time() + 20);
    $future['state']['sample']['timestamp'] = $futureTime;
    $future['state']['sample']['last_success_at'] = $futureTime;
    file_put_contents($path, json_encode($future, JSON_THROW_ON_ERROR));
    expectShared($otherReader->snapshot()['status'] === 'clock_error', 'Clock rollback detected');
    $latched = json_decode(file_get_contents($path), true, 64, JSON_THROW_ON_ERROR);
    expectShared($latched['state']['future_sample'] === true, 'Clock fault persisted for next reader');
    expectShared($latched['heartbeat'] === $original['heartbeat'], 'Latch cannot renew heartbeat');

    $expired = $original;
    $expired['heartbeat'] = hrtime(true) / 1e9 - 4;
    file_put_contents($path, json_encode($expired, JSON_THROW_ON_ERROR));
    $offline = $otherReader->snapshot();
    expectShared($offline['status'] === 'offline' && $offline['values'] === null && !$offline['broker_connected'], 'Dead worker fails closed');
    file_put_contents($path, '{broken');
    expectShared($otherReader->snapshot()['values'] === null, 'Corrupt record fails closed');
    file_put_contents($path, str_repeat('x', 65537));
    expectShared($otherReader->snapshot()['status'] === 'offline', 'Oversized record fails closed');
    file_put_contents($path, json_encode($original, JSON_THROW_ON_ERROR));
    $lock = fopen($directory . '/state.lock', 'c');
    flock($lock, LOCK_EX);
    $started = hrtime(true);
    expectShared($otherReader->snapshot()['status'] === 'offline', 'Busy lock fails closed');
    expectShared((hrtime(true) - $started) / 1e9 < 1, 'Bounded IPC lock wait');
    flock($lock, LOCK_UN);
    fclose($lock);
    $store->reset();
    expectShared($otherReader->snapshot()['status'] === 'offline', 'Worker restart clears samples and online');
    echo "Shared state IPC tests passed (roundtrip, clocks, heartbeat, corruption, lock, restart)\n";
} finally {
    foreach (glob($directory . '/*') ?: [] as $file) { unlink($file); }
    rmdir($directory);
}
