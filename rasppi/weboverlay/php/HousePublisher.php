<?php
declare(strict_types=1);

namespace EvseOverlay;

/** Observation identity belongs to an HTTP attempt, never to a reconnect. */
final class HousePublisher
{
    private const MAX_SEQUENCE = 4294967295;
    private const MAX_SAFE_WATTS = 9007199254740991.0;
    private const ERRORS = ['read_failed', 'startup', 'stale', 'clock_error'];

    private string $epoch;
    private int $sequence = 0;
    private ?string $lastSuccess = null;
    private ?float $lastClock = null;
    private float $observedAt = 0;
    private array $latest;

    public function __construct()
    {
        $this->epoch = self::uuid();
        $this->observe(null, 'startup');
    }

    private static function uuid(): string
    {
        $b = random_bytes(16);
        $b[6] = chr((ord($b[6]) & 15) | 64);
        $b[8] = chr((ord($b[8]) & 63) | 128);
        $h = bin2hex($b);
        return substr($h, 0, 8) . '-' . substr($h, 8, 4) . '-' . substr($h, 12, 4) . '-'
            . substr($h, 16, 4) . '-' . substr($h, 20);
    }

    private static function timestamp(float $wall): string
    {
        // 253370764800 is 9999-01-01T00:00:00Z. The contract ends in 9998.
        if (!is_finite($wall) || $wall < 0 || $wall >= 253370764800.0) {
            throw new \RuntimeException('Clock unavailable');
        }
        // createFromFormat avoids interpreting a Unix decimal as a calendar date.
        $stamp = \DateTimeImmutable::createFromFormat(
            'U.u',
            sprintf('%.6F', $wall),
            new \DateTimeZone('UTC'),
        );
        if ($stamp === false || (int) $stamp->format('Y') > 9998) {
            throw new \RuntimeException('Clock unavailable');
        }
        return $stamp->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.u\Z');
    }

    public function observe(?float $power, ?string $error = null, ?float $wall = null, ?float $mono = null): void
    {
        $wall ??= microtime(true);
        $mono ??= hrtime(true) / 1e9;
        if ($error !== null && !in_array($error, self::ERRORS, true)) {
            throw new \InvalidArgumentException('Invalid observation error');
        }
        if (!is_finite($mono) || $mono < 0) {
            throw new \InvalidArgumentException('Invalid monotonic clock');
        }
        $timestamp = self::timestamp($wall);
        if ($this->sequence === self::MAX_SEQUENCE) {
            $this->epoch = self::uuid();
            $this->sequence = 0;
        }
        if ($this->lastClock !== null && $wall < $this->lastClock) {
            $error = 'clock_error';
            $this->lastSuccess = null;
        }
        $this->lastClock = $wall;
        if ($power === null || !is_finite($power) || abs($power) > self::MAX_SAFE_WATTS) {
            $error ??= 'read_failed';
        }
        if ($error === null) {
            $this->lastSuccess = $timestamp;
        }
        $this->latest = [
            'schema_version' => 1,
            'device' => 'house_grid',
            'publisher_id' => $this->epoch,
            'sequence' => ++$this->sequence,
            'timestamp' => $timestamp,
            'status' => $error === null ? 'ok' : 'error',
            'last_success_at' => $this->lastSuccess,
            'power_w' => $error === null ? $power : null,
            'error' => $error,
        ];
        $this->observedAt = $mono;
    }

    public function json(): string
    {
        return json_encode($this->latest, JSON_THROW_ON_ERROR | JSON_PRESERVE_ZERO_FRACTION);
    }

    public function online(float $mono, int $stale): bool
    {
        return $this->latest['status'] === 'ok' && $mono >= $this->observedAt && $mono - $this->observedAt < $stale;
    }

    public function expire(float $mono, int $stale): void
    {
        if ($this->latest['status'] === 'ok' && !$this->online($mono, $stale)) {
            $this->observe(null, 'stale', null, $mono);
        }
    }

    public static function health(string $directory, bool $running): void
    {
        if (!is_dir($directory) && !@mkdir($directory, 0700, true) && !is_dir($directory)) {
            throw new \RuntimeException('Health unavailable');
        }
        $owner = fileowner('/proc/self');
        $permissions = @fileperms($directory);
        if ($owner === false || is_link($directory) || $permissions === false
            || ($permissions & 0777) !== 0700 || @fileowner($directory) !== $owner) {
            throw new \RuntimeException('Health unavailable');
        }
        $temp = tempnam($directory, '.health-');
        if ($temp === false || dirname($temp) !== $directory || !@chmod($temp, 0600)) {
            if (is_string($temp) && is_file($temp)) {
                @unlink($temp);
            }
            throw new \RuntimeException('Health unavailable');
        }
        try {
            $data = json_encode([
                'schema_version' => 1,
                'pid' => getmypid(),
                'running' => $running,
                'heartbeat' => hrtime(true),
            ], JSON_THROW_ON_ERROR);
            if (@file_put_contents($temp, $data) !== strlen($data)
                || !@rename($temp, $directory . '/health.json')) {
                throw new \RuntimeException('Health unavailable');
            }
        } finally {
            if (is_file($temp)) {
                @unlink($temp);
            }
        }
    }
}
