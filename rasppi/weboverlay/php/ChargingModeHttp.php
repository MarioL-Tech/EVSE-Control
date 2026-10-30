<?php
declare(strict_types=1);
namespace EvseOverlay;

require_once __DIR__ . '/ControlHttp.php';
require_once __DIR__ . '/ChargingModeStore.php';

final class ChargingModeHttp
{
    private static function respond(array $data, int $code = 200): never
    {
        $body = json_encode(['schema_version' => 1, ...$data], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
        if (strlen($body) > 16384) { $body = '{"schema_version":1,"status":"unavailable"}'; $code = 503; }
        http_response_code($code); header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store'); header('X-Content-Type-Options: nosniff');
        if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'HEAD') echo $body;
        exit;
    }

    private static function root(): string { return getenv('SETTINGS_EDITOR_ROOT') ?: '/run/evse-settings'; }

    /**
     * Frozen reader wire (ok): schema_version/status/generated_at(epoch double)/
     * fresh_for_seconds(6)/config_revision(captured draft SHA)/activation{mode,id,guard}/config.
     * Disabled/unavailable carry no invented active snapshot. No session, origin
     * restriction, or draft application. Guard is a causal epoch, not a secret.
     */
    public static function handlePlan(): never
    {
        if (!in_array($_SERVER['REQUEST_METHOD'] ?? '', ['GET', 'HEAD'], true)) {
            header('Allow: GET, HEAD'); self::respond(['status' => 'invalid'], 405);
        }
        if (($_SERVER['QUERY_STRING'] ?? '') !== '') self::respond(['status' => 'invalid'], 400);
        if (getenv('SETTINGS_EDITOR_ENABLED') !== '1') self::respond(['status' => 'disabled']);
        // Validate the prepared draft store as well; unsafe/unreadable settings fail closed.
        $draft = (new ChargingSettings(self::root(), true))->operate();
        if ($draft['status'] !== 'ok') self::respond(['status' => 'unavailable'], 503);
        $state = (new ChargingModeStore(self::root(), true))->read();
        if ($state['status'] !== 'ok') self::respond(['status' => 'unavailable'], 503);
        $active = $state['active'];
        self::respond(['status' => 'ok', 'generated_at' => microtime(true), 'fresh_for_seconds' => 6,
            'config_revision' => $active['config_revision'], 'activation' => ['mode' => $active['mode'], 'id' => $active['id'], 'guard' => $active['guard']],
            'config' => $active['config']]);
    }

