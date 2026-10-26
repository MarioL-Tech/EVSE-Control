<?php
declare(strict_types=1);

require dirname(__DIR__) . '/vendor/autoload.php';

use EvseOverlay\Config;
use EvseOverlay\MqttTransport;
use EvseOverlay\SharedState;
use EvseOverlay\StateStore;

umask(0077);
set_time_limit(0);
stream_set_blocking(STDERR, false);
$stop = false;
pcntl_async_signals(true);
pcntl_signal(SIGTERM, static function () use (&$stop): void { $stop = true; });
pcntl_signal(SIGINT, static function () use (&$stop): void { $stop = true; });

try {
    $config = Config::fromEnvironment();
    $shared = new SharedState(getenv('WEB_STATE_DIR') ?: '/tmp/evse-weboverlay', $config->staleSeconds);
    $shared->reset();
    $delay = 1;
    while (!$stop) {
        $shared->update(static fn(StateStore $s) => $s->connection(false));
        $transport = new MqttTransport($config,
            static fn() => $shared->update(static fn(StateStore $s) => $s->connection(true)),
            static fn(string $payload) => $shared->update(static fn(StateStore $s) => $s->acceptSample($payload)),
            static fn(string $payload) => $shared->update(static fn(StateStore $s) => $s->acceptAvailability($payload)));
        $connectedAt = hrtime(true) / 1e9;
        try {
            $transport->connect();
            $lastTick = hrtime(true) / 1e9;
            $lastHeartbeat = $lastTick;
            while (!$stop) {
                $now = hrtime(true) / 1e9;
                if ($now - $lastTick >= SharedState::HEARTBEAT_SECONDS) {
                    throw new RuntimeException('MQTT worker paused');
                }
                $lastTick = $now;
                $transport->tick();
                if ($now - $lastHeartbeat >= 0.25) {
                    $shared->update(static function (StateStore $s): void {});
                    $lastHeartbeat = $now;
                }
                usleep(50000);
            }
        } catch (Throwable) {
            // Never print library exception messages: they can include credentials/payloads.
            if (!$stop) {
                @fwrite(STDERR, "MQTT connection unavailable; retrying\n");
            }
        } finally {
            $shared->update(static fn(StateStore $s) => $s->connection(false));
            $transport->close();
        }
        if (hrtime(true) / 1e9 - $connectedAt >= 15) {
            $delay = 1;
        }
        $until = hrtime(true) / 1e9 + $delay;
        while (!$stop && hrtime(true) / 1e9 < $until) {
            $shared->update(static function (StateStore $s): void {});
            usleep(250000);
        }
        $delay = min(30, $delay * 2);
    }
} catch (Throwable) {
    @fwrite(STDERR, "Weboverlay subscriber failed; check configuration and private state storage\n");
    exit(1);
}
