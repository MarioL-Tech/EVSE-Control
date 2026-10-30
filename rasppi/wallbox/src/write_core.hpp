#pragma once

#include <modbus.h>

#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <optional>
#include <thread>

namespace wallbox {

using WriteClock = std::chrono::steady_clock;
constexpr std::uint32_t minimum_write_current_ma = 6000;
// Conservative application ceiling, NOT an installation/current authorization.
// A lower explicit installation limit AND fresh 0x4006 read remain mandatory.
constexpr std::uint32_t maximum_write_current_ma = 32000;
constexpr auto maximum_write_lifetime = std::chrono::seconds(10);

enum class WriteOperation { SetCurrent, Start, Stop };
struct WritePolicy {
    bool enabled = false;
    std::uint32_t installation_max_ma = 0; // No guessed installation default.
};
struct WriteRequest {
    WriteOperation operation = WriteOperation::Stop;
    std::uint32_t current_ma = 0; // Start must match a freshly prepared limit.
    WriteClock::time_point deadline{}; // Absolute, monotonic; default expired.
};
enum class WriteStatus {
    Disabled, InvalidRequest, ExpiredNotSent, CancelledNotSent, WrongThread,
    NotConnected, PreflightFailedNotSent, PreparationRequired, RecoveryRequired,
    Acknowledged, RejectedByDevice, OutcomeUnknown
};
const char *write_status_name(WriteStatus status) noexcept;

struct WriteResult {
    WriteStatus status = WriteStatus::InvalidRequest;
    const char *reason = "invalid_request"; // Fixed labels, never raw input/errors.
    bool attempted = false; // Entered write call; transmission/effect may be unknown.
    bool acknowledged = false; // Valid protocol ACK, NOT proof of physical charging.
    int transport_errno = 0;
    std::optional<std::uint32_t> hardware_max_ma;
    std::optional<std::uint32_t> effective_current_ma;
    std::optional<std::uint32_t> charging_state_raw;
    std::optional<bool> charging_observed;
};

std::array<std::uint16_t, 2> current_register_words(std::uint32_t milliamps) noexcept;

// Synchronous, thread-confined internal seam. The caller owns the ONE connected
// libmodbus context and must serialize polls/commands on that thread. This core
// never opens, closes, reconnects or queues a device. No arbitrary register API.
// Production wiring is permanently Disabled in stage 1; only build-stage tests
// supply an enabled policy, and their probe accepts only validated Linux PTYs.
class WriteCore {
public:
    using Now = std::function<WriteClock::time_point()>;
    WriteCore(modbus_t *context, WritePolicy policy, const std::atomic_bool &cancelled,
              Now now = [] { return WriteClock::now(); });
    WriteCore(const WriteCore &) = delete;
    WriteCore &operator=(const WriteCore &) = delete;
    WriteResult execute(const WriteRequest &request);
    // A read failure, disconnect, or unknown write invalidates preparation.
    // Recovery needs an explicitly rebuilt session/core, never an implicit retry.
    void invalidate_session() noexcept;

private:
    modbus_t *context_;
    const WritePolicy policy_;
    const std::atomic_bool &cancelled_;
    Now now_;
    const std::thread::id owner_;
    bool recovery_required_ = false;
    std::optional<std::uint32_t> prepared_current_ma_;
    WriteClock::time_point prepared_until_{};
};

} // namespace wallbox
