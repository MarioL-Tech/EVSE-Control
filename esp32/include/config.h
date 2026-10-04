#pragma once

// --- UART link ESP32 <-> Raspberry Pi ---
#define UART_BAUD     115200
#define UART_RX_PIN   16     // from Pi TXD (GPIO14)
#define UART_TX_PIN   17     // to Pi RXD (GPIO15)

// --- MFRC522 RFID reader (SPI) ---
// ESP32 DevKit VSPI defaults: SCK=GPIO18, MOSI=GPIO23, MISO=GPIO19
#define RFID_SS_PIN   5      // SDA/SS of the MFRC522
#define RFID_RST_PIN  22     // RST of the MFRC522

// --- Reader timing (authorization/persistence/framing constants: security.h/protocol.h) ---
#define RFID_POLL_MS       50
#define UART_BYTE_BUDGET   64

// --- Anti-theft servo ---
// Model servo; authorized taps toggle independently of charging.
// Startup policy is persisted in NVS; default RESTORE with LOCKED fallback.
// Requested position only: there is no mechanical feedback sensor.
#define SERVO_PIN       13
#define SERVO_UNLOCK_DEG 0
#define SERVO_LOCK_DEG   90

// Explicit pulse mapping replaces the unpinned servo library. Calibrate unloaded.
// ESP32Servo 1.1.2 default range: 544..2400 us for 0..180 degrees.
#define SERVO_MIN_US     544
#define SERVO_MAX_US     2400
#define SERVO_CHANNEL    0
#define SERVO_HZ         50
#define SERVO_BITS       16
