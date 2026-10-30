# ABB Terra AC Wallbox – Modbus RTU Befehlsübersicht

> **Historische Notizen, keine freigegebene Schreibtestanleitung.** Die folgenden
> `mbpoll`-Beispiele sind bei Funktionscode/Registerbreite nicht durchgehend
> belastbar. Maßgeblich sind das Hersteller-PDF v1.7 und der
> [Schreibkernvertrag](write-core-contract.md): Stromlimit braucht FC16/zwei Wörter;
> Start=0, Stop=1 an `0x4105`. Echte Schreibtests erst nach Information der Leitung
> und gesonderter Freigabe; Stufe 1 bleibt reine Docker-PTY-Simulation.

> **Schnittstelle:** Modbus RTU über `/dev/ttyUSBEVSEcontrol`  
> **Konfiguration:** 57600 Baud | Parität: Even (8E1) | Modbus ID (Address): 9

---

## 1. Auslesbare Parameter (Read-Only)

| Parameter | Register (Dez / Hex) | Auflösung / Einheit | Befehl zum Ausführen (`mbpoll`) |
| :--- | :--- | :--- | :--- |
| **Seriennummer** | `16384` / `0x4000` | Unsigned (4 Reg.) | `mbpoll /dev/ttyUSBEVSEcontrol -m rtu -a 9 -c 4 -B -0 -1 -b 57600 -P even -s 1 -r 16384 -t 3:int` |
| **Firmware-Version** | `16388` / `0x4004` | Unsigned (2 Reg.) | `mbpoll /dev/ttyUSBEVSEcontrol -m rtu -a 9 -c 2 -B -0 -1 -b 57600 -P even -s 1 -r 16388 -t 3:int` |
| **Max. Hardware-Strom** | `16390` / `0x4006` | 0,001 A (mA) | `mbpoll /dev/ttyUSBEVSEcontrol -m rtu -a 9 -c 2 -B -0 -1 -b 57600 -P even -s 1 -r 16390 -t 3:int` |
| **Fehlercode (Error Code)** | `16392` / `0x4008` | 0 = kein Fehler | `mbpoll /dev/ttyUSBEVSEcontrol -m rtu -a 9 -c 2 -B -0 -1 -b 57600 -P even -s 1 -r 16392 -t 3:int` |
| **Kabel-Verriegelungsstatus** | `16394` / `0x400A` | Status-Code | `mbpoll /dev/ttyUSBEVSEcontrol -m rtu -a 9 -c 2 -B -0 -1 -b 57600 -P even -s 1 -r 16394 -t 3:int` |
| **Ladestatus (Charging State)** | `16396` / `0x400C` | IEC 61851-1 Status | `mbpoll /dev/ttyUSBEVSEcontrol -m rtu -a 9 -c 2 -B -0 -1 -b 57600 -P even -s 1 -r 16396 -t 3:int` |
| **Aktuelles Stromlimit** | `16398` / `0x400E` | 0,001 A (mA) | `mbpoll /dev/ttyUSBEVSEcontrol -m rtu -a 9 -c 2 -B -0 -1 -b 57600 -P even -s 1 -r 16398 -t 3:int` |
| **Ladeströme L1, L2, L3** | `16400` / `0x4010` | 0,001 A (mA) (6 Reg.) | `mbpoll /dev/ttyUSBEVSEcontrol -m rtu -a 9 -c 6 -B -0 -1 -b 57600 -P even -s 1 -r 16400 -t 3:int` |
| **Spannungen L1, L2, L3** | `16406` / `0x4016` | 0,1 V (Wert/10) (6 Reg.) | `mbpoll /dev/ttyUSBEVSEcontrol -m rtu -a 9 -c 6 -B -0 -1 -b 57600 -P even -s 1 -r 16406 -t 3:int` |
| **Wirkleistung (Active Power)** | `16412` / `0x401C` | 1 Watt (W) | `mbpoll /dev/ttyUSBEVSEcontrol -m rtu -a 9 -c 2 -B -0 -1 -b 57600 -P even -s 1 -r 16412 -t 3:int` |
| **Gelieferte Energie (Session)** | `16414` / `0x401E` | 1 Wattstunde (Wh) | `mbpoll /dev/ttyUSBEVSEcontrol -m rtu -a 9 -c 2 -B -0 -1 -b 57600 -P even -s 1 -r 16414 -t 3:int` |

---

## 2. Steuerbare Funktionen (Write-Only)

| Funktion | Register (Dez / Hex) | Wertebereich | Befehl zum Ausführen (`mbpoll`) |
| :--- | :--- | :--- | :--- |
| **Ladesession STARTEN** | `16645` / `0x4105` | Wert: `0` | `mbpoll /dev/ttyUSBEVSEcontrol -m rtu -a 9 -B -0 -1 -b 57600 -P even -s 1 -r 16645 -t 3:int 0` |
| **Ladesession STOPPEN** | `16645` / `0x4105` | Wert: `1` | `mbpoll /dev/ttyUSBEVSEcontrol -m rtu -a 9 -B -0 -1 -b 57600 -P even -s 1 -r 16645 -t 3:int 1` |
| **Ladestrom setzen (6 A)** | `16640` / `0x4100` | `6000` mA | `mbpoll /dev/ttyUSBEVSEcontrol -m rtu -a 9 -B -0 -1 -b 57600 -P even -s 1 -r 16640 -t 3:int 6000` |
| **Ladestrom setzen (10 A)** | `16640` / `0x4100` | `10000` mA | `mbpoll /dev/ttyUSBEVSEcontrol -m rtu -a 9 -B -0 -1 -b 57600 -P even -s 1 -r 16640 -t 3:int 10000` |
| **Ladestrom setzen (16 A)** | `16640` / `0x4100` | `16000` mA | `mbpoll /dev/ttyUSBEVSEcontrol -m rtu -a 9 -B -0 -1 -b 57600 -P even -s 1 -r 16640 -t 3:int 16000` |
| **Kabel entriegeln** | `16643` / `0x4103` | Wert: `0` (Dosenmodell) | `mbpoll /dev/ttyUSBEVSEcontrol -m rtu -a 9 -B -0 -1 -b 57600 -P even -s 1 -r 16643 -t 3:int 0` |
| **Kabel verriegeln** | `16643` / `0x4103` | Wert: `1` (Dosenmodell) | `mbpoll /dev/ttyUSBEVSEcontrol -m rtu -a 9 -B -0 -1 -b 57600 -P even -s 1 -r 16643 -t 3:int 1` |
| **Timeout setzen (60s)** | `16646` / `0x4106` | 10–65535 Sek. | `mbpoll /dev/ttyUSBEVSEcontrol -m rtu -a 9 -B -0 -1 -b 57600 -P even -s 1 -r 16646 -t 3:int 60` |
