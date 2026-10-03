# UART Protocol — ESP32 ↔ Raspberry Pi

Line-based ASCII protocol over the UART link (115200 baud, `\n` terminated).
This is the contract between the ESP32 and the Raspberry Pi. See
`docs/pin-connection.md` for the wiring.

## ESP32 → Raspberry Pi

| Message | Meaning |
|---|---|
| `EVSE:STATUS:CHARGING:ON:SRC:<source>` | Charging started |
| `EVSE:STATUS:CHARGING:OFF:SRC:<source>` | Charging stopped |
| `EVSE:STATUS:ANTITHEFT:ACTIVE:SRC:<source>` | Anti-theft lock engaged (servo 90°) |
| `EVSE:STATUS:ANTITHEFT:INACTIVE:SRC:<source>` | Anti-theft lock released (servo 0°) |
| `EVSE:RFID:CARD:UID:<uid>` | RFID card detected (`uid` = hex, e.g. `AB:CD:EF:12`) |
| `EVSE:ERROR:UNKNOWN_CMD:<cmd>` | Unknown command received |

`<source>` is who changed the state: `boot`, `pi`, `rfid` or `query`
(status was requested).

## Raspberry Pi → ESP32

| Command | Meaning |
|---|---|
| `CMD:CHARGE:ON` | Start charging |
| `CMD:CHARGE:OFF` | Stop charging |
| `CMD:STATUS` | Request current status (ESP32 replies with `EVSE:STATUS:...`) |

## Behavior rules

1. The ESP32 sends `EVSE:STATUS:...` on **every state change** (including boot).
2. Repeated identical commands are **not** re-sent (state did not change).
3. RFID tap = **manual override for the anti-theft lock**: first tap locks
   (`ANTITHEFT:ACTIVE`, servo 90°), next tap unlocks (`ANTITHEFT:INACTIVE`,
   servo 0°). Reported as `SRC:rfid`. Cards held on the reader are debounced
   (800 ms). **At boot the lock starts RELEASED** (`ANTITHEFT:INACTIVE:SRC:boot`,
   servo 0°).
4. **Charging is Pi-controlled**: `CMD:CHARGE:ON/OFF` — the ESP32 only
   mirrors the state; enforcement at the wallbox via Pi/Modbus is planned
   (see the [installation guide](installation.md#3-wallbox-reader-bauen-und-einmal-testen)). The anti-theft lock is **independent** of the
   charging state.
5. **UID whitelist:** currently *any* card toggles the lock. A whitelist of
   allowed UIDs is a planned extension.
6. Unknown commands are answered with `EVSE:ERROR:UNKNOWN_CMD:<cmd>`.
7. `CMD:STATUS` answers with the charging state **and** the anti-theft state.
8. At boot the ESP32 prints the reader firmware version on USB serial:
   `0x91`/`0x92` are common MFRC522 identifiers; `0x82` was observed on this
   project's module. A version response confirms SPI reachability, not full
   card-reading functionality; `0x00`/`0xFF` suggest wiring/power problems.

## Charging station interface

**Decided: Modbus RTU (RS-485) via a USB-RS485 adapter on the Raspberry Pi.**

The physical link to the charging station (ABB Terra AC) is owned by the
**Raspberry Pi**, not the ESP32:

```text
Raspberry Pi ──USB──> USB-RS485 adapter ──A/B──> ABB Terra AC wallbox
                    (/dev/ttyUSBEVSEcontrol)      (Modbus RTU, slave)
```

- **Modbus config:** 57600 baud, 8E1 (Even parity), Modbus ID 9.
- The Pi is the Modbus **master**: it polls the wallbox registers (charging
  state, currents, power, energy). Start/stop and current-limit writes are planned,
  not implemented in the current read-only service.
- The ESP32 keeps its **local** state machine (anti-theft lock via RFID taps
  + charging-state mirror) and reports over UART; future Pi control will enforce
  charging state at the wallbox via Modbus.
- Full register map, `mbpoll` examples and wiring: `docs/wallbox/`
  (ABB_Terra_AC_Modbus_Befehle.md + official ABB datasheet PDF) and
  the [installation guide](installation.md#rs485-zur-wallbox).

**Planned:** `CMD:SET_CURRENT:<mA>` in the UART protocol so the ESP32 (or the
Pi's MQTT layer) can set the charging current limit (register 4100h).
