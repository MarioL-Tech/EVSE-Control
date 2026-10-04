#include <Arduino.h>
#include <MFRC522.h>
#include <SPI.h>
#include <nvs.h>
#include <nvs_flash.h>

#include <cstdarg>
#include <cstdio>
#include <cstring>

#include "config.h"
#include "protocol.h"
#include "security.h"

namespace {
// Separate from Arduino default NVS, which the framework may automatically erase.
class NvsStore final : public evse::Storage {
public:
  evse::LoadResult load(evse::Blob &blob) override {
    if (nvs_flash_init_partition("evse_nvs") != ESP_OK) return evse::LoadResult::Error;
    if (nvs_open_from_partition("evse_nvs", "evse-lock", NVS_READWRITE, &handle_) != ESP_OK)
      return evse::LoadResult::Error;
    opened_ = true;
    std::size_t length = 0;
    const esp_err_t found = nvs_get_blob(handle_, "state", nullptr, &length);
    if (found == ESP_ERR_NVS_NOT_FOUND) return evse::LoadResult::Missing;
    if (found == ESP_ERR_NVS_TYPE_MISMATCH) return evse::LoadResult::Corrupt;
    if (found != ESP_OK) return evse::LoadResult::Error;
    if (length != blob.size()) return evse::LoadResult::Corrupt;
    return nvs_get_blob(handle_, "state", blob.data(), &length) == ESP_OK
               ? evse::LoadResult::Found : evse::LoadResult::Error;
  }
  bool save(const evse::Blob &blob) override {
    return opened_ && nvs_set_blob(handle_, "state", blob.data(), blob.size()) == ESP_OK &&
           nvs_commit(handle_) == ESP_OK;
  }
private:
  nvs_handle_t handle_{};
  bool opened_ = false;
};

// Arduino 2.x LEDC: preload the requested duty before connecting the GPIO.
// This does not prove actual pulse shape or mechanical position on real hardware.
class LockOutput {
public:
  bool begin(bool locked) {
    pinMode(SERVO_PIN, INPUT);
    if (ledcSetup(SERVO_CHANNEL, SERVO_HZ, SERVO_BITS) <= 0) return false;
    write(locked);
    ledcAttachPin(SERVO_PIN, SERVO_CHANNEL);
    ready_ = true;
    return true;
  }
  void write(bool locked) {
    const uint32_t degrees = locked ? SERVO_LOCK_DEG : SERVO_UNLOCK_DEG;
    const uint32_t pulse = SERVO_MIN_US + (SERVO_MAX_US - SERVO_MIN_US) * degrees / 180;
    const uint32_t period = 1000000U / SERVO_HZ;
    const uint32_t duty = (pulse * (1U << SERVO_BITS) + period / 2) / period;
    ledcWrite(SERVO_CHANNEL, duty);
  }
  bool ready() const { return ready_; }
private:
  bool ready_ = false;
};

NvsStore store;
evse::Security security(store);
evse::Presence presence;
evse::LineReader uart;
LockOutput lockOutput;
MFRC522 reader(RFID_SS_PIN, RFID_RST_PIN);
bool chargingOn = false; // mirror only; never controls the ABB Wallbox
bool readerReady = false;
bool radioFault = false;
uint32_t lastPoll = 0;

// All ordinary responses are bounded constant-format text, never an echoed command.
void emit(const char *format, ...) {
  char line[256];
  va_list args;
  va_start(args, format);
  const int length = std::vsnprintf(line, sizeof(line), format, args);
  va_end(args);
  if (length < 0 || static_cast<std::size_t>(length) >= sizeof(line)) return;
  Serial2.printf("%s\n", line);
  Serial.printf("%s\n", line);
}
void sendCharging(const char *source) {
  emit("EVSE:STATUS:CHARGING:%s:SRC:%s", chargingOn ? "ON" : "OFF", source);
}
void sendLock(const char *source) {
  emit("EVSE:STATUS:ANTITHEFT:%s:SRC:%s", security.locked() ? "ACTIVE" : "INACTIVE", source);
}
void sendSecurity() {
  emit("EVSE:STATUS:SECURITY:STORE:%s:FAULT:%s:BOOT:%s:CARDS:%u:ENROLL:%s:READER:%s:SERVO:%s",
       security.ready() ? "READY" : "FAULT", evse::faultName(security.fault()),
       evse::modeName(security.mode()), static_cast<unsigned>(security.count()),
       security.enrolling() ? "ON" : "OFF", readerReady ? "SPI_OK" : "FAULT",
       lockOutput.ready() ? "PWM_OK" : "FAULT");
}
void result(const char *action, evse::Result code) {
  emit("EVSE:RESULT:%s:%s", action, evse::resultName(code));
}
void applyTarget(bool previous, const char *source) {
  if (previous == security.locked()) return;
  if (lockOutput.ready()) lockOutput.write(security.locked());
  sendLock(source); // explicitly a requested target; not an end-position sensor
}
void command(const char *line) {
  const auto parsed = evse::parseCommand(line);
  const bool previous = security.locked();
  const char *action = "";
  evse::Result code = evse::Result::Ok;
  switch (parsed.kind) {
    case evse::CommandKind::ChargeOn:
    case evse::CommandKind::ChargeOff: {
      const bool requested = parsed.kind == evse::CommandKind::ChargeOn;
      if (requested != chargingOn) { chargingOn = requested; sendCharging("pi"); }
      return;
    }
    case evse::CommandKind::Status:
      sendCharging("query"); sendLock("query"); sendSecurity(); return;
    case evse::CommandKind::EnrollStart: {
      if (!readerReady || !lockOutput.ready()) { emit("EVSE:ERROR:NOT_READY"); return; }
      code = security.startEnrollment(millis());
      if (code == evse::Result::EnrollStarted) presence.requireRemoval();
      action = "ENROLL";
      break;
    }
    case evse::CommandKind::EnrollCancel:
      action = "ENROLL"; code = security.cancelEnrollment(); break;
    case evse::CommandKind::Revoke:
      action = "REVOKE"; code = security.revoke(parsed.uid); break;
    case evse::CommandKind::BootMode:
      action = "BOOT"; code = security.setBootMode(parsed.mode); break;
    case evse::CommandKind::Invalid:
      emit("EVSE:ERROR:INVALID_ARGUMENT"); return;
    case evse::CommandKind::Unknown:
      emit("EVSE:ERROR:UNKNOWN_CMD"); return;
  }
  applyTarget(previous, "storage_fault");
  result(action, code);
  sendSecurity();
}
void frameError(evse::FrameResult code) {
  switch (code) {
    case evse::FrameResult::TooLong: emit("EVSE:ERROR:UART:TOO_LONG"); break;
    case evse::FrameResult::Invalid: emit("EVSE:ERROR:UART:INVALID"); break;
    case evse::FrameResult::Timeout: emit("EVSE:ERROR:UART:TIMEOUT"); break;
    default: break;
  }
}
void handleUart() {
  frameError(uart.tick(millis()));
  for (unsigned i = 0; i < UART_BYTE_BUDGET && Serial2.available(); ++i) {
    const auto code = uart.feed(static_cast<char>(Serial2.read()), millis());
    if (code == evse::FrameResult::Line) {
      if (uart.line()[0] != '\0') command(uart.line());
      break; // at most one command per loop; leave time for RFID and enrollment expiry
    }
    if (code != evse::FrameResult::None) { frameError(code); break; }
  }
}
void radioError() {
  presence.observe(evse::Observation::Fault, millis());
  if (!radioFault) emit("EVSE:ERROR:RFID:READ");
  radioFault = true;
}
void handleRfid() {
  const uint32_t now = millis();
  if (now - lastPoll < RFID_POLL_MS) return;
  lastPoll = now;
  // Check the SPI diagnosis at each poll before interpreting an RF timeout.
  const uint8_t version = reader.PCD_ReadRegister(MFRC522::VersionReg);
  const bool reachable = version != 0 && version != 0xff;
  if (reachable != readerReady) {
    readerReady = reachable;
    presence.observe(evse::Observation::Fault, millis());
    if (!reachable) {
      emit("EVSE:ERROR:READER:SPI_FAULT");
      if (security.enrolling()) result("ENROLL", security.cancelEnrollment());
    }
    sendSecurity();
  }
  if (!readerReady) { radioError(); return; }

  byte atqa[2];
  byte length = sizeof(atqa);
  // WUPA probes halted cards too; REQA alone cannot distinguish HALT from removal.
  const auto wake = reader.PICC_WakeupA(atqa, &length);
  if (wake == MFRC522::STATUS_TIMEOUT) {
    // The library uses TIMEOUT for both chip TimerIRQ and a software watchdog.
    // Only a clean chip-timer expiry counts as an absence observation.
    const byte irq = reader.PCD_ReadRegister(MFRC522::ComIrqReg);
    const byte errors = reader.PCD_ReadRegister(MFRC522::ErrorReg);
    if ((irq & 0x01) == 0 || (errors & 0xdf) != 0) { radioError(); return; }
    radioFault = false;
    presence.observe(evse::Observation::Absent, millis());
    return;
  }
  // Conservatively reject detected collisions instead of selecting one participant.
  if (wake != MFRC522::STATUS_OK || !reader.PICC_ReadCardSerial()) {
    reader.PCD_StopCrypto1();
    radioError(); return;
  }
  evse::Uid uid;
  uid.size = reader.uid.size;
  if (uid.valid()) std::memcpy(uid.bytes.data(), reader.uid.uidByte, uid.size);
  const auto halted = reader.PICC_HaltA();
  reader.PCD_StopCrypto1();
  if (halted != MFRC522::STATUS_OK || !uid.valid()) { radioError(); return; }
  radioFault = false;
  const bool fresh = presence.observe(evse::Observation::Card, millis());
  if (!fresh || !lockOutput.ready()) return;

  const bool previous = security.locked();
  const bool enrollment = security.enrolling();
  const auto code = security.card(uid, millis());
  applyTarget(previous, code == evse::Result::StorageError ? "storage_fault" : "rfid");
  if (enrollment && (code == evse::Result::Enrolled || code == evse::Result::AlreadyAllowed)) {
    // Card identity only for explicit administration, not ordinary actions or USB logs.
    char text[30];
    evse::formatUid(uid, text);
    Serial2.printf("EVSE:RESULT:ENROLL:%s:UID:%s\n", evse::resultName(code), text);
    Serial.printf("EVSE:RESULT:ENROLL:%s\n", evse::resultName(code));
  } else result(enrollment ? "ENROLL" : "RFID", code);
  if (enrollment || code == evse::Result::StorageError) sendSecurity();
}
} // namespace

void setup() {
  Serial.begin(115200);
  Serial2.begin(UART_BAUD, SERIAL_8N1, UART_RX_PIN, UART_TX_PIN);
  security.begin(); // no auto-erase or insecure empty-list recovery on corruption
  lockOutput.begin(security.locked());
  SPI.begin();
  reader.PCD_Init();
  reader.PCD_SetAntennaGain(MFRC522::RxGain_max);
  const uint8_t version = reader.PCD_ReadRegister(MFRC522::VersionReg);
  readerReady = version != 0 && version != 0xff;
  Serial.printf("MFRC522 firmware version: 0x%02X\n", version);
  Serial.println("EVSE authorized RFID controller started");
  sendCharging("boot"); sendLock("boot"); sendSecurity();
}
void loop() {
  const auto expired = security.tick(millis());
  if (expired == evse::Result::EnrollExpired) { result("ENROLL", expired); sendSecurity(); }
  handleUart();
  handleRfid();
  delay(2);
}
