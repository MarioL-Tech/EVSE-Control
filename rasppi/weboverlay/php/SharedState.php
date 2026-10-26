<?php
declare(strict_types=1);

namespace EvseOverlay;

/** Private tmpfs IPC: stable lock inode, bounded record, atomic replacement. */
final class SharedState
{
    private const MAX_BYTES = 65536;
    public const HEARTBEAT_SECONDS = 3.0;

    public function __construct(private string $directory, private int $staleSeconds = 10)
    {
        if (!str_starts_with($directory, '/') || is_link($directory)) {
            throw new \RuntimeException('Invalid state directory');
        }
        if (!is_dir($directory) && !@mkdir($directory, 0700, true) && !is_dir($directory)) {
            throw new \RuntimeException('State directory unavailable');
        }
    }

    public function reset(): void
    {
        $this->locked(function (): void {
            $this->write(new StateStore($this->staleSeconds), self::monotonic());
        });
    }

    public function update(callable $change): void
    {
        $this->locked(function () use ($change): void {
            [$state] = $this->read();
            $change($state);
            // Latch clock faults even when no browser is polling.
            $state->snapshot();
            $this->write($state, self::monotonic());
        });
    }

    public function snapshot(): array
    {
        try {
            return $this->locked(function (): array {
                [$state, $heartbeat] = $this->read();
                $elapsed = self::monotonic() - $heartbeat;
                if ($elapsed < 0 || $elapsed >= self::HEARTBEAT_SECONDS) {
                    return $this->unavailable();
                }
                $result = $state->snapshot();
                // Persist the latch across PHP requests; never renew the heartbeat.
                $this->write($state, $heartbeat);
                return $result;
            });
        } catch (\Throwable) {
            return $this->unavailable();
        }
    }

    private function unavailable(): array
    {
        $result = (new StateStore($this->staleSeconds))->snapshot();
        $result['reason'] = 'MQTT-Empfänger nicht verfügbar';
        return $result;
    }

    private static function monotonic(): float
    {
        return hrtime(true) / 1e9;
    }

    private function locked(callable $operation): mixed
    {
        $path = $this->directory . '/state.lock';
        if (is_link($path)) {
            throw new \RuntimeException('Invalid lock file');
        }
        $lock = @fopen($path, 'c');
        if ($lock === false) {
            throw new \RuntimeException('State lock unavailable');
        }
        try {
            $deadline = self::monotonic() + 0.2;
            while (!flock($lock, LOCK_EX | LOCK_NB)) {
                if (self::monotonic() >= $deadline) {
                    throw new \RuntimeException('State lock timeout');
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
        $path = $this->directory . '/state.json';
        clearstatcache(true, $path);
        if (!file_exists($path)) {
            return [new StateStore($this->staleSeconds), 0.0];
        }
        if (is_link($path) || !is_file($path) || filesize($path) > self::MAX_BYTES) {
            throw new \RuntimeException('Invalid state record');
        }
        $text = @file_get_contents($path, false, null, 0, self::MAX_BYTES + 1);
        if ($text === false || strlen($text) > self::MAX_BYTES) {
            throw new \RuntimeException('State record unavailable');
        }
        $record = json_decode($text, true, 64, JSON_THROW_ON_ERROR);
        if (!is_array($record) || ($record['version'] ?? null) !== 1
            || ($record['stale_seconds'] ?? null) !== $this->staleSeconds
            || !isset($record['heartbeat'], $record['state']) || !is_array($record['state'])
            || !is_numeric($record['heartbeat']) || !is_finite((float) $record['heartbeat'])) {
            throw new \RuntimeException('Invalid state record');
        }
        return [StateStore::restore($record['state'], $this->staleSeconds), (float) $record['heartbeat']];
    }

    private function write(StateStore $state, float $heartbeat): void
    {
        $text = json_encode(['version' => 1, 'stale_seconds' => $this->staleSeconds,
            'heartbeat' => $heartbeat, 'state' => $state->export()], JSON_THROW_ON_ERROR);
        if (strlen($text) > self::MAX_BYTES) {
            throw new \RuntimeException('State record too large');
        }
        $temporary = $this->directory . '/.' . bin2hex(random_bytes(12));
        try {
            $stream = @fopen($temporary, 'x');
            if ($stream === false) {
                throw new \RuntimeException('State write failed');
            }
            try {
                if (!chmod($temporary, 0600) || fwrite($stream, $text) !== strlen($text) || !fflush($stream)) {
                    throw new \RuntimeException('State write failed');
                }
            } finally {
                fclose($stream);
            }
            if (!rename($temporary, $this->directory . '/state.json')) {
                throw new \RuntimeException('State replacement failed');
            }
        } finally {
            if (file_exists($temporary)) {
                @unlink($temporary);
            }
        }
    }
}
