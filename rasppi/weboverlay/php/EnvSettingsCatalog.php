<?php
declare(strict_types=1);

namespace EvseOverlay;

/** Deployment environment only; not a runtime configuration or a secret-file editor. */
final class EnvSettingsCatalog
{
    public const SERVICES = ['uart', 'wallbox', 'storage', 'weboverlay'];

    public static function entries(string $service): array
    {
        if (!in_array($service, self::SERVICES, true)) { return []; }
        $keys = [];
        $add = static function (string $name, string $type, ?int $min = null, ?int $max = null,
            bool $secret = false, bool $readonly = false, array $choices = []) use (&$keys): void {
            $keys[$name] = compact('type', 'min', 'max', 'secret', 'readonly', 'choices');
        };
        if ($service === 'uart') {
            $add('UART_DEVICE', 'device');
            return $keys;
        }
        $add('MQTT_HOST', 'host');
        $add('MQTT_PORT', 'integer', 1, 65535);
        $add('MQTT_TOPIC_PREFIX', 'topic');
        $add('MQTT_CLIENT_ID', 'identifier', 1, 128);
        $add('MQTT_USERNAME', 'text', 0, 128);
        $add('MQTT_PASSWORD', 'text', 0, 4096, true);
        foreach (['MQTT_PASSWORD_FILE', 'MQTT_PASSWORD_HOST_FILE'] as $key) {
            $add($key, 'mount', null, null, true, true);
        }
        if ($service === 'wallbox') {
            $add('WALLBOX_DEVICE', 'device');
            // Compose fixes the container port; only the host-side device is selectable.
            $add('WALLBOX_PORT', 'device', null, null, false, true);
            $add('WALLBOX_BAUD', 'enum', null, null, false, false,
                ['4800', '9600', '19200', '38400', '57600', '115200']);
            $add('WALLBOX_PARITY', 'enum', null, null, false, false, ['N', 'E', 'O']);
            $add('WALLBOX_SLAVE', 'integer', 1, 247);
            $add('WALLBOX_INTERVAL_MS', 'integer', 100, 30000);
            $add('WALLBOX_TIMEOUT_MS', 'integer', 10, 10000);
            $add('MQTT_ENABLED', 'enum', null, null, false, false, ['true', 'false', '1', '0']);
        }
        if ($service === 'storage') {
            // Storage Compose supplies file-mounted DB credentials and does not
            // forward inline MQTT_PASSWORD. Editing these .env keys cannot apply them.
            $keys['MQTT_PASSWORD']['readonly'] = true;
            $add('DB_HOST', 'host');
            $add('DB_PORT', 'integer', 1, 65535);
            $add('DB_NAME', 'database');
            $add('DB_USERNAME', 'identifier', 1, 128);
            $add('DB_MIGRATION_USERNAME', 'identifier', 1, 128);
            $add('DB_PASSWORD', 'text', 0, 4096, true, true);
            $add('DB_PASSWORD_FILE', 'mount', null, null, true, true);
            $add('DB_TIMEOUT_SECONDS', 'integer', 1, 10);
            $add('STORAGE_QUEUE_SIZE', 'integer', 8, 4096);
            $add('STORAGE_RECORDING_MODE', 'enum', null, null, false, false, ['raw', 'minute']);
        }
        if ($service === 'weboverlay') {
            $add('WEB_PORT', 'integer', 1, 65535);
            $add('WEB_BIND_ADDRESS', 'ipv4');
            $add('WEB_HTTPS_PORT', 'integer', 1, 65535);
            $add('WEB_TLS_HOST', 'optional-host');
            $add('WEB_STALE_SECONDS', 'integer', 3, 120);
            foreach (['WEB_HISTORY_ENABLED', 'WEB_HOUSE_HISTORY_ENABLED'] as $key) {
                $add($key, 'enum', null, null, false, false, ['0', '1']);
            }
            $add('HISTORY_DB_HOST', 'host');
            $add('HISTORY_DB_PORT', 'integer', 1, 65535);
            $add('HISTORY_DB_NAME', 'database');
            $add('HISTORY_DB_USERNAME', 'identifier', 1, 128);
            foreach (['HISTORY_DB_PASSWORD_FILE', 'HISTORY_DB_PASSWORD_HOST_FILE'] as $key) {
                $add($key, 'mount', null, null, true, true);
            }
            $add('SMARTMETER_STALE_SECONDS', 'integer', 3, 120);
        }
        if (in_array($service, ['storage', 'weboverlay'], true)) {
            $add('DB_NETWORK', 'network');
            $add('SMARTMETER_URL', 'url', null, null, true);
            $add('SMARTMETER_POLL_SECONDS', 'integer', 1, 60);
            $add('SMARTMETER_TIMEOUT_SECONDS', 'integer', 1, 5);
            $add('HOUSE_HISTORY_SOURCE', 'topic');
            $add('HOUSE_MQTT_TOPIC_PREFIX', 'topic'); // Legacy database identity.
            // Compose profiles affect service lifecycle, not just env values. No browser provisioning.
            $add('COMPOSE_PROFILES', 'profiles', null, null, false, true);
        }
        return $keys;
    }

