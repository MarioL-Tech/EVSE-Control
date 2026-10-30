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
use EvseOverlay\HouseHistoryConfig;
use EvseOverlay\HouseHistoryStore;
use EvseOverlay\HouseHistoryArchive;

header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header('X-Frame-Options: DENY');
header("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$assets = ['wallbox-control.js' => 'text/javascript', 'env-settings.js' => 'text/javascript', 'app.js' => 'text/javascript', 'charts.js' => 'text/javascript', 'history.js' => 'text/javascript', 'newcalendar.js' => 'text/javascript', 'theme.js' => 'text/javascript', 'smartmeter.js' => 'text/javascript', 'smartmeter-chart.js' => 'text/javascript',
    'house-history.js' => 'text/javascript', 'pwa.js' => 'text/javascript', 'style.css' => 'text/css', 'icon.svg' => 'image/svg+xml',
    'app-192.png' => 'image/png', 'app-512.png' => 'image/png',
    'app-maskable-512.png' => 'image/png', 'apple-touch-icon.png' => 'image/png',
    'offline.html' => 'text/html'];
$rootAssets = ['/manifest.webmanifest' => ['manifest.webmanifest', 'application/manifest+json'],
    '/service-worker.js' => ['service-worker.js', 'text/javascript']];
$pages = ['/' => 'index.html', '/diagramme' => 'diagrams.html', '/einstellungen' => 'settings.html'];
if ($path === '/wallbox') {
    if (in_array($_SERVER['REQUEST_METHOD'], ['GET', 'HEAD'], true)) {
        header('Location: /', true, 302);
    } else {
        http_response_code(405);
        header('Allow: GET, HEAD');
    }
    exit;
}
$asset = is_string($path) && str_starts_with($path, '/static/') ? substr($path, 8) : null;
$known = isset($pages[$path ?? '']) || in_array($path, ['/api/state', '/api/smartmeter', '/api/history', '/api/house-history', '/healthz'], true)
    || isset($rootAssets[$path ?? ''])
    || ($asset !== null && isset($assets[$asset]));

if ($path === '/api/settings-env') {
    \EvseOverlay\EnvSettingsHttp::handle();
}
if ($path === '/api/wallbox-control') {
    \EvseOverlay\ControlHttp::handle();
}
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

if (isset($rootAssets[$path])) {
    header('Content-Type: ' . $rootAssets[$path][1] . '; charset=utf-8');
    if ($path === '/service-worker.js') {
        header('Service-Worker-Allowed: /');
    }
    readfile(dirname(__DIR__) . '/static/' . $rootAssets[$path][0]);
} elseif (isset($pages[$path])) {
    header('Content-Type: text/html; charset=utf-8');
    readfile(dirname(__DIR__) . '/static/' . $pages[$path]);
} elseif ($asset !== null && isset($assets[$asset])) {
    header('Content-Type: ' . $assets[$asset] . '; charset=utf-8');
    readfile(dirname(__DIR__) . '/static/' . $asset);
} else {
    header('Content-Type: application/json; charset=utf-8');
    if ($path === '/healthz') {
        $result = ['status' => 'ok', 'read_only' => true];
    } elseif ($path === '/api/house-history') {
        try {
            $query = HistoryRange::parse($_SERVER['QUERY_STRING'] ?? '');
        } catch (InvalidArgumentException) {
            http_response_code(400);
            echo '{"error":"Invalid history query"}';
            exit;
        }
        try {
            $config = HouseHistoryConfig::fromEnvironment();
            $result = $query instanceof HistoryRange ? (new HouseHistoryArchive($config))->snapshot($query) :
                (new HouseHistoryStore($config))->snapshot($query);
        } catch (Throwable) {
            $result = HouseHistoryStore::envelope($query, 'unavailable');
        }
        if ($result['status'] === 'unavailable') { http_response_code(503); }
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
