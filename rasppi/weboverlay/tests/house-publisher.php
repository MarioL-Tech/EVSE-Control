<?php
declare(strict_types=1);
require '/app/vendor/autoload.php';

use EvseOverlay\HousePublisher;

function check(bool $ok): void { if (!$ok) { throw new RuntimeException('House publisher assertion'); } }
function rejects(callable $callable, string $class): void
{
    try { $callable(); }
    catch (Throwable $error) { check($error instanceof $class); return; }
    throw new RuntimeException('Expected house publisher rejection');
}

$p = new HousePublisher();
$s = json_decode($p->json(), true, 16, JSON_THROW_ON_ERROR);
check($s['error'] === 'startup' && $s['power_w'] === null && $s['last_success_at'] === null);
check(array_keys($s) === ['schema_version', 'device', 'publisher_id', 'sequence', 'timestamp',
    'status', 'last_success_at', 'power_w', 'error']);
check($s['schema_version'] === 1 && $s['device'] === 'house_grid' && $s['status'] === 'error');
check(preg_match('/\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/', $s['publisher_id']) === 1);
check(preg_match('/\A\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z\z/', $s['timestamp']) === 1);
$wall = microtime(true) + 1;
foreach ([-800.5, 0.0, 1549.4, 9007199254740991.0] as $i => $power) {
    $p->observe($power, null, $wall + $i, 10 + $i);
    $value = json_decode($p->json(), true, 16, JSON_THROW_ON_ERROR);
    check($value['status'] === 'ok' && $value['power_w'] == $power);
    check($value['sequence'] === $i + 2 && $value['last_success_at'] === $value['timestamp']);
    check($value['publisher_id'] === $s['publisher_id']);
    check($p->online(10 + $i, 10) && !$p->online(20 + $i, 10));
    check($p->json() === $p->json());
}
$lastSuccess = json_decode($p->json(), true)['last_success_at'];
$p->observe(9007199254740992.0, null, $wall + 5);
check(json_decode($p->json(), true)['error'] === 'read_failed');
check(json_decode($p->json(), true)['last_success_at'] === $lastSuccess);
$p->observe(1.0, null, $wall + 4);
$bad = json_decode($p->json(), true);
check($bad['error'] === 'clock_error' && $bad['power_w'] === null && $bad['last_success_at'] === null);
$expiry = new HousePublisher();
$expiry->observe(0.0, null, null, 30);
$expiry->expire(40, 10);
check(json_decode($expiry->json(), true)['error'] === 'stale');
foreach ([INF, NAN, -1.0, 253370764800.0] as $invalid) {
    rejects(fn () => $p->observe(0, null, $invalid), RuntimeException::class);
}
foreach ([INF, NAN, -1.0] as $invalid) {
    rejects(fn () => $p->observe(0, null, $wall + 6, $invalid), InvalidArgumentException::class);
}
rejects(fn () => $p->observe(null, 'private-url'), InvalidArgumentException::class);
// Sequence rollover starts a new epoch, without reusing an identity.
$reflection = new ReflectionProperty(HousePublisher::class, 'sequence');
$reflection->setValue($p, 4294967295);
$p->observe(-1, null, $wall + 8);
$rolled = json_decode($p->json(), true);
check($rolled['sequence'] === 1 && $rolled['publisher_id'] !== $s['publisher_id']);
fwrite(STDOUT, "House observation checks passed\n");
