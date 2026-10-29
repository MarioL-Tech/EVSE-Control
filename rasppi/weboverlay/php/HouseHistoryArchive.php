<?php
declare(strict_types=1);

namespace EvseOverlay;

/** Materialized HOUSE reader. There is deliberately no raw-data fallback. */
final class HouseHistoryArchive
{
    private HouseHistoryStore $reader;

    public function __construct(HouseHistoryConfig $config, ?callable $factory = null, ?callable $clock = null, ?callable $monotonic = null)
    {
        $this->reader = new HouseHistoryStore($config, $factory, $clock, $monotonic);
    }

    /** Minute edges plus bounded hour interiors: a leap year reads at most 8,784 hour rows. */
    public static function segments(HistoryRange $range): array
    {
        $a = $range->from->getTimestamp(); $b = $range->to->getTimestamp();
        if ($range->resolution() === 60) { return [['minute', $a, $b, 60]]; }
        $left = min($b, $a + (3600 - $a % 3600) % 3600);
        $right = max($left, $b - $b % 3600);
        $segments = [];
        if ($left > $a) { $segments[] = ['minute', $a, $left, 60]; }
        if ($right > $left) { $segments[] = ['hour', $left, $right, 3600]; }
        if ($b > $right) { $segments[] = ['minute', $right, $b, 60]; }
        return $segments;
    }

    private static function count(mixed $value): int { return (int) HouseHistoryStore::uint($value); }

    private static function bucket(array $row): array
    {
        $a = HouseHistoryStore::date($row['bucket_start']); $b = HouseHistoryStore::date($row['bucket_end']);
        $seconds = match ($row['level']) { 'minute' => 60, 'hour' => 3600, 'day' => 86400, default => throw new \UnexpectedValueException('Invalid house level') };
        if ($a->format('u') !== '000000' || $b->format('u') !== '000000' || $a->getTimestamp() % $seconds !== 0 || $b->getTimestamp() - $a->getTimestamp() !== $seconds) {
            throw new \UnexpectedValueException('Invalid house bucket bounds');
        }
        $samples = self::count($row['samples']); $valid = self::count($row['valid_count']); $nulls = self::count($row['null_count']);
        $coverage = self::count($row['coverage_ms']);
        if ($valid + $nulls !== $samples || $coverage > $seconds * 1000) { throw new \UnexpectedValueException('Invalid house counts'); }
        $sum = HouseHistoryStore::decimal($row['sum_w'], true);
        $min = HouseHistoryStore::decimal($row['min_w']); $max = HouseHistoryStore::decimal($row['max_w']);
        $first = HouseHistoryStore::decimal($row['first_w']); $last = HouseHistoryStore::decimal($row['last_w']);
        if (($valid === 0 && ($sum !== null || $min !== null || $max !== null || $first !== null || $last !== null)) ||
            ($valid > 0 && ($sum === null || $min === null || $max === null || $min > $max || $sum / $valid < $min - 0.000001 || $sum / $valid > $max + 0.000001)) ||
            ($samples === 0 && ($row['first_at'] !== null || $row['last_at'] !== null || $coverage !== 0)) ||
            ($samples > 0 && ($row['first_at'] === null || $row['last_at'] === null))) {
            throw new \UnexpectedValueException('Invalid house aggregate');
        }
        if ($samples > 0) {
            $firstAt = HouseHistoryStore::date($row['first_at']); $lastAt = HouseHistoryStore::date($row['last_at']);
            if ($firstAt < $a || $lastAt >= $b || $firstAt > $lastAt ||
                ($nulls === 0 && ($first === null || $last === null)) ||
                ($first !== null && ($first < $min || $first > $max)) || ($last !== null && ($last < $min || $last > $max))) {
                throw new \UnexpectedValueException('Invalid house endpoints');
            }
        }
        return ['a' => $a->getTimestamp(), 'b' => $b->getTimestamp(), 'samples' => $samples,
            'valid' => $valid, 'nulls' => $nulls, 'sum' => $sum, 'min' => $min, 'max' => $max, 'last' => $last,
            'coverage' => $coverage / 1000, 'gap' => HouseHistoryStore::flag($row['has_gap']), 'complete' => HouseHistoryStore::flag($row['complete'])];
    }

