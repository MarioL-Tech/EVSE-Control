<?php
declare(strict_types=1);

namespace EvseOverlay;

/** Validated alternative query DTO. All boundaries are instants, never SQL expressions. */
final class HistoryRange
{
    private function __construct(
        public readonly string $period,
        public readonly string $label,
        public readonly string $timezone,
        public readonly \DateTimeImmutable $from,
        public readonly \DateTimeImmutable $to,
    ) {}

    public static function iso(\DateTimeImmutable $date): string
    {
        return $date->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z');
    }

    /** Legacy parsing is deliberately delegated unchanged (including its escape policy). */
    public static function parse(string $query, ?\DateTimeImmutable $now = null): self|int
    {
        if ($query === '' || preg_match('/\Aminutes=/', $query)) {
            return HistoryStore::parseMinutes($query);
        }
        if (strlen($query) > 512 || preg_match('/%(?![0-9a-fA-F]{2})/', $query)) {
            throw new \InvalidArgumentException('Invalid history query');
        }
        $q = [];
        foreach (explode('&', $query) as $part) {
            if (substr_count($part, '=') !== 1) {
                throw new \InvalidArgumentException('Invalid history query');
            }
            [$key, $value] = array_map('rawurldecode', explode('=', $part, 2));
            if (!in_array($key, ['period', 'date', 'at', 'tz', 'from', 'to', 'date_from', 'date_to'], true) ||
                isset($q[$key]) || $value === '' || preg_match('/[^\x20-\x7E]/', $value)) {
                throw new \InvalidArgumentException('Invalid history query');
            }
            $q[$key] = $value;
        }
        $period = $q['period'] ?? '';
        $zone = $q['tz'] ?? 'Europe/Vienna';
        if (!in_array($period, ['hour', 'day', 'week', 'month', 'year', 'custom'], true) ||
            !in_array($zone, ['Europe/Vienna', 'UTC'], true)) {
            throw new \InvalidArgumentException('Invalid history query');
        }
        $tz = new \DateTimeZone($zone);
        $now ??= new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        if ($period === 'custom') {
            $utc = isset($q['from'], $q['to']);
            $civil = isset($q['date_from'], $q['date_to']);
            $allowed = $utc ? ['period', 'tz', 'from', 'to'] : ['period', 'tz', 'date_from', 'date_to'];
            if ($utc === $civil || array_diff(array_keys($q), $allowed)) {
                throw new \InvalidArgumentException('Invalid history query');
            }
            $from = $utc ? self::utc($q['from']) : self::civil($q['date_from'], 'Y-m-d\TH:i', $tz);
            $to = $utc ? self::utc($q['to']) : self::civil($q['date_to'], 'Y-m-d\TH:i', $tz);
            self::bounds($from, $to, $tz);
            if ($to > $now) {
                throw new \InvalidArgumentException('Future history range');
            }
            return new self($period, 'custom', $zone, $from, $to);
        }
        if (array_diff(array_keys($q), ['period', 'tz', 'date', 'at']) || isset($q['date']) === isset($q['at'])) {
            throw new \InvalidArgumentException('Invalid history query');
        }
        if (isset($q['at']) || ($q['date'] ?? '') === 'now') {
            $anchor = isset($q['at']) ? self::utc($q['at']) : $now;
            if ($anchor > $now) {
                throw new \InvalidArgumentException('Future history anchor');
            }
            $local = $anchor->setTimezone($tz);
            $from = self::floor($local, $period);
        } else {
            $date = $q['date'];
            $format = match ($period) {
                'hour' => 'Y-m-d\TH:00', 'day' => 'Y-m-d', 'month' => 'Y-m', 'year' => 'Y', default => '',
            };
            if ($period === 'week') {
                if (!preg_match('/\A([0-9]{4})-W([0-9]{2})\z/D', $date, $m)) {
                    throw new \InvalidArgumentException('Invalid ISO week');
                }
                $from = (new \DateTimeImmutable('2000-01-03', $tz))->setISODate((int) $m[1], (int) $m[2])->setTime(0, 0);
                if ($from->format('o-\WW') !== $date) {
                    throw new \InvalidArgumentException('Invalid ISO week');
                }
            } else {
                $from = self::civil($date, $format, $tz);
            }
        }
        $to = self::advance($from, $period, 1);
        self::bounds($from, $to, $tz);
        if ($from > $now) {
            throw new \InvalidArgumentException('Future history period');
        }
        $label = $from->format(match ($period) {
            'hour' => 'Y-m-d\TH:00', 'day' => 'Y-m-d', 'week' => 'o-\WW', 'month' => 'Y-m', 'year' => 'Y',
        });
        return new self($period, $label, $zone, $from, $to);
    }

    private static function utc(string $value): \DateTimeImmutable
    {
        return self::civil($value, 'Y-m-d\TH:i:s\Z', new \DateTimeZone('UTC'));
    }

