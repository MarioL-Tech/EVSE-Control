<?php
declare(strict_types=1);

namespace EvseOverlay;

use PhpMqtt\Client\ConnectionSettings;
use PhpMqtt\Client\Message;
use PhpMqtt\Client\MessageType;
use PhpMqtt\Client\MqttClient;
use PhpMqtt\Client\Repositories\MemoryRepository;
use PhpMqtt\Client\SubscribeRequest;

final class MqttTransport
{
    private ?BoundedMqttClient $client = null;
    private bool $ready = false;
    private array $acked = [];
    private array $held = [];
    private float $subscribeStarted = 0;
    private float $loopStarted = 0;
    private readonly \Closure $onReady;
    private readonly \Closure $onState;
    private readonly \Closure $onAvailability;

    public function __construct(private readonly Config $config, callable $onReady, callable $onState, callable $onAvailability)
    {
        $this->onReady = \Closure::fromCallable($onReady);
        $this->onState = \Closure::fromCallable($onState);
        $this->onAvailability = \Closure::fromCallable($onAvailability);
    }

    public function connect(): void
    {
        $this->close();
        $this->client = new BoundedMqttClient($this->config,
            function (string $topic): void {
                $this->acked[$topic] = true;
                if (!$this->ready && isset($this->acked[$this->config->prefix . '/state'],
                    $this->acked[$this->config->prefix . '/availability'])) {
                    $this->ready = true;
                    ($this->onReady)();
                    $held = $this->held;
                    $this->held = [];
                    foreach ($held as $name => $payload) {
                        $this->deliver($name, $payload);
                    }
                }
            },
            function (string $topic, string $payload): void {
                if ($topic !== $this->config->prefix . '/state' && $topic !== $this->config->prefix . '/availability') {
                    return;
                }
                $limit = $topic === $this->config->prefix . '/state' ? 16384 : 16;
                if (strlen($payload) > $limit) {
                    throw new \RuntimeException('MQTT payload exceeds limit.');
                }
                if (!$this->ready) {
                    $this->held[$topic] = $payload;
                } else {
                    $this->deliver($topic, $payload);
                }
            });
        try {
            $settings = (new ConnectionSettings())->setKeepAliveInterval(15)
                ->setConnectTimeout(2)->setSocketTimeout(2)->setReconnectAutomatically(false);
            if ($this->config->username !== '') {
                $settings = $settings->setUsername($this->config->username)->setPassword($this->config->password());
            }
            $this->client->connect($settings, true);
            $this->subscribeStarted = hrtime(true) / 1e9;
            $this->loopStarted = microtime(true);
            $this->client->subscribe($this->config->prefix . '/state', null, 1);
            $this->client->subscribe($this->config->prefix . '/availability', null, 1);
        } catch (\Throwable $error) {
            $this->close();
            throw $error;
        }
    }

    private function deliver(string $topic, string $payload): void
    {
        if ($topic === $this->config->prefix . '/state') {
            ($this->onState)($payload);
        } else {
            ($this->onAvailability)($payload);
        }
    }

    public function tick(): void
    {
        if ($this->client === null) {
            throw new \RuntimeException('MQTT transport is closed.');
        }
        try {
            $this->client->checkFrameDeadline();
            if (!$this->ready && hrtime(true) / 1e9 - $this->subscribeStarted >= 3) {
                throw new \RuntimeException('MQTT subscription acknowledgement timed out.');
            }
            $this->client->loopOnce($this->loopStarted, false);
        } catch (\Throwable $error) {
            $this->close();
            throw $error;
        }
    }

    public function close(): void
    {
        // Also closes sockets left open by an unsuccessful upstream handshake.
        $client = $this->client;
        $this->client = null;
        $this->ready = false;
        $this->acked = $this->held = [];
        $client?->forceClose();
    }
}

/** IO/framing safety adapter, not a second MQTT parser. MQTT semantics stay upstream. */
final class BoundedMqttClient extends MqttClient
{
    private MemoryRepository $retainedRepository;
    private int $phase = 0; // 0: fixed header, 1: remaining length, 2: body
    private int $lengthBytes = 0;
    private int $remaining = 0;
    private ?float $frameStarted = null;

    public function __construct(Config $config, private readonly \Closure $onAck, private readonly \Closure $onPayload)
    {
        $this->retainedRepository = new MemoryRepository();
        parent::__construct($config->host, $config->port, $config->clientId,
            self::MQTT_3_1_1, $this->retainedRepository);
    }

