<?php
declare(strict_types=1);

namespace EvseOverlay;

/** Publish-only MQTT 3.1.1. No subscription/parser shared with the website.
 * php-mqtt/client v2.3.2 loopOnce() drains all available input and parses its
 * entire buffer without an input/work budget. This deliberately smaller
 * transport accepts only CONNACK, PUBACK and PINGRESP, with fixed-size frames.
 */
final class HouseMqttPublisher
{
    private const ACK_SECONDS = 3.0;
    private const KEEPALIVE_SECONDS = 15;
    private const PING_AFTER_SECONDS = 5.0;
    private const MAX_INPUT_BYTES = 512;
    private const MAX_OUTPUT_BYTES = 20000;

    private $socket = null;
    private string $phase = 'closed';
    private string $input = '';
    private string $output = '';
    private array $pending = [];
    private int $mid = 0;
    private float $deadline = 0;
    private float $retryAt = 0;
    private float $lastIo = 0;
    private ?float $pingAt = null;
    private float $backoff = 1;
    private ?string $sent = null;

    public function __construct(private readonly Config $config) {}
    public function __debugInfo(): array { return ['phase' => $this->phase, 'pending' => count($this->pending)]; }
    private static function field(string $value): string
    {
        if (strlen($value) > 65535 || str_contains($value, "\0") || preg_match('//u', $value) !== 1) {
            throw new \RuntimeException('Invalid MQTT field');
        }
        return pack('n', strlen($value)) . $value;
    }
    private static function packet(int $header, string $body): string
    {
        $n = strlen($body); $length = '';
        do { $byte = $n % 128; $n = intdiv($n, 128); $length .= chr($byte | ($n ? 128 : 0)); } while ($n);
        return chr($header) . $length . $body;
    }

    private function appendOutput(string $packet): void
    {
        if (strlen($this->output) + strlen($packet) > self::MAX_OUTPUT_BYTES) {
            throw new \RuntimeException('MQTT output exceeds bound');
        }
        $this->output .= $packet;
    }

    private function connect(float $now): void
    {
        $host = $this->config->host;
        if (str_contains($host, ':') && $host[0] !== '[') { $host = '[' . $host . ']'; }
        $this->socket = @stream_socket_client('tcp://' . $host . ':' . $this->config->port,
            $errno, $error, 0, STREAM_CLIENT_CONNECT | STREAM_CLIENT_ASYNC_CONNECT);
        if ($this->socket === false) { $this->socket = null; throw new \RuntimeException(); }
        stream_set_blocking($this->socket, false);
        $flags = 2 | 4 | 8 | 32; // clean session, QoS-1 retained offline will
        $payload = self::field($this->config->clientId)
            . self::field($this->config->prefix . '/availability') . self::field('offline');
        if ($this->config->username !== '') { $flags |= 128; $payload .= self::field($this->config->username); }
        if ($this->config->password() !== '') { $flags |= 64; $payload .= self::field($this->config->password()); }
        $this->output = '';
        $this->appendOutput(self::packet(16, self::field('MQTT') . chr(4) . chr($flags)
            . pack('n', self::KEEPALIVE_SECONDS) . $payload));
        $this->phase = 'connecting'; $this->deadline = $now + self::ACK_SECONDS;
        $this->lastIo = $now;
    }
    private function publish(string $topic, string $payload, float $now): void
    {
        if (count($this->pending) >= 2) { throw new \LogicException('Pending bound'); }
        $this->mid = $this->mid % 65535 + 1;
        $this->pending[$this->mid] = $now + self::ACK_SECONDS;
        $this->appendOutput(self::packet(0x33, self::field($topic) . pack('n', $this->mid) . $payload));
    }
    private function drop(float $now): void
    {
        if (is_resource($this->socket)) { fclose($this->socket); }
        $this->socket = null; $this->phase = 'closed'; $this->input = $this->output = '';
        $this->pending = []; $this->sent = null; $this->pingAt = null;
        $this->retryAt = $now + $this->backoff; $this->backoff = min(30, $this->backoff * 2);
    }

    private function writeAvailable(float $now): void
    {
        if ($this->output === '') {
            return;
        }
        $written = @fwrite($this->socket, $this->output, self::MAX_OUTPUT_BYTES);
        if ($written === false) {
            throw new \RuntimeException('MQTT write failed');
        }
        if ($written > 0) {
            $this->output = substr($this->output, $written);
            $this->lastIo = $now;
        }
    }

    private function readAvailable(float $now): void
    {
        $bytes = @fread($this->socket, 256);
        if ($bytes === false || ($bytes === '' && feof($this->socket))) {
            throw new \RuntimeException('MQTT read failed');
        }
        if ($bytes !== '') {
            $this->input .= $bytes;
            $this->lastIo = $now;
        }
        if (strlen($this->input) > self::MAX_INPUT_BYTES) {
            throw new \RuntimeException('MQTT input exceeds bound');
        }
    }

