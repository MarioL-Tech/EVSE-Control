<?php
declare(strict_types=1);

namespace EvseOverlay;

/** Bounded, SELECT-only materialized history reader. Never falls back to raw samples. */
final class HistoryArchive
{
    public const METRICS = ['active_power_w', 'session_energy_wh', 'current_limit_a',
        'current_l1_a', 'current_l2_a', 'current_l3_a', 'voltage_l1_v', 'voltage_l2_v', 'voltage_l3_v',
        'plugged_in', 'charging', 'below_commanded_current', 'error_code', 'charging_state', 'charging_state_raw', 'socket_lock_state'];
    private const FLAGS = ['plugged_in', 'charging', 'below_commanded_current'];
    private const CODES = ['error_code', 'charging_state', 'charging_state_raw', 'socket_lock_state'];
    private const MEANS = ['active_power_w', 'current_l1_a', 'current_l2_a', 'current_l3_a', 'voltage_l1_v', 'voltage_l2_v', 'voltage_l3_v'];
    private \Closure $factory;
    private \Closure $clock;
    private \Closure $monotonic;

    public function __construct(private HistoryConfig $config, ?callable $factory = null, ?callable $clock = null, ?callable $monotonic = null)
    {
        $this->factory = \Closure::fromCallable($factory ?? static fn($dsn, $user, $password, $options) => new \PDO($dsn, $user, $password, $options));
        $this->clock = \Closure::fromCallable($clock ?? static fn() => new \DateTimeImmutable('now', new \DateTimeZone('UTC')));
        $this->monotonic = \Closure::fromCallable($monotonic ?? static fn() => hrtime(true));
    }

    public function __debugInfo(): array { return ['enabled' => $this->config->enabled]; }

    public static function failure(HistoryRange $range): array
    {
        return $range->envelope('unavailable', new \DateTimeImmutable('now', new \DateTimeZone('UTC')));
    }

    public static function versions(array $rows, bool $archive = false): void
    {
        $versions = array_column($rows, 'version');
        sort($versions, SORT_STRING);
        if (($versions !== ['1'] && $versions !== ['1', '2']) || count($rows) !== count($versions) || ($archive && $versions !== ['1', '2'])) {
            throw new \UnexpectedValueException('Unsupported history schema');
        }
    }

    private static function keys(array $value, array $keys): void
    {
        if (count($value) !== count($keys) || array_diff(array_keys($value), $keys)) {
            throw new \UnexpectedValueException('Invalid summary shape');
        }
    }

    private static function count(mixed $value): int
    {
        if (!is_int($value) || $value < 0 || $value > 9007199254740991) {
            throw new \UnexpectedValueException('Invalid summary count');
        }
        return $value;
    }

    private static function decimal(mixed $value): ?float
    {
        if ($value === null) {
            return null;
        }
        // Canonical, finite, nonnegative physical readings; bounded before float conversion.
        if (!is_string($value) || strlen($value) > 80 || !preg_match('/\A(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?\z/D', $value) || !is_finite((float) $value) || (float) $value > 1e40 || ((float) $value === 0.0 && $value !== '0')) {
            throw new \UnexpectedValueException('Invalid summary decimal');
        }
        return (float) $value;
    }

    private static function timestamp(mixed $value, bool $sql = false): float
    {
        $pattern = $sql ? '/\A[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{6})?\z/D' :
            '/\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z\z/D';
        if (!is_string($value) || !preg_match($pattern, $value)) {
            throw new \UnexpectedValueException('Invalid summary date');
        }
        $normalized = $sql ? str_replace(' ', 'T', $value) : substr($value, 0, -1);
        if (strlen($normalized) === 19) {
            $normalized .= '.000000';
        }
        $date = \DateTimeImmutable::createFromFormat('!Y-m-d\TH:i:s.u', $normalized, new \DateTimeZone('UTC'));
        if ($date === false || $date->format('Y-m-d\TH:i:s.u') !== $normalized) {
            throw new \UnexpectedValueException('Invalid summary date');
        }
        return (float) $date->format('U.u');
    }

