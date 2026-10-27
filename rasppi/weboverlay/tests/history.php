<?php
declare(strict_types=1);

require_once __DIR__ . '/../php/HistoryConfig.php';
require_once __DIR__ . '/../php/HistoryStore.php';

use EvseOverlay\HistoryConfig;
use EvseOverlay\HistoryStore;

// Explicit checks, including with zend.assertions=-1. No external server is contacted.
function historyCheck(bool $condition, string $message = 'History check failed'): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

function historyRejects(callable $operation): void
{
    try {
        $operation();
    } catch (Throwable) {
        return;
    }
    throw new RuntimeException('Expected history rejection');
}

function historyDate(int $seconds, string $fraction = '000000'): string
{
    return '2026-10-26 12:00:' . sprintf('%02d', $seconds) . '.' . $fraction;
}

function historyRow(string $id = '1', int $seconds = 2): array
{
    return ['id' => $id, 'measured_at' => historyDate($seconds), 'received_at' => historyDate($seconds),
        'retained' => '0', 'status' => 'ok', 'error_code' => '0', 'socket_lock_state' => '273',
        'charging_state_raw' => '33024', 'charging_state' => '1', 'below_commanded_current' => '0',
        'plugged_in' => '1', 'charging' => '0', 'current_limit_a' => '6.000',
        'current_l1_a' => '0.000', 'current_l2_a' => null, 'current_l3_a' => '1.250',
        'voltage_l1_v' => '230.1', 'voltage_l2_v' => '231.2', 'voltage_l3_v' => '232.3',
        'active_power_w' => '0', 'session_energy_wh' => '4294967295'];
}

function historyEvent(int $seconds, string $kind = 'availability', ?string $availability = 'online', string $retained = '0'): array
{
    return ['event_id' => str_repeat(chr($seconds + 1), 16), 'kind' => $kind, 'availability' => $availability,
        'retained' => $retained, 'received_at' => historyDate($seconds)];
}

function historyProject(array $rows, array $events = [], ?array $baseline = null): array
{
    return HistoryStore::project($rows, $events, $baseline, historyDate(0), historyDate(59));
}

function historyBreaks(array $projection): array
{
    return array_column($projection['samples'], 'break_before');
}

final class HistoryStatement extends PDOStatement
{
    public array $parameters = [];
    public function __construct(private array $rows, private ?Closure $step = null) {}
    public function execute(?array $params = null): bool
    {
        $this->parameters = $params ?? [];
        if ($this->step !== null) {
            ($this->step)('execute');
        }
        return true;
    }
    public function fetchAll(int $mode = PDO::FETCH_DEFAULT, mixed ...$args): array
    {
        historyCheck($mode === PDO::FETCH_ASSOC);
        if ($this->step !== null) {
            ($this->step)('fetch');
        }
        return $this->rows;
    }
}

final class HistoryPDO extends PDO
{
    public array $commands = [];
    public array $statements = [];
    public bool $committed = false;
    public bool $rolledBack = false;
    public ?Closure $step = null;
    public function __construct(private array $results, private bool $fail = false) {}
    public function exec(string $statement): int|false
    {
        $this->commands[] = $statement;
        if ($this->step !== null) {
            ($this->step)('exec');
        }
        if ($this->fail) {
            throw new PDOException('isolated-sensitive-marker');
        }
        return 0;
    }
    public function prepare(string $query, array $options = []): PDOStatement|false
    {
        historyCheck(count($this->results) > 0, 'Unexpected SQL query');
        $statement = new HistoryStatement(array_shift($this->results), $this->step);
        $this->statements[] = [$query, $statement];
        if ($this->step !== null) {
            ($this->step)('prepare');
        }
        return $statement;
    }
    public function inTransaction(): bool { return true; }
    public function commit(): bool { $this->committed = true; return true; }
    public function rollBack(): bool { $this->rolledBack = true; return true; }
}

