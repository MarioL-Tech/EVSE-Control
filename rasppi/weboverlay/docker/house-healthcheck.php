<?php
declare(strict_types=1);

// Read-only process liveness, deliberately independent of HTTP/MQTT success.
$file = '/tmp/evse-house-publisher/health.json';
try {
    clearstatcache(true, $file);
    $directory = dirname($file);
    $owner = fileowner('/proc/self');
    $directoryMode = @fileperms($directory);
    $fileMode = @fileperms($file);
    $size = @filesize($file);
    if ($owner === false || is_link($directory) || is_link($file) || !is_file($file)
        || $directoryMode === false || ($directoryMode & 0777) !== 0700
        || @fileowner($directory) !== $owner || @fileowner($file) !== $owner
        || $fileMode === false || ($fileMode & 0170000) !== 0100000 || ($fileMode & 0077) !== 0
        || !is_int($size) || $size < 2 || $size > 1024) { exit(1); }
    $stream = @fopen($file, 'rb');
    if ($stream === false) { exit(1); }
    try { $raw = stream_get_contents($stream, 1025); } finally { fclose($stream); }
    $data = json_decode($raw, true, 8, JSON_THROW_ON_ERROR);
    if (!is_array($data) || array_keys($data) !== ['schema_version', 'pid', 'running', 'heartbeat']) { exit(1); }
    $timeout = getenv('SMARTMETER_TIMEOUT_SECONDS');
    if ($timeout !== false && !preg_match('/\A[1-5]\z/D', $timeout)) { exit(1); }
    $age = hrtime(true) - ($data['heartbeat'] ?? 0);
    exit(($data['schema_version'] ?? null) === 1 && ($data['running'] ?? false) === true
        && is_int($data['heartbeat'] ?? null) && is_int($data['pid'] ?? null)
        && $data['pid'] > 0 && is_dir('/proc/' . $data['pid'])
        && $age >= 0 && $age < (max(3, (int) ($timeout ?: 2) + 2) * 1e9) ? 0 : 1);
} catch (Throwable) { exit(1); }
