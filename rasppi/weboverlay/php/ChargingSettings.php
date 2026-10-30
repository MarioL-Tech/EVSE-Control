<?php
declare(strict_types=1);
namespace EvseOverlay;

require_once __DIR__ . '/StrictJson.php';

/** Non-secret rule drafts, NOT an active charging controller. */
final class ChargingSettings
{
    public function __construct(private readonly string $root, private readonly bool $enabled) {}

    public static function defaults(): array
    {
        $limits = ['max_import_w' => null, 'max_current_ma' => null,
            'adjust_seconds' => null, 'pause_seconds' => null, 'resume_seconds' => null];
        return ['schema_version' => 1, 'timezone' => 'Europe/Vienna',
            'manual' => ['current_ma' => null], 'pv' => $limits,
            'custom' => [...$limits, 'use_schedule' => null, 'pv_enabled' => null,
                'weekdays' => [], 'windows' => [], 'outside_window' => null]];
    }

    private static function keys(mixed $object, array $keys): bool
    {
        if (!$object instanceof \stdClass) return false;
        $actual = array_keys(get_object_vars($object)); sort($actual); sort($keys);
        return $actual === $keys;
    }

    public static function validate(mixed $v): array
    {
        $defaults = self::defaults();
        if (!self::keys($v, array_keys($defaults)) || $v->schema_version !== 1 ||
            $v->timezone !== 'Europe/Vienna') throw new \InvalidArgumentException();
        foreach (['manual', 'pv', 'custom'] as $profile) {
            if (!self::keys($v->$profile, array_keys($defaults[$profile]))) throw new \InvalidArgumentException();
            foreach (get_object_vars($v->$profile) as $key => $value) {
                $range = match ($key) {
                    'current_ma', 'max_current_ma' => [6000, 32000],
                    'max_import_w' => [0, 100000],
                    'adjust_seconds', 'pause_seconds', 'resume_seconds' => [0, 3600],
                    default => null,
                };
                if ($range !== null && $value !== null &&
                    (!is_int($value) || $value < $range[0] || $value > $range[1])) throw new \InvalidArgumentException();
            }
        }
        $c = $v->custom;
        foreach (['use_schedule', 'pv_enabled'] as $key)
            if ($c->$key !== null && !is_bool($c->$key)) throw new \InvalidArgumentException();
        if (!in_array($c->outside_window, [null, 'pause', 'manual'], true) ||
            !is_array($c->weekdays) || !array_is_list($c->weekdays) || count($c->weekdays) > 7 ||
            count(array_unique($c->weekdays, SORT_REGULAR)) !== count($c->weekdays) ||
            !is_array($c->windows) || !array_is_list($c->windows) || count($c->windows) > 16) throw new \InvalidArgumentException();
        foreach ($c->weekdays as $day) if (!is_int($day) || $day < 1 || $day > 7) throw new \InvalidArgumentException();
        $seen = [];
        foreach ($c->windows as $window) {
            if (!self::keys($window, ['from', 'to'])) throw new \InvalidArgumentException();
            foreach (['from', 'to'] as $key)
                if (!is_string($window->$key) || !preg_match('/\A(?:[01][0-9]|2[0-3]):[0-5][0-9]\z/D', $window->$key)) throw new \InvalidArgumentException();
            $pair = $window->from . '-' . $window->to;
            if ($window->from === $window->to || isset($seen[$pair])) throw new \InvalidArgumentException();
            $seen[$pair] = true;
        }
        return json_decode(json_encode($v, JSON_THROW_ON_ERROR), true, 16, JSON_THROW_ON_ERROR);
    }

    private static function regular(array|false $s): bool
    {
        return $s !== false && ($s['mode'] & 0170000) === 0100000 && $s['nlink'] === 1;
    }

    private static function stat(string $path): array|false
    {
        clearstatcache(true, $path); return @lstat($path);
    }

