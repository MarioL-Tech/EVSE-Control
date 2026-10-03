"""UART bridge between Raspberry Pi and ESP32 (EVSE-Control).

The ESP32 reports charging status and RFID events; this script prints them
and lets you send commands to the ESP32.

Commands (type in the terminal):
  on       -> CMD:CHARGE:ON
  off      -> CMD:CHARGE:OFF
  status   -> CMD:STATUS
  anything else is passed through as-is.

Run in Docker: docker compose -f rasppi/compose.yaml run --rm --build uart-bridge
Requires pyserial inside the image; do not install it on the Pi host.
"""

import select
import serial
import sys

PORT = "/dev/serial0"
BAUD = 115200

ser = serial.Serial(PORT, BAUD, timeout=0.1)
print(f"EVSE UART bridge: listening on {PORT} @ {BAUD} baud")
print("Commands: 'on' | 'off' | 'status' | <raw line> | Ctrl+C to stop")

try:
    while True:
        # Pi -> ESP32: interactive commands
        if select.select([sys.stdin], [], [], 0)[0]:
            line = sys.stdin.readline().strip()
            if line == "":
                continue
            cmd = {
                "on": "CMD:CHARGE:ON",
                "off": "CMD:CHARGE:OFF",
                "status": "CMD:STATUS",
            }.get(line.lower(), line)
            ser.write((cmd + "\n").encode())
            print(f"TX -> ESP32: {cmd}")

        # ESP32 -> Pi: status / RFID events
        line = ser.readline()
        if line:
            text = line.decode("utf-8", errors="replace").rstrip()
            print(f"RX <- ESP32: {text}")
except KeyboardInterrupt:
    print("\nStopped by user")
finally:
    ser.close()