    private function processInput(): void
    {
        // Every accepted server packet has a canonical one-byte remaining length.
        for ($budget = 0; $budget < 64 && strlen($this->input) >= 2; ++$budget) {
            $header = ord($this->input[0]);
            $length = ord($this->input[1]);
            if (!in_array($header, [0x20, 0x40, 0xd0], true)
                || $length !== ($header === 0xd0 ? 0 : 2)) {
                throw new \RuntimeException('Unexpected MQTT packet');
            }
            if (strlen($this->input) < $length + 2) {
                break;
            }
            $body = substr($this->input, 2, $length);
            $this->input = substr($this->input, 2 + $length);
            if ($this->phase === 'connecting') {
                if ($header !== 0x20 || $body !== "\0\0" || $this->output !== '') {
                    throw new \RuntimeException('MQTT connection rejected');
                }
                $this->phase = 'ready';
                continue;
            }
            if ($this->phase !== 'ready') {
                throw new \RuntimeException('Unexpected MQTT phase');
            }
            if ($header === 0x40) {
                $id = unpack('n', $body)[1];
                if (!isset($this->pending[$id])) {
                    throw new \RuntimeException('Unexpected MQTT acknowledgement');
                }
                unset($this->pending[$id]);
                if (!$this->pending) {
                    $this->backoff = 1;
                }
            } elseif ($header === 0xd0 && $this->pingAt !== null) {
                $this->pingAt = null;
            } else {
                throw new \RuntimeException('Unexpected MQTT packet');
            }
        }
    }

    private function checkDeadlines(float $now): void
    {
        if (($this->phase !== 'ready' && $now >= $this->deadline)
            || ($this->pending && $now >= min($this->pending))
            || ($this->pingAt !== null && $now - $this->pingAt >= self::ACK_SECONDS)) {
            throw new \RuntimeException('MQTT acknowledgement timed out');
        }
    }

    /** One bounded turn; latest observation is retained by the caller, never queued here. */
    public function tick(string $sample, bool $online, float $now): void
    {
        if ($sample === '' || strlen($sample) > 8192 || !is_finite($now) || $now < 0) {
            throw new \InvalidArgumentException('Invalid publisher turn');
        }
        try {
            if ($this->phase === 'closed') {
                if ($now < $this->retryAt) { return; }
                $this->connect($now);
            }
            $this->checkDeadlines($now);
            $read = [$this->socket]; $write = $this->output !== '' ? [$this->socket] : []; $except = [$this->socket];
            if (@stream_select($read, $write, $except, 0, 0) === false || $except) { throw new \RuntimeException(); }
            if ($write) { $this->writeAvailable($now); }
            if ($read) { $this->readAvailable($now); }
            $this->processInput();
            $key = hash('sha256', ($online ? "1\0" : "0\0") . $sample);
            if ($this->phase === 'ready' && !$this->pending && $this->output === '' && $this->sent !== $key) {
                $this->publish($this->config->prefix . '/state', $sample, $now);
                $this->publish($this->config->prefix . '/availability', $online ? 'online' : 'offline', $now);
                $this->sent = $key;
            } elseif ($this->phase === 'ready' && !$this->pending && $this->output === ''
                && $this->pingAt === null && $now - $this->lastIo >= self::PING_AFTER_SECONDS) {
                $this->appendOutput("\xc0\0");
                $this->pingAt = $now;
            }
        } catch (\Throwable) { $this->drop($now); }
    }
    /** If the offline PUBACK cannot be obtained in 500 ms, closing triggers LWT. */
    public function close(): void
    {
        $end = hrtime(true) / 1e9 + 0.5;
        if ($this->phase === 'ready' && !$this->pending && $this->output === '') {
            $this->publish($this->config->prefix . '/availability', 'offline', hrtime(true) / 1e9);
            // tick must not enqueue a new state during shutdown.
            while (($this->pending || $this->output !== '') && hrtime(true) / 1e9 < $end
                && is_resource($this->socket)) {
                $r = [$this->socket]; $w = $this->output !== '' ? [$this->socket] : []; $e = [];
                if (@stream_select($r, $w, $e, 0, 10000) === false) { break; }
                try {
                    $now = hrtime(true) / 1e9;
                    if ($w) { $this->writeAvailable($now); }
                    if ($r) { $this->readAvailable($now); }
                    $this->processInput();
                } catch (\Throwable) { break; }
            }
            if (!$this->pending && $this->output === '' && is_resource($this->socket)) {
                @fwrite($this->socket, "\xe0\0");
            }
        }
        $this->drop(hrtime(true) / 1e9);
    }
}
