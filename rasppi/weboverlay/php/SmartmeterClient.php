<?php
declare(strict_types=1);

namespace EvseOverlay;

final class SmartmeterClient
{
    public static function parse(string $body): float
    {
        $invalid = static fn () => new \RuntimeException('Smartmeter-Antwort ungültig');
        if (strlen($body) > 4096 || preg_match('/[^\x09-\x0d\x20-\x7e]/', $body)) {
            throw $invalid();
        }
        $tokens = preg_split('/[\x09-\x0d\x20]+/', trim($body, " \t\r\n\v\f"));
        if ($tokens === false || count($tokens) < 7) {
            throw $invalid();
        }
        foreach ($tokens as $token) {
            if (strlen($token) > 64
                || !preg_match('/\A[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\z/D', $token)) {
                throw $invalid();
            }
            $value = (float) $token;
            $mantissa = preg_split('/[eE]/', $token)[0];
            if (!is_finite($value) || ($value === 0.0 && preg_match('/[1-9]/', $mantissa))
                || ($value !== 0.0 && abs($value) < PHP_FLOAT_MIN)) {
                throw $invalid();
            }
        }
        return (float) $tokens[6];
    }

    public static function fetch(SmartmeterConfig $config): float
    {
        $handle = null;
        try {
            if (!$config->enabled() || !extension_loaded('curl')) {
                throw new \RuntimeException();
            }
            $handle = curl_init($config->url());
            if ($handle === false) {
                throw new \RuntimeException();
            }
            $body = '';
            $headers = 0;
            curl_setopt_array($handle, [CURLOPT_HTTPGET => true, CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_PROXY => '', CURLOPT_PROTOCOLS_STR => 'http,https',
                CURLOPT_CONNECTTIMEOUT_MS => $config->timeoutSeconds * 1000,
                CURLOPT_TIMEOUT_MS => $config->timeoutSeconds * 1000,
                CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
                CURLOPT_HEADERFUNCTION => static function ($curl, string $line) use (&$headers): int {
                    $headers += strlen($line);
                    return $headers <= 8192 ? strlen($line) : 0;
                },
                CURLOPT_WRITEFUNCTION => static function ($curl, string $chunk) use (&$body): int {
                    if (strlen($body) + strlen($chunk) > 4096) {
                        return 0;
                    }
                    $body .= $chunk;
                    return strlen($chunk);
                }]);
            if (curl_exec($handle) === false || curl_getinfo($handle, CURLINFO_RESPONSE_CODE) !== 200) {
                throw new \RuntimeException();
            }
            return self::parse($body);
        } catch (\Throwable) {
            throw new \RuntimeException('Smartmeter-Abfrage fehlgeschlagen');
        } finally {
            if ($handle instanceof \CurlHandle) {
                curl_close($handle);
            }
        }
    }
}
