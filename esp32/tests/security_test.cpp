#include "protocol.h"
#include "security.h"

#include <algorithm>
#include <functional>
#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {
using namespace evse;

// Deliberately not assert(): these checks also run with -DNDEBUG.
void check(bool condition, const char *expression, int line) {
  if (!condition)
    throw std::runtime_error("line " + std::to_string(line) + ": " + expression);
}
#define CHECK(expression) check(bool(expression), #expression, __LINE__)

struct MemoryStorage : Storage {
  LoadResult result = LoadResult::Missing;
  Blob blob{};
  unsigned loads = 0;
  unsigned saves = 0;
  bool fail = false;
  bool persistOnFailure = false;
  std::function<void(const Blob &)> beforeSave;
  LoadResult load(Blob &out) override {
    ++loads;
    if (result == LoadResult::Found) out = blob;
    return result;
  }
  bool save(const Blob &in) override {
    ++saves;
    if (beforeSave) beforeSave(in);
    if (!fail || persistOnFailure) {
      blob = in;
      result = LoadResult::Found;
    }
    return !fail;
  }
};

Uid uid(unsigned id = 1, uint8_t size = 4) {
  Uid value;
  value.size = size;
  for (unsigned i = 0; i < value.bytes.size(); ++i)
    value.bytes[i] = static_cast<uint8_t>(id + i * 17);
  return value; // Entirely fabricated, including the unused bytes.
}
Record record(bool locked = true, BootMode mode = BootMode::Restore,
              unsigned count = 1) {
  Record value;
  value.locked = locked;
  value.mode = mode;
  value.count = static_cast<uint8_t>(count);
  for (unsigned i = 0; i < count; ++i) value.cards[i] = uid(i + 1);
  return value;
}

// Independent wire-record builder/CRC, so codec roundtrips alone cannot hide
// a mutually consistent encoder/decoder format mistake.
void repairCrc(Blob &blob) {
  uint32_t crc = 0xffffffffU;
  for (std::size_t i = 0; i < 184; ++i) {
    crc ^= blob[i];
    for (unsigned bit = 0; bit < 8; ++bit) {
      if (crc & 1U) crc = (crc >> 1) ^ 0xedb88320U;
      else crc >>= 1;
    }
  }
  crc ^= 0xffffffffU;
  for (unsigned i = 0; i < 4; ++i)
    blob[184 + i] = static_cast<uint8_t>(crc >> (8 * i));
}
Blob wire(const Record &r) {
  Blob b{};
  b[0] = 'E'; b[1] = 'V'; b[2] = 'S'; b[3] = '1';
  b[4] = 1; b[5] = static_cast<uint8_t>(r.mode);
  b[6] = r.locked ? 1 : 0; b[7] = r.count;
  for (unsigned i = 0; i < r.count; ++i) {
    b[8 + 11 * i] = r.cards[i].size;
    for (unsigned j = 0; j < r.cards[i].size && j < 10; ++j)
      b[9 + 11 * i + j] = r.cards[i].bytes[j];
  }
  repairCrc(b);
  return b;
}
MemoryStorage stored(const Record &r) {
  MemoryStorage s;
  s.result = LoadResult::Found;
  s.blob = wire(r);
  return s;
}
void latched(Security &s, MemoryStorage &storage) {
  CHECK(!s.ready());
  CHECK(s.fault() == Fault::Write);
  CHECK(s.locked()); // emergency fallback, explicitly not a durable-success claim
  CHECK(!s.enrolling());
  CHECK(!s.allowed(uid()));
  unsigned saves = storage.saves;
  CHECK(s.card(uid(), 90000) == Result::NotReady);
  CHECK(s.startEnrollment(90000) == Result::NotReady);
  CHECK(s.revoke(uid()) == Result::NotReady);
  CHECK(s.setBootMode(BootMode::Locked) == Result::NotReady);
  CHECK(storage.saves == saves);
}
bool presented(Security &s, Presence &p, Observation o, uint32_t now,
               const Uid &card, Result &result) {
  if (!p.observe(o, now)) return false;
  result = s.card(card, now);
  return true;
}
void rearm(Presence &p, uint32_t start) {
  CHECK(!p.observe(Observation::Absent, start));
  CHECK(!p.observe(Observation::Absent, start + 250));
  CHECK(!p.observe(Observation::Absent, start + 500));
}
FrameResult bytes(LineReader &reader, const std::string &text, uint32_t now) {
  FrameResult result = FrameResult::None;
  for (char c : text) result = reader.feed(c, now);
  return result;
}
void goodNext(LineReader &reader, uint32_t now) {
  CHECK(bytes(reader, "CMD:STATUS\n", now) == FrameResult::Line);
  CHECK(std::string(reader.line()) == "CMD:STATUS");
  CHECK(parseCommand(reader.line()).kind == CommandKind::Status);
}
void malformed(const Blob &b) {
  Record out = record(false, BootMode::Unlocked, 2);
  Blob before = wire(out);
  CHECK(!decode(b, out));
  CHECK(wire(out) == before); // no partial decode exposed
  MemoryStorage storage;
  storage.result = LoadResult::Found;
  storage.blob = b;
  Security s(storage);
  CHECK(!s.begin());
  CHECK(!s.ready());
  CHECK(s.locked());
  CHECK(s.count() == 0);
  CHECK(s.fault() == Fault::Corrupt);
  CHECK(storage.saves == 0);
  CHECK(storage.blob == b);
  CHECK(s.card(uid(), 1) == Result::NotReady);
}

