<?php
declare(strict_types=1);

/** One-shot, operator-invoked provisioning. Source is mounted READ ONLY. No Docker API. */
final class SettingsProvisioner
{
    private const SERVICES = ['uart' => 'rasppi', 'wallbox' => 'rasppi/wallbox',
        'storage' => 'rasppi/storage', 'weboverlay' => 'rasppi/weboverlay'];

    public static function prepare(string $source, string $root, int $uid, int $gid, ?string $hostSource = null): void
    {
        if ($uid < 1 || $gid < 0 || realpath($source) !== $source || realpath($root) !== $root) {
            throw new RuntimeException('Invalid provisioning root');
        }
        // Validate ALL inputs before creating/changing any file. Existing targets
        // must be identical to regular sources; reruns never overwrite edits.
        $inputs = [];
        foreach (self::SERVICES as $service => $relative) {
            $dir = "$root/$service"; $target = "$dir/.env"; $path = "$source/$relative/.env";
            if (is_link($dir) || (file_exists($dir) && !is_dir($dir)) || is_link($target)) {
                throw new RuntimeException('Unsafe settings path');
            }
            if (is_link($path)) {
                if (readlink($path) !== ($hostSource ?? $source) . "/.evse-settings/$service/.env" ||
                    !is_file($target) || lstat($target)['nlink'] !== 1 || filesize($target) > 65536) {
                    throw new RuntimeException('Unexpected deployment link');
                }
                $inputs[$service] = null;
                continue;
            }
            $value = null;
            if (file_exists($path)) {
                $s = lstat($path);
                if (!$s || ($s['mode'] & 0170000) !== 0100000 || $s['nlink'] !== 1 || $s['size'] > 65536) {
                    throw new RuntimeException('Unsafe deployment file');
                }
                $value = file_get_contents($path);
                if ($value === false || strlen($value) > 65536) { throw new RuntimeException('Cannot read deployment'); }
            }
            if (file_exists($target)) {
                $s = lstat($target);
                if (!$s || ($s['mode'] & 0170000) !== 0100000 || $s['nlink'] !== 1 || $s['size'] > 65536 ||
                    ($value !== null && file_get_contents($target) !== $value)) {
                    throw new RuntimeException('Existing settings differ; nothing overwritten');
                }
                $inputs[$service] = null;
            } else { $inputs[$service] = $value ?? ''; }
        }
        self::directory($root, $uid, $gid);
        foreach ($inputs as $service => $value) {
            $dir = "$root/$service"; self::directory($dir, $uid, $gid);
            if ($value !== null) {
                $old = umask(0077);
                try { $f = fopen("$dir/.env", 'xb'); } finally { umask($old); }
                if ($f === false) { throw new RuntimeException('Cannot create settings'); }
                try {
                    if (fwrite($f, $value) !== strlen($value) || !fflush($f) || !fsync($f)) {
                        throw new RuntimeException('Cannot copy settings');
                    }
                } finally { fclose($f); }
            }
            // Private operator group can read Compose input, never write it.
            // setgid directories preserve that group during atomic editor rename.
            if (!chown("$dir/.env", $uid) || !chgrp("$dir/.env", $gid) || !chmod("$dir/.env", 0640)) {
                throw new RuntimeException('Cannot secure settings');
            }
        }
    }

    private static function directory(string $path, int $uid, int $gid): void
    {
        if (!is_dir($path) && !mkdir($path, 0700)) { throw new RuntimeException('Cannot create settings directory'); }
        if (is_link($path) || !chown($path, $uid) || !chgrp($path, $gid) || !chmod($path, 02750)) {
            throw new RuntimeException('Cannot secure settings directory');
        }
    }
}

if (realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
    try {
        if (posix_geteuid() !== 0 || count($argv) !== 3 || !preg_match('/\A[0-9]{1,9}\z/D', $argv[1]) ||
            !str_starts_with($argv[2], '/') || str_contains($argv[2], "\0")) {
            throw new RuntimeException('Operator provisioning required');
        }
        SettingsProvisioner::prepare('/source', '/run/evse-settings', 10001, (int) $argv[1], $argv[2]);
        fwrite(STDOUT, "Settings-only directories prepared; no containers recreated.\n");
    } catch (Throwable) {
        fwrite(STDERR, "Settings preparation failed; no existing settings overwritten. Check paths, permissions and backups.\n");
        exit(1);
    }
}
