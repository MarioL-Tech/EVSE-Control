// Disposable native adapter, NOT an ESP32/NVS/servo/RFID hardware simulation.
// Gateway, Security and ChargeMirror are compiled unchanged from named context.
#include "gateway.h"
#include "security.h"
#include <chrono>
#include <cstring>
#include <iostream>
#include <poll.h>
#include <random>
#include <string>
#include <unistd.h>

struct MemoryStore : evse::Storage {
  evse::Blob blob{};
  bool exists = false;
  evse::LoadResult load(evse::Blob &out) override {
    out = blob; return exists ? evse::LoadResult::Found : evse::LoadResult::Missing;
  }
  bool save(const evse::Blob &in) override { blob = in; exists = true; return true; }
};
struct Adapter : evse::GatewayIo {
  MemoryStore store;
  evse::Security security{store};
  evse::ChargeMirror charge;
  void output(const char *line) override { std::cout << "UART|" << line << std::endl; }
  void snapshot() override {
    std::string c = std::string("EVSE:STATUS:CHARGING:") + charge.name() + ":SRC:query";
    output(c.c_str());
    output(security.locked() ? "EVSE:STATUS:ANTITHEFT:ACTIVE:SRC:query" :
                             "EVSE:STATUS:ANTITHEFT:INACTIVE:SRC:query");
    std::string s = "EVSE:STATUS:SECURITY:STORE:READY:FAULT:NONE:BOOT:RESTORE:CARDS:" +
      std::to_string(security.count()) + ":ENROLL:" + (security.enrolling() ? "ON" : "OFF") +
      ":READER:SPI_OK:SERVO:PWM_OK";
    output(s.c_str());
  }
  const char *execute(const char *op, const char *arg, uint32_t now) override {
    if (!std::strcmp(op, "MIRROR")) {
      charge.update(!std::strcmp(arg, "ON") ? evse::Charge::On :
                    !std::strcmp(arg, "OFF") ? evse::Charge::Off : evse::Charge::Unknown, now);
      return "OK";
    }
    evse::Result r = evse::Result::InvalidArgument;
    if (!std::strcmp(op, "LOCK")) r = security.setLocked(true);
    else if (!std::strcmp(op, "UNLOCK")) r = security.setLocked(false);
    else if (!std::strcmp(op, "ENROLL")) r = security.startEnrollment(now);
    else if (!std::strcmp(op, "CANCEL")) r = security.cancelEnrollment();
    else if (!std::strcmp(op, "REVOKE")) {
      evse::Uid uid;
      if (evse::parseUid(arg, uid)) r = security.revoke(uid);
    }
    return evse::resultName(r);
  }
  void state() {
    std::cout << "STATE|" << (security.locked() ? "1" : "0") << "|"
      << unsigned(security.count()) << "|" << (security.enrolling() ? "1" : "0")
      << "|" << charge.name() << std::endl;
  }
};
int main() {
  Adapter io;
  evse::Gateway gateway;
  std::random_device random;
  uint8_t entropy[16];
  for (auto &byte : entropy) byte = static_cast<uint8_t>(random());
  if (!io.security.begin() || !gateway.begin(entropy, true)) return 2;
  const auto start = std::chrono::steady_clock::now();
  auto now = [&]() { return static_cast<uint32_t>(std::chrono::duration_cast<
    std::chrono::milliseconds>(std::chrono::steady_clock::now() - start).count()); };
  std::string pending;
  while (true) {
    gateway.tick(now()); io.security.tick(now()); io.charge.tick(now());
    pollfd fd{STDIN_FILENO, POLLIN, 0};
    if (poll(&fd, 1, 20) < 0) return 3;
    if (!(fd.revents & (POLLIN | POLLHUP))) continue;
    char bytes[256]; const auto n = read(STDIN_FILENO, bytes, sizeof(bytes));
    if (n <= 0) return 0;
    pending.append(bytes, static_cast<size_t>(n));
    size_t pos;
    while ((pos = pending.find('\n')) != std::string::npos) {
      const auto line = pending.substr(0, pos); pending.erase(0, pos + 1);
      if (line == "@STATE") io.state();
      else if (line == "@CARD") {
        // Test-only fresh presentation directly at Security boundary; no UID output.
        evse::Uid uid; evse::parseUid("01:23:45:67", uid);
        if (io.security.card(uid, now()) != evse::Result::Enrolled) return 4;
        io.state();
      } else if (!gateway.handle(line.c_str(), now(), io)) return 5;
    }
    if (pending.size() > 192) return 6;
  }
}
