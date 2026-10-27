<?php
declare(strict_types=1);

require '/app/vendor/autoload.php';

use EvseOverlay\SmartmeterCache;
use EvseOverlay\SmartmeterClient;
use EvseOverlay\SmartmeterConfig;

set_time_limit(0);
stream_set_blocking(STDERR, false);
$running = true;
pcntl_async_signals(true);
pcntl_signal(SIGTERM, static function () use (&$running): void { $running = false; });
pcntl_signal(SIGINT, static function () use (&$running): void { $running = false; });
try {
    $config = SmartmeterConfig::fromEnvironment();
    $cache = new SmartmeterCache(getenv('WEB_STATE_DIR') ?: '/tmp/evse-weboverlay', $config);
    $cache->reset();
    $next = 0.0;
    while ($running) {
        $now = hrtime(true) / 1e9;
        if ($config->enabled() && $now >= $next) {
            $next = $now + $config->pollSeconds;
            try {
                $power = SmartmeterClient::fetch($config);
                if ($running) {
                    $cache->success($power);
                }
            } catch (Throwable) {
                if ($running) {
                    $cache->failure();
                }
            }
        }
        if ($running) {
            $cache->heartbeat();
            usleep(250000);
        }
    }
} catch (Throwable) {
    @fwrite(STDERR, "Haus-Smartmeter-Dienst nicht verfügbar\n");
    exit(1);
}
