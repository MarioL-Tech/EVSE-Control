<?php
declare(strict_types=1);

// Docker-only third phase, after history-integration.cjs and archive-integration.php.
// Never read deployment credentials or use an environment-selected DSN.
require '/app/vendor/autoload.php';
require __DIR__ . '/archive-fixtures.php';

use EvseOverlay\HistoryConfig;
use EvseOverlay\HistoryStore;
use EvseOverlay\HouseHistoryConfig;
use EvseOverlay\HouseHistoryStore;
use EvseOverlay\MinuteHistory;

$case = 'guard'; $completed = 0; $server = null; $secret = null; $failed = false;
$run = static function (string $label, callable $operation) use (&$case, &$completed): void {
    $case = $label; $operation(); ++$completed; print("ok $completed - $label\n");
};
$sqlDate = static fn(int $t): string => gmdate('Y-m-d H:i:s', $t) . '.000000';
$iso = static fn(int $t): string => gmdate('Y-m-d\TH:i:s', $t) . '.000000Z';
try {
    archiveAssert(getenv('HISTORY_TEST_DB_HOST') === 'history-db');
    archiveAssert(getenv('HISTORY_TEST_ROOT_PASSWORD') === 'dummy-only-history-root');
    $dsn = 'mysql:host=history-db;port=3306;dbname=evse_history_test;charset=utf8mb4';
    $options = [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_EMULATE_PREPARES => false,
        PDO::ATTR_STRINGIFY_FETCHES => true, PDO::ATTR_TIMEOUT => 2];
    $root = new PDO($dsn, 'root', 'dummy-only-history-root', $options);
    $root->exec("SET time_zone='+00:00'");
    $source = 'isolated/minute-e2e'; $other = 'isolated/Minute-e2e';
    $globalRegistry = $root->query('SELECT version,applied_at FROM evse_schema_versions ORDER BY version')->fetchAll(PDO::FETCH_ASSOC);
    // Legacy tables are never cleared or modified by this phase.
    $legacyCounts = static fn(): array => $root->query('SELECT (SELECT COUNT(*) FROM evse_wallbox_samples),
        (SELECT COUNT(*) FROM evse_history_buckets),(SELECT COUNT(*) FROM evse_history_work),
        (SELECT COUNT(*) FROM evse_history_state)')->fetchAll(PDO::FETCH_NUM);
    $legacyBefore = $legacyCounts();
    $run('additive fixtures and table-specific reader grants', static function () use ($root): void {
        $fixtures = [
            ['/fixtures/003_house.sql', HouseHistoryStore::SCHEMA_SHA256, 'evse_house_schema_versions',
                ['evse_house_schema_versions','evse_house_samples','evse_house_events','evse_house_buckets','evse_house_work']],
            ['/fixtures/004_minutes.sql', MinuteHistory::SCHEMA_SHA256, 'evse_minute_schema_versions',
                ['evse_minute_schema_versions','evse_minute_sources','evse_minute_records']],
        ];
        foreach ($fixtures as [$file, $expected, $registry, $tables]) {
            $text = file_get_contents($file);
            archiveAssert(is_string($text) && strlen($text) < 65536 && hash_equals($expected, hash('sha256', $text)));
            foreach (explode(';', $text) as $statement) {
                if (trim($statement) !== '') { $root->exec($statement); }
            }
            // Identifiers come exclusively from the static fixture allowlist above.
            $root->prepare("INSERT INTO $registry (version,checksum,applied_at) VALUES (1,?,UTC_TIMESTAMP(6))")
                ->execute([hash('sha256', $text, true)]);
            foreach ($tables as $table) { $root->exec("GRANT SELECT ON evse_history_test.$table TO 'history_reader'@'%'"); }
        }
    });
    $now = MinuteHistory::date($root->query('SELECT UTC_TIMESTAMP(6)')->fetchColumn());
    $start = intdiv($now->getTimestamp(), 60) * 60 - 180;
    $wall = static function (int $t, int $power): string {
        $row = archiveMutate(archiveFixture($t, 60, 2, $power), static function (&$d) use ($power): void {
            // A mixed flag and changing limit use LAST, never an arithmetic mean.
            foreach (['charging', 'current_limit_a'] as $field) {
                $a = $field === 'charging' ? '0' : '6'; $b = $field === 'charging' ? '1' : '16';
                $d['metrics'][$field] = ['n' => 2, 'nulls' => 0, 'sum' => null,
                    'min' => $a, 'max' => $b, 'first' => $a, 'last' => $b, 'mixed' => true];
            }
            $d['metrics']['active_power_w']['min'] = (string) ($power - 100);
            $d['metrics']['active_power_w']['max'] = (string) ($power + 100);
            $d['metrics']['active_power_w']['first'] = (string) ($power - 100);
            $d['metrics']['active_power_w']['last'] = (string) ($power + 100);
            $d['metrics']['active_power_w']['mixed'] = true;
        });
        return $row['data_json'];
    };
    $house = static function (int $t, int $power, bool $null = false) use ($iso): string {
        return json_encode(['bucket_start' => $iso($t), 'bucket_end' => $iso($t + 60),
            'samples' => 2, 'valid_count' => $null ? 1 : 2, 'null_count' => $null ? 1 : 0,
            'sum_w' => (string) ($power * ($null ? 1 : 2)), 'min_w' => (string) $power, 'max_w' => (string) $power,
            'first_w' => (string) $power, 'last_w' => $null ? null : (string) $power,
            'first_at' => $iso($t), 'last_at' => $iso($t + 58), 'coverage_ms' => 60000,
            'has_gap' => false, 'complete' => true], JSON_THROW_ON_ERROR);
    };
    $insert = static function (string $kind, string $prefix, int $t, string $text) use ($root, $sqlDate): void {
        archiveAssert(strlen($text) < 32768);
        $root->prepare('INSERT INTO evse_minute_records (kind,source,bucket_start,data_json,digest) VALUES (?,?,?,?,?)')
            ->execute([$kind, $prefix, $sqlDate($t), $text, hash('sha256', $text, true)]);
    };
    foreach (['wallbox','house'] as $kind) {
        foreach ([$source, $other] as $prefix) {
            $root->prepare('INSERT INTO evse_minute_sources (kind,source,started_at) VALUES (?,?,?)')
                ->execute([$kind, $prefix, $sqlDate($start)]);
        }
    }
    $insert('wallbox', $source, $start, $wall($start, 200));
    $insert('wallbox', $source, $start + 60, $wall($start + 60, 400));
    $insert('wallbox', $other, $start, $wall($start, 9000));
    $insert('house', $source, $start, $house($start, -200));
    $insert('house', $source, $start + 60, $house($start + 60, 0, true));
    $insert('house', $other, $start, $house($start, 9000));
    $config = new HistoryConfig(true, 'history-db', 3306, 'evse_history_test', 'history_reader', $source, 'dummy-only-reader');
    $houseConfig = new HouseHistoryConfig(true, 'history-db', 3306, 'evse_history_test', 'history_reader', $source, 'dummy-only-reader');
    $read = static fn(): array => (new HistoryStore($config))->snapshot(15);
    $readHouse = static fn(): array => (new HouseHistoryStore($houseConfig))->snapshot(15);
    $safe = static function (array $v): void {
        $body = json_encode($v, JSON_THROW_ON_ERROR);
        archiveAssert(strlen($body) <= 1048576 && $v['read_only'] === true);
        foreach (['dummy-only', 'history-db', 'history_reader', 'mysql:', 'SELECT ', 'data_json', 'digest', 'isolated/'] as $marker) {
            archiveAssert(!str_contains($body, $marker));
        }
    };
    $run('reader reload returns schema 3 interval means and last states', static function () use ($read, $safe, $start, $iso): void {
        for ($reload = 0; $reload < 2; ++$reload) {
            $v = $read(); $safe($v);
            archiveAssert($v['status'] === 'ok' && $v['schema_version'] === 3 && count($v['samples']) === 2);
            foreach ($v['samples'] as $i => $s) {
                archiveAssert($s['values']['active_power_w'] === ($i ? 400.0 : 200.0));
                archiveAssert($s['values']['charging'] === true && $s['values']['current_limit_a'] === 16.0);
                archiveAssert($s['values']['session_energy_wh'] === 2000.0);
                archiveAssert($s['interval']['from'] === $iso($start + $i * 60) && $s['interval']['to'] === $iso($start + ($i + 1) * 60));
                archiveAssert($s['interval']['complete'] && !$s['interval']['has_gap']);
                archiveAssert(in_array('charging', $s['interval']['break_fields'], true));
                archiveAssert($s['break_before'] === ($i === 0));
            }
        }
    });
    $run('house negative and true zero retain local NULL evidence', static function () use ($readHouse, $safe): void {
        $v = $readHouse(); $safe($v);
        archiveAssert($v['status'] === 'ok' && $v['schema_version'] === 3 && count($v['samples']) === 2);
        archiveAssert($v['samples'][0]['power_w'] === -200.0 && $v['samples'][1]['power_w'] === 0.0);
        archiveAssert($v['samples'][0]['interval']['break_fields'] === []);
        archiveAssert($v['samples'][1]['interval']['break_fields'] === ['power_w']);
        archiveAssert(!$v['samples'][1]['interval']['has_gap']);
    });
    $run('binary source filters isolate case variants for both kinds', static function () use ($other): void {
        $w = (new HistoryStore(new HistoryConfig(true, 'history-db', 3306, 'evse_history_test', 'history_reader', $other, 'dummy-only-reader')))->snapshot(15);
        $h = (new HouseHistoryStore(new HouseHistoryConfig(true, 'history-db', 3306, 'evse_history_test', 'history_reader', $other, 'dummy-only-reader')))->snapshot(15);
        archiveAssert($w['status'] === 'ok' && count($w['samples']) === 1 && $w['samples'][0]['values']['active_power_w'] === 9000.0);
        archiveAssert($h['status'] === 'ok' && count($h['samples']) === 1 && $h['samples'][0]['power_w'] === 9000.0);
    });
    $run('missing minute is absent not synthetic zero and breaks the next edge', static function () use ($root, $source, $start, $sqlDate, $read): void {
        $move = $root->prepare("UPDATE evse_minute_records SET bucket_start=? WHERE kind='wallbox' AND source=CAST(? AS BINARY) AND bucket_start=?");
        // Move only our disposable record, leaving legacy data untouched.
        // Rebuild timestamps and digest too: a mismatched product must fail validation.
        $s = $root->prepare("SELECT data_json FROM evse_minute_records WHERE kind='wallbox' AND source=CAST(? AS BINARY) AND bucket_start=?");
        $s->execute([$source, $sqlDate($start + 60)]); $original = $s->fetchColumn();
        $d = json_decode($original, true, 16, JSON_THROW_ON_ERROR);
        foreach (['first_at','last_at'] as $key) { $d[$key] = (new DateTimeImmutable($d[$key]))->modify('+1 minute')->format('Y-m-d\TH:i:s.u\Z'); }
        $text = json_encode($d, JSON_THROW_ON_ERROR);
        $move->execute([$sqlDate($start + 120), $source, $sqlDate($start + 60)]);
        $update = $root->prepare("UPDATE evse_minute_records SET data_json=?,digest=? WHERE kind='wallbox' AND source=CAST(? AS BINARY) AND bucket_start=?");
        $update->execute([$text, hash('sha256', $text, true), $source, $sqlDate($start + 120)]);
        $v = $read(); archiveAssert($v['status'] === 'ok' && !$v['complete'] && count($v['samples']) === 2);
        archiveAssert($v['samples'][1]['break_before'] && $v['samples'][1]['values']['active_power_w'] === 400.0);
        $move->execute([$sqlDate($start + 60), $source, $sqlDate($start + 120)]);
        $update->execute([$original, hash('sha256', $original, true), $source, $sqlDate($start + 60)]);
    });
    $run('corrupt digest fails closed without leaking SQL or credentials', static function () use ($root, $source, $start, $sqlDate, $read, $safe): void {
        $root->prepare("UPDATE evse_minute_records SET digest=? WHERE kind='wallbox' AND source=CAST(? AS BINARY) AND bucket_start=?")
            ->execute([str_repeat("\0", 32), $source, $sqlDate($start)]);
        $v = $read(); $safe($v); archiveAssert($v['status'] === 'unavailable' && $v['samples'] === []);
        $root->prepare("UPDATE evse_minute_records SET digest=UNHEX(SHA2(data_json,256)) WHERE kind='wallbox' AND source=CAST(? AS BINARY) AND bucket_start=?")
            ->execute([$source, $sqlDate($start)]);
        archiveAssert($read()['status'] === 'ok');
    });
    $run('late pre-window offline baseline invalidates until definite newer online', static function () use ($root, $source, $start, $sqlDate, $read): void {
        $event = $root->prepare('INSERT INTO evse_ingest_events (source,event_id,kind,received_at,retained,availability,details_json) VALUES (?, ?, ?, ?, 0, ?, ?)');
        $event->execute([$source, random_bytes(16), 'availability', $sqlDate($start - 120), 'offline', '{}']);
        $v = $read(); archiveAssert($v['status'] === 'ok');
        foreach ($v['samples'] as $s) { archiveAssert($s['interval']['has_gap']); }
        $event->execute([$source, random_bytes(16), 'availability', $sqlDate($start - 60), 'online', '{}']);
        $v = $read(); archiveAssert($v['status'] === 'ok');
        foreach ($v['samples'] as $s) { archiveAssert(!$s['interval']['has_gap']); }
        // Online cannot erase an independent lifecycle barrier inside a minute.
        $event->execute([$source, random_bytes(16), 'collector_stopping', $sqlDate($start + 30), null, '{}']);
        $v = $read(); archiveAssert($v['status'] === 'ok' && $v['samples'][0]['interval']['has_gap']);
    });
    $run('cutover merge keeps earlier raw only and isolates the minute seam', static function () use ($read, $start, $iso): void {
        $capture = $read();
        $legacy = ['complete' => true, 'samples' => [
            ['timestamp' => $iso($start - 2), 'break_before' => false],
            ['timestamp' => $iso($start), 'break_before' => false],
        ]];
        $merged = MinuteHistory::merge($legacy, ['cutover' => new DateTimeImmutable($iso($start)),
            'samples' => $capture['samples'], 'complete' => false]);
        archiveAssert($merged['schema_version'] === 3 && count($merged['samples']) === 3);
        archiveAssert($merged['samples'][0]['interval'] === null && $merged['samples'][0]['break_before']);
        archiveAssert($merged['samples'][1]['break_before'] && $merged['samples'][1]['interval'] !== null);
    });
    $run('reader rejects every DML verb and snapshots leave data unchanged', static function () use ($root, $dsn, $options, $read, $readHouse, $globalRegistry, $legacyCounts, $legacyBefore): void {
        $reader = new PDO($dsn, 'history_reader', 'dummy-only-reader', $options);
        foreach (["INSERT INTO evse_minute_sources VALUES ('house','forbidden','2000-01-01')",
            "UPDATE evse_minute_records SET data_json='{}' WHERE source=0x00",
            'DELETE FROM evse_house_events WHERE source=0x00'] as $sql) {
            $denied = false;
            try { $reader->exec($sql); } catch (PDOException $e) { $denied = (int) ($e->errorInfo[1] ?? 0) === 1142; }
            archiveAssert($denied);
        }
        $count = static fn(): array => $root->query('SELECT (SELECT COUNT(*) FROM evse_minute_records),
            (SELECT COUNT(*) FROM evse_minute_sources),(SELECT COUNT(*) FROM evse_ingest_events),
            (SELECT COUNT(*) FROM evse_house_events)')->fetchAll(PDO::FETCH_NUM);
        $before = $count(); archiveAssert($read()['status'] === 'ok' && $readHouse()['status'] === 'ok');
        archiveAssert($before === $count() && $legacyBefore === $legacyCounts());
        archiveAssert($globalRegistry === $root->query('SELECT version,applied_at FROM evse_schema_versions ORDER BY version')->fetchAll(PDO::FETCH_ASSOC));
    });
    $run('real HTTP reload read-only schema 3 no-store HEAD and method guard', static function () use (&$server, &$secret, $source, $safe): void {
        $secret = tempnam('/tmp', 'minute-reader-'); archiveAssert(is_string($secret));
        chmod($secret, 0600); file_put_contents($secret, "dummy-only-reader\n");
        foreach (['WEB_HISTORY_ENABLED' => '1', 'WEB_HOUSE_HISTORY_ENABLED' => '1', 'HISTORY_DB_HOST' => 'history-db',
            'HISTORY_DB_PORT' => '3306', 'HISTORY_DB_NAME' => 'evse_history_test', 'HISTORY_DB_USERNAME' => 'history_reader',
            'HISTORY_DB_PASSWORD_FILE' => $secret, 'MQTT_TOPIC_PREFIX' => $source, 'HOUSE_HISTORY_SOURCE' => $source] as $key => $value) {
            putenv("$key=$value");
        }
        $socket = stream_socket_server('tcp://127.0.0.1:0'); archiveAssert(is_resource($socket));
        $address = stream_socket_get_name($socket, false); fclose($socket);
        $server = proc_open(['php', '-S', $address, '/app/public/index.php'],
            [['file','/dev/null','r'],['file','/dev/null','w'],['file','/dev/null','w']], $pipes, '/app');
        archiveAssert(is_resource($server));
        $request = static function (string $path, string $method = 'GET') use ($address): array {
            $ctx = stream_context_create(['http' => ['method' => $method, 'timeout' => 5, 'ignore_errors' => true]]);
            $body = @file_get_contents('http://' . $address . $path, false, $ctx);
            return [$http_response_header ?? [], $body];
        };
        $ready = false;
        for ($i = 0; $i < 40; ++$i) {
            [$headers] = $request('/api/history?minutes=15');
            if ($headers) { $ready = true; break; } usleep(50000);
        }
        archiveAssert($ready);
        foreach (['/api/history?minutes=15','/api/house-history?minutes=15'] as $path) {
            for ($reload = 0; $reload < 2; ++$reload) {
                [$headers, $body] = $request($path);
                archiveAssert(str_contains($headers[0], '200') && is_string($body));
                $v = json_decode($body, true, 32, JSON_THROW_ON_ERROR); $safe($v);
                archiveAssert($v['schema_version'] === 3 && $v['status'] === 'ok' && count($v['samples']) === 2);
                archiveAssert(str_contains(strtolower(implode("\n", $headers)), 'cache-control: no-store'));
            }
            [$headers, $body] = $request($path, 'HEAD'); archiveAssert(str_contains($headers[0], '200') && $body === '');
            [$headers] = $request($path, 'POST'); archiveAssert(str_contains($headers[0], '405'));
        }
    });
    print("Minute integration: $completed scenarios passed (isolated Docker only).\n");
} catch (Throwable $e) {
    // Class and test source line only; never exception messages, SQL, DSNs or values.
    fwrite(STDERR, 'Minute integration failed: ' . $case . ' [' . get_class($e) . ':' . $e->getLine() . "].\n");
    $failed = true;
} finally {
    if (is_resource($server)) { proc_terminate($server); proc_close($server); }
    if (is_string($secret) && is_file($secret)) { unlink($secret); }
}
if ($failed) { exit(1); }
