<?php
declare(strict_types=1);

require '/app/vendor/autoload.php';

use EvseOverlay\SmartmeterCache;
use EvseOverlay\SmartmeterClient;
use EvseOverlay\SmartmeterConfig;

$checks = 0;
function check(bool $ok): void
{
    global $checks;
    ++$checks;
    if (!$ok) { throw new RuntimeException('Smartmeter-Prüfung fehlgeschlagen: ' . $checks); }
}
function rejects(callable $operation): void
{
    try { $operation(); } catch (Throwable) { check(true); return; }
    check(false);
}

$sample = '234.40 232.90 234.40 348.60 164.90 309.90 1549.40 741.80 159.70 647.70 -799.40';
check(SmartmeterClient::parse($sample) === 1549.40);
foreach (['-12.5' => -12.5, '0' => 0.0, '-0' => -0.0, '+1.5e2' => 150.0] as $token => $expected) {
    check(SmartmeterClient::parse("1\t2 3\r\n4 5 6 $token 8") === $expected);
}
foreach (['', '1 2 3 4 5 6', "\xef\xbb\xbf" . $sample, '<html>' . $sample,
    str_repeat('1', 4097), "1 2 3 4 5 6 7\0"] as $invalid) {
    rejects(fn () => SmartmeterClient::parse($invalid));
}
foreach (['NaN', 'Inf', '-Infinity', '1,2', '0x10', '1_0', '1e999', '1e-999', '1e-310',
    str_repeat('0', 65), '.', '1e', "7\xc2\xa0"] as $invalid) {
    rejects(fn () => SmartmeterClient::parse("1 2 3 4 5 6 $invalid"));
    rejects(fn () => SmartmeterClient::parse("$invalid 2 3 4 5 6 7"));
}
check(!(new SmartmeterConfig())->enabled());
foreach (['ftp://example.invalid/a', 'http://user:pass@example.invalid/', 'http://example.invalid/#',
    'http://', 'http://example.invalid:0/', 'http://example.invalid:65536/',
    "http://example.invalid/\n", 'http://example.invalid/\\a', '0', str_repeat('x', 2049)] as $url) {
    rejects(fn () => new SmartmeterConfig($url));
}
foreach ([[0, 2, 10], [61, 2, 10], [2, 0, 10], [2, 6, 10], [2, 2, 2], [2, 2, 121]] as $limits) {
    rejects(fn () => new SmartmeterConfig('', ...$limits));
}
$config = new SmartmeterConfig('http://example.invalid/private-marker', 1, 1, 3);
ob_start(); var_dump($config); $debug = ob_get_clean();
check(!str_contains($debug, 'private-marker') && !str_contains($debug, 'example.invalid'));
foreach (['SMARTMETER_URL', 'SMARTMETER_POLL_SECONDS', 'SMARTMETER_TIMEOUT_SECONDS', 'SMARTMETER_STALE_SECONDS'] as $key) {
    putenv($key);
}
check(!SmartmeterConfig::fromEnvironment()->enabled());
putenv('SMARTMETER_POLL_SECONDS=1.5');
rejects(fn () => SmartmeterConfig::fromEnvironment());
putenv('SMARTMETER_POLL_SECONDS');
$dir = '/tmp/smartmeter-unit-' . bin2hex(random_bytes(8));
$wall = 1800000000.0; $mono = 100.0;
$make = static function () use ($dir, $config, &$wall, &$mono): SmartmeterCache {
    return new SmartmeterCache($dir, $config, static function () use (&$wall): float { return $wall; },
        static function () use (&$mono): float { return $mono; });
};
try {
    $cache = $make();
    check($cache->snapshot()['status'] === 'offline');
    $cache->reset(); check($cache->snapshot()['status'] === 'waiting');
    $cache->success(1549.4); $s = $cache->snapshot();
    check($s['status'] === 'live' && $s['power_w'] === 1549.4 && $s['age_seconds'] === 0.0);
    check(count($s) === 8 && $s['fresh_for_seconds'] === 3.0 && str_ends_with($s['fetched_at'], 'Z'));
    $wall += 2; $mono += 2; $cache->heartbeat();
    check($make()->snapshot()['age_seconds'] === 2.0);
    $wall += 1; $mono += 1; $cache->heartbeat();
    check($cache->snapshot()['status'] === 'stale' && $cache->snapshot()['power_w'] === null);
    $cache->success(1549.4); check($cache->snapshot()['age_seconds'] === 0.0);
    check($cache->snapshot()['fetched_at'] !== $s['fetched_at']);
    $cache->failure(); check($cache->snapshot()['status'] === 'read_error' && $cache->snapshot()['power_w'] === null);
    $cache->success(0); check($cache->snapshot()['power_w'] === 0.0);
    $wall -= 1; check($make()->snapshot()['status'] === 'clock_error');
    $wall += 2; $mono += 1; check($make()->snapshot()['status'] === 'clock_error');
    $cache->success(-9); check($cache->snapshot()['power_w'] === -9.0);
    $mono -= 1; check($cache->snapshot()['status'] === 'clock_error');
    $mono += 2; $cache->success(1); $wall += 3; $mono += 3;
    check($make()->snapshot()['status'] === 'offline');
    rejects(fn () => $cache->success(INF));
    foreach (['{}', str_repeat('x', 8193), '{broken', '{"version":1,"version":1}'] as $broken) {
        file_put_contents($dir . '/smartmeter.json', $broken);
        check($make()->snapshot()['status'] === 'offline');
    }
    $cache->reset();
    $lock = fopen($dir . '/smartmeter.lock', 'c'); flock($lock, LOCK_EX);
    $start = hrtime(true); check($cache->snapshot()['status'] === 'offline');
    check((hrtime(true) - $start) / 1e9 < 0.5);
    flock($lock, LOCK_UN); fclose($lock);
    check((new SmartmeterCache($dir, new SmartmeterConfig()))->snapshot()['status'] === 'disabled');
} finally {
    foreach (glob($dir . '/*') ?: [] as $file) { unlink($file); }
    @rmdir($dir);
}
fwrite(STDOUT, "Smartmeter: $checks Prüfungen erfolgreich\n");
