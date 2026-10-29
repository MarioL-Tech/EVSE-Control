<?php
declare(strict_types=1);

set_exception_handler(static function (Throwable $error): void {
    $label = $error::class === RuntimeException::class ? $error->getMessage() : $error::class;
    fwrite(STDERR, 'House history fixture: ' . $label . ' at ' . basename($error->getFile()) . ':' . $error->getLine() . "\n");
    exit(1);
});

// Container-only pure projections. No database, broker, source HTTP or browser required.
require dirname(__DIR__) . '/vendor/autoload.php';

use EvseOverlay\HouseHistoryConfig;
use EvseOverlay\HouseHistoryStore as Store;
use EvseOverlay\HouseHistoryArchive as Archive;
use EvseOverlay\HistoryRange;

$checks = 0;
function check(bool $condition, string $label): void
{
    global $checks;
    if (!$condition) { throw new RuntimeException($label); }
    ++$checks;
}
function rejects(callable $call, string $label): void
{
    try { $call(); } catch (UnexpectedValueException|InvalidArgumentException) { check(true, $label); return; }
    check(false, $label);
}
function sample(string $id, string $seconds, ?string $power = '-800.500000'): array
{
    return ['id' => $id, 'publisher_id' => str_repeat('a', 16), 'sequence' => $id,
        'fetched_at' => "2026-10-29 00:00:$seconds.000000", 'received_at' => "2026-10-29 00:00:$seconds.010000",
        'status' => $power === null ? 'error' : 'ok', 'power_w' => $power,
        'last_success_at' => $power === null ? null : "2026-10-29 00:00:$seconds.000000",
        'error_code' => $power === null ? 'read_failed' : null, 'retained' => '0'];
}
$from = Store::date('2026-10-29 00:00:00'); $to = Store::date('2026-10-29 00:01:00');
$baseline = ['id' => '1', 'kind' => 'availability', 'availability' => 'online', 'retained' => '0', 'received_at' => '2026-10-28 23:59:59.000000'];
$rows = [sample('1', '02'), sample('2', '04', '0.000000'), sample('3', '06', null), sample('4', '08')];
$project = static fn($r = null, $e = [], $b = null) => Store::project($r ?? $rows, $e, $b ?? [$baseline], $from, $to);
$p = $project();
check(array_keys(Store::envelope(15, 'ok', $to)) === ['schema_version','read_only','status','reason','generated_at','minutes','range','complete','samples'], 'raw top-level contract');
$microNow = Store::date('2026-10-29 00:15:00.900000');
$microEnvelope = Store::envelope(15, 'ok', $microNow);
check($microEnvelope['range'] === ['from' => '2026-10-29T00:00:00.900000Z', 'to' => '2026-10-29T00:15:00.900000Z'], 'raw bounds preserve SQL microseconds');
check(array_keys(Store::envelope(HistoryRange::parse('period=hour&date=2026-10-29T00%3A00&tz=UTC'), 'ok', $to)) ===
    ['schema_version','read_only','status','reason','generated_at','range','selection','navigation','aggregation','complete','progress','buckets'], 'calendar top-level contract');
check($p['samples'][0]['power_w'] === -800.5, 'signed import');
check($p['samples'][1]['power_w'] === 0.0, 'real zero');
check(!$p['samples'][1]['break_before'], 'proved neighbouring edge');
check($p['samples'][2]['power_w'] === null && $p['samples'][2]['break_before'] && $p['samples'][3]['break_before'], 'NULL blocks both neighbours');
check($p['samples'][0]['id'] === '1' && $p['samples'][0]['timestamp'] === '2026-10-29T00:00:02.000000Z', 'stable raw shape');
$edgeRows = [sample('1', '58'), sample('2', '59')];
$edgeRows[1]['received_at'] = '2026-10-29 00:01:00.010000';
$edgeProjection = $project($edgeRows);
check($edgeProjection['complete'] && !$edgeProjection['samples'][1]['break_before'], 'fetch window does not incorrectly bound the independent receipt time');
$edgeOffline = array_replace($baseline, ['id' => '2', 'availability' => 'offline', 'received_at' => '2026-10-29 00:01:00.005000']);
$edgeGap = $project($edgeRows, [$edgeOffline]);
check($edgeGap['complete'] && $edgeGap['samples'][1]['break_before'], 'receipt-offset event context preserves offline beyond fetch-window boundary');
check(array_keys($p['samples'][0]) === ['id','timestamp','received_at','status','power_w','break_before'], 'raw sample keys');
$retained = $rows; $retained[0]['retained'] = '1';
check($project($retained)['samples'][1]['break_before'], 'retained cannot heal');
$event = $baseline; $event['received_at'] = '2026-10-29 00:00:03.000000'; $event['availability'] = 'offline';
check($project(null, [$event])['samples'][1]['break_before'], 'offline barrier');
$event['availability'] = 'online';
check(!$project(null, [$event])['samples'][1]['break_before'], 'unique online refresh preserves continuity');
$offline = array_replace($event, ['id' => '2', 'availability' => 'offline', 'received_at' => '2026-10-29 00:00:02.500000']);
check($project(null, [$offline, $event])['samples'][1]['break_before'], 'real offline to online transition remains a barrier');
$event['received_at'] = '2026-10-29 00:00:04.010000';
check($project(null, [$event])['samples'][1]['break_before'], 'simultaneous event ambiguity');
$gapRows = [sample('1', '02'), sample('2', '04'), sample('3', '06'), sample('4', '08')];
$gap = ['id' => '2', 'kind' => 'ingestion_gap', 'availability' => null, 'retained' => '0',
    'received_at' => '2026-10-29 00:00:03.000000'];
