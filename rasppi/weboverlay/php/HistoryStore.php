<?php
declare(strict_types=1);

namespace EvseOverlay;

final class HistoryStore
{
    private \Closure $factory;
    private \Closure $clock;
    private \Closure $monotonic;

    public function __construct(private HistoryConfig $config, ?callable $pdoFactory = null, ?callable $clock = null, ?callable $monotonic = null)
    {
        $this->factory = \Closure::fromCallable($pdoFactory ?? static fn(string $dsn, string $user, string $password, array $options): \PDO =>
            new \PDO($dsn, $user, $password, $options));
        $this->clock = \Closure::fromCallable($clock ?? static fn(): float => microtime(true));
        // Monotonic clock returns nanoseconds, matching hrtime(true).
        $this->monotonic = \Closure::fromCallable($monotonic ?? static fn(): int => hrtime(true));
    }

    public function __debugInfo(): array { return ['enabled' => $this->config->enabled]; }

    public static function parseMinutes(string $rawQuery): int
    {
        if ($rawQuery === '') {
            return 15;
        }
        if (strlen($rawQuery) > 128 || !preg_match('/\Aminutes=(1|5|15)\z/D', $rawQuery, $match)) {
            throw new \InvalidArgumentException('Invalid history query');
        }
        return (int) $match[1];
    }

    private static function minutes(int $minutes): void
    {
        if (!in_array($minutes, [1, 5, 15], true)) {
            throw new \InvalidArgumentException('Invalid history window');
        }
    }

    private static function iso(int $micros): string
    {
        $seconds = intdiv($micros, 1000000);
        $fraction = $micros % 1000000;
        if ($fraction < 0) {
            --$seconds;
            $fraction += 1000000;
        }
        return gmdate('Y-m-d\TH:i:s', $seconds) . sprintf('.%06dZ', $fraction);
    }

    private static function envelope(int $minutes, string $status, int $now): array
    {
        self::minutes($minutes);
        return ['schema_version' => 1, 'read_only' => true, 'status' => $status,
            'reason' => match ($status) {
                'ok' => 'Historische Wallbox-Messdaten',
                'disabled' => 'SQL-Verlauf ist deaktiviert',
                default => 'SQL-Verlauf ist nicht verfügbar',
            },
            'generated_at' => self::iso($now), 'minutes' => $minutes,
            'range' => ['from' => self::iso($now - $minutes * 60000000), 'to' => self::iso($now)],
            'complete' => false, 'samples' => []];
    }

    public static function failure(int $minutes = 15): array
    {
        return self::envelope($minutes, 'unavailable', (int) floor(microtime(true) * 1000000));
    }

    private static function date(mixed $value): int
    {
        if (!is_string($value) || !preg_match('/\A([0-9]{4})-([0-9]{2})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{6}))?\z/D', $value, $m) ||
            (int) $m[1] < 1000 || !checkdate((int) $m[2], (int) $m[3], (int) $m[1]) ||
            (int) $m[4] > 23 || (int) $m[5] > 59 || (int) $m[6] > 59) {
            throw new \UnexpectedValueException('Invalid history date');
        }
        $date = \DateTimeImmutable::createFromFormat('!Y-m-d H:i:s.u', substr($value, 0, 19) . '.' . ($m[7] ?? '000000'), new \DateTimeZone('UTC'));
        if ($date === false) {
            throw new \UnexpectedValueException('Invalid history date');
        }
        return $date->getTimestamp() * 1000000 + (int) ($m[7] ?? '0');
    }

    private static function id(mixed $value): string
    {
        if (!is_string($value) || !preg_match('/\A(?:0|[1-9][0-9]{0,19})\z/D', $value) ||
            (strlen($value) === 20 && strcmp($value, '18446744073709551615') > 0)) {
            throw new \UnexpectedValueException('Invalid history identifier');
        }
        return $value;
    }

    private static function compareId(string $a, string $b): int
    {
        return (strlen($a) <=> strlen($b)) ?: strcmp($a, $b);
    }

    private static function boolean(mixed $value): ?bool
    {
        return match ($value) {
            null => null, '0', 0 => false, '1', 1 => true,
            default => throw new \UnexpectedValueException('Invalid history boolean'),
        };
    }

