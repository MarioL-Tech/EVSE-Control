<?php
declare(strict_types=1);

namespace EvseOverlay;

use PhpMqtt\Client\ConnectionSettings;

require_once __DIR__ . '/MqttTransport.php';
require_once __DIR__ . '/StrictJson.php';
require_once __DIR__ . '/Esp32Http.php';

/** Request-scoped MQTT transport. No retry, retained command, or UID readback. */
final class Esp32MqttTransport
{
    private const OPERATIONS = ['inspect', 'lock', 'unlock', 'enroll', 'cancel', 'revoke'];
    private const STATUSES = ['ok', 'disabled', 'busy', 'rejected', 'outcome_unknown', 'unavailable', 'acknowledged'];
    private const REASONS = ['inspection_complete', 'gateway_unavailable', 'firmware_unsupported',
        'serial_timeout', 'invalid_session', 'invalid_lease', 'queue_full', 'busy', 'deadline_elapsed',
        'protocol_ack_only', 'rejected_by_device', 'outcome_unknown', 'invalid_request', 'not_ready',
        'gateway_session_changed', 'uart_unavailable'];
    private const CODES = ['OK', 'NOT_READY', 'STORAGE_ERROR', 'INVALID_UID', 'INVALID_ARGUMENT', 'FULL',
        'ALREADY_ALLOWED', 'ENROLL_STARTED', 'ENROLL_ACTIVE', 'ENROLL_CANCELLED', 'ENROLL_INACTIVE',
        'ENROLL_EXPIRED', 'ENROLLED', 'REVOKED', 'NOT_FOUND', 'DENIED', 'DEBOUNCED', 'LOCKED', 'UNLOCKED',
        'MODE_CHANGED', 'INVALID', 'INVALID_SESSION', 'INVALID_LEASE', 'BUSY', 'DUPLICATE_MISMATCH',
        'SESSION_MISMATCH', 'GATEWAY_UNAVAILABLE'];
    private readonly string $prefix;

    public function __construct(private readonly Config $config, ?string $prefix = null)
    {
        $prefix ??= (($v = getenv('ESP32_MQTT_TOPIC_PREFIX')) === false ? 'evse/esp32' : $v);
        if ($prefix === '' || strlen($prefix) > 240 || $prefix[0] === '/' || str_ends_with($prefix, '/') ||
            strpbrk($prefix, "+#\0") !== false || preg_match('//u', $prefix) !== 1) {
            throw new \InvalidArgumentException();
        }
        $this->prefix = $prefix;
    }

    public static function validId(mixed $id): bool
    {
        return is_string($id) && preg_match('/\\A[0-9a-f]{32}\\z/D', $id) === 1;
    }

    private static function keys(\stdClass $value, array $keys): bool
    {
        $actual = array_keys(get_object_vars($value)); sort($actual); sort($keys);
        return $actual === $keys;
    }

    /** Strict fixed schema: never forward raw gateway payloads or UID-bearing fields. */
    public static function validateResult(string $json, string $id, string $operation): ?\stdClass
    {
        try {
            if (strlen($json) > 4096 || !self::validId($id) ||
                !in_array($operation, self::OPERATIONS, true)) { return null; }
            $r = StrictJson::decode($json);
            if (!$r instanceof \stdClass || !self::keys($r, ['schema_version', 'id', 'operation', 'status',
                'reason', 'session', 'lease', 'fresh_for_seconds', 'firmware_version', 'state', 'command_sent', 'result_code']) ||
                $r->schema_version !== 1 || $r->id !== $id || $r->operation !== $operation ||
                !in_array($r->status, self::STATUSES, true) || !in_array($r->reason, self::REASONS, true) ||
                !self::validId($r->session) || !is_bool($r->command_sent) ||
                ($r->firmware_version !== null && $r->firmware_version !== 2) ||
                ($r->result_code !== null && !in_array($r->result_code, self::CODES, true)) ||
                !$r->state instanceof \stdClass || !self::keys($r->state,
                    ['charging', 'antitheft', 'store_ready', 'cards', 'enrolling', 'reader_ready', 'servo_ready'])) { return null; }
            foreach (['charging', 'antitheft', 'store_ready', 'enrolling', 'reader_ready', 'servo_ready'] as $field) {
                if ($r->state->$field !== null && !is_bool($r->state->$field)) { return null; }
            }
            if ($r->state->cards !== null && (!is_int($r->state->cards) ||
                $r->state->cards < 0 || $r->state->cards > 16)) { return null; }
            if (!in_array($r->fresh_for_seconds, [0, 8], true)) { return null; }
            if ($operation === 'inspect' && $r->command_sent) { return null; }
            if ($r->lease !== null && ($operation !== 'inspect' || !self::validId($r->lease) ||
                $r->status !== 'ok' || $r->reason !== 'inspection_complete' ||
                $r->firmware_version !== 2 || $r->fresh_for_seconds !== 8 ||
                in_array(null, array_diff_key(get_object_vars($r->state), ['charging' => true]), true))) { return null; }
            if ($operation === 'inspect' && $r->status === 'ok' && $r->lease === null) { return null; }
            if ($r->firmware_version === null && ($r->lease !== null || $r->fresh_for_seconds !== 0 ||
                count(array_filter(get_object_vars($r->state), static fn($v) => $v !== null)) !== 0)) { return null; }
            if (in_array($r->status, ['acknowledged', 'outcome_unknown'], true) &&
                ($operation === 'inspect' || !$r->command_sent)) { return null; }
            if ($operation !== 'inspect' && $r->status === 'ok' && !$r->command_sent) { return null; }
            if ($r->status === 'acknowledged' && $r->reason !== 'protocol_ack_only') { return null; }
            return $r;
        } catch (\Throwable) { return null; }
    }

