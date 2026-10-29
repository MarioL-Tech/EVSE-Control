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
$range = static fn(string $q): HistoryRange => HistoryRange::parse($q, new DateTimeImmutable('2030-01-01T00:00:00Z'));
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
    archiveAssert(count($leap->bins()) === 53);
    archiveAssert($leap->to->getTimestamp() - $leap->from->getTimestamp() === 8784 * 3600);
    archiveAssert(count($range('period=month&date=2024-02')->bins()) === 29);
    archiveAssert($range('period=week&date=2020-W53')->from->format('Y-m-d') === '2020-12-28');
});
$test(static function () use ($range): void {
    $a = $range('period=hour&at=2026-10-25T00:30:00Z');
    $b = $range('period=hour&at=2026-10-25T01:30:00Z');
    archiveAssert($a->label === $b->label && $b->from->getTimestamp() - $a->from->getTimestamp() === 3600);
    $nav = $a->envelope('ok', new DateTimeImmutable('2026-10-25T01:30:00Z'))['navigation'];
    archiveAssert($nav['next']['at'] === HistoryRange::iso($b->from));
    archiveAssert($range(http_build_query($nav['next']))->from == $b->from);
    $now = HistoryRange::parse('period=month&date=now', new DateTimeImmutable('2026-12-31T23:30:00Z'));
    archiveAssert($now->label === '2027-01');
});
$test(static function (): void {
    $now = new DateTimeImmutable('2026-10-29T18:30:00Z');
    foreach (['period=hour&date=2026-10-29T20:00', 'period=day&date=2026-10-30',
        'period=week&date=2026-W45', 'period=month&date=2026-11', 'period=year&date=2027',
        'period=hour&at=2026-10-29T18:30:01Z',
        'period=custom&from=2026-10-28T00:00:00Z&to=2026-10-29T18:30:01Z',
        'period=custom&date_from=2026-10-28T00:00&date_to=2026-10-29T19:31'] as $future) {
        archiveReject(static fn() => HistoryRange::parse($future, $now));
    }
    foreach (['hour','day','week','month','year'] as $period) {
        $r = HistoryRange::parse('period=' . $period . '&date=now', $now);
        archiveAssert($r->from <= $now && $r->envelope('ok', $now)['navigation']['next'] === null);
    }
    $today = HistoryRange::parse('period=day&date=2026-10-29', $now);
    $yesterday = HistoryRange::parse('period=day&date=2026-10-28', $now);
    archiveAssert($yesterday->envelope('ok', $now)['navigation']['next']['at'] === HistoryRange::iso($today->from));
    archiveAssert(HistoryRange::parse('period=custom&from=2026-10-28T00:00:00Z&to=2026-10-29T18:30:00Z', $now)->to == $now);
    $firstHour = new DateTimeImmutable('2026-10-25T00:30:00Z');
    $r = HistoryRange::parse('period=hour&date=now', $firstHour);
    archiveAssert($r->envelope('ok', $firstHour)['navigation']['next'] === null);
    archiveReject(static fn() => HistoryRange::parse('period=hour&at=2026-10-25T01:00:00Z', $firstHour));
});
$hour = $range('period=hour&date=2026-01-01T12:00&tz=UTC');
$test(static function () use ($range): void {
    foreach (['2026-03' => 23, '2026-10' => 25] as $month => $dstHours) {
        $r = $range('period=month&date=' . $month);
        archiveAssert(count($r->bins()) === 31);
        $durations = array_map(static fn($bin) => ($bin[1] - $bin[0]) / 3600, $r->bins());
        archiveAssert(in_array($dstHours, $durations));
        archiveAssert(array_sum($durations) * 3600 === $r->to->getTimestamp() - $r->from->getTimestamp());
    }
    foreach (['2012' => 54, '2024' => 53, '2026' => 53] as $year => $count) {
        $r = $range('period=year&date=' . $year);
        $bins = $r->bins(); archiveAssert(count($bins) === $count);
        archiveAssert($bins[0][0] === $r->from->getTimestamp() && end($bins)[1] === $r->to->getTimestamp());
        foreach ($bins as $i => [$a, $b]) {
            archiveAssert($a < $b && $b - $a <= 169 * 3600);
            if ($i) archiveAssert($a === $bins[$i - 1][1]);
        }
    }
    // Read existing hour sums/counts, not an average of differently populated days.
    $month = $range('period=month&date=2026-03&tz=UTC');
    $a = $month->from->getTimestamp();
    $p = HistoryArchive::project($month, [archiveFixture($a, 3600, 2, 100), archiveFixture($a + 3600, 3600, 6, 300)]);
    archiveAssert(count($p['buckets']) === 31 && $p['buckets'][0]['metrics']['active_power_w']['mean'] === 250.0);
    $year = $range('period=year&date=2026&tz=UTC');
    $a = $year->from->getTimestamp();
    $p = HistoryArchive::project($year, [archiveFixture($a, 3600, 2, 100), archiveFixture($a + 86400, 3600, 6, 300)]);
    archiveAssert($p['buckets'][0]['metrics']['active_power_w']['mean'] === 250.0);
    archiveAssert($p['buckets'][0]['metrics']['session_energy_wh']['mean'] === null);
});
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
    $rows = [];
    for ($i = 0; $i < 60; ++$i) {
        $rows[] = archiveMutate(archiveFixture($start + $i * 60, 60, 2, 0), static function (&$d) use ($i): void {
            $d['metrics']['charging'] = ['n' => 0, 'nulls' => 2, 'sum' => null,
                'min' => null, 'max' => null, 'first' => null, 'last' => null, 'mixed' => false];
            foreach (['current_l1_a', 'current_l2_a', 'current_l3_a', 'voltage_l1_v', 'voltage_l2_v', 'voltage_l3_v'] as $field) {
                $value = str_starts_with($field, 'voltage_') ? '230' : '0';
                $d['metrics'][$field] = ['n' => 2, 'nulls' => 0, 'sum' => $value === '0' ? '0' : '460',
                    'min' => $value, 'max' => $value, 'first' => $value, 'last' => $value, 'mixed' => false];
            }
            if ($i === 20) {
                $d['metrics']['current_l1_a']['n'] = 1;
                $d['metrics']['current_l1_a']['nulls'] = 1;
                $d['metrics']['current_l1_a']['last'] = null;
            }
        });
    }
    $p = HistoryArchive::project($hour, $rows);
    archiveAssert($p['complete']);
    foreach ($p['buckets'] as $i => $bin) {
        archiveAssert($bin['complete'] && !$bin['has_gap'] && $bin['coverage_seconds'] === 60.0);
        $m = $bin['metrics'];
        archiveAssert($m['charging']['count'] === 0 && $m['charging']['nulls'] === 2 && $m['charging']['last'] === null);
        archiveAssert($m['active_power_w']['mean'] === 0.0 && $m['current_limit_a']['last'] === 6.0);
        foreach (['voltage_l1_v', 'voltage_l2_v', 'voltage_l3_v'] as $field) {
            archiveAssert($m[$field]['mean'] === 230.0 && $m[$field]['nulls'] === 0);
        }
        archiveAssert($m['current_l1_a']['nulls'] === ($i === 20 ? 1 : 0));
        archiveAssert($m['current_l1_a']['last'] === ($i === 20 ? null : 0.0));
        archiveAssert($m['current_l1_a']['mean'] === 0.0);
        archiveAssert($m['current_l2_a']['nulls'] === 0 && $m['current_l3_a']['nulls'] === 0);
    }
    foreach (['has_gap', 'coverage', 'complete', 'retained'] as $barrier) {
        $bad = archiveMutate($rows[0], static function (&$d) use ($barrier): void {
            if ($barrier === 'has_gap') { $d['has_gap'] = true; }
            if ($barrier === 'coverage') { $d['coverage_seconds'] = '58'; }
            if ($barrier === 'complete') { $d['complete'] = false; }
            if ($barrier === 'retained') { $d['retained_samples'] = 1; }
        });
        archiveAssert(HistoryArchive::project($hour, [$bad])['buckets'][0]['has_gap']);
    }
    $dirty = HistoryArchive::project($hour, $rows, [[$start, $start + 60]])['buckets'][0];
    archiveAssert($dirty['has_gap'] && !$dirty['complete'] && $dirty['metrics']['active_power_w']['mean'] === null);
    archiveAssert(HistoryArchive::project($hour, $rows, [], false)['buckets'][0]['has_gap']);
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
    archiveAssert($p['complete'] && count($p['buckets']) === 53);
    archiveAssert(array_sum(array_column($p['buckets'], 'samples')) === 8784 * 2);
    foreach ($p['buckets'] as $b) {
        $hours = (strtotime($b['to']) - strtotime($b['from'])) / 3600;
        archiveAssert($hours > 0 && $hours <= 169 && $b['samples'] === (int) $hours * 2);
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
$mock = static function (array $changes = [], ?array $rows = null, array $pending = []) use ($start): ArchivePDO {
    $row = archiveFixture($start); $row['updated_at'] = '2026-01-01 12:59:00.000000';
    return new ArchivePDO([[['version' => '1'], ['version' => '2']], [['server_now' => '2026-01-01 13:00:00.000000']],
        [array_replace(['algorithm_version' => '1', 'sample_cursor' => '18446744073709551615', 'sample_highwater' => '18446744073709551615',
            'samples_done' => '1', 'events_done' => '1', 'updated_at' => '2026-01-01 12:59:00.000000', 'initialized' => '1',
            'event_cursor_at' => '2026-01-01 11:00:00.000000', 'event_highwater_at' => '2026-01-01 11:00:00.000000',
            'event_cursor_id' => str_repeat('0', 32), 'event_highwater_id' => str_repeat('0', 32),
            'invalidate_from' => null, 'invalidate_cursor' => null], $changes)], $pending, $rows ?? [$row]]);
};
$config = new HistoryConfig(true, password: 'isolated-dummy');
$clock = static fn() => new DateTimeImmutable('2026-01-01T13:00:00Z');
$fullRows = [];
for ($i = 0; $i < 60; ++$i) {
    $row = archiveFixture($start + $i * 60);
    $row['updated_at'] = '2026-01-01 12:59:00.000000';
    $fullRows[] = $row;
}
$test(static function () use ($mock, $hour, $config, $clock, $fullRows): void {
    $pdo = $mock(['events_done' => '0', 'invalidate_from' => '2026-01-01 13:00:00.000000'], $fullRows);
    $v = (new HistoryArchive($config, static fn() => $pdo, $clock))->snapshot($hour);
    archiveAssert($v['status'] === 'ok' && $v['complete'] && !$v['progress']['events_done']);
    foreach ($v['buckets'] as $bin) { archiveAssert($bin['complete'] && !$bin['has_gap'] && $bin['samples'] === 2); }
    archiveAssert($pdo->statements[2]->parameters === ['evse/wallbox']);
    archiveAssert($pdo->statements[3]->parameters === ['evse/wallbox', '60', '2026-01-01 11:59:01', '2026-01-01 13:00:00']);
});
$test(static function () use ($mock, $hour, $config, $clock, $fullRows): void {
    foreach (['2026-01-01 12:20:00.000000', '2026-01-01 12:50:00.000000'] as $cursor) {
        $pdo = $mock(['events_done' => '0', 'invalidate_from' => '2026-01-01 12:20:00.000000', 'invalidate_cursor' => $cursor], $fullRows);
        $v = (new HistoryArchive($config, static fn() => $pdo, $clock))->snapshot($hour);
        archiveAssert($v['status'] === 'ok' && !$v['complete']);
        foreach ($v['buckets'] as $i => $bin) {
            archiveAssert($bin['complete'] === ($i < 20) && $bin['has_gap'] === ($i >= 20));
            archiveAssert($bin['samples'] === ($i < 20 ? 2 : 0));
            if ($i >= 20) { archiveAssert($bin['metrics']['active_power_w']['mean'] === null); }
        }
    }
});
foreach ([['initialized' => '0', 'events_done' => '0'],
    ['samples_done' => '0', 'sample_cursor' => '0', 'events_done' => '0'],
    ['event_cursor_at' => '2026-01-01 10:59:59.999999', 'event_cursor_id' => str_repeat('F', 32), 'events_done' => '0'],
    ['event_cursor_id' => str_repeat('0', 31) . '1', 'event_highwater_id' => str_repeat('0', 31) . '2', 'events_done' => '0'],
    ['events_done' => '0', 'invalidate_from' => null]] as $changes) {
    $test(static function () use ($mock, $hour, $config, $clock, $fullRows, $changes): void {
        $pdo = $mock(array_replace(['invalidate_from' => '2026-01-01 13:00:00.000000'], $changes), $fullRows);
        $v = (new HistoryArchive($config, static fn() => $pdo, $clock))->snapshot($hour);
        archiveAssert($v['status'] === 'ok' && !$v['complete']);
        foreach ($v['buckets'] as $bin) { archiveAssert(!$bin['complete'] && $bin['has_gap']); }
    });
}
$test(static function () use ($mock, $hour, $config, $clock, $fullRows): void {
    foreach (['2026-01-01 11:00:00.000000', '2026-01-01 11:00:00.000001'] as $at) {
        $pdo = $mock(['events_done' => '0', 'event_cursor_at' => $at,
            'event_cursor_id' => str_repeat('F', 32), 'invalidate_from' => '2026-01-01 13:00:00.000000'], $fullRows);
        archiveAssert((new HistoryArchive($config, static fn() => $pdo, $clock))->snapshot($hour)['complete']);
    }
    $pending = [['bucket_start' => '2026-01-01 12:10:00.000000', 'resolution_seconds' => '60']];
    foreach ([['events_done' => '0', 'invalidate_from' => '2026-01-01 12:20:00.000000', 'invalidate_cursor' => '2026-01-01 12:50:00.000000'], []] as $changes) {
        $pdo = $mock($changes, $fullRows, $pending);
        $v = (new HistoryArchive($config, static fn() => $pdo, $clock))->snapshot($hour);
        archiveAssert($v['status'] === 'ok' && !$v['complete'] && !$v['buckets'][10]['complete']);
        archiveAssert($v['buckets'][10]['metrics']['active_power_w']['mean'] === null);
        archiveAssert($v['buckets'][9]['complete'] && !$v['buckets'][9]['has_gap']);
        archiveAssert($v['buckets'][40]['complete'] === ($changes === []));
    }
    $pdo = $mock([], $fullRows);
    archiveAssert((new HistoryArchive($config, static fn() => $pdo, $clock))->snapshot($hour)['complete']);
});
foreach ([['initialized' => '2'], ['event_cursor_id' => str_repeat('A', 31)],
    ['event_highwater_id' => str_repeat('G', 32)], ['event_cursor_id' => null],
    ['event_cursor_at' => '2026-02-30 00:00:00.000000'], ['event_highwater_at' => '2026-01-01 13:01:00.000000'],
    ['events_done' => '0', 'invalidate_from' => '2026-01-01 12:00:01.000000'],
    ['events_done' => '0', 'invalidate_from' => '2026-01-01 12:00:00.000001'],
    ['events_done' => '0', 'invalidate_from' => '1000-01-01 00:00:00.000001'],
    ['events_done' => '0', 'invalidate_from' => '1000-01-01 00:00:00.000000', 'invalidate_cursor' => '1000-01-01 00:00:00.000001'],
    ['events_done' => '0', 'invalidate_from' => '2026-01-01 12:20:00.000000', 'invalidate_cursor' => '2026-01-01 12:19:00.000000'],
    ['events_done' => '0', 'invalidate_cursor' => '2026-01-01 12:20:00.000000'],
    ['invalidate_from' => '2026-01-01 12:20:00.000000'],
    ['event_cursor_id' => str_repeat('0', 32), 'event_highwater_id' => str_repeat('F', 32)]] as $changes) {
    $test(static function () use ($mock, $hour, $config, $clock, $fullRows, $changes): void {
        $pdo = $mock($changes, $fullRows);
        $v = (new HistoryArchive($config, static fn() => $pdo, $clock))->snapshot($hour);
        archiveAssert($v['status'] === 'unavailable' && $v['buckets'] === [] && $pdo->rolledBack);
    });
}
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
