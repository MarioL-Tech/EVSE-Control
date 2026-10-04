#pragma once

#include "security.h"

namespace evse {
constexpr std::size_t LINE_MAX = 192;
constexpr uint32_t FRAME_MS = 2000;
enum class FrameResult { None, Line, TooLong, Invalid, Timeout };
class LineReader {
public:
  FrameResult feed(char byte, uint32_t now);
  FrameResult tick(uint32_t now);
  const char *line() const { return buffer_.data(); }
private:
  FrameResult discard(FrameResult reason);
  void reset();
  std::array<char, LINE_MAX + 1> buffer_{};
  std::size_t length_ = 0;
  bool started_ = false;
  bool discarding_ = false;
  bool cr_ = false;
  uint32_t start_ = 0;
};
enum class CommandKind {
  Unknown, Invalid, ChargeOn, ChargeOff, Status, EnrollStart, EnrollCancel,
  Revoke, BootMode
};
struct Command {
  CommandKind kind = CommandKind::Unknown;
  Uid uid{};
  evse::BootMode mode = evse::BootMode::Restore;
};
Command parseCommand(const char *line);
} // namespace evse
