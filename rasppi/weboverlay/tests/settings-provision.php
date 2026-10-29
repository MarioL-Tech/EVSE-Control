<?php
declare(strict_types=1);
require_once __DIR__ . '/../docker/provision-settings.php';
require_once __DIR__ . '/../php/EnvSettingsCatalog.php';
require_once __DIR__ . '/../php/EnvSettingsStore.php';

use EvseOverlay\EnvSettingsStore;

$checks = 0;
function provisionCheck(bool $condition): void
{
    global $checks; ++$checks;
    if (!$condition) { throw new RuntimeException('Provision check ' . $checks); }
}
function provisionRemove(string $path): void
{
    if (is_link($path) || !is_dir($path)) { unlink($path); return; }
    foreach (scandir($path) as $name) if ($name !== '.' && $name !== '..') provisionRemove("$path/$name");
    rmdir($path);
}
$base = '/tmp/settings-provision-' . bin2hex(random_bytes(8));
mkdir($base, 0700);
$source = "$base/source"; mkdir($source, 0700);
$root = "$source/.evse-settings"; mkdir($root, 0700);
mkdir("$source/rasppi", 0700);
foreach (['wallbox', 'storage', 'weboverlay'] as $service) mkdir("$source/rasppi/$service", 0700);
$original = "# retain exact bytes\r\nWEB_PORT=8080\r\nMQTT_PASSWORD='dummy-only-private'\r\nUNKNOWN=keep\r\n";
$path = "$source/rasppi/weboverlay/.env";
file_put_contents($path, $original);
try {
    SettingsProvisioner::prepare($source, $root, posix_geteuid(), posix_getegid());
    provisionCheck(file_get_contents("$root/weboverlay/.env") === $original);
    provisionCheck(file_get_contents($path) === $original);
    foreach (['uart', 'wallbox', 'storage', 'weboverlay'] as $service) {
        provisionCheck((fileperms("$root/$service") & 07777) === 02750);
        provisionCheck((fileperms("$root/$service/.env") & 0777) === 0640);
    }
    SettingsProvisioner::prepare($source, $root, posix_geteuid(), posix_getegid());
    $store = new EnvSettingsStore($root, true);
    $snapshot = $store->read('weboverlay');
    provisionCheck($snapshot['status'] === 'ok');
    provisionCheck(!str_contains(json_encode($snapshot), 'dummy-only-private'));
    $saved = $store->update('weboverlay', $snapshot['revision'], ['WEB_PORT' => '8081']);
    provisionCheck($saved['status'] === 'ok');
    clearstatcache();
    provisionCheck((fileperms("$root/weboverlay/.env") & 0777) === 0640);
    provisionCheck(filegroup("$root/weboverlay/.env") === posix_getegid());
    $updated = file_get_contents("$root/weboverlay/.env");
    provisionCheck(str_contains($updated, "MQTT_PASSWORD='dummy-only-private'\r\nUNKNOWN=keep\r\n"));
    $failed = false;
    try { SettingsProvisioner::prepare($source, $root, posix_geteuid(), posix_getegid()); }
    catch (RuntimeException) { $failed = true; }
    provisionCheck($failed && file_get_contents("$root/weboverlay/.env") === $updated);
    rename($path, "$path.backup"); symlink("$root/weboverlay/.env", $path);
    SettingsProvisioner::prepare($source, $root, posix_geteuid(), posix_getegid());
    provisionCheck(file_get_contents($path) === $updated && file_get_contents("$path.backup") === $original);
    unlink($path); symlink('/unexpected/location', $path);
    $failed = false;
    try { SettingsProvisioner::prepare($source, $root, posix_geteuid(), posix_getegid()); }
    catch (RuntimeException) { $failed = true; }
    provisionCheck($failed && file_get_contents("$root/weboverlay/.env") === $updated);
    unlink($path); symlink('/host/project/.evse-settings/weboverlay/.env', $path);
    // Absolute host links cannot resolve inside a container; validate the exact
    // operator-supplied host root rather than following them into the host tree.
    SettingsProvisioner::prepare($source, $root, posix_geteuid(), posix_getegid(), '/host/project');
    provisionCheck(file_get_contents("$root/weboverlay/.env") === $updated);
} finally { provisionRemove($base); }
echo "Settings provisioning: $checks checks passed\n";
