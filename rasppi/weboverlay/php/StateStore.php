<?php
declare(strict_types=1);

namespace EvseOverlay;

final class StateStore
{
    private \Closure $wall;
    private \Closure $mono;
    private bool $connected = false;
    private ?string $availability = null;
    private bool $availabilityInvalid = false;
    private bool $invalid = false;
    private ?array $sample = null;
    private float $receivedAt = 0;
    private float $initialAge = 0;
    private bool $futureSample = false;

    public function __construct(private int $staleSeconds = 10, ?callable $wall = null, ?callable $mono = null)
    {
        if ($staleSeconds <= 0) {
            throw new \InvalidArgumentException('Invalid stale threshold');
        }
        $this->wall = \Closure::fromCallable($wall ?? static fn(): float => microtime(true));
        $this->mono = \Closure::fromCallable($mono ?? static fn(): float => hrtime(true) / 1e9);
    }

    private static function timestamp(mixed $text): float
    {
        if (!is_string($text) || !preg_match('/\A(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)\z/D', $text, $m) ||
            !checkdate((int) $m[2], (int) $m[3], (int) $m[1]) || (int) $m[4] > 23 || (int) $m[5] > 59 || (int) $m[6] > 59) {
            throw new \UnexpectedValueException('Invalid UTC timestamp');
        }
        $date = new \DateTimeImmutable($text);
        return (float) $date->format('U.u');
    }

    private static function decodeSample(string $payload): array
    {
        if (strlen($payload) > 16384) {
            throw new \UnexpectedValueException('Payload too large');
        }
        $data = StrictJson::decode($payload);
        if (!$data instanceof \stdClass || ($data->schema_version ?? null) !== 1 ||
            ($data->device ?? null) !== 'abb_terra_ac' || !in_array($data->status ?? null, ['ok', 'error'], true)) {
            throw new \UnexpectedValueException('Invalid sample schema');
        }
        foreach (['timestamp', 'last_success_at', 'values', 'error'] as $key) {
            if (!property_exists($data, $key)) {
                throw new \UnexpectedValueException('Missing sample field');
            }
        }
        self::timestamp($data->timestamp);
        if ($data->last_success_at !== null) {
            self::timestamp($data->last_success_at);
        }
        $error = $data->error;
        if ($error !== null && (!is_string($error) || preg_match_all('/./us', $error) > 1024)) {
            throw new \UnexpectedValueException('Invalid error');
        }
        $values = $data->values;
        if ($data->status === 'error') {
            if ($values !== null || $error === null || $error === '') {
                throw new \UnexpectedValueException('Invalid read error');
            }
        } else {
            if (!$values instanceof \stdClass || $error !== null || $data->last_success_at !== $data->timestamp) {
                throw new \UnexpectedValueException('Invalid successful sample');
            }
            $clean = [];
            foreach (['error_code', 'socket_lock_state', 'charging_state_raw', 'charging_state', 'active_power_w', 'session_energy_wh'] as $key) {
                $value = $values->$key ?? null;
                if (!is_int($value) || $value < 0 || $value > 0xFFFFFFFF) {
                    throw new \UnexpectedValueException('Invalid unsigned measurement');
                }
                $clean[$key] = $value;
            }
            foreach (['plugged_in', 'charging', 'below_commanded_current'] as $key) {
                if (!property_exists($values, $key) || (!is_bool($values->$key) && ($values->$key !== null || $key === 'below_commanded_current'))) {
                    throw new \UnexpectedValueException('Invalid boolean');
                }
                $clean[$key] = $values->$key;
            }
            foreach (['current_limit_a' => 1, 'current_a' => 3, 'voltage_v' => 3] as $key => $length) {
                $value = $values->$key ?? null;
                $array = $length === 1 ? [$value] : $value;
                if (!is_array($array) || !array_is_list($array) || count($array) !== $length) {
                    throw new \UnexpectedValueException('Invalid phase array');
                }
                foreach ($array as $item) {
                    if ((!is_int($item) && !is_float($item)) || !is_finite((float) $item) || $item < 0) {
                        throw new \UnexpectedValueException('Invalid numeric measurement');
                    }
                }
                $clean[$key] = $value;
            }
            $values = $clean;
        }
        return ['timestamp' => $data->timestamp, 'last_success_at' => $data->last_success_at,
            'status' => $data->status, 'values' => $values, 'error' => $error];
    }

    public function connection(bool $connected): void
    {
        $this->connected = $connected;
        $this->availability = null;
        $this->availabilityInvalid = $this->invalid = $this->futureSample = false;
        $this->sample = null;
        $this->receivedAt = $this->initialAge = 0;
    }

    public function acceptAvailability(string $payload): void
    {
        $this->availability = in_array($payload, ['online', 'offline'], true) ? $payload : null;
        $this->availabilityInvalid = $this->availability === null;
    }

    public function acceptSample(string $payload): void
    {
        try {
            $sample = self::decodeSample($payload);
        } catch (\JsonException | \UnexpectedValueException $e) {
            $this->invalid = true;
            return;
        }
        if ($this->sample !== null && !$this->futureSample && self::timestamp($sample['timestamp']) < self::timestamp($this->sample['timestamp'])) {
            return;
        }
        $duplicate = $this->sample !== null && $this->sample['timestamp'] === $sample['timestamp'];
        $this->sample = $sample;
        $this->invalid = false;
        if (!$duplicate) {
            $this->receivedAt = ($this->mono)();
            $age = ($this->wall)() - self::timestamp($sample['timestamp']);
            $this->initialAge = max(0, $age);
            $this->futureSample = $age < -5;
        }
    }

