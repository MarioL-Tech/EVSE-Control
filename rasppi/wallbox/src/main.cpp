#include "telemetry.hpp"
#include "mqtt.hpp"
#include "write_core.hpp"
#include "control_channel.hpp"

#include <modbus.h>
#include <fcntl.h>
#include <poll.h>
#include <unistd.h>

#include <cerrno>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <csignal>
#include <ctime>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <thread>

namespace {

static_assert(std::atomic_bool::is_always_lock_free, "Signal flag must be lock-free");
std::atomic_bool stopped{false};
void stop(int) { stopped.store(true, std::memory_order_relaxed); }

struct Options {
    std::string device = "/dev/ttyUSBEVSEcontrol";
    int baud = 57600;
    char parity = 'E';
    int slave = 9;
    int interval_ms = 2000;
    int timeout_ms = 1000;
    bool once = false;
};

void help() {
    std::cout << "Usage: evse-wallbox [options]\n"
                 "ABB Terra AC Modbus RTU reader; JSON lines on stdout.\n"
                 "Manual control via non-retained MQTT requests; no CLI write commands.\n"
                 "  --device PATH        Serial device (default /dev/ttyUSBEVSEcontrol)\n"
                 "  --baud RATE          4800/9600/19200/38400/57600/115200\n"
                 "  --parity E|O|N       Parity (default E); always 8 data bits, 1 stop bit\n"
                 "  --slave ID           Slave address 1..247 (default 9)\n"
                 "  --interval-ms N      Poll interval 100..30000 ms (default 2000)\n"
                 "  --timeout-ms N       Full-response timeout 10..10000 ms (default 1000)\n"
                 "  --once               One request; exit 1 on communication failure\n"
                 "MQTT is optional via MQTT_ENABLED=true and MQTT_HOST/PORT/TOPIC_PREFIX/CLIENT_ID.\n"
                 "Credentials: MQTT_USERNAME, MQTT_PASSWORD or MQTT_PASSWORD_FILE (never CLI).\n"
                 "  --help               Show this help\n";
}

int number(const std::string &text, int low, int high) {
    if (text.empty() || text.find_first_not_of("0123456789") != std::string::npos)
        throw std::invalid_argument("Expected a decimal integer: " + text);
    std::size_t used = 0;
    const long value = std::stol(text, &used);
    if (used != text.size() || value < low || value > high)
        throw std::invalid_argument("Value out of range: " + text);
    return static_cast<int>(value);
}

Options options(int argc, char **argv) {
    Options o;
    for (int i = 1; i < argc; ++i) {
        const std::string key = argv[i];
        if (key == "--once") { o.once = true; continue; }
        if (key != "--device" && key != "--baud" && key != "--parity" &&
            key != "--slave" && key != "--interval-ms" && key != "--timeout-ms")
            throw std::invalid_argument("Unknown option: " + key);
        if (++i >= argc) throw std::invalid_argument("Missing value for " + key);
        const std::string value = argv[i];
        if (key == "--device") {
            if (value.empty()) throw std::invalid_argument("Device path must not be empty");
            o.device = value;
        } else if (key == "--baud") {
            o.baud = number(value, 4800, 115200);
            if (o.baud != 4800 && o.baud != 9600 && o.baud != 19200 &&
                o.baud != 38400 && o.baud != 57600 && o.baud != 115200)
                throw std::invalid_argument("Unsupported baud rate: " + value);
        } else if (key == "--parity") {
            if (value != "E" && value != "O" && value != "N")
                throw std::invalid_argument("Parity must be E, O or N");
            o.parity = value[0];
        } else if (key == "--slave") o.slave = number(value, 1, 247);
        else if (key == "--interval-ms") o.interval_ms = number(value, 100, 30000);
        else o.timeout_ms = number(value, 10, 10000);
    }
    if (o.timeout_ms >= o.interval_ms && !o.once)
        throw std::invalid_argument("Timeout must be shorter than the poll interval");
    return o;
}

std::string timestamp() {
    const auto now = std::chrono::system_clock::now();
    const auto time = std::chrono::system_clock::to_time_t(now);
    std::tm utc{};
    if (!gmtime_r(&time, &utc)) throw std::runtime_error("Cannot format UTC timestamp");
    std::ostringstream out;
    out << std::put_time(&utc, "%Y-%m-%dT%H:%M:%SZ");
    return out.str();
}

struct FreeContext {
    bool connected = false;
    void operator()(modbus_t *ctx) const {
        if (connected) modbus_close(ctx);
        modbus_free(ctx);
    }
};

class JsonOutput {
public:
    JsonOutput() : flags_(fcntl(STDOUT_FILENO, F_GETFL)) {
        if (flags_ == -1 || fcntl(STDOUT_FILENO, F_SETFL, flags_ | O_NONBLOCK) == -1)
            throw std::runtime_error("Cannot configure stdout");
    }
    ~JsonOutput() { fcntl(STDOUT_FILENO, F_SETFL, flags_); }

