<?php
// Streamed to the existing PHP runtime via stdin. Never print telemetry.
declare(strict_types=1);
[$script, $endpoint, $expected] = $argv;
if (!in_array($endpoint, ['history', 'house-history'], true) || !in_array($expected, ['ok', 'disabled'], true)) exit(2);
$body = '';
$ch = curl_init('http://127.0.0.1:8080/api/'.$endpoint.'?minutes=1');
curl_setopt_array($ch, [CURLOPT_NOPROXY => '*', CURLOPT_CONNECTTIMEOUT_MS => 750, CURLOPT_TIMEOUT_MS => 4500,
    CURLOPT_FOLLOWLOCATION => false, CURLOPT_WRITEFUNCTION => static function ($ch, string $chunk) use (&$body): int {
        if (strlen($body) + strlen($chunk) > 1048576) return 0;
        $body .= $chunk;
        return strlen($chunk);
    }]);
$ok = curl_exec($ch) && curl_getinfo($ch, CURLINFO_RESPONSE_CODE) === 200;
$data = $ok ? json_decode($body, true, 64) : null;
exit(is_array($data) && ($data['read_only'] ?? null) === true && ($data['status'] ?? null) === $expected &&
    in_array($data['schema_version'] ?? null, [1, 3], true) ? 0 : 1);
