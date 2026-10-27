<?php
declare(strict_types=1);

namespace EvseOverlay;

/** Independent private IPC; HTTP readers never renew heartbeat or receipt times. */
final class SmartmeterCache
{
    private \Closure $wall;
    private \Closure $mono;

    public function __construct(private string $dir, private SmartmeterConfig $config,
        ?callable $wall = null, ?callable $mono = null)
    {
        $this->wall = \Closure::fromCallable($wall ?? static fn (): float => microtime(true));
        $this->mono = \Closure::fromCallable($mono ?? static fn (): float => hrtime(true) / 1e9);
        if (!str_starts_with($dir, '/') || is_link($dir)
            || (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir))) {
            throw new \RuntimeException('Smartmeter-Speicher nicht verfügbar');
        }
    }

    public function reset(): void
    {
        $this->locked(function (): void {
            $this->write(['version' => 1, 'status' => 'waiting', 'power' => null, 'wall' => null,
                'mono' => null, 'heartbeat' => ($this->mono)(), 'clock_error' => false,
                'seen_wall' => ($this->wall)(), 'seen_mono' => ($this->mono)()]);
        });
    }

    public function success(float $power): void
    {
        if (!is_finite($power)) {
            throw new \RuntimeException('Smartmeter-Wert ungültig');
        }
        $this->locked(function () use ($power): void {
            $wall = ($this->wall)();
            $mono = ($this->mono)();
            $this->write(['version' => 1, 'status' => 'live', 'power' => $power, 'wall' => $wall,
                'mono' => $mono, 'heartbeat' => $mono, 'clock_error' => false,
                'seen_wall' => $wall, 'seen_mono' => $mono]);
        });
    }

    public function failure(): void
    {
        $this->update(true);
    }

    public function heartbeat(): void
    {
        $this->update(false);
    }

    private function update(bool $failed): void
    {
        $this->locked(function () use ($failed): void {
            $record = $this->read();
            $this->observe($record);
            if ($failed) {
                $record['status'] = 'read_error';
            }
            $record['heartbeat'] = ($this->mono)();
            $this->write($record);
        });
    }

    public function snapshot(): array
    {
        if (!$this->config->enabled()) {
            return $this->result('disabled');
        }
        try {
            return $this->locked(function (): array {
                $record = $this->read();
                $this->observe($record);
                $this->write($record); // Persist clock latch, never heartbeat/sample renewal.
                $mono = ($this->mono)();
                $age = $record['wall'] === null ? null : max(0.0,
                    ($this->wall)() - $record['wall'], $mono - $record['mono']);
                $status = $record['status'];
                if ($record['clock_error']) {
                    $status = 'clock_error';
                } elseif ($mono - $record['heartbeat'] >= max(3, $this->config->timeoutSeconds + 1)) {
                    $status = 'offline';
                } elseif ($status === 'live' && $age >= $this->config->staleSeconds) {
                    $status = 'stale';
                }
                return $this->result($status, $record, $age);
            });
        } catch (\Throwable) {
            return $this->result('offline');
        }
    }

    private function observe(array &$record): void
    {
        $wall = ($this->wall)();
        $mono = ($this->mono)();
        if ($wall < $record['seen_wall'] || $mono < $record['seen_mono']
            || $mono < $record['heartbeat'] || ($record['wall'] !== null
                && ($wall < $record['wall'] || $mono < $record['mono']))) {
            $record['clock_error'] = true;
        }
        $record['seen_wall'] = $wall;
        $record['seen_mono'] = $mono;
    }

    private function result(string $status, ?array $record = null, ?float $age = null): array
    {
        $reasons = ['disabled' => 'Haus-Smartmeter deaktiviert', 'waiting' => 'Warte auf Haus-Smartmeter',
            'live' => 'Haus-Smartmeter aktuell', 'stale' => 'Haus-Smartmeter-Daten veraltet',
            'offline' => 'Haus-Smartmeter-Empfänger nicht verfügbar',
            'read_error' => 'Haus-Smartmeter-Abfrage fehlgeschlagen', 'clock_error' => 'Zeitprüfung fehlgeschlagen'];
        return ['schema_version' => 1, 'read_only' => true, 'status' => $status, 'reason' => $reasons[$status],
            'power_w' => $status === 'live' ? (float) $record['power'] : null,
            'fetched_at' => isset($record['wall']) ? gmdate('Y-m-d\TH:i:s', (int) $record['wall'])
                . sprintf('.%06dZ', (int) (($record['wall'] - floor($record['wall'])) * 1e6)) : null,
            'age_seconds' => $age,
            'fresh_for_seconds' => $status === 'live' ? max(0.0, $this->config->staleSeconds - $age) : 0.0];
    }

    private function locked(callable $operation): mixed
    {
        $path = $this->dir . '/smartmeter.lock';
        if (is_link($path)) {
            throw new \RuntimeException('Smartmeter-Speicher nicht verfügbar');
        }
        $lock = @fopen($path, 'c');
        if ($lock === false) {
            throw new \RuntimeException('Smartmeter-Speicher nicht verfügbar');
        }
        try {
            @chmod($path, 0600);
            $deadline = hrtime(true) + 200000000;
            while (!flock($lock, LOCK_EX | LOCK_NB)) {
                if (hrtime(true) >= $deadline) {
                    throw new \RuntimeException('Smartmeter-Speicher nicht verfügbar');
                }
                usleep(1000);
            }
            return $operation();
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    private function read(): array
    {
        $path = $this->dir . '/smartmeter.json';
        clearstatcache(true, $path);
        if (is_link($path) || !is_file($path) || filesize($path) > 8192) {
            throw new \RuntimeException('Smartmeter-Speicher ungültig');
        }
        $text = @file_get_contents($path, false, null, 0, 8193);
        if ($text === false || strlen($text) > 8192) {
            throw new \RuntimeException('Smartmeter-Speicher ungültig');
        }
        $decoded = StrictJson::decode($text);
        $r = $decoded instanceof \stdClass ? get_object_vars($decoded) : null;
        $keys = ['version', 'status', 'power', 'wall', 'mono', 'heartbeat', 'clock_error', 'seen_wall', 'seen_mono'];
        if (!is_array($r) || count($r) !== count($keys) || array_diff($keys, array_keys($r))
            || $r['version'] !== 1 || !in_array($r['status'], ['waiting', 'live', 'read_error'], true)
            || !is_bool($r['clock_error'])) {
            throw new \RuntimeException('Smartmeter-Speicher ungültig');
        }
        foreach (['power', 'wall', 'mono', 'heartbeat', 'seen_wall', 'seen_mono'] as $key) {
            if ($r[$key] === null && in_array($key, ['power', 'wall', 'mono'], true)) {
                continue;
            }
            if ((!is_int($r[$key]) && !is_float($r[$key])) || !is_finite((float) $r[$key])
                || ($key !== 'power' && $r[$key] < 0)) {
                throw new \RuntimeException('Smartmeter-Speicher ungültig');
            }
        }
        if (($r['wall'] === null) !== ($r['mono'] === null)
            || ($r['wall'] === null) !== ($r['power'] === null)
            || ($r['status'] === 'live' && $r['power'] === null)
            || ($r['status'] === 'waiting' && $r['power'] !== null)
            || ($r['wall'] !== null && $r['wall'] > 253402300799)) {
            throw new \RuntimeException('Smartmeter-Speicher ungültig');
        }
        return $r;
    }

    private function write(array $record): void
    {
        $text = json_encode($record, JSON_THROW_ON_ERROR | JSON_PRESERVE_ZERO_FRACTION);
        if (strlen($text) > 8192) {
            throw new \RuntimeException('Smartmeter-Speicher ungültig');
        }
        $temp = $this->dir . '/.smartmeter-' . bin2hex(random_bytes(12));
        try {
            $stream = @fopen($temp, 'x');
            if ($stream === false) {
                throw new \RuntimeException('Smartmeter-Speicher nicht verfügbar');
            }
            try {
                if (!@chmod($temp, 0600) || fwrite($stream, $text) !== strlen($text) || !fflush($stream)) {
                    throw new \RuntimeException('Smartmeter-Speicher nicht verfügbar');
                }
            } finally {
                fclose($stream);
            }
            if (!@rename($temp, $this->dir . '/smartmeter.json')) {
                throw new \RuntimeException('Smartmeter-Speicher nicht verfügbar');
            }
        } finally {
            if (is_file($temp)) {
                @unlink($temp);
            }
        }
    }
}
