#include "gateway.h"
#include <cstdio>
#include <cstring>
#include <limits>
#include <initializer_list>

namespace evse {
namespace {
bool hex32(const char *s) {
  if (std::strlen(s) != 32) return false;
  for (unsigned i = 0; i < 32; ++i)
    if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return false;
  return true;
}
// Split one token, leaving an untouched remainder (UID contains colons).
char *take(char *&s) {
  char *value = s;
  if (!s) return nullptr;
  char *end = std::strchr(s, ':');
  if (end) { *end = '\0'; s = end + 1; } else s = nullptr;
  return value;
}
bool equal(const char *a, const char *b) { return a && std::strcmp(a,b) == 0; }
}
bool Gateway::begin(const uint8_t *entropy, bool available) {
  if (initialized_) return false;
  initialized_ = true;
  if (!available || !entropy) return false;
  bool varied = false;
  for (unsigned i = 1; i < 16; ++i) varied |= entropy[i] != entropy[0];
  if (!varied) return false; // obvious broken adapter, not an entropy health proof
  constexpr char hex[] = "0123456789abcdef";
  for (unsigned i = 0; i < 16; ++i) {
    session_[i*2] = hex[entropy[i] >> 4]; session_[i*2+1] = hex[entropy[i] & 15];
  }
  enabled_ = true; return true;
}
void Gateway::tick(uint32_t now) {
  for (auto &l : leases_) if (l.live && now - l.issued >= 8000) l.live = false;
  for (auto &c : cache_) if (c.live && now - c.at >= 10000) c.live = false;
}
bool Gateway::handle(const char *line, uint32_t now, GatewayIo &io) {
  constexpr char prefix[] = "CMD:GATEWAY:";
  if (!line || std::strncmp(line,prefix,sizeof(prefix)-1) != 0) return false;
  tick(now);
  if (std::strlen(line) > UART_LINE_CAPACITY) { io.output("EVSE:ERROR:INVALID_ARGUMENT"); return true; }
  char buffer[UART_LINE_CAPACITY+1]; std::strcpy(buffer,line+sizeof(prefix)-1);
  char *rest = buffer;
  char *id = take(rest);
  char reply[160];
  if (equal(id,"HELLO")) {
    if (!rest || !hex32(rest)) io.output("EVSE:ERROR:INVALID_ARGUMENT");
    else if (!enabled_) io.output("EVSE:ERROR:GATEWAY_UNAVAILABLE");
    else {
      for (const auto &c : cache_) if (c.live && std::strcmp(c.id.data(),rest) == 0) {
        if (std::strcmp(c.request.data(),line) == 0) io.output(c.reply.data());
        else {
          std::snprintf(reply,sizeof(reply),"EVSE:GATEWAY:RESULT:%.32s:%.32s:HELLO:DUPLICATE_MISMATCH",rest,session_.data());
          io.output(reply);
        }
        return true;
      }
      Cached *slot = nullptr;
      for (auto &c : cache_) if (!c.live) { slot = &c; break; }
      if (!slot) {
        std::snprintf(reply,sizeof(reply),"EVSE:GATEWAY:RESULT:%.32s:%.32s:HELLO:BUSY",rest,session_.data());
        io.output(reply); return true;
      }
      std::snprintf(reply,sizeof(reply),"EVSE:GATEWAY:HELLO:%.32s:%.32s:2",rest,session_.data());
      slot->live = true; slot->at = now;
      std::strcpy(slot->id.data(),rest); std::strcpy(slot->request.data(),line);
      std::strcpy(slot->reply.data(),reply);
      io.output(reply);
    }
    return true;
  }
  char *session = take(rest);
  if (!id || !hex32(id) || !session || !hex32(session)) {
    io.output("EVSE:ERROR:INVALID_ARGUMENT"); return true;
  }
  char *token = take(rest);
  const bool status = equal(token,"STATUS") && !rest;
  char *operation = status ? token : take(rest);
  const char *op = "INVALID";
  for (const char *known : {"STATUS","LOCK","UNLOCK","ENROLL","CANCEL","REVOKE","MIRROR"})
    if (equal(operation,known)) op = known;
  auto respond = [&](const char *code) {
    std::snprintf(reply,sizeof(reply),"EVSE:GATEWAY:RESULT:%.32s:%.32s:%.7s:%.24s",id,session,op,code);
  };
  if (!enabled_ || std::strcmp(session,session_.data()) != 0) {
    respond(enabled_ ? "SESSION_MISMATCH" : "GATEWAY_UNAVAILABLE"); io.output(reply); return true;
  }
  for (const auto &c : cache_) if (c.live && std::strcmp(c.id.data(),id) == 0) {
    if (std::strcmp(c.request.data(),line) == 0) io.output(c.reply.data());
    else { respond("DUPLICATE_MISMATCH"); io.output(reply); }
    return true;
  }
  // Consume an authentic lease BEFORE validation, capacity checks or side effects.
  bool admitted = false;
  if (!status && token && hex32(token)) {
    for (auto &l : leases_) if (l.live && std::strcmp(l.token.data(),token) == 0) {
      l.live = false; admitted = true; break;
    }
  }
  Cached *slot = nullptr;
  for (auto &c : cache_) if (!c.live) { slot = &c; break; }
  if (!slot) { respond("BUSY"); io.output(reply); return true; }
  if (status) {
    Lease *lease = nullptr;
    for (auto &l : leases_) if (!l.live) { lease = &l; break; }
    if (!lease || nextLease_ == std::numeric_limits<uint64_t>::max()) respond("BUSY");
    else {
      ++nextLease_;
      // Counter never reused in a boot, even after cache/lease expiry. Bound to session.
      std::snprintf(lease->token.data(),lease->token.size(),"%016llx%016llx",
                    0ULL,static_cast<unsigned long long>(nextLease_));
      lease->live = true; lease->issued = now;
      io.snapshot();
      std::snprintf(reply,sizeof(reply),"EVSE:GATEWAY:RESULT:%.32s:%.32s:STATUS:OK:%.32s:8",
                    id,session,lease->token.data());
    }
  } else if (!admitted) respond("INVALID_LEASE");
  else {
    bool valid = false;
    if (equal(op,"LOCK") || equal(op,"UNLOCK") || equal(op,"ENROLL") || equal(op,"CANCEL")) valid = !rest;
    if (equal(op,"MIRROR")) valid = equal(rest,"ON") || equal(rest,"OFF") || equal(rest,"UNKNOWN");
    if (equal(op,"REVOKE")) { Uid uid; valid = rest && parseUid(rest,uid); }
    respond(valid ? io.execute(op,rest,now) : "INVALID_ARGUMENT");
  }
  slot->live = true; slot->at = now;
  std::strcpy(slot->id.data(),id); std::strcpy(slot->request.data(),line);
  std::strcpy(slot->reply.data(),reply);
  io.output(reply);
  return true;
}
} // namespace evse
