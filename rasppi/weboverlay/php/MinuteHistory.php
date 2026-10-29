<?php
declare(strict_types=1);

namespace EvseOverlay;

require_once __DIR__ . '/StrictJson.php';

/** Optional immutable minute products. Never manufactures raw observations or live freshness. */
final class MinuteHistory
{
    public const SCHEMA_SHA256 = '5545065cfe9d3808adadec0c64f30379b0993be048ed1e778c73200c2f3a1460';
    public const FIELDS = ['active_power_w','session_energy_wh','current_limit_a',
        'current_l1_a','current_l2_a','current_l3_a','voltage_l1_v','voltage_l2_v','voltage_l3_v',
        'plugged_in','charging','below_commanded_current','error_code','charging_state','charging_state_raw','socket_lock_state'];
    private const MEAN = ['active_power_w','current_l1_a','current_l2_a','current_l3_a','voltage_l1_v','voltage_l2_v','voltage_l3_v'];
    private const FLAGS = ['plugged_in','charging','below_commanded_current'];

    private static function fail(): never { throw new \UnexpectedValueException('Invalid minute history'); }
    private static function keys(mixed $v, array $keys): void
    {
        if (!is_array($v)) { self::fail(); }
        $actual = array_keys($v); sort($actual); sort($keys);
        if ($actual !== $keys) { self::fail(); }
    }
    private static function count(mixed $v, int $max = 128): int
    {
        if (!is_int($v) || $v < 0 || $v > $max) { self::fail(); }
        return $v;
    }
    private static function flag(mixed $v): bool
    {
        if (!is_bool($v)) { self::fail(); }
        return $v;
    }
    public static function date(mixed $v, bool $iso = false): \DateTimeImmutable
    {
        $format = $iso ? 'Y-m-d\TH:i:s.u\Z' : 'Y-m-d H:i:s.u';
        if (!is_string($v)) { self::fail(); }
        $d = \DateTimeImmutable::createFromFormat('!' . $format, $v, new \DateTimeZone('UTC'));
        if (!$d || $d->format($format) !== $v || (int) $d->format('Y') < 1970 || (int) $d->format('Y') > 9998) { self::fail(); }
        return $d;
    }
    private static function minute(\DateTimeImmutable $d): void
    {
        if ($d->format('s.u') !== '00.000000') { self::fail(); }
    }
    private static function iso(\DateTimeImmutable $d): string { return $d->format('Y-m-d\TH:i:s.u\Z'); }
    private static function compare(string $a, string $b): int
    {
        $parts = static function (string $s): array {
            $negative = str_starts_with($s, '-');
            [$i, $f] = array_pad(explode('.', ltrim($s, '-'), 2), 2, '');
            $i = ltrim($i, '0') ?: '0'; $f = rtrim($f, '0');
            return [$negative && ($i !== '0' || $f !== ''), $i, $f];
        };
        [$na, $ia, $fa] = $parts($a); [$nb, $ib, $fb] = $parts($b);
        if ($na !== $nb) { return $na ? -1 : 1; }
        $width = max(strlen($fa), strlen($fb));
        $cmp = (strlen($ia) <=> strlen($ib)) ?: strcmp($ia, $ib) ?: strcmp(str_pad($fa, $width, '0'), str_pad($fb, $width, '0'));
        return $na ? -$cmp : $cmp;
    }
    private static function times(string $v, int $n): string
    {
        $negative = str_starts_with($v, '-');
        $v = ltrim($v, '-'); $places = str_contains($v, '.') ? strlen(explode('.', $v)[1]) : 0;
        $digits = str_replace('.', '', $v); $carry = 0; $out = '';
        for ($i = strlen($digits) - 1; $i >= 0; --$i) {
            $product = (int) $digits[$i] * $n + $carry;
            $out = (string) ($product % 10) . $out; $carry = intdiv($product, 10);
        }
        $out = (string) $carry . $out;
        if ($places) { $out = substr($out, 0, -$places) . '.' . substr($out, -$places); }
        return ($negative ? '-' : '') . $out;
    }
    private static function number(mixed $v, bool $signed = false, string $maximum = '9007199254740991', int $places = 12): float
    {
        if (!is_string($v) || strlen($v) > 80 || !preg_match($signed ? '/\A-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?\z/D' : '/\A(?:0|[1-9][0-9]*)(?:\.[0-9]+)?\z/D', $v) ||
            (str_contains($v, '.') && strlen(explode('.', $v)[1]) > $places)) { self::fail(); }
        // history.validate uses canonical nonnegative decimal_string values;
        // HOUSE deliberately retains its Decimal scale, including trailing zeros.
        if (!$signed && str_contains($v, '.') && str_ends_with($v, '0')) { self::fail(); }
        $n = (float) $v;
        if (!is_finite($n) || self::compare(ltrim($v, '-'), $maximum) > 0) { self::fail(); }
        return $n;
    }
    private static function bounds(array $d, \DateTimeImmutable $start): void
    {
        $first = $d['first_at']; $last = $d['last_at'];
        if ($d['samples'] === 0) {
            if ($first !== null || $last !== null) { self::fail(); }
        } else {
            $a = self::date($first, true); $b = self::date($last, true);
            if ($a < $start || $a > $b || $b >= $start->modify('+1 minute')) { self::fail(); }
        }
    }

