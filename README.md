⚡ SmartCharge: Intelligent EV Management
SmartCharge is an open-source solution designed to optimize electric vehicle charging. By balancing energy costs, grid load, and user requirements, this project ensures your car is ready when you need it, at the lowest possible cost to both your wallet and the planet.

✨ Key Features
📈 Dynamic Pricing Integration: Automatically schedules charging during off-peak hours based on real-time electricity market data.

☀️ Solar Forecasting: Prioritizes charging when your home solar panels are producing excess energy.

🔋 Battery Health Optimization: Prevents degradation by managing state-of-charge (SoC) limits and charging speeds.

📱 Remote Monitoring: Track your charging progress and energy savings through a sleek dashboard.

🔌 Universal Compatibility: Supports major EVSE (Electric Vehicle Supply Equipment) protocols.

---

## Architecture

```text
┌─────────────┐   UART (115200 8N1)   ┌──────────────┐   MQTT (1883)   ┌──────────────────┐
│    ESP32    │◄────────────────────►│ Raspberry Pi │◄───────────────►│ Home Assistant /  │
│ RFID (MFRC522) │                    │ Modbus master│                 │ web overlay       │
│ anti-theft servo │                  └──────┬───────┘                 └──────────────────┘
└─────────────┘                             │ RS-485 (Modbus RTU, 57600 8E1, ID 9)
                                     ┌──────▼───────┐
                                     │ ABB Terra AC │
                                     │   wallbox    │
                                     └──────────────┘
```

- **ESP32:** RFID manual override (MFRC522), anti-theft servo, UART bridge to the Pi.
- **Raspberry Pi:** Modbus RTU master to the wallbox (USB-RS485), MQTT broker + bridge, Home Assistant integration, web overlay.
- Protocol contracts: `docs/uart-protocol.md` (ESP32 ↔ Pi), `docs/wallbox/` (Pi ↔ wallbox Modbus).

## Current implementation

- ESP32 RFID/servo controller and interactive Python UART bridge.
- Read-only C++/libmodbus wallbox reader with JSON output, tests and Pi build/
  Docker Compose instructions: [`rasppi/wallbox/README.md`](rasppi/wallbox/README.md).
  Real wallbox validation and Pi deployment are still pending.
- MQTT integration, charging control, database, Home Assistant, web overlay
  and automated scheduling are planned, not implemented yet.
