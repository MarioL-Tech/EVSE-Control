#include "protocol.h"

#include <cstring>

namespace evse {
void LineReader::reset() {
  length_ = 0; started_ = false; discarding_ = false; cr_ = false;
}
FrameResult LineReader::discard(FrameResult reason) {
  length_ = 0; buffer_[0] = '\0';
  started_ = false; discarding_ = true; cr_ = false;
  return reason;
}
FrameResult LineReader::tick(uint32_t now) {
  if (started_ && now - start_ >= FRAME_MS) return discard(FrameResult::Timeout);
  return FrameResult::None;
}
FrameResult LineReader::feed(char byte, uint32_t now) {
  const auto expired = tick(now);
  if (discarding_) {
    if (byte == '\n') reset();
    return expired;
  }
  if (byte == '\n') {
    buffer_[length_] = '\0';
    reset();
    return FrameResult::Line;
  }
  if (!started_) { started_ = true; start_ = now; }
  if (cr_) return discard(FrameResult::Invalid);
  if (byte == '\r') { cr_ = true; return FrameResult::None; }
  const auto value = static_cast<unsigned char>(byte);
  if (value < 32 || value > 126) return discard(FrameResult::Invalid);
  if (length_ >= LINE_MAX) return discard(FrameResult::TooLong);
  buffer_[length_++] = byte;
  return FrameResult::None;
}
Command parseCommand(const char *line) {
  Command command;
  constexpr char revokePrefix[] = "CMD:RFID:REVOKE:";
  constexpr char bootPrefix[] = "CMD:ANTITHEFT:BOOT:";
  if (!line) return command;
  if (std::strcmp(line, "CMD:CHARGE:ON") == 0) command.kind = CommandKind::ChargeOn;
  else if (std::strcmp(line, "CMD:CHARGE:OFF") == 0) command.kind = CommandKind::ChargeOff;
  else if (std::strcmp(line, "CMD:STATUS") == 0) command.kind = CommandKind::Status;
  else if (std::strcmp(line, "CMD:RFID:ENROLL:START") == 0) command.kind = CommandKind::EnrollStart;
  else if (std::strcmp(line, "CMD:RFID:ENROLL:CANCEL") == 0) command.kind = CommandKind::EnrollCancel;
  else if (std::strncmp(line, revokePrefix, sizeof(revokePrefix) - 1) == 0) {
    command.kind = parseUid(line + sizeof(revokePrefix) - 1, command.uid) ? CommandKind::Revoke : CommandKind::Invalid;
  } else if (std::strncmp(line, bootPrefix, sizeof(bootPrefix) - 1) == 0) {
    const char *mode = line + sizeof(bootPrefix) - 1;
    command.kind = CommandKind::BootMode;
    if (std::strcmp(mode, "RESTORE") == 0) command.mode = BootMode::Restore;
    else if (std::strcmp(mode, "LOCKED") == 0) command.mode = BootMode::Locked;
    else if (std::strcmp(mode, "UNLOCKED") == 0) command.mode = BootMode::Unlocked;
    else command.kind = CommandKind::Invalid;
  }
  return command;
}
} // namespace evse
