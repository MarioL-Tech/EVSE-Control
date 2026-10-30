#include "write_core.hpp"

#include <cstring>
#include <iostream>
#include <limits>
#include <memory>
#include <stdexcept>
#include <type_traits>

namespace {
using namespace wallbox;
using namespace std::chrono;

void check(bool condition, const char *message) {
    if (!condition) throw std::runtime_error(message);
}

void unsent(const WriteResult &result, WriteStatus status, const char *reason) {
    check(result.status == status, "unexpected denial status");
    check(result.reason && std::strcmp(result.reason, reason) == 0, "unexpected denial reason");
    check(!result.attempted && !result.acknowledged, "denied request entered write call");
    check(result.transport_errno == 0, "validation denial has transport error");
    check(!result.hardware_max_ma && !result.effective_current_ma &&
          !result.charging_state_raw && !result.charging_observed,
          "denied request invented a device observation");
}

constexpr WriteOperation operations[] = {
    WriteOperation::SetCurrent, WriteOperation::Start, WriteOperation::Stop
};

WriteRequest request(WriteOperation operation, WriteClock::time_point deadline) {
    return {operation, operation == WriteOperation::Stop ? 0U : 6000U, deadline};
}

void test_words_and_names() {
    struct Words { std::uint32_t value; std::uint16_t high; std::uint16_t low; };
    for (const auto &entry : {Words{0, 0, 0}, Words{6000, 0, 0x1770},
         Words{10000, 0, 0x2710}, Words{16000, 0, 0x3E80}, Words{32000, 0, 0x7D00},
         Words{65535, 0, 0xFFFF}, Words{65536, 1, 0},
         Words{0x1234ABCDU, 0x1234, 0xABCD}, Words{0x80000001U, 0x8000, 1},
         Words{0xFFFFFFFFU, 0xFFFF, 0xFFFF}}) {
        const auto words = current_register_words(entry.value);
        check(words[0] == entry.high && words[1] == entry.low,
              "current encoder truncated or reversed 32-bit words");
    }
    struct Name { WriteStatus status; const char *name; };
    for (const auto &entry : {
         Name{WriteStatus::Disabled, "disabled"},
         Name{WriteStatus::InvalidRequest, "invalid_request"},
         Name{WriteStatus::ExpiredNotSent, "expired_not_sent"},
         Name{WriteStatus::CancelledNotSent, "cancelled_not_sent"},
         Name{WriteStatus::WrongThread, "wrong_thread"},
         Name{WriteStatus::NotConnected, "not_connected"},
         Name{WriteStatus::PreflightFailedNotSent, "preflight_failed_not_sent"},
         Name{WriteStatus::PreparationRequired, "preparation_required"},
         Name{WriteStatus::RecoveryRequired, "recovery_required"},
         Name{WriteStatus::Acknowledged, "acknowledged"},
         Name{WriteStatus::RejectedByDevice, "rejected_by_device"},
         Name{WriteStatus::OutcomeUnknown, "outcome_unknown"}}) {
        const char *name = write_status_name(entry.status);
        check(name && std::strcmp(name, entry.name) == 0, "status label mismatch");
    }
    check(std::strcmp(write_status_name(static_cast<WriteStatus>(-1)), "invalid_request") == 0,
          "unknown status must have safe fixed label");
}

// Every context here is either null or allocated-but-unconnected. No connect,
// socket injection, device access, or positive wire exchange belongs in this test.
void test_validation(modbus_t *context) {
    std::atomic_bool cancelled{false};
    const auto now = WriteClock::time_point{} + seconds(100);
    const auto future = now + seconds(1);
    WriteCore core(context, {true, 32000}, cancelled, [=] { return now; });

    unsent(core.execute({static_cast<WriteOperation>(-1), 6000, future}),
           WriteStatus::InvalidRequest, "invalid_operation");
    unsent(core.execute({static_cast<WriteOperation>(99), 0, future}),
           WriteStatus::InvalidRequest, "invalid_operation");
    for (const auto op : operations) {
        for (const auto limit : {0U, 1U, 5999U, 32001U, 65536U,
                                std::numeric_limits<std::uint32_t>::max()}) {
            WriteCore bad_policy(context, {true, limit}, cancelled, [=] { return now; });
            unsent(bad_policy.execute(request(op, future)), WriteStatus::InvalidRequest,
                   "explicit_installation_limit_required");
        }
        for (const auto limit : {6000U, 16000U, 32000U}) {
            WriteCore bounded(context, {true, limit}, cancelled, [=] { return now; });
            unsent(bounded.execute(request(op, future)), WriteStatus::NotConnected,
                   "connected_context_required");
            if (op != WriteOperation::Stop) {
                unsent(bounded.execute({op, limit, future}), WriteStatus::NotConnected,
                       "connected_context_required");
                unsent(bounded.execute({op, limit + 1, future}), WriteStatus::InvalidRequest,
                       "invalid_current");
            }
        }
        for (const auto current : {0U, 1U, 5999U, 32001U, 65536U, 0x80000000U,
                                  std::numeric_limits<std::uint32_t>::max()}) {
            if (op == WriteOperation::Stop && current == 0) continue;
            unsent(core.execute({op, current, future}), WriteStatus::InvalidRequest,
                   "invalid_current");
        }
        if (op == WriteOperation::Stop) {
            for (const auto current : {6000U, 16000U, 32000U})
                unsent(core.execute({op, current, future}), WriteStatus::InvalidRequest,
                       "invalid_current");
        }
        for (const auto deadline : {WriteClock::time_point{}, now - WriteClock::duration{1}, now})
            unsent(core.execute(request(op, deadline)), WriteStatus::ExpiredNotSent,
                   "deadline_elapsed");
        for (const auto deadline : {now + WriteClock::duration{1}, now + microseconds(1),
                                   future, now + maximum_write_lifetime})
            unsent(core.execute(request(op, deadline)), WriteStatus::NotConnected,
                   "connected_context_required");
        unsent(core.execute(request(op, now + maximum_write_lifetime + WriteClock::duration{1})),
               WriteStatus::InvalidRequest, "deadline_too_distant");
        unsent(core.execute(request(op, WriteClock::time_point::max())),
               WriteStatus::InvalidRequest, "deadline_too_distant");
        cancelled.store(true);
        unsent(core.execute(request(op, future)), WriteStatus::CancelledNotSent,
               "shutdown_requested");
        cancelled.store(false);
        unsent(core.execute(request(op, future)), WriteStatus::NotConnected,
               "connected_context_required");
    }
    unsent(core.execute(WriteRequest{}), WriteStatus::ExpiredNotSent, "deadline_elapsed");
    const auto almost_max = WriteClock::time_point::max() - seconds(1);
    WriteCore overflow(context, {true, 32000}, cancelled, [=] { return almost_max; });
    unsent(overflow.execute(request(WriteOperation::Stop, WriteClock::time_point::max())),
           WriteStatus::InvalidRequest, "deadline_too_distant");
}

void test_thread_latch_and_disabled(modbus_t *context) {
    std::atomic_bool cancelled{false};
    const auto now = WriteClock::time_point{} + seconds(100);
    const auto valid = request(WriteOperation::Stop, now + seconds(1));
    WriteCore core(context, {true, 32000}, cancelled, [=] { return now; });
    WriteResult foreign;
    std::thread other([&] {
        core.invalidate_session(); // Wrong-thread invalidation must not mutate owner state.
        foreign = core.execute(valid);
    });
    other.join();
    unsent(foreign, WriteStatus::WrongThread, "owner_thread_required");
    unsent(core.execute(valid), WriteStatus::NotConnected, "connected_context_required");
    core.invalidate_session();
    core.invalidate_session();
    for (const auto op : operations)
        unsent(core.execute(request(op, valid.deadline)), WriteStatus::RecoveryRequired,
               "new_session_required");
    cancelled.store(true);
    unsent(core.execute({}), WriteStatus::RecoveryRequired, "new_session_required");
    cancelled.store(false);
    WriteCore rebuilt(context, {true, 32000}, cancelled, [=] { return now; });
    unsent(rebuilt.execute(valid), WriteStatus::NotConnected, "connected_context_required");

    const WritePolicy defaults{};
    check(!defaults.enabled && defaults.installation_max_ma == 0,
          "write policy must default disabled without guessed installation limit");
    for (const auto policy : {defaults, WritePolicy{false, 32000}}) {
        unsigned clock_calls = 0;
        WriteCore disabled(context, policy, cancelled, [&] { ++clock_calls; return now; });
        for (const auto op : operations)
            unsent(disabled.execute(request(op, valid.deadline)), WriteStatus::Disabled,
                   "writes_disabled");
        disabled.invalidate_session();
        cancelled.store(true);
        unsent(disabled.execute({static_cast<WriteOperation>(99), 0xFFFFFFFFU, {}}),
               WriteStatus::Disabled, "writes_disabled");
        std::thread worker([&] { foreign = disabled.execute({}); });
        worker.join();
        unsent(foreign, WriteStatus::Disabled, "writes_disabled");
        check(clock_calls == 0, "disabled core must not even consult clock");
        cancelled.store(false);
    }
    // Exercise the default injected-clock argument, still without any I/O.
    WriteCore real_clock(context, defaults, cancelled);
    unsent(real_clock.execute({}), WriteStatus::Disabled, "writes_disabled");
}

void test() {
    static_assert(!std::is_copy_constructible<WriteCore>::value, "core cannot be copied");
    static_assert(!std::is_copy_assignable<WriteCore>::value, "core cannot be assigned");
    check(minimum_write_current_ma == 6000 && maximum_write_current_ma == 32000 &&
          maximum_write_lifetime == seconds(10), "conservative safety constants changed");
    test_words_and_names();
    test_validation(nullptr);
    test_thread_latch_and_disabled(nullptr);

    std::unique_ptr<modbus_t, decltype(&modbus_free)> context(
        modbus_new_rtu("/nonexistent-evse-write-core-test/no-device", 57600, 'E', 8, 1),
        &modbus_free);
    check(context != nullptr, "synthetic RTU context allocation failed");
    check(modbus_set_slave(context.get(), 9) == 0, "synthetic slave configuration failed");
    check(modbus_set_response_timeout(context.get(), 2, 123456) == 0 &&
          modbus_set_byte_timeout(context.get(), 0, 654321) == 0,
          "synthetic timeout configuration failed");
    check(modbus_get_socket(context.get()) == -1, "allocated context unexpectedly connected");
    test_validation(context.get());
    test_thread_latch_and_disabled(context.get());
    // All borrowed cores are now destroyed; the caller must still own this context.
    check(modbus_get_socket(context.get()) == -1 && modbus_get_slave(context.get()) == 9,
          "core opened or changed borrowed context");
    std::uint32_t seconds_part = 0, micros_part = 0;
    check(modbus_get_response_timeout(context.get(), &seconds_part, &micros_part) == 0 &&
          seconds_part == 2 && micros_part == 123456, "denial changed response timeout");
    check(modbus_get_byte_timeout(context.get(), &seconds_part, &micros_part) == 0 &&
          seconds_part == 0 && micros_part == 654321, "denial changed byte timeout");
}
} // namespace

int main() {
    try {
        test();
        std::cout << "All wallbox write-core no-I/O tests passed\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