    /** Validate the persisted writer contract before projection; NULL evidence survives a known mean. */
    public static function sample(string $kind, array $row): array
    {
        if (!in_array($kind, ['wallbox','house'], true)) { self::fail(); }
        $start = self::date($row['bucket_start'] ?? null); self::minute($start);
        $text = $row['data_json'] ?? null; $digest = $row['digest'] ?? null;
        if (!is_string($text) || strlen($text) > 32768 || !is_string($digest) || strlen($digest) !== 32 ||
            !hash_equals(hash('sha256', $text, true), $digest)) { self::fail(); }
        StrictJson::decode($text);
        $d = json_decode($text, true, 16, JSON_THROW_ON_ERROR);
        $breaks = []; $values = [];
        if ($kind === 'wallbox') {
            self::keys($d, ['schema_version','samples','valid_samples','error_samples','retained_samples','first_at','last_at','has_gap','complete','coverage_seconds','metrics']);
            if ($d['schema_version'] !== 1) { self::fail(); }
            foreach (['samples','valid_samples','error_samples','retained_samples'] as $k) { self::count($d[$k]); }
            if ($d['samples'] !== $d['valid_samples'] + $d['error_samples'] || $d['retained_samples'] > $d['samples']) { self::fail(); }
            $coverage = self::number($d['coverage_seconds'], false, '60');
            self::keys($d['metrics'], self::FIELDS);
            foreach (self::FIELDS as $field) {
                $m = $d['metrics'][$field]; self::keys($m, ['n','nulls','sum','min','max','first','last','mixed']);
                $n = self::count($m['n']); $nulls = self::count($m['nulls']); $mixed = self::flag($m['mixed']);
                if ($n + $nulls !== $d['samples']) { self::fail(); }
                $max = in_array($field, self::FLAGS, true) ? '1' : (str_starts_with($field, 'current_') ? '4294967.295' : (str_starts_with($field, 'voltage_') ? '429496729.5' : '4294967295'));
                $places = str_starts_with($field, 'current_') ? 3 : (str_starts_with($field, 'voltage_') ? 1 : 0);
                $v = [];
                foreach (['min','max','first','last'] as $k) {
                    $v[$k] = $m[$k] === null ? null : self::number($m[$k], false, $max, $places);
                    if ((in_array($k, ['min','max'], true) && (($v[$k] === null) !== ($n === 0))) ||
                        ($v[$k] !== null && $n === 0) || ($v[$k] === null && $n > 0 && $nulls === 0)) { self::fail(); }
                }
                if ($n && (self::compare($m['min'], $m['max']) > 0 || $mixed !== (self::compare($m['min'], $m['max']) !== 0))) { self::fail(); }
                if (!$n && $mixed) { self::fail(); }
                foreach (['first','last'] as $k) {
                    if ($v[$k] !== null && (self::compare($m[$k], $m['min']) < 0 || self::compare($m[$k], $m['max']) > 0)) { self::fail(); }
                }
                $mean = in_array($field, self::MEAN, true);
                if ($mean) {
                    $sum = self::number($m['sum'], false, self::times($max, 128));
                    if ((!$n && $sum != 0) || ($n && (self::compare($m['sum'], self::times($m['min'], $n)) < 0 || self::compare($m['sum'], self::times($m['max'], $n)) > 0))) { self::fail(); }
                    $value = $n ? $sum / $n : null;
                } else {
                    if ($m['sum'] !== null) { self::fail(); }
                    $value = $v['last'];
                }
                if ($nulls || !$n || (!$mean && $mixed)) { $breaks[] = $field; }
                $values[$field] = $value === null ? null : (in_array($field, self::FLAGS, true) ? (bool) $value : $value);
            }
            $globalGap = $d['error_samples'] > 0 || $d['retained_samples'] > 0;
            $out = [];
            foreach (self::FIELDS as $field) {
                if (preg_match('/\A(current|voltage)_l([123])_[av]\z/', $field, $m)) {
                    $out[$m[1] === 'current' ? 'current_a' : 'voltage_v'][(int) $m[2] - 1] = $values[$field];
                } else { $out[$field] = $values[$field]; }
            }
            $product = ['values' => $out];
        } else {
            self::keys($d, ['bucket_start','bucket_end','samples','valid_count','null_count','sum_w','min_w','max_w','first_w','last_w','first_at','last_at','coverage_ms','has_gap','complete']);
            if ($d['bucket_start'] !== self::iso($start) || $d['bucket_end'] !== self::iso($start->modify('+1 minute'))) { self::fail(); }
            foreach (['samples','valid_count','null_count'] as $k) { self::count($d[$k]); }
            if ($d['samples'] !== $d['valid_count'] + $d['null_count']) { self::fail(); }
            $coverage = self::count($d['coverage_ms'], 60000) / 1000;
            $n = $d['valid_count']; $v = [];
            foreach (['sum_w','min_w','max_w','first_w','last_w'] as $k) {
                $v[$k] = $d[$k] === null ? null : self::number($d[$k], true, self::times('9007199254740991', $k === 'sum_w' ? 128 : 1), 6);
                if ((in_array($k, ['sum_w','min_w','max_w'], true) && (($v[$k] === null) !== ($n === 0))) || (!$n && $v[$k] !== null) ||
                    ($n && !$d['null_count'] && $v[$k] === null)) { self::fail(); }
            }
            if ($n && (self::compare($d['min_w'], $d['max_w']) > 0 || self::compare($d['sum_w'], self::times($d['min_w'], $n)) < 0 || self::compare($d['sum_w'], self::times($d['max_w'], $n)) > 0)) { self::fail(); }
            foreach (['first_w','last_w'] as $k) { if ($v[$k] !== null && (self::compare($d[$k], $d['min_w']) < 0 || self::compare($d[$k], $d['max_w']) > 0)) { self::fail(); } }
            if ($d['null_count'] || !$n) { $breaks[] = 'power_w'; }
            $globalGap = false;
            $product = ['power_w' => $n ? $v['sum_w'] / $n : null];
        }
        self::bounds($d, $start);
        $complete = self::flag($d['complete']); $gap = self::flag($d['has_gap']) || $globalGap || $coverage < 60;
        if (!$d['samples'] && $coverage != 0) { self::fail(); }
        return array_merge(['id' => (string) (intdiv($start->getTimestamp(), 60) + 1),
            'timestamp' => self::iso($start->modify('+30 seconds')), 'received_at' => self::iso($start->modify('+1 minute')),
            'status' => 'ok', 'break_before' => true,
            'interval' => ['from' => self::iso($start), 'to' => self::iso($start->modify('+1 minute')),
                'complete' => $complete, 'has_gap' => $gap, 'break_fields' => $breaks]], $product);
    }