    private static function uint(mixed $value): ?int
    {
        if ($value === null) {
            return null;
        }
        if (!is_string($value) || !preg_match('/\A(?:0|[1-9][0-9]{0,9})\z/D', $value) ||
            (strlen($value) === 10 && strcmp($value, '4294967295') > 0)) {
            throw new \UnexpectedValueException('Invalid history unsigned measurement');
        }
        return (int) $value;
    }

    private static function decimal(mixed $value, int $scale): ?float
    {
        if ($value === null) {
            return null;
        }
        if (!is_string($value) || !preg_match('/\A[0-9]{1,' . (14 - $scale) . '}(?:\.[0-9]{1,' . $scale . '})?\z/D', $value) ||
            !is_finite((float) $value)) {
            throw new \UnexpectedValueException('Invalid history decimal');
        }
        return (float) $value;
    }

    private static function sample(array $row): array
    {
        foreach (['id', 'measured_at', 'received_at', 'retained', 'status', 'error_code', 'socket_lock_state',
            'charging_state_raw', 'charging_state', 'below_commanded_current', 'plugged_in', 'charging',
            'current_limit_a', 'current_l1_a', 'current_l2_a', 'current_l3_a', 'voltage_l1_v', 'voltage_l2_v',
            'voltage_l3_v', 'active_power_w', 'session_energy_wh'] as $key) {
            if (!array_key_exists($key, $row)) {
                throw new \UnexpectedValueException('Missing history field');
            }
        }
        if (!in_array($row['status'], ['ok', 'error'], true) || $row['retained'] === null) {
            throw new \UnexpectedValueException('Invalid history state');
        }
        $values = [];
        foreach (['error_code', 'socket_lock_state', 'charging_state_raw', 'charging_state', 'active_power_w', 'session_energy_wh'] as $key) {
            $values[$key] = self::uint($row[$key]);
        }
        foreach (['below_commanded_current', 'plugged_in', 'charging'] as $key) {
            $values[$key] = self::boolean($row[$key]);
        }
        $values['current_limit_a'] = self::decimal($row['current_limit_a'], 3);
        $values['current_a'] = array_map(static fn(string $key): ?float => self::decimal($row[$key], 3), ['current_l1_a', 'current_l2_a', 'current_l3_a']);
        $values['voltage_v'] = array_map(static fn(string $key): ?float => self::decimal($row[$key], 1), ['voltage_l1_v', 'voltage_l2_v', 'voltage_l3_v']);
        $measured = self::date($row['measured_at']);
        $received = self::date($row['received_at']);
        return ['id' => self::id($row['id']), 'timestamp' => self::iso($measured), 'received_at' => self::iso($received),
            'status' => $row['status'], 'values' => $row['status'] === 'ok' ? $values : null,
            'break_before' => true, '_m' => $measured, '_r' => $received, '_retained' => self::boolean($row['retained'])];
    }

    private static function event(array $row): array
    {
        if (!isset($row['kind'], $row['received_at'], $row['event_id']) ||
            !is_string($row['event_id']) || strlen($row['event_id']) !== 16 ||
            !array_key_exists('availability', $row) || !isset($row['retained']) ||
            !in_array($row['kind'], ['availability', 'collector_started', 'broker_connected', 'broker_disconnected', 'ingestion_gap', 'collector_stopping'], true) ||
            !in_array($row['availability'], [null, 'online', 'offline'], true) ||
            ($row['kind'] === 'availability' && $row['availability'] === null)) {
            throw new \UnexpectedValueException('Invalid history event');
        }
        $retained = self::boolean($row['retained']);
        return ['time' => self::date($row['received_at']), 'kind' => $row['kind'],
            'online' => $row['kind'] === 'availability' && $row['availability'] === 'online' && $retained === false,
            'id' => $row['event_id']];
    }