    private static function fail(): never { throw new \RuntimeException(); }

    /** Cooperating writers use the same persistent lock; no hostile-same-UID CAS promise. */
    public function operate(?string $revision = null, ?array $changes = null): array
    {
        if (!$this->enabled) return ['status' => 'disabled', 'revision' => null, 'config' => self::defaults()];
        $lock = null; $temp = null;
        try {
            $uid = posix_geteuid();
            foreach ([$this->root, $this->root . '/weboverlay'] as $dir) {
                $s = self::stat($dir);
                if (!$s || realpath($dir) !== $dir || ($s['mode'] & 0170000) !== 0040000 ||
                    $s['uid'] !== $uid || ($s['mode'] & 0022)) self::fail();
            }
            $dir = $this->root . '/weboverlay';
            $path = $dir . '/charging.json'; $lockPath = $dir . '/charging.lock';
            $ls = self::stat($lockPath);
            if ($ls !== false && (!self::regular($ls) || $ls['uid'] !== $uid || ($ls['mode'] & 0077))) self::fail();
            $oldMask = umask(0077);
            try { $lock = @fopen($lockPath, 'c+b'); } finally { umask($oldMask); }
            if (!$lock) self::fail();
            $ls = self::stat($lockPath); $fs = fstat($lock);
            if (!self::regular($ls) || $ls['uid'] !== $uid || ($ls['mode'] & 0077) ||
                !$fs || $ls['ino'] !== $fs['ino'] || $ls['dev'] !== $fs['dev']) self::fail();
            $until = hrtime(true) + 200000000;
            while (!flock($lock, LOCK_EX | LOCK_NB)) {
                if (hrtime(true) >= $until) return ['status' => 'busy'];
                usleep(2000);
            }
            $read = static function () use ($path, $uid): ?string {
                $s = self::stat($path);
                if ($s === false) return null;
                if (!self::regular($s) || $s['uid'] !== $uid || ($s['mode'] & 0022) || $s['size'] > 16384) self::fail();
                $f = @fopen($path, 'rb'); if (!$f) self::fail();
                try {
                    $fs = fstat($f);
                    if (!$fs || $s['ino'] !== $fs['ino'] || $s['dev'] !== $fs['dev']) self::fail();
                    $body = stream_get_contents($f, 16385);
                    if ($body === false || strlen($body) > 16384) self::fail();
                    return $body;
                } finally { fclose($f); }
            };
            $body = $read();
            $current = $body === null ? null : hash('sha256', $body);
            $config = $body === null ? self::defaults() : self::validate(StrictJson::decode($body));
            if ($changes !== null) {
                if ($revision !== $current) return ['status' => 'conflict'];
                $config = self::validate(json_decode(json_encode($changes, JSON_THROW_ON_ERROR), false, 16, JSON_THROW_ON_ERROR));
                $encoded = json_encode($config, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES) . "\n";
                if (strlen($encoded) > 16384) self::fail();
                $temp = @tempnam($dir, '.charging-'); if (!$temp || dirname($temp) !== $dir) self::fail();
                $f = @fopen($temp, 'wb'); if (!$f) self::fail();
                try {
                    if (!@chmod($temp, 0640) || @fwrite($f, $encoded) !== strlen($encoded) || !@fflush($f) || !@fsync($f)) self::fail();
                } finally { fclose($f); }
                $again = $read();
                if (($again === null ? null : hash('sha256', $again)) !== $current) return ['status' => 'conflict'];
                if (!@rename($temp, $path)) self::fail();
                $temp = null; $current = hash('sha256', $encoded);
            }
            return ['status' => 'ok', 'revision' => $current, 'config' => $config];
        } catch (\Throwable) { return ['status' => 'unavailable']; }
        finally {
            if ($temp !== null) @unlink($temp);
            if (is_resource($lock)) { flock($lock, LOCK_UN); fclose($lock); }
        }
    }
}