    private static function data(string $json, int $start, int $resolution): array
    {
        if (strlen($json) > 65536) {
            throw new \UnexpectedValueException('Summary too large');
        }
        // Worker summaries contain only canonical compact ASCII JSON, integer
        // counts and decimal *strings*. A native decode/encode round-trip rejects
        // duplicate/escaped-alias keys and noncanonical numbers without scanning
        // a year's summaries with the PHP-level MQTT parser. Structural/type
        // validation below remains mandatory, including arrays-as-objects.
        $object = json_decode($json, false, 64, JSON_THROW_ON_ERROR);
        if (json_encode($object, JSON_THROW_ON_ERROR) !== $json) {
            throw new \UnexpectedValueException('Noncanonical summary JSON');
        }
        if (!$object instanceof \stdClass) {
            throw new \UnexpectedValueException('Invalid summary object');
        }
        $d = (array) $object;
        self::keys($d, ['schema_version', 'samples', 'valid_samples', 'error_samples', 'retained_samples', 'first_at', 'last_at', 'has_gap', 'complete', 'coverage_seconds', 'metrics']);
        if ($d['schema_version'] !== 1 || !is_bool($d['complete']) || !is_bool($d['has_gap']) || !$d['metrics'] instanceof \stdClass) {
            throw new \UnexpectedValueException('Invalid summary metadata');
        }
        foreach (['samples', 'valid_samples', 'error_samples', 'retained_samples'] as $key) {
            self::count($d[$key]);
        }
        if ($d['valid_samples'] + $d['error_samples'] !== $d['samples'] || $d['retained_samples'] > $d['samples']) {
            throw new \UnexpectedValueException('Invalid summary totals');
        }
        $coverage = self::decimal($d['coverage_seconds']);
        if ($coverage === null || $coverage > $resolution) {
            throw new \UnexpectedValueException('Invalid summary coverage');
        }
        $d['coverage_seconds'] = $coverage;
        if ($d['samples'] === 0) {
            if ($d['first_at'] !== null || $d['last_at'] !== null || $coverage !== 0.0) {
                throw new \UnexpectedValueException('Invalid empty summary');
            }
        } else {
            $first = self::timestamp($d['first_at']);
            $last = self::timestamp($d['last_at']);
            if ($first < $start || $last < $first || $last >= $start + $resolution) {
                throw new \UnexpectedValueException('Summary outside bucket');
            }
        }
        $metrics = (array) $d['metrics'];
        self::keys($metrics, self::METRICS);
        foreach ($metrics as $key => $stat) {
            if (!$stat instanceof \stdClass) {
                throw new \UnexpectedValueException('Invalid metric object');
            }
            $s = (array) $stat;
            self::keys($s, ['n', 'nulls', 'sum', 'min', 'max', 'first', 'last', 'mixed']);
            $n = self::count($s['n']);
            $nulls = self::count($s['nulls']);
            if ($n + $nulls !== $d['samples'] || $nulls < $d['error_samples'] || !is_bool($s['mixed'])) {
                throw new \UnexpectedValueException('Invalid metric counts');
            }
            foreach (['sum', 'min', 'max', 'first', 'last'] as $field) {
                $places = str_starts_with($key, 'current_') ? 3 : (str_starts_with($key, 'voltage_') ? 1 : 0);
                $pattern = '/\A[0-9]+' . ($places > 0 ? '(?:\.[0-9]{1,' . $places . '})?' : '') . '\z/D';
                if ($s[$field] !== null && (!is_string($s[$field]) || !preg_match($pattern, $s[$field]))) {
                    throw new \UnexpectedValueException('Invalid metric precision');
                }
                $s[$field] = self::decimal($s[$field]);
            }
            $mean = in_array($key, self::MEANS, true);
            if ((!$mean && $s['sum'] !== null) || ($mean && $n > 0 && $s['sum'] === null) || ($n > 0 && ($s['min'] === null || $s['max'] === null)) ||
                ($n === 0 && ($s['min'] !== null || $s['max'] !== null || $s['first'] !== null || $s['last'] !== null || $s['mixed'] || ($s['sum'] !== null && $s['sum'] !== 0.0))) ||
                ($n > 0 && $nulls === 0 && ($s['first'] === null || $s['last'] === null)) ||
                ($n > 0 && ($s['min'] > $s['max'] || $s['mixed'] !== ($s['min'] !== $s['max'])))) {
                throw new \UnexpectedValueException('Invalid metric statistics');
            }
            foreach (['min', 'max', 'first', 'last'] as $field) {
                $v = $s[$field];
                if ($v !== null && (($n > 0 && ($v < $s['min'] || $v > $s['max'])) ||
                    (in_array($key, self::FLAGS, true) && !in_array($v, [0.0, 1.0], true)) ||
                    (in_array($key, self::CODES, true) && ($v > 4294967295 || floor($v) !== $v)) ||
                    ($key === 'session_energy_wh' || $key === 'active_power_w') && ($v > 4294967295 || floor($v) !== $v) ||
                    (str_starts_with($key, 'current_') && $v > 4294967.295) ||
                    (str_starts_with($key, 'voltage_') && $v > 429496729.5))) {
                    throw new \UnexpectedValueException('Invalid metric value');
                }
            }
            if ($mean && $n > 0 && ($s['sum'] / $n < $s['min'] - 1e-9 * max(1, $s['min']) || $s['sum'] / $n > $s['max'] + 1e-9 * max(1, $s['max']))) {
                throw new \UnexpectedValueException('Invalid metric sum');
            }
            $metrics[$key] = $s;
        }
        $d['metrics'] = $metrics;
        return $d;
    }

