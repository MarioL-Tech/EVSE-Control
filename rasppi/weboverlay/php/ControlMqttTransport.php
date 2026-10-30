<?php
declare(strict_types=1);

namespace EvseOverlay;

use PhpMqtt\Client\ConnectionSettings;

// BoundedMqttClient is a secondary class, not independently PSR-4 autoloadable.
require_once __DIR__ . '/MqttTransport.php';
require_once __DIR__ . '/StrictJson.php';
require_once __DIR__ . '/ControlHttp.php';

/** One HTTP exchange, one connection, no reconnect or command retransmission. */
final class ControlMqttTransport
{
    private const STATUSES = ['ok', 'busy', 'rejected', 'unavailable', 'disabled', 'invalid_request',
        'expired_not_sent', 'cancelled_not_sent', 'wrong_thread', 'not_connected',
        'preflight_failed_not_sent', 'preparation_required', 'recovery_required',
        'acknowledged', 'rejected_by_device', 'outcome_unknown'];
    private const REASONS = ['ok', 'inspection_complete', 'reader_unavailable', 'busy', 'queue_full',
        'lease_capacity', 'invalid_session', 'invalid_lease', 'deadline_elapsed', 'invalid_request',
        'writes_disabled', 'owner_thread_required', 'new_session_required', 'invalid_operation',
        'explicit_installation_limit_required', 'invalid_current', 'deadline_too_distant',
        'shutdown_requested', 'connected_context_required', 'unicast_rtu_context_required',
        'fresh_limit_ack_required', 'cancelled_after_ack', 'deadline_after_ack',
        'timeout_configuration_failed', 'observation_read_failed', 'invalid_hardware_limit',
        'above_hardware_limit', 'active_wallbox_fault', 'charging_state_unknown',
        'effective_limit_above_request', 'write_outcome_unknown', 'device_exception',
        'protocol_ack_only', 'session_changed', 'inspection_failed', 'serial_unavailable',
        'inspection_read_failed', 'hardware_read_failed', 'modbus_unavailable',
        'read_only_inspection', 'fresh_inspection_required'];

    public function __construct(private readonly Config $config) {}

    public static function validId(mixed $id): bool
    {
        return is_string($id) && preg_match('/\A[0-9a-f]{32}\z/D', $id) === 1;
    }

    private static function keys(\stdClass $value, array $keys): bool
    {
        $actual = array_keys(get_object_vars($value));
        sort($actual); sort($keys);
        return $actual === $keys;
    }

    private static function uint(mixed $value): bool
    {
        return $value === null || (is_int($value) && $value >= 0 && $value <= 4294967295);
    }

    private static function labels(\stdClass $value): bool
    {
        return in_array($value->status, self::STATUSES, true) && in_array($value->reason, self::REASONS, true);
    }

    public static function validAutomation(mixed $a): bool
    {
        if ($a === null) return true;
        return $a instanceof \stdClass && self::keys($a, ['schema_version', 'guard', 'requested_mode',
            'activation_id', 'config_revision', 'state', 'plan', 'house']) && $a->schema_version === 1 &&
            self::validId($a->guard) && in_array($a->requested_mode, ['manual', 'pv', 'custom'], true) &&
            ($a->activation_id === null || self::validId($a->activation_id)) &&
            ($a->config_revision === null || is_string($a->config_revision) && preg_match('/\A[a-f0-9]{64}\z/D', $a->config_revision)) &&
            in_array($a->state, ['awaiting_activation', 'manual', 'manual_override', 'frozen', 'invalid_configuration',
                'source_unavailable', 'manual_handling', 'unplugged', 'adjusting', 'pausing', 'resuming',
                'awaiting_start', 'awaiting_stop', 'charging', 'vehicle_finished'], true) &&
            in_array($a->plan, ['waiting', 'ok', 'transport_unavailable', 'invalid_response', 'disabled', 'clock_error', 'invalid_base'], true) &&
            in_array($a->house, ['waiting', 'ok', 'transport_unavailable', 'invalid_response', 'disabled', 'clock_error', 'invalid_base'], true);
    }