    /** command=null is inspection only; command shape is revalidated at this boundary. */
    public function exchange(?array $command = null): array
    {
        $result = ['status' => 'unavailable', 'inspection' => null, 'command' => null, 'command_sent' => false];
        $client = null;
        try {
            if ($command !== null) { $command = Esp32Http::validateCommand(json_encode($command, JSON_THROW_ON_ERROR)); }
            $started = hrtime(true) / 1e9;
            // Reserve two seconds for the adapter's longest blocking socket read.
            $deadline = $started + 10;
            $id = bin2hex(random_bytes(16));
            $operation = 'inspect';
            $topic = $this->prefix . '/control/result/' . $id;
            $acked = false; $reply = null; $published = false; $inspectionStarted = null;
            $config = new Config($this->config->host, $this->config->port, $this->prefix,
                'evse-esp32-' . bin2hex(random_bytes(16)), $this->config->username, $this->config->password(),
                $this->config->staleSeconds);
            $client = new BoundedMqttClient($config,
                static function (string $name) use (&$topic, &$acked): void { if ($name === $topic) { $acked = true; } },
                static function (string $name, string $payload, bool $retained) use (&$topic, &$reply, &$id, &$operation, &$published): void {
                    if ($name === $topic && !$retained && $published && $reply === null) {
                        $reply = self::validateResult($payload, $id, $operation);
                    }
                });
            $settings = (new ConnectionSettings())->setKeepAliveInterval(15)->setConnectTimeout(2)
                ->setSocketTimeout(2)->setReconnectAutomatically(false);
            if ($config->username !== '') { $settings = $settings->setUsername($config->username)->setPassword($config->password()); }
            $client->connect($settings, true);
            $loopStarted = microtime(true);
            $wait = static function (callable $done, float $until) use ($client, $loopStarted, $deadline): void {
                while (!$done()) {
                    if (hrtime(true) / 1e9 >= min($until, $deadline)) { throw new \RuntimeException(); }
                    $client->checkFrameDeadline();
                    $client->loopOnce($loopStarted, false);
                    usleep(1000);
                }
                if (hrtime(true) / 1e9 >= min($until, $deadline)) { throw new \RuntimeException(); }
            };
            $send = function (string $session, string $lease, string $uid) use ($client, $wait, &$acked, &$reply,
                &$published, &$topic, &$id, &$operation, &$result, &$inspectionStarted, $deadline): void {
                $acked = false; $reply = null; $published = false;
                $client->subscribe($topic, null, 0);
                $wait(static function () use (&$acked): bool { return $acked; }, hrtime(true) / 1e9 + 3);
                if (hrtime(true) / 1e9 >= $deadline) { throw new \RuntimeException(); }
                $now = hrtime(true) / 1e9;
                if ($operation === 'inspect') { $inspectionStarted = $now; }
                elseif ($inspectionStarted === null || $now - $inspectionStarted >= 8) { throw new \RuntimeException(); }
                $wire = "v1|$id|$session|$lease|$operation|$uid";
                if (strlen($wire) > 192) { throw new \RuntimeException(); }
                // Set before the publish call: partial/failed writes cannot prove non-delivery.
                if ($operation !== 'inspect') { $result['command_sent'] = true; }
                $published = true;
                $client->publish($this->prefix . '/control/request', $wire, 0, false);
                $wait(static function () use (&$reply): bool { return $reply !== null; }, hrtime(true) / 1e9 + ($operation === 'inspect' ? 3 : 8));
            };
            $send('-', '-', '-');
            $result['inspection'] = $reply;
            if ($command !== null) {
                if ($reply->status !== 'ok' || !self::validId($reply->lease)) { return $result; }
                $session = $reply->session; $lease = $reply->lease;
                $id = bin2hex(random_bytes(16)); $operation = $command['operation'];
                $topic = $this->prefix . '/control/result/' . $id;
                $send($session, $lease, $command['uid'] ?? '-');
                $result['command'] = $reply;
                if ($reply->session !== $session) {
                    $result['status'] = 'outcome_unknown'; return $result;
                }
                if ($reply->status === 'outcome_unknown') {
                    $result['status'] = 'outcome_unknown'; return $result;
                }
            }
            $result['status'] = $reply->status === 'ok' || $reply->status === 'acknowledged' ? 'ok' : 'unavailable';
        } catch (\Throwable) {
            $result['status'] = $result['command_sent'] ? 'outcome_unknown' : 'unavailable';
        } finally {
            try { $client?->forceClose(); } catch (\Throwable) { /* Never mask delivery uncertainty. */ }
        }
        return $result;
    }
}
