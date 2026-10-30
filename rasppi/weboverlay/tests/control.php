<?php
declare(strict_types=1);

// Run only in the project's disposable Docker test stage, after vendor autoload.
require_once __DIR__ . '/../vendor/autoload.php';
require_once __DIR__ . '/../php/ControlHttp.php';
require_once __DIR__ . '/../php/ControlMqttTransport.php';

use EvseOverlay\ControlHttp;
use EvseOverlay\ControlMqttTransport;

$checks = 0;
function check(bool $ok): void {
    global $checks;
    ++$checks;
    if (!$ok) { throw new RuntimeException('Control validation check failed'); }
}
foreach (['start', 'set_current'] as $op) {
    foreach ([6000, 32000, 12345] as $ma) {
        check(ControlHttp::validateCommand(json_encode(['operation' => $op, 'current_ma' => $ma]))['current_ma'] === $ma);
    }
}
check(ControlHttp::validateCommand('{"operation":"stop","current_ma":0}')['operation'] === 'stop');
foreach (['{}', '[]', 'null', '{"operation":"stop","current_ma":6000}',
    '{"operation":"start","current_ma":5999}', '{"operation":"start","current_ma":32001}',
    '{"operation":"start","current_ma":6000.0}', '{"operation":"start","current_ma":"6000"}',
    '{"operation":"start","current_ma":true}', '{"operation":"inspect","current_ma":0}',
    '{"operation":"stop","current_ma":0,"lease":"x"}',
    '{"operation":"stop","operation":"start","current_ma":6000}',
    '{"operation":"stop","current_ma":0,"current_\u006da":0}', str_repeat(' ', 1025)] as $bad) {
    $rejected = false;
    try { ControlHttp::validateCommand($bad); } catch (Throwable) { $rejected = true; }
    check($rejected);
}
foreach (['http://localhost:8080', 'https://example.test', 'http://[::1]:8080'] as $origin) {
    check(ControlHttp::originParts($origin) !== null);
}
foreach (['', 'http://', 'http://x/', 'http://user@x', 'http://x?y', 'http://x#y',
    'ftp://x', "http://x\r\n", 'http://x:0', 'http://x:65536', 'http://x\\y'] as $origin) {
    check(ControlHttp::originParts($origin) === null);
}
$id = str_repeat('a', 32);
$r = (object) ['schema_version' => 1, 'id' => $id, 'operation' => 'inspect', 'status' => 'ok',
    'reason' => 'inspection_complete', 'session' => str_repeat('b', 32), 'lease' => str_repeat('c', 32),
    'fresh_for_seconds' => 8, 'read_only' => true, 'minimum_ma' => 6000, 'software_max_ma' => 32000,
    'hardware_max_ma' => null, 'installation_max_ma' => null, 'effective_max_ma' => null, 'firmware_raw' => null,
    'write' => null, 'preparation' => null];
$encode = static fn(object $v): string => json_encode($v, JSON_THROW_ON_ERROR | JSON_PRESERVE_ZERO_FRACTION);
check(ControlMqttTransport::validateResult($encode($r), $id, 'inspect') instanceof stdClass);
check(ControlMqttTransport::validateResult($encode($r), str_repeat('d', 32), 'inspect') === null);
foreach (['schema_version' => 2, 'id' => strtoupper($id), 'operation' => 'stop', 'session' => '-',
    'lease' => '-', 'fresh_for_seconds' => 7, 'read_only' => false, 'minimum_ma' => 0,
    'software_max_ma' => 64000, 'hardware_max_ma' => -1, 'installation_max_ma' => 6000.0,
    'effective_max_ma' => '6000', 'firmware_raw' => 4294967296, 'status' => 'raw-secret',
    'reason' => 'raw-secret', 'extra' => 'raw-secret'] as $key => $value) {
    $copy = clone $r; $copy->$key = $value;
    check(ControlMqttTransport::validateResult($encode($copy), $id, 'inspect') === null);
}
foreach (array_keys(get_object_vars($r)) as $key) {
    $copy = clone $r; unset($copy->$key);
    check(ControlMqttTransport::validateResult($encode($copy), $id, 'inspect') === null);
}
check(ControlMqttTransport::validateResult(str_repeat(' ', 4097), $id, 'inspect') === null);
check(ControlMqttTransport::validateResult(substr($encode($r), 0, -1) . ',"id":"' . $id . '"}', $id, 'inspect') === null);
$r->operation = 'start'; $r->read_only = false; $r->lease = null; $r->fresh_for_seconds = 0;
$r->status = 'acknowledged'; $r->reason = 'protocol_ack_only';
$r->write = (object) ['status' => 'acknowledged', 'reason' => 'protocol_ack_only', 'attempted' => true,
    'acknowledged' => true, 'hardware_max_ma' => 32000, 'effective_current_ma' => 6000,
    'charging_state_raw' => 0, 'charging_observed' => false];
$r->preparation = clone $r->write;
check(ControlMqttTransport::validateResult($encode($r), $id, 'start')?->write->charging_observed === false);
foreach (['status' => 'payload', 'reason' => 'payload', 'attempted' => 1, 'acknowledged' => null,
    'hardware_max_ma' => -1, 'effective_current_ma' => '6000', 'charging_state_raw' => 1.5,
    'charging_observed' => 0, 'extra' => 'secret'] as $key => $value) {
    $copy = clone $r; $copy->write = clone $r->write; $copy->write->$key = $value;
    check(ControlMqttTransport::validateResult($encode($copy), $id, 'start') === null);
}
foreach (['attempted' => false, 'acknowledged' => false, 'status' => 'outcome_unknown'] as $key => $value) {
    $copy = clone $r; $copy->write = clone $r->write; $copy->write->$key = $value;
    check(ControlMqttTransport::validateResult($encode($copy), $id, 'start') === null);
}
$automatic = (object) ['schema_version' => 1, 'guard' => str_repeat('a', 32), 'requested_mode' => 'pv',
    'activation_id' => str_repeat('b', 32), 'config_revision' => str_repeat('c', 64), 'state' => 'frozen', 'plan' => 'ok', 'house' => 'clock_error'];
check(ControlMqttTransport::validAutomation(null));
check(ControlMqttTransport::validAutomation($automatic));
$with = clone $r; $with->automation = $automatic;
check(ControlMqttTransport::validateResult($encode($with), $id, 'start') instanceof stdClass);
foreach (['schema_version' => 2, 'guard' => '-', 'requested_mode' => 'other', 'activation_id' => 'bad',
    'config_revision' => '', 'state' => 'secret', 'plan' => 'unknown', 'house' => 'secret', 'extra' => true] as $field => $value) {
    $copy = clone $automatic; $copy->$field = $value;
    check(!ControlMqttTransport::validAutomation($copy));
}
echo "Control pure validation checks passed ($checks, Docker only)\n";
