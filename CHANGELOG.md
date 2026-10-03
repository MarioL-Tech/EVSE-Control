# Changelog

All notable changes to the EVSE-Control project. This file is **actively maintained** — every code, docs or infrastructure change is logged here with a timestamp. New entries are added at the top of the current day's section.

Format: `YYYY-MM-DD HH:MM` (Europe/Vienna)

## 2026-10-03

- **22:20** — **Feat: MQTT-Publisher im lesenden Wallbox-Reader ergänzt** — libmosquitto veröffentlicht retained/QoS-1-Samples und Verfügbarkeit mit Last Will, frischen Zuständen, begrenzter Nachrichtenwarteschlange und separatem Reconnect-Worker. Bestehendes evse-mqtt-Netzwerk/Broker wird verwendet; optionale lokale Auth-Konfiguration und isolierte Docker-Broker-/PTY-Tests samt GitHub-Docker-CI ergänzt. Noch kein Pi-Deployment-/Empfangstest; Docker-CI-Ergebnis ausstehend. Keine Wallbox-Schreibbefehle.
- **22:10** — **Docs: Setup und Installation zu einer zentralen Anleitung vereint** — Hardware-/OS-Referenz, Verdrahtung, ESP32-Flashen, UART-Meldungen/Diagnose und RS485-/mbpoll-Hinweise in docs/installation.md übernommen; doppelte Docker-Startabläufe vermieden und docs/setup.md entfernt. README, Pin-/Protokollreferenzen und AGENTS.md aktualisiert; realer Reader bleibt ausschließlich lesend. Keine Programmänderungen.
- **21:58** — **Docs: wiederholbarer Docker-Installationsguide ergänzt** — docs/installation.md dokumentiert Repositorystand, Wallbox-Build/Test/Betrieb, vorhandenen Mosquitto-Broker, evse-mqtt/Alias, bestätigten Publish-Test, UART-Brücke und Aufrufprobleme; bekannte Voraussetzungen und offene Neuinstallations-/MQTT-Schritte klar abgegrenzt. Kurzes Polling mit Timeout-Recovery im Projektkontext festgehalten und fortlaufende Pflege des Guides vorgeschrieben; keine Programm-/Containeränderungen.
- **21:33** — **Docs: erster realer Docker-Wallbox-Read bestätigt** — Marios Screenshot dokumentiert erfolgreichen FC03-Read des gesamten Blocks mit status=ok und Fehlercode 0. Projektstand aktualisiert, Einmaltests auf nicht-interaktives Compose-Run umgestellt und Shell-Exitcode-Abfrage erläutert. Mario ordnet das vorherige Aufrufproblem Windows zu; genaue Ursache nicht unabhängig untersucht. Dauerbetriebs-/Fehlerfall- und unabhängige Messwertvalidierung bleiben offen. Keine Programmänderungen.
- **19:15** — **Docs: Wallbox-Startanleitung gekürzt** — kompakte Docker-Befehlsfolge in Haupt- und Dienst-README; Dauerbetrieb startet nur nach erfolgreichem Einmal-Test. Ausführliche Dienst-Konfiguration/Tests/Betriebshinweise einklappbar gemacht, Docker-only- und Port-Exklusivitätshinweise beibehalten; AGENTS.md abgeglichen. Keine Programmänderungen.
- **19:09** — **Docs: Haupt-README als deutscher Projekteinstieg überarbeitet** — unbelegte SmartCharge-Featureversprechen durch Projektziele und tatsächlichen Stand ersetzt; Architektur, Docker-only-Schnellstart, UART-Test, Konfiguration, Grenzen, Repositorystruktur und Dokumentationslinks ergänzt. AGENTS.md abgeglichen; keine Laufzeit-/Containeränderungen und keine unbestätigten Hardwaretestergebnisse übernommen.
- **18:59** — **Fix: Pi-Build, Tests und Betrieb strikt Docker-only** — native Installations-/Startanweisungen entfernt, Wallbox-Entrypoint für konsistente Compose-Einstellungen bei Einmal-Test und Dauerbetrieb ergänzt; UART-Testbrücke containerisiert, Docker-Build auf zwei Compilerjobs begrenzt, Docker-Kontextfilter und LF-Regeln für Shellskripte/Dockerfiles ergänzt. Setup, README und AGENTS.md auf keine Projektpakete am Pi-Host umgestellt; MQTT bleibt geplant. Compose-YAML und Entrypoint-Syntax/Parameterweitergabe geprüft; Docker-/Pi-/Hardwaretests weiterhin offen.
- **18:28** — **Fix: Reader-Robustheit nach unabhängiger Prüfung verbessert** — Port-Freigabe/Wiederherstellung auch bei Ausnahmen, unterbrechbare und zeitbegrenzte stdout-Ausgabe sowie konsistente Gerätepfad-Konfiguration in der Docker-Anleitung ergänzt; Tests für Teilantworten, Shutdown während einer Abfrage und blockierte Ausgabe einschließlich Port-Einstellungen erweitert. Builds und beide Tests mit libmodbus 3.1.6 und 3.1.11 erneut erfolgreich; Hardware-/Dockerprüfung weiterhin offen.
- **18:23** — **Feat: rein lesender Pi-Wallbox-Dienst mit libmodbus** — C++17-Reader unter rasppi/wallbox mit konfigurierbarem FC03-Polling, Register-/Bitdekodierung, skalierten Messwerten, JSON-Zeilen, Timeout-/Reconnect-Behandlung und sauberem Shutdown; CMake, Decoder- und simulierte RTU-/CLI-Tests sowie Pi-/Docker-Compose-Anleitung ergänzt. Linux/WSL-Builds mit libmodbus 3.1.6 und 3.1.11 und jeweils beide Tests erfolgreich; Decoder-only-Build ebenfalls geprüft. Docker, Pi und reale Wallbox noch nicht getestet. README und AGENTS.md aktualisiert; keine Schreibbefehle oder MQTT-Anbindung.
- **17:53** — **Docs: Pi-Betrieb und Remote-Zugriff dokumentiert** — WireGuard-/SSH-Zugriff des Projektinhabers, Ausführung auf dem Pi mit lokalen Hardwareanbindungen sowie Remote-Test- und Deploymentgrenzen in AGENTS.md festgehalten; keine Dienste installiert oder Netzwerkänderungen vorgenommen.
- **17:47** — **Docs: neue Registerquelle und libmodbus-Option eingeordnet** — AGENTS.md um v1.11-Register-/Testnotizen, widersprüchliche Start-/Stop- und Timeout-Angaben, Registerbreiten, Ladezustandsdekodierung und FC03/FC04-Abgrenzung ergänzt; libmodbus als noch nicht entschiedene Bibliotheksoption dokumentiert. Die neue Registerdatei selbst blieb unverändert.
- **17:37** — **Docs: konkretisierte Systemziele in AGENTS.md aufgenommen** — zyklische Ladezustandsabfragen, gemeinsamer MQTT-Broker, modularer Docker-Compose-Aufbau, Bedienung/Anzeigen/Automationen für Home Assistant und Weboverlay sowie modulare Wallbox-Befehlseinrichtung als Anforderungen dokumentiert; offene Detailentscheidungen und bestehende UART-/Modbus-Anbindungen abgegrenzt.
- **16:05** — **Docs: AGENTS.md als gepflegter Projektkontext ergänzt** — Ziele, aktueller Implementierungsstand, Architektur, Hardware-/Modbus-Grenzen, offene Aufgaben und Branch-/PR-Arbeitsweise dokumentiert; regelmäßige Aktualisierung und Abgleich mit Code und Dokumentation vorgeschrieben.

