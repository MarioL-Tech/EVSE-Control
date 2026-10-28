<?php
declare(strict_types=1);

require_once __DIR__ . '/../php/HistoryConfig.php';
require_once __DIR__ . '/../php/HistoryStore.php';
require_once __DIR__ . '/../php/HistoryRange.php';
require_once __DIR__ . '/../php/HistoryArchive.php';
require_once __DIR__ . '/../php/StrictJson.php';
require_once __DIR__ . '/archive-fixtures.php';

use EvseOverlay\HistoryRange;
use EvseOverlay\HistoryArchive;
use EvseOverlay\HistoryConfig;

$cases = 0;
$test = static function (callable $op) use (&$cases): void { $op(); ++$cases; };
$range = static fn(string $q): HistoryRange => HistoryRange::parse($q);
foreach (['', 'minutes=1', 'minutes=5', 'minutes=15'] as $query) {
    $test(static fn() => archiveAssert(is_int(HistoryRange::parse($query))));
}
foreach (['period=day&date=2026-02-30', 'period=hour&date=2026-03-29T02:00',
    'period=week&date=2021-W53', 'period=year&date=1969', 'period=year&date=9999',
    'period=day&date=2026-01-01&tz=America%2FNew_York', 'period=day&date=now&date=now',
    'period=day&date=now&%64ate=now', 'period=day&date[]=now', 'period=day&date=now&unknown=1',
    'period=day&date=now&tz=UTC%', 'period=day&date=now&tz=UTC%0A',
    'period=day&date=now&minutes=15', 'minutes=15&period=day&date=now',
    'period=day&date=now&at=2026-01-01T00:00:00Z', 'period=day',
    'period=custom&from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:01Z&tz=UTC',
    'period=custom&from=2026-01-01T00:00:00Z&to=2026-01-01T00:00:00Z',
    'period=custom&date_from=2026-03-29T02:30&date_to=2026-03-29T04:00',
    'period=custom&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z&date_from=2026-01-01T00:00',
    'period=hour&at=2026-01-01T24:00:00Z', 'period=year&date=2026&x=' . str_repeat('x', 512)] as $invalid) {
    $test(static fn() => archiveReject(static fn() => HistoryRange::parse($invalid)));
}
$test(static function () use ($range): void {
    foreach (['2026-03-29' => 23, '2026-10-25' => 25] as $date => $hours) {
        $r = $range('period=day&date=' . $date);
        archiveAssert($r->to->getTimestamp() - $r->from->getTimestamp() === $hours * 3600);
        archiveAssert(count($r->bins()) === $hours * 12);
    }
    $leap = $range('period=year&date=2024');
    archiveAssert(count($leap->bins()) === 366);
    archiveAssert($leap->to->getTimestamp() - $leap->from->getTimestamp() === 8784 * 3600);
    archiveAssert(count($range('period=month&date=2024-02')->bins()) === 348);
    archiveAssert($range('period=week&date=2020-W53')->from->format('Y-m-d') === '2020-12-28');
});
$test(static function () use ($range): void {
    $a = $range('period=hour&at=2026-10-25T00:30:00Z');
    $b = $range('period=hour&at=2026-10-25T01:30:00Z');
    archiveAssert($a->label === $b->label && $b->from->getTimestamp() - $a->from->getTimestamp() === 3600);
    $nav = $a->envelope('ok', new DateTimeImmutable('2026-10-25T00:30:00Z'))['navigation'];
    archiveAssert($nav['next']['at'] === HistoryRange::iso($b->from));
    archiveAssert($range(http_build_query($nav['next']))->from == $b->from);
    $now = HistoryRange::parse('period=month&date=now', new DateTimeImmutable('2026-12-31T23:30:00Z'));
    archiveAssert($now->label === '2027-01');
});
$hour = $range('period=hour&date=2026-01-01T12:00&tz=UTC');
$start = $hour->from->getTimestamp();
$test(static function () use ($hour): void {
    $store = new HistoryArchive(new HistoryConfig(), static fn() => throw new RuntimeException('Must not connect'));
    $result = $store->snapshot($hour);
    archiveAssert($result['status'] === 'disabled' && $result['schema_version'] === 2 && $result['buckets'] === [] && $result['read_only']);
    archiveAssert(HistoryArchive::failure($hour)['status'] === 'unavailable');
    foreach ([[['version' => '1']], [['version' => '2']], [['version' => '1'], ['version' => '2'], ['version' => '3']]] as $v) {
        archiveReject(static fn() => HistoryArchive::versions($v, true));
    }
    HistoryArchive::versions([['version' => '2'], ['version' => '1']], true);
});
$test(static function () use ($hour, $start): void {
    $p = HistoryArchive::project($hour, [archiveFixture($start)]);
    archiveAssert(!$p['complete'] && count($p['buckets']) === 60);
    $b = $p['buckets'][0];
    archiveAssert($b['complete'] && $b['samples'] === 2 && $b['metrics']['active_power_w']['mean'] === 1000.0);
    archiveAssert($b['metrics']['charging']['last'] === false && $b['metrics']['plugged_in']['last'] === true);
    archiveAssert($b['metrics']['session_energy_wh']['mean'] === null && $b['metrics']['current_limit_a']['mean'] === null);
    archiveAssert($p['buckets'][1]['has_gap'] && $p['buckets'][1]['metrics']['active_power_w']['last'] === null);
    $dirty = HistoryArchive::project($hour, [archiveFixture($start)], [[$start, $start + 60]]);
    archiveAssert(!$dirty['buckets'][0]['complete'] && $dirty['buckets'][0]['metrics']['active_power_w']['mean'] === null);
    archiveAssert(!HistoryArchive::project($hour, [archiveFixture($start)], [], false)['buckets'][0]['complete']);
});
$test(static function () use ($range, $start): void {
    $day = $range('period=day&date=2026-01-01&tz=UTC');
    $a = archiveFixture($start, 60, 2, 100);
    $b = archiveFixture($start + 60, 60, 6, 300);
    $b = archiveMutate($b, static function (&$d): void {
        $d['metrics']['current_limit_a']['min'] = $d['metrics']['current_limit_a']['max'] = $d['metrics']['current_limit_a']['first'] = $d['metrics']['current_limit_a']['last'] = '16';
        $d['metrics']['charging']['min'] = $d['metrics']['charging']['max'] = $d['metrics']['charging']['first'] = $d['metrics']['charging']['last'] = '1';
    });
    $p = HistoryArchive::project($day, [$a, $b]);
    $m = $p['buckets'][144]['metrics'];
    archiveAssert($m['active_power_w']['mean'] === 250.0 && $m['active_power_w']['count'] === 8);
    archiveAssert($m['current_limit_a']['last'] === 16.0 && $m['current_limit_a']['mean'] === null);
    archiveAssert($m['charging']['mixed'] && $m['charging']['last'] === true && $m['charging']['mean'] === null);
    archiveAssert($m['session_energy_wh']['last'] === 2000.0 && $m['session_energy_wh']['mean'] === null);
});
$test(static function () use ($hour, $start): void {
    $null = archiveMutate(archiveFixture($start), static function (&$d): void {
        $d['error_samples'] = 2; $d['valid_samples'] = 0; $d['has_gap'] = true; $d['coverage_seconds'] = '0';
        foreach ($d['metrics'] as &$s) {
            $s['n'] = 0; $s['nulls'] = 2; $s['sum'] = $s['sum'] === null ? null : '0';
            $s['min'] = $s['max'] = $s['first'] = $s['last'] = null;
        }
    });
    $p = HistoryArchive::project($hour, [$null]);
    archiveAssert($p['buckets'][0]['has_gap'] && $p['buckets'][0]['metrics']['charging']['last'] === null);
    archiveAssert($p['buckets'][0]['metrics']['active_power_w']['nulls'] === 2);
});
foreach (['schema_version' => 2, 'samples' => '2', 'coverage_seconds' => '60.0', 'has_gap' => 0,
    'first_at' => '2026-02-30T12:00:00.000000Z', 'last_at' => '2026-01-01T13:00:00.000000Z', 'metrics' => []] as $key => $bad) {
    $test(static function () use ($hour, $start, $key, $bad): void {
        $row = archiveMutate(archiveFixture($start), static function (&$d) use ($key, $bad): void { $d[$key] = $bad; });
        archiveReject(static fn() => HistoryArchive::project($hour, [$row]));
    });
}
foreach (['n' => -1, 'nulls' => 1, 'sum' => 'NaN', 'min' => '-1', 'max' => '4294967296', 'last' => [], 'mixed' => true] as $key => $bad) {
    $test(static function () use ($hour, $start, $key, $bad): void {
        $row = archiveMutate(archiveFixture($start), static function (&$d) use ($key, $bad): void { $d['metrics']['active_power_w'][$key] = $bad; });
        archiveReject(static fn() => HistoryArchive::project($hour, [$row]));
    });
}
$test(static function () use ($hour, $start): void {
    $a = archiveFixture($start);
    archiveReject(static fn() => HistoryArchive::project($hour, [$a, $a]));
    archiveReject(static fn() => HistoryArchive::project($hour, [archiveFixture($start + 60), $a]));
    archiveReject(static fn() => HistoryArchive::project($hour, [$a], [], true, null, $start - 100));
    $a['data_json'] = str_replace('"schema_version":1', '"schema_version":1,"schema_version":1', $a['data_json']);
    archiveReject(static fn() => HistoryArchive::project($hour, [$a]));
});
$test(static function () use ($range): void {
    // Every UTC hour in a leap year belongs to exactly one LOCAL date, including both DST transitions.
    $year = $range('period=year&date=2024');
    $rows = (static function () use ($year): Generator {
        for ($t = $year->from->getTimestamp(); $t < $year->to->getTimestamp(); $t += 3600) { yield archiveFixture($t, 3600); }
    })();
    $p = HistoryArchive::project($year, $rows);
    archiveAssert($p['complete'] && count($p['buckets']) === 366);
    archiveAssert(array_sum(array_column($p['buckets'], 'samples')) === 8784 * 2);
    foreach ($p['buckets'] as $b) {
        $hours = (strtotime($b['to']) - strtotime($b['from'])) / 3600;
        archiveAssert(in_array($hours, [23, 24, 25]) && $b['samples'] === (int) $hours * 2);
    }
    archiveAssert(strlen(json_encode($p, JSON_THROW_ON_ERROR)) < 2097152);
});
$test(static function () use ($range): void {
    $year = $range('period=year&date=2026&tz=UTC');
    $rows = (static function () use ($year): Generator {
        for ($i = 0; $i < 600; ++$i) {
            $row = archiveFixture($year->from->getTimestamp() + $i * 60);
            $row['data_json'] .= str_repeat(' ', 63000 - strlen($row['data_json']));
            yield $row;
        }
    })();
    archiveReject(static fn() => HistoryArchive::project($year, $rows));
    $rows = (static function () use ($year): Generator {
        for ($i = 0; $i <= 10000; ++$i) { yield archiveFixture($year->from->getTimestamp() + $i * 60); }
    })();
    archiveReject(static fn() => HistoryArchive::project($year, $rows));
});
$test(static function () use ($range): void {
    $r = $range('period=custom&from=2026-01-01T12:00:30Z&to=2026-01-01T12:03:00Z&tz=UTC');
    $p = HistoryArchive::project($r, [archiveFixture(strtotime('2026-01-01T12:01:00Z'))]);
    archiveAssert(!$p['complete'] && $p['buckets'][0]['has_gap'] && $p['buckets'][1]['samples'] === 2);
    archiveAssert($r->envelope('ok', new DateTimeImmutable())['navigation'] === null);
});