void missingInitializes() {
  MemoryStorage storage;
  Security s(storage);
  CHECK(!s.ready());
  CHECK(s.locked());
  CHECK(s.card(uid(), 0) == Result::NotReady);
  CHECK(s.begin());
  CHECK(storage.loads == 1 && storage.saves == 1);
  CHECK(s.ready() && s.locked() && s.count() == 0);
  CHECK(s.mode() == BootMode::Restore);
  CHECK(storage.blob == wire(record(true, BootMode::Restore, 0)));
  Security restarted(storage);
  CHECK(restarted.begin());
  CHECK(storage.saves == 1);
}
void unavailableFailsClosed() {
  auto storage = stored(record(false));
  storage.result = LoadResult::Error;
  auto original = storage.blob;
  Security s(storage);
  CHECK(!s.begin());
  CHECK(s.fault() == Fault::Unavailable);
  CHECK(!s.ready() && s.locked() && s.count() == 0);
  CHECK(!s.allowed(uid()));
  CHECK(s.startEnrollment(0) == Result::NotReady);
  CHECK(s.revoke(uid()) == Result::NotReady);
  CHECK(s.setBootMode(BootMode::Unlocked) == Result::NotReady);
  CHECK(storage.saves == 0 && storage.blob == original);
}
void corruptStorageBoundary() {
  // Wrong blob length/type is reported by the adapter; the fixed-size Blob
  // interface itself cannot represent an oversized/undersized NVS value.
  auto storage = stored(record(false));
  storage.result = LoadResult::Corrupt;
  auto original = storage.blob;
  Security s(storage);
  CHECK(!s.begin());
  CHECK(s.fault() == Fault::Corrupt);
  CHECK(!s.ready() && s.locked() && s.count() == 0);
  CHECK(!s.enrolling() && !s.allowed(uid()));
  CHECK(s.card(uid(), 0) == Result::NotReady);
  CHECK(s.startEnrollment(0) == Result::NotReady);
  CHECK(s.revoke(uid()) == Result::NotReady);
  CHECK(s.setBootMode(BootMode::Unlocked) == Result::NotReady);
  CHECK(storage.loads == 1 && storage.saves == 0 && storage.blob == original);
}
void whitelistAndDenial() {
  auto storage = stored(record());
  Security s(storage);
  CHECK(s.begin());
  CHECK(s.allowed(uid()));
  auto original = storage.blob;
  CHECK(!s.allowed(uid(99)));
  CHECK(s.card(uid(99), 0) == Result::Denied);
  CHECK(s.card(uid(99), 90000) == Result::Denied);
  CHECK(s.card(uid(1, 5), 0) == Result::InvalidUid);
  CHECK(s.revoke(uid(99)) == Result::NotFound);
  CHECK(s.revoke(uid(1, 0)) == Result::InvalidUid);
  CHECK(s.setBootMode(BootMode::Restore) == Result::Ok);
  CHECK(storage.saves == 0 && storage.blob == original);
  CHECK(s.locked() && s.count() == 1);
}
void startupGateFirstTap() {
  auto storage = stored(record());
  Security s(storage);
  Presence p;
  Result result = Result::Ok;
  CHECK(s.begin());
  CHECK(!presented(s, p, Observation::Card, 0, uid(), result));
  rearm(p, 1);
  CHECK(presented(s, p, Observation::Card, 502, uid(), result));
  CHECK(result == Result::Unlocked); // not incorrectly debounced before 800 ms
  CHECK(!s.locked() && storage.saves == 1);
}
void debounceBoundaries() {
  for (uint32_t start : {uint32_t(0), uint32_t(0xffffff00U)}) {
    auto storage = stored(record());
    Security s(storage);
    CHECK(s.begin());
    CHECK(s.card(uid(), start) == Result::Unlocked);
    CHECK(s.card(uid(), start + 799) == Result::Debounced);
    CHECK(s.card(uid(99), start + 800) == Result::Denied);
    CHECK(storage.saves == 1 && !s.locked());
    CHECK(s.card(uid(), start + 800) == Result::Locked);
    CHECK(s.card(uid(), start + 1599) == Result::Debounced);
    CHECK(s.card(uid(), start + 1600) == Result::Unlocked);
    CHECK(storage.saves == 3);
  }
}
void enrollmentWindow() {
  for (uint32_t start : {uint32_t(10), uint32_t(0xfffffff0U)}) {
    MemoryStorage storage;
    Security s(storage);
    CHECK(s.begin());
    CHECK(s.startEnrollment(start) == Result::EnrollStarted);
    CHECK(s.startEnrollment(start + 29999) == Result::EnrollActive);
    CHECK(s.tick(start + 29999) == Result::Ok);
    CHECK(s.enrolling());
    CHECK(s.tick(start + 30000) == Result::EnrollExpired);
    CHECK(!s.enrolling());
    CHECK(s.tick(start + 30001) == Result::Ok);
    CHECK(s.card(uid(), start + 30001) == Result::Denied);
    CHECK(storage.saves == 1);
  }
}
void enrollmentCardAtExpiry() {
  for (uint32_t start : {uint32_t(0), uint32_t(0xfffffff0U)}) {
    MemoryStorage storage;
    Security s(storage);
    CHECK(s.begin());
    CHECK(s.startEnrollment(start) == Result::EnrollStarted);
    CHECK(s.card(uid(), start + 30000) == Result::EnrollExpired);
    CHECK(!s.enrolling() && s.count() == 0 && s.locked());
    CHECK(storage.saves == 1);
    CHECK(s.startEnrollment(start + 30001) == Result::EnrollStarted);
    CHECK(s.card(uid(), start + 60000) == Result::Enrolled);
    CHECK(s.count() == 1 && s.locked());
  }
}
void enrollOneCancelDuplicate() {
  auto storage = stored(record());
  Security s(storage);
  CHECK(s.begin());
  CHECK(s.cancelEnrollment() == Result::EnrollInactive);
  CHECK(s.startEnrollment(0) == Result::EnrollStarted);
  CHECK(s.cancelEnrollment() == Result::EnrollCancelled);
  CHECK(s.cancelEnrollment() == Result::EnrollInactive);
  CHECK(s.startEnrollment(1) == Result::EnrollStarted);
  CHECK(s.card(uid(1, 5), 2) == Result::InvalidUid);
  CHECK(s.enrolling());
  CHECK(s.card(uid(), 3) == Result::AlreadyAllowed);
  CHECK(!s.enrolling() && s.locked() && storage.saves == 0);
  CHECK(s.startEnrollment(4) == Result::EnrollStarted);
  CHECK(s.card(uid(2, 7), 5) == Result::Enrolled);
  CHECK(!s.enrolling() && s.locked() && s.count() == 2);
  CHECK(s.allowed(uid(2, 7)));
  CHECK(s.card(uid(3), 6) == Result::Denied);
  CHECK(storage.saves == 1);
}
void fullWhitelistAndRevokeLast() {
  MemoryStorage storage;
  Security s(storage);
  CHECK(s.begin());
  for (unsigned i = 1; i <= 16; ++i) {
    CHECK(s.startEnrollment(i * 100) == Result::EnrollStarted);
    CHECK(s.card(uid(i), i * 100 + 1) == Result::Enrolled);
    CHECK(s.count() == i && s.locked());
  }
  CHECK(storage.saves == 17);
  CHECK(s.startEnrollment(2000) == Result::Full);
  CHECK(!s.enrolling());
  CHECK(s.card(uid(17), 2001) == Result::Denied);
  CHECK(storage.saves == 17);
  for (unsigned i = 1; i <= 16; ++i) {
    CHECK(s.revoke(uid(i)) == Result::Revoked);
    CHECK(!s.allowed(uid(i)));
    CHECK(s.count() == 16 - i && s.locked());
    Record out;
    CHECK(decode(storage.blob, out)); // vacated slots have canonical zero padding
  }
  CHECK(s.card(uid(16), 3000) == Result::Denied);
  CHECK(storage.saves == 33);
  CHECK(s.startEnrollment(3001) == Result::EnrollStarted);
}
void revokeCancelsEnrollment() {
  auto storage = stored(record(false, BootMode::Restore, 2));
  Security s(storage);
  CHECK(s.begin());
  CHECK(s.startEnrollment(0) == Result::EnrollStarted);
  CHECK(s.revoke(uid()) == Result::Revoked);
  CHECK(!s.enrolling() && !s.locked() && s.count() == 1);
  CHECK(s.allowed(uid(2)));
  CHECK(s.card(uid(3), 1) == Result::Denied);
  CHECK(s.revoke(uid(2)) == Result::Revoked);
  CHECK(s.count() == 0 && !s.locked()); // revocation does not invent a servo action
}
void deniedRevokeCancelsEnrollment() {
  // Cancellation is a command safety property, even for a nonmember UID.
  auto storage = stored(record());
  Security s(storage);
  CHECK(s.begin());
  CHECK(s.startEnrollment(0) == Result::EnrollStarted);
  CHECK(s.revoke(uid(99)) == Result::NotFound);
  CHECK(!s.enrolling());
  CHECK(storage.saves == 0);
}
void invalidRevokeCancelsEnrollment() {
  auto storage = stored(record());
  Security s(storage);
  CHECK(s.begin());
  CHECK(s.startEnrollment(0) == Result::EnrollStarted);
  CHECK(s.revoke(uid(1, 5)) == Result::InvalidUid);
  CHECK(!s.enrolling());
  CHECK(storage.saves == 0);
}
void restartAndForcedPolicies() {
  for (BootMode mode : {BootMode::Restore, BootMode::Locked, BootMode::Unlocked}) {
    for (bool locked : {false, true}) {
      auto storage = stored(record(locked, mode));
      Security s(storage);
      CHECK(s.begin());
      bool target = mode == BootMode::Restore ? locked : mode == BootMode::Locked;
      CHECK(s.locked() == target && s.mode() == mode);
      CHECK(s.allowed(uid()) && s.count() == 1);
      CHECK(storage.saves == unsigned(target != locked));
      CHECK(s.setBootMode(mode) == Result::Ok);
      CHECK(storage.saves == unsigned(target != locked));
      Security restarted(storage);
      CHECK(restarted.begin());
      CHECK(restarted.locked() == target && restarted.allowed(uid()));
      CHECK(storage.saves == unsigned(target != locked));
    }
  }
}
void policyOnlyChangesNextBoot() {
  auto storage = stored(record(false));
  Security s(storage);
  CHECK(s.begin());
  CHECK(s.setBootMode(BootMode::Locked) == Result::ModeChanged);
  CHECK(!s.locked());
  CHECK(s.setBootMode(BootMode::Locked) == Result::Ok);
  CHECK(storage.saves == 1);
  CHECK(s.setBootMode(static_cast<BootMode>(255)) == Result::InvalidArgument);
  CHECK(storage.saves == 1);
  Security next(storage);
  CHECK(next.begin() && next.locked());
  CHECK(storage.saves == 2);
  CHECK(next.setBootMode(BootMode::Unlocked) == Result::ModeChanged);
  CHECK(next.locked());
  Security unlocked(storage);
  CHECK(unlocked.begin() && !unlocked.locked());
  CHECK(storage.saves == 4);
}
void persistenceBeforeSuccess() {
  auto storage = stored(record());
  Security s(storage);
  CHECK(s.begin());
  storage.beforeSave = [&](const Blob &candidate) {
    CHECK(s.ready() && s.locked() && s.count() == 1);
    Record out;
    CHECK(decode(candidate, out));
    CHECK(!out.locked && out.count == 1);
  };
  CHECK(s.card(uid(), 0) == Result::Unlocked);
  storage.beforeSave = [&](const Blob &candidate) {
    CHECK(!s.locked() && s.count() == 1 && !s.allowed(uid(2)));
    Record out;
    CHECK(decode(candidate, out) && out.count == 2 && !out.locked);
  };
  CHECK(s.startEnrollment(1) == Result::EnrollStarted);
  CHECK(s.card(uid(2), 2) == Result::Enrolled);
  storage.beforeSave = [&](const Blob &candidate) {
    CHECK(s.allowed(uid()) && s.count() == 2 && !s.locked());
    Record out;
    CHECK(decode(candidate, out) && out.count == 1);
  };
  CHECK(s.revoke(uid()) == Result::Revoked);
  storage.beforeSave = [&](const Blob &candidate) {
    CHECK(s.mode() == BootMode::Restore && !s.locked());
    Record out;
    CHECK(decode(candidate, out) && out.mode == BootMode::Locked);
  };
  CHECK(s.setBootMode(BootMode::Locked) == Result::ModeChanged);
}

