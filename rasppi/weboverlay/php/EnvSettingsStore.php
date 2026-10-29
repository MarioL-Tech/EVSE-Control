<?php
declare(strict_types=1);

namespace EvseOverlay;

/**
 * Fixed, explicitly provisioned settings-only directory tree, never a project tree.
 * Each existing root/service directory must be owned by the service OS user and not
 * writable by other users. Cooperating writers MUST use the persistent .env.lock.
 * PHP has no portable openat/O_NOFOLLOW: hostile same-UID filesystem writers are
 * outside this boundary. No file contents, paths or exception messages escape it.
 * Saving does not apply/restart services; the deployment owner handles that later.
 */
final class EnvSettingsStore
{
    private const MAX_BYTES = 65536;
    private const MAX_ENTRIES = 512;
    private const MAX_LINES = 2048;
    private const LOCK_NS = 200000000;

    public function __construct(private readonly string $root, private readonly bool $enabled = false) {}

    public function __debugInfo(): array { return ['enabled' => $this->enabled]; }

    public function catalog(): array
    {
        $result = [];
        foreach (EnvSettingsCatalog::SERVICES as $service) {
            $result[$service] = EnvSettingsCatalog::entries($service);
        }
        return ['status' => $this->enabled ? 'ok' : 'disabled', 'services' => $result];
    }

    public function read(string $service): array
    {
        return $this->operate($service, null, null, false);
    }

    /**
     * Omitted keys retain their exact source bytes (especially secrets).
     * Empty string explicitly clears a value; null is not a secret-retention token.
     * Missing file: expectedRevision=null AND create=true are required. Directories
     * are never created. Existing file: exact SHA256 from read() is required.
     */
    public function update(string $service, ?string $expectedRevision, array $changes, bool $create = false): array
    {
        return $this->operate($service, $expectedRevision, $changes, $create);
    }

    private static function fail(string $status = 'unavailable'): never
    {
        throw new \RuntimeException($status);
    }

    private static function stat(string $path): array|false
    {
        clearstatcache(true, $path);
        return @lstat($path);
    }

    private static function regular(array|false $stat): bool
    {
        return $stat !== false && ($stat['mode'] & 0170000) === 0100000 && $stat['nlink'] === 1;
    }

    private static function same(array $a, array $b): bool
    {
        return $a['dev'] === $b['dev'] && $a['ino'] === $b['ino'];
    }

    private function directory(string $service): string
    {
        // realpath equality rejects symlinks in every ancestor, dot segments and relative roots.
        if ($this->root === '' || str_contains($this->root, "\0") ||
            !str_starts_with($this->root, '/') || realpath($this->root) !== $this->root) {
            self::fail();
        }
        foreach ([$this->root, $this->root . '/' . $service] as $path) {
            $stat = self::stat($path);
            if ($stat === false || ($stat['mode'] & 0170000) !== 0040000 ||
                ($stat['mode'] & 0022) !== 0 || realpath($path) !== $path ||
                !function_exists('posix_geteuid') || $stat['uid'] !== posix_geteuid()) {
                self::fail();
            }
        }
        return $this->root . '/' . $service;
    }

    private function lock(string $dir): mixed
    {
        $path = $dir . '/.env.lock';
        $before = self::stat($path);
        if ($before !== false && (!self::regular($before) || ($before['mode'] & 0022) !== 0)) { self::fail(); }
        // Exclusive creation under restrictive umask; never unlink/replace this lock.
        $old = umask(0077);
        try { $stream = @fopen($path, $before === false ? 'x+b' : 'r+b'); }
        finally { umask($old); }
        if ($stream === false) {
            // Another cooperating reader may have just created the persistent lock.
            $before = self::stat($path);
            if (!self::regular($before) || ($before['mode'] & 0022) !== 0) { self::fail(); }
            $stream = @fopen($path, 'r+b');
        }
        if ($stream === false) { self::fail(); }
        try {
            $opened = fstat($stream); $current = self::stat($path);
            if (!self::regular($opened) || !self::regular($current) || !self::same($opened, $current) ||
                ($before !== false && !self::same($before, $opened)) ||
                $opened['uid'] !== posix_geteuid() || !@chmod($path, 0600)) { self::fail(); }
            $deadline = hrtime(true) + self::LOCK_NS;
            do {
                if (@flock($stream, LOCK_EX | LOCK_NB)) { return $stream; }
                usleep(5000);
            } while (hrtime(true) < $deadline);
            self::fail('busy');
        } catch (\Throwable $error) {
            fclose($stream);
            throw $error;
        }
    }