## 2026-08-07

- **16:30** — **Docs: setup.md + uart-protocol.md brought to current state** — setup.md §3 (RFID = anti-theft toggle, servo independent of charging, boot 0°), §4 (current firmware description instead of old counter sketch), §5 (UART bridge expected output, boot diagnostics incl. `0x82` = PN512, anti-theft toggle test, troubleshooting); uart-protocol.md: version-line meanings extended with `0x82`, wallbox section wording updated.
- **16:24** — **Fix: servo boots at 0° (released)** — anti-theft lock starts `INACTIVE` (servo 0°) at boot; first RFID tap activates the lock (90°), next tap releases it (0°). Supersedes the 16:19 boot-90° change.
- **16:19** — **Feat: anti-theft lock starts ENGAGED at boot** — servo initializes to 90° (SERVO_LOCK_DEG) and the anti-theft state boots as `ACTIVE` (fail-safe: lock closed on power-up); first RFID tap now unlocks, next tap locks. *(reverted by 16:24)*
- **15:50** — **Docs: pin-connection.md synced to new behavior** — MFRC522 note + servo section now describe the RFID-toggled anti-theft lock (independent of charging) instead of the old charging-coupled behavior.
- **15:42** — **Feat: RFID toggles anti-theft lock (independent of charging)** — card tap now toggles the Diebstahlsicherung (first tap locks, next tap unlocks) instead of the charging state; charging stays Pi-controlled (`CMD:CHARGE:ON/OFF`); `CMD:STATUS` now reports both states; boot diagnostic prints MFRC522 firmware version (0x91/0x92 = OK) to spot wiring problems.
- **15:24** — **Docs: wallbox interface (ABB Terra AC, Modbus RTU)** — charging-station interface decided: Pi acts as Modbus RTU master over USB-RS485 (`/dev/ttyUSBEVSEcontrol`, 57600 8E1, ID 9); new `docs/setup.md` §6 (wiring, Terra Config, `mbpoll` tests, polling-timeout + <6 A pause warnings), `docs/uart-protocol.md` charging-station section updated, `docs/pin-connection.md` note; wallbox datasheet + `mbpoll` cheat sheet + smart meter docs added by Mario (commits `docwallbox*`, `docmeterschematic`).
- **10:32** — **Feat: anti-theft servo** — model servo (GPIO 13) acts as anti-theft lock: 90° while charging is active, 0° when charging stops; new `EVSE:STATUS:ANTITHEFT:...` messages; ESP32Servo library added (PR #12).

## 2026-08-06

- **19:51** — **Feat: RFID manual override (MFRC522)** — ESP32 reads RFID cards as manual override (tap = toggle charging), reports status to the Pi and accepts Pi commands over UART; new line protocol in `docs/uart-protocol.md`; `rasppi/src/main.py` is now an interactive UART bridge (PR #9).
- **19:38** — Docs: rework `docs/pin-connection.md` (proper markdown table, signal column, GND ↔ GND) and sync wiring section in `docs/setup.md` (PR #7).
- **19:35** — Docs: Mario created `docs/pin-connection.md` (pin wiring reference).
- **19:33** — Docs: add `docs/setup.md` — full setup guide (Pi preparation, wiring, ESP32 flash, connection test, MQTT) (PR #6).
- **19:29** — Docs: initial `pin-connection` notes.
- **19:24** — Chore: document `pyserial` in `rasppi/requirements.txt` (PR #5).
- **18:29** — **Feat: UART connection test** (PR #4): rewrite `esp32/src/main.cpp` (heartbeat counter + echo via Serial2) and `rasppi/src/main.py` (serial listener + PING every 3 s).
- **17:40–17:51** — Chore: remove `desktop.ini`, add root `.gitignore` (PR #3).
- **~17:30** — **Milestone: UART connection between Pi and ESP32 verified in both directions** (`EVSE_TEST` lines + `ECHO:PING`). Fixes along the way: serial console disabled via raspi-config (login shell off), `python3-serial` installed.
- **14:26–16:00** — Infra: repo cloned to custos server; GitHub access via SSH key (account key) + fine-grained PAT (PR creation via API); branch+PR workflow established.
- **12:07–12:25** — Hardware setup: Raspberry Pi on WiFi ("Leeb"), SSH enabled, keyboard layout set to German (raspi-config).

## 2026-02-02

- **23:31** — Trial reading data ESP32 ↔ Raspi (initial UART attempt).
- **21:46** — Repo repaired, cleanup of initial commits.
