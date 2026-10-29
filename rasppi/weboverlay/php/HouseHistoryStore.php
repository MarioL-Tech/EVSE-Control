<?php
declare(strict_types=1);

namespace EvseOverlay;

/** Independent HOUSE registry, credentials shared with the read-only history reader. */
final class HouseHistoryStore
{
    /** SHA-256 of storage/migrations/003_house.sql; update only with that writer schema. */
    public const SCHEMA_SHA256 = 'db10ad75e9947799db2a896f3211c2c3ba6f64afa75219620630dcbb8a139391';

    private \Closure $factory;
    private \Closure $clock;
    private \Closure $monotonic;

    public function __construct(private HouseHistoryConfig $config, ?callable $factory = null, ?callable $clock = null, ?callable $monotonic = null)
    {
        $this->factory = \Closure::fromCallable($factory ?? static fn(...$args) => new \PDO(...$args));
        $this->clock = \Closure::fromCallable($clock ?? static fn() => new \DateTimeImmutable('now', new \DateTimeZone('UTC')));
        $this->monotonic = \Closure::fromCallable($monotonic ?? static fn() => hrtime(true));
    }

    public function __debugInfo(): array { return ['enabled' => $this->config->enabled]; }

    public static function date(mixed $value): \DateTimeImmutable
    {
        if (!is_string($value) || !preg_match('/\A[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{6})?\z/D', $value)) {
            throw new \UnexpectedValueException('Invalid house timestamp');
        }
        $text = strlen($value) === 19 ? $value . '.000000' : $value;
        $date = \DateTimeImmutable::createFromFormat('!Y-m-d H:i:s.u', $text, new \DateTimeZone('UTC'));
        if ($date === false || $date->format('Y-m-d H:i:s.u') !== $text || (int) $date->format('Y') < 1970 || (int) $date->format('Y') > 9998) {
            throw new \UnexpectedValueException('Invalid house timestamp');
        }
        return $date;
    }

    public static function iso(\DateTimeImmutable $date): string
    {
        return $date->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.u\Z');
    }

    public static function uint(mixed $value, string $maximum = '9007199254740991'): string
    {
        if (!is_string($value) || !preg_match('/\A(?:0|[1-9][0-9]*)\z/D', $value) || strlen($value) > strlen($maximum) ||
            (strlen($value) === strlen($maximum) && strcmp($value, $maximum) > 0)) {
            throw new \UnexpectedValueException('Invalid house integer');
        }
        return $value;
    }

    public static function compareUint(string $left, string $right): int
    {
        return (strlen($left) <=> strlen($right)) ?: strcmp($left, $right);
    }

    public static function decimal(mixed $value, bool $sum = false): ?float
    {
        if ($value === null) { return null; }
        if (!is_string($value) || !preg_match('/\A-?[0-9]{1,' . ($sum ? 32 : 18) . '}(?:\.[0-9]{1,6})?\z/D', $value)) {
            throw new \UnexpectedValueException('Invalid house decimal');
        }
        // Compare decimal strings before conversion: JS-safe + a fraction must not round down into range.
        $absolute = ltrim($value, '-');
        [$integer, $fraction] = array_pad(explode('.', $absolute, 2), 2, '');
        $integer = ltrim($integer, '0');
        if (!$sum && (strlen($integer) > 16 || (strlen($integer) === 16 &&
            (strcmp($integer, '9007199254740991') > 0 || ($integer === '9007199254740991' && trim($fraction, '0') !== ''))))) {
            throw new \UnexpectedValueException('Unsafe house decimal');
        }
        $number = (float) $value;
        if (!is_finite($number)) { throw new \UnexpectedValueException('Invalid house decimal'); }
        return $number;
    }

    public static function flag(mixed $value): bool
    {
        return match ($value) { '0', 0 => false, '1', 1 => true, default => throw new \UnexpectedValueException('Invalid house flag') };
    }

    private static function onlineAfter(array $event, ?bool $online): ?bool
    {
        $retained = self::flag($event['retained']);
        if ($event['kind'] === 'availability') {
            return $retained ? null : $event['availability'] === 'online';
        }
        // A bounded loss marker breaks one edge but does not claim that the
        // broker is offline. Other lifecycle transitions need a fresh online.
        if ($online === null) { return null; }
        return $event['kind'] === 'ingestion_gap' && !$retained ? $online : false;
    }

