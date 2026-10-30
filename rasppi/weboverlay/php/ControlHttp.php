<?php
declare(strict_types=1);

namespace EvseOverlay;

require_once __DIR__ . '/StrictJson.php';

/** Trusted LAN control without authentication. CSRF is not an access-control gate. */
final class ControlHttp
{
    public static function validateCommand(string $body): array
    {
        if (strlen($body) > 1024) { throw new \InvalidArgumentException(); }
        $data = StrictJson::decode($body);
        if (!$data instanceof \stdClass) { throw new \InvalidArgumentException(); }
        $keys = array_keys(get_object_vars($data)); sort($keys);
        if ($keys !== ['current_ma', 'operation'] ||
            !in_array($data->operation, ['start', 'stop', 'set_current'], true) ||
            !is_int($data->current_ma) || ($data->operation === 'stop' ? $data->current_ma !== 0 :
                ($data->current_ma < 6000 || $data->current_ma > 32000))) { throw new \InvalidArgumentException(); }
        return ['operation' => $data->operation, 'current_ma' => $data->current_ma];
    }

    /** Exact configured origin; never derive authority from the request. */
    public static function originParts(string $origin): ?array
    {
        if (preg_match('/[\x00-\x20\x7f\\\\]/', $origin)) { return null; }
        try { $p = parse_url($origin); } catch (\Throwable) { return null; }
        if (!is_array($p) || !in_array($p['scheme'] ?? '', ['http', 'https'], true) ||
            !isset($p['host']) || $p['host'] === '' ||
            array_diff(array_keys($p), ['scheme', 'host', 'port'])) { return null; }
        $authority = $p['host'] . (isset($p['port']) ? ':' . $p['port'] : '');
        if ($origin !== $p['scheme'] . '://' . $authority) { return null; }
        // DNS/IPv4 or bracketed IPv6 only; no ambiguous URL authorities.
        $host = $p['host'];
        if ($host[0] === '[') {
            if (!str_ends_with($host, ']') || filter_var(substr($host, 1, -1), FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) === false) { return null; }
        } elseif (!preg_match('/\A[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\z/D', $host)) { return null; }
        if (isset($p['port']) && ($p['port'] < 1 || $p['port'] > 65535)) { return null; }
        return ['authority' => $authority, 'secure' => $p['scheme'] === 'https'];
    }

    /** Optional factory is for disposable fixtures; never selected by HTTP input. */
    public static function handle(?callable $exchange = null): void
    {
        $method = $_SERVER['REQUEST_METHOD'] ?? '';
        $csrf = null;
        $respond = static function (string $status, int $code, ?array $result = null) use ($method, &$csrf): never {
            http_response_code($code);
            header('Content-Type: application/json; charset=utf-8');
            header('Cache-Control: no-store');
            header('X-Content-Type-Options: nosniff');
            if ($method !== 'HEAD') {
                echo json_encode(['status' => $status, 'csrf' => $csrf, 'inspection' => $result['inspection'] ?? null,
                    'command' => $result['command'] ?? null, 'command_sent' => $result['command_sent'] ?? false], JSON_THROW_ON_ERROR);
            }
            exit;
        };
        $configured = getenv('WEB_CONTROL_ORIGIN');
        $origin = ($configured === false || $configured === '') ? (getenv('SETTINGS_EDITOR_ORIGIN') ?: '') : $configured;
        $parts = self::originParts($origin);
        if ($parts === null) { $respond('unavailable', 503); }
        if (($_SERVER['HTTP_HOST'] ?? '') !== $parts['authority'] ||
            (isset($_SERVER['HTTP_ORIGIN']) && $_SERVER['HTTP_ORIGIN'] !== $origin) ||
            (isset($_SERVER['HTTP_SEC_FETCH_SITE']) && !in_array($_SERVER['HTTP_SEC_FETCH_SITE'], ['same-origin', 'none'], true))) {
            $respond('forbidden', 403);
        }
        if (!in_array($method, ['GET', 'HEAD', 'POST'], true)) {
            header('Allow: GET, HEAD, POST'); $respond('invalid', 405);
        }
        if (($_SERVER['QUERY_STRING'] ?? '') !== '') { $respond('invalid', 400); }
        session_name('evse_control_csrf');
        ini_set('session.save_path', '/tmp');
        ini_set('session.use_strict_mode', '1');
        ini_set('session.use_only_cookies', '1');
        session_set_cookie_params(['lifetime' => 0, 'path' => '/api/wallbox-control',
            'secure' => $parts['secure'], 'httponly' => true, 'samesite' => 'Strict']);
        try {
            if (!@session_start()) { $respond('unavailable', 503); }
            $now = time();
            if (!isset($_SESSION['csrf'], $_SESSION['created']) || !is_string($_SESSION['csrf']) ||
                !is_int($_SESSION['created']) || $now < $_SESSION['created'] || $now - $_SESSION['created'] >= 1800) {
                $_SESSION = ['csrf' => bin2hex(random_bytes(32)), 'created' => $now];
            }
            $csrf = $_SESSION['csrf'];
            session_write_close();
        } catch (\Throwable) { $respond('unavailable', 503); }
        $command = null;
        if ($method === 'POST') {
            if (($_SERVER['HTTP_ORIGIN'] ?? '') !== $origin || !hash_equals($csrf, $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '')) {
                $respond('forbidden', 403);
            }
            if (strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0])) !== 'application/json') {
                $respond('invalid', 415);
            }
            try {
                $body = file_get_contents('php://input', false, null, 0, 1025);
                if ($body === false) { throw new \InvalidArgumentException(); }
                $command = self::validateCommand($body);
            } catch (\Throwable) { $respond('invalid', 400); }
        }
        try {
            if ($exchange === null) {
                require_once __DIR__ . '/ControlMqttTransport.php';
                $result = (new ControlMqttTransport(Config::fromEnvironment()))->exchange($command);
            } else { $result = $exchange($command); }
        } catch (\Throwable) { $respond('unavailable', 503); }
        $status = $result['status'];
        $respond($status, match ($status) { 'ok' => 200, 'outcome_unknown' => 504, default => 503 }, $result);
    }
}