    public function forceClose(): void { $this->closeSocket(); }

    public function checkFrameDeadline(): void
    {
        if ($this->frameStarted !== null && hrtime(true) / 1e9 - $this->frameStarted >= 3) {
            throw new \RuntimeException('MQTT partial frame timed out.');
        }
    }

    private function guard(string $data): void
    {
        $this->checkFrameDeadline();
        for ($i = 0, $size = strlen($data); $i < $size;) {
            if ($this->phase === 0) {
                $this->frameStarted = hrtime(true) / 1e9;
                $this->remaining = $this->lengthBytes = 0;
                $this->phase = 1;
                ++$i;
            } elseif ($this->phase === 1) {
                $byte = ord($data[$i++]);
                $this->remaining += ($byte & 127) << (7 * $this->lengthBytes++);
                if ($this->remaining > 32768 || ($this->lengthBytes === 4 && ($byte & 128))) {
                    throw new \RuntimeException('MQTT remaining length is invalid or exceeds limit.');
                }
                if (($byte & 128) === 0) {
                    $this->phase = $this->remaining === 0 ? 0 : 2;
                    if ($this->phase === 0) { $this->frameStarted = null; }
                }
            } else {
                $take = min($this->remaining, $size - $i);
                $this->remaining -= $take;
                $i += $take;
                if ($this->remaining === 0) {
                    $this->phase = 0;
                    $this->frameStarted = null;
                }
            }
        }
    }

    protected function readFromSocket(int $limit = 8192, bool $withoutBlocking = false): string
    {
        if (!is_resource($this->socket)) {
            throw new \RuntimeException('MQTT socket is closed.');
        }
        $deadline = hrtime(true) / 1e9 + 2;
        do {
            $this->checkFrameDeadline();
            $left = $deadline - hrtime(true) / 1e9;
            if ($left <= 0) { throw new \RuntimeException('MQTT socket read timed out.'); }
            $read = [$this->socket];
            $write = $except = [];
            $wait = $withoutBlocking ? 0 : min(100000, (int) ($left * 1e6));
            $selected = @stream_select($read, $write, $except, 0, $wait);
            if ($selected === false) { throw new \RuntimeException('MQTT socket select failed.'); }
            if ($selected === 0) {
                if ($withoutBlocking) { return ''; }
                continue;
            }
            $data = @fread($this->socket, min(8192, max(1, $limit)));
            if ($data === false || ($data === '' && feof($this->socket))) {
                throw new \RuntimeException('MQTT socket read failed or reached EOF.');
            }
            if ($data !== '') {
                $this->guard($data);
                return $data;
            }
            if ($withoutBlocking) { return ''; }
        } while (true);
    }

    protected function readAllAvailableDataFromSocket(bool $withAutoReconnectIfConfigured = false): string
    {
        return $this->readFromSocket(8192, true);
    }

    protected function handleMessage(Message $message): void
    {
        if ($message->getType()->equals(MessageType::PUBLISH())) {
            // No subscription callbacks are registered upstream: intercept even retained
            // PUBLISH packets arriving before their own subscription is acknowledged.
            if (!in_array($message->getQualityOfService(), [0, 1], true)) {
                throw new \RuntimeException('Unexpected MQTT publish QoS.');
            }
            parent::handleMessage($message);
            ($this->onPayload)($message->getTopic(), $message->getContent());
            return;
        }
        if ($message->getType()->equals(MessageType::SUBSCRIBE_ACKNOWLEDGEMENT())) {
            $pending = $this->retainedRepository->getPendingOutgoingMessage($message->getMessageId());
            if (!$pending instanceof SubscribeRequest) {
                return; // Unknown/replayed ACK never contributes to readiness.
            }
            $subscriptions = $pending->getSubscriptions();
            $qos = $message->getAcknowledgedQualityOfServices();
            if (count($subscriptions) !== count($qos) || count($qos) !== 1 || !in_array($qos[0], [0, 1], true)) {
                throw new \RuntimeException('MQTT subscription rejected or invalid acknowledgement.');
            }
            parent::handleMessage($message);
            ($this->onAck)($subscriptions[0]->getTopicFilter());
            return;
        }
        parent::handleMessage($message);
    }
}