    /** Pure projection accepts an iterable so PDO rows need never accumulate in memory. */
    public static function project(HistoryRange $range, iterable $rows, array $dirty = [], bool $ready = true, ?callable $guard = null, ?float $now = null): array
    {
        $bins = $range->bins();
        $output = [];
        foreach ($bins as [$a, $b]) {
            $output[] = ['from' => gmdate('Y-m-d\TH:i:s\Z', $a), 'to' => gmdate('Y-m-d\TH:i:s\Z', $b),
                'samples' => 0, 'has_gap' => !$ready, 'complete' => $ready, 'coverage_seconds' => 0.0,
                'metrics' => [], '_seconds' => 0, '_seen' => false];
        }
        $bytes = 0;
        $count = 0;
        $previous = null;
        foreach ($rows as $row) {
            if ($guard !== null) { $guard(); }
            if (++$count > 10000 || !isset($row['bucket_start'], $row['resolution_seconds'], $row['data_json']) || !is_string($row['data_json'])) {
                throw new \UnexpectedValueException('History row limit');
            }
            $bytes += strlen($row['data_json']);
            if ($bytes > 33554432) {
                throw new \UnexpectedValueException('History byte limit');
            }
            $start = self::timestamp($row['bucket_start'], true);
            $res = match ($row['resolution_seconds']) { '60', 60 => 60, '3600', 3600 => 3600, default => throw new \UnexpectedValueException('Invalid resolution') };
            if (floor($start) !== $start || (int) $start % $res !== 0 || ($previous !== null && $start < $previous)) {
                throw new \UnexpectedValueException('Overlapping history rows');
            }
            $previous = $start + $res;
            $d = self::data($row['data_json'], (int) $start, $res);
            if ($now !== null && $d['last_at'] !== null && self::timestamp($d['last_at']) > $now) {
                throw new \UnexpectedValueException('Future summary sample');
            }
            $found = false;
            foreach ($bins as $i => [$a, $b]) {
                if ($start < $a || $start + $res > $b) {
                    continue;
                }
                $found = true;
                $o = &$output[$i];
                $o['samples'] += $d['samples'];
                if ($o['samples'] > 9007199254740991) {
                    throw new \UnexpectedValueException('History count overflow');
                }
                $o['complete'] = $o['complete'] && $d['complete'];
                $o['has_gap'] = $o['has_gap'] || !$d['complete'] || $d['has_gap'] || $d['error_samples'] > 0 || $d['retained_samples'] > 0;
                $o['coverage_seconds'] += $d['coverage_seconds'];
                $o['_seconds'] += $res;
                foreach ($d['metrics'] as $key => $s) {
                    $old = $o['metrics'][$key] ?? null;
                    if ($old === null) {
                        $o['metrics'][$key] = $s;
                    } else {
                        $old['mixed'] = $old['mixed'] || $s['mixed'] || ($old['n'] > 0 && $s['n'] > 0 && $old['min'] !== $s['min']);
                        $old['n'] += $s['n'];
                        $old['nulls'] += $s['nulls'];
                        $old['sum'] = $old['sum'] === null ? null : $old['sum'] + ($s['sum'] ?? 0);
                        $old['min'] = $old['min'] === null ? $s['min'] : ($s['min'] === null ? $old['min'] : min($old['min'], $s['min']));
                        $old['max'] = $old['max'] === null ? $s['max'] : ($s['max'] === null ? $old['max'] : max($old['max'], $s['max']));
                        // Empty summaries have no observation. A real latest NULL/error
                        // must replace a preceding value instead of resurrecting it.
                        if ($d['samples'] > 0) {
                            if ($o['samples'] === $d['samples']) {
                                $old['first'] = $s['first'];
                            }
                            $old['last'] = $s['last'];
                        }
                        $o['metrics'][$key] = $old;
                    }
                }
                $o['_seen'] = true;
                unset($o);
                break;
            }
            if (!$found) {
                throw new \UnexpectedValueException('Summary outside requested bins');
            }
        }
        $complete = $ready;
        foreach ($output as $i => &$o) {
            if ($guard !== null) { $guard(); }
            [$a, $b] = $bins[$i];
            foreach ($dirty as [$x, $y]) {
                if ($x < $b && $y > $a) {
                    $o['complete'] = false;
                    $o['has_gap'] = true;
                    // A stale materialization is not an approximation of newly arrived data.
                    $o['metrics'] = [];
                    $o['samples'] = 0;
                    $o['coverage_seconds'] = 0.0;
                }
            }
            if ($o['_seconds'] !== $b - $a) {
                $o['complete'] = false;
                $o['has_gap'] = true;
            }
            if ($o['coverage_seconds'] < $b - $a) {
                $o['has_gap'] = true;
            }
            $metrics = [];
            foreach (self::METRICS as $key) {
                $s = $o['metrics'][$key] ?? ['n' => 0, 'nulls' => 0, 'sum' => null, 'min' => null, 'max' => null, 'last' => null, 'mixed' => false];
                $last = $s['last'];
                if (in_array($key, self::FLAGS, true)) {
                    $last = $last === null ? null : $last === 1.0;
                } elseif (in_array($key, self::CODES, true)) {
                    $last = $last === null ? null : (int) $last;
                }
                $metrics[$key] = ['count' => $s['n'], 'nulls' => $s['nulls'],
                    'mean' => in_array($key, self::MEANS, true) && $s['n'] > 0 ? $s['sum'] / $s['n'] : null,
                    'min' => $s['min'], 'max' => $s['max'], 'last' => $last, 'mixed' => $s['mixed']];
                // NULLs are per-metric evidence, not a loss of reception for
                // every other series. Global coverage/dirty barriers stay above.
            }
            $o['metrics'] = $metrics;
            $complete = $complete && $o['complete'];
            unset($o['_seconds'], $o['_seen']);
        }
        unset($o);
        return ['complete' => $complete, 'buckets' => $output];
    }