    bool write_line(const std::string &json) const {
        const std::string line = json + '\n';
        std::size_t offset = 0;
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
        while (offset < line.size()) {
            if (stopped) return false;
            if (std::chrono::steady_clock::now() >= deadline)
                throw std::runtime_error("stdout blocked for one second; stopping reader");
            const auto count = ::write(STDOUT_FILENO, line.data() + offset, line.size() - offset);
            if (count > 0) offset += static_cast<std::size_t>(count);
            else if (count == -1 && errno == EINTR) continue;
            else if (count == -1 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
                pollfd fd{STDOUT_FILENO, POLLOUT, 0};
                if (::poll(&fd, 1, 50) == -1 && errno != EINTR)
                    throw std::runtime_error("stdout poll failed");
            } else throw std::runtime_error("stdout write failed");
        }
        return true;
    }
private:
    int flags_;
};

int run(const Options &o) {
    JsonOutput output;
    const auto mqtt_config = wallbox::mqtt_options_from_environment();
    wallbox::MqttPublisher mqtt(mqtt_config,
        std::chrono::milliseconds(std::max(5000, o.interval_ms * 3 + o.timeout_ms)));
    // Declared AFTER publisher: network callback/thread destroyed BEFORE the
    // publisher cleans up libmosquitto. --once is an exclusively read-only path.
    auto control_config = mqtt_config;
    if (o.once) control_config.enabled = false;
    wallbox::ControlChannel control(control_config, mqtt);
    std::uint32_t installation_max_ma = 0;
    if (const char *limit = std::getenv("WALLBOX_INSTALLATION_MAX_MA"); limit && *limit) {
        try { installation_max_ma = static_cast<std::uint32_t>(number(limit, 6000, 32000)); }
        catch (const std::exception &) {
            // Keep monitoring/Stop available; never guess a cap or echo input.
            std::cerr << "Installation current maximum invalid; current/start unavailable\n";
        }
    }
    std::unique_ptr<modbus_t, FreeContext> ctx(
        modbus_new_rtu(o.device.c_str(), o.baud, o.parity, 8, 1));
    if (!ctx) throw std::runtime_error(modbus_strerror(errno));
    // Disable the per-byte timeout so the entire response has a bounded deadline.
    if (modbus_set_slave(ctx.get(), o.slave) == -1 ||
        modbus_set_byte_timeout(ctx.get(), 0, 0) == -1 ||
        modbus_set_response_timeout(ctx.get(), o.timeout_ms / 1000,
                                   (o.timeout_ms % 1000) * 1000) == -1)
        throw std::runtime_error(modbus_strerror(errno));

    std::cerr << "Polling " << o.device << ", slave " << o.slave
              << ", FC03, 0x4008..0x401F; manual MQTT control"
              << (o.once ? " unavailable in --once\n" : " on the same owner thread\n");
    bool &connected = ctx.get_deleter().connected;
    std::optional<std::string> last_success;
    int result = 0;
    bool recovery_required = false;
    while (!stopped) {
        const auto cycle = std::chrono::steady_clock::now();
        std::optional<std::string> error;
        std::optional<wallbox::Telemetry> values;
        if (!connected) {
            if (modbus_connect(ctx.get()) == -1)
                error = std::string("connect: ") + modbus_strerror(errno);
            else connected = true;
        }
        if (connected && !stopped) {
            wallbox::Registers registers{};
            const int count = modbus_read_registers(ctx.get(), wallbox::first_register,
                                                    wallbox::register_count, registers.data());
            if (count == wallbox::register_count) values = wallbox::decode(registers);
            else {
                error = count == -1 ? std::string("read: ") + modbus_strerror(errno)
                                    : "read: incomplete register block";
                control.invalidate_session();
                modbus_close(ctx.get());
                connected = false; // reopen on the next cycle, including after USB disconnect
            }
        }
        if (stopped) break;
        const auto sampled_at = timestamp();
        if (values) last_success = sampled_at;
        const auto json = wallbox::sample_json(sampled_at, last_success, values, error);
        mqtt.update(json, values.has_value());
        if (!output.write_line(json))
            break;
        result = values ? 0 : 1;
        if (o.once) {
            if (!mqtt.flush(std::chrono::milliseconds(1500)))
                std::cerr << "MQTT one-shot not acknowledged; exit code describes Modbus only\n";
            break;
        }
        const auto next_poll = cycle + std::chrono::milliseconds(o.interval_ms);
        // One control action per poll interval, never an unbounded drain that
        // starves telemetry. Network callbacks only enqueue; all serial I/O here.
        bool handled = false;
        while (!stopped && std::chrono::steady_clock::now() < next_poll) {
            const auto command = handled ? std::optional<wallbox::ControlRequest>{} : control.take();
            if (!command) { std::this_thread::sleep_for(std::chrono::milliseconds(20)); continue; }
            handled = true;
            wallbox::ControlReply reply;
            reply.installation_max_ma = installation_max_ma ? std::optional<std::uint32_t>(installation_max_ma) : std::nullopt;
            if (command->deadline <= wallbox::WriteClock::now() || stopped) {
                reply.status = "expired_not_sent"; reply.reason = "deadline_elapsed";
            } else if (!connected) {
                reply.reason = "modbus_unavailable";
            } else if (command->operation == wallbox::ControlOperation::Inspect) {
                // Inspect is the explicit, read-only recovery action after an
                // unknown write. No command is preserved or retried on recovery.
                if (recovery_required) {
                    modbus_close(ctx.get()); connected = false;
                    if (modbus_connect(ctx.get()) == 0) {
                        connected = true;
                        (void)modbus_flush(ctx.get());
                    }
                }
                std::array<std::uint16_t, 4> registers{};
                const auto left = std::chrono::duration_cast<std::chrono::microseconds>(command->deadline - wallbox::WriteClock::now()).count();
                const auto budget = std::min<std::int64_t>(left, o.timeout_ms * 1000LL);
                if (connected && budget > 0 && control.matches_session(command->session) &&
                    modbus_set_response_timeout(ctx.get(), static_cast<std::uint32_t>(budget / 1000000),
                                                 static_cast<std::uint32_t>(budget % 1000000)) == 0 &&
                    modbus_read_registers(ctx.get(), 0x4004, 4, registers.data()) == 4 &&
                    command->deadline > wallbox::WriteClock::now() && control.matches_session(command->session) && !stopped) {
                    reply.firmware_raw = (static_cast<std::uint32_t>(registers[0]) << 16) | registers[1];
                    reply.hardware_max_ma = (static_cast<std::uint32_t>(registers[2]) << 16) | registers[3];
                    reply.status = "ok"; reply.reason = "read_only_inspection";
                    recovery_required = false;
                } else {
                    reply.reason = "inspection_read_failed";
                    control.invalidate_session();
                    if (connected) modbus_close(ctx.get());
                    connected = false;
                }
                (void)modbus_set_response_timeout(ctx.get(), o.timeout_ms / 1000, (o.timeout_ms % 1000) * 1000);
            } else if (recovery_required) {
                reply.status = "recovery_required"; reply.reason = "fresh_inspection_required";
            } else {
                wallbox::WriteCore core(ctx.get(), {true, installation_max_ma}, stopped,
                    [] { return wallbox::WriteClock::now(); },
                    [&] { return !control.matches_session(command->session); });
                const auto operation = command->operation == wallbox::ControlOperation::Stop ? wallbox::WriteOperation::Stop :
                    (command->operation == wallbox::ControlOperation::SetCurrent ? wallbox::WriteOperation::SetCurrent : wallbox::WriteOperation::Start);
                if (operation == wallbox::WriteOperation::Start) {
                    // Two EXPLICIT steps of the requested web action, not an
                    // implicit core write. Report partial completion honestly.
                    reply.preparation = core.execute({wallbox::WriteOperation::SetCurrent, command->current_ma, command->deadline});
                    if (reply.preparation->acknowledged && reply.preparation->effective_current_ma &&
                        *reply.preparation->effective_current_ma <= command->current_ma &&
                        reply.preparation->reason == std::string("protocol_ack_only"))
                        reply.write = core.execute({operation, command->current_ma, command->deadline});
                } else {
                    reply.write = core.execute({operation, command->current_ma, command->deadline});
                }
                const auto &outcome = reply.write ? *reply.write : *reply.preparation;
                reply.status = wallbox::write_status_name(outcome.status);
                reply.reason = outcome.reason;
                reply.hardware_max_ma = outcome.hardware_max_ma;
                if (outcome.status == wallbox::WriteStatus::OutcomeUnknown || outcome.transport_errno != 0) {
                    recovery_required = true;
                    control.invalidate_session();
                }
            }
            control.finish(*command, reply);
        }
    }
    return o.once ? result : 0;
}

} // namespace

int main(int argc, char **argv) {
    try {
        for (int i = 1; i < argc; ++i) {
            if (std::string(argv[i]) == "--help") { help(); return 0; }
        }
        const auto config = options(argc, argv);
        std::signal(SIGINT, stop);
        std::signal(SIGTERM, stop);
        std::signal(SIGPIPE, SIG_IGN); // A disconnected consumer is an output error, not a crash.
        return run(config);
    } catch (const std::exception &e) {
        std::cerr << "evse-wallbox: " << e.what() << '\n';
        return 2;
    }
}
