<?php
declare(strict_types=1);

require dirname(__DIR__) . '/vendor/autoload.php';

use EvseOverlay\SharedState;
use EvseOverlay\StateStore;
use EvseOverlay\SmartmeterCache;
use EvseOverlay\SmartmeterConfig;
use EvseOverlay\HistoryConfig;
use EvseOverlay\HistoryStore;
use EvseOverlay\HistoryRange;
use EvseOverlay\HistoryArchive;

header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header('X-Frame-Options: DENY');
header("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$assets = ['app.js' => 'text/javascript', 'charts.js' => 'text/javascript', 'history.js' => 'text/javascript', 'newcalendar.js' => 'text/javascript', 'theme.js' => 'text/javascript', 'smartmeter.js' => 'text/javascript',
    'style.css' => 'text/css', 'icon.svg' => 'image/svg+xml'];
$pages = ['/' => 'index.html', '/diagramme' => 'diagrams.html', '/einstellungen' => 'settings.html'];
$asset = is_string($path) && str_starts_with($path, '/static/') ? substr($path, 8) : null;
$known = isset($pages[$path ?? '']) || in_array($path, ['/api/state', '/api/smartmeter', '/api/history', '/healthz'], true)
    || ($asset !== null && isset($assets[$asset]));

if (!$known) {
    http_response_code(404);
    header('Content-Type: application/json; charset=utf-8');
    echo '{"error":"Not found"}';
    exit;
}
if (!in_array($_SERVER['REQUEST_METHOD'], ['GET', 'HEAD'], true)) {
    http_response_code(405);
    header('Allow: GET, HEAD');
    header('Content-Type: application/json; charset=utf-8');
    echo '{"error":"Method not allowed"}';
    exit;
}

if (isset($pages[$path])) {
    header('Content-Type: text/html; charset=utf-8');
    readfile(dirname(__DIR__) . '/static/' . $pages[$path]);
} elseif ($asset !== null && isset($assets[$asset])) {
    header('Content-Type: ' . $assets[$asset] . '; charset=utf-8');
    readfile(dirname(__DIR__) . '/static/' . $asset);
} else {
    header('Content-Type: application/json; charset=utf-8');
    if ($path === '/healthz') {
        $result = ['status' => 'ok', 'read_only' => true];
    } elseif ($path === '/api/history') {
        try {
            $query = HistoryRange::parse($_SERVER['QUERY_STRING'] ?? '');
        } catch (InvalidArgumentException) {
            http_response_code(400);
            echo '{"error":"Invalid history query"}';
            exit;
        }
        try {
            $config = HistoryConfig::fromEnvironment();
            $result = $query instanceof HistoryRange ? (new HistoryArchive($config))->snapshot($query) :
                (new HistoryStore($config))->snapshot($query);
        } catch (Throwable) {
            $result = $query instanceof HistoryRange ? HistoryArchive::failure($query) : HistoryStore::failure($query);
        }
        if ($result['status'] === 'unavailable') {
            http_response_code(503);
        }
    } elseif ($path === '/api/smartmeter') {
        try {
            $result = (new SmartmeterCache(getenv('WEB_STATE_DIR') ?: '/tmp/evse-weboverlay',
                SmartmeterConfig::fromEnvironment()))->snapshot();
        } catch (Throwable) {
            $result = ['schema_version' => 1, 'read_only' => true, 'status' => 'offline',
                'reason' => 'Haus-Smartmeter-Empfänger nicht verfügbar', 'power_w' => null,
                'fetched_at' => null, 'age_seconds' => null, 'fresh_for_seconds' => 0];
        }
    } else {
        try {
            $staleText = getenv('WEB_STALE_SECONDS') ?: '10';
            if (!preg_match('/^[0-9]+$/D', $staleText) || (int) $staleText < 3 || (int) $staleText > 120) {
                throw new RuntimeException('Invalid freshness configuration');
            }
            $shared = new SharedState(getenv('WEB_STATE_DIR') ?: '/tmp/evse-weboverlay', (int) $staleText);
            $result = $shared->snapshot();
        } catch (Throwable) {
            $result = (new StateStore())->snapshot();
        }
    }
    echo json_encode($result, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
}