    /** Conservative subset that round-trips as a Compose single-quoted literal. */
    public static function valid(array $entry, string $value): bool
    {
        if ($entry['readonly'] || strlen($value) > 4096 || preg_match('//u', $value) !== 1 ||
            preg_match('/\p{Cc}|\R/u', $value) || strpbrk($value, "'\"\\\$`") !== false) {
            return false;
        }
        return match ($entry['type']) {
            'integer' => preg_match('/\A[0-9]{1,10}\z/D', $value) === 1 &&
                (float) $value >= $entry['min'] && (float) $value <= $entry['max'],
            'enum' => in_array($value, $entry['choices'], true),
            'text' => strlen($value) >= $entry['min'] && strlen($value) <= $entry['max'],
            'identifier' => strlen($value) >= $entry['min'] && strlen($value) <= $entry['max'] &&
                preg_match('/\A[A-Za-z0-9_.@:-]+\z/D', $value) === 1,
            'database' => preg_match('/\A[A-Za-z][A-Za-z0-9_]{0,63}\z/D', $value) === 1,
            'host' => self::host($value),
            'optional-host' => $value === '' || self::host($value),
            'ipv4' => filter_var($value, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false,
            'network' => preg_match('/\A[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\z/D', $value) === 1,
            'device' => strlen($value) <= 240 && preg_match('~\A/dev/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_.-]+\z~D', $value) === 1 &&
                !str_contains($value, '..'),
            'topic' => strlen($value) >= 1 && strlen($value) <= 240 &&
                preg_match('~\A[A-Za-z0-9_.:-]+(?:/[A-Za-z0-9_.:-]+)*\z~D', $value) === 1,
            'url' => self::url($value),
            default => false,
        };
    }

    private static function host(string $value): bool
    {
        if ($value === '' || strlen($value) > 253) { return false; }
        // Numeric-looking hosts must be actual IPv4, not ambiguous legacy IP syntax.
        if (preg_match('/\A[0-9.]+\z/D', $value)) {
            return filter_var($value, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false;
        }
        foreach (explode('.', $value) as $label) {
            if (!preg_match('/\A[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\z/D', $label)) {
                return false;
            }
        }
        return true;
    }

    private static function url(string $value): bool
    {
        if ($value === '') { return true; }
        if (strlen($value) > 2048 || preg_match('/\s/u', $value)) { return false; }
        $parts = @parse_url($value);
        return $parts !== false && in_array(strtolower($parts['scheme'] ?? ''), ['http', 'https'], true) &&
            self::host($parts['host'] ?? '') && !isset($parts['user']) && !isset($parts['pass']) &&
            !array_key_exists('fragment', $parts) &&
            (!isset($parts['port']) || ($parts['port'] >= 1 && $parts['port'] <= 65535)) &&
            filter_var($value, FILTER_VALIDATE_URL) !== false;
    }
}
