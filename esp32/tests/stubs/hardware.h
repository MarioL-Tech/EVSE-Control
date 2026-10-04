#pragma once

// Simulation only: deliberately not a model of electrical/mechanical behavior.
#include <array>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <string>
#include <vector>

using byte = unsigned char;
using esp_err_t = int;
using nvs_handle_t = unsigned;
constexpr int ESP_OK = 0, ESP_FAIL = 1, ESP_ERR_NVS_NOT_FOUND = 2;
constexpr int ESP_ERR_NVS_TYPE_MISMATCH = 3, NVS_READWRITE = 4;
constexpr int INPUT = 0, SERIAL_8N1 = 1;
struct SimulatedHardware {
  uint32_t now = 0;
  bool nvsInitFail = false, nvsOpenFail = false, nvsReadFail = false;
  bool nvsWrongType = false, nvsSetFail = false, nvsCommitFail = false;
  bool ambiguousCommit = false, pwmFail = false;
  bool nvsReadSizeChanged = false;
  bool found = false;
  std::vector<uint8_t> durable, pending;
  std::vector<std::string> trace;
  uint32_t duty = 0;
  byte version = 0x82, irq = 1, errors = 0;
  int wake = 1, halt = 0;
  bool select = true;
};
inline SimulatedHardware sim;
class SerialPort {
public:
  explicit SerialPort(const char *label) : label_(label) {}
  std::deque<char> input;
  std::string output;
  void begin(unsigned, int = 0, int = 0, int = 0) {}
  int available() const { return static_cast<int>(input.size()); }
  int read() { const char c = input.front(); input.pop_front(); return static_cast<unsigned char>(c); }
  void println(const char *line) { output += line; output += '\n'; sim.trace.emplace_back(label_); }
  void printf(const char *format, ...) {
    char buffer[512];
    va_list args; va_start(args, format);
    std::vsnprintf(buffer, sizeof(buffer), format, args); va_end(args);
    output += buffer; sim.trace.emplace_back(label_);
  }
private:
  const char *label_;
};
inline SerialPort Serial("USB_OUT"), Serial2("UART_OUT");
inline uint32_t millis() { return sim.now; }
inline void delay(unsigned ms) { sim.now += ms; }
inline void pinMode(int, int) { sim.trace.emplace_back("PIN_INPUT"); }
inline double ledcSetup(int, double hz, int) {
  sim.trace.emplace_back("PWM_SETUP"); return sim.pwmFail ? 0 : hz;
}
inline void ledcWrite(int, uint32_t duty) { sim.duty = duty; sim.trace.emplace_back("PWM_WRITE"); }
inline void ledcAttachPin(int, int) { sim.trace.emplace_back("PIN_ATTACH"); }
struct Spi { void begin() {} };
inline Spi SPI;

class MFRC522 {
public:
  enum StatusCode { STATUS_OK, STATUS_TIMEOUT, STATUS_COLLISION, STATUS_CRC_WRONG };
  enum PCD_Register { VersionReg, ComIrqReg, ErrorReg };
  enum { RxGain_max };
  struct { byte size = 4; byte uidByte[10] = {0x10, 0x20, 0x30, 0x40}; } uid;
  MFRC522(int, int) {}
  void PCD_Init() {}
  void PCD_SetAntennaGain(int) {}
  byte PCD_ReadRegister(PCD_Register reg) {
    switch (reg) {
      case VersionReg: return sim.version;
      case ComIrqReg: return sim.irq;
      case ErrorReg: return sim.errors;
    }
    return 0;
  }
  StatusCode PICC_WakeupA(byte *, byte *) { return static_cast<StatusCode>(sim.wake); }
  bool PICC_ReadCardSerial() { return sim.select; }
  StatusCode PICC_HaltA() { return static_cast<StatusCode>(sim.halt); }
  void PCD_StopCrypto1() {}
};

inline esp_err_t nvs_flash_init_partition(const char *partition) {
  sim.trace.emplace_back("NVS_INIT");
  return sim.nvsInitFail || std::strcmp(partition, "evse_nvs") != 0 ? ESP_FAIL : ESP_OK;
}
inline esp_err_t nvs_open_from_partition(const char *partition, const char *space, int, nvs_handle_t *handle) {
  if (sim.nvsOpenFail || std::strcmp(partition, "evse_nvs") != 0 || std::strcmp(space, "evse-lock") != 0)
    return ESP_FAIL;
  *handle = 1; return ESP_OK;
}
inline esp_err_t nvs_get_blob(nvs_handle_t, const char *, void *data, std::size_t *length) {
  if (sim.nvsReadFail) return ESP_FAIL;
  if (sim.nvsWrongType) return ESP_ERR_NVS_TYPE_MISMATCH;
  if (!sim.found) return ESP_ERR_NVS_NOT_FOUND;
  if (data) {
    if (*length < sim.durable.size()) return ESP_FAIL;
    std::memcpy(data, sim.durable.data(), sim.durable.size());
  }
  *length = sim.durable.size();
  if (data && sim.nvsReadSizeChanged && *length > 0) --*length;
  return ESP_OK;
}
inline esp_err_t nvs_set_blob(nvs_handle_t, const char *, const void *data, std::size_t length) {
  if (sim.nvsSetFail) return ESP_FAIL;
  const auto *bytes = static_cast<const uint8_t *>(data);
  sim.pending.assign(bytes, bytes + length); sim.trace.emplace_back("NVS_SET"); return ESP_OK;
}
inline esp_err_t nvs_commit(nvs_handle_t) {
  sim.trace.emplace_back("NVS_COMMIT");
  if (!sim.nvsCommitFail || sim.ambiguousCommit) { sim.durable = sim.pending; sim.found = true; }
  return sim.nvsCommitFail ? ESP_FAIL : ESP_OK;
}