enum class Mutation { Tap, Enroll, Revoke, Policy };
void bootPersistenceOrdering() {
  for (unsigned path = 0; path < 3; ++path) {
    MemoryStorage storage;
    if (path == 1) storage = stored(record(false, BootMode::Locked));
    if (path == 2) storage = stored(record(true, BootMode::Unlocked));
    Security s(storage);
    storage.beforeSave = [&](const Blob &candidate) {
      CHECK(s.locked() == (path != 1)); // candidate not adopted before save
      CHECK(s.count() == (path == 0 ? 0 : 1));
      Record out;
      CHECK(decode(candidate, out));
      CHECK(out.locked == (path != 2));
      CHECK(out.count == (path == 0 ? 0 : 1));
    };
    CHECK(s.begin());
    CHECK(storage.saves == 1 && s.locked() == (path != 2));
  }
}
void failureMatrix(bool persistDespiteFailure) {
  for (bool locked : {false, true}) {
    for (Mutation mutation : {Mutation::Tap, Mutation::Enroll,
                              Mutation::Revoke, Mutation::Policy}) {
      for (BootMode mode : {BootMode::Restore, BootMode::Locked, BootMode::Unlocked}) {
        // Policy tests exercise every destination, including RESTORE.
        auto initial = record(locked);
        if (mutation == Mutation::Policy && mode == BootMode::Restore)
          initial.mode = locked ? BootMode::Locked : BootMode::Unlocked;
        auto storage = stored(initial);
        auto original = storage.blob;
        Security s(storage);
        CHECK(s.begin());
        CHECK(s.startEnrollment(0) == Result::EnrollStarted);
        if (mutation == Mutation::Tap) CHECK(s.cancelEnrollment() == Result::EnrollCancelled);
        storage.fail = true;
        storage.persistOnFailure = persistDespiteFailure;
        Result result = Result::Ok;
        switch (mutation) {
          case Mutation::Tap: result = s.card(uid(), 1); break;
          case Mutation::Enroll: result = s.card(uid(2), 1); break;
          case Mutation::Revoke: result = s.revoke(uid()); break;
          case Mutation::Policy: result = s.setBootMode(mode); break;
        }
        CHECK(result == Result::StorageError);
        CHECK(storage.saves == 1);
        CHECK(s.count() == 1 && s.mode() == initial.mode);
        latched(s, storage);
        if (!persistDespiteFailure) CHECK(storage.blob == original);
        else {
          CHECK(storage.blob != original);
          Record actual;
          CHECK(decode(storage.blob, actual));
          CHECK(actual.count == (mutation == Mutation::Enroll ? 2 :
                                 mutation == Mutation::Revoke ? 0 : 1));
          CHECK(actual.locked == (mutation == Mutation::Tap ? !locked : locked));
          CHECK(actual.mode == (mutation == Mutation::Policy ? mode : initial.mode));
        }
        storage.fail = false;
        storage.beforeSave = nullptr;
        Record actual;
        CHECK(decode(storage.blob, actual));
        Security reboot(storage);
        CHECK(reboot.begin());
        CHECK(reboot.count() == actual.count && reboot.mode() == actual.mode);
        bool target = actual.mode == BootMode::Restore ? actual.locked :
                      actual.mode == BootMode::Locked;
        CHECK(reboot.locked() == target);
        CHECK(reboot.allowed(uid()) == (actual.count > 0));
      }
    }
  }
}
void bootFailureMatrix() {
  for (bool unknownOutcome : {false, true}) {
    for (unsigned path = 0; path < 3; ++path) {
      MemoryStorage storage;
      if (path == 1) storage = stored(record(false, BootMode::Locked));
      if (path == 2) storage = stored(record(true, BootMode::Unlocked));
      Blob original = storage.blob;
      storage.fail = true;
      storage.persistOnFailure = unknownOutcome;
      Security s(storage);
      CHECK(!s.begin());
      CHECK(storage.saves == 1);
      latched(s, storage); // boot has no confirmed actuator state: fail closed
      if (!unknownOutcome) CHECK(storage.blob == original);
      else {
        Record out;
        CHECK(decode(storage.blob, out));
        CHECK(out.locked == (path != 2));
      }
      storage.fail = false;
      Security reboot(storage);
      CHECK(reboot.begin());
      CHECK(reboot.locked() == (path != 2));
      CHECK(reboot.count() == (path == 0 ? 0 : 1));
    }
  }
  for (BootMode mode : {BootMode::Restore, BootMode::Locked, BootMode::Unlocked}) {
    bool locked = mode != BootMode::Unlocked;
    auto storage = stored(record(locked, mode));
    storage.fail = true;
    Security s(storage);
    CHECK(s.begin()); // no unnecessary write for already-applied policy
    CHECK(storage.saves == 0 && s.locked() == locked);
  }
}