    public function snapshot(): array
    {
        $sample = $this->sample;
        $age = null;
        if ($sample !== null) {
            $wallAge = ($this->wall)() - self::timestamp($sample['timestamp']);
            $age = max(0, $wallAge, $this->initialAge + ($this->mono)() - $this->receivedAt);
            if ($wallAge < -5) {
                $this->futureSample = true;
            }
        }
        if (!$this->connected) {
            [$status, $reason] = ['offline', 'Keine Verbindung zum MQTT-Broker'];
        } elseif ($this->invalid || $this->availabilityInvalid) {
            [$status, $reason] = ['invalid', 'Ungültige MQTT-Daten – Messwerte ausgeblendet'];
        } elseif ($sample !== null && $sample['status'] === 'error') {
            [$status, $reason] = ['read_error', 'Wallbox konnte nicht ausgelesen werden'];
        } elseif ($this->availability === 'offline') {
            [$status, $reason] = ['offline', 'Wallbox-Reader meldet offline'];
        } elseif ($this->futureSample) {
            [$status, $reason] = ['clock_error', 'Messzeit liegt in der Zukunft – Uhrzeiten prüfen'];
        } elseif ($sample !== null && $age >= $this->staleSeconds) {
            [$status, $reason] = ['stale', 'Messdaten veraltet'];
        } elseif ($this->availability === null || $sample === null) {
            [$status, $reason] = ['waiting', 'Warte auf Messdaten und Verfügbarkeit'];
        } else {
            [$status, $reason] = ['live', 'Aktuelle Wallbox-Messdaten'];
        }
        return ['schema_version' => 1, 'read_only' => true, 'status' => $status, 'reason' => $reason,
            'broker_connected' => $this->connected, 'availability' => $this->availability,
            'timestamp' => $sample['timestamp'] ?? null, 'last_success_at' => $sample['last_success_at'] ?? null,
            'age_seconds' => $age === null ? null : round($age, 3),
            'fresh_for_seconds' => $status === 'live' ? max(0, $this->staleSeconds - $age) : 0,
            'values' => $status === 'live' ? $sample['values'] : null, 'error' => $sample['error'] ?? null];
    }

    public function export(): array
    {
        // Observe rollback now, so a different reader cannot lose the future latch.
        $this->snapshot();
        return ['version' => 1, 'connected' => $this->connected, 'availability' => $this->availability,
            'availability_invalid' => $this->availabilityInvalid, 'invalid' => $this->invalid,
            'sample' => $this->sample, 'received_at' => $this->receivedAt,
            'initial_age' => $this->initialAge, 'future_sample' => $this->futureSample];
    }

    /** Invalid persisted records produce a disconnected empty store, never live data. */
    public static function restore(array $record, int $staleSeconds = 10, ?callable $wall = null, ?callable $mono = null): self
    {
        $store = new self($staleSeconds, $wall, $mono);
        try {
            $keys = array_keys($record);
            $expected = ['version', 'connected', 'availability', 'availability_invalid', 'invalid', 'sample', 'received_at', 'initial_age', 'future_sample'];
            sort($keys);
            sort($expected);
            if ($keys !== $expected || $record['version'] !== 1) {
                throw new \UnexpectedValueException();
            }
            foreach (['connected', 'availability_invalid', 'invalid', 'future_sample'] as $key) {
                if (!is_bool($record[$key])) {
                    throw new \UnexpectedValueException();
                }
            }
            if (!in_array($record['availability'], [null, 'online', 'offline'], true) ||
                ($record['availability_invalid'] && $record['availability'] !== null)) {
                throw new \UnexpectedValueException();
            }
            foreach (['received_at', 'initial_age'] as $key) {
                $v = $record[$key];
                if ((!is_int($v) && !is_float($v)) || !is_finite((float) $v) || $v < 0) {
                    throw new \UnexpectedValueException();
                }
            }
            if ($record['received_at'] > ($store->mono)()) {
                // Monotonic origin changed (e.g. reboot); cached state is unusable.
                throw new \UnexpectedValueException();
            }
            $sample = $record['sample'];
            if ($sample !== null) {
                if (!is_array($sample) || count($sample) !== 5) {
                    throw new \UnexpectedValueException();
                }
                $wire = $sample;
                $wire['schema_version'] = 1;
                $wire['device'] = 'abb_terra_ac';
                $clean = self::decodeSample(json_encode($wire, JSON_THROW_ON_ERROR | JSON_PRESERVE_ZERO_FRACTION));
                if ($clean != $sample || array_diff(array_keys($sample), array_keys($clean)) !== []) {
                    throw new \UnexpectedValueException();
                }
                // Reject extra value keys instead of silently accepting corrupted records.
                if ($sample['values'] !== null && (!is_array($sample['values']) || count($sample['values']) !== count($clean['values']))) {
                    throw new \UnexpectedValueException();
                }
                $sample = $clean;
            } elseif ($record['future_sample'] || $record['received_at'] != 0 || $record['initial_age'] != 0) {
                throw new \UnexpectedValueException();
            }
            $store->connected = $record['connected'];
            $store->availability = $record['availability'];
            $store->availabilityInvalid = $record['availability_invalid'];
            $store->invalid = $record['invalid'];
            $store->sample = $sample;
            $store->receivedAt = (float) $record['received_at'];
            $store->initialAge = (float) $record['initial_age'];
            $store->futureSample = $record['future_sample'];
            return $store;
        } catch (\JsonException | \UnexpectedValueException $e) {
            return new self($staleSeconds, $wall, $mono);
        }
    }
}