    /** Pure projection for isolated tests. Inputs are bounded PDO-style rows, dates are SQL UTC. */
    public static function project(array $rows, array $events, ?array $baseline, string $from, string $to): array
    {
        $start = self::date($from);
        $end = self::date($to);
        if ($end < $start) {
            throw new \UnexpectedValueException('Invalid history range');
        }
        $complete = count($rows) <= 1200 && count($events) <= 2400;
        $rows = array_map(self::sample(...), array_slice($rows, 0, 1200));
        // Auto-increment order detects clock rollback before chronological sorting can conceal it.
        usort($rows, static fn(array $a, array $b): int => self::compareId($a['id'], $b['id']));
        $previous = null;
        foreach ($rows as $row) {
            if ($row['_m'] < $start || $row['_m'] > $end || $row['_r'] < $start || $row['_r'] > $end ||
                abs($row['_r'] - $row['_m']) > 10000000 ||
                ($previous !== null && ($row['_m'] < $previous['_m'] || $row['_r'] < $previous['_r'] || $row['id'] === $previous['id']))) {
                $complete = false;
            }
            $previous = $row;
        }
        $events = array_map(self::event(...), array_slice($events, 0, 2400));
        foreach ($events as $event) {
            if ($event['time'] < $start || $event['time'] > $end) {
                $complete = false;
            }
        }
        usort($events, static fn(array $a, array $b): int => ($a['time'] <=> $b['time']) ?: strcmp($a['id'], $b['id']));
        foreach ($events as $i => $event) {
            if ($i > 0 && $event['time'] === $events[$i - 1]['time'] &&
                (!$event['online'] || !$events[$i - 1]['online'])) {
                // UUID ordering cannot establish the real order of simultaneous lifecycle events.
                $complete = false;
            }
        }
        $online = false;
        if ($baseline !== null) {
            $base = self::event($baseline);
            if ($base['time'] >= $start) {
                $complete = false;
            } else {
                $online = $base['online'];
            }
        }
        usort($rows, static fn(array $a, array $b): int => ($a['_m'] <=> $b['_m']) ?: ($a['_r'] <=> $b['_r']) ?: self::compareId($a['id'], $b['id']));
        $index = 0;
        $barrier = 0;
        $previous = null;
        $previousOnline = false;
        $previousBarrier = -1;
        foreach ($rows as &$row) {
            $ambiguous = false;
            while (isset($events[$index]) && $events[$index]['time'] <= $row['_r']) {
                $event = $events[$index++];
                // Equal receipt timestamps carry no cross-table ordering guarantee.
                $ambiguous = $ambiguous || $event['time'] === $row['_r'];
                if (!$event['online']) {
                    ++$barrier;
                    $online = false;
                } else {
                    $online = true;
                }
            }
            $eligible = $online && !$ambiguous && !$row['_retained'] && $row['status'] === 'ok';
            $row['break_before'] = !$complete || !$eligible || !$previousOnline || $previous === null ||
                $previousBarrier !== $barrier || $row['_m'] - $previous['_m'] < 0 || $row['_m'] - $previous['_m'] > 10000000 ||
                $row['_r'] - $previous['_r'] < 0 || $row['_r'] - $previous['_r'] > 10000000;
            $previous = $row;
            $previousOnline = $eligible;
            $previousBarrier = $barrier;
        }
        unset($row);
        $samples = array_map(static function (array $row): array {
            unset($row['_m'], $row['_r'], $row['_retained']);
            return $row;
        }, $rows);
        return ['complete' => $complete, 'samples' => $samples];
    }