$gapProjection = $project($gapRows, [$gap]);
check($gapProjection['samples'][1]['break_before'] && !$gapProjection['samples'][2]['break_before'], 'bounded loss breaks one edge then continuity resumes');
$olderOnline = $baseline; $olderOnline['received_at'] = '2026-10-28 23:59:58.000000';
$newerGap = $gap; $newerGap['received_at'] = '2026-10-28 23:59:59.000000';
check(!$project([$gapRows[0], $gapRows[1]], [], [$newerGap, $olderOnline])['samples'][1]['break_before'], 'bounded baseline retains known online state');
$conflictRows = [sample('1', '02'), sample('2', '04'), sample('3', '06'), sample('4', '08'), sample('5', '10')];
$online = ['id' => '2', 'kind' => 'availability', 'availability' => 'online', 'retained' => '0', 'received_at' => '2026-10-29 00:00:03.000000'];
$offline = array_replace($online, ['id' => '3', 'availability' => 'offline']);
$recovery = array_replace($online, ['id' => '4', 'received_at' => '2026-10-29 00:00:07.000000']);
foreach ([[$online, $offline, $recovery], [array_replace($offline, ['id' => '2']), array_replace($online, ['id' => '3']), $recovery]] as $conflicts) {
    $ambiguous = $project($conflictRows, array_reverse($conflicts));
    check($ambiguous['samples'][1]['break_before'] && $ambiguous['samples'][2]['break_before'] &&
        $ambiguous['samples'][3]['break_before'] && !$ambiguous['samples'][4]['break_before'], 'simultaneous online/offline never use ID order');
}
$lifecycleA = ['id' => '2', 'kind' => 'broker_connected', 'availability' => null, 'retained' => '0', 'received_at' => '2026-10-29 00:00:03.000000'];
$lifecycleB = array_replace($lifecycleA, ['id' => '3', 'kind' => 'ingestion_gap']);
$lifecycle = $project($conflictRows, [$lifecycleB, $recovery, $lifecycleA]);
check($lifecycle['samples'][1]['break_before'] && $lifecycle['samples'][2]['break_before'] &&
    $lifecycle['samples'][3]['break_before'] && !$lifecycle['samples'][4]['break_before'], 'simultaneous lifecycle group stays unknown until unique availability');
