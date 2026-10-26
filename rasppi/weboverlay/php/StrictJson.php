<?php
declare(strict_types=1);

namespace EvseOverlay;

/** JSON objects remain stdClass, so arrays cannot masquerade as objects. */
final class StrictJson
{
    private int $offset = 0;

    private function __construct(private string $text) {}

    public static function decode(string $text): mixed
    {
        // Native decoding checks UTF-8, escapes, grammar and trailing input.
        $value = json_decode($text, false, 512, JSON_THROW_ON_ERROR);
        $parser = new self($text);
        $parser->value(0);
        return $value;
    }

    private function whitespace(): void
    {
        $this->offset += strspn($this->text, " \t\r\n", $this->offset);
    }

    private function stringToken(): string
    {
        $start = $this->offset++;
        while ($this->text[$this->offset] !== '"') {
            if ($this->text[$this->offset] === '\\') {
                ++$this->offset;
            }
            ++$this->offset;
        }
        ++$this->offset;
        return json_decode(substr($this->text, $start, $this->offset - $start), false, 512, JSON_THROW_ON_ERROR);
    }

    private function value(int $depth): void
    {
        $this->whitespace();
        $char = $this->text[$this->offset];
        if ($char === '{' || $char === '[') {
            if ($depth >= 64) {
                throw new \UnexpectedValueException('JSON nesting too deep');
            }
            $object = $char === '{';
            $end = $object ? '}' : ']';
            ++$this->offset;
            $this->whitespace();
            $keys = [];
            if ($this->text[$this->offset] === $end) {
                ++$this->offset;
                return;
            }
            while (true) {
                if ($object) {
                    $this->whitespace();
                    $key = $this->stringToken();
                    // Prefix prevents PHP's numeric-string array key coercion.
                    $identity = ':' . $key;
                    if (isset($keys[$identity])) {
                        throw new \UnexpectedValueException('Duplicate JSON key');
                    }
                    $keys[$identity] = true;
                    $this->whitespace();
                    ++$this->offset; // colon (grammar already validated)
                }
                $this->value($depth + 1);
                $this->whitespace();
                if ($this->text[$this->offset++] === $end) {
                    return;
                }
            }
        }
        if ($char === '"') {
            $this->stringToken();
            return;
        }
        $start = $this->offset;
        $this->offset += strcspn($this->text, ",]} \t\r\n", $start);
        $token = substr($this->text, $start, $this->offset - $start);
        if ($token !== 'true' && $token !== 'false' && $token !== 'null') {
            $number = json_decode($token, false, 512, JSON_THROW_ON_ERROR);
            if (is_float($number) && !is_finite($number)) {
                throw new \UnexpectedValueException('Non-finite JSON number');
            }
        }
    }
}