    /** Pure projection, no inference of continuity from counts or constant values. */
    public static function project(HistoryRange $range, iterable $rows, array $dirty = [], ?callable $guard = null): array
    {
        $bins = $range->bins(); $output = [];
        foreach ($bins as [$a, $b]) {
            $output[] = ['from' => gmdate('Y-m-d\TH:i:s\Z', $a), 'to' => gmdate('Y-m-d\TH:i:s\Z', $b), 'samples' => 0,
                'has_gap' => false, 'complete' => true, 'coverage_seconds' => 0.0, 'metrics' => [],
                '_seconds' => 0, '_count' => 0, '_nulls' => 0, '_sum' => 0.0, '_min' => null, '_max' => null, '_last' => null];
        }
        $previous = null; $count = 0; $bytes = 0; $binIndex = 0;
        foreach ($rows as $row) {
            if ($guard !== null) { $guard(); }
            ++$count; $bytes += strlen(serialize($row));
            if ($count > 10000 || $bytes > 33554432) { throw new \UnexpectedValueException('House input bound'); }
            $d = self::bucket($row);
            if ($previous !== null && $d['a'] < $previous) { throw new \UnexpectedValueException('Overlapping house summaries'); }
            $previous = $d['b'];
            while (isset($bins[$binIndex]) && $bins[$binIndex][1] <= $d['a']) { ++$binIndex; }
            if (!isset($bins[$binIndex]) || $d['a'] < $bins[$binIndex][0] || $d['b'] > $bins[$binIndex][1]) {
                throw new \UnexpectedValueException('House summary outside bin');
            }
            $o = &$output[$binIndex];
            foreach (['samples' => 'samples', '_count' => 'valid', '_nulls' => 'nulls'] as $key => $source) {
                if ($d[$source] > 9007199254740991 - $o[$key]) { throw new \UnexpectedValueException('House aggregate overflow'); }
                $o[$key] += $d[$source];
            }
            $o['_sum'] += $d['sum'] ?? 0.0;
            if (!is_finite($o['_sum'])) { throw new \UnexpectedValueException('House sum overflow'); }
            if ($d['min'] !== null) { $o['_min'] = $o['_min'] === null ? $d['min'] : min($o['_min'], $d['min']); }
            if ($d['max'] !== null) { $o['_max'] = $o['_max'] === null ? $d['max'] : max($o['_max'], $d['max']); }
            // Empty buckets do not overwrite a last observation, but a real NULL does.
            if ($d['samples'] > 0) { $o['_last'] = $d['last']; }
            $o['_seconds'] += $d['b'] - $d['a'];
            $o['coverage_seconds'] += $d['coverage'];
            $o['complete'] = $o['complete'] && $d['complete'];
            $o['has_gap'] = $o['has_gap'] || $d['gap'] || !$d['complete'] || $d['nulls'] > 0;
            unset($o);
        }
        $complete = true;
        foreach ($output as $i => &$o) {
            if ($guard !== null) { $guard(); }
            [$a, $b] = $bins[$i];
            $pending = false;
            foreach ($dirty as [$x, $y]) { if ($x < $b && $y > $a) { $pending = true; break; } }
            if ($o['_seconds'] !== $b - $a || $pending) { $o['complete'] = false; }
            if ($o['coverage_seconds'] < $b - $a || !$o['complete']) { $o['has_gap'] = true; }
            if ($pending) {
                // Dirty rows are stale, not an estimate of the new observations.
                $o['samples'] = $o['_count'] = $o['_nulls'] = 0;
                $o['coverage_seconds'] = 0.0; $o['_min'] = $o['_max'] = $o['_last'] = null;
            }
            $mean = $o['_count'] > 0 ? $o['_sum'] / $o['_count'] : null;
            if ($mean !== null && (!is_finite($mean) || abs($mean) > 9007199254740991)) { throw new \UnexpectedValueException('Unsafe house mean'); }
            $o['metrics'] = ['power_w' => ['count' => $o['_count'], 'nulls' => $o['_nulls'], 'mean' => $mean,
                'min' => $o['_min'], 'max' => $o['_max'], 'last' => $o['_last'], 'mixed' => false]];
            $complete = $complete && $o['complete'];
            foreach (array_keys($o) as $key) { if (str_starts_with($key, '_')) { unset($o[$key]); } }
        }
        unset($o);
        return ['complete' => $complete, 'progress' => ['samples_done' => $complete, 'events_done' => $complete], 'buckets' => $output];
    }

