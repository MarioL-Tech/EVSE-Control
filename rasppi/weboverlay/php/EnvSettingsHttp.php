<?php
declare(strict_types=1);

namespace EvseOverlay;

/** Explicitly provisioned trusted-LAN editor, without login. CSRF is NOT authentication. */
final class EnvSettingsHttp
{
    public static function handle(): void
    {
        $enabled = getenv('SETTINGS_EDITOR_ENABLED') === '1';
        $store = new EnvSettingsStore('/run/evse-settings', $enabled);
        $method = $_SERVER['REQUEST_METHOD'] ?? '';
        $respond = static function (array $data, int $code = 200) use ($method): never {
            http_response_code($code);
            header('Content-Type: application/json; charset=utf-8');
            header('Cache-Control: no-store');
            if ($method !== 'HEAD') { echo json_encode($data, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE); }
            exit;
        };
        if (!$enabled) {
            if (!in_array($method, ['GET', 'HEAD'], true)) {
                header('Allow: GET, HEAD');
                $respond(['status' => 'disabled'], 405);
            }
            $respond($store->catalog());
        }
        // There is intentionally no inferred Host, proxy-header trust, CORS or
        // first-visitor bootstrap. An explicit origin is required even in tests.
        $origin = getenv('SETTINGS_EDITOR_ORIGIN') ?: '';
        $parts = parse_url($origin);
        if (!is_array($parts) || !in_array($parts['scheme'] ?? '', ['http', 'https'], true) ||
            !isset($parts['host']) || isset($parts['user']) || isset($parts['pass']) ||
            isset($parts['query']) || isset($parts['fragment']) || isset($parts['path'])) {
            $respond(['status' => 'unavailable'], 503);
        }
        $authority = $parts['host'] . (isset($parts['port']) ? ':' . $parts['port'] : '');
        if (($_SERVER['HTTP_HOST'] ?? '') !== $authority ||
            (isset($_SERVER['HTTP_ORIGIN']) && $_SERVER['HTTP_ORIGIN'] !== $origin) ||
            (isset($_SERVER['HTTP_SEC_FETCH_SITE']) && !in_array($_SERVER['HTTP_SEC_FETCH_SITE'], ['same-origin', 'none'], true))) {
            $respond(['status' => 'forbidden'], 403);
        }
        if (!in_array($method, ['GET', 'HEAD', 'POST'], true)) {
            header('Allow: GET, HEAD, POST');
            $respond(['status' => 'invalid'], 405);
        }
        // /tmp is private to this container; settings data itself is persistent.
        session_name('evse_settings_csrf');
        ini_set('session.save_path', '/tmp');
        session_set_cookie_params(['lifetime' => 0, 'path' => '/api/settings-env',
            'secure' => $parts['scheme'] === 'https', 'httponly' => true, 'samesite' => 'Strict']);
        ini_set('session.use_strict_mode', '1');
        ini_set('session.use_only_cookies', '1');
        if (!session_start()) { $respond(['status' => 'unavailable'], 503); }
        $now = time();
        if (!isset($_SESSION['csrf'], $_SESSION['created']) || $now - $_SESSION['created'] > 1800) {
            $_SESSION = ['csrf' => bin2hex(random_bytes(32)), 'created' => $now];
        }
        $csrf = $_SESSION['csrf'];
        session_write_close();
        if ($method !== 'POST') {
            $query = $_SERVER['QUERY_STRING'] ?? '';
            if (!preg_match('/\Aservice=(uart|wallbox|storage|weboverlay)\z/D', $query, $match)) {
                $respond(['status' => 'invalid'], 400);
            }
            $snapshot = $store->read($match[1]);
            $respond([...$store->catalog(), 'snapshot' => $snapshot, 'csrf' => $csrf]);
        }
        if (($_SERVER['QUERY_STRING'] ?? '') !== '' ||
            ($_SERVER['HTTP_ORIGIN'] ?? '') !== $origin ||
            !hash_equals($csrf, $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '')) {
            $respond(['status' => 'forbidden'], 403);
        }
        if (strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0])) !== 'application/json') {
            $respond(['status' => 'invalid'], 415);
        }
        $body = file_get_contents('php://input', false, null, 0, 65537);
        try {
            if ($body === false || strlen($body) > 65536) { throw new \InvalidArgumentException(); }
            $data = json_decode($body, false, 16, JSON_THROW_ON_ERROR);
            if (!$data instanceof \stdClass ||
                array_diff(array_keys(get_object_vars($data)), ['service', 'revision', 'changes', 'create']) ||
                !isset($data->service, $data->changes) || !is_string($data->service) ||
                !$data->changes instanceof \stdClass ||
                !property_exists($data, 'revision') || ($data->revision !== null && !is_string($data->revision)) ||
                (isset($data->create) && !is_bool($data->create))) { throw new \InvalidArgumentException(); }
            $snapshot = $store->update($data->service, $data->revision, get_object_vars($data->changes), $data->create ?? false);
        } catch (\Throwable) { $respond(['status' => 'invalid'], 400); }
        $status = $snapshot['status'];
        $respond(['status' => $status, 'snapshot' => $snapshot, 'csrf' => $csrf],
            match ($status) { 'ok' => 200, 'conflict' => 409, 'busy' => 503, 'unavailable' => 503, default => 400 });
    }
}