$rollback = [$rows[0], $rows[1]]; $rollback[0]['id'] = '9';
check(!$project($rollback)['complete'] && $project($rollback)['samples'][1]['break_before'], 'clock rollback in insertion order');
$epoch = [$rows[0], $rows[1]]; $epoch[1]['publisher_id'] = str_repeat('b',16);
check($project($epoch)['samples'][1]['break_before'], 'epoch boundary');
$jump = [$rows[0], $rows[1]]; $jump[1]['sequence'] = '8';
check($project($jump)['samples'][1]['break_before'], 'sequence boundary');
check($project([], [], [])['samples'] === [], 'empty raw');
check($project([$rows[0], $rows[1]], [], [])['samples'][1]['break_before'], 'no baseline does not prove availability');
$tie = $baseline; $tie['id'] = '2'; $tie['availability'] = 'offline';
check($project([$rows[0], $rows[1]], [], [$baseline, $tie])['samples'][1]['break_before'], 'ambiguous baseline cannot heal');
$many = array_fill(0, 1201, $rows[0]);
check(count($project($many)['samples']) === 1200 && !$project($many)['complete'], 'raw cap');
$largeId = $rows[0]; $largeId['id'] = '18446744073709551615';
check($project([$largeId])['samples'][0]['id'] === '18446744073709551615', 'raw UInt64 not converted');
$clockError = $rows[2]; $clockError['error_code'] = 'clock_error'; $clockError['last_success_at'] = '2026-10-29 00:00:50.000000';
check($project([$clockError])['samples'][0]['power_w'] === null, 'clock error preserves prior success without fabricating power');
check(Store::uint('18446744073709551615', '18446744073709551615') === '18446744073709551615', 'UInt64 string');
check(Store::SCHEMA_SHA256 === 'db10ad75e9947799db2a896f3211c2c3ba6f64afa75219620630dcbb8a139391', 'HOUSE migration checksum pin');
rejects(static fn() => Store::uint('18446744073709551616', '18446744073709551615'), 'UInt64 overflow');
foreach (['9007199254740991.000001', '-9007199254740992', 'NaN', '1e3', '0,1', INF] as $bad) {
    rejects(static fn() => Store::decimal($bad), 'invalid signed decimal');
}
check(Store::decimal('-9007199254740991.000000') === -9007199254740991.0, 'negative safe limit');
check(Store::iso(new DateTimeImmutable('2026-10-29 01:00:00.123456', new DateTimeZone('Europe/Vienna'))) === '2026-10-29T00:00:00.123456Z', 'microsecond UTC output');
rejects(static fn() => Store::date('2026-02-30 00:00:00'), 'impossible date');
rejects(static fn() => Store::date('1969-12-31 23:59:59'), 'date below supported year');
foreach (['minutes=0','minutes=15&x=1','minutes=1&minutes=5','period=year&date=2026&tz=bad'] as $bad) {
    rejects(static fn() => HistoryRange::parse($bad), 'query whitelist');
}
$hour = HistoryRange::parse('period=hour&date=2026-10-29T00%3A00&tz=UTC');
function bucket(int $minute, ?string $last = '-2.000000'): array
{
    $a = sprintf('2026-10-29 00:%02d:00.000000', $minute);
    $b = $minute === 59 ? '2026-10-29 01:00:00.000000' : sprintf('2026-10-29 00:%02d:00.000000', $minute + 1);
    return ['level' => 'minute', 'bucket_start' => $a, 'bucket_end' => $b, 'samples' => '2', 'valid_count' => $last === null ? '1' : '2',
        'null_count' => $last === null ? '1' : '0', 'sum_w' => $last === null ? '-2.000000' : '-4.000000', 'min_w' => '-2.000000',
        'max_w' => '-2.000000', 'first_w' => '-2.000000', 'last_w' => $last, 'first_at' => $a,
        'last_at' => sprintf('2026-10-29 00:%02d:58.000000', $minute), 'coverage_ms' => '58000', 'has_gap' => '1', 'complete' => '1'];
}
$buckets = array_map(static fn($i) => bucket($i), range(0,59));
$p = Archive::project($hour, $buckets);
check($p['complete'] && count($p['buckets']) === 60, 'complete materialization distinct from physical gaps');
check($p['buckets'][0]['has_gap'] && $p['buckets'][0]['metrics']['power_w']['mean'] === -2.0, 'signed materialization');
check(array_keys($p['buckets'][0]['metrics']) === ['power_w'] && $p['buckets'][0]['metrics']['power_w']['mixed'] === false, 'power only metrics');
check(array_keys($p['buckets'][0]) === ['from','to','samples','has_gap','complete','coverage_seconds','metrics'] &&
    array_keys($p['buckets'][0]['metrics']['power_w']) === ['count','nulls','mean','min','max','last','mixed'], 'calendar bucket contract');
