<?php
declare(strict_types=1);
namespace EvseOverlay;

require_once __DIR__ . '/ControlHttp.php';
require_once __DIR__ . '/ChargingSettings.php';

final class ChargingSettingsHttp
{
    public static function handle(): never
    {
        $method = $_SERVER['REQUEST_METHOD'] ?? ''; $csrf = null;
        $respond = static function (array $data, int $code = 200) use ($method, &$csrf): never {
            http_response_code($code); header('Content-Type: application/json; charset=utf-8');
            header('Cache-Control: no-store'); header('X-Content-Type-Options: nosniff');
            if ($method !== 'HEAD') echo json_encode(['schema_version' => 1, ...$data,
                'csrf' => $csrf, 'automation_available' => false], JSON_THROW_ON_ERROR);
            exit;
        };
        $origin = getenv('SETTINGS_EDITOR_ORIGIN') ?: '';
        $parts = ControlHttp::originParts($origin);
        if ($parts === null) $respond(['status' => 'unavailable'], 503);
        if (($_SERVER['HTTP_HOST'] ?? '') !== $parts['authority'] ||
            (isset($_SERVER['HTTP_ORIGIN']) && $_SERVER['HTTP_ORIGIN'] !== $origin) ||
            (isset($_SERVER['HTTP_SEC_FETCH_SITE']) && !in_array($_SERVER['HTTP_SEC_FETCH_SITE'], ['same-origin', 'none'], true)))
            $respond(['status' => 'forbidden'], 403);
        if (!in_array($method, ['GET', 'HEAD', 'POST'], true)) {
            header('Allow: GET, HEAD, POST'); $respond(['status' => 'invalid'], 405);
        }
        if (($_SERVER['QUERY_STRING'] ?? '') !== '') $respond(['status' => 'invalid'], 400);
        if (getenv('SETTINGS_EDITOR_ENABLED') !== '1')
            $respond(['status' => 'disabled', 'revision' => null, 'config' => ChargingSettings::defaults()]);
        try {
            session_name('evse_charging_csrf');
            ini_set('session.save_path', '/tmp'); ini_set('session.use_strict_mode', '1'); ini_set('session.use_only_cookies', '1');
            session_set_cookie_params(['lifetime' => 0, 'path' => '/api/charging-settings', 'secure' => $parts['secure'],
                'httponly' => true, 'samesite' => 'Strict']);
            if (!@session_start()) throw new \RuntimeException();
            $now = time();
            if (!isset($_SESSION['csrf'], $_SESSION['created']) || !is_string($_SESSION['csrf']) ||
                !is_int($_SESSION['created']) || $now < $_SESSION['created'] || $now - $_SESSION['created'] >= 1800)
                $_SESSION = ['csrf' => bin2hex(random_bytes(32)), 'created' => $now];
            $csrf = $_SESSION['csrf']; session_write_close();
        } catch (\Throwable) { $respond(['status' => 'unavailable'], 503); }
        $store = new ChargingSettings(getenv('SETTINGS_EDITOR_ROOT') ?: '/run/evse-settings', true);
        if ($method !== 'POST') {
            $data = $store->operate();
        } else {
            if (($_SERVER['HTTP_ORIGIN'] ?? '') !== $origin || !hash_equals($csrf, $_SERVER['HTTP_X_CSRF_TOKEN'] ?? ''))
                $respond(['status' => 'forbidden'], 403);
            if (strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0])) !== 'application/json')
                $respond(['status' => 'invalid'], 415);
            try {
                $body = file_get_contents('php://input', false, null, 0, 16385);
                if ($body === false || strlen($body) > 16384) throw new \InvalidArgumentException();
                $v = StrictJson::decode($body);
                if (!$v instanceof \stdClass || count(get_object_vars($v)) !== 2 ||
                    !property_exists($v, 'revision') || !property_exists($v, 'config') ||
                    ($v->revision !== null && (!is_string($v->revision) || !preg_match('/\A[a-f0-9]{64}\z/D', $v->revision))))
                    throw new \InvalidArgumentException();
                $config = ChargingSettings::validate($v->config);
                if (!property_exists($v->config, 'installation')) unset($config['installation']);
            } catch (\Throwable) { $respond(['status' => 'invalid'], 400); }
            $data = $store->operate($v->revision, $config);
        }
        $respond($data, match ($data['status']) { 'ok', 'disabled' => 200, 'invalid' => 400, 'conflict' => 409, default => 503 });
    }
}
