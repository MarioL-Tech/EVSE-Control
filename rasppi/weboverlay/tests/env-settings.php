<?php
declare(strict_types=1);

// Docker-only standalone unit suite; every filesystem fixture is under a random /tmp tree.
require_once __DIR__ . '/../php/EnvSettingsCatalog.php';
require_once __DIR__ . '/../php/EnvSettingsStore.php';

use EvseOverlay\EnvSettingsCatalog;
use EvseOverlay\EnvSettingsStore;

$checks = 0;
set_exception_handler(static function (Throwable $error): void {
    global $checks;
    fwrite(STDERR, 'Env settings failure after check ' . $checks . ': ' . get_class($error) . ' at line ' . $error->getLine() . PHP_EOL);
    exit(1);
});
function envCheck(bool $condition): void
{
    global $checks;
    ++$checks;
    if (!$condition) { throw new RuntimeException('Env settings check failed: ' . $checks); }
}
function envRemove(string $path): void
{
    if (is_link($path) || !is_dir($path)) { unlink($path); return; }
    foreach (scandir($path) as $name) {
        if ($name !== '.' && $name !== '..') { envRemove($path . '/' . $name); }
    }
    rmdir($path);
}

$base = '/tmp/env-settings-unit-' . bin2hex(random_bytes(12));
mkdir($base, 0700);
$root = $base . '/settings';
mkdir($root, 0700);
foreach (EnvSettingsCatalog::SERVICES as $service) { mkdir($root . '/' . $service, 0700); }
$store = new EnvSettingsStore($root, true);
$other = new EnvSettingsStore($root, true);
$path = $root . '/weboverlay/.env';
$put = static function (string $text) use ($path): void {
    file_put_contents($path, $text); chmod($path, 0600);
};
$save = static function (array $changes) use ($store): array {
    $read = $store->read('weboverlay');
    return $store->update('weboverlay', $read['revision'] ?? null, $changes);
};
try {
    envCheck((new EnvSettingsStore($root))->read('weboverlay') === ['status' => 'disabled']);
    envCheck((new EnvSettingsStore($root))->update('weboverlay', null, [], true) === ['status' => 'disabled']);
    envCheck(!file_exists($root . '/weboverlay/.env.lock'));
    envCheck(array_keys($store->catalog()['services']) === EnvSettingsCatalog::SERVICES);
    foreach (['../storage', '/storage', 'weboverlay/.env', '', 'https', 'STORAGE'] as $service) {
        envCheck($store->read($service) === ['status' => 'invalid_service']);
        envCheck($store->update($service, null, [], true) === ['status' => 'invalid_service']);
    }
    envCheck($store->read('weboverlay')['status'] === 'missing');
    envCheck($store->update('weboverlay', null, ['WEB_PORT' => '8081'])['status'] === 'conflict');
    envCheck(!file_exists($path));
    $created = $store->update('weboverlay', null, ['WEB_PORT' => '8081'], true);
    envCheck($created['status'] === 'ok' && file_get_contents($path) === "WEB_PORT='8081'\n");
    envCheck($created['revision'] === hash_file('sha256', $path));
    envCheck((fileperms($path) & 0777) === 0600);
    envCheck((fileperms($root . '/weboverlay/.env.lock') & 0777) === 0600);
    envCheck($store->update('weboverlay', null, [], true)['status'] === 'conflict');

    $original = "# keep comment\r\nUNKNOWN_KEY=\"\${SOME_EXTERNAL}\" # untouched\r\n" .
        "export WEB_PORT = 8080 # keep inline\r\nMQTT_PASSWORD='private-marker\$literal'\r\n" .
        "SMARTMETER_URL='http://example.invalid/private-meter'\r\n" .
        "HISTORY_DB_PASSWORD_HOST_FILE='/not/read/secret-marker'\r\n" .
        "UNKNOWN_KEY=second\r\nWEB_BIND_ADDRESS=legacy-deployment-value";
    $put($original);
    $read = $store->read('weboverlay');
    envCheck($read['status'] === 'ok');
    envCheck($read['entries']['MQTT_PASSWORD']['configured']);
    envCheck(!array_key_exists('value', $read['entries']['MQTT_PASSWORD']));
    envCheck(!array_key_exists('value', $read['entries']['SMARTMETER_URL']));
    envCheck($read['entries']['HISTORY_DB_PASSWORD_HOST_FILE']['readonly']);
    $public = json_encode([$read, $store->catalog()]);
    foreach (['private-marker', 'private-meter', 'example.invalid', '/not/read', 'secret-marker', 'UNKNOWN_KEY'] as $marker) {
        envCheck(!str_contains($public, $marker));
    }
    ob_start(); var_dump($store); $debug = ob_get_clean();
    envCheck(!str_contains($debug, $root));
    envCheck($save(['WEB_BIND_ADDRESS' => 'legacy-deployment-value'])['revision'] === $read['revision']);
    envCheck(file_get_contents($path) === $original);
    $lockStat = stat($root . '/weboverlay/.env.lock');
    $updated = $save(['WEB_PORT' => '8082']);
    envCheck($updated['status'] === 'ok');
    envCheck(file_get_contents($path) === str_replace('8080 #', "'8082' #", $original));
    envCheck(stat($root . '/weboverlay/.env.lock')['ino'] === $lockStat['ino']);
    envCheck($other->update('weboverlay', $read['revision'], ['WEB_PORT' => '8083'])['status'] === 'conflict');
    envCheck($store->update('weboverlay', 'not-a-revision', [])['status'] === 'invalid');
    envCheck($save([])['revision'] === $updated['revision']);
    foreach (['MQTT_PASSWORD_FILE', 'MQTT_PASSWORD_HOST_FILE', 'HISTORY_DB_PASSWORD_FILE',
        'HISTORY_DB_PASSWORD_HOST_FILE', 'COMPOSE_PROFILES'] as $readonly) {
        envCheck($save([$readonly => '/arbitrary/new/path'])['status'] === 'invalid');
    }
    envCheck($save(['UNKNOWN_KEY' => 'changed'])['status'] === 'invalid');
    envCheck($save(['MQTT_PASSWORD' => null])['status'] === 'invalid');
    envCheck($save(['MQTT_PASSWORD' => 'replacement'])['status'] === 'invalid'); // Username required.
    envCheck($save(['MQTT_PASSWORD' => 'replacement', 'MQTT_USERNAME' => 'reader'])['status'] === 'ok');
    envCheck(!str_contains(json_encode($store->read('weboverlay')), 'replacement'));
    envCheck($save(['MQTT_PASSWORD' => ''])['entries']['MQTT_PASSWORD']['configured'] === false);
    envCheck(str_contains(file_get_contents($path), "MQTT_PASSWORD=''"));
    envCheck($save(['SMARTMETER_URL' => 'http://192.0.2.1/dev/powerValue.txt?meter=1'])['status'] === 'ok');
    envCheck(!str_contains(json_encode($store->read('weboverlay')), '192.0.2.1'));

    // Inputs must never become additional dotenv records, Compose expansions or shell syntax.
    foreach (["ok\nEVIL=1", "ok\rEVIL=1", "ok\0x", 'a\\b', "a'b", 'a"b', '${EVIL}',
        '$(touch marker)', '`id`', "x\t", "x\x7f", "\xff", str_repeat('a', 4097)] as $bad) {
        $before = file_get_contents($path);
        envCheck($save(['MQTT_PASSWORD' => $bad, 'MQTT_USERNAME' => 'reader'])['status'] === 'invalid');
        envCheck(file_get_contents($path) === $before);
    }
    foreach (['0', '65536', '-1', '8080;id', '1e3', '999999999999999999999999'] as $bad) {
        envCheck($save(['WEB_PORT' => $bad])['status'] === 'invalid');
    }
    foreach (['1.2.3', 'example.invalid', '127.0.0.1:80', ' 127.0.0.1', '[::1]'] as $bad) {
        envCheck($save(['WEB_BIND_ADDRESS' => $bad])['status'] === 'invalid');
    }
    foreach (['host;port=1', '../host', 'host:1883', '-host', 'a..b', str_repeat('a', 64) . '.test'] as $bad) {
        envCheck($save(['MQTT_HOST' => $bad])['status'] === 'invalid');
    }
    foreach (['ftp://example.invalid/', 'http://user:password@example.invalid/',
        'http://example.invalid/#fragment', 'http://example.invalid:0/', 'http://127.1/'] as $bad) {
        envCheck($save(['SMARTMETER_URL' => $bad])['status'] === 'invalid');
    }
    foreach (['WEB_STALE_SECONDS' => ['2', '121'], 'SMARTMETER_POLL_SECONDS' => ['0', '61'],
        'SMARTMETER_TIMEOUT_SECONDS' => ['0', '6'], 'SMARTMETER_STALE_SECONDS' => ['2', '121'],
        'WEB_HISTORY_ENABLED' => ['true', '2']] as $key => $values) {
        foreach ($values as $bad) { envCheck($save([$key => $bad])['status'] === 'invalid'); }
    }
    envCheck($save(['MQTT_TOPIC_PREFIX' => 'evse/+'])['status'] === 'invalid');
    envCheck($save(['DB_NETWORK' => '../network'])['status'] === 'invalid');
    envCheck($save(['WEB_TLS_HOST' => ''])['status'] === 'ok');
    $put("SMARTMETER_URL=  # disabled\nMQTT_USERNAME=reader\nMQTT_PASSWORD=\n");
    envCheck(!$store->read('weboverlay')['entries']['SMARTMETER_URL']['configured']);
    envCheck($save(['SMARTMETER_URL' => 'http://example.invalid/meter'])['status'] === 'ok');
    envCheck(str_contains(file_get_contents($path), "SMARTMETER_URL='http://example.invalid/meter'  # disabled\n"));
    envCheck($save(['MQTT_PASSWORD' => 'literal # hash ; plain text'])['status'] === 'ok');
    envCheck(str_contains(file_get_contents($path), "MQTT_PASSWORD='literal # hash ; plain text'"));

    foreach (["WEB_PORT=8080\nWEB_PORT=8081\n", "WEB_PORT=8080\nexport WEB_PORT=8081\n"] as $duplicate) {
        $put($duplicate);
        envCheck($store->read('weboverlay')['status'] === 'duplicate');
        envCheck($store->update('weboverlay', hash('sha256', $duplicate), ['WEB_PORT' => '8082'])['status'] === 'duplicate');
        envCheck(file_get_contents($path) === $duplicate);
    }
    foreach (["MQTT_HOST=\${EXTERNAL}\n", "MQTT_PASSWORD=\"\${EXTERNAL}\"\n", "WEB_PORT='8080\n8081'\n",
        "UNKNOWN='first\nWEB_PORT=8080\nlast'\n", "WEB_PORT=8080\r", "WEB_PORT=8080\0", "source /etc/passwd\n",
        "MQTT_PASSWORD='escaped\\'quote'\n"] as $unsupported) {
        $put($unsupported);
        envCheck($store->read('weboverlay')['status'] === 'unsupported');
        envCheck($store->update('weboverlay', hash('sha256', $unsupported), [])['status'] === 'unsupported');
    }
    $put('');
    envCheck($store->read('weboverlay')['revision'] === hash('sha256', ''));
    $put('WEB_PORT=8080');
    envCheck($save(['WEB_PORT' => '8081'])['status'] === 'ok');
    envCheck(file_get_contents($path) === "WEB_PORT='8081'");
    envCheck($save(['WEB_HTTPS_PORT' => '444'])['status'] === 'ok');
    envCheck(file_get_contents($path) === "WEB_PORT='8081'\nWEB_HTTPS_PORT='444'\n");

    $put('#' . str_repeat('a', 65535));
    envCheck($store->read('weboverlay')['status'] === 'ok');
    envCheck($save(['WEB_PORT' => '8080'])['status'] === 'limit');
    $put('#' . str_repeat('a', 65536));
    envCheck($store->read('weboverlay')['status'] === 'unavailable');
    $put(str_repeat('UNKNOWN=1' . "\n", 513));
    envCheck($store->read('weboverlay')['status'] === 'limit');
    $put(str_repeat("# comment\n", 2049));
    envCheck($store->read('weboverlay')['status'] === 'limit');
    $put("WEB_PORT=8080\n");
    $lock = fopen($root . '/weboverlay/.env.lock', 'r+b');
    flock($lock, LOCK_EX);
    $start = hrtime(true);
    envCheck($other->read('weboverlay')['status'] === 'busy');
    envCheck((hrtime(true) - $start) < 1000000000);
    envCheck($other->update('weboverlay', hash_file('sha256', $path), ['WEB_PORT' => '8081'])['status'] === 'busy');
    envCheck(file_get_contents($path) === "WEB_PORT=8080\n");
    flock($lock, LOCK_UN); fclose($lock);
    envCheck($other->read('weboverlay')['status'] === 'ok');
    $revision = $store->read('weboverlay')['revision'];
    envCheck($other->update('weboverlay', $revision, ['WEB_PORT' => '8081'])['status'] === 'ok');
    envCheck($store->update('weboverlay', $revision, ['WEB_PORT' => '8082'])['status'] === 'conflict');
    if (function_exists('pcntl_fork') && function_exists('pcntl_waitpid')) {
        $revision = $store->read('weboverlay')['revision'];
        $pair = stream_socket_pair(STREAM_PF_UNIX, STREAM_SOCK_STREAM, 0);
        envCheck($pair !== false);
        $children = [];
        foreach (['8083', '8084'] as $port) {
            $pid = pcntl_fork();
            envCheck($pid !== -1);
            if ($pid === 0) {
                fclose($pair[0]);
                fread($pair[1], 1); fclose($pair[1]);
                $result = (new EnvSettingsStore($root, true))->update('weboverlay', $revision, ['WEB_PORT' => $port]);
                file_put_contents($base . '/writer-' . $port, $result['status']);
                exit(0);
            }
            $children[] = $pid;
        }
        fclose($pair[1]); fwrite($pair[0], 'xx'); fclose($pair[0]);
        foreach ($children as $pid) {
            pcntl_waitpid($pid, $exit);
            envCheck(pcntl_wifexited($exit) && pcntl_wexitstatus($exit) === 0);
        }
        $statuses = [file_get_contents($base . '/writer-8083'), file_get_contents($base . '/writer-8084')];
        envCheck(count(array_filter($statuses, static fn($s) => $s === 'ok')) === 1);
        foreach ($statuses as $status) { envCheck(in_array($status, ['ok', 'conflict', 'busy'], true)); }
        envCheck(in_array($store->read('weboverlay')['entries']['WEB_PORT']['value'], ['8083', '8084'], true));
    } else {
        fwrite(STDOUT, "Env settings: fork race skipped (pcntl unavailable); lock contention checked\n");
    }

    // Symlink/hardlink/device/directory checks never touch the external target.
    $target = $base . '/untouched'; file_put_contents($target, 'target-marker');
    unlink($path); symlink($target, $path);
    envCheck($store->read('weboverlay')['status'] === 'unavailable');
    envCheck($store->update('weboverlay', null, [], true)['status'] === 'unavailable');
    envCheck(file_get_contents($target) === 'target-marker');
    foreach ([['STORAGE_RETENTION_MINUTE_DAYS' => '2', 'STORAGE_RETENTION_HOUR_DAYS' => '1'],
        ['STORAGE_RETENTION_MINUTE_DAYS' => '0', 'STORAGE_RETENTION_HOUR_DAYS' => '2'],
        ['STORAGE_RETENTION_MINUTE_DAYS' => '1', 'STORAGE_RETENTION_HOUR_DAYS' => '0', 'STORAGE_RETENTION_DAY_DAYS' => '2'],
        ['STORAGE_RETENTION_MINUTE_DAYS' => '36501']] as $bad) {
        envCheck($store->update('storage', $storage['revision'], $bad)['status'] === 'invalid');
    }
    envCheck($store->update('storage', $storage['revision'], ['STORAGE_RECORDING_MODE' => 'minute',
        'STORAGE_RETENTION_MINUTE_DAYS' => '365', 'STORAGE_RETENTION_HOUR_DAYS' => '730',
        'STORAGE_RETENTION_DAY_DAYS' => '0'])['status'] === 'ok');
    unlink($path); link($target, $path);
    envCheck($store->read('weboverlay')['status'] === 'unavailable');
    unlink($path); mkdir($path, 0700);
    envCheck($store->read('weboverlay')['status'] === 'unavailable');
    rmdir($path);
    if (function_exists('posix_mkfifo')) {
        posix_mkfifo($path, 0600);
        envCheck($store->read('weboverlay')['status'] === 'unavailable');
        unlink($path);
    }
    unlink($root . '/weboverlay/.env.lock');
    symlink($target, $root . '/weboverlay/.env.lock');
    envCheck($store->read('weboverlay')['status'] === 'unavailable');
    envCheck(file_get_contents($target) === 'target-marker');
    unlink($root . '/weboverlay/.env.lock');
    rmdir($root . '/weboverlay'); symlink($root . '/storage', $root . '/weboverlay');
    envCheck($store->read('weboverlay')['status'] === 'unavailable');
    unlink($root . '/weboverlay'); mkdir($root . '/weboverlay', 0700);
    symlink($root, $base . '/alias');
    envCheck((new EnvSettingsStore($base . '/alias', true))->read('storage')['status'] === 'unavailable');
    envCheck((new EnvSettingsStore($root . '/storage/..', true))->read('storage')['status'] === 'unavailable');
    chmod($root . '/weboverlay', 0777);
    envCheck($store->read('weboverlay')['status'] === 'unavailable');
    chmod($root . '/weboverlay', 0700);
    $put("WEB_PORT=8080\n"); chmod($path, 0666);
    envCheck($store->read('weboverlay')['status'] === 'unavailable');
    chmod($path, 0600);

    envCheck($store->update('uart', null, ['UART_DEVICE' => '/dev/serial0'], true)['status'] === 'ok');
    $uart = $store->read('uart');
    foreach (['/etc/passwd', '/dev/../secret', '/dev/x:device', '/dev/x;id'] as $bad) {
        envCheck($store->update('uart', $uart['revision'], ['UART_DEVICE' => $bad])['status'] === 'invalid');
    }
    envCheck($store->update('wallbox', null, ['WALLBOX_BAUD' => '57600', 'WALLBOX_PARITY' => 'E',
        'WALLBOX_SLAVE' => '9', 'WALLBOX_INTERVAL_MS' => '2000', 'WALLBOX_TIMEOUT_MS' => '1000'], true)['status'] === 'ok');
    $wallbox = $store->read('wallbox');
    foreach (['WALLBOX_BAUD' => '14400', 'WALLBOX_PARITY' => 'X', 'WALLBOX_SLAVE' => '248',
        'WALLBOX_INTERVAL_MS' => '1000', 'WALLBOX_TIMEOUT_MS' => '2000'] as $key => $bad) {
        envCheck($store->update('wallbox', $wallbox['revision'], [$key => $bad])['status'] === 'invalid');
    }
    envCheck($store->update('storage', null, ['DB_HOST' => 'evse-database', 'DB_PORT' => '3306',
        'DB_NAME' => 'energyControl', 'STORAGE_QUEUE_SIZE' => '256', 'HOUSE_HISTORY_SOURCE' => 'evse/house'], true)['status'] === 'ok');
    $storage = $store->read('storage');
    foreach (['STORAGE_QUEUE_SIZE' => '4097', 'DB_TIMEOUT_SECONDS' => '11', 'DB_NAME' => 'x;dbname=y',
        'DB_PASSWORD_FILE' => $target, 'DB_PASSWORD' => 'not-forwarded', 'MQTT_PASSWORD' => 'not-forwarded'] as $key => $bad) {
        envCheck($store->update('storage', $storage['revision'], [$key => $bad])['status'] === 'invalid');
    }
    envCheck(file_get_contents($target) === 'target-marker');
    foreach (glob($root . '/*/.env.tmp-*') as $temp) { envCheck(false); }
} finally {
    envRemove($base);
}
fwrite(STDOUT, "Env settings: $checks checks passed\n");