$p = Archive::project($hour, [bucket(0, null)]);
check($p['buckets'][0]['metrics']['power_w']['last'] === null && $p['buckets'][0]['metrics']['power_w']['count'] === 1, 'real last NULL');
$p = Archive::project($hour, $buckets, [[$hour->from->getTimestamp(), $hour->from->getTimestamp()+60]]);
check(!$p['complete'] && $p['buckets'][0]['samples'] === 0 && $p['buckets'][0]['metrics']['power_w']['mean'] === null, 'pending suppresses stale values');
check($p['buckets'][1]['metrics']['power_w']['mean'] === -2.0, 'pending does not destroy unrelated bucket');
$p = Archive::project($hour, []);
check(!$p['complete'] && $p['buckets'][0]['metrics']['power_w']['mean'] === null, 'missing bucket not zero');
$empty = bucket(0);
foreach (['samples','valid_count','null_count','coverage_ms'] as $k) { $empty[$k] = '0'; }
foreach (['sum_w','min_w','max_w','first_w','last_w','first_at','last_at'] as $k) { $empty[$k] = null; }
check(Archive::project($hour, [$empty])['buckets'][0]['metrics']['power_w']['last'] === null, 'empty endpoint semantics');
$day = HistoryRange::parse('period=day&date=2026-10-29&tz=UTC');
$dayNull = Archive::project($day, [bucket(0), bucket(1, null), array_replace($empty, ['bucket_start' => '2026-10-29 00:02:00.000000', 'bucket_end' => '2026-10-29 00:03:00.000000'])]);
check($dayNull['buckets'][0]['metrics']['power_w']['last'] === null && $dayNull['buckets'][0]['metrics']['power_w']['mean'] === -2.0, 'empty after NULL cannot resurrect last value');
$zero = bucket(0);
foreach (['sum_w','min_w','max_w','first_w','last_w'] as $k) { $zero[$k] = '0.000000'; }
check(Archive::project($hour, [$zero])['buckets'][0]['metrics']['power_w']['mean'] === 0.0, 'archive true zero');
$bad = $empty; $bad['first_at'] = $bad['bucket_start'];
rejects(static fn() => Archive::project($hour, [$bad]), 'empty timestamp invalid');
$bad = bucket(0); $bad['sum_w'] = '10.000000';
rejects(static fn() => Archive::project($hour, [$bad]), 'inconsistent sum');
rejects(static fn() => Archive::project($hour, [bucket(0),bucket(0)]), 'duplicate bucket');
foreach (['2026-03-29' => 23, '2026-10-25' => 25] as $date => $hours) {
    $range = HistoryRange::parse('period=day&date=' . $date . '&tz=Europe%2FVienna');
    check($range->to->getTimestamp() - $range->from->getTimestamp() === $hours * 3600, 'DST boundaries');
}
$year = HistoryRange::parse('period=year&date=2024&tz=Europe%2FVienna');
$segments = Archive::segments($year);
check(count($segments) === 1 && $segments[0][0] === 'hour' && ($segments[0][2]-$segments[0][1])/3600 === 8784, 'leap year bounded hours');
check(count(Archive::project($year, [])['buckets']) === 366, 'leap year daily output');
$week = HistoryRange::parse('period=week&date=2026-W01&tz=UTC');
check($week->from->format('Y-m-d') === '2025-12-29', 'ISO year crossing');
rejects(static fn() => HistoryRange::parse('period=custom&from=2024-01-01T00%3A00%3A00Z&to=2025-01-02T00%3A00%3A00Z&tz=UTC'), 'one calendar year maximum');
$never = static function () { throw new RuntimeException('Must not connect'); };
check((new Store(new HouseHistoryConfig(), $never))->snapshot()['status'] === 'disabled', 'disabled raw no DB');
check((new Archive(new HouseHistoryConfig(), $never))->snapshot($hour)['status'] === 'disabled', 'disabled archive no DB');
$enabled = new HouseHistoryConfig(true, 'localhost', 3306, 'evse_house_test', 'reader', 'test/house', 'dummy-only');
check((new Store($enabled, $never))->snapshot()['status'] === 'unavailable', 'safe failure raw');
check((new Archive($enabled, $never))->snapshot($hour)['status'] === 'unavailable', 'safe failure archive');
putenv('WEB_HOUSE_HISTORY_ENABLED=0'); putenv('WEB_HISTORY_ENABLED=invalid'); putenv('HISTORY_DB_PASSWORD_FILE=/unreadable');
check(!HouseHistoryConfig::fromEnvironment()->enabled, 'independent disabled config');
$defaults = new HouseHistoryConfig(enabled: true, password: 'dummy-only');
check($defaults->prefix === 'evse/house' && $defaults->host === 'evse-database' && $defaults->database === 'energyControl', 'independent HOUSE defaults');
echo "House history: $checks checks passed\n";
