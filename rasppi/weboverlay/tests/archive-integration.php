<?php
declare(strict_types=1);

// Docker-only second phase: legacy history-integration.cjs finishes against schema 1 first.
require '/app/vendor/autoload.php';
require __DIR__ . '/archive-fixtures.php';

use EvseOverlay\HistoryArchive;
use EvseOverlay\HistoryConfig;
use EvseOverlay\HistoryRange;
use EvseOverlay\HistoryStore;

archiveAssert(getenv('HISTORY_TEST_DB_HOST') === 'history-db');
archiveAssert(getenv('HISTORY_TEST_ROOT_PASSWORD') === 'dummy-only-history-root');
$dsn = 'mysql:host=history-db;port=3306;dbname=evse_history_test;charset=utf8mb4';
$options = [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_EMULATE_PREPARES => false, PDO::ATTR_STRINGIFY_FETCHES => true];
$root = new PDO($dsn, 'root', 'dummy-only-history-root', $options);
$config = new HistoryConfig(true, 'history-db', 3306, 'evse_history_test', 'history_reader', 'isolated/archive', 'dummy-only-reader');
$writerConfig = new HistoryConfig(true, 'history-db', 3306, 'evse_history_test', 'history_writer', 'isolated/archive', 'dummy-only-writer');
$reader = new PDO($dsn, 'history_reader', 'dummy-only-reader', $options);
$range = HistoryRange::parse('period=day&date=2026-01-01&tz=UTC');
$start = $range->from->getTimestamp();
$case = 'setup'; $completed = 0; $server = null; $secret = null; $failed = false;
$run = static function (string $label, callable $operation) use (&$case, &$completed): void {
    $case = $label; $operation(); ++$completed; print("ok $completed - $label\n");
};
$insert = static function (array $row, string $source = 'isolated/archive') use ($root): void {
    $root->prepare('INSERT INTO evse_history_buckets (source,resolution_seconds,bucket_start,data_json,updated_at) VALUES (?,?,?,?,UTC_TIMESTAMP(6))')->execute(
        [$source, $row['resolution_seconds'], $row['bucket_start'], $row['data_json']]);
};
$snapshot = static fn() => (new HistoryArchive($config))->snapshot($range);
$reset = static function () use ($root): void {
    // Only this disposable fixture, no production path. Legacy raw rows are left untouched.
    $root->exec('DELETE FROM evse_history_buckets; DELETE FROM evse_history_work; DELETE FROM evse_history_state;');
    $root->exec("INSERT INTO evse_history_state (source,algorithm_version,sample_cursor,sample_highwater,samples_done,events_done,updated_at,initialized,event_cursor_at,event_cursor_id,event_highwater_at,event_highwater_id)
        VALUES ('isolated/archive',1,5,5,1,1,UTC_TIMESTAMP(6),1,'1000-01-01',UNHEX(REPEAT('00',16)),'1000-01-01',UNHEX(REPEAT('00',16)))");
};
try {
    $run('archive unavailable at schema 1; raw API remains schema 1', static function () use ($snapshot, $config): void {
        archiveAssert($snapshot()['status'] === 'unavailable');
        archiveAssert((new HistoryStore($config))->snapshot()['schema_version'] === 1);
    });
    $run('canonical additive 002 migration in isolated database only', static function () use ($root): void {
        $sql = file_get_contents('/fixtures/002_newhistory.sql');
        archiveAssert(is_string($sql) && strlen($sql) < 65536);
        // This is fixture setup with explicit root, never called by the website reader.
        foreach (explode(';', $sql) as $statement) {
            if (trim($statement) !== '') { $root->exec($statement); }
        }
        foreach (['evse_history_buckets', 'evse_history_work', 'evse_history_state'] as $table) {
            $root->exec("GRANT SELECT ON evse_history_test.$table TO 'history_reader'@'%'");
        }
        $root->exec('INSERT INTO evse_schema_versions VALUES (2,UTC_TIMESTAMP(6))');
    });
    $run('table-specific reader grants reject writes; writer still read-only in API', static function () use ($reader, $writerConfig, $range): void {
        foreach (["INSERT INTO evse_history_work VALUES ('forbidden',60,'2026-01-01',1,0,1)",
            'UPDATE evse_history_buckets SET updated_at=UTC_TIMESTAMP(6) WHERE source=0x00',
            'DELETE FROM evse_history_state WHERE source=0x00', 'CREATE TABLE forbidden_archive (id INT)'] as $sql) {
            archiveReject(static fn() => $reader->exec($sql));
        }
        archiveAssert((new HistoryArchive($writerConfig))->snapshot($range)['read_only']);
    });
    $run('missing state and unready progress cannot assert completeness', static function () use ($reset, $root, $snapshot, $insert, $start): void {
        archiveAssert($snapshot()['status'] === 'unavailable');
        $reset(); $insert(archiveFixture($start));
        $root->exec("UPDATE evse_history_state SET samples_done=0,events_done=0,sample_cursor=0 WHERE source='isolated/archive'");
        $v = $snapshot();
        archiveAssert($v['status'] === 'ok' && !$v['complete'] && !$v['progress']['samples_done'] && !$v['buckets'][0]['complete']);
    });
    $run('exact binary source, weighted means, counter last and nullable flags', static function () use ($reset, $insert, $snapshot, $start): void {
        $reset(); $insert(archiveFixture($start, 60, 2, 100)); $insert(archiveFixture($start + 60, 60, 6, 300));
        $insert(archiveFixture($start, 60, 20, 9999), 'isolated/Archive');
        $v = $snapshot();
        archiveAssert($v['status'] === 'ok' && $v['buckets'][0]['samples'] === 8);
        $m = $v['buckets'][0]['metrics'];
        archiveAssert($m['active_power_w']['mean'] === 250.0 && $m['charging']['last'] === false);
        archiveAssert($m['session_energy_wh']['mean'] === null && $m['session_energy_wh']['last'] === 2000.0);
        archiveAssert($v['buckets'][1]['metrics']['charging']['last'] === null);
    });
    $run('indexed pending work masks stale materialization', static function () use ($root, $snapshot): void {
        $root->exec("INSERT INTO evse_history_work VALUES ('isolated/archive',60,'2026-01-01',2,1,1)");
        $v = $snapshot(); archiveAssert($v['status'] === 'ok' && !$v['buckets'][0]['complete'] && $v['buckets'][0]['has_gap']);
        archiveAssert($v['buckets'][0]['metrics']['active_power_w']['last'] === null);
    });
    $run('dirty child minute invalidates preexisting parent hour', static function () use ($reset, $root, $insert, $start, $config): void {
        $reset(); $insert(archiveFixture($start, 3600));
        $root->exec("INSERT INTO evse_history_work VALUES ('isolated/archive',60,'2026-01-01 00:15:00',2,1,1)");
        $r = HistoryRange::parse('period=year&date=2026&tz=UTC');
        $v = (new HistoryArchive($config))->snapshot($r);
        archiveAssert($v['status'] === 'ok' && !$v['buckets'][0]['complete'] && $v['buckets'][0]['metrics']['active_power_w']['last'] === null);
    });
    $run('metric NULLs remain local through SQL and PHP projection', static function () use ($reset, $insert, $snapshot, $start): void {
        $reset();
        // Five minutes fill the first day-view bin: missing intervals cannot
        // mask whether an unrelated metric NULL changed global coverage.
        for ($i = 0; $i < 5; ++$i) {
            $insert(archiveMutate(archiveFixture($start + $i * 60, 60, 2, 0), static function (&$d) use ($i): void {
                $d['metrics']['charging'] = ['n' => 0, 'nulls' => 2, 'sum' => null,
                    'min' => null, 'max' => null, 'first' => null, 'last' => null, 'mixed' => false];
                foreach (['voltage_l1_v', 'voltage_l2_v', 'voltage_l3_v'] as $field) {
                    $d['metrics'][$field] = ['n' => 2, 'nulls' => 0, 'sum' => '460',
                        'min' => '230', 'max' => '230', 'first' => '230', 'last' => '230', 'mixed' => false];
                }
                foreach (['current_l1_a', 'current_l2_a', 'current_l3_a'] as $field) {
                    $ownNull = $field === 'current_l1_a' && $i === 4;
                    $d['metrics'][$field] = ['n' => $ownNull ? 1 : 2, 'nulls' => $ownNull ? 1 : 0, 'sum' => '0',
                        'min' => '0', 'max' => '0', 'first' => '0', 'last' => $ownNull ? null : '0', 'mixed' => false];
                }
            }));
        }
        $v = $snapshot();
        archiveAssert($v['status'] === 'ok');
        $bin = $v['buckets'][0]; $m = $bin['metrics'];
        archiveAssert($bin['complete'] && !$bin['has_gap'] && $bin['coverage_seconds'] === 300.0 && $bin['samples'] === 10);
        archiveAssert($m['charging']['count'] === 0 && $m['charging']['nulls'] === 10 && $m['charging']['last'] === null);
        archiveAssert($m['active_power_w']['mean'] === 0.0 && $m['current_limit_a']['last'] === 6.0);
        archiveAssert($m['current_l1_a']['nulls'] === 1 && $m['current_l1_a']['last'] === null && $m['current_l1_a']['mean'] === 0.0);
        foreach (['current_l2_a', 'current_l3_a'] as $field) {
            archiveAssert($m[$field]['nulls'] === 0 && $m[$field]['mean'] === 0.0);
        }
        foreach (['voltage_l1_v', 'voltage_l2_v', 'voltage_l3_v'] as $field) {
            archiveAssert($m[$field]['nulls'] === 0 && $m[$field]['mean'] === 230.0);
        }
    });
    $run('range-local invalidation waits for initial cursors and never releases pending work', static function () use ($reset, $insert, $root, $config, $start): void {
        $reset();
        for ($i = 0; $i < 60; ++$i) { $insert(archiveFixture($start + $i * 60)); }
        $hour = HistoryRange::parse('period=hour&date=2026-01-01T00:00&tz=UTC');
        $read = static fn() => (new HistoryArchive($config))->snapshot($hour);
        $root->exec("UPDATE evse_history_state SET events_done=0,invalidate_from='2026-01-01 01:00:00' WHERE source='isolated/archive'");
        // A differently cased source must not affect state or pending queries.
        $root->exec("INSERT INTO evse_history_state SELECT 'isolated/Archive',algorithm_version,sample_cursor,sample_highwater,samples_done,1,updated_at,initialized,event_cursor_at,event_cursor_id,event_highwater_at,event_highwater_id,invalidate_from,invalidate_cursor FROM evse_history_state WHERE source='isolated/archive'");
        $root->exec("INSERT INTO evse_history_work VALUES ('isolated/Archive',60,'2026-01-01 00:05:00',2,1,1)");
        $v = $read();
        archiveAssert($v['status'] === 'ok' && $v['complete'] && !$v['progress']['events_done']);
        foreach ($v['buckets'] as $bin) { archiveAssert($bin['complete'] && !$bin['has_gap'] && $bin['samples'] === 2); }
        $root->exec("UPDATE evse_history_state SET invalidate_from='2026-01-01 00:20:00',invalidate_cursor='2026-01-01 00:50:00' WHERE source='isolated/archive'");
        $v = $read();
        archiveAssert($v['status'] === 'ok' && !$v['complete']);
        foreach ($v['buckets'] as $i => $bin) {
            archiveAssert($bin['complete'] === ($i < 20) && $bin['has_gap'] === ($i >= 20));
            archiveAssert($bin['samples'] === ($i < 20 ? 2 : 0));
            if ($i >= 20) { archiveAssert($bin['metrics']['active_power_w']['last'] === null); }
        }
        foreach (["initialized=0", "samples_done=0,sample_cursor=0",
            "event_cursor_at='1000-01-01',event_highwater_at='1000-01-02'",
            "event_highwater_id=UNHEX(CONCAT(REPEAT('00',15),'01'))",
            "invalidate_from=NULL,invalidate_cursor=NULL"] as $unfinished) {
            // Recreate the completed initial state before each negative case.
            $root->exec("UPDATE evse_history_state SET initialized=1,samples_done=1,sample_cursor=5,event_cursor_at='1000-01-01',event_highwater_at='1000-01-01',event_highwater_id=UNHEX(REPEAT('00',16)),invalidate_from='2026-01-01 01:00:00',invalidate_cursor=NULL WHERE source='isolated/archive'");
            $root->exec("UPDATE evse_history_state SET $unfinished WHERE source='isolated/archive'");
            $v = $read(); archiveAssert($v['status'] === 'ok' && !$v['complete']);
            foreach ($v['buckets'] as $bin) { archiveAssert(!$bin['complete'] && $bin['has_gap']); }
        }
        $root->exec("UPDATE evse_history_state SET initialized=1,samples_done=1,sample_cursor=5,event_highwater_id=UNHEX(REPEAT('00',16)),events_done=1,invalidate_from=NULL,invalidate_cursor=NULL WHERE source='isolated/archive'");
        $root->exec("INSERT INTO evse_history_work VALUES ('isolated/archive',60,'2026-01-01 00:10:00',2,1,1)");
        $v = $read(); archiveAssert($v['status'] === 'ok' && !$v['complete']);
        archiveAssert(!$v['buckets'][10]['complete'] && $v['buckets'][10]['metrics']['active_power_w']['mean'] === null);
        archiveAssert($v['buckets'][9]['complete'] && $v['buckets'][40]['complete']);
        $root->exec("UPDATE evse_history_work SET pending=0,done_generation=generation WHERE source='isolated/archive'");
        archiveAssert($read()['complete']);
        $root->exec("UPDATE evse_history_state SET invalidate_from='2026-01-01 00:20:00' WHERE source='isolated/archive'");
        archiveAssert($read()['status'] === 'unavailable');
    });
    $run('localized readiness retains hour and child-minute pending barriers', static function () use ($reset, $insert, $root, $config, $start): void {
        $reset();
        $year = HistoryRange::parse('period=year&date=2026&tz=UTC');
        [$first, $next] = $year->bins()[0];
        for ($t = $first; $t < $next; $t += 3600) { $insert(archiveFixture($t, 3600)); }
        $read = static fn() => (new HistoryArchive($config))->snapshot($year);
        $boundary = gmdate('Y-m-d H:i:s', $next);
        $root->exec("UPDATE evse_history_state SET events_done=0,invalidate_from='$boundary' WHERE source='isolated/archive'");
        $v = $read(); archiveAssert($v['status'] === 'ok' && $v['buckets'][0]['complete'] && !$v['buckets'][0]['has_gap']);
        foreach ([60, 3600] as $resolution) {
            $root->exec("INSERT INTO evse_history_work VALUES ('isolated/archive',$resolution,'2026-01-01',2,1,1)");
            $v = $read(); archiveAssert($v['status'] === 'ok' && !$v['buckets'][0]['complete']);
            archiveAssert($v['buckets'][0]['metrics']['active_power_w']['mean'] === null);
            $root->exec("UPDATE evse_history_work SET pending=0,done_generation=generation WHERE source='isolated/archive'");
            archiveAssert($read()['buckets'][0]['complete']);
        }
    });
    $run('future period is rejected before any archive access', static function (): void {
        archiveReject(static fn() => HistoryRange::parse('period=year&date=9998&tz=UTC'));
    });
    $run('current period never reads future materializations', static function () use ($reset, $insert, $config): void {
        $reset();
        $r = HistoryRange::parse('period=year&date=now&tz=UTC');
        $future = intdiv(time(), 3600) * 3600 + 3600;
        $insert(archiveFixture($future, 3600));
        $v = (new HistoryArchive($config))->snapshot($r);
        archiveAssert($v['status'] === 'ok' && array_sum(array_column($v['buckets'], 'samples')) === 0);
        archiveAssert($v['navigation']['next'] === null);
    });
    $run('corrupt JSON shape, invalid progress and future update fail closed', static function () use ($reset, $insert, $start, $root, $snapshot): void {
        $reset(); $row = archiveFixture($start); $row['data_json'] = '{}'; $insert($row);
        archiveAssert($snapshot()['status'] === 'unavailable');
        $reset(); $insert(archiveFixture($start));
        $root->exec("UPDATE evse_history_state SET sample_cursor=6 WHERE source='isolated/archive'");
        archiveAssert($snapshot()['status'] === 'unavailable');
        $reset(); $insert(archiveFixture($start));
        $root->exec('UPDATE evse_history_buckets SET updated_at=UTC_TIMESTAMP(6)+INTERVAL 1 DAY');
        archiveAssert($snapshot()['status'] === 'unavailable');
    });
    $run('schema 1 raw output remains available with {1,2}', static function () use ($reset, $config): void {
        $reset(); $v = (new HistoryStore($config))->snapshot(15);
        archiveAssert($v['status'] === 'ok' && $v['schema_version'] === 1 && array_key_exists('samples', $v));
    });
    $run('archive reader never writes, including approved temporary writer account', static function () use ($root, $config, $writerConfig, $range): void {
        $counts = static fn() => $root->query('SELECT (SELECT COUNT(*) FROM evse_history_buckets),(SELECT COUNT(*) FROM evse_history_work),(SELECT COUNT(*) FROM evse_history_state)')->fetchAll(PDO::FETCH_NUM);
        $before = $counts();
        foreach ([$config, $writerConfig] as $c) { archiveAssert((new HistoryArchive($c))->snapshot($range)['status'] === 'ok'); }
        archiveAssert($before === $counts());
    });
    $run('complete leap-year hourly materialization fits bounded local-day API', static function () use ($root, $reset, $config): void {
        $reset();
        $year = HistoryRange::parse('period=year&date=2024&tz=Europe%2FVienna');
        $statement = $root->prepare('INSERT INTO evse_history_buckets (source,resolution_seconds,bucket_start,data_json,updated_at) VALUES (?,?,?,?,UTC_TIMESTAMP(6))');
        $root->beginTransaction();
        $hours = 0;
        for ($t = $year->from->getTimestamp(); $t < $year->to->getTimestamp(); $t += 3600) {
            $row = archiveFixture($t, 3600, 1800);
            $statement->execute(['isolated/archive', 3600, $row['bucket_start'], $row['data_json']]);
            ++$hours;
        }
        $root->commit();
        $before = hrtime(true);
        $v = (new HistoryArchive($config))->snapshot($year);
        print('Year fixture: ' . json_encode(['status' => $v['status'], 'complete' => $v['complete'],
            'buckets' => count($v['buckets']), 'samples' => array_sum(array_column($v['buckets'], 'samples')),
            'elapsed_ms' => (int) ((hrtime(true) - $before) / 1000000)], JSON_THROW_ON_ERROR) . "\n");
        archiveAssert($v['status'] === 'ok' && $v['complete'] && count($v['buckets']) === 53);
        archiveAssert($hours === 8784 && array_sum(array_column($v['buckets'], 'samples')) === 15811200);
        archiveAssert(strlen(json_encode($v, JSON_THROW_ON_ERROR)) <= 2097152);
        foreach ($v['buckets'] as $b) {
            archiveAssert($b['samples'] === (int) ((strtotime($b['to']) - strtotime($b['from'])) / 3600) * 1800);
            archiveAssert($b['metrics']['active_power_w']['mean'] === 1000.0);
            archiveAssert($b['metrics']['session_energy_wh']['mean'] === null);
        }
        // Keep these fixture rows for the real HTTP year request below too.
    });
    $run('database clock mismatch, credential denial and budget expiration are unavailable', static function () use ($config, $range): void {
        $wrongClock = new HistoryArchive($config, null, static fn() => new DateTimeImmutable('2000-01-01T00:00:00Z'));
        archiveAssert($wrongClock->snapshot($range)['status'] === 'unavailable');
        $wrong = new HistoryConfig(true, 'history-db', 3306, 'evse_history_test', 'history_reader', 'isolated/archive', 'dummy-only-wrong');
        archiveAssert((new HistoryArchive($wrong))->snapshot($range)['status'] === 'unavailable');
        $i = 0;
        $mono = static function () use (&$i): int { return $i++ === 0 ? 0 : 3000000000; };
        $expired = new HistoryArchive($config, static fn() => throw new RuntimeException('Must not connect'), null, $mono);
        archiveAssert($expired->snapshot($range)['status'] === 'unavailable');
    });
    $run('real HTTP schema routing, validation, HEAD, methods, no-store and CSP', static function () use (&$server, &$secret): void {
        $secret = tempnam('/tmp', 'archive-reader-');
        archiveAssert($secret !== false);
        file_put_contents($secret, "dummy-only-reader\n"); chmod($secret, 0600);
        foreach (['WEB_HISTORY_ENABLED' => '1', 'HISTORY_DB_HOST' => 'history-db', 'HISTORY_DB_NAME' => 'evse_history_test',
            'HISTORY_DB_USERNAME' => 'history_reader', 'HISTORY_DB_PASSWORD_FILE' => $secret, 'MQTT_TOPIC_PREFIX' => 'isolated/archive'] as $k => $v) { putenv("$k=$v"); }
        $socket = stream_socket_server('tcp://127.0.0.1:0'); archiveAssert($socket !== false);
        $address = stream_socket_get_name($socket, false); fclose($socket);
        $server = proc_open(['php', '-S', $address, '/app/public/index.php'], [['file', '/dev/null', 'r'], ['file', '/dev/null', 'w'], ['file', '/dev/null', 'w']], $pipes, '/app');
        archiveAssert(is_resource($server));
        $request = static function (string $query, string $method = 'GET') use ($address): array {
            $context = stream_context_create(['http' => ['method' => $method, 'ignore_errors' => true, 'timeout' => 5]]);
            $body = @file_get_contents('http://' . $address . '/api/history?' . $query, false, $context);
            return [$http_response_header ?? [], $body];
        };
        $ready = false;
        for ($i = 0; $i < 40; ++$i) {
            [$headers] = $request('minutes=1');
            if ($headers) { $ready = true; break; }
            usleep(50000);
        }
        archiveAssert($ready);
        [$headers, $body] = $request('period=day&date=2026-01-01&tz=UTC');
        archiveAssert(str_contains($headers[0], '200') && json_decode($body, true)['schema_version'] === 2);
        archiveAssert(strlen($body) <= 2097152 && str_contains(strtolower(implode("\n", $headers)), 'cache-control: no-store'));
        archiveAssert(str_contains(strtolower(implode("\n", $headers)), 'content-security-policy:'));
        archiveAssert(!str_contains($body, 'dummy-only') && !str_contains($body, 'history-db'));
        foreach (['period=day&date=2026-03-29', 'period=year&date=2024', 'period=hour&at=2026-10-25T01%3A30%3A00Z',
            'period=week&date=2020-W53', 'period=custom&date_from=2026-01-01T00%3A00&date_to=2026-01-02T00%3A00'] as $q) {
            [$headers] = $request($q); archiveAssert(str_contains($headers[0], '200'));
        }
        foreach (['period=day&date=now&date=now', 'period=day&date=now&x=1', 'period=day&date[]=now',
            'period=hour&date=2026-03-29T02:00', 'period=year&date=2026&minutes=15',
            'period=year&date=9998', 'period=hour&at=9998-01-01T00:00:00Z',
            'period=custom&from=9997-01-01T00:00:00Z&to=9998-01-01T00:00:00Z'] as $q) {
            [$headers] = $request($q); archiveAssert(str_contains($headers[0], '400'));
        }
        [$headers, $body] = $request('period=day&date=2026-01-01', 'HEAD'); archiveAssert(str_contains($headers[0], '200') && $body === '');
        [$headers] = $request('period=day&date=2026-01-01', 'POST'); archiveAssert(str_contains($headers[0], '405'));
        [$headers, $body] = $request('minutes=15'); archiveAssert(str_contains($headers[0], '200') && json_decode($body, true)['schema_version'] === 1);
    });
    print("Archive integration: $completed scenarios passed (isolated Docker only).\n");
} catch (Throwable) {
    // Never print SQL, DSNs, fixture credentials or exception messages.
    fwrite(STDERR, "Archive integration failed: $case (diagnostics withheld).\n");
    $failed = true;
} finally {
    if (is_resource($server)) { proc_terminate($server); proc_close($server); }
    if (is_string($secret)) { unlink($secret); }
}
if ($failed) { exit(1); }
