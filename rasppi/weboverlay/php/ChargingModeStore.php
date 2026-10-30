<?php
declare(strict_types=1);
namespace EvseOverlay;

require_once __DIR__ . '/ChargingSettings.php';

/** Persisted activation intent, never a hardware acknowledgement or restart permission. */
final class ChargingModeStore
{
    public function __construct(private readonly string $root, private readonly bool $enabled) {}

    public static function encode(array $value): string
    {
        return json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES) . "\n";
    }

    public static function draftRevision(array $draft): string
    {
        return $draft['revision'] ?? hash('sha256', self::encode(ChargingSettings::defaults()));
    }

    private static function initial(): array
    {
        $config = ChargingSettings::defaults();
        return ['schema_version' => 1, 'id' => str_repeat('0', 32), 'mode' => 'manual', 'guard' => str_repeat('0', 32),
            'config_revision' => hash('sha256', self::encode($config)), 'config' => $config];
    }

    public static function required(string $mode, array $config): array
    {
        if ($mode === 'manual') return [];
        $required = [];
        if ($config['installation']['phases'] === null) $required[] = 'installation.phases';
        $p = $config[$mode];
        if ($mode === 'pv' || $p['pv_enabled'] === true) {
            if ($config['installation']['meter_includes_wallbox'] === null) $required[] = 'installation.meter_includes_wallbox';
            if ($p['max_import_w'] === null) $required[] = "$mode.max_import_w";
        }
        foreach (['max_current_ma', 'adjust_seconds', 'pause_seconds', 'resume_seconds'] as $key)
            if ($p[$key] === null) $required[] = "$mode.$key";
        if ($mode === 'custom') {
            foreach (['use_schedule', 'pv_enabled'] as $key) if ($p[$key] === null) $required[] = "custom.$key";
            if ($p['use_schedule'] === true) {
                foreach (['weekdays', 'windows'] as $key) if ($p[$key] === []) $required[] = "custom.$key";
                if ($p['outside_window'] === null) $required[] = 'custom.outside_window';
            }
        }
        return $required;
    }

    private static function stat(string $path): array|false { clearstatcache(true, $path); return @lstat($path); }
    private static function regular(array|false $s, int $uid): bool
    {
        return $s !== false && ($s['mode'] & 0170000) === 0100000 && $s['nlink'] === 1 && $s['uid'] === $uid;
    }
    private static function fail(): never { throw new \RuntimeException(); }

    /** Lock order: draft first, then active. No arbitrary paths or recursive revision field. */
    public function activate(string $mode, ?string $revision, string $configRevision, string $guard): array
    {
        if (!in_array($mode, ['manual', 'pv', 'custom'], true) ||
            !preg_match('/\A[a-f0-9]{32}\z/D', $guard) ||
            !preg_match('/\A[a-f0-9]{64}\z/D', $configRevision) ||
            ($revision !== null && !preg_match('/\A[a-f0-9]{64}\z/D', $revision))) return ['status' => 'invalid'];
        return (new ChargingSettings($this->root, $this->enabled))->operate(snapshot:
            function (array $draft, callable $recheck) use ($mode, $revision, $configRevision, $guard): array {
                if (self::draftRevision($draft) !== $configRevision) return ['status' => 'conflict'];
                $required = self::required($mode, $draft['config']);
                if ($required !== []) return ['status' => 'invalid', 'reason' => 'missing_configuration', 'required' => $required];
                $active = ['schema_version' => 1, 'id' => bin2hex(random_bytes(16)), 'mode' => $mode, 'guard' => $guard,
                    'config_revision' => $configRevision, 'config' => $draft['config']];
                return $this->operate($revision, $active, $recheck);
            });
    }

    public function read(): array { return $this->operate(); }

    private function operate(?string $revision = null, ?array $active = null, ?callable $recheck = null): array
    {
        if (!$this->enabled) return ['status' => 'disabled'];
        $lock = null; $temp = null;
        try {
            $uid = posix_geteuid(); $dir = $this->root . '/weboverlay';
            foreach ([$this->root, $dir] as $d) {
                $s = self::stat($d);
                if (!$s || realpath($d) !== $d || ($s['mode'] & 0170000) !== 0040000 ||
                    $s['uid'] !== $uid || ($s['mode'] & 0022)) self::fail();
            }
            $path = $dir . '/charging-active.json'; $lockPath = $dir . '/charging-active.lock';
            $ls = self::stat($lockPath);
            if ($ls !== false && (!self::regular($ls, $uid) || ($ls['mode'] & 0077))) self::fail();
            $mask = umask(0077);
            try { $lock = @fopen($lockPath, 'c+b'); } finally { umask($mask); }
            if (!$lock) self::fail();
            $ls = self::stat($lockPath); $fs = fstat($lock);
            if (!self::regular($ls, $uid) || ($ls['mode'] & 0077) || !$fs ||
                $ls['ino'] !== $fs['ino'] || $ls['dev'] !== $fs['dev']) self::fail();
            $until = hrtime(true) + 200000000;
            while (!flock($lock, LOCK_EX | LOCK_NB)) {
                if (hrtime(true) >= $until) return ['status' => 'busy'];
                usleep(2000);
            }
            $read = static function () use ($path, $uid): ?string {
                $s = self::stat($path); if ($s === false) return null;
                if (!self::regular($s, $uid) || ($s['mode'] & 0022) || $s['size'] > 16384) self::fail();
                $f = @fopen($path, 'rb'); if (!$f) self::fail();
                try {
                    $fs = fstat($f);
                    if (!$fs || $s['ino'] !== $fs['ino'] || $s['dev'] !== $fs['dev']) self::fail();
                    $body = stream_get_contents($f, 16385);
                    if ($body === false || strlen($body) > 16384) self::fail();
                    return $body;
                } finally { fclose($f); }
            };
            $body = $read(); $current = $body === null ? null : hash('sha256', $body);
            $stored = self::initial();
            if ($body !== null) {
                $v = StrictJson::decode($body);
                if (!$v instanceof \stdClass) self::fail();
                $keys = array_keys(get_object_vars($v)); sort($keys);
                if ($keys !== ['config', 'config_revision', 'guard', 'id', 'mode', 'schema_version'] || $v->schema_version !== 1 ||
                    !is_string($v->guard) || !preg_match('/\A[a-f0-9]{32}\z/D', $v->guard) ||
                    !is_string($v->id) || !preg_match('/\A[a-f0-9]{32}\z/D', $v->id) ||
                    !is_string($v->config_revision) || !preg_match('/\A[a-f0-9]{64}\z/D', $v->config_revision) ||
                    !in_array($v->mode, ['manual', 'pv', 'custom'], true)) self::fail();
                $config = ChargingSettings::validate($v->config);
                if (self::required($v->mode, $config) !== []) self::fail();
                $stored = ['schema_version' => 1, 'id' => $v->id, 'mode' => $v->mode, 'guard' => $v->guard,
                    'config_revision' => $v->config_revision, 'config' => $config];
            }
            if ($active !== null) {
                if ($revision !== $current) return ['status' => 'conflict'];
                $encoded = self::encode($active); if (strlen($encoded) > 16384) self::fail();
                $temp = @tempnam($dir, '.charging-active-');
                if (!$temp || dirname($temp) !== $dir) self::fail();
                $f = @fopen($temp, 'wb'); if (!$f) self::fail();
                try {
                    if (!@chmod($temp, 0640) || @fwrite($f, $encoded) !== strlen($encoded) || !@fflush($f) || !@fsync($f)) self::fail();
                } finally { fclose($f); }
                $again = $read();
                if (($again === null ? null : hash('sha256', $again)) !== $current || !$recheck()) return ['status' => 'conflict'];
                if (!@rename($temp, $path)) self::fail();
                $temp = null; $stored = $active; $current = hash('sha256', $encoded);
            }
            return ['status' => 'ok', 'mode_revision' => $current, 'active' => $stored];
        } catch (\Throwable) { return ['status' => 'unavailable']; }
        finally {
            if ($temp !== null) @unlink($temp);
            if (is_resource($lock)) { flock($lock, LOCK_UN); fclose($lock); }
        }
    }
}
