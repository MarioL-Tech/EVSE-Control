<?php
declare(strict_types=1);

namespace EvseOverlay;

final class Config
{
    public function __construct(
        public readonly string $host = 'mqtt-broker',
        public readonly int $port = 1883,
        public readonly string $prefix = 'evse/wallbox',
        public readonly string $clientId = 'evse-weboverlay',
        public readonly string $username = '',
        private readonly string $password = '',
        public readonly int $staleSeconds = 10,
    ) {}

    public function password(): string { return $this->password; }

    public function __debugInfo(): array
    {
        return ['host' => $this->host, 'port' => $this->port, 'prefix' => $this->prefix,
            'clientId' => $this->clientId, 'staleSeconds' => $this->staleSeconds];
    }

    public static function fromEnvironment(): self
    {
        $env = static fn(string $key, string $default = ''): string => (($v = getenv($key)) === false ? $default : $v);
        $number = static function (string $key, int $default, int $low, int $high) use ($env): int {
            $text = $env($key, (string) $default);
            // Compare as float before converting: integer overflow must not wrap.
            if (!preg_match('/\A[0-9]+\z/D', $text) || (float) $text < $low || (float) $text > $high) {
                throw new \InvalidArgumentException('Invalid ' . $key);
            }
            return (int) $text;
        };
        $host = $env('MQTT_HOST', 'mqtt-broker');
        $client = $env('MQTT_CLIENT_ID', 'evse-weboverlay');
        $prefix = $env('MQTT_TOPIC_PREFIX', 'evse/wallbox');
        if ($host === '' || $client === '' || strlen($client) > 128 ||
            preg_match('//u', $host . $client) !== 1) {
            throw new \InvalidArgumentException('Invalid MQTT_HOST / MQTT_CLIENT_ID');
        }
        if ($prefix === '' || strlen($prefix) > 240 || $prefix[0] === '/' || str_ends_with($prefix, '/') ||
            strpbrk($prefix, "+#\0") !== false || preg_match('//u', $prefix) !== 1) {
            throw new \InvalidArgumentException('Invalid MQTT_TOPIC_PREFIX');
        }
        $username = $env('MQTT_USERNAME');
        $password = $env('MQTT_PASSWORD');
        $file = $env('MQTT_PASSWORD_FILE');
        if ($file !== '') {
            if ($password !== '') {
                throw new \InvalidArgumentException('Use MQTT_PASSWORD or MQTT_PASSWORD_FILE, not both');
            }
            // Reject streams, devices and directories before opening (including FIFOs).
            if (str_contains($file, '://') || !is_file($file)) {
                throw new \InvalidArgumentException('Cannot read MQTT_PASSWORD_FILE');
            }
            $stream = @fopen($file, 'rb');
            if ($stream === false) {
                throw new \InvalidArgumentException('Cannot read MQTT_PASSWORD_FILE');
            }
            try {
                $stat = fstat($stream);
                if ($stat === false || ($stat['mode'] & 0170000) !== 0100000) {
                    throw new \InvalidArgumentException('Invalid MQTT_PASSWORD_FILE');
                }
                $content = stream_get_contents($stream, 16387);
            } finally {
                fclose($stream);
            }
            if ($content === false || preg_match('//u', $content) !== 1) {
                throw new \InvalidArgumentException('Invalid MQTT_PASSWORD_FILE');
            }
            $password = preg_replace('/(?:\r\n|\n|\r)\z/D', '', $content);
            if ($password === '' || strpbrk($password, "\r\n") !== false ||
                preg_match_all('/./us', $password) > 4096) {
                throw new \InvalidArgumentException('Invalid MQTT_PASSWORD_FILE');
            }
        }
        if (preg_match('//u', $username . $password) !== 1 || ($password !== '' && $username === '')) {
            throw new \InvalidArgumentException('Invalid MQTT credentials');
        }
        return new self($host, $number('MQTT_PORT', 1883, 1, 65535), $prefix, $client,
            $username, $password, $number('WEB_STALE_SECONDS', 10, 3, 120));
    }
}
