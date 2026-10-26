<?php
declare(strict_types=1);
$context = stream_context_create(['http' => ['timeout' => 2]]);
$port = getenv('EVSE_HTTP_PORT');
$port = $port === false ? '8080' : $port;
if (!preg_match('/^[0-9]+$/D', $port) || (float) $port < 1 || (float) $port > 65535) {
    exit(1);
}
$text = @file_get_contents('http://127.0.0.1:' . (int) $port . '/healthz', false, $context);
$data = $text === false ? null : json_decode($text, true);
exit(is_array($data) && ($data['status'] ?? null) === 'ok' ? 0 : 1);