    /** At most three registry rows, one source and sixteen closed minute products per request. */
    public static function read(callable $select, string $kind, string $source, \DateTimeImmutable $from, \DateTimeImmutable $to): ?array
    {
        if (!in_array($kind, ['wallbox','house'], true) || $source === '' || strlen($source) > 240) { self::fail(); }
        $tables = $select("SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('evse_minute_schema_versions','evse_minute_sources','evse_minute_records') LIMIT 3");
        if (!$tables) { return null; }
        $names = array_column($tables, 'TABLE_NAME'); sort($names);
        if ($names !== ['evse_minute_records','evse_minute_schema_versions','evse_minute_sources']) { self::fail(); }
        foreach ($tables as $t) { if (strtolower($t['ENGINE'] ?? '') !== 'innodb') { self::fail(); } }
        $versions = $select('SELECT version, HEX(checksum) AS checksum, applied_at FROM evse_minute_schema_versions ORDER BY version LIMIT 2');
        if (count($versions) !== 1 || $versions[0]['version'] !== '1' || !is_string($versions[0]['checksum']) ||
            !hash_equals(self::SCHEMA_SHA256, strtolower($versions[0]['checksum']))) { self::fail(); }
        self::date($versions[0]['applied_at']);
        $sources = $select('SELECT started_at FROM evse_minute_sources WHERE kind = ? AND source = CAST(? AS BINARY) LIMIT 2', [$kind, $source]);
        if (!$sources) { return null; }
        if (count($sources) !== 1) { self::fail(); }
        $cutover = self::date($sources[0]['started_at']); self::minute($cutover);
        $a = $from->setTime((int) $from->format('H'), (int) $from->format('i'));
        if ($a < $from) { $a = $a->modify('+1 minute'); }
        $a = max($a, $cutover);
        $b = $to->setTime((int) $to->format('H'), (int) $to->format('i'));
        $rows = $a < $b ? $select('SELECT bucket_start, IF(OCTET_LENGTH(data_json)<=32768,data_json,NULL) AS data_json, digest FROM evse_minute_records WHERE kind = ? AND source = CAST(? AS BINARY) AND bucket_start >= ? AND bucket_start < ? ORDER BY bucket_start LIMIT 17',
            [$kind, $source, $a->format('Y-m-d H:i:s.u'), $b->format('Y-m-d H:i:s.u')]) : [];
        if (count($rows) > 16) { self::fail(); }
        $events = []; $baselines = [];
        $lower = $a->modify('-10 seconds'); $upper = $b->modify('+10 seconds');
        if ($rows) {
            $table = $kind === 'wallbox' ? 'evse_ingest_events' : 'evse_house_events';
            $events = $select('SELECT received_at, kind, availability, retained FROM ' . $table . ' WHERE source = CAST(? AS BINARY) AND received_at >= ? AND received_at <= ? ORDER BY received_at LIMIT 2401',
                [$source, $lower->format('Y-m-d H:i:s.u'), $upper->format('Y-m-d H:i:s.u')]);
            $baselines = $select('SELECT received_at, kind, availability, retained FROM ' . $table . ' WHERE source = CAST(? AS BINARY) AND received_at < ? ORDER BY received_at DESC LIMIT 2',
                [$source, $lower->format('Y-m-d H:i:s.u')]);
        }
        if (count($events) > 2401 || count($baselines) > 2) { self::fail(); }
        // Validate even the truncation sentinel before using timestamp keys or counters.
        $validateEvent = static function (array $e, bool $baseline) use ($lower, $upper): array {
            self::keys($e, ['received_at','kind','availability','retained']);
            $at = self::date($e['received_at']);
            if (($baseline ? $at >= $lower : ($at < $lower || $at > $upper)) ||
                !in_array($e['kind'], ['availability','collector_started','broker_connected','broker_disconnected','ingestion_gap','collector_stopping'], true) ||
                !in_array($e['availability'], [null,'online','offline'], true) ||
                ($e['kind'] === 'availability' && $e['availability'] === null) ||
                !in_array($e['retained'], ['0','1',0,1], true)) { self::fail(); }
            return $e + ['_at' => $at];
        };
        $events = array_map(static fn($e) => $validateEvent($e, false), $events);
        $baselines = array_map(static fn($e) => $validateEvent($e, true), $baselines);
        $samples = []; $previous = null; $seenEvents = [];
        foreach ($events as $event) { $key = $event['received_at']; $seenEvents[$key] = ($seenEvents[$key] ?? 0) + 1; }
        $complete = count($rows) === max(0, intdiv($b->getTimestamp() - $a->getTimestamp(), 60)) && count($events) <= 2400;
        foreach ($rows as $row) {
            $s = self::sample($kind, $row); $start = self::date($row['bucket_start']);
            if ($start < $a || $start >= $b || ($previous !== null && $s['interval']['from'] <= $previous['interval']['from'])) { self::fail(); }
            $localLower = $start->modify('-10 seconds');
            $preceding = array_filter(array_merge($baselines, $events), static fn($e) => $e['_at'] < $localLower);
            if ($preceding) {
                $latest = max(array_column($preceding, '_at'));
                $group = array_values(array_filter($preceding, static fn($e) => $e['_at'] == $latest));
                if (count($group) !== 1 || $group[0]['kind'] !== 'availability' || $group[0]['availability'] !== 'online' ||
                    !in_array($group[0]['retained'], ['0',0], true)) { $s['interval']['has_gap'] = true; }
            }
            foreach ($events as $e) {
                $at = $e['_at'];
                if ($at < $localLower || $at > $start->modify('+70 seconds')) { continue; }
                if ($seenEvents[$e['received_at']] > 1 || $e['kind'] !== 'availability' || $e['availability'] !== 'online' || !in_array($e['retained'], ['0',0], true)) { $s['interval']['has_gap'] = true; }
            }
            if (count($events) > 2400) { $s['interval']['has_gap'] = true; }
            $s['break_before'] = !$previous || $previous['interval']['to'] !== $s['interval']['from'] ||
                !$previous['interval']['complete'] || !$s['interval']['complete'] || $previous['interval']['has_gap'] || $s['interval']['has_gap'];
            $complete = $complete && $s['interval']['complete'];
            $samples[] = $s; $previous = $s;
        }
        return ['cutover' => $cutover, 'samples' => $samples, 'complete' => $complete];
    }

    public static function merge(array $legacy, ?array $capture): array
    {
        if ($capture === null) { return $legacy; }
        $cutover = self::iso($capture['cutover']);
        $samples = array_values(array_filter($legacy['samples'], static fn($s) => $s['timestamp'] < $cutover));
        foreach ($samples as &$s) { $s['interval'] = null; } unset($s);
        $samples = array_merge($samples, $capture['samples']);
        $bounded = count($samples) <= 1200;
        if (!$bounded) { $samples = array_slice($samples, -1200); }
        if ($samples) { $samples[0]['break_before'] = true; }
        return ['schema_version' => 3, 'samples' => $samples, 'complete' => $legacy['complete'] && $capture['complete'] && $bounded];
    }
}
