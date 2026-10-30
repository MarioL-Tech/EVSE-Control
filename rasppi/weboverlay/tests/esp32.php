<?php
declare(strict_types=1);

// Pure validation fixture; executed only by the parent's disposable Docker stage.
require_once __DIR__ . '/../vendor/autoload.php';
require_once __DIR__ . '/../php/Esp32MqttTransport.php';

use EvseOverlay\Esp32Http;
use EvseOverlay\Esp32MqttTransport;
use EvseOverlay\Config;

$checks = 0;
function check(bool $ok): void {
    global $checks; ++$checks;
    if (!$ok) { throw new RuntimeException('ESP32 validation fixture failed'); }
}
foreach (['lock', 'unlock', 'enroll', 'cancel'] as $operation) {
    check(Esp32Http::validateCommand(json_encode(['operation' => $operation])) === ['operation' => $operation]);
}
foreach (['01:23:45:67', '01:23:45:67:89:ab:cd', '01:23:45:67:89:ab:cd:ef:01:23'] as $uid) {
    check(Esp32Http::validateCommand(json_encode(['operation' => 'revoke', 'uid' => $uid])) ===
        ['operation' => 'revoke', 'uid' => strtoupper($uid)]);
}
foreach (['[]', '{}', 'null', 'true', '{"operation":false}', '{"operation":1}',
    '{"operation":"inspect"}', '{"operation":"start"}', '{"operation":"lock","uid":null}',
    '{"operation":"revoke"}', '{"operation":"revoke","uid":123}',
    '{"operation":"revoke","uid":["01:23:45:67"]}', '{"operation":"revoke","uid":"01234567"}',
    '{"operation":"revoke","uid":"01:23:45:67:89"}', '{"operation":"revoke","uid":"01:23:45:GG"}',
    '{"operation":"revoke","uid":"01:23:45:67\n"}',
    '{"operation":"lock","operation":"unlock"}', '{"operation":"lock","oper\u0061tion":"lock"}',
    '{"operation":"lock","topic":"secret-marker"}', str_repeat(' ', 1025)] as $body) {
    $rejected = false;
    try { Esp32Http::validateCommand($body); } catch (Throwable) { $rejected = true; }
    check($rejected);
}
check(Esp32Http::originParts('http://example.invalid:8080') === ['authority' => 'example.invalid:8080', 'secure' => false]);
check(Esp32Http::originParts('http://example.invalid/') === null);
$id = str_repeat('a', 32);
$r = (object) ['schema_version' => 1, 'id' => $id, 'operation' => 'inspect', 'status' => 'ok',
    'reason' => 'inspection_complete', 'session' => str_repeat('b', 32), 'lease' => str_repeat('c', 32),
    'fresh_for_seconds' => 8, 'firmware_version' => 2, 'state' => (object) [
        'charging' => false, 'antitheft' => true, 'store_ready' => true, 'cards' => 0,
        'enrolling' => false, 'reader_ready' => true, 'servo_ready' => true],
    'command_sent' => false, 'result_code' => null];
$encode = static fn(object $v): string => json_encode($v, JSON_THROW_ON_ERROR | JSON_PRESERVE_ZERO_FRACTION);
check(Esp32MqttTransport::validateResult($encode($r), $id, 'inspect') instanceof stdClass);
check(Esp32MqttTransport::validateResult($encode($r), str_repeat('d', 32), 'inspect') === null);
foreach (['schema_version' => 2, 'id' => strtoupper($id), 'operation' => 'lock', 'status' => 'raw-secret',
    'reason' => 'raw-secret', 'session' => '-', 'lease' => '-', 'fresh_for_seconds' => 8.0,
    'firmware_version' => 1, 'state' => [], 'command_sent' => 0, 'result_code' => 'raw-secret',
    'uid' => '01:23:45:67'] as $key => $value) {
    $copy = clone $r; $copy->$key = $value;
    check(Esp32MqttTransport::validateResult($encode($copy), $id, 'inspect') === null);
}
foreach (array_keys(get_object_vars($r)) as $key) {
    $copy = clone $r; unset($copy->$key);
    check(Esp32MqttTransport::validateResult($encode($copy), $id, 'inspect') === null);
}
foreach (['charging' => 0, 'antitheft' => 1, 'store_ready' => 'true', 'cards' => -1,
    'enrolling' => [], 'reader_ready' => 1, 'servo_ready' => 'false', 'uid' => '01:23:45:67'] as $key => $value) {
    $copy = clone $r; $copy->state = clone $r->state; $copy->state->$key = $value;
    check(Esp32MqttTransport::validateResult($encode($copy), $id, 'inspect') === null);
}
foreach ([17, 0.0, '0', false] as $value) {
    $copy = clone $r; $copy->state = clone $r->state; $copy->state->cards = $value;
    check(Esp32MqttTransport::validateResult($encode($copy), $id, 'inspect') === null);
}
check(Esp32MqttTransport::validateResult(substr($encode($r), 0, -1) . ',"id":"' . $id . '"}', $id, 'inspect') === null);
check(Esp32MqttTransport::validateResult(str_repeat(' ', 4097), $id, 'inspect') === null);
$unsupported = clone $r;
$unsupported->status = 'unavailable'; $unsupported->reason = 'firmware_unsupported';
$unsupported->lease = null; $unsupported->fresh_for_seconds = 0; $unsupported->firmware_version = null;
$unsupported->state = (object) array_fill_keys(array_keys(get_object_vars($r->state)), null);
check(Esp32MqttTransport::validateResult($encode($unsupported), $id, 'inspect') instanceof stdClass);
$unsupported->lease = str_repeat('c', 32);
check(Esp32MqttTransport::validateResult($encode($unsupported), $id, 'inspect') === null);
foreach (['lock', 'unlock', 'enroll', 'cancel', 'revoke'] as $operation) {
    $copy = clone $r; $copy->operation = $operation; $copy->lease = null;
    $copy->command_sent = true; $copy->status = 'acknowledged'; $copy->reason = 'protocol_ack_only';
    $copy->result_code = 'OK';
    check(Esp32MqttTransport::validateResult($encode($copy), $id, $operation) instanceof stdClass);
    $copy->command_sent = false;
    check(Esp32MqttTransport::validateResult($encode($copy), $id, $operation) === null);
}
foreach (['SESSION_MISMATCH', 'GATEWAY_UNAVAILABLE', 'INVALID_ARGUMENT', 'INVALID_LEASE',
    'DUPLICATE_MISMATCH', 'BUSY'] as $code) {
    $copy = clone $r; $copy->status = 'rejected'; $copy->lease = null;
    $copy->fresh_for_seconds = 0; $copy->result_code = $code;
    check(Esp32MqttTransport::validateResult($encode($copy), $id, 'inspect') instanceof stdClass);
}
// No network/credential files are accessed during construction or prefix rejection.
require_once __DIR__ . '/../php/Config.php';
foreach (['', '/bad', 'bad/', 'bad+', 'bad#', "bad\0", "\xff", str_repeat('x', 241)] as $prefix) {
    $rejected = false;
    try { new Esp32MqttTransport(new Config(), $prefix); } catch (Throwable) { $rejected = true; }
    check($rejected);
}
new Esp32MqttTransport(new Config(), 'fixture/esp32');
echo "ESP32 pure validation checks passed ($checks, Docker only)\n";