void uidLengthsAndFormatting() {
  for (unsigned length = 0; length <= 11; ++length) {
    Uid u = uid(1, static_cast<uint8_t>(length));
    bool valid = length == 4 || length == 7 || length == 10;
    CHECK(u.valid() == valid);
    CHECK((u == u) == valid);
    char text[30];
    formatUid(u, text);
    Uid parsed;
    if (!valid) { CHECK(std::string(text).empty()); continue; }
    CHECK(std::string(text).size() == length * 3 - 1);
    CHECK(parseUid(text, parsed) && parsed == u);
    std::string lower(text);
    for (char &c : lower) if (c >= 'A' && c <= 'F') c += 'a' - 'A';
    CHECK(parseUid(lower.c_str(), parsed) && parsed == u);
    auto r = record();
    r.cards[0] = u;
    CHECK(encode(r) == wire(r));
    Record decoded;
    CHECK(decode(wire(r), decoded) && decoded.cards[0] == u);
    auto storage = stored(r);
    Security s(storage);
    CHECK(s.begin() && s.allowed(parsed));
    CHECK(s.card(parsed, 0) == Result::Unlocked);
  }
  Uid a = uid(), b = a;
  b.bytes[9] ^= 0xff;
  CHECK(a == b); // unused UID bytes are not identity
  CHECK(!(a == uid(1, 7)));
}
void invalidUidLengthsCannotMutate() {
  auto storage = stored(record());
  Security s(storage);
  CHECK(s.begin());
  CHECK(s.startEnrollment(0) == Result::EnrollStarted);
  for (unsigned size = 0; size <= 255; ++size) {
    if (size == 4 || size == 7 || size == 10) continue;
    auto invalid = uid(99, static_cast<uint8_t>(size));
    CHECK(!invalid.valid() && !s.allowed(invalid));
    CHECK(s.card(invalid, 1) == Result::InvalidUid);
    CHECK(s.enrolling() && s.count() == 1 && s.locked());
    auto b = wire(record());
    b[8] = static_cast<uint8_t>(size);
    repairCrc(b);
    malformed(b);
  }
  CHECK(storage.saves == 0);
}
void invalidUidText() {
  Uid parsed = uid();
  CHECK(!parseUid(nullptr, parsed) && !parsed.valid());
  for (const char *text : {"", "01", "01:02:03", "01:02:03:04:05",
       "01:02:03:04:05:06", "01:02:03:04:05:06:07:08",
       "01:02:03:04:05:06:07:08:09", "01:02:03:04:05:06:07:08:09:0A:0B",
       "01020304", "01-02-03-04", "1:02:03:04", "01:02:03:GG",
       " 01:02:03:04", "01:02:03:04 ", "01:02:03:04:", "01:02:03:0Z"}) {
    parsed = uid();
    CHECK(!parseUid(text, parsed));
    CHECK(!parsed.valid());
  }
}
void recordSizeAndFormat() {
  static_assert(RECORD_SIZE == 188, "version 1 wire record must be 188 bytes");
  static_assert(sizeof(Blob) == 188, "Blob must not carry hidden padding");
  for (unsigned count : {0U, 1U, 16U}) {
    auto r = record(false, BootMode::Unlocked, count);
    CHECK(encode(r) == wire(r));
    Record out;
    CHECK(decode(wire(r), out));
    CHECK(out.count == count && !out.locked && out.mode == BootMode::Unlocked);
  }
}
void crcCorruption() {
  auto original = wire(record());
  // Every byte is CRC-protected, including the stored CRC itself.
  for (std::size_t i = 0; i < original.size(); ++i) {
    auto corrupt = original;
    corrupt[i] ^= 1;
    malformed(corrupt);
  }
}
void malformedFormatAndPadding() {
  for (auto change : std::vector<std::pair<unsigned, uint8_t>>{
       {0, 'X'}, {3, '2'}, {4, 0}, {4, 2}, {5, 3}, {6, 2}, {7, 17},
       {8, 0}, {8, 1}, {8, 3}, {8, 5}, {8, 6}, {8, 8}, {8, 9}, {8, 11},
       {13, 1}, // nonzero padding after a four-byte active UID
       {19, 4}, // nonzero length of an unused slot
       {20, 1}, {183, 1}}) {
    auto b = wire(record());
    b[change.first] = change.second;
    repairCrc(b); // structural invalidity, not merely bad checksum
    malformed(b);
  }
  auto r = record(true, BootMode::Restore, 2);
  r.cards[1] = r.cards[0];
  malformed(wire(r));
  // Fixed-size Blob has no length argument: model truncated data padded by a
  // storage adapter, never treat a short prefix as a valid record.
  auto fixture = record();
  auto b = wire(fixture);
  // Select a deterministic fixture with a nonzero last CRC byte: truncation
  // plus zero padding must differ even when exactly one byte is missing.
  for (unsigned value = 0; value <= 255 && b[187] == 0; ++value) {
    fixture.cards[0].bytes[0] = static_cast<uint8_t>(value);
    b = wire(fixture);
  }
  CHECK(b[187] != 0);
  for (std::size_t length : {std::size_t(0), std::size_t(7), std::size_t(8),
                             std::size_t(183), std::size_t(184), std::size_t(187)}) {
    Blob shortRecord{};
    std::copy_n(b.begin(), length, shortRecord.begin());
    malformed(shortRecord);
  }
}

