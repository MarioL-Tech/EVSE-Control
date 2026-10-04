#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

namespace evse {
constexpr std::size_t MAX_CARDS = 16;
constexpr std::size_t RECORD_SIZE = 8 + MAX_CARDS * 11 + 4;
constexpr uint32_t ENROLL_MS = 30000;
constexpr uint32_t DEBOUNCE_MS = 800;
constexpr uint32_t REMOVAL_MS = 500;
constexpr uint32_t MAX_POLL_GAP_MS = 250;

enum class BootMode : uint8_t { Restore, Locked, Unlocked };
struct Uid {
  uint8_t size = 0;
  std::array<uint8_t, 10> bytes{};
  bool valid() const;
  bool operator==(const Uid &other) const;
};
bool parseUid(const char *text, Uid &uid);
void formatUid(const Uid &uid, char (&text)[30]);
const char *modeName(BootMode mode);

struct Record {
  BootMode mode = BootMode::Restore;
  bool locked = true;
  uint8_t count = 0;
  std::array<Uid, MAX_CARDS> cards{};
};
using Blob = std::array<uint8_t, RECORD_SIZE>;
Blob encode(const Record &record);
bool decode(const Blob &blob, Record &record);

enum class LoadResult { Found, Missing, Error, Corrupt };
class Storage {
public:
  virtual ~Storage() = default;
  virtual LoadResult load(Blob &blob) = 0;
  virtual bool save(const Blob &blob) = 0;
};
enum class Fault { None, Unavailable, Corrupt, Write };
enum class Result {
  Ok, NotReady, StorageError, InvalidUid, InvalidArgument, Full, AlreadyAllowed,
  EnrollStarted, EnrollActive, EnrollCancelled, EnrollInactive,
  EnrollExpired, Enrolled, Revoked, NotFound, Denied, Debounced,
  Locked, Unlocked, ModeChanged
};
const char *resultName(Result result);
const char *faultName(Fault fault);

class Security {
public:
  explicit Security(Storage &storage) : storage_(storage) {}
  bool begin();
  Result startEnrollment(uint32_t now);
  Result cancelEnrollment();
  Result tick(uint32_t now);
  Result card(const Uid &uid, uint32_t now);
  Result revoke(const Uid &uid);
  Result setBootMode(BootMode mode);
  bool ready() const { return fault_ == Fault::None && started_; }
  bool locked() const { return record_.locked; }
  BootMode mode() const { return record_.mode; }
  uint8_t count() const { return record_.count; }
  bool enrolling() const { return enrolling_; }
  Fault fault() const { return fault_; }
  bool allowed(const Uid &uid) const;
private:
  bool commit(const Record &candidate);
  Storage &storage_;
  Record record_{};
  Fault fault_ = Fault::Unavailable;
  bool started_ = false;
  bool enrolling_ = false;
  uint32_t enrollmentStart_ = 0;
  bool hasAction_ = false;
  uint32_t lastAction_ = 0;
};

// A timeout after WUPA is only a radio absence observation, not a physical sensor.
enum class Observation { Card, Absent, Fault };
class Presence {
public:
  bool observe(Observation observation, uint32_t now);
  void requireRemoval() { occupied_ = true; missing_ = false; }
private:
  bool occupied_ = true; // also require removal for a card lying on the reader at boot
  bool missing_ = false;
  bool polled_ = false;
  uint32_t missingSince_ = 0;
  uint32_t lastPoll_ = 0;
};
} // namespace evse