    private static function civil(string $value, string $format, \DateTimeZone $tz): \DateTimeImmutable
    {
        $date = \DateTimeImmutable::createFromFormat('!' . $format, $value, $tz);
        $errors = \DateTimeImmutable::getLastErrors();
        if ($date === false || ($errors !== false && ($errors['warning_count'] || $errors['error_count'])) || $date->format($format) !== $value ||
            (int) $date->format('Y') < 1970 || (int) $date->format('Y') > 9998) {
            throw new \InvalidArgumentException('Invalid calendar date');
        }
        return $date;
    }

    private static function bounds(\DateTimeImmutable $from, \DateTimeImmutable $to, \DateTimeZone $tz): void
    {
        $local = $from->setTimezone($tz);
        if ((int) $local->format('Y') < 1970 || (int) $local->format('Y') > 9998 || $to <= $from || $to > $local->modify('+1 year')) {
            throw new \InvalidArgumentException('Invalid calendar range');
        }
    }

    public static function floor(\DateTimeImmutable $local, string $period): \DateTimeImmutable
    {
        if ($period === 'hour') {
            // Subtract elapsed seconds: setTime() can change the offset of a repeated hour.
            return $local->setTimestamp($local->getTimestamp() - (int) $local->format('i') * 60 - (int) $local->format('s'));
        }
        $day = $local->setTime(0, 0);
        return match ($period) {
            'day' => $day,
            'week' => $day->modify('-' . ((int) $day->format('N') - 1) . ' days'),
            'month' => $day->modify('first day of this month'),
            'year' => $day->setDate((int) $day->format('Y'), 1, 1),
            default => throw new \InvalidArgumentException('Invalid period'),
        };
    }

    private static function advance(\DateTimeImmutable $from, string $period, int $direction): \DateTimeImmutable
    {
        return $period === 'hour' ? $from->setTimestamp($from->getTimestamp() + 3600 * $direction) :
            $from->modify(($direction > 0 ? '+' : '-') . '1 ' . $period);
    }

    public function resolution(): int
    {
        return in_array($this->period, ['hour', 'day'], true) ||
            ($this->period === 'custom' && $this->to->getTimestamp() - $this->from->getTimestamp() <= 86400) ? 60 : 3600;
    }

    /** Half-open bins, local midnight boundaries for year/long custom, elapsed bins otherwise. */
    public function bins(): array
    {
        $duration = $this->to->getTimestamp() - $this->from->getTimestamp();
        $step = match ($this->period) {
            'hour' => 60, 'day' => 300, 'week' => 3600, 'month' => 7200, 'year' => 0,
            default => $duration <= 3600 ? 60 : ($duration <= 86400 ? 300 : ($duration <= 7 * 86400 ? 3600 : ($duration <= 31 * 86400 ? 7200 : 0))),
        };
        $bins = [];
        $cursor = $this->from;
        while ($cursor < $this->to) {
            if (count($bins) >= 512) {
                throw new \UnexpectedValueException('Too many history bins');
            }
            $end = $step === 0 ? $cursor->setTimezone(new \DateTimeZone($this->timezone))->modify('tomorrow')->setTime(0, 0) :
                $cursor->setTimestamp($cursor->getTimestamp() + $step);
            if ($this->period === 'custom' && $step > 0) {
                $stamp = $cursor->getTimestamp();
                $end = $cursor->setTimestamp($stamp + $step - ($stamp % $step + $step) % $step);
            }
            $end = min($end, $this->to);
            $bins[] = [$cursor->getTimestamp(), $end->getTimestamp()];
            $cursor = $end;
        }
        return $bins;
    }

    public function envelope(string $status, \DateTimeImmutable $now): array
    {
        $nav = null;
        if ($this->period !== 'custom') {
            $nav = [
                'previous' => ['period' => $this->period, 'at' => self::iso(self::advance($this->from, $this->period, -1)), 'tz' => $this->timezone],
                'next' => $this->to <= $now ? ['period' => $this->period, 'at' => self::iso($this->to), 'tz' => $this->timezone] : null,
                'now' => ['period' => $this->period, 'date' => 'now', 'tz' => $this->timezone],
            ];
        }
        return ['schema_version' => 2, 'read_only' => true, 'status' => $status,
            'reason' => match ($status) { 'ok' => 'Historische Wallbox-Messdaten', 'disabled' => 'SQL-Verlauf ist deaktiviert', default => 'SQL-Verlauf ist nicht verfügbar' },
            'generated_at' => self::iso($now),
            'range' => ['from' => self::iso($this->from), 'to' => self::iso($this->to), 'timezone' => $this->timezone],
            'selection' => ['period' => $this->period, 'date' => $this->label, 'timezone' => $this->timezone],
            'navigation' => $nav, 'aggregation' => 'sample_mean', 'complete' => false,
            'progress' => ['samples_done' => false, 'events_done' => false], 'buckets' => []];
    }
}