    public static function envelope(int|HistoryRange $query, string $status, ?\DateTimeImmutable $now = null): array
    {
        $now ??= new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $reason = match ($status) { 'ok' => 'Hausverlauf', 'disabled' => 'Hausverlauf ist deaktiviert', default => 'Hausverlauf ist nicht verfügbar' };
        if ($query instanceof HistoryRange) { return array_replace($query->envelope($status, $now), ['reason' => $reason]); }
        if (!in_array($query, [1, 5, 15], true)) { throw new \InvalidArgumentException('Invalid house query'); }
        return ['schema_version' => 1, 'read_only' => true, 'status' => $status, 'reason' => $reason,
            'generated_at' => self::iso($now), 'minutes' => $query,
            'range' => ['from' => self::iso($now->modify('-' . $query . ' minutes')), 'to' => self::iso($now)],
            'complete' => false, 'samples' => []];
    }

    /** Bounded unbuffered prepared reads in one read-only snapshot. No global schema dependency. */
    public function read(int|HistoryRange $query, callable $project): array
    {
        $now = ($this->clock)();
        if (!$this->config->enabled) { return self::envelope($query, 'disabled', $now); }
        $pdo = null;
        $settings = [];
        try {
            $started = ($this->monotonic)();
            $guard = function () use ($started): void {
                if (($this->monotonic)() - $started >= 3000000000) { throw new \RuntimeException('House history deadline'); }
            };
            $guard();
            $c = $this->config;
            // mysqlnd's read timeout is independent of PDO's connection timeout.
            foreach (['mysqlnd.net_read_timeout', 'default_socket_timeout'] as $setting) {
                $old = ini_set($setting, '2');
                if ($old === false) { throw new \RuntimeException('House driver timeout unavailable'); }
                $settings[$setting] = $old;
            }
            $pdo = ($this->factory)("mysql:host={$c->host};port={$c->port};dbname={$c->database};charset=utf8mb4", $c->username, $c->password(),
                [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION, \PDO::ATTR_EMULATE_PREPARES => false,
                    \PDO::ATTR_STRINGIFY_FETCHES => true, \PDO::ATTR_TIMEOUT => 2, \PDO::MYSQL_ATTR_USE_BUFFERED_QUERY => false]);
            $guard();
            foreach (['SET SESSION max_statement_time=1', "SET time_zone='+00:00'", 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
                'SET TRANSACTION READ ONLY', 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY'] as $sql) {
                $guard(); $pdo->exec($sql); $guard();
            }
            $rowsRead = 0; $bytesRead = 0;
            $select = static function (string $sql, array $parameters = []) use ($pdo, $guard, &$rowsRead, &$bytesRead): array {
                $guard(); $s = $pdo->prepare($sql); $guard(); $s->execute($parameters); $guard();
                $rows = [];
                try {
                    while (($row = $s->fetch(\PDO::FETCH_ASSOC)) !== false) {
                        $guard(); ++$rowsRead; $bytesRead += strlen(serialize($row));
                        if ($rowsRead > 10000 || $bytesRead > 33554432) { throw new \UnexpectedValueException('House input bound'); }
                        $rows[] = $row;
                    }
                } finally { $s->closeCursor(); }
                $guard(); return $rows;
            };
            $version = $select('SELECT version, HEX(checksum) AS checksum, applied_at FROM evse_house_schema_versions ORDER BY version LIMIT 2');
            if (count($version) !== 1 || $version[0]['version'] !== '1' || !is_string($version[0]['checksum']) ||
                !hash_equals(self::SCHEMA_SHA256, strtolower($version[0]['checksum']))) {
                throw new \UnexpectedValueException('Unsupported house schema');
            }
            self::date($version[0]['applied_at']);
            self::shape($select);
            $time = $select('SELECT UTC_TIMESTAMP(6) AS server_now');
            $server = self::date($time[0]['server_now'] ?? null);
            if (abs((float) $server->format('U.u') - (float) $now->format('U.u')) > 10) { throw new \UnexpectedValueException('House clock mismatch'); }
            $result = array_replace(self::envelope($query, 'ok', $server), $project($select, $c->prefix, $server, $guard));
            $guard();
            if (strlen(json_encode($result, JSON_THROW_ON_ERROR)) > ($query instanceof HistoryRange ? 2097152 : 1048576)) {
                throw new \UnexpectedValueException('House output bound');
            }
            if (abs((float) (($this->clock)())->format('U.u') - (float) $now->format('U.u') - (($this->monotonic)() - $started) / 1e9) > 5) {
                throw new \UnexpectedValueException('House clock changed');
            }
            $guard(); $pdo->commit(); $guard(); return $result;
        } catch (\Throwable) {
            if ($pdo instanceof \PDO) { try { if ($pdo->inTransaction()) { $pdo->rollBack(); } } catch (\Throwable) {} }
            return self::envelope($query, 'unavailable', $now);
        } finally {
            foreach ($settings as $setting => $old) { ini_set($setting, $old); }
        }
    }

    private static function shape(callable $select): void
    {
        $tables = [
            'evse_house_schema_versions' => ['version','checksum','applied_at'],
            'evse_house_samples' => ['id','source','publisher_id','sequence','fetched_at','received_at','status','last_success_at','power_w','error_code','retained','digest'],
            'evse_house_events' => ['id','source','event_id','kind','received_at','retained','availability','details'],
            'evse_house_buckets' => ['source','level','bucket_start','bucket_end','samples','valid_count','null_count','sum_w','min_w','max_w','first_w','last_w','first_at','last_at','coverage_ms','has_gap','complete'],
            'evse_house_work' => ['source','level','bucket_start','generation','processed_generation','pending'],
        ];
        $rows = $select("SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, DATETIME_PRECISION, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('evse_house_schema_versions','evse_house_samples','evse_house_events','evse_house_buckets','evse_house_work') ORDER BY TABLE_NAME, ORDINAL_POSITION");
        $seen = [];
        foreach ($rows as $r) {
            $table = $r['TABLE_NAME']; $column = $r['COLUMN_NAME']; $type = strtolower($r['COLUMN_TYPE']);
            $seen[$table][] = $column;
            $expected = match ($column) {
                'source' => 'varbinary(240)', 'publisher_id', 'event_id' => 'binary(16)', 'digest', 'checksum' => 'binary(32)',
                'id', 'samples', 'valid_count', 'null_count', 'coverage_ms', 'generation', 'processed_generation' => 'bigint unsigned',
                'sequence' => 'int unsigned', 'version' => 'int', 'retained', 'pending', 'has_gap', 'complete' => 'tinyint',
                'power_w','min_w','max_w','first_w','last_w' => 'decimal(24,6)', 'sum_w' => 'decimal(38,6)',
                'level' => "enum('minute','hour','day')", 'status' => "enum('ok','error')", 'availability' => "enum('online','offline')",
                'kind' => "enum('availability','collector_started','broker_connected','broker_disconnected','ingestion_gap','collector_stopping')",
                'error_code' => "enum('read_failed','startup','stale','clock_error')", 'details' => 'varchar(1024)', default => null,
            };
            $type = preg_replace('/\b(bigint|int|tinyint)\([0-9]+\)/', '$1', $type);
            $nullable = in_array($column, ['last_success_at','power_w','error_code','availability','sum_w','min_w','max_w','first_w','last_w','first_at','last_at'], true);
            if (($r['IS_NULLABLE'] === 'YES') !== $nullable || ($expected !== null && $type !== $expected) ||
                (in_array($column, ['applied_at','fetched_at','received_at','last_success_at','bucket_start','bucket_end','first_at','last_at'], true) &&
                    ($r['DATA_TYPE'] !== 'datetime' || (string) $r['DATETIME_PRECISION'] !== '6'))) {
                throw new \UnexpectedValueException('Invalid house column');
            }
        }
        foreach ($tables as $table => $columns) {
            $actual = $seen[$table] ?? []; sort($actual); sort($columns);
            if ($actual !== $columns) { throw new \UnexpectedValueException('Invalid house table shape'); }
        }
        $engines = $select("SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('evse_house_schema_versions','evse_house_samples','evse_house_events','evse_house_buckets','evse_house_work')");
        if (count($engines) !== 5) { throw new \UnexpectedValueException('Invalid house tables'); }
        foreach ($engines as $table) {
            if (strtolower($table['ENGINE'] ?? '') !== 'innodb') { throw new \UnexpectedValueException('Nontransactional house table'); }
        }
        $indexes = $select("SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('evse_house_schema_versions','evse_house_samples','evse_house_events','evse_house_buckets','evse_house_work') ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX");
        $keys = [];
        foreach ($indexes as $index) {
            $key = $index['TABLE_NAME'] . ':' . $index['INDEX_NAME'];
            $keys[$key]['table'] = $index['TABLE_NAME'];
            $keys[$key]['unique'] = $index['NON_UNIQUE'] === '0';
            $keys[$key]['columns'][] = $index['COLUMN_NAME'];
        }
        foreach ([
            ['evse_house_schema_versions', ['version'], true], ['evse_house_samples', ['id'], true],
            ['evse_house_samples', ['source','publisher_id','sequence'], true], ['evse_house_samples', ['source','fetched_at','id'], false],
            ['evse_house_events', ['id'], true], ['evse_house_events', ['source','event_id'], true],
            ['evse_house_events', ['source','received_at','id'], false], ['evse_house_buckets', ['source','level','bucket_start'], true],
            ['evse_house_work', ['source','level','bucket_start'], true], ['evse_house_work', ['source','pending','level','bucket_start'], false],
        ] as [$table, $columns, $unique]) {
            $found = false;
            foreach ($keys as $index) {
                if ($index['table'] === $table && $index['columns'] === $columns && (!$unique || $index['unique'])) { $found = true; break; }
            }
            if (!$found) { throw new \UnexpectedValueException('Missing house access index'); }
        }
    }

    /** Pure projection retains errors and uses receipt events as edge barriers. */
    public static function project(array $rows, array $events, array $baselines, \DateTimeImmutable $from, \DateTimeImmutable $to): array
    {
        $complete = count($rows) <= 1200 && count($events) <= 2400;
        $rows = array_slice($rows, 0, 1200); $events = array_slice($events, 0, 2400);
        foreach (array_merge($events, $baselines) as $event) {
            self::uint($event['id'], '18446744073709551615');
            self::date($event['received_at']); self::flag($event['retained']);
            if (!in_array($event['kind'], ['availability','collector_started','broker_connected','broker_disconnected','ingestion_gap','collector_stopping'], true) ||
                !in_array($event['availability'], [null,'online','offline'], true) || ($event['kind'] === 'availability' && $event['availability'] === null)) {
                throw new \UnexpectedValueException('Invalid house event');
            }
        }
        foreach ($events as $event) {
            $at = self::date($event['received_at']);
            // Event context spans the maximum permitted fetch/receipt offset.
            if ($at < $from->modify('-10 seconds') || $at > $to->modify('+10 seconds')) { $complete = false; }
        }
        $online = null;
        if (isset($baselines[0]) && (!isset($baselines[1]) || $baselines[0]['received_at'] !== $baselines[1]['received_at'])) {
            // The query supplies the two latest rows in descending order. Two
            // distinct rows are enough for a latest availability followed by
            // one loss marker; anything older remains conservatively unknown.
            foreach (array_reverse($baselines) as $base) {
                if (self::date($base['received_at']) >= $from) { throw new \UnexpectedValueException('Invalid house baseline'); }
                $online = self::onlineAfter($base, $online);
            }
        }
        usort($rows, static fn($a, $b) => self::compareUint($a['id'], $b['id']));
        $prior = null;
        foreach ($rows as $row) {
            self::uint($row['id'], '18446744073709551615');
            $at = self::date($row['fetched_at']); $receipt = self::date($row['received_at']);
            // The requested window bounds HTTP fetch times, not the independent
            // collector receipt clock. A small transport/clock offset must not
            // turn the entire otherwise valid response into isolated points.
            if ($at < $from || $at > $to || abs((float) $at->format('U.u') - (float) $receipt->format('U.u')) > 10 ||
                ($prior !== null && ($at <= $prior[0] || $receipt < $prior[1]))) { $complete = false; }
            $prior = [$at, $receipt];
        }
        usort($rows, static fn($a, $b) => strcmp($a['fetched_at'], $b['fetched_at']) ?:
            strcmp($a['received_at'], $b['received_at']) ?: self::compareUint($a['id'], $b['id']));
        // IDs make output deterministic but never establish the order of
        // lifecycle events carrying the same reception timestamp.
        usort($events, static fn($a, $b) => strcmp($a['received_at'], $b['received_at']) ?:
            self::compareUint($a['id'], $b['id']));
        $samples = []; $previous = null; $barrier = 0; $index = 0;
        foreach ($rows as $row) {
            $at = self::date($row['fetched_at']); $receipt = self::date($row['received_at']);
            $ambiguous = false;
            while (isset($events[$index]) && self::date($events[$index]['received_at']) <= $receipt) {
                $eventTime = $events[$index]['received_at'];
                $group = [];
                do { $group[] = $events[$index++]; }
                while (isset($events[$index]) && $events[$index]['received_at'] === $eventTime);
                $ambiguous = $ambiguous || self::date($group[0]['received_at']) === $receipt;
                // A unique online refresh preserves a known online state.
                // Reconnects, losses and ambiguous groups still break edges;
                // same-timestamp IDs never prove lifecycle ordering.
                $nextOnline = count($group) === 1 ? self::onlineAfter($group[0], $online) : null;
                $refresh = count($group) === 1 && $online === true && $nextOnline === true
                    && $group[0]['kind'] === 'availability' && !self::flag($group[0]['retained']);
                if (!$refresh) { ++$barrier; }
                $online = $nextOnline;
            }
            $power = self::decimal($row['power_w']);
            $sequence = (int) self::uint($row['sequence'], '4294967295');
            if ($sequence < 1 || !is_string($row['publisher_id']) || strlen($row['publisher_id']) !== 16 ||
                !in_array($row['status'], ['ok','error'], true) ||
                ($row['status'] === 'ok' && ($power === null || $row['last_success_at'] !== $row['fetched_at'] || $row['error_code'] !== null)) ||
                ($row['status'] === 'error' && ($power !== null || !in_array($row['error_code'], ['read_failed','startup','stale','clock_error'], true)))) {
                throw new \UnexpectedValueException('Invalid house observation');
            }
            // A clock_error can legitimately precede the last successful fetch.
            if ($row['last_success_at'] !== null) { self::date($row['last_success_at']); }
            $eligible = $online === true && !$ambiguous && !self::flag($row['retained']) && $row['status'] === 'ok';
            $break = !$complete || !$eligible || $previous === null || !$previous['eligible'] || $barrier !== $previous['barrier'] ||
                $previous['publisher'] !== $row['publisher_id'] || $previous['sequence'] + 1 !== $sequence ||
                $at <= $previous['at'] || (float) $at->format('U.u') - (float) $previous['at']->format('U.u') > 10 ||
                $receipt < $previous['receipt'] || (float) $receipt->format('U.u') - (float) $previous['receipt']->format('U.u') > 10;
            $samples[] = ['id' => $row['id'], 'timestamp' => self::iso($at), 'received_at' => self::iso($receipt),
                'status' => $row['status'], 'power_w' => $power, 'break_before' => $break];
            $previous = ['at' => $at, 'receipt' => $receipt, 'publisher' => $row['publisher_id'], 'sequence' => $sequence, 'eligible' => $eligible, 'barrier' => $barrier];
        }
        return ['complete' => $complete, 'samples' => $samples];
    }

    public function snapshot(int $minutes = 15): array
    {
        return $this->read($minutes, static function ($select, $prefix, $now) use ($minutes): array {
            $from = $now->modify('-' . $minutes . ' minutes');
            $parameters = [$prefix, $from->format('Y-m-d H:i:s.u'), $now->format('Y-m-d H:i:s.u')];
            $rows = $select('SELECT id, publisher_id, sequence, fetched_at, received_at, status, last_success_at, power_w, error_code, retained FROM evse_house_samples FORCE INDEX (sample_time) WHERE source = CAST(? AS BINARY) AND fetched_at >= ? AND fetched_at <= ? ORDER BY fetched_at DESC, id DESC LIMIT 1201', $parameters);
            $columns = 'id, kind, received_at, retained, availability';
            $eventParameters = [$prefix, $from->modify('-10 seconds')->format('Y-m-d H:i:s.u'), $now->modify('+10 seconds')->format('Y-m-d H:i:s.u')];
            $events = $select('SELECT ' . $columns . ' FROM evse_house_events FORCE INDEX (event_time) WHERE source = CAST(? AS BINARY) AND received_at >= ? AND received_at <= ? ORDER BY received_at DESC, id DESC LIMIT 2401', $eventParameters);
            $bases = $select('SELECT ' . $columns . ' FROM evse_house_events FORCE INDEX (event_time) WHERE source = CAST(? AS BINARY) AND received_at < ? ORDER BY received_at DESC, id DESC LIMIT 2', [$prefix, $eventParameters[1]]);
            return self::project($rows, $events, $bases, $from, $now);
        });
    }
}