void presenceBoundaries() {
  Presence p;
  CHECK(!p.observe(Observation::Card, 0));
  CHECK(!p.observe(Observation::Absent, 1));
  CHECK(!p.observe(Observation::Absent, 251));
  CHECK(!p.observe(Observation::Absent, 500));
  CHECK(!p.observe(Observation::Card, 500)); // 499 ms is not enough
  rearm(p, 501);
  CHECK(p.observe(Observation::Card, 1001)); // exactly 500 ms, <=250 ms gaps
  CHECK(!p.observe(Observation::Card, 1002));
}
void presenceHeldSwapAndPreEnroll() {
  auto storage = stored(record());
  Security s(storage);
  Presence p;
  Result result = Result::Ok;
  CHECK(s.begin());
  CHECK(!presented(s, p, Observation::Card, 0, uid(), result));
  CHECK(s.startEnrollment(1) == Result::EnrollStarted);
  for (uint32_t t = 2; t <= 2000; t += 100)
    CHECK(!presented(s, p, Observation::Card, t, uid(2), result));
  CHECK(s.enrolling() && s.count() == 1 && storage.saves == 0);
  rearm(p, 2001);
  CHECK(presented(s, p, Observation::Card, 2502, uid(2), result));
  CHECK(result == Result::Enrolled && s.locked());
  CHECK(!presented(s, p, Observation::Card, 3400, uid(), result));
  CHECK(storage.saves == 1); // swapping UID without observed removal is no tap
}
void presenceFaultAndCardReset() {
  for (Observation interrupt : {Observation::Card, Observation::Fault}) {
    Presence p;
    CHECK(!p.observe(Observation::Absent, 0));
    CHECK(!p.observe(Observation::Absent, 250));
    CHECK(!p.observe(interrupt, 499));
    CHECK(!p.observe(Observation::Absent, 500));
    CHECK(!p.observe(Observation::Absent, 750));
    CHECK(!p.observe(Observation::Card, 999));
    rearm(p, 1000);
    CHECK(p.observe(Observation::Card, 1501));
    CHECK(!p.observe(Observation::Fault, 1502));
    CHECK(!p.observe(Observation::Card, 1503));
  }
}
void presenceGapAndWrap() {
  for (uint32_t start : {uint32_t(0), uint32_t(0xffffff00U)}) {
    Presence p;
    CHECK(!p.observe(Observation::Absent, start));
    CHECK(!p.observe(Observation::Absent, start + 250));
    CHECK(!p.observe(Observation::Absent, start + 501)); // 251 ms gap restarts
    CHECK(!p.observe(Observation::Absent, start + 751));
    CHECK(!p.observe(Observation::Card, start + 1000));
    rearm(p, start + 1001);
    CHECK(p.observe(Observation::Card, start + 1502));
  }
}
void enrollmentRequiresNewRemoval() {
  auto storage = stored(record());
  Security s(storage);
  Presence p;
  Result result = Result::Ok;
  CHECK(s.begin());
  rearm(p, 0); // field was armed before enrollment command
  CHECK(s.startEnrollment(501) == Result::EnrollStarted);
  p.requireRemoval();
  CHECK(!presented(s, p, Observation::Card, 502, uid(2), result));
  CHECK(!presented(s, p, Observation::Card, 600, uid(3), result));
  CHECK(s.enrolling() && s.count() == 1 && storage.saves == 0);
  CHECK(!p.observe(Observation::Absent, 601));
  CHECK(!p.observe(Observation::Absent, 851));
  CHECK(s.startEnrollment(900) == Result::EnrollActive);
  // Firmware must not call requireRemoval for EnrollActive: the ongoing
  // clean-removal interval must survive this idempotent command.
  CHECK(!p.observe(Observation::Absent, 1101));
  CHECK(presented(s, p, Observation::Card, 1102, uid(3), result));
  CHECK(result == Result::Enrolled && !s.enrolling());
  CHECK(s.allowed(uid(3)) && !s.allowed(uid(2)) && s.locked());
  CHECK(storage.saves == 1);
  CHECK(!presented(s, p, Observation::Card, 2000, uid(3), result));
}
void requireRemovalResetsPartialAbsence() {
  for (uint32_t start : {uint32_t(0), uint32_t(0xffffff00U)}) {
    Presence p;
    CHECK(!p.observe(Observation::Absent, start));
    CHECK(!p.observe(Observation::Absent, start + 250));
    p.requireRemoval();
    CHECK(!p.observe(Observation::Absent, start + 500));
    CHECK(!p.observe(Observation::Absent, start + 750));
    CHECK(!p.observe(Observation::Card, start + 999)); // old 250 ms discarded
    rearm(p, start + 1000);
    CHECK(p.observe(Observation::Card, start + 1501));
  }
}