    /** null means absent, not an empty file. Never follow symlinks or read secret files. */
    private function content(string $path): ?string
    {
        $before = self::stat($path);
        if ($before === false) { return null; }
        if (!self::regular($before) || ($before['mode'] & 0022) !== 0 || $before['size'] > self::MAX_BYTES ||
            $before['uid'] !== posix_geteuid()) { self::fail(); }
        $stream = @fopen($path, 'rb');
        if ($stream === false) { self::fail(); }
        try {
            $opened = fstat($stream);
            if (!self::regular($opened) || !self::same($before, $opened)) { self::fail(); }
            $content = stream_get_contents($stream, self::MAX_BYTES + 1);
            $after = self::stat($path);
            if ($content === false || strlen($content) > self::MAX_BYTES ||
                !self::regular($after) || !self::same($opened, $after)) { self::fail(); }
            return $content;
        } finally { fclose($stream); }
    }

    /** Strict single-line dotenv grammar, with byte-exact retention of untouched lines. */
    private function parse(string $content, array $catalog): array
    {
        if (str_contains($content, "\0") || preg_match('//u', $content) !== 1 ||
            preg_match('/\r(?!\n)/', $content)) { self::fail('unsupported'); }
        $lines = preg_split('/(?<=\n)/', $content, -1, PREG_SPLIT_NO_EMPTY);
        if (count($lines) > self::MAX_LINES) { self::fail('limit'); }
        $known = []; $count = 0;
        foreach ($lines as $index => $line) {
            $text = rtrim($line, "\r\n");
            if (preg_match('/\A[ \t]*(?:#.*)?\z/D', $text)) { continue; }
            if (++$count > self::MAX_ENTRIES) { self::fail('limit'); }
            if (!preg_match('/\A([ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*)(.*)\z/D', $text, $m)) {
                self::fail('unsupported');
            }
            $key = $m[2]; $raw = $m[3]; $suffix = ''; $prefix = $m[1];
            if (str_starts_with($raw, '#') && preg_match('/([ \t]+)\z/D', $prefix, $space)) {
                // KEY= # comment means an empty value, unlike KEY=#literal.
                $value = ''; $suffix = $space[1] . $raw;
                $prefix = substr($prefix, 0, -strlen($space[1]));
            } elseif (str_starts_with($raw, "'")) {
                if (!preg_match("/\A'([^'\\\\]*)'([ \t]*(?:#.*)?)\z/D", $raw, $v)) { self::fail('unsupported'); }
                $value = $v[1]; $suffix = $v[2];
            } elseif (str_starts_with($raw, '"')) {
                if (!preg_match('/\A"([^"\\\\]*)"([ \t]*(?:#.*)?)\z/D', $raw, $v)) { self::fail('unsupported'); }
                $value = $v[1]; $suffix = $v[2];
                if (isset($catalog[$key]) && strpbrk($value, '$`') !== false) { self::fail('unsupported'); }
            } else {
                if (!preg_match('/\A(.*?)([ \t]+#.*|[ \t]*)\z/D', $raw, $v)) { self::fail('unsupported'); }
                $value = $v[1]; $suffix = $v[2];
                if (strpbrk($value, "'\"\\") !== false ||
                    (isset($catalog[$key]) && strpbrk($value, '$`') !== false)) { self::fail('unsupported'); }
            }
            if (!isset($catalog[$key])) { continue; }
            if (isset($known[$key])) { self::fail('duplicate'); }
            $eol = str_ends_with($line, "\r\n") ? "\r\n" : (str_ends_with($line, "\n") ? "\n" : '');
            $known[$key] = ['index' => $index, 'value' => $value, 'prefix' => $prefix, 'suffix' => $suffix, 'eol' => $eol];
        }
        return [$lines, $known];
    }

    private function snapshot(string $service, ?string $content, array $catalog, array $known): array
    {
        $entries = [];
        foreach ($catalog as $key => $definition) {
            $present = isset($known[$key]);
            $entry = ['present' => $present, 'configured' => $present && $known[$key]['value'] !== '',
                'readonly' => $definition['readonly'], 'secret' => $definition['secret']];
            if (!$definition['secret']) { $entry['value'] = $present ? $known[$key]['value'] : null; }
            $entries[$key] = $entry;
        }
        return ['status' => $content === null ? 'missing' : 'ok', 'service' => $service,
            'revision' => $content === null ? null : hash('sha256', $content), 'entries' => $entries];
    }