$environment = ['WEB_HISTORY_ENABLED', 'HISTORY_DB_HOST', 'HISTORY_DB_PORT', 'HISTORY_DB_NAME',
    'HISTORY_DB_USERNAME', 'HISTORY_DB_PASSWORD_FILE', 'MQTT_TOPIC_PREFIX'];
$saved = [];
foreach ($environment as $key) {
    $saved[$key] = getenv($key);
    putenv($key);
}
$secret = tempnam(sys_get_temp_dir(), 'history-test-');
if ($secret === false) {
    throw new RuntimeException('Cannot create isolated test secret');
}
$cases = 0;
$test = static function (callable $operation) use (&$cases): void {
    $operation();
    ++$cases;
};
try {
    $test(static function (): void {
        historyCheck(!HistoryConfig::fromEnvironment()->enabled);
        putenv('HISTORY_DB_HOST=unsafe;dsn');
        putenv('HISTORY_DB_PORT=not-a-port');
        putenv('HISTORY_DB_PASSWORD_FILE=missing-test-secret');
        historyCheck(!HistoryConfig::fromEnvironment()->enabled);
        putenv('HISTORY_DB_HOST');
        putenv('HISTORY_DB_PORT');
        putenv('HISTORY_DB_PASSWORD_FILE');
    });
    foreach (['', 'true', '01', '2', ' 1'] as $invalid) {
        $test(static function () use ($invalid): void {
            putenv('WEB_HISTORY_ENABLED=' . $invalid);
            historyRejects(HistoryConfig::fromEnvironment(...));
        });
    }
    putenv('WEB_HISTORY_ENABLED=1');
    $test(static fn() => historyRejects(HistoryConfig::fromEnvironment(...)));
    putenv('HISTORY_DB_PASSWORD_FILE=' . $secret);
    foreach (['', "dummy\nsecond", "dummy\0", "dummy\u{2028}second", "\xFF", str_repeat('x', 4097), str_repeat('x', 4099)] as $invalid) {
        $test(static function () use ($secret, $invalid): void {
            file_put_contents($secret, $invalid);
            historyRejects(HistoryConfig::fromEnvironment(...));
        });
    }
    file_put_contents($secret, "dummy-only\r\n");
    $config = HistoryConfig::fromEnvironment();
    $test(static function () use ($config): void {
        historyCheck($config->enabled && $config->host === 'evse-database' && $config->port === 3306);
        historyCheck($config->database === 'energyControl' && $config->username === 'smartReader');
        historyCheck($config->password() === 'dummy-only' && $config->timeoutSeconds === 2);
        ob_start();
        var_dump($config, new HistoryStore($config));
        $debug = ob_get_clean();
        historyCheck(!str_contains($debug, 'dummy-only') && !str_contains($debug, 'smartReader'));
    });
    $test(static function () use ($secret): void {
        file_put_contents($secret, str_repeat('x', 4096) . "\r\n");
        historyCheck(strlen(HistoryConfig::fromEnvironment()->password()) === 4096);
        file_put_contents($secret, "dummy-only\r\n");
        putenv('HISTORY_DB_PASSWORD_FILE=php://memory');
        historyRejects(HistoryConfig::fromEnvironment(...));
        putenv('HISTORY_DB_PASSWORD_FILE=' . sys_get_temp_dir());
        historyRejects(HistoryConfig::fromEnvironment(...));
        putenv('HISTORY_DB_PASSWORD_FILE=' . $secret);
    });
    foreach (['HISTORY_DB_HOST' => ['a;unix_socket=x', 'a b', 'a/b', '', 'a..b'],
        'HISTORY_DB_PORT' => ['0', '65536', '1e3'], 'HISTORY_DB_NAME' => ['a;b', '1schema', 'a-b'],
        'HISTORY_DB_USERNAME' => ['', "bad\nname", str_repeat('x', 129), "\xFF"],
        'MQTT_TOPIC_PREFIX' => ['', '/x', 'x/', 'x/+', 'x/#', "x\n", "x\0", str_repeat('x', 241), "\xFF"]] as $key => $invalids) {
        foreach ($invalids as $invalid) {
            $test(static function () use ($key, $invalid): void {
                // getenv cannot represent NUL; direct construction covers that case below.
                if (str_contains($invalid, "\0")) {
                    historyRejects(static fn() => new HistoryConfig(true, prefix: $invalid, password: 'dummy'));
                    return;
                }
                putenv($key . '=' . $invalid);
                try {
                    historyRejects(HistoryConfig::fromEnvironment(...));
                } finally {
                    putenv($key);
                }
            });
        }
    }
    $test(static function (): void {
        historyCheck(HistoryStore::parseMinutes('') === 15);
        foreach ([1, 5, 15] as $minutes) {
            historyCheck(HistoryStore::parseMinutes('minutes=' . $minutes) === $minutes);
        }
    });
    foreach (['minutes=01', 'minutes=0', 'minutes=60', 'minutes=5&minutes=5', 'minutes[]=5',
        'minutes=%35', '%6dinutes=5', 'minutes=5&limit=1', 'limit=1', 'minutes=5;',
        'minutes=5&', 'minutes=5#x', "minutes=5\n", str_repeat('x', 129)] as $query) {
        $test(static fn() => historyRejects(static fn() => HistoryStore::parseMinutes($query)));
    }
    $test(static function (): void {
        $store = new HistoryStore(new HistoryConfig(), static fn() => throw new RuntimeException('Must not connect'), static fn(): float => 1793016059.0);
        $result = $store->snapshot(1);
        historyCheck($result['status'] === 'disabled' && $result['samples'] === [] && !$result['complete']);
        historyCheck(array_keys($result) === ['schema_version', 'read_only', 'status', 'reason', 'generated_at', 'minutes', 'range', 'complete', 'samples']);
        historyRejects(static fn() => $store->snapshot(2));
        $failure = HistoryStore::failure(5);
        historyCheck(array_keys($failure) === array_keys($result));
        historyCheck($failure['status'] === 'unavailable' && $failure['samples'] === [] && $failure['minutes'] === 5);
    });
    $rows = [historyRow('1', 2), historyRow('2', 4), historyRow('3', 6)];
    $test(static function (): void {
        $row = historyRow();
        $row['received_at'] = '1960-01-01 00:00:00.123456';
        $result = historyProject([$row]);
        historyCheck(!$result['complete']);
        historyCheck($result['samples'][0]['break_before']);
        historyCheck($result['samples'][0]['received_at'] === '1960-01-01T00:00:00.123456Z');
    });
    $test(static function () use ($rows): void {
        $result = historyProject($rows, [historyEvent(1)]);
        historyCheck($result['complete'] && historyBreaks($result) === [true, false, false]);
        $sample = $result['samples'][0];
        historyCheck($sample['id'] === '1' && $sample['timestamp'] === '2026-10-26T12:00:02.000000Z');
        historyCheck($sample['values']['current_a'] === [0.0, null, 1.25]);
        historyCheck($sample['values']['session_energy_wh'] === 4294967295);
        historyCheck($sample['values']['plugged_in'] === true && $sample['values']['charging'] === false);
        historyCheck(!array_key_exists('retained', $sample) && !array_key_exists('_m', $sample));
    });
    $test(static function () use ($rows): void {
        historyCheck(historyBreaks(historyProject($rows)) === [true, true, true]);
        historyCheck(historyBreaks(historyProject($rows, [historyEvent(3)])) === [true, true, false]);
        historyCheck(historyBreaks(historyProject($rows, [historyEvent(1, retained: '1')])) === [true, true, true]);
        historyCheck(historyBreaks(historyProject($rows, [historyEvent(1), historyEvent(3)])) === [true, false, false]);
    });
    foreach (['collector_started', 'collector_stopping', 'broker_connected', 'broker_disconnected', 'ingestion_gap'] as $kind) {
        $test(static function () use ($rows, $kind): void {
            $result = historyProject($rows, [historyEvent(1), historyEvent(3, $kind, null), historyEvent(5)]);
            historyCheck(historyBreaks($result) === [true, true, true]);
        });
    }
    $test(static function () use ($rows): void {
        historyCheck(historyBreaks(historyProject($rows, [historyEvent(1), historyEvent(3, availability: 'offline'), historyEvent(5)])) === [true, true, true]);
        historyCheck(historyBreaks(historyProject($rows, [historyEvent(1), historyEvent(2, 'ingestion_gap', null), historyEvent(3)])) === [true, true, false]);
        // An event tied with a sample isolates that sample and the following edge.
        historyCheck(historyBreaks(historyProject($rows, [historyEvent(2)])) === [true, true, false]);
    });
    $test(static function () use ($rows): void {
        $baseline = historyEvent(0);
        $baseline['received_at'] = '2026-10-26 11:59:59.000000';
        historyCheck(historyBreaks(historyProject($rows, [], $baseline)) === [true, false, false]);
        $baseline['availability'] = 'offline';
        historyCheck(historyBreaks(historyProject($rows, [], $baseline)) === [true, true, true]);
    });
    foreach (['retained', 'error'] as $mode) {
        $test(static function () use ($rows, $mode): void {
            if ($mode === 'retained') {
                $rows[1]['retained'] = '1';
            } else {
                $rows[1]['status'] = 'error';
            }
            $result = historyProject($rows, [historyEvent(1)]);
            historyCheck(historyBreaks($result) === [true, true, true]);
            if ($mode === 'error') {
                historyCheck($result['samples'][1]['values'] === null);
            }
        });
    }
    $test(static function () use ($rows): void {
        $rows[1]['measured_at'] = historyDate(2);
        $rows[1]['received_at'] = historyDate(2);
        $rows[1]['id'] = '18446744073709551615';
        $rows[2]['id'] = '18446744073709551614';
        $result = historyProject($rows, [historyEvent(1)]);
        historyCheck(!$result['complete'] && historyBreaks($result) === [true, true, true]);
        historyCheck(array_column($result['samples'], 'id') === ['1', '18446744073709551615', '18446744073709551614']);
        $duplicate = historyProject([historyRow('9', 2), historyRow('10', 2)], [historyEvent(1)]);
        historyCheck(count($duplicate['samples']) === 2 && $duplicate['complete']);
    });
    foreach (['measured_at', 'received_at'] as $field) {
        $test(static function () use ($rows, $field): void {
            $rows[1][$field] = historyDate(1);
            $result = historyProject($rows, [historyEvent(0)]);
            historyCheck(!$result['complete'] && historyBreaks($result) === [true, true, true]);
        });
    }
    $test(static function () use ($rows): void {
        $rows[1]['received_at'] = '2026-10-26 11:59:59.000000';
        historyCheck(!historyProject($rows)['complete']);
        $rows[1]['received_at'] = historyDate(20);
        historyCheck(!historyProject($rows)['complete']);
        $gap = historyProject([historyRow('1', 2), historyRow('2', 13)], [historyEvent(1)]);
        historyCheck($gap['complete'] && historyBreaks($gap) === [true, true]);
    });
    $test(static function () use ($rows): void {
        $events = [historyEvent(1), historyEvent(3, 'broker_disconnected', null), historyEvent(3)];
        $result = historyProject($rows, $events);
        historyCheck(!$result['complete'] && historyBreaks($result) === [true, true, true]);
        historyCheck(!historyProject($rows, [historyEvent(1)], historyEvent(0))['complete']);
    });
    foreach (['id' => ['18446744073709551616', '01', '-1', 1],
        'measured_at' => ['2026-02-30 12:00:00.000000', '2026-10-26 24:00:00.000000', '2026-10-26T12:00:00Z'],
        'current_limit_a' => ['-1.000', '1e3', 'NaN', '100000000000.000', '1.0001'],
        'voltage_l1_v' => ['10000000000000.0', '1.12'],
        'error_code' => ['4294967296', '-1', '1.0'], 'charging' => ['2', '', true], 'retained' => [null],
        'status' => ['unknown']] as $field => $values) {
        foreach ($values as $value) {
            $test(static function () use ($field, $value): void {
                $row = historyRow();
                $row[$field] = $value;
                historyRejects(static fn() => historyProject([$row]));
            });
        }
    }
    $test(static function (): void {
        $row = historyRow();
        foreach (['error_code', 'plugged_in', 'charging', 'below_commanded_current', 'current_limit_a'] as $field) {
            $row[$field] = null;
        }
        $values = historyProject([$row])['samples'][0]['values'];
        historyCheck($values['error_code'] === null && $values['charging'] === null && $values['current_limit_a'] === null);
        $row['voltage_l1_v'] = '9999999999999.9';
        $row['current_limit_a'] = '99999999999.999';
        historyCheck(count(historyProject([$row])['samples']) === 1);
    });
    $test(static function () use ($rows): void {
        $overflow = array_fill(0, 1201, historyRow());
        $result = historyProject($overflow, [historyEvent(1)]);
        historyCheck(!$result['complete'] && count($result['samples']) === 1200);
        historyCheck(!in_array(false, historyBreaks($result), true));
        $result = historyProject($rows, array_fill(0, 2401, historyEvent(1)));
        historyCheck(!$result['complete'] && historyBreaks($result) === [true, true, true]);
        $event = historyEvent(1);
        $event['event_id'] = 'bad';
        historyRejects(static fn() => historyProject([], [$event]));
    });
    $test(static function () use ($config, $rows): void {
        $pdo = new HistoryPDO([[['version' => '1']], [['server_now' => historyDate(59)]], array_reverse($rows), [historyEvent(1)], []]);
        $factory = static function (string $dsn, string $user, string $password, array $options) use ($pdo): PDO {
            historyCheck($user === 'smartReader' && $password === 'dummy-only');
            historyCheck(str_starts_with($dsn, 'mysql:host=evse-database;'));
            historyCheck($options[PDO::ATTR_EMULATE_PREPARES] === false && $options[PDO::ATTR_STRINGIFY_FETCHES] === true);
            historyCheck($options[PDO::ATTR_ERRMODE] === PDO::ERRMODE_EXCEPTION && $options[PDO::ATTR_TIMEOUT] === 2);
            return $pdo;
        };
        $result = (new HistoryStore($config, $factory))->snapshot(1);
        historyCheck($result['status'] === 'ok' && $result['complete'] && count($result['samples']) === 3);
        historyCheck($pdo->committed && !$pdo->rolledBack);
        historyCheck(in_array('SET TRANSACTION READ ONLY', $pdo->commands, true));
        historyCheck(in_array('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY', $pdo->commands, true));
        foreach ($pdo->statements as [$query, $statement]) {
            historyCheck(str_starts_with($query, 'SELECT ') && !str_contains($query, '*'));
            historyCheck(!preg_match('/payload|details_json|communication_error|T_ELECTRICITY/i', $query));
        }
        [$query, $statement] = $pdo->statements[2];
        historyCheck(str_contains($query, 'FORCE INDEX (source_measurement)') && str_ends_with($query, 'LIMIT 1201'));
        historyCheck($statement->parameters === ['evse/wallbox', '2026-10-26 11:59:59.000000', historyDate(59)]);
        historyCheck(str_contains($pdo->statements[3][0], 'LIMIT 2401'));
        historyCheck(str_ends_with($pdo->statements[4][0], 'LIMIT 2'));
    });
    foreach ([true, false] as $tied) {
        $test(static function () use ($config, $tied): void {
            $online = historyEvent(0);
            $online['event_id'] = str_repeat("\xFF", 16);
            $online['received_at'] = '2026-10-26 11:59:58.000000';
            $disconnected = historyEvent(0, 'broker_disconnected', null);
            $disconnected['event_id'] = str_repeat("\x01", 16);
            $disconnected['received_at'] = $tied ? $online['received_at'] : '2026-10-26 11:59:57.000000';
            $pdo = new HistoryPDO([[['version' => '1']], [['server_now' => historyDate(59)]],
                [historyRow('2', 4), historyRow('1', 2)], [], [$online, $disconnected]]);
            $result = (new HistoryStore($config, static fn() => $pdo))->snapshot(1);
            historyCheck($result['status'] === 'ok' && $result['complete']);
            historyCheck(historyBreaks($result) === ($tied ? [true, true] : [true, false]));
            historyCheck($pdo->committed && !$pdo->rolledBack);
            historyCheck(str_ends_with($pdo->statements[4][0], 'LIMIT 2'));
        });
    }
    foreach ([[], [['version' => '2']], [['version' => '1'], ['version' => '2']]] as $versions) {
        $test(static function () use ($config, $versions): void {
            $pdo = new HistoryPDO([$versions]);
            $result = (new HistoryStore($config, static fn() => $pdo))->snapshot();
            historyCheck($result['status'] === 'unavailable' && $result['samples'] === [] && $pdo->rolledBack);
        });
    }
    $test(static function () use ($config): void {
        $pdo = new HistoryPDO([], true);
        $result = (new HistoryStore($config, static fn() => $pdo))->snapshot();
        historyCheck($result['status'] === 'unavailable' && $result['samples'] === [] && $pdo->rolledBack);
        historyCheck(!str_contains(json_encode($result, JSON_THROW_ON_ERROR), 'isolated-sensitive-marker'));
        $result = (new HistoryStore($config, static fn() => throw new PDOException('dummy-only')))->snapshot();
        historyCheck($result['status'] === 'unavailable' && !str_contains(json_encode($result), 'dummy-only'));
    });
    $test(static function () use ($config): void {
        $invalid = historyRow();
        $invalid['measured_at'] = 'not-a-date';
        $pdo = new HistoryPDO([[['version' => '1']], [['server_now' => historyDate(59)]], [$invalid], [], []]);
        $result = (new HistoryStore($config, static fn() => $pdo))->snapshot();
        historyCheck($result['status'] === 'unavailable' && $result['samples'] === [] && $pdo->rolledBack);
        historyCheck(!str_contains(json_encode($result), 'not-a-date'));
    });
    $test(static function () use ($config): void {
        $rows = [];
        for ($i = 1; $i <= 1200; ++$i) {
            $rows[] = historyRow((string) $i, 2);
        }
        $pdo = new HistoryPDO([[['version' => '1']], [['server_now' => historyDate(59)]], $rows, [historyEvent(1)], []]);
        $result = (new HistoryStore($config, static fn() => $pdo))->snapshot();
        historyCheck($result['status'] === 'ok' && strlen(json_encode($result, JSON_THROW_ON_ERROR)) <= 1048576);
        historyCheck(count($result['samples']) === 1200 && $result['complete']);
    });
    $test(static function () use ($config): void {
        $reads = 0;
        $factoryCalled = false;
        $mono = static function () use (&$reads): int {
            return $reads++ === 0 ? 0 : 3000000000;
        };
        $factory = static function () use (&$factoryCalled): PDO {
            $factoryCalled = true;
            throw new RuntimeException('Factory must not run');
        };
        $result = (new HistoryStore($config, $factory, null, $mono))->snapshot();
        historyCheck(!$factoryCalled && $result['status'] === 'unavailable' && $result['samples'] === []);
    });
    $test(static function () use ($config): void {
        $time = (object) ['now' => 0];
        $pdo = new HistoryPDO([]);
        $factory = static function () use ($time, $pdo): PDO {
            $time->now = 3000000000;
            return $pdo;
        };
        $result = (new HistoryStore($config, $factory, null, static fn(): int => $time->now))->snapshot();
        historyCheck($result['status'] === 'unavailable' && $pdo->commands === [] && $pdo->statements === []);
        historyCheck($pdo->rolledBack && !$pdo->committed);
    });
    // Expire after every individual driver stage, without sleeping or opening a socket.
    foreach (['exec', 'prepare', 'execute', 'fetch'] as $stage) {
        for ($occurrence = 1; $occurrence <= 5; ++$occurrence) {
            $test(static function () use ($config, $stage, $occurrence): void {
                $time = (object) ['now' => 0];
                $counts = ['exec' => 0, 'prepare' => 0, 'execute' => 0, 'fetch' => 0];
                $expired = false;
                $followingCalls = 0;
                $pdo = new HistoryPDO([[['version' => '1']], [['server_now' => historyDate(59)]], [], [], []]);
                $pdo->step = static function (string $operation) use ($time, $stage, $occurrence, &$counts, &$expired, &$followingCalls): void {
                    if ($expired) {
                        ++$followingCalls;
                    }
                    ++$counts[$operation];
                    if ($operation === $stage && $counts[$operation] === $occurrence) {
                        $time->now = 3000000000;
                        $expired = true;
                    }
                };
                $result = (new HistoryStore($config, static fn() => $pdo, null, static fn(): int => $time->now))->snapshot();
                historyCheck($expired && $followingCalls === 0, 'Driver work continued after total budget');
                historyCheck($result['status'] === 'unavailable' && $result['samples'] === [] && !$result['complete']);
                historyCheck($pdo->rolledBack && !$pdo->committed);
                $body = json_encode($result, JSON_THROW_ON_ERROR);
                historyCheck(!str_contains($body, 'History time budget exceeded') && !str_contains($body, 'dummy-only'));
            });
        }
    }
    $test(static function () use ($config): void {
        $time = (object) ['now' => 0, 'remainingReads' => null];
        $fetches = 0;
        $pdo = new HistoryPDO([[['version' => '1']], [['server_now' => historyDate(59)]], [], [], []]);
        $pdo->step = static function (string $operation) use ($time, &$fetches): void {
            if ($operation === 'fetch' && ++$fetches === 5) {
                // Let the post-fetch guard pass, then expire at the pre-commit guard.
                $time->remainingReads = 1;
            }
        };
        $mono = static function () use ($time): int {
            if ($time->remainingReads !== null && $time->remainingReads-- <= 0) {
                $time->now = 3000000000;
            }
            return $time->now;
        };
        $result = (new HistoryStore($config, static fn() => $pdo, null, $mono))->snapshot();
        historyCheck($fetches === 5 && count($pdo->statements) === 5);
        historyCheck($result['status'] === 'unavailable' && !$pdo->committed && $pdo->rolledBack);
    });
    $test(static function () use ($config): void {
        $time = (object) ['now' => 0];
        $pdo = new HistoryPDO([[['version' => '1']], [['server_now' => historyDate(59)]], [], [], []]);
        $pdo->step = static function (string $operation) use ($time): void {
            $time->now += 100000000;
        };
        $result = (new HistoryStore($config, static fn() => $pdo, null, static fn(): int => $time->now))->snapshot();
        historyCheck($time->now === 2000000000 && $result['status'] === 'ok');
        historyCheck($pdo->committed && !$pdo->rolledBack);
    });
    print('History: ' . $cases . " isolated cases passed\n");
} finally {
    unlink($secret);
    foreach ($saved as $key => $value) {
        putenv($value === false ? $key : $key . '=' . $value);
    }
}
