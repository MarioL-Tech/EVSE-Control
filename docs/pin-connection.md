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
- Serial2 on the ESP32 runs at 115200 baud (see `esp32/src/main.cpp`).
- The Raspberry Pi serial port must be enabled first: `sudo raspi-config` → Interface Options → Serial Port (login shell: No, hardware: Yes). Coordinate any required reboot; see the [hardware preparation guide](installation.md#raspberry-pi-erstvorbereitung).

## MFRC522 RFID reader (manual override)

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
- A card tap acts as manual override and **toggles the anti-theft lock**
  (see `docs/uart-protocol.md`): first tap locks, next tap unlocks.

## Anti-theft servo (model servo)

Servo connection for the anti-theft lock. The lock is toggled by RFID taps
(manual override, **independent of the charging state**): first tap locks
(90°), next tap unlocks (0°). **At boot the lock starts released (0°).**

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