    private function operate(string $service, ?string $revision, ?array $changes, bool $create): array
    {
        if (!$this->enabled) { return ['status' => 'disabled']; }
        $catalog = EnvSettingsCatalog::entries($service);
        if ($catalog === []) { return ['status' => 'invalid_service']; }
        $lock = null; $temp = null;
        try {
            if ($changes !== null && (count($changes) > count($catalog) ||
                ($revision !== null && !preg_match('/\A[0-9a-f]{64}\z/D', $revision)))) { self::fail('invalid'); }
            $dir = $this->directory($service);
            $lock = $this->lock($dir);
            $path = $dir . '/.env';
            $content = $this->content($path);
            [$lines, $known] = $this->parse($content ?? '', $catalog);
            if ($changes === null) { return $this->snapshot($service, $content, $catalog, $known); }
            if (($content === null && (!$create || $revision !== null)) ||
                ($content !== null && ($revision === null || !hash_equals(hash('sha256', $content), $revision)))) {
                self::fail('conflict');
            }
            $effective = [];
            foreach ($changes as $key => $value) {
                if (!is_string($key) || !isset($catalog[$key]) || $catalog[$key]['readonly'] || !is_string($value)) {
                    self::fail('invalid');
                }
                // No-op preserves existing deployment values without stricter revalidation/requoting.
                if (isset($known[$key]) && $known[$key]['value'] === $value) { continue; }
                if (!EnvSettingsCatalog::valid($catalog[$key], $value)) { self::fail('invalid'); }
                $effective[$key] = $value;
            }
            $this->validateRelated($service, $known, $effective);
            if ($effective === [] && $content !== null) {
                return $this->snapshot($service, $content, $catalog, $known);
            }
            $eol = str_contains($content ?? '', "\r\n") ? "\r\n" : "\n";
            foreach ($effective as $key => $value) {
                $literal = "'" . $value . "'";
                if (isset($known[$key])) {
                    $entry = $known[$key];
                    $lines[$entry['index']] = $entry['prefix'] . $literal . $entry['suffix'] . $entry['eol'];
                } else {
                    $last = count($lines) - 1;
                    if ($last >= 0 && !str_ends_with($lines[$last], "\n")) { $lines[$last] .= $eol; }
                    $lines[] = $key . '=' . $literal . $eol;
                }
            }
            $next = implode('', $lines);
            if (strlen($next) > self::MAX_BYTES) { self::fail('limit'); }
            [, $nextKnown] = $this->parse($next, $catalog);
            // Recheck bytes before commit; catches non-cooperating edits observed during this transaction.
            if ($this->content($path) !== $content) { self::fail('conflict'); }
            $temp = $dir . '/.env.tmp-' . bin2hex(random_bytes(16));
            $old = umask(0077);
            try { $stream = @fopen($temp, 'x+b'); } finally { umask($old); }
            if ($stream === false) { self::fail(); }
            try {
                if (!@chmod($temp, 0600)) { self::fail(); }
                $offset = 0;
                while ($offset < strlen($next)) {
                    $written = @fwrite($stream, substr($next, $offset));
                    if ($written === false || $written === 0) { self::fail(); }
                    $offset += $written;
                }
                if (!@fflush($stream) || !@fsync($stream)) { self::fail(); }
            } finally { fclose($stream); }
            if (!@rename($temp, $path)) { self::fail(); }
            $temp = null;
            return $this->snapshot($service, $next, $catalog, $nextKnown);
        } catch (\Throwable $error) {
            // Never propagate filesystem paths, raw values, traces or arbitrary exception text.
            $status = $error instanceof \RuntimeException && in_array($error->getMessage(),
                ['busy', 'unsupported', 'limit', 'duplicate', 'conflict', 'invalid'], true)
                ? $error->getMessage() : 'unavailable';
            return ['status' => $status];
        } finally {
            if ($temp !== null) { @unlink($temp); }
            if (is_resource($lock)) { @flock($lock, LOCK_UN); fclose($lock); }
        }
    }

    private function validateRelated(string $service, array $known, array $changes): void
    {
        $get = static fn(string $key, string $default = ''): string =>
            $changes[$key] ?? ($known[$key]['value'] ?? $default);
        if ($service === 'wallbox' &&
            (isset($changes['WALLBOX_INTERVAL_MS']) || isset($changes['WALLBOX_TIMEOUT_MS'])) &&
            (float) $get('WALLBOX_TIMEOUT_MS', '1000') >= (float) $get('WALLBOX_INTERVAL_MS', '2000')) {
            self::fail('invalid');
        }
        if ((isset($changes['MQTT_PASSWORD']) || isset($changes['MQTT_USERNAME'])) && $get('MQTT_PASSWORD') !== '' &&
            ($get('MQTT_USERNAME') === '' || $get('MQTT_PASSWORD_FILE') !== '' || $get('MQTT_PASSWORD_HOST_FILE') !== '')) {
            self::fail('invalid');
        }
        if (isset($changes['DB_PASSWORD']) && $get('DB_PASSWORD') !== '' && $get('DB_PASSWORD_FILE') !== '') {
            self::fail('invalid');
        }
    }
}