    public function snapshot(HistoryRange $range): array
    {
        return $this->reader->read($range, static function ($select, $prefix, $now, $guard) use ($range): array {
            $start = $range->from->getTimestamp(); $end = $range->to->getTimestamp();
            $dirty = [];
            foreach (['minute' => 60, 'hour' => 3600, 'day' => 86400] as $level => $res) {
                $last = null;
                do {
                    // source,pending,level,bucket_start is the writer-owned
                    // covering access path; keep keyset comparisons on it.
                    $sql = 'SELECT level, bucket_start, generation, processed_generation, pending FROM evse_house_work FORCE INDEX (pending_work) WHERE source = CAST(? AS BINARY) AND pending = 1 AND level = ? AND bucket_start >= ? AND bucket_start < ?';
                    $parameters = [$prefix, $level, gmdate('Y-m-d H:i:s', $start - $res + 1), gmdate('Y-m-d H:i:s', $end)];
                    if ($last !== null) { $sql .= ' AND bucket_start > ?'; $parameters[] = $last; }
                    $page = $select($sql . ' ORDER BY bucket_start LIMIT 256', $parameters);
                    foreach ($page as $row) {
                        if ($row['level'] !== $level) { throw new \UnexpectedValueException('Invalid pending house level'); }
                        $t = HouseHistoryStore::date($row['bucket_start']);
                        $generation = HouseHistoryStore::uint($row['generation'], '18446744073709551615');
                        $processed = HouseHistoryStore::uint($row['processed_generation'], '18446744073709551615');
                        if ($generation === '0' || HouseHistoryStore::compareUint($processed, $generation) > 0 || !HouseHistoryStore::flag($row['pending']) ||
                            $t->format('u') !== '000000' || $t->getTimestamp() % $res !== 0) {
                            throw new \UnexpectedValueException('Invalid pending house boundary');
                        }
                        // Pending parent publication also prevents children from appearing final.
                        $dirty[] = [$t->getTimestamp(), $t->getTimestamp() + $res];
                        $last = $row['bucket_start'];
                    }
                } while (count($page) === 256);
            }
            $rows = (static function () use ($range, $select, $prefix, $now): \Generator {
                foreach (self::segments($range) as [$level, $a, $b, $res]) {
                    $last = null;
                    do {
                        $sql = 'SELECT level, bucket_start, bucket_end, samples, valid_count, null_count, sum_w, min_w, max_w, first_w, last_w, first_at, last_at, coverage_ms, has_gap, complete FROM evse_house_buckets FORCE INDEX (PRIMARY) WHERE source = CAST(? AS BINARY) AND level = ? AND bucket_start >= ? AND bucket_start <= ?';
                        $parameters = [$prefix, $level, gmdate('Y-m-d H:i:s', $a), gmdate('Y-m-d H:i:s', $b - $res)];
                        if ($last !== null) { $sql .= ' AND bucket_start > ?'; $parameters[] = $last; }
                        $page = $select($sql . ' ORDER BY bucket_start LIMIT 256', $parameters);
                        foreach ($page as $row) {
                            if ($row['last_at'] !== null && HouseHistoryStore::date($row['last_at']) > $now->modify('+5 seconds')) {
                                throw new \UnexpectedValueException('Future house observation');
                            }
                            $last = $row['bucket_start']; yield $row;
                        }
                    } while (count($page) === 256);
                }
            })();
            return self::project($range, $rows, $dirty, $guard);
        });
    }
}
