#include <algorithm>
#include <iostream>
#include <stdexcept>

// Execute the real firmware orchestration/adapters with injected fake hardware APIs.
#include "../src/main.cpp"

#define CHECK(condition) do { if (!(condition)) throw std::runtime_error( \
  std::string(__FILE__) + ":" + std::to_string(__LINE__) + " " #condition); } while (false)

namespace {
evse::Uid fakeUid() {
  evse::Uid uid;
  CHECK(evse::parseUid("10:20:30:40", uid));
  return uid;
}
void clearOutput() { Serial.output.clear(); Serial2.output.clear(); sim.trace.clear(); }
void restart() {
  presence = evse::Presence{}; uart = evse::LineReader{}; lockOutput = LockOutput{};
  chargingOn = false; readerReady = false; radioFault = false; lastPoll = 0;
  Serial.input.clear(); Serial2.input.clear(); clearOutput(); setup();
}
void fresh() { sim = SimulatedHardware{}; restart(); }
void seed(bool locked, evse::BootMode mode = evse::BootMode::Restore) {
  evse::Record record;
  record.locked = locked; record.mode = mode; record.count = 1; record.cards[0] = fakeUid();
  const auto blob = evse::encode(record);
  sim.durable.assign(blob.begin(), blob.end()); sim.found = true;
}
void absent() {
  sim.wake = MFRC522::STATUS_TIMEOUT; sim.irq = 1; sim.errors = 0;
  for (unsigned i = 0; i < 7; ++i) { sim.now += 100; handleRfid(); }
}
void card() {
  sim.wake = MFRC522::STATUS_OK; sim.select = true; sim.halt = MFRC522::STATUS_OK;
  sim.now += 100; handleRfid();
}
std::size_t position(const char *event) {
  const auto it = std::find(sim.trace.begin(), sim.trace.end(), event);
  CHECK(it != sim.trace.end()); return static_cast<std::size_t>(it - sim.trace.begin());
}
void bootAndPwm() {
  fresh(); CHECK(security.ready()); CHECK(security.locked()); CHECK(security.count() == 0);
  CHECK(sim.found); CHECK(position("NVS_COMMIT") < position("PWM_WRITE"));
  CHECK(position("PWM_WRITE") < position("PIN_ATTACH"));
  CHECK(Serial2.output.find("BOOT:RESTORE:CARDS:0") != std::string::npos);
  CHECK(Serial2.output.find("SERVO:PWM_OK") != std::string::npos);
  seed(false); restart(); CHECK(!security.locked());
  CHECK(position("PWM_WRITE") < position("PIN_ATTACH"));
  CHECK(sim.duty == (SERVO_MIN_US * 65536U + 10000U) / 20000U);
  sim.pwmFail = true; restart(); CHECK(!lockOutput.ready());
  command("CMD:RFID:ENROLL:START"); CHECK(!security.enrolling());
  CHECK(Serial2.output.find("EVSE:ERROR:NOT_READY") != std::string::npos);
}
void enrollmentAndPrivacy() {
  fresh(); clearOutput(); command("CMD:RFID:ENROLL:START"); CHECK(security.enrolling());
  card(); CHECK(security.count() == 0); // already held; START does not accept it
  absent(); clearOutput(); card();
  CHECK(security.count() == 1); CHECK(security.locked()); CHECK(!security.enrolling());
  CHECK(Serial2.output.find("ENROLLED:UID:10:20:30:40") != std::string::npos);
  CHECK(Serial.output.find("10:20:30:40") == std::string::npos);
  clearOutput(); card(); CHECK(security.locked()); CHECK(Serial2.output.empty());
  absent(); clearOutput(); card(); CHECK(!security.locked());
  CHECK(position("NVS_COMMIT") < position("PWM_WRITE"));
  CHECK(position("PWM_WRITE") < position("UART_OUT"));
  CHECK(Serial2.output.find("10:20:30:40") == std::string::npos);
  CHECK(Serial.output.find("10:20:30:40") == std::string::npos);
  command("CMD:RFID:REVOKE:10:20:30:40"); CHECK(security.count() == 0);
  absent(); clearOutput(); card(); CHECK(!security.locked());
  CHECK(Serial2.output.find("RFID:DENIED") != std::string::npos);
  CHECK(Serial2.output.find("10:20:30:40") == std::string::npos);
}
void persistenceFailures() {
  fresh(); seed(false); restart(); clearOutput();
  const auto before = sim.durable;
  sim.nvsCommitFail = true;
  command("CMD:ANTITHEFT:BOOT:UNLOCKED");
  CHECK(!security.ready()); CHECK(security.locked()); CHECK(sim.durable == before);
  CHECK(Serial2.output.find("BOOT:STORAGE_ERROR") != std::string::npos);
  CHECK(Serial2.output.find("SRC:storage_fault") != std::string::npos);
  sim.nvsCommitFail = false; restart(); CHECK(!security.locked()); // actual last durable state
  for (unsigned failure = 0; failure < 7; ++failure) {
    sim = SimulatedHardware{}; seed(false);
    if (failure == 0) sim.nvsInitFail = true;
    if (failure == 1) sim.nvsOpenFail = true;
    if (failure == 2) sim.nvsReadFail = true;
    if (failure == 3) sim.nvsWrongType = true;
    if (failure == 4) sim.durable.pop_back();
    if (failure == 5) sim.durable[0] ^= 1;
    if (failure == 6) sim.nvsReadSizeChanged = true;
    const auto original = sim.durable;
    restart(); CHECK(!security.ready()); CHECK(security.locked());
    CHECK(sim.durable == original); // no reinitialization/erasure on read/corruption errors
  }
  fresh(); seed(true, evse::BootMode::Unlocked); sim.nvsSetFail = true;
  restart(); CHECK(!security.ready()); CHECK(security.locked());
}
void readerFaults() {
  fresh(); seed(true); restart();
  command("CMD:RFID:ENROLL:START"); sim.version = 0xff;
  sim.now += 100; handleRfid(); CHECK(!readerReady); CHECK(!security.enrolling());
  sim.version = 0x82; sim.wake = MFRC522::STATUS_TIMEOUT; sim.irq = 0;
  for (unsigned i = 0; i < 8; ++i) { sim.now += 100; handleRfid(); }
  card(); CHECK(security.locked()); // software watchdog timeout never rearms
  absent(); sim.wake = MFRC522::STATUS_COLLISION; sim.now += 100; handleRfid();
  card(); CHECK(security.locked()); // collision prevents a fresh presentation
  absent(); sim.wake = MFRC522::STATUS_OK; sim.select = false;
  sim.now += 100; handleRfid(); card(); CHECK(security.locked());
  absent(); sim.wake = MFRC522::STATUS_OK; sim.halt = MFRC522::STATUS_CRC_WRONG;
  sim.now += 100; handleRfid(); card(); CHECK(security.locked());
  absent(); sim.wake = MFRC522::STATUS_TIMEOUT; sim.errors = 8;
  sim.now += 100; handleRfid(); sim.errors = 0; card(); CHECK(security.locked());
  absent(); card(); CHECK(!security.locked()); // recovery requires real clean absence series
  for (byte error : {byte(1), byte(2), byte(4), byte(8), byte(16), byte(64), byte(128)}) {
    fresh(); seed(true); restart(); sim.errors = error;
    for (unsigned i = 0; i < 8; ++i) { sim.now += 100; handleRfid(); }
    sim.errors = 0; card(); CHECK(security.locked());
  }
}
void uartOrchestration() {
  fresh(); clearOutput();
  const std::string frames = "CMD:CHARGE:ON\nCMD:CHARGE:OFF\n";
  Serial2.input.insert(Serial2.input.end(), frames.begin(), frames.end());
  handleUart(); CHECK(chargingOn); CHECK(!Serial2.input.empty());
  handleUart(); CHECK(!chargingOn); CHECK(security.locked());
  const std::string overlong(1000, 'A');
  Serial2.input.insert(Serial2.input.end(), overlong.begin(), overlong.end());
  const auto size = Serial2.input.size(); handleUart();
  CHECK(size - Serial2.input.size() <= UART_BYTE_BUDGET);
  while (!Serial2.input.empty()) handleUart();
  clearOutput(); command("PRIVATE:10:20:30:40");
  CHECK(Serial2.output == "EVSE:ERROR:UNKNOWN_CMD\n");
  CHECK(Serial.output.find("10:20:30:40") == std::string::npos);
}
} // namespace
int main() {
  try {
    bootAndPwm(); enrollmentAndPrivacy(); persistenceFailures(); readerFaults(); uartOrchestration();
    std::cout << "5 simulated firmware suites passed (not physical hardware tests)\n";
  } catch (const std::exception &error) { std::cerr << error.what() << '\n'; return 1; }
}
