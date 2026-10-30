#include "gateway.h"
#include <cstdio>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#define CHECK(x) do { if (!(x)) throw std::runtime_error(std::to_string(__LINE__) + ": " #x); } while (false)
namespace {
const std::string session = "000102030405060708090a0b0c0d0e0f";
std::string id(unsigned n) { char s[33]; std::snprintf(s,sizeof(s),"%032x",n); return s; }
struct Io : evse::GatewayIo {
  unsigned snapshots = 0, calls = 0;
  std::vector<std::string> lines;
  void output(const char *line) override { lines.emplace_back(line); }
  void snapshot() override {
    ++snapshots;
    output("CHARGING"); output("ANTITHEFT"); output("SECURITY");
  }
  const char *execute(const char *, const char *, uint32_t) override { ++calls; return "OK"; }
  const std::string &last() const { return lines.back(); }
};
void start(evse::Gateway &g) {
  uint8_t bytes[16]; for (unsigned i = 0; i < 16; ++i) bytes[i] = static_cast<uint8_t>(i);
  CHECK(g.begin(bytes,true)); CHECK(!g.begin(bytes,true));
}
std::string status(unsigned n) { return "CMD:GATEWAY:" + id(n) + ":" + session + ":STATUS"; }
std::string lease(evse::Gateway &g, Io &io, unsigned n, uint32_t now) {
  CHECK(g.handle(status(n).c_str(),now,io));
  const auto at = io.last().find(":STATUS:OK:"); CHECK(at != std::string::npos);
  return io.last().substr(at+11,32);
}
std::string request(unsigned n, const std::string &token, const std::string &op) {
  return "CMD:GATEWAY:" + id(n) + ":" + session + ":" + token + ":" + op;
}
void discoveryAndParsing() {
  evse::Gateway g; Io io; start(g);
  CHECK(!g.handle("CMD:STATUS",0,io));
  g.handle(("CMD:GATEWAY:HELLO:"+id(1)).c_str(),0,io);
  CHECK(io.last() == "EVSE:GATEWAY:HELLO:"+id(1)+":"+session+":2");
  g.handle(status(1).c_str(),0,io);
  CHECK(io.last().find("DUPLICATE_MISMATCH") != std::string::npos);
  for (const char *bad : {"CMD:GATEWAY:","CMD:GATEWAY:HELLO:",
       "CMD:GATEWAY:HELLO:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
       "CMD:GATEWAY:HELLO:00000000000000000000000000000000:extra"}) {
    g.handle(bad,0,io); CHECK(io.last() == "EVSE:ERROR:INVALID_ARGUMENT");
  }
  auto wrong = status(3); wrong.replace(45,32,id(99));
  g.handle(wrong.c_str(),0,io); CHECK(io.last().find("SESSION_MISMATCH") != std::string::npos);
  CHECK(io.snapshots == 0 && io.calls == 0);
  const auto token = lease(g,io,4,0);
  CHECK(token == id(1));
  CHECK(io.lines[io.lines.size()-4] == "CHARGING");
  CHECK(io.lines[io.lines.size()-3] == "ANTITHEFT");
  CHECK(io.lines[io.lines.size()-2] == "SECURITY");
  g.handle(status(4).c_str(),1,io); CHECK(io.snapshots == 1);
}
void dedupeAndConsumption() {
  evse::Gateway g; Io io; start(g);
  auto token = lease(g,io,1,100);
  auto req = request(2,token,"UNLOCK");
  g.handle(req.c_str(),101,io); CHECK(io.calls == 1);
  auto ack = io.last();
  g.handle(req.c_str(),102,io); CHECK(io.last() == ack && io.calls == 1);
  g.handle(request(2,token,"LOCK").c_str(),103,io);
  CHECK(io.last().find("DUPLICATE_MISMATCH") != std::string::npos && io.calls == 1);
  g.handle(request(3,token,"LOCK").c_str(),104,io);
  CHECK(io.last().find("INVALID_LEASE") != std::string::npos && io.calls == 1);
  // Even after the request cache expires, the spent token never becomes valid.
  g.handle(req.c_str(),20000,io); CHECK(io.calls == 1);
  for (const auto &bad : {"LOCK:extra","MIRROR:OFF:extra","REVOKE:private","BOGUS"}) {
    evse::Gateway invalid; Io rejected; start(invalid);
    token = lease(invalid,rejected,10,20001);
    auto line = request(11,token,bad);
    invalid.handle(line.c_str(),20002,rejected);
    CHECK(rejected.last().find("INVALID_ARGUMENT") != std::string::npos);
    invalid.handle(request(12,token,"UNLOCK").c_str(),20003,rejected);
    CHECK(rejected.last().find("INVALID_LEASE") != std::string::npos);
    CHECK(rejected.calls == 0);
  }
  CHECK(io.calls == 1);
  // ID collision must not consume a different live lease.
  evse::Gateway collision; Io other; start(collision);
  const auto first = lease(collision,other,1,0);
  const auto second = lease(collision,other,2,0);
  collision.handle(request(3,first,"LOCK").c_str(),1,other);
  collision.handle(request(3,second,"UNLOCK").c_str(),2,other);
  CHECK(other.last().find("DUPLICATE_MISMATCH") != std::string::npos);
  collision.handle(request(4,second,"UNLOCK").c_str(),3,other); CHECK(other.calls == 2);
}
void boundariesAndCapacity() {
  for (uint32_t base : {uint32_t(0),uint32_t(0xfffffff0)}) {
    evse::Gateway g; Io io; start(g);
    const auto token = lease(g,io,1,base);
    g.handle(request(2,token,"LOCK").c_str(),base+7999,io); CHECK(io.calls == 1);
    const auto next = lease(g,io,3,base+7999);
    g.handle(request(4,next,"LOCK").c_str(),base+15999,io);
    CHECK(io.last().find("INVALID_LEASE") != std::string::npos);
  }
  evse::Gateway g; Io io; start(g);
  std::string first;
  for (unsigned i = 1; i <= 8; ++i) {
    auto token = lease(g,io,i,0); if (i == 1) first = token;
  }
  g.handle(status(9).c_str(),1,io); CHECK(io.last().find("BUSY") != std::string::npos);
  CHECK(io.snapshots == 8);
  g.handle(request(10,first,"LOCK").c_str(),2,io);
  CHECK(io.last().find("BUSY") != std::string::npos && io.calls == 0);
  g.handle(request(10,first,"LOCK").c_str(),10000,io);
  CHECK(io.last().find("INVALID_LEASE") != std::string::npos && io.calls == 0);
  CHECK(lease(g,io,20,10001) != first);
  // A reboot rejects the old combined session+lease, even if its counter repeats.
  evse::Gateway rebooted; Io rebootIo; uint8_t entropy[16];
  for (unsigned i = 0; i < 16; ++i) entropy[i] = static_cast<uint8_t>(i+1);
  CHECK(rebooted.begin(entropy,true));
  rebooted.handle(request(21,first,"UNLOCK").c_str(),10002,rebootIo);
  CHECK(rebootIo.last().find("SESSION_MISMATCH") != std::string::npos && rebootIo.calls == 0);
}
void operationsAndFraming() {
  unsigned n = 1;
  for (const char *op : {"LOCK","UNLOCK","ENROLL","CANCEL","REVOKE:10:20:30:40",
       "REVOKE:10:20:30:40:50:60:70:80:90:A0","MIRROR:ON","MIRROR:OFF","MIRROR:UNKNOWN"}) {
    evse::Gateway g; Io io; start(g);
    auto req = request(n+1,lease(g,io,n,0),op);
    CHECK(req.size() <= evse::UART_LINE_CAPACITY);
    evse::LineReader reader;
    for (char c : req) CHECK(reader.feed(c,0) == evse::FrameResult::None);
    CHECK(reader.feed('\n',1) == evse::FrameResult::Line);
    g.handle(reader.line(),1,io); CHECK(io.calls == 1);
    CHECK(io.last().find("10:20:30:40") == std::string::npos);
    n += 2;
  }
}
void entropyAndWatchdog() {
  evse::Gateway g; Io io;
  CHECK(!g.begin(nullptr,false));
  uint8_t bytes[16]{}; bytes[1] = 1;
  CHECK(!g.begin(bytes,true)); // cannot recover failed startup within same boot
  g.handle(("CMD:GATEWAY:HELLO:"+id(1)).c_str(),0,io);
  CHECK(io.last() == "EVSE:ERROR:GATEWAY_UNAVAILABLE");
  evse::Gateway broken; uint8_t zero[16]{}; CHECK(!broken.begin(zero,true));
  for (uint32_t base : {uint32_t(0),uint32_t(0xfffffff0)}) {
    evse::ChargeMirror c; CHECK(c.value() == evse::Charge::Unknown);
    c.update(evse::Charge::On,base); CHECK(!c.tick(base+9999));
    CHECK(c.tick(base+10000) && c.value() == evse::Charge::Unknown);
    c.update(evse::Charge::Off,base+10001);
    c.update(evse::Charge::Off,base+19999); // unchanged value still refreshes
    CHECK(!c.tick(base+20001)); CHECK(c.tick(base+29999));
    c.update(evse::Charge::Unknown,base+30000); CHECK(!c.tick(base+40000));
  }
}
}
int main() {
  try {
    discoveryAndParsing(); dedupeAndConsumption(); boundariesAndCapacity();
    operationsAndFraming(); entropyAndWatchdog();
    std::cout << "5 gateway protocol suites passed\n";
  } catch (const std::exception &e) { std::cerr << e.what() << '\n'; return 1; }
}
