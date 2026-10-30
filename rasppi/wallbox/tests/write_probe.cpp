// Test-build-only PTY probe. Never install/copy this executable into runtime.
#include "write_core.hpp"

#include <atomic>
#include <cerrno>
#include <csignal>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <iostream>
#include <linux/magic.h>
#include <memory>
#include <stdexcept>
#include <string>
#include <sys/stat.h>
#include <sys/vfs.h>
#include <unistd.h>

namespace {
std::atomic_bool cancelled{false};
static_assert(std::atomic_bool::is_always_lock_free, "signal flag must be lock-free");
void terminate(int) { cancelled.store(true, std::memory_order_relaxed); }

bool same_device(const struct stat &a, const struct stat &b) {
    return S_ISCHR(a.st_mode) && S_ISCHR(b.st_mode) && a.st_dev == b.st_dev &&
           a.st_ino == b.st_ino && a.st_rdev == b.st_rdev;
}

// Keep the validated identity open throughout the session, including recovery.
class Pty {
public:
    explicit Pty(const std::string &path) {
        const std::string prefix = "/dev/pts/";
        if (path.compare(0, prefix.size(), prefix) != 0 || path.size() == prefix.size() ||
            path.find_first_not_of("0123456789", prefix.size()) != std::string::npos)
            throw std::runtime_error("pty_path_required");
        char *resolved = ::realpath(path.c_str(), nullptr);
        const bool canonical = resolved && path == resolved;
        ::free(resolved);
        struct stat before{};
        if (!canonical || ::lstat(path.c_str(), &before) != 0 || !S_ISCHR(before.st_mode))
            throw std::runtime_error("canonical_pty_required");
        fd_ = ::open(path.c_str(), O_RDWR | O_NOCTTY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
        struct statfs filesystem{};
        if (fd_ < 0 || ::fstat(fd_, &identity_) != 0 || !same_device(before, identity_) ||
            ::fstatfs(fd_, &filesystem) != 0 || filesystem.f_type != DEVPTS_SUPER_MAGIC) {
            if (fd_ >= 0) ::close(fd_);
            fd_ = -1;
            throw std::runtime_error("devpts_identity_required");
        }
    }
    ~Pty() { if (fd_ >= 0) ::close(fd_); }
    bool matches(int fd) const {
        struct stat opened{};
        struct statfs filesystem{};
        return fd >= 0 && ::fstat(fd, &opened) == 0 && same_device(identity_, opened) &&
               ::fstatfs(fd, &filesystem) == 0 && filesystem.f_type == DEVPTS_SUPER_MAGIC;
    }
private:
    int fd_ = -1;
    struct stat identity_{};
};

struct ContextDeleter {
    void operator()(modbus_t *ctx) const { if (ctx) { modbus_close(ctx); modbus_free(ctx); } }
};
using Context = std::unique_ptr<modbus_t, ContextDeleter>;

void connect(modbus_t *ctx, const Pty &pty) {
    if (modbus_connect(ctx) != 0) throw std::runtime_error("pty_connect_failed");
    if (!pty.matches(modbus_get_socket(ctx))) throw std::runtime_error("opened_identity_mismatch");
    if (modbus_flush(ctx) < 0) throw std::runtime_error("pty_flush_failed");
}

template <typename T> void optional_number(const std::optional<T> &value) {
    if (value) std::cout << *value; else std::cout << "null";
}

void print(const char *stage, const wallbox::WriteResult &r, long long elapsed, modbus_t *ctx) {
    std::uint32_t seconds = 0, micros = 0, byte_seconds = 0, byte_micros = 0;
    if (modbus_get_response_timeout(ctx, &seconds, &micros) != 0 ||
        modbus_get_byte_timeout(ctx, &byte_seconds, &byte_micros) != 0)
        throw std::runtime_error("timeout_query_failed");
    std::cout << "{\"stage\":\"" << stage << "\",\"status\":\""
              << wallbox::write_status_name(r.status) << "\",\"reason\":\"" << r.reason
              << "\",\"attempted\":" << (r.attempted ? "true" : "false")
              << ",\"acknowledged\":" << (r.acknowledged ? "true" : "false")
              << ",\"elapsed_us\":" << elapsed << ",\"response_us\":"
              << (seconds * 1000000ULL + micros) << ",\"byte_us\":"
              << (byte_seconds * 1000000ULL + byte_micros) << ",\"hardware_ma\":";
    optional_number(r.hardware_max_ma);
    std::cout << ",\"effective_ma\":"; optional_number(r.effective_current_ma);
    std::cout << ",\"state_raw\":"; optional_number(r.charging_state_raw);
    std::cout << ",\"charging\":";
    if (r.charging_observed) std::cout << (*r.charging_observed ? "true" : "false");
    else std::cout << "null";
    std::cout << "}\n" << std::flush;
}
} // namespace

int main(int argc, char **argv) {
    // Fixed scenarios only: no arbitrary command/register/current endpoint.
    if (argc != 3) return 2;
    const std::string scenario = argv[2];
    const std::string scenarios[] = {"disabled", "set6", "set10", "set16", "set32",
        "stop", "start", "unprepared", "mismatch", "expired-preparation",
        "prepared-stop", "invalidate", "deadline", "missing-installation", "above-installation",
        "rejected-replacement", "expired-replacement", "expires-during-preflight"};
    bool known = false;
    for (const auto &item : scenarios) known = known || item == scenario;
    if (!known) return 2;
    try {
        Pty pty(argv[1]); // Reject all non-devpts paths BEFORE libmodbus opens anything.
        struct sigaction action{};
        action.sa_handler = terminate;
        sigemptyset(&action.sa_mask);
        if (sigaction(SIGTERM, &action, nullptr) != 0 || sigaction(SIGINT, &action, nullptr) != 0)
            throw std::runtime_error("signal_setup_failed");
        Context ctx(modbus_new_rtu(argv[1], 57600, 'E', 8, 1));
        if (!ctx || modbus_set_slave(ctx.get(), 9) != 0 ||
            modbus_set_response_timeout(ctx.get(), 0, 100000) != 0 ||
            modbus_set_byte_timeout(ctx.get(), 0, 0) != 0 ||
            modbus_set_error_recovery(ctx.get(), MODBUS_ERROR_RECOVERY_NONE) != 0)
            throw std::runtime_error("context_setup_failed");
        connect(ctx.get(), pty);
        wallbox::WritePolicy policy{true, 32000};
        if (scenario == "disabled") policy = {};
        if (scenario == "missing-installation") policy.installation_max_ma = 0;
        if (scenario == "above-installation") policy.installation_max_ma = 6000;
        auto offset = wallbox::WriteClock::duration::zero();
        bool expire_during_start = false;
        unsigned start_clock_calls = 0;
        const auto now = [&] {
            // Deterministic fake clock: request timestamp, validation, hardware
            // preflight, telemetry preflight, then the final send checkpoint.
            // Expire the OLD preparation only after both preflights succeeded.
            if (expire_during_start && ++start_clock_calls == 5) offset += std::chrono::seconds(3);
            return wallbox::WriteClock::now() + offset;
        };
        wallbox::WriteCore core(ctx.get(), policy, cancelled, now);
        const auto execute = [&](const char *stage, wallbox::WriteOperation op, std::uint32_t ma) {
            const auto start = wallbox::WriteClock::now();
            const auto lifetime = scenario == "deadline" ? std::chrono::milliseconds(40) :
                (scenario == "expires-during-preflight" && op == wallbox::WriteOperation::Start
                    ? std::chrono::milliseconds(5000) :
                 (scenario == "expired-replacement" && std::strcmp(stage, "replacement") == 0
                    ? std::chrono::milliseconds(-1) : std::chrono::milliseconds(2000)));
            auto r = core.execute({op, ma, now() + lifetime});
            print(stage, r, std::chrono::duration_cast<std::chrono::microseconds>(
                wallbox::WriteClock::now() - start).count(), ctx.get());
            return r;
        };
        using Op = wallbox::WriteOperation;
        std::uint32_t ma = scenario == "set6" ? 6000 : scenario == "set16" ? 16000 :
                           scenario == "set32" ? 32000 : 10000;
        Op operation = scenario == "stop" ? Op::Stop : Op::SetCurrent;
        if (scenario == "unprepared") operation = Op::Start;
        const bool prepare = scenario == "start" || scenario == "mismatch" ||
            scenario == "expired-preparation" || scenario == "prepared-stop" || scenario == "invalidate" ||
            scenario == "rejected-replacement" || scenario == "expired-replacement" ||
            scenario == "expires-during-preflight";
        if (prepare) {
            execute("prepare", Op::SetCurrent, ma);
            operation = scenario == "prepared-stop" ? Op::Stop : Op::Start;
            if (scenario == "mismatch") execute("mismatch", Op::Start, 6000);
            if (scenario == "expired-preparation") offset += std::chrono::seconds(3);
            if (scenario == "invalidate") core.invalidate_session();
            if (scenario == "rejected-replacement") execute("replacement", Op::SetCurrent, 32001);
            if (scenario == "expired-replacement") execute("replacement", Op::SetCurrent, ma);
            expire_during_start = scenario == "expires-during-preflight";
        }
        const auto result = execute("result", operation, operation == Op::Stop ? 0 : ma);
        expire_during_start = false;
        if (prepare) execute("consumed", Op::Start, ma);
        if (std::strcmp(result.reason, "observation_read_failed") == 0)
            execute("read_failure_latched", operation, operation == Op::Stop ? 0 : ma);
        if (result.status == wallbox::WriteStatus::OutcomeUnknown ||
            result.status == wallbox::WriteStatus::RejectedByDevice) {
            execute("latched", operation, operation == Op::Stop ? 0 : ma);
            if (!cancelled.load(std::memory_order_relaxed)) {
                // Caller-controlled recovery, strictly AFTER publishing the unknown result.
                // The old core remains latched even after observations on a reopened session.
                modbus_close(ctx.get());
                connect(ctx.get(), pty);
                std::uint16_t telemetry[24]{}, effective[2]{};
                const bool good = modbus_read_registers(ctx.get(), 0x4008, 24, telemetry) == 24 &&
                                  modbus_read_registers(ctx.get(), 0x400E, 2, effective) == 2;
                std::cout << "{\"stage\":\"recovery_observation\",\"ok\":"
                          << (good ? "true" : "false") << "}\n" << std::flush;
                execute("still_latched", operation, operation == Op::Stop ? 0 : ma);
            }
        }
        return 0;
    } catch (const std::exception &) {
        // Fixed diagnostic: do not echo arbitrary paths or arguments.
        std::cerr << "write_probe_setup_failed\n";
        return 2;
    }
}
