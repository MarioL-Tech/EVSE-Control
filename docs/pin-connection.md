# Pin Connection — Raspberry Pi ↔ ESP32

UART connection between the Raspberry Pi (40-pin header) and the ESP32 DevKit.
Both sides use **3.3V logic**, so no level shifter is required.

## Wiring

| Raspberry Pi (40-pin header) | ESP32 (DevKit) | Signal |
|---|---|---|
| GPIO 14 / TXD (pin 8) | GPIO 16 (Serial2 RX) | Pi TX → ESP32 RX |
| GPIO 15 / RXD (pin 10) | GPIO 17 (Serial2 TX) | Pi RX ← ESP32 TX |
| GND (pin 6) | GND | Common ground |

## Notes

- **Crossover:** TX of one side always goes to RX of the other side (never TX → TX).
- **Common ground (GND ↔ GND) is mandatory** — without it the UART signal has no reference and communication fails.
- **Never connect 5V to the ESP32 GPIOs** — the ESP32 is not 5V tolerant on most GPIOs.
- Serial2 on the ESP32 runs at **115200 baud, 8N1** (see `esp32/src/main.cpp`).
  The physical Pi UART is a trusted management boundary: a malicious Pi can
  enroll cards/change boot policy; no protocol authentication is provided.
- The Raspberry Pi serial port must be enabled first: `sudo raspi-config` → Interface Options → Serial Port (login shell: No, hardware: Yes). Coordinate any required reboot; see the [hardware preparation guide](installation.md#raspberry-pi-erstvorbereitung).

## MFRC522 RFID reader (allowlist-controlled model lock)

SPI connection between the MFRC522 module and the ESP32 DevKit.
VSPI defaults on the ESP32: SCK = GPIO18, MOSI = GPIO23, MISO = GPIO19.

| MFRC522 | ESP32 DevKit | Signal |
|---|---|---|
| SDA/SS | GPIO 5 | SPI chip select |
| SCK | GPIO 18 | SPI clock |
| MOSI | GPIO 23 | SPI MOSI |
| MISO | GPIO 19 | SPI MISO |
| RST | GPIO 22 | Reset |
| 3.3V | 3.3V | Power |
| GND | GND | Common ground |

Notes:

- The MFRC522 is a **3.3V device** — never connect it to 5V.
- The IRQ pin of the module is not connected (polling mode).
- Only enrolled UIDs toggle the requested servo target; other cards are denied.
  UIDs are clonable, not cryptographic authentication. Enrollment never toggles.
  Fresh presentation requires at least 500 ms clean no-card observations,
  including after confirmed enrollment START. Continuous radio reachability
  suppresses repeats; RF coupling loss can mimic removal without a physical sensor.
  See [UART protocol](uart-protocol.md) and [setup](installation.md#6-optionale-esp32-uart-testbrücke).

## Anti-theft servo (model servo)

Servo connection for the model lock, **independent of Wallbox charging**.
Requested targets: 90° locked/active, 0° unlocked/inactive. With empty NVS the
new firmware starts **locked at 90°**, with no allowed cards and `RESTORE`.
Configured startup: `RESTORE` restores the last saved requested target,
`LOCKED`/`UNLOCKED` always request their respective target at restart. Changing
policy does not move the servo now. Startup storage faults request locked;
runtime write faults request LOCKED/90°, cancel enrollment and latch a fault
until restart. This fallback cannot be saved on failure; subsequent RESTORE
reads the actual last valid durable blob, which may request a different target.

**Upgrade warning:** earlier firmware was a UART communication test starting
at 0°. New firmware is unflashed/unverified on real ESP32 hardware. Coordinate
safe movement and physical USB flashing before upgrading. No mechanical sensor
confirms the target, no power-loss security promise; SG90 is not certified
physical theft prevention. NVS is not claimed encrypted.
Native Arduino-2 LEDC drives GPIO13 (no ESP32Servo): baseline 544 µs at 0°,
1472 µs at 90°, range 544–2400 µs (ESP32Servo 1.1.2 default mapping reference).
Timer/duty are set before GPIO attachment;
`PWM_OK` does not prove mechanical position. The new dedicated NVS partition
requires a 4-MB board and coordinated partition-table/firmware/bootloader update;
see [flashing guide](installation.md#esp32-bauen-und-flashen). Never erase-all
or use stock SPIFFS overlapping the security partition.

| Servo (e.g. SG90) | ESP32 DevKit / PSU |
|---|---|
| Signal (orange) | GPIO 13 |
| VCC (red) | 5V (external or Pi 5V pin) |
| GND (brown) | GND (common with ESP32) |

Notes:

- **Do not power the servo from the ESP32 3V3 pin** — a model servo can draw
  100–250 mA under load, which overloads the 3.3V rail. Use a 5V supply and a
  **common ground** with the ESP32.
- The signal pin uses 3.3V logic, which is fine for common model servos (SG90, MG90S).

## Wallbox (ABB Terra AC) — NOT on ESP32 pins

The charging station is connected to the **Raspberry Pi** (not the ESP32) via
a USB-RS485 adapter — no GPIO wiring needed:

```text
Pi USB ──> USB-RS485 adapter ──A/B──> Wallbox RS-485 terminals
```

See the [installation guide](installation.md#rs485-zur-wallbox) for Modbus
configuration and `docs/wallbox/` for the register reference.
