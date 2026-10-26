<?php
declare(strict_types=1);
$context = stream_context_create(['http' => ['timeout' => 2]]);
$text = @file_get_contents('http://127.0.0.1:8080/healthz', false, $context);
$data = $text === false ? null : json_decode($text, true);
exit(is_array($data) && ($data['status'] ?? null) === 'ok' ? 0 : 1);
