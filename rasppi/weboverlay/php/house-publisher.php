<?php
declare(strict_types=1);

require '/app/vendor/autoload.php';

use EvseOverlay\Config;
use EvseOverlay\SmartmeterConfig;
use EvseOverlay\SmartmeterClient;
use EvseOverlay\HousePublisher;
use EvseOverlay\HouseMqttPublisher;

set_time_limit(0);
umask(0077);
stream_set_blocking(STDERR, false);
$running = true; $mqtt = null; $health = '/tmp/evse-house-publisher';
pcntl_async_signals(true);
pcntl_signal(SIGTERM, static function () use (&$running): void { $running = false; });
pcntl_signal(SIGINT, static function () use (&$running): void { $running = false; });
$exit = 0;
try {
    $smart = SmartmeterConfig::fromEnvironment();
    // This dedicated CLI process may reuse generic broker credentials, but never
    // the website/Wallbox topic or client identity from the generic MQTT names.
    $housePrefix = getenv('HOUSE_MQTT_TOPIC_PREFIX');
    $houseClient = getenv('HOUSE_PUBLISHER_CLIENT_ID');
    putenv('MQTT_TOPIC_PREFIX=' . ($housePrefix === false ? 'evse/house' : $housePrefix));
    putenv('MQTT_CLIENT_ID=' . ($houseClient === false ? 'evse-house-publisher' : $houseClient));
    $mqtt = new HouseMqttPublisher(Config::fromEnvironment());
    $publisher = new HousePublisher();
    HousePublisher::health($health, true);
    $nextPoll = hrtime(true) / 1e9 + 0.25;
    $nextHealth = 0.0;
    while ($running) {
        $now = hrtime(true) / 1e9;
        if ($now >= $nextHealth) {
            HousePublisher::health($health, true);
            $nextHealth = $now + 0.25;
        }
        $publisher->expire($now, $smart->staleSeconds);
        $mqtt->tick($publisher->json(), $publisher->online($now, $smart->staleSeconds), $now);
        if ($now >= $nextPoll && $smart->enabled()) {
            try { $power = SmartmeterClient::fetch($smart); $error = null; }
            catch (Throwable) { $power = null; $error = 'read_failed'; }
            if (!$running) { break; }
            $publisher->observe($power, $error);
            $nextPoll = hrtime(true) / 1e9 + $smart->pollSeconds;
        }
        usleep(50000);
    }
} catch (Throwable) {
    @fwrite(STDERR, "Haus-Publisher nicht verfügbar\n"); $exit = 1;
} finally {
    if ($mqtt !== null) { $mqtt->close(); }
    try { HousePublisher::health($health, false); } catch (Throwable) {}
}
exit($exit);