    public function snapshot(int $minutes = 15): array
    {
        self::minutes($minutes);
        $now = (int) floor(($this->clock)() * 1000000);
        if (!$this->config->enabled) {
            return self::envelope($minutes, 'disabled', $now);
        }
        $pdo = null;
        try {
            $deadline = ($this->monotonic)() + 3000000000;
            $guard = function () use ($deadline): void {
                if (($this->monotonic)() >= $deadline) {
                    throw new \RuntimeException('History time budget exceeded');
                }
            };
            // Cooperative total budget: DNS and an already-running driver call cannot be
            // interrupted here. Driver timeouts still apply; no further work starts on expiry.
            $c = $this->config;
            $guard();
            $pdo = ($this->factory)("mysql:host={$c->host};port={$c->port};dbname={$c->database};charset=utf8mb4",
                $c->username, $c->password(), [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
                    \PDO::ATTR_EMULATE_PREPARES => false, \PDO::ATTR_STRINGIFY_FETCHES => true, \PDO::ATTR_TIMEOUT => 2]);
            $guard();
            if (!$pdo instanceof \PDO) {
                throw new \UnexpectedValueException('Invalid history connection');
            }
            $exec = static function (string $sql) use ($pdo, $guard): void {
                $guard();
                $pdo->exec($sql);
                $guard();
            };
            $exec('SET SESSION max_statement_time=1');
            $exec("SET time_zone='+00:00'");
            $exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            $exec('SET TRANSACTION READ ONLY');
            $exec('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
            $select = static function (string $sql, array $params = []) use ($pdo, $guard): array {
                $guard();
                $statement = $pdo->prepare($sql);
                $guard();
                $statement->execute($params);
                $guard();
                $rows = $statement->fetchAll(\PDO::FETCH_ASSOC);
                $guard();
                return $rows;
            };
            $version = $select('SELECT version FROM evse_schema_versions LIMIT 2');
            if (count($version) !== 1 || ($version[0]['version'] ?? null) !== '1') {
                throw new \UnexpectedValueException('Unsupported history schema');
            }
            $time = $select('SELECT UTC_TIMESTAMP(6) AS server_now');
            if (count($time) !== 1) {
                throw new \UnexpectedValueException('Invalid history clock');
            }
            $now = self::date($time[0]['server_now'] ?? null);
            $to = substr(self::iso($now), 0, -1);
            $from = substr(self::iso($now - $minutes * 60000000), 0, -1);
            $to = str_replace('T', ' ', $to);
            $from = str_replace('T', ' ', $from);
            $params = [$c->prefix, $from, $to];
            $rows = $select('SELECT id, measured_at, received_at, retained, status, error_code, socket_lock_state, charging_state_raw, charging_state, below_commanded_current, plugged_in, charging, current_limit_a, current_l1_a, current_l2_a, current_l3_a, voltage_l1_v, voltage_l2_v, voltage_l3_v, active_power_w, session_energy_wh FROM evse_wallbox_samples FORCE INDEX (source_measurement) WHERE source = CAST(? AS BINARY) AND measured_at >= ? AND measured_at <= ? ORDER BY measured_at DESC, id DESC LIMIT 1201', $params);
            $eventColumns = 'kind, availability, retained, received_at, event_id';
            $events = $select('SELECT ' . $eventColumns . ' FROM evse_ingest_events FORCE INDEX (source_receipt) WHERE source = CAST(? AS BINARY) AND received_at >= ? AND received_at <= ? ORDER BY received_at DESC, event_id DESC LIMIT 2401', $params);
            $baseline = $select('SELECT ' . $eventColumns . ' FROM evse_ingest_events FORCE INDEX (source_receipt) WHERE source = CAST(? AS BINARY) AND received_at < ? ORDER BY received_at DESC, event_id DESC LIMIT 2', [$c->prefix, $from]);
            $base = $baseline[0] ?? null;
            if (isset($baseline[1]) && self::date($baseline[0]['received_at']) === self::date($baseline[1]['received_at'])) {
                // Random UUID ordering does not resolve simultaneous pre-window events.
                // Coverage remains complete, but availability starts unknown until a definite event.
                $base = null;
            }
            $projection = self::project($rows, $events, $base, $from, $to);
            $guard();
            $pdo->commit();
            $result = array_replace(self::envelope($minutes, 'ok', $now), $projection);
            // Keep the HTTP body bounded even with maximal-width decimal values and identifiers.
            if (strlen(json_encode($result, JSON_THROW_ON_ERROR)) > 1048576) {
                $result['complete'] = false;
                foreach ($result['samples'] as &$sample) {
                    $sample['break_before'] = true;
                }
                unset($sample);
                while (strlen(json_encode($result, JSON_THROW_ON_ERROR)) > 1048576) {
                    $result['samples'] = array_slice($result['samples'], 100);
                }
            }
            return $result;
        } catch (\Throwable) {
            // Neither a PDO exception nor configuration, DSN, SQL or credentials cross this boundary.
            if ($pdo instanceof \PDO) {
                try {
                    if ($pdo->inTransaction()) {
                        $pdo->rollBack();
                    }
                } catch (\Throwable) {
                    // Connection loss requires no further work; closing discards the read-only transaction.
                }
            }
            return self::envelope($minutes, 'unavailable', $now);
        }
    }
}
