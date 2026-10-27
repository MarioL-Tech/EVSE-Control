<?php
declare(strict_types=1);

namespace EvseOverlay;

final class SmartmeterConfig
{
    public function __construct(
        private readonly string $sourceUrl = '',
        public readonly int $pollSeconds = 2,
        public readonly int $timeoutSeconds = 2,
        public readonly int $staleSeconds = 10,
    ) {
        if ($pollSeconds < 1 || $pollSeconds > 60 || $timeoutSeconds < 1 || $timeoutSeconds > 5
            || $staleSeconds < 3 || $staleSeconds > 120) {
            throw new \InvalidArgumentException('Ungültige Smartmeter-Konfiguration');
        }
        if ($sourceUrl === '') {
            return;
        }
        $parts = @parse_url($sourceUrl);
        if (strlen($sourceUrl) > 2048 || preg_match('/[\x00-\x20\x7f\\\\]/', $sourceUrl)
            || $parts === false || !in_array(strtolower($parts['scheme'] ?? ''), ['http', 'https'], true)
            || empty($parts['host']) || isset($parts['user']) || isset($parts['pass'])
            || array_key_exists('fragment', $parts)
            || (isset($parts['port']) && ($parts['port'] < 1 || $parts['port'] > 65535))
            || filter_var($sourceUrl, FILTER_VALIDATE_URL) === false) {
            throw new \InvalidArgumentException('Ungültige Smartmeter-Konfiguration');
        }
    }

    public static function fromEnvironment(): self
    {
        $integer = static function (string $key, int $default): int {
            $value = getenv($key);
            if ($value === false) {
                return $default;
            }
            if (!preg_match('/\A[0-9]{1,3}\z/D', $value)) {
                throw new \InvalidArgumentException('Ungültige Smartmeter-Konfiguration');
            }
            return (int) $value;
        };
        $url = getenv('SMARTMETER_URL');
        return new self($url === false ? '' : $url, $integer('SMARTMETER_POLL_SECONDS', 2),
            $integer('SMARTMETER_TIMEOUT_SECONDS', 2), $integer('SMARTMETER_STALE_SECONDS', 10));
    }

    public function enabled(): bool { return $this->sourceUrl !== ''; }
    public function url(): string { return $this->sourceUrl; }
    public function __debugInfo(): array
    {
        return ['enabled' => $this->enabled(), 'pollSeconds' => $this->pollSeconds,
            'timeoutSeconds' => $this->timeoutSeconds, 'staleSeconds' => $this->staleSeconds];
    }
}
