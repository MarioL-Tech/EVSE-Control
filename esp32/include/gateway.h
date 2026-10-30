#pragma once
#include "protocol.h"

namespace evse {
enum class Charge { Unknown, On, Off };
class ChargeMirror {
public:
  void update(Charge value, uint32_t now) { value_ = value; refreshed_ = now; }
  bool tick(uint32_t now) {
    if (value_ == Charge::Unknown || now - refreshed_ < 10000) return false;
    value_ = Charge::Unknown; return true;
  }
  Charge value() const { return value_; }
  const char *name() const {
    return value_ == Charge::On ? "ON" : value_ == Charge::Off ? "OFF" : "UNKNOWN";
  }
private:
  Charge value_ = Charge::Unknown;
  uint32_t refreshed_ = 0;
};

// Synchronous adapter: no heap, UART, clock, hardware or entropy in this module.
class GatewayIo {
public:
  virtual ~GatewayIo() = default;
  virtual void output(const char *line) = 0;
  virtual void snapshot() = 0;
  virtual const char *execute(const char *op, const char *argument, uint32_t now) = 0;
};
class Gateway {
public:
  // Call exactly once per boot, with 16 bytes from the platform entropy adapter.
  // A failed initialization cannot subsequently enable the gateway this boot.
  bool begin(const uint8_t *entropy, bool available);
  bool handle(const char *line, uint32_t now, GatewayIo &io);
  void tick(uint32_t now);
private:
  struct Lease { bool live = false; uint32_t issued = 0; std::array<char,33> token{}; };
  struct Cached {
    bool live = false; uint32_t at = 0;
    std::array<char,33> id{};
    std::array<char,UART_LINE_CAPACITY+1> request{};
    std::array<char,160> reply{};
  };
  bool initialized_ = false, enabled_ = false;
  std::array<char,33> session_{};
  uint64_t nextLease_ = 0;
  std::array<Lease,8> leases_{};
  std::array<Cached,8> cache_{};
};
} // namespace evse