    /** Pure strict wire validator. Never returns raw/unrecognised result fields. */
    public static function validateResult(string $json, string $id, string $operation): ?\stdClass
    {
        try {
            if (strlen($json) > 4096 || !self::validId($id) ||
                !in_array($operation, ['inspect', 'start', 'stop', 'set_current'], true)) { return null; }
            $r = StrictJson::decode($json);
            if (!$r instanceof \stdClass || !self::keys($r, ['schema_version', 'id', 'operation', 'status',
                'reason', 'session', 'lease', 'fresh_for_seconds', 'read_only', 'minimum_ma', 'software_max_ma',
                'hardware_max_ma', 'installation_max_ma', 'effective_max_ma', 'firmware_raw', 'write', 'preparation',
                ...(property_exists($r, 'automation') ? ['automation'] : [])]) ||
                !self::validAutomation($r->automation ?? null) ||
                $r->schema_version !== 1 || $r->id !== $id || $r->operation !== $operation ||
                !self::labels($r) || !self::validId($r->session) ||
                $r->read_only !== ($operation === 'inspect') || $r->minimum_ma !== 6000 || $r->software_max_ma !== 32000) {
                return null;
            }
            if ($r->lease !== null) {
                if ($operation !== 'inspect' || !self::validId($r->lease) || $r->status !== 'ok' ||
                    $r->fresh_for_seconds !== 8) { return null; }
            } elseif ($r->fresh_for_seconds !== 0) { return null; }
            foreach (['hardware_max_ma', 'installation_max_ma', 'effective_max_ma', 'firmware_raw'] as $field) {
                if (!self::uint($r->$field)) { return null; }
            }
            foreach (['write', 'preparation'] as $field) {
                $w = $r->$field;
                if ($w === null) { continue; }
                if ($operation === 'inspect' || !$w instanceof \stdClass ||
                    !self::keys($w, ['status', 'reason', 'attempted', 'acknowledged', 'hardware_max_ma',
                        'effective_current_ma', 'charging_state_raw', 'charging_observed']) ||
                    !self::labels($w) || !is_bool($w->attempted) || !is_bool($w->acknowledged) ||
                    ($w->acknowledged !== ($w->status === 'acknowledged')) ||
                    ($w->acknowledged && !$w->attempted) ||
                    (in_array($w->status, ['outcome_unknown', 'rejected_by_device'], true) && !$w->attempted) ||
                    ($w->charging_observed !== null && !is_bool($w->charging_observed))) { return null; }
                foreach (['hardware_max_ma', 'effective_current_ma', 'charging_state_raw'] as $n) {
                    if (!self::uint($w->$n)) { return null; }
                }
            }
            return $r;
        } catch (\Throwable) { return null; }
    }

    /** command=null is inspection only; command shape is revalidated at this boundary. */
    public function exchange(?array $command = null): array
    {
        $result = ['status' => 'unavailable', 'inspection' => null, 'command' => null, 'command_sent' => false];
        $client = null;
        try {
            if ($command !== null) { $command = ControlHttp::validateCommand(json_encode($command, JSON_THROW_ON_ERROR)); }
            $started = hrtime(true) / 1e9;
            // Reserve two seconds for the adapter's longest blocking socket read.
            $deadline = $started + 10;
            $id = bin2hex(random_bytes(16));
            $operation = 'inspect';
            $topic = $this->config->prefix . '/control/result/' . $id;
            $acked = false; $reply = null; $published = false;
            $config = new Config($this->config->host, $this->config->port, $this->config->prefix,
                'evse-control-' . bin2hex(random_bytes(16)), $this->config->username, $this->config->password(),
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
            $send = function (string $session, string $lease, int $ma) use ($client, $wait, &$acked, &$reply,
                &$published, &$topic, &$id, &$operation, &$result): void {
                $acked = false; $reply = null; $published = false;
                $client->subscribe($topic, null, 0);
                $wait(static function () use (&$acked): bool { return $acked; }, hrtime(true) / 1e9 + 3);
                // Set before the publish call: partial/failed writes cannot prove non-delivery.
                if ($operation !== 'inspect') { $result['command_sent'] = true; }
                $published = true;
                $client->publish($this->config->prefix . '/control/request',
                    "v1|$id|$session|$lease|$operation|$ma", 0, false);
                $wait(static function () use (&$reply): bool { return $reply !== null; }, hrtime(true) / 1e9 + ($operation === 'inspect' ? 3 : 8));
            };
            $send('-', '-', 0);
            $result['inspection'] = $reply;
            if ($command !== null) {
                if ($reply->status !== 'ok' || !self::validId($reply->lease)) { return $result; }
                $session = $reply->session; $lease = $reply->lease;
                $id = bin2hex(random_bytes(16)); $operation = $command['operation'];
                $topic = $this->config->prefix . '/control/result/' . $id;
                $send($session, $lease, $command['current_ma']);
                $result['command'] = $reply;
            }
            $result['status'] = 'ok';
        } catch (\Throwable) {
            $result['status'] = $result['command_sent'] ? 'outcome_unknown' : 'unavailable';
        } finally {
            try { $client?->forceClose(); } catch (\Throwable) { /* Never mask delivery uncertainty. */ }
        }
        return $result;
    }
}