    public function snapshot(HistoryRange $range): array
    {
        $now = ($this->clock)();
        $wallStarted = (float) $now->format('U.u');
        if (!$this->config->enabled) {
            return $range->envelope('disabled', $now);
        }
        $pdo = null;
        try {
            $started = ($this->monotonic)();
            $deadline = $started + 3000000000;
            $guard = function () use ($deadline): void {
                if (($this->monotonic)() >= $deadline) {
                    throw new \RuntimeException('History budget exceeded');
                }
            };
            $guard();
            $c = $this->config;
            $pdo = ($this->factory)("mysql:host={$c->host};port={$c->port};dbname={$c->database};charset=utf8mb4", $c->username, $c->password(),
                [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION, \PDO::ATTR_EMULATE_PREPARES => false,
                    \PDO::ATTR_STRINGIFY_FETCHES => true, \PDO::ATTR_TIMEOUT => 2, \PDO::MYSQL_ATTR_USE_BUFFERED_QUERY => false]);
            $guard();
            foreach (['SET SESSION max_statement_time=1', "SET time_zone='+00:00'", 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
                'SET TRANSACTION READ ONLY', 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY'] as $sql) {
                $guard();
                $pdo->exec($sql);
                $guard();
            }
            $select = static function (string $sql, array $parameters = []) use ($pdo, $guard): \Generator {
                $guard();
                $s = $pdo->prepare($sql);
                $guard();
                $s->execute($parameters);
                $guard();
                try {
                    while (true) {
                        $guard();
                        $row = $s->fetch(\PDO::FETCH_ASSOC);
                        $guard();
                        if ($row === false) {
                            break;
                        }
                        yield $row;
                    }
                } finally {
                    $s->closeCursor();
                }
            };
            self::versions(iterator_to_array($select('SELECT version FROM evse_schema_versions ORDER BY version LIMIT 3')), true);
            $time = iterator_to_array($select('SELECT UTC_TIMESTAMP(6) AS server_now'));
            if (count($time) !== 1 || abs(self::timestamp($time[0]['server_now'] ?? null, true) - (float) $now->format('U.u')) > 10) {
                throw new \UnexpectedValueException('Invalid archive clock');
            }
            $now = (new \DateTimeImmutable('@' . (int) self::timestamp($time[0]['server_now'], true)));
            $state = iterator_to_array($select('SELECT algorithm_version, sample_cursor, sample_highwater, samples_done, events_done, updated_at, initialized, event_cursor_at, event_highwater_at, HEX(event_cursor_id) AS event_cursor_id, HEX(event_highwater_id) AS event_highwater_id, invalidate_from, invalidate_cursor FROM evse_history_state WHERE source = CAST(? AS BINARY) LIMIT 2', [$c->prefix]));
            if (count($state) !== 1 || $state[0]['algorithm_version'] !== '1' ||
                !in_array($state[0]['samples_done'], ['0', '1'], true) || !in_array($state[0]['events_done'], ['0', '1'], true) ||
                !in_array($state[0]['initialized'] ?? null, ['0', '1'], true)) {
                throw new \UnexpectedValueException('Archive not initialized');
            }
            foreach (['sample_cursor', 'sample_highwater'] as $key) {
                if (!is_string($state[0][$key]) || !preg_match('/\A(?:0|[1-9][0-9]{0,19})\z/D', $state[0][$key]) ||
                    (strlen($state[0][$key]) === 20 && strcmp($state[0][$key], '18446744073709551615') > 0)) {
                    throw new \UnexpectedValueException('Invalid archive progress');
                }
            }
            $cursor = $state[0]['sample_cursor'];
            $high = $state[0]['sample_highwater'];
            if (strlen($cursor) > strlen($high) || (strlen($cursor) === strlen($high) && strcmp($cursor, $high) > 0) ||
                ($state[0]['samples_done'] === '1' && $cursor !== $high) || self::timestamp($state[0]['updated_at'], true) > $now->getTimestamp() + 5) {
                throw new \UnexpectedValueException('Invalid archive progress');
            }
            $progress = ['samples_done' => $state[0]['samples_done'] === '1', 'events_done' => $state[0]['events_done'] === '1'];
            $s = $state[0];
            $eventTimes = [];
            foreach (['event_cursor_at', 'event_highwater_at'] as $key) {
                if (self::timestamp($s[$key] ?? null, true) > $now->getTimestamp() + 5) {
                    throw new \UnexpectedValueException('Future event progress');
                }
                // Compare canonical date strings, not float timestamps: retain
                // microsecond ordering even near the supported date limits.
                $eventTimes[$key] = strlen($s[$key]) === 19 ? $s[$key] . '.000000' : $s[$key];
            }
            foreach (['event_cursor_id', 'event_highwater_id'] as $key) {
                if (!is_string($s[$key] ?? null) || !preg_match('/\A[0-9A-Fa-f]{32}\z/D', $s[$key])) {
                    throw new \UnexpectedValueException('Invalid event progress');
                }
                $s[$key] = strtoupper($s[$key]);
            }
            // UUID order is traversal evidence only, never event chronology.
            $eventOrder = strcmp($eventTimes['event_cursor_at'], $eventTimes['event_highwater_at']);
            $eventsScanned = $eventOrder > 0 || ($eventOrder === 0 && strcmp($s['event_cursor_id'], $s['event_highwater_id']) >= 0);
            $invalid = [];
            foreach (['invalidate_from', 'invalidate_cursor'] as $key) {
                if (!array_key_exists($key, $s)) { throw new \UnexpectedValueException('Missing invalidation state'); }
                // Validate minute alignment as text before float conversion:
                // microseconds near the year-1000 SQL epoch can round away.
                if ($s[$key] !== null && (!is_string($s[$key]) ||
                    !preg_match('/\A[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:00(?:\.000000)?\z/D', $s[$key]))) {
                    throw new \UnexpectedValueException('Invalid invalidation boundary');
                }
                $invalid[$key] = $s[$key] === null ? null : self::timestamp($s[$key], true);
                if ($invalid[$key] !== null && (floor($invalid[$key]) !== $invalid[$key] || (int) $invalid[$key] % 60 !== 0 ||
                    $invalid[$key] > $now->getTimestamp() + 5)) {
                    throw new \UnexpectedValueException('Invalid invalidation boundary');
                }
            }
            $invalidateFrom = $invalid['invalidate_from'];
            if (($invalid['invalidate_cursor'] !== null && ($invalidateFrom === null || $invalid['invalidate_cursor'] < $invalidateFrom)) ||
                ($progress['events_done'] && ($invalidateFrom !== null || $invalid['invalidate_cursor'] !== null || !$eventsScanned))) {
                throw new \UnexpectedValueException('Inconsistent invalidation state');
            }
            // initialized alone precedes backfill. Only completed initial
            // cursors permit range-local readiness during later invalidations.
            $initialDone = $s['initialized'] === '1' && $progress['samples_done'] && $cursor === $high && $eventsScanned;
            $ready = $initialDone && ($progress['events_done'] || $invalidateFrom !== null);
            // Long custom selections use minute edges and whole UTC hours in the interior.
            $start = $range->from->getTimestamp();
            $end = min($range->to->getTimestamp(), $now->getTimestamp());
            $segments = [];
            if ($range->resolution() === 60) {
                $segments[] = [60, $start, $end];
            } else {
                $remainder = ($start % 3600 + 3600) % 3600;
                $left = min($end, $start + ($remainder === 0 ? 0 : 3600 - $remainder));
                $right = max($left, $end - ($end % 3600 + 3600) % 3600);
                if ($left > $start) { $segments[] = [60, $start, $left]; }
                if ($right > $left) { $segments[] = [3600, $left, $right]; }
                if ($end > $right) { $segments[] = [60, $right, $end]; }
            }
            $dirty = [];
            foreach ($segments as [$resolution, $a, $b]) {
                $params = [$c->prefix, (string) $resolution, gmdate('Y-m-d H:i:s', $a - $resolution + 1), gmdate('Y-m-d H:i:s', $b)];
                // source,pending,resolution_seconds,bucket_start is the storage-owned covering index.
                foreach ($select('SELECT bucket_start, resolution_seconds FROM evse_history_work WHERE source = CAST(? AS BINARY) AND pending = 1 AND resolution_seconds = ? AND bucket_start >= ? AND bucket_start < ? ORDER BY bucket_start LIMIT 10001', $params) as $row) {
                    if (count($dirty) >= 10000) { throw new \UnexpectedValueException('Dirty history overflow'); }
                    $t = self::timestamp($row['bucket_start'] ?? null, true);
                    if (($row['resolution_seconds'] ?? null) !== (string) $resolution || (int) $t % $resolution !== 0 || floor($t) !== $t) {
                        throw new \UnexpectedValueException('Invalid dirty bucket');
                    }
                    $dirty[] = [$t, $t + $resolution];
                }
            }
            // Dirty child minutes are evidence even before parent-hour work has been published.
            if ($range->resolution() === 3600) {
                foreach ($select('SELECT bucket_start FROM evse_history_work WHERE source = CAST(? AS BINARY) AND pending = 1 AND resolution_seconds = 60 AND bucket_start >= ? AND bucket_start < ? ORDER BY bucket_start LIMIT 10001',
                    [$c->prefix, gmdate('Y-m-d H:i:s', $start - 59), gmdate('Y-m-d H:i:s', $end)]) as $row) {
                    if (count($dirty) >= 10000) { throw new \UnexpectedValueException('Dirty history overflow'); }
                    $t = self::timestamp($row['bucket_start'] ?? null, true);
                    if (floor($t) !== $t || (int) $t % 60 !== 0) { throw new \UnexpectedValueException('Invalid dirty minute'); }
                    $dirty[] = [$t, $t + 60];
                }
            }
            $rows = (static function () use ($segments, $select, $c, $now): \Generator {
                foreach ($segments as [$res, $a, $b]) {
                    $last = null;
                    do {
                        // Small keyset pages avoid keeping a server statement open
                        // while PHP validates an entire year. All pages still share
                        // the same read-only snapshot, row/byte and total-time caps.
                        $sql = 'SELECT resolution_seconds, bucket_start, SUBSTRING(CAST(data_json AS BINARY),1,65537) AS data_json, updated_at FROM evse_history_buckets WHERE source = CAST(? AS BINARY) AND resolution_seconds = ? AND bucket_start >= ? AND bucket_start <= ?';
                        $parameters = [$c->prefix, (string) $res, gmdate('Y-m-d H:i:s', $a), gmdate('Y-m-d H:i:s', $b - $res)];
                        if ($last !== null) {
                            $sql .= ' AND bucket_start > ?';
                            $parameters[] = $last;
                        }
                        $page = 0;
                        foreach ($select($sql . ' ORDER BY bucket_start LIMIT 256', $parameters) as $row) {
                            if (self::timestamp($row['updated_at'] ?? null, true) > $now->getTimestamp() + 5) {
                                throw new \UnexpectedValueException('Future materialization');
                            }
                            $last = $row['bucket_start'];
                            ++$page;
                            yield $row;
                        }
                    } while ($page === 256);
                }
            })();
            // Do not shorten to invalidate_cursor: already traversed jobs can
            // still be pending. Also mask jobs not yet discovered by the worker.
            if ($ready && !$progress['events_done'] && $invalidateFrom < $end) {
                $dirty[] = [max($start, $invalidateFrom), $end];
            }
            $projection = self::project($range, $rows, $dirty, $ready, $guard, (float) $now->format('U.u'));
            $result = array_replace($range->envelope('ok', $now), $projection, ['progress' => $progress]);
            $guard();
            if (strlen(json_encode($result, JSON_THROW_ON_ERROR)) > 2097152) {
                throw new \UnexpectedValueException('Archive response too large');
            }
            $guard();
            $wallElapsed = (float) (($this->clock)())->format('U.u') - $wallStarted;
            if (abs($wallElapsed - (($this->monotonic)() - $started) / 1000000000) > 5) {
                throw new \UnexpectedValueException('Archive clock changed');
            }
            $guard();
            $pdo->commit();
            $guard();
            return $result;
        } catch (\Throwable) {
            if ($pdo instanceof \PDO) {
                try { if ($pdo->inTransaction()) { $pdo->rollBack(); } } catch (\Throwable) {}
            }
            return $range->envelope('unavailable', $now);
        }
    }
}
