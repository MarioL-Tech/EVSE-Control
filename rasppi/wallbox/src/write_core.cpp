#include "write_core.hpp"
#include "telemetry.hpp"

#include <algorithm>
#include <cerrno>
#include <utility>

namespace wallbox {
namespace {

std::uint32_t pair_value(const std::uint16_t *words) {
    return (static_cast<std::uint32_t>(words[0]) << 16) | words[1];
}

class TimeoutScope {
public:
    explicit TimeoutScope(modbus_t *context) : context_(context) {
        valid_ = modbus_get_response_timeout(context_, &response_s_, &response_us_) == 0 &&
                 modbus_get_byte_timeout(context_, &byte_s_, &byte_us_) == 0;
    }
    ~TimeoutScope() {
        if (valid_) {
            (void)modbus_set_response_timeout(context_, response_s_, response_us_);
            (void)modbus_set_byte_timeout(context_, byte_s_, byte_us_);
        }
    }
    bool configure(WriteClock::duration remaining) const {
        if (!valid_ || remaining <= WriteClock::duration::zero()) return false;
        const auto available = std::chrono::duration_cast<std::chrono::microseconds>(remaining).count();
        const auto original = static_cast<std::int64_t>(response_s_) * 1000000 + response_us_;
        const auto budget = std::min(original, available);
        if (budget <= 0) return false;
        return modbus_set_byte_timeout(context_, 0, 0) == 0 &&
               modbus_set_response_timeout(context_, static_cast<std::uint32_t>(budget / 1000000),
                                            static_cast<std::uint32_t>(budget % 1000000)) == 0 &&
               modbus_set_error_recovery(context_, MODBUS_ERROR_RECOVERY_NONE) == 0;
    }
private:
    modbus_t *context_;
    std::uint32_t response_s_ = 0, response_us_ = 0, byte_s_ = 0, byte_us_ = 0;
    bool valid_ = false;
};

} // namespace

std::array<std::uint16_t, 2> current_register_words(std::uint32_t milliamps) noexcept {
    return {static_cast<std::uint16_t>(milliamps >> 16),
            static_cast<std::uint16_t>(milliamps & 0xFFFFU)};
}

const char *write_status_name(WriteStatus status) noexcept {
    switch (status) {
    case WriteStatus::Disabled: return "disabled";
    case WriteStatus::InvalidRequest: return "invalid_request";
    case WriteStatus::ExpiredNotSent: return "expired_not_sent";
    case WriteStatus::CancelledNotSent: return "cancelled_not_sent";
    case WriteStatus::WrongThread: return "wrong_thread";
    case WriteStatus::NotConnected: return "not_connected";
    case WriteStatus::PreflightFailedNotSent: return "preflight_failed_not_sent";
    case WriteStatus::PreparationRequired: return "preparation_required";
    case WriteStatus::RecoveryRequired: return "recovery_required";
    case WriteStatus::Acknowledged: return "acknowledged";
    case WriteStatus::RejectedByDevice: return "rejected_by_device";
    case WriteStatus::OutcomeUnknown: return "outcome_unknown";
    }
    return "invalid_request";
}

WriteCore::WriteCore(modbus_t *context, WritePolicy policy, const std::atomic_bool &cancelled,
                     Now now, std::function<bool()> session_cancelled)
    : context_(context), policy_(policy), cancelled_(cancelled), now_(std::move(now)),
      session_cancelled_(std::move(session_cancelled)),
      owner_(std::this_thread::get_id()) {}

void WriteCore::invalidate_session() noexcept {
    // No concurrent mutation by an accidental MQTT/HTTP callback thread.
    if (std::this_thread::get_id() != owner_) return;
    prepared_current_ma_.reset();
    recovery_required_ = true;
}

WriteResult WriteCore::execute(const WriteRequest &request) {
    WriteResult result;
    const auto deny = [&](WriteStatus status, const char *reason) {
        result.status = status;
        result.reason = reason;
        return result;
    };
    if (!policy_.enabled) return deny(WriteStatus::Disabled, "writes_disabled");
    if (std::this_thread::get_id() != owner_)
        return deny(WriteStatus::WrongThread, "owner_thread_required");
    if (recovery_required_) return deny(WriteStatus::RecoveryRequired, "new_session_required");
    if (request.operation != WriteOperation::SetCurrent && request.operation != WriteOperation::Start &&
        request.operation != WriteOperation::Stop)
        return deny(WriteStatus::InvalidRequest, "invalid_operation");
    // Every recognized owner-thread attempt revokes the preceding preparation,
    // including malformed replacement limits, expired requests and mismatches.
    // Keep only a local one-shot copy for validating THIS Start.
    const auto prepared_current = std::exchange(prepared_current_ma_, std::nullopt);
    const auto prepared_until = std::exchange(prepared_until_, WriteClock::time_point{});
    if (request.operation != WriteOperation::Stop &&
        (policy_.installation_max_ma < minimum_write_current_ma ||
         policy_.installation_max_ma > maximum_write_current_ma))
        return deny(WriteStatus::InvalidRequest, "explicit_installation_limit_required");
    if ((request.operation == WriteOperation::Stop && request.current_ma != 0) ||
        (request.operation != WriteOperation::Stop &&
         (request.current_ma < minimum_write_current_ma || request.current_ma > policy_.installation_max_ma)))
        return deny(WriteStatus::InvalidRequest, "invalid_current");
    const auto initial = now_();
    if (request.deadline <= initial)
        return deny(WriteStatus::ExpiredNotSent, "deadline_elapsed");
    if (initial > WriteClock::time_point::max() - maximum_write_lifetime ||
        request.deadline > initial + maximum_write_lifetime)
        return deny(WriteStatus::InvalidRequest, "deadline_too_distant");
    if (cancelled_.load(std::memory_order_relaxed) || session_cancelled_())
        return deny(WriteStatus::CancelledNotSent, "shutdown_requested");
    if (!context_ || modbus_get_socket(context_) < 0)
        return deny(WriteStatus::NotConnected, "connected_context_required");
    const int slave = modbus_get_slave(context_);
    if (modbus_get_header_length(context_) != 1 || slave < 1 || slave > 247)
        return deny(WriteStatus::InvalidRequest, "unicast_rtu_context_required");
    if (request.operation == WriteOperation::Start &&
        (!prepared_current || *prepared_current != request.current_ma || prepared_until <= initial))
        return deny(WriteStatus::PreparationRequired, "fresh_limit_ack_required");
    const auto transaction_deadline = request.operation == WriteOperation::Start
        ? std::min(request.deadline, prepared_until) : request.deadline;

    TimeoutScope timeout(context_);
    const auto ready = [&]() {
        const bool cancelled = cancelled_.load(std::memory_order_relaxed) || session_cancelled_();
        const auto now = now_();
        if (cancelled || transaction_deadline <= now ||
            std::chrono::duration_cast<std::chrono::microseconds>(transaction_deadline - now).count() <= 0) {
            if (!result.attempted) {
                const bool preparation_expired = request.operation == WriteOperation::Start &&
                                                 prepared_until <= request.deadline;
                result.status = cancelled ? WriteStatus::CancelledNotSent :
                    (preparation_expired ? WriteStatus::PreparationRequired : WriteStatus::ExpiredNotSent);
                result.reason = cancelled ? "shutdown_requested" :
                    (preparation_expired ? "fresh_limit_ack_required" : "deadline_elapsed");
            } else {
                // A received ACK remains an ACK, even if cancellation/deadline
                // prevents subsequent observation. Never report this as unsent.
                result.reason = cancelled ? "cancelled_after_ack" : "deadline_after_ack";
            }
            return false;
        }
        if (!timeout.configure(transaction_deadline - now)) {
            if (!result.attempted) result.status = WriteStatus::PreflightFailedNotSent;
            result.reason = "timeout_configuration_failed";
            result.transport_errno = errno;
            invalidate_session();
            return false;
        }
        return true;
    };
    const auto read = [&](int address, int count, std::uint16_t *words) {
        if (!ready()) return false;
        const int received = modbus_read_registers(context_, address, count, words);
        if (received == count) return true;
        result.transport_errno = received == -1 ? errno : EMBBADDATA;
        if (!result.attempted) result.status = WriteStatus::PreflightFailedNotSent;
        result.reason = "observation_read_failed";
        invalidate_session();
        return false;
    };

    if (request.operation != WriteOperation::Stop) {
        std::array<std::uint16_t, 2> hardware{};
        if (!read(0x4006, 2, hardware.data())) return result;
        result.hardware_max_ma = pair_value(hardware.data());
        if (*result.hardware_max_ma < minimum_write_current_ma ||
            *result.hardware_max_ma > maximum_write_current_ma)
            return deny(WriteStatus::PreflightFailedNotSent, "invalid_hardware_limit");
        if (request.current_ma > *result.hardware_max_ma)
            return deny(WriteStatus::PreflightFailedNotSent, "above_hardware_limit");
        if (request.operation == WriteOperation::Start) {
            Registers registers{};
            if (!read(first_register, register_count, registers.data())) return result;
            const auto telemetry = decode(registers);
            if (telemetry.error_code != 0)
                return deny(WriteStatus::PreflightFailedNotSent, "active_wallbox_fault");
            if (telemetry.charging_state > 4)
                return deny(WriteStatus::PreflightFailedNotSent, "charging_state_unknown");
            result.effective_current_ma = pair_value(registers.data() + 6);
            if (*result.effective_current_ma > request.current_ma)
                return deny(WriteStatus::PreflightFailedNotSent, "effective_limit_above_request");
        }
    }
    if (!ready()) return result;
    // libmodbus 3.1.6 high-level write calls do NOT verify the echoed address or
    // FC06 value. Use its raw send/receive APIs (library framing, CRC, deadlines),
    // and additionally require the complete matching unicast RTU confirmation.
    // Exactly ONE send call; NONE recovery prevents silent resend/reconnect.
    const auto words = current_register_words(request.current_ma);
    const bool current = request.operation == WriteOperation::SetCurrent;
    const auto function = static_cast<std::uint8_t>(current ? 0x10 : 0x06);
    const auto argument = static_cast<std::uint8_t>(current ? 2 : (request.operation == WriteOperation::Start ? 0 : 1));
    const std::array<std::uint8_t, 11> frame{
        static_cast<std::uint8_t>(slave), function, 0x41, static_cast<std::uint8_t>(current ? 0 : 5), 0, argument,
        4, static_cast<std::uint8_t>(words[0] >> 8), static_cast<std::uint8_t>(words[0]),
        static_cast<std::uint8_t>(words[1] >> 8), static_cast<std::uint8_t>(words[1])};
    const int request_size = current ? 11 : 6;
    result.attempted = true;
    const int sent = modbus_send_raw_request(context_, frame.data(), request_size);
    int io_error = sent == -1 ? errno : EMBBADDATA;
    std::array<std::uint8_t, MODBUS_MAX_ADU_LENGTH> response{};
    int received = -1;
    if (sent == request_size + 2) {
        // Account for time already spent sending. A write that has crossed its
        // deadline is UNKNOWN, not unsent; do not grant a new response budget.
        const auto remaining = transaction_deadline - now_();
        if (timeout.configure(remaining)) {
            received = modbus_receive_confirmation(context_, response.data());
            io_error = received == -1 ? errno : EMBBADDATA;
        } else {
            io_error = ETIMEDOUT;
        }
    }
    if (sent != request_size + 2 || received != 8 ||
        !std::equal(frame.begin(), frame.begin() + 6, response.begin())) {
        result.transport_errno = io_error;
        result.status = WriteStatus::OutcomeUnknown;
        result.reason = "write_outcome_unknown";
        if (sent == request_size + 2 && received == 5 && response[0] == slave &&
            response[1] == static_cast<std::uint8_t>(function | 0x80U) &&
            response[2] >= 1 && response[2] <= 11 && response[2] != 9) {
            result.transport_errno = MODBUS_ENOBASE + response[2];
            // ACK(5) means accepted/processing, not rejected! Server failures,
            // busy/gateway failures also do not prove the write had no effect.
            if (response[2] <= 3) result.status = WriteStatus::RejectedByDevice;
            result.reason = "device_exception";
        }
        invalidate_session();
        return result; // No retry, reconnect, compensating write or unsafe immediate readback.
    }
    result.status = WriteStatus::Acknowledged;
    result.reason = "protocol_ack_only";
    result.acknowledged = true;
    std::array<std::uint16_t, 2> observation{};
    if (request.operation == WriteOperation::SetCurrent) {
        if (!read(0x400E, 2, observation.data())) return result;
        result.effective_current_ma = pair_value(observation.data());
        if (!ready()) return result;
        if (*result.effective_current_ma > request.current_ma) {
            result.reason = "effective_limit_above_request";
        } else {
            // A lower value (including zero) may be internal load management;
            // it is an observation, never an echo of the write-only setpoint.
            prepared_current_ma_ = request.current_ma;
            prepared_until_ = request.deadline;
        }
    } else {
        if (!read(0x400C, 2, observation.data())) return result;
        result.charging_state_raw = pair_value(observation.data());
        const auto state = (*result.charging_state_raw >> 8) & 0x7FU;
        if (state <= 4) result.charging_observed = state == 4;
        else result.reason = "charging_state_unknown";
    }
    return result;
}

} // namespace wallbox