final class ArchiveStatement extends PDOStatement
{
    public array $parameters = [];
    public function __construct(private array $rows, private Closure $step) {}
    public function execute(?array $params = null): bool { $this->parameters = $params ?? []; ($this->step)('execute'); return true; }
    public function fetch(int $mode = PDO::FETCH_DEFAULT, int $cursorOrientation = PDO::FETCH_ORI_NEXT, int $cursorOffset = 0): mixed
    {
        archiveAssert($mode === PDO::FETCH_ASSOC); ($this->step)('fetch'); return array_shift($this->rows) ?? false;
    }
    public function closeCursor(): bool { return true; }
}
final class ArchivePDO extends PDO
{
    public array $sql = [];
    public array $statements = [];
    public bool $committed = false;
    public bool $rolledBack = false;
    public Closure $step;
    public function __construct(private array $results) { $this->step = static function (string $stage): void {}; }
    public function exec(string $statement): int|false { $this->sql[] = $statement; ($this->step)('exec'); return 0; }
    public function prepare(string $query, array $options = []): PDOStatement|false
    {
        archiveAssert(count($this->results) > 0, 'Unexpected archive SQL');
        $s = new ArchiveStatement(array_shift($this->results), $this->step);
        $this->sql[] = $query; $this->statements[] = $s; ($this->step)('prepare'); return $s;
    }
    public function inTransaction(): bool { return true; }
    public function commit(): bool { $this->committed = true; return true; }
    public function rollBack(): bool { $this->rolledBack = true; return true; }
}
$mock = static function () use ($start): ArchivePDO {
    $row = archiveFixture($start); $row['updated_at'] = '2026-01-01 12:59:00.000000';
    return new ArchivePDO([[['version' => '1'], ['version' => '2']], [['server_now' => '2026-01-01 13:00:00.000000']],
        [['algorithm_version' => '1', 'sample_cursor' => '18446744073709551615', 'sample_highwater' => '18446744073709551615',
            'samples_done' => '1', 'events_done' => '1', 'updated_at' => '2026-01-01 12:59:00.000000']], [], [$row]]);
};
$config = new HistoryConfig(true, password: 'isolated-dummy');
$clock = static fn() => new DateTimeImmutable('2026-01-01T13:00:00Z');
$test(static function () use ($mock, $hour, $config, $clock): void {
    $pdo = $mock();
    $factory = static function ($dsn, $user, $password, $options) use ($pdo): PDO {
        archiveAssert($options[PDO::MYSQL_ATTR_USE_BUFFERED_QUERY] === false && $options[PDO::ATTR_EMULATE_PREPARES] === false);
        return $pdo;
    };
    $result = (new HistoryArchive($config, $factory, $clock))->snapshot($hour);
    archiveAssert($result['status'] === 'ok' && $pdo->committed && !$pdo->rolledBack);
    archiveAssert(in_array('SET SESSION max_statement_time=1', $pdo->sql, true));
    archiveAssert(in_array('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY', $pdo->sql, true));
    foreach ($pdo->sql as $sql) {
        archiveAssert(str_starts_with($sql, 'SELECT ') || str_starts_with($sql, 'SET ') || str_starts_with($sql, 'START TRANSACTION'));
        archiveAssert(!preg_match('/GROUP BY|evse_wallbox_samples|T_ELECTRICITY|\b(?:INSERT|UPDATE|DELETE)\b/i', $sql));
    }
    archiveAssert($pdo->statements[2]->parameters === ['evse/wallbox']);
    archiveAssert($pdo->statements[4]->parameters === ['evse/wallbox', '60', '2026-01-01 12:00:00', '2026-01-01 12:59:00']);
});
foreach (['exec', 'prepare', 'execute', 'fetch'] as $stage) {
    $test(static function () use ($mock, $hour, $config, $clock, $stage): void {
        $pdo = $mock(); $time = (object) ['now' => 0]; $expired = false; $following = 0;
        $pdo->step = static function (string $actual) use ($stage, $time, &$expired, &$following): void {
            if ($expired) { ++$following; }
            if ($actual === $stage) { $time->now = 3000000000; $expired = true; }
        };
        $result = (new HistoryArchive($config, static fn() => $pdo, $clock, static fn() => $time->now))->snapshot($hour);
        archiveAssert($expired && $following === 0 && $pdo->rolledBack && !$pdo->committed && $result['status'] === 'unavailable');
        archiveAssert($result['buckets'] === [] && !str_contains(json_encode($result), 'isolated-dummy'));
    });
}
$test(static function () use ($mock, $hour, $config): void {
    $pdo = $mock();
    $result = (new HistoryArchive($config, static fn() => $pdo, static fn() => new DateTimeImmutable('2025-01-01T00:00:00Z')))->snapshot($hour);
    archiveAssert($result['status'] === 'unavailable' && $pdo->rolledBack && !$pdo->committed);
});
$test(static function () use ($mock, $hour, $config): void {
    $pdo = $mock(); $calls = 0;
    $clock = static function () use (&$calls): DateTimeImmutable {
        return new DateTimeImmutable($calls++ === 0 ? '2026-01-01T13:00:00Z' : '2026-01-01T12:59:00Z');
    };
    $result = (new HistoryArchive($config, static fn() => $pdo, $clock))->snapshot($hour);
    archiveAssert($result['status'] === 'unavailable' && $pdo->rolledBack && !$pdo->committed);
});
$test(static function () use ($hour, $start): void {
    $row = archiveMutate(archiveFixture($start), static function (array &$d): void {
        foreach (['charging', 'session_energy_wh'] as $key) {
            $d['metrics'][$key]['n'] = 1;
            $d['metrics'][$key]['nulls'] = 1;
            $d['metrics'][$key]['last'] = null;
        }
        $d['has_gap'] = true;
    });
    $result = HistoryArchive::project($hour, [$row]);
    archiveAssert($result['buckets'][0]['metrics']['charging']['last'] === null);
    archiveAssert($result['buckets'][0]['metrics']['session_energy_wh']['last'] === null);
});
$test(static function () use ($range, $start): void {
    $later = archiveMutate(archiveFixture($start + 60), static function (array &$d): void {
        $d['metrics']['session_energy_wh'] = ['n' => 0, 'nulls' => 2, 'sum' => null,
            'min' => null, 'max' => null, 'first' => null, 'last' => null, 'mixed' => false];
        $d['has_gap'] = true;
    });
    $result = HistoryArchive::project($range('period=day&date=2026-01-01&tz=UTC'), [archiveFixture($start), $later]);
    $bin = array_values(array_filter($result['buckets'], static fn($b) => $b['samples'] > 0))[0];
    archiveAssert($bin['metrics']['session_energy_wh']['last'] === null);
    archiveAssert($bin['metrics']['session_energy_wh']['nulls'] === 2);
});
print('Archive: ' . $cases . " isolated cases passed\n");