void frameExactLimits() {
  static_assert(LINE_MAX == 192, "UART payload bound is fixed");
  for (const std::string &ending : {std::string("\n"), std::string("\r\n")}) {
    LineReader r;
    std::string text(192, '~');
    CHECK(bytes(r, text + ending, 0) == FrameResult::Line);
    CHECK(std::string(r.line()) == text);
    CHECK(bytes(r, std::string(192, 'A'), 1) == FrameResult::None);
    CHECK(r.feed('B', 1) == FrameResult::TooLong);
    CHECK(std::string(r.line()).empty());
    CHECK(bytes(r, "CMD:STATUS", 1) == FrameResult::None);
    CHECK(bytes(r, ending, 1) == FrameResult::None);
    goodNext(r, 2);
  }
}
void frameInvalidBytes() {
  for (unsigned byte = 0; byte <= 255; ++byte) {
    if (byte >= 32 && byte <= 126) continue;
    if (byte == '\r' || byte == '\n') continue;
    LineReader r;
    CHECK(bytes(r, "CMD:", 0) == FrameResult::None);
    CHECK(r.feed(static_cast<char>(byte), 1) == FrameResult::Invalid);
    CHECK(std::string(r.line()).empty());
    CHECK(bytes(r, "STATUS\n", 2) == FrameResult::None);
    goodNext(r, 3);
  }
  LineReader printable;
  std::string all;
  for (unsigned c = 32; c <= 126; ++c) all += static_cast<char>(c);
  CHECK(bytes(printable, all + '\n', 0) == FrameResult::Line);
  CHECK(std::string(printable.line()) == all);
}
void frameCrRules() {
  for (const std::string &bad : {std::string("CMD:\rSTATUS\n"),
                                std::string("CMD:STATUS\r\r\n")}) {
    LineReader r;
    unsigned invalid = 0, lines = 0;
    for (char c : bad) {
      auto result = r.feed(c, 0);
      invalid += result == FrameResult::Invalid;
      lines += result == FrameResult::Line;
    }
    CHECK(invalid == 1 && lines == 0);
    goodNext(r, 1);
  }
  LineReader r;
  CHECK(bytes(r, "CMD:STATUS\r", 0) == FrameResult::None);
  CHECK(r.feed('\n', 1999) == FrameResult::Line);
  CHECK(parseCommand(r.line()).kind == CommandKind::Status);
}
void frameAbsoluteTimeout() {
  for (uint32_t start : {uint32_t(0), uint32_t(0xffffff00U)}) {
    LineReader r;
    CHECK(r.feed('C', start) == FrameResult::None);
    CHECK(r.feed('M', start + 900) == FrameResult::None);
    CHECK(r.feed('D', start + 1800) == FrameResult::None);
    CHECK(r.tick(start + 1999) == FrameResult::None);
    CHECK(r.tick(start + 2000) == FrameResult::Timeout);
    CHECK(std::string(r.line()).empty());
    CHECK(r.tick(start + 2001) == FrameResult::None);
    CHECK(bytes(r, ":STATUS\n", start + 2002) == FrameResult::None);
    goodNext(r, start + 2003);
  }
}
void frameTimeoutAtDelimiterAndSuffix() {
  for (bool crlf : {false, true}) {
    LineReader r;
    CHECK(bytes(r, crlf ? "CMD:STATUS\r" : "CMD:STATUS", 10) == FrameResult::None);
    CHECK(r.feed('\n', 2010) == FrameResult::Timeout);
    CHECK(std::string(r.line()).empty());
    goodNext(r, 2011); // timed-out LF itself finishes discard/resync
  }
  LineReader r;
  CHECK(bytes(r, "CMD:CHARGE:", 0) == FrameResult::None);
  CHECK(r.feed('O', 2000) == FrameResult::Timeout);
  CHECK(bytes(r, "NCMD:STATUS\n", 2001) == FrameResult::None);
  goodNext(r, 2002);
  LineReader idle;
  CHECK(idle.tick(100000) == FrameResult::None);
  goodNext(idle, 100000);
}
void concatenatedLines() {
  LineReader r;
  std::vector<CommandKind> commands;
  for (char c : std::string("CMD:CHARGE:ON\nCMD:CHARGE:OFF\r\nCMD:STATUS\n\n")) {
    auto result = r.feed(c, 0);
    if (result == FrameResult::Line) commands.push_back(parseCommand(r.line()).kind);
    else CHECK(result == FrameResult::None);
  }
  CHECK(commands == std::vector<CommandKind>({CommandKind::ChargeOn,
      CommandKind::ChargeOff, CommandKind::Status, CommandKind::Unknown}));
}
void validCommands() {
  for (auto pair : std::vector<std::pair<const char *, CommandKind>>{
      {"CMD:CHARGE:ON", CommandKind::ChargeOn},
      {"CMD:CHARGE:OFF", CommandKind::ChargeOff},
      {"CMD:STATUS", CommandKind::Status},
      {"CMD:RFID:ENROLL:START", CommandKind::EnrollStart},
      {"CMD:RFID:ENROLL:CANCEL", CommandKind::EnrollCancel}})
    CHECK(parseCommand(pair.first).kind == pair.second);
  for (uint8_t size : {uint8_t(4), uint8_t(7), uint8_t(10)}) {
    char text[30];
    auto u = uid(1, size);
    formatUid(u, text);
    auto c = parseCommand((std::string("CMD:RFID:REVOKE:") + text).c_str());
    CHECK(c.kind == CommandKind::Revoke && c.uid == u);
  }
  for (auto pair : std::vector<std::pair<const char *, BootMode>>{
      {"RESTORE", BootMode::Restore}, {"LOCKED", BootMode::Locked},
      {"UNLOCKED", BootMode::Unlocked}}) {
    auto c = parseCommand((std::string("CMD:ANTITHEFT:BOOT:") + pair.first).c_str());
    CHECK(c.kind == CommandKind::BootMode && c.mode == pair.second);
  }
}
void invalidCommandArguments() {
  for (const char *text : {"CMD:RFID:REVOKE:", "CMD:RFID:REVOKE:01:02:03",
      "CMD:RFID:REVOKE:01:02:03:04:05", "CMD:RFID:REVOKE:01:02:03:GG",
      "CMD:RFID:REVOKE:01:02:03:04 ", "CMD:RFID:REVOKE:01:02:03:04:extra",
      "CMD:ANTITHEFT:BOOT:", "CMD:ANTITHEFT:BOOT:locked",
      "CMD:ANTITHEFT:BOOT:UNLOCK", "CMD:ANTITHEFT:BOOT:LOCKED:extra",
      "CMD:ANTITHEFT:BOOT: RESTORE", "CMD:ANTITHEFT:BOOT:RESTORE "})
    CHECK(parseCommand(text).kind == CommandKind::Invalid);
}
void prefixMatchingAndNoUnlock() {
  CHECK(parseCommand(nullptr).kind == CommandKind::Unknown);
  for (const char *text : {"", "CMD", "cmd:STATUS", " CMD:STATUS", "CMD:STATUS ",
      "CMD:STATUS:extra", "CMD:CHARGE:ON:extra", "CMD:CHARGE:ONWARD",
      "CMD:CHARGE:OFFICE", "CMD:RFID:ENROLL:START:extra", "CMD:RFID:ENROLL",
      "CMD:RFID:ENROLL:CANCELLED", "CMD:RFID:REVOKE", "CMD:RFID:REVOKEX:01:02:03:04",
      "CMD:ANTITHEFT:BOOT", "CMD:ANTITHEFT:BOOTX:LOCKED", "CMD:ANTITHEFT:UNLOCK",
      "CMD:ANTITHEFT:LOCK", "CMD:SERVO:0", "CMD:UNLOCK"})
    CHECK(parseCommand(text).kind == CommandKind::Unknown);
}

} // namespace

