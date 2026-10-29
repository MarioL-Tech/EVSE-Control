<?php
declare(strict_types=1);

namespace EvseOverlay;

final class HouseHistoryConfig
{
    public function __construct(
        public readonly bool $enabled = false,
        public readonly string $host = 'evse-database',
        public readonly int $port = 3306,
        public readonly string $database = 'energyControl',
        public readonly string $username = 'smartReader',
        public readonly string $prefix = 'evse/house',
        private readonly string $password = '',
        public readonly int $timeoutSeconds = 2,
    ) {
        if (!$enabled) {
            return;
        }
        // No DSN delimiters, socket paths or connection options from configuration.
        if (strlen($host) > 253 || !preg_match('/\A[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\z/D', $host) ||
            str_contains($host, '..') || $port < 1 || $port > 65535 ||
            !preg_match('/\A[A-Za-z][A-Za-z0-9_]{0,63}\z/D', $database) ||
            $username === '' || preg_match('//u', $username) !== 1 ||
            preg_match_all('/./us', $username) > 128 || preg_match('/\p{Cc}/u', $username) ||
            $prefix === '' || strlen($prefix) > 240 || preg_match('//u', $prefix) !== 1 ||
            strpbrk($prefix, "+#\0\r\n") !== false || preg_match('/\R/u', $prefix) || $prefix[0] === '/' || str_ends_with($prefix, '/') ||
            $password === '' || strlen($password) > 4096 || preg_match('//u', $password) !== 1 ||
            strpbrk($password, "\0\r\n") !== false || preg_match('/\R/u', $password) || $timeoutSeconds !== 2) {
            throw new \InvalidArgumentException('Invalid history configuration');
        }
    }

    public function password(): string { return $this->password; }

    public function __debugInfo(): array
    {
        return ['enabled' => $this->enabled, 'timeoutSeconds' => $this->timeoutSeconds];
    }

    public static function fromEnvironment(): self
    {
        $env = static fn(string $key, string $default = ''): string =>
            (($value = getenv($key)) === false ? $default : $value);
        $enabled = $env('WEB_HOUSE_HISTORY_ENABLED', '0');
        if (!in_array($enabled, ['0', '1'], true)) {
            throw new \InvalidArgumentException('Invalid WEB_HOUSE_HISTORY_ENABLED');
        }
        if ($enabled === '0') {
            return new self();
        }
        $port = $env('HISTORY_DB_PORT', '3306');
        if (!preg_match('/\A[0-9]{1,5}\z/D', $port)) {
            throw new \InvalidArgumentException('Invalid history configuration');
        }
        $file = $env('HISTORY_DB_PASSWORD_FILE');
        if ($file === '' || str_contains($file, '://') || !is_file($file)) {
            throw new \InvalidArgumentException('Invalid history secret file');
        }
        $stream = @fopen($file, 'rb');
        if ($stream === false) {
            throw new \InvalidArgumentException('Invalid history secret file');
        }
        try {
            $stat = fstat($stream);
            if ($stat === false || ($stat['mode'] & 0170000) !== 0100000 || $stat['size'] > 4098) {
                throw new \InvalidArgumentException('Invalid history secret file');
            }
            $content = stream_get_contents($stream, 4099);
        } finally {
            fclose($stream);
        }
        if ($content === false || strlen($content) > 4098) {
            throw new \InvalidArgumentException('Invalid history secret file');
        }
        $password = preg_replace('/(?:\r\n|\n|\r)\z/D', '', $content);
        return new self(true, $env('HISTORY_DB_HOST', 'evse-database'), (int) $port,
            $env('HISTORY_DB_NAME', 'energyControl'), $env('HISTORY_DB_USERNAME', 'smartReader'),
            $env('HOUSE_HISTORY_SOURCE', $env('HOUSE_MQTT_TOPIC_PREFIX', 'evse/house')), $password);
    }
}