    /**
     * POST exactly {mode,revision,config_revision,guard}. Get a fresh reader
     * inspection's automation.guard before EACH explicit selection, including
     * reselection. Only the sole Modbus owner can accept that reader epoch.
     * activation_requested and automation_available describe staged protocol
     * intent/support, NOT actual automation/reader state or permission after restart.
     * Manual selection is not a physical Stop. No save/GET/reload activates anything.
     */
    public static function handleMode(): never
    {
        $method = $_SERVER['REQUEST_METHOD'] ?? ''; $csrf = null;
        $reply = static function (array $data, int $code = 200) use (&$csrf): never {
            self::respond([...$data, 'csrf' => $csrf, 'automation_available' => true,
                'semantics' => 'activation_requested'], $code);
        };
        $origin = getenv('SETTINGS_EDITOR_ORIGIN') ?: ''; $parts = ControlHttp::originParts($origin);
        if ($parts === null) $reply(['status' => 'unavailable'], 503);
        if (($_SERVER['HTTP_HOST'] ?? '') !== $parts['authority'] ||
            (isset($_SERVER['HTTP_ORIGIN']) && $_SERVER['HTTP_ORIGIN'] !== $origin) ||
            (isset($_SERVER['HTTP_SEC_FETCH_SITE']) && !in_array($_SERVER['HTTP_SEC_FETCH_SITE'], ['same-origin', 'none'], true)))
            $reply(['status' => 'forbidden'], 403);
        if (!in_array($method, ['GET', 'HEAD', 'POST'], true)) {
            header('Allow: GET, HEAD, POST'); $reply(['status' => 'invalid'], 405);
        }
        if (($_SERVER['QUERY_STRING'] ?? '') !== '') $reply(['status' => 'invalid'], 400);
        if (getenv('SETTINGS_EDITOR_ENABLED') !== '1') $reply(['status' => 'disabled']);
        try {
            session_name('evse_charging_mode_csrf');
            ini_set('session.save_path', '/tmp'); ini_set('session.use_strict_mode', '1'); ini_set('session.use_only_cookies', '1');
            session_set_cookie_params(['lifetime' => 0, 'path' => '/api/charging-mode', 'secure' => $parts['secure'],
                'httponly' => true, 'samesite' => 'Strict']);
            if (!@session_start()) throw new \RuntimeException();
            $now = time();
            if (!isset($_SESSION['csrf'], $_SESSION['created']) || !is_string($_SESSION['csrf']) ||
                !is_int($_SESSION['created']) || $now < $_SESSION['created'] || $now - $_SESSION['created'] >= 1800)
                $_SESSION = ['csrf' => bin2hex(random_bytes(32)), 'created' => $now];
            $csrf = $_SESSION['csrf']; session_write_close();
        } catch (\Throwable) { $reply(['status' => 'unavailable'], 503); }
        $settings = new ChargingSettings(self::root(), true); $store = new ChargingModeStore(self::root(), true);
        if ($method === 'POST') {
            if (($_SERVER['HTTP_ORIGIN'] ?? '') !== $origin || !hash_equals($csrf, $_SERVER['HTTP_X_CSRF_TOKEN'] ?? ''))
                $reply(['status' => 'forbidden'], 403);
            if (strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0])) !== 'application/json')
                $reply(['status' => 'invalid'], 415);
            try {
                $body = file_get_contents('php://input', false, null, 0, 2049);
                if ($body === false || strlen($body) > 2048) throw new \InvalidArgumentException();
                $v = StrictJson::decode($body);
                if (!$v instanceof \stdClass) throw new \InvalidArgumentException();
                $keys = array_keys(get_object_vars($v)); sort($keys);
                if ($keys !== ['config_revision', 'guard', 'mode', 'revision'] || !in_array($v->mode, ['manual', 'pv', 'custom'], true) ||
                    !is_string($v->guard) || !preg_match('/\A[a-f0-9]{32}\z/D', $v->guard) ||
                    !is_string($v->config_revision) || !preg_match('/\A[a-f0-9]{64}\z/D', $v->config_revision) ||
                    ($v->revision !== null && (!is_string($v->revision) || !preg_match('/\A[a-f0-9]{64}\z/D', $v->revision))))
                    throw new \InvalidArgumentException();
            } catch (\Throwable) { $reply(['status' => 'invalid'], 400); }
            // Opaque reader-owned causal epoch; PHP validates shape only, never authorizes it.
            $state = $store->activate($v->mode, $v->revision, $v->config_revision, $v->guard);
            if ($state['status'] !== 'ok') $reply($state, match ($state['status']) { 'invalid' => 400, 'conflict' => 409, default => 503 });
            // Echo the revision actually captured, not a later draft revision.
            $draftRevision = $state['active']['config_revision'];
        } else {
            $draft = $settings->operate();
            if ($draft['status'] !== 'ok') $reply(['status' => 'unavailable'], 503);
            $draftRevision = ChargingModeStore::draftRevision($draft);
            $state = $store->read();
            if ($state['status'] !== 'ok') $reply(['status' => 'unavailable'], 503);
        }
        $reply(['status' => 'ok', 'mode_revision' => $state['mode_revision'], 'config_revision' => $draftRevision,
            'activation' => ['mode' => $state['active']['mode'], 'id' => $state['active']['id'], 'guard' => $state['active']['guard']], 'required' => []]);
    }
}