int main() {
  const std::vector<std::pair<const char *, std::function<void()>>> cases = {
    {"missing initializes locked empty", missingInitializes},
    {"unavailable fails closed without overwrite", unavailableFailsClosed},
    {"storage adapter corrupt length or type", corruptStorageBoundary},
    {"whitelist denial and unchanged policy do not mutate", whitelistAndDenial},
    {"first fresh startup tap before debounce interval", startupGateFirstTap},
    {"debounce exact boundary and wrap", debounceBoundaries},
    {"enrollment expiry wrap and idempotent start", enrollmentWindow},
    {"enrollment card at exact expiry", enrollmentCardAtExpiry},
    {"enrollment exactly one cancel invalid and duplicate", enrollOneCancelDuplicate},
    {"full sixteen cards and revoke last", fullWhitelistAndRevokeLast},
    {"successful revoke cancels enrollment", revokeCancelsEnrollment},
    {"nonmember revoke cancels enrollment", deniedRevokeCancelsEnrollment},
    {"invalid UID revoke cancels enrollment", invalidRevokeCancelsEnrollment},
    {"persisted restore and forced boot policies", restartAndForcedPolicies},
    {"policy changes next boot only", policyOnlyChangesNextBoot},
    {"persist before acknowledged mutation", persistenceBeforeSuccess},
    {"persist before initial or forced boot target", bootPersistenceOrdering},
    {"every runtime mutation write failure", [] { failureMatrix(false); }},
    {"unknown runtime commit outcome and reboot", [] { failureMatrix(true); }},
    {"boot writes failure and unknown commit outcome", bootFailureMatrix},
    {"all UID lengths formatting and storage", uidLengthsAndFormatting},
    {"every invalid uint8 UID length cannot mutate", invalidUidLengthsCannotMutate},
    {"invalid UID text", invalidUidText},
    {"188 byte versioned record format", recordSizeAndFormat},
    {"CRC every record byte", crcCorruption},
    {"malformed length format duplicates and padding", malformedFormatAndPadding},
    {"presence exact removal and gap boundaries", presenceBoundaries},
    {"held boot preenroll and swapped cards", presenceHeldSwapAndPreEnroll},
    {"card and fault reset absence", presenceFaultAndCardReset},
    {"missing poll gap and clock wrap", presenceGapAndWrap},
    {"enrollment requires removal after previously armed gate", enrollmentRequiresNewRemoval},
    {"explicit requireRemoval resets partial absence and wraps", requireRemovalResetsPartialAbsence},
    {"frame exactly 192 and overflow", frameExactLimits},
    {"NUL controls nonASCII and printable ASCII", frameInvalidBytes},
    {"CRLF and interior CR", frameCrRules},
    {"absolute fragmented timeout and wrap", frameAbsoluteTimeout},
    {"timeout at delimiter suffix discard and resync", frameTimeoutAtDelimiterAndSuffix},
    {"concatenated LF CRLF and empty lines", concatenatedLines},
    {"exact old and new commands", validCommands},
    {"invalid command arguments", invalidCommandArguments},
    {"no prefix acceptance or direct UART unlock", prefixMatchingAndNoUnlock}
  };
  unsigned failed = 0;
  for (const auto &test : cases) {
    try {
      test.second();
      std::cout << "PASS " << test.first << '\n';
    } catch (const std::exception &error) {
      ++failed;
      std::cerr << "FAIL " << test.first << ": " << error.what() << '\n';
    } catch (...) {
      ++failed;
      std::cerr << "FAIL " << test.first << ": unknown exception\n";
    }
  }
  std::cout << cases.size() << " cases, " << failed << " failed\n";
  return failed ? 1 : 0;
}
