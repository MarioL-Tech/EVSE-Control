#include "security.h"

#include <cstring>

namespace evse {
namespace {
int nibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}
uint32_t checksum(const Blob &blob) {
  uint32_t crc = 0xffffffffU;
  for (std::size_t i = 0; i < RECORD_SIZE - 4; ++i) {
    crc ^= blob[i];
    for (unsigned bit = 0; bit < 8; ++bit)
      crc = (crc >> 1) ^ ((crc & 1U) ? 0xedb88320U : 0U);
  }
  return ~crc;
}
bool validRecord(const Record &record) {
  if (static_cast<uint8_t>(record.mode) > 2 || record.count > MAX_CARDS) return false;
  for (std::size_t i = 0; i < record.count; ++i) {
    if (!record.cards[i].valid()) return false;
    for (std::size_t j = 0; j < i; ++j)
      if (record.cards[i] == record.cards[j]) return false;
  }
  return true;
}
} // namespace

bool Uid::valid() const { return size == 4 || size == 7 || size == 10; }
bool Uid::operator==(const Uid &other) const {
  return valid() && other.valid() && size == other.size &&
         std::memcmp(bytes.data(), other.bytes.data(), size) == 0;
}
bool parseUid(const char *text, Uid &uid) {
  uid = Uid{};
  if (!text) return false;
  const std::size_t length = std::strlen(text);
  if (length != 11 && length != 20 && length != 29) return false;
  Uid candidate;
  candidate.size = static_cast<uint8_t>((length + 1) / 3);
  for (std::size_t i = 0; i < candidate.size; ++i) {
    const int high = nibble(text[i * 3]), low = nibble(text[i * 3 + 1]);
    if (high < 0 || low < 0 || (i + 1 < candidate.size && text[i * 3 + 2] != ':'))
      return false;
    candidate.bytes[i] = static_cast<uint8_t>((high << 4) | low);
  }
  uid = candidate;
  return true;
}
void formatUid(const Uid &uid, char (&text)[30]) {
  text[0] = '\0';
  if (!uid.valid()) return;
  constexpr char hex[] = "0123456789ABCDEF";
  std::size_t at = 0;
  for (std::size_t i = 0; i < uid.size; ++i) {
    if (i) text[at++] = ':';
    text[at++] = hex[uid.bytes[i] >> 4];
    text[at++] = hex[uid.bytes[i] & 15];
  }
  text[at] = '\0';
}
const char *modeName(BootMode mode) {
  switch (mode) {
    case BootMode::Restore: return "RESTORE";
    case BootMode::Locked: return "LOCKED";
    case BootMode::Unlocked: return "UNLOCKED";
  }
  return "INVALID";
}
Blob encode(const Record &record) {
  Blob blob{};
  blob[0] = 'E'; blob[1] = 'V'; blob[2] = 'S'; blob[3] = '1';
  blob[4] = 1; blob[5] = static_cast<uint8_t>(record.mode);
  blob[6] = record.locked ? 1 : 0; blob[7] = record.count;
  for (std::size_t i = 0; i < record.count && i < MAX_CARDS; ++i) {
    const auto &uid = record.cards[i];
    const auto offset = 8 + i * 11;
    blob[offset] = uid.size;
    if (uid.valid()) std::memcpy(&blob[offset + 1], uid.bytes.data(), uid.size);
  }
  const uint32_t crc = checksum(blob);
  for (unsigned i = 0; i < 4; ++i)
    blob[RECORD_SIZE - 4 + i] = static_cast<uint8_t>(crc >> (i * 8));
  return blob;
}
bool decode(const Blob &blob, Record &record) {
  if (std::memcmp(blob.data(), "EVS1", 4) != 0 || blob[4] != 1 ||
      blob[5] > 2 || blob[6] > 1 || blob[7] > MAX_CARDS) return false;
  uint32_t stored = 0;
  for (unsigned i = 0; i < 4; ++i)
    stored |= static_cast<uint32_t>(blob[RECORD_SIZE - 4 + i]) << (i * 8);
  if (stored != checksum(blob)) return false;
  Record candidate;
  candidate.mode = static_cast<BootMode>(blob[5]);
  candidate.locked = blob[6] != 0;
  candidate.count = blob[7];
  for (std::size_t i = 0; i < MAX_CARDS; ++i) {
    const auto offset = 8 + i * 11;
    auto &uid = candidate.cards[i];
    uid.size = blob[offset];
    if (i < candidate.count) {
      if (!uid.valid()) return false;
      std::memcpy(uid.bytes.data(), &blob[offset + 1], uid.size);
    } else if (uid.size != 0) return false;
    for (std::size_t j = i < candidate.count ? uid.size : 0; j < 10; ++j)
      if (blob[offset + 1 + j] != 0) return false;
  }
  if (!validRecord(candidate)) return false;
  record = candidate;
  return true;
}
const char *faultName(Fault fault) {
  switch (fault) {
    case Fault::None: return "NONE";
    case Fault::Unavailable: return "UNAVAILABLE";
    case Fault::Corrupt: return "CORRUPT";
    case Fault::Write: return "WRITE";
  }
  return "INVALID";
}
const char *resultName(Result result) {
  switch (result) {
    case Result::Ok: return "OK";
    case Result::NotReady: return "NOT_READY";
    case Result::StorageError: return "STORAGE_ERROR";
    case Result::InvalidUid: return "INVALID_UID";
    case Result::InvalidArgument: return "INVALID_ARGUMENT";
    case Result::Full: return "FULL";
    case Result::AlreadyAllowed: return "ALREADY_ALLOWED";
    case Result::EnrollStarted: return "ENROLL_STARTED";
    case Result::EnrollActive: return "ENROLL_ACTIVE";
    case Result::EnrollCancelled: return "ENROLL_CANCELLED";
    case Result::EnrollInactive: return "ENROLL_INACTIVE";
    case Result::EnrollExpired: return "ENROLL_EXPIRED";
    case Result::Enrolled: return "ENROLLED";
    case Result::Revoked: return "REVOKED";
    case Result::NotFound: return "NOT_FOUND";
    case Result::Denied: return "DENIED";
    case Result::Debounced: return "DEBOUNCED";
    case Result::Locked: return "LOCKED";
    case Result::Unlocked: return "UNLOCKED";
    case Result::ModeChanged: return "MODE_CHANGED";
  }
  return "INVALID";
}
bool Security::begin() {
  record_ = Record{};
  enrolling_ = false; hasAction_ = false; started_ = true;
  Blob blob{};
  const LoadResult result = storage_.load(blob);
  if (result == LoadResult::Error) { fault_ = Fault::Unavailable; return false; }
  if (result == LoadResult::Corrupt) { fault_ = Fault::Corrupt; return false; }
  if (result == LoadResult::Found && !decode(blob, record_)) {
    fault_ = Fault::Corrupt; return false;
  }
  fault_ = Fault::None;
  Record desired = record_;
  if (desired.mode == BootMode::Locked) desired.locked = true;
  if (desired.mode == BootMode::Unlocked) desired.locked = false;
  if (result == LoadResult::Missing || desired.locked != record_.locked) {
    if (!commit(desired)) { record_.locked = true; return false; }
  }
  return true;
}
bool Security::commit(const Record &candidate) {
  if (!storage_.save(encode(candidate))) {
    fault_ = Fault::Write;
    enrolling_ = false;
    record_.locked = true; // emergency target, not a claim of successful persistence
    return false;
  }
  record_ = candidate;
  return true;
}
bool Security::allowed(const Uid &uid) const {
  if (!ready() || !uid.valid()) return false;
  for (std::size_t i = 0; i < record_.count; ++i)
    if (record_.cards[i] == uid) return true;
  return false;
}
Result Security::tick(uint32_t now) {
  if (enrolling_ && now - enrollmentStart_ >= ENROLL_MS) {
    enrolling_ = false;
    return Result::EnrollExpired;
  }
  return Result::Ok;
}
Result Security::startEnrollment(uint32_t now) {
  if (!ready()) return Result::NotReady;
  tick(now);
  if (enrolling_) return Result::EnrollActive; // repeated command cannot extend window
  if (record_.count >= MAX_CARDS) return Result::Full;
  enrollmentStart_ = now; enrolling_ = true;
  return Result::EnrollStarted;
}
Result Security::cancelEnrollment() {
  if (!enrolling_) return Result::EnrollInactive;
  enrolling_ = false;
  return Result::EnrollCancelled;
}
Result Security::card(const Uid &uid, uint32_t now) {
  if (!ready()) return Result::NotReady;
  if (!uid.valid()) return Result::InvalidUid;
  if (tick(now) == Result::EnrollExpired) return Result::EnrollExpired;
  if (enrolling_) {
    enrolling_ = false; // exactly one valid new presentation; never toggle during enrollment
    if (allowed(uid)) return Result::AlreadyAllowed;
    if (record_.count >= MAX_CARDS) return Result::Full;
    Record candidate = record_;
    candidate.cards[candidate.count++] = uid;
    return commit(candidate) ? Result::Enrolled : Result::StorageError;
  }
  if (!allowed(uid)) return Result::Denied;
  if (hasAction_ && now - lastAction_ < DEBOUNCE_MS) return Result::Debounced;
  Record candidate = record_;
  candidate.locked = !candidate.locked;
  if (!commit(candidate)) return Result::StorageError;
  hasAction_ = true; lastAction_ = now;
  return record_.locked ? Result::Locked : Result::Unlocked;
}
Result Security::revoke(const Uid &uid) {
  enrolling_ = false; // a revoke attempt cannot leave a pending admission window open
  if (!ready()) return Result::NotReady;
  if (!uid.valid()) return Result::InvalidUid;
  std::size_t index = 0;
  while (index < record_.count && !(record_.cards[index] == uid)) ++index;
  if (index == record_.count) return Result::NotFound;
  Record candidate = record_;
  for (std::size_t i = index; i + 1 < candidate.count; ++i)
    candidate.cards[i] = candidate.cards[i + 1];
  candidate.cards[--candidate.count] = Uid{};
  if (!commit(candidate)) return Result::StorageError;
  return Result::Revoked;
}
Result Security::setBootMode(BootMode mode) {
  if (!ready()) return Result::NotReady;
  if (static_cast<uint8_t>(mode) > 2) return Result::InvalidArgument;
  if (mode == record_.mode) return Result::Ok;
  Record candidate = record_;
  candidate.mode = mode;
  return commit(candidate) ? Result::ModeChanged : Result::StorageError;
}
bool Presence::observe(Observation observation, uint32_t now) {
  if (polled_ && now - lastPoll_ > MAX_POLL_GAP_MS) missing_ = false;
  polled_ = true; lastPoll_ = now;
  if (observation == Observation::Card) {
    const bool fresh = !occupied_;
    occupied_ = true; missing_ = false;
    return fresh;
  }
  if (observation == Observation::Fault) {
    occupied_ = true; missing_ = false;
    return false;
  }
  if (!missing_) { missing_ = true; missingSince_ = now; }
  if (now - missingSince_ >= REMOVAL_MS) occupied_ = false;
  return false;
}
} // namespace evse
