#pragma once
#include "telemetry.hpp"
#include <cstdint>
#include <optional>
#include <string>
#include <vector>
#include <utility>

namespace wallbox::automation {
// All deadlines are monotonic seconds. No installation defaults.
enum class Mode { Manual, Pv, Custom };
struct Window { int from = 0, to = 0; }; // local minutes, end exclusive
struct Profile {
    std::optional<int> max_import_w, max_current_ma, adjust_seconds, pause_seconds, resume_seconds;
    std::optional<bool> use_schedule, pv_enabled;
    std::vector<int> weekdays;
    std::vector<Window> windows;
    enum class Outside { Unset, Pause, Manual } outside = Outside::Unset;
};
struct Settings {
    bool valid = false;
    double expires = 0;
    std::string revision, activation, guard;
    Mode mode = Mode::Manual;
    Profile pv, custom;
    std::optional<int> phases;
    std::optional<bool> meter_includes_wallbox;
};
struct House {
    bool valid = false;
    double expires = 0, fetched_at = 0, power_w = 0;
};
struct Sources {
    Settings settings;
    House house;
    std::uint64_t generation = 0; // changed by HTTP publisher on invalidation/update
    bool clock_error = false;
};
struct Input {
    std::string activation_guard; // reader-owned causal epoch, never supplied by HTTP
    double now = 0, utc = 0;
    Sources sources;
    bool bus_connected = false;
    std::optional<Telemetry> sample;
    double sample_at = -1; // monotonic successful observation time, never an API heartbeat
    double sample_expires = 0, hardware_expires = 0;
    std::optional<int> hardware_max_ma, installation_max_ma;
};
enum class Status {
    AwaitingActivation, Manual, ManualOverride, Frozen, InvalidConfiguration,
    SourceUnavailable, ManualHandling, Unplugged, Adjusting, Pausing, Resuming,
    AwaitingStart, AwaitingStop, Charging, VehicleFinished
};
const char *status_name(Status) noexcept;
enum class Operation { Stop, SetCurrent, Start };
struct Action {
    Operation operation = Operation::Stop;
    int target_ma = 0;
    std::uint64_t serial = 0, source_generation = 0;
    std::string activation, revision, guard;
    double deadline = 0;
    double issued_at = 0, issued_utc = 0;
    bool requires_house = false;
    bool clock_protection = false; // One load-reducing Stop, never Start/SetCurrent.
};
struct Outcome { bool attempted = false, acknowledged = false; };
// Start is a compound owner operation: fresh SetCurrent, then Start on the SAME
// WriteCore/deadline. Report aggregate ACK only if BOTH strict ACKs succeeded.
bool action_is_current(const Action &, const Input &) noexcept;
bool schedule_contains(const Profile &, double utc);
// Call before creating threads: sets TZ once; all existing UTC formatting uses gmtime_r.
void initialize_vienna_timezone();
class Engine {
public:
    std::optional<Action> step(const Input &);
    // Owner calls immediately before each IO; includes manual/frozen cancellation.
    bool accepts(const Action &, const Input &) noexcept;
    void complete(const Action &, Outcome);
    void manual_override() noexcept;
    Status status() const noexcept { return status_; }
private:
    std::optional<std::pair<double,double>> clock_recovery_;
    std::optional<Action> issue(Operation, int, const Input &);
    void reset_activation(const Settings &);
    void consume_pending_activation(const Settings &);
    Status status_ = Status::AwaitingActivation;
    std::string activation_, revision_;
    Mode mode_ = Mode::Manual;
    bool baseline_ = false, armed_ = false, frozen_ = false, manual_ = false;
    bool start_wait_ = false, stop_wait_ = false, auto_stopped_ = false;
    bool observed_running_ = false, finished_ = false, unplugged_ = false;
    std::optional<int> ack_target_, candidate_;
    double candidate_since_ = 0, last_now_ = 0, last_utc_ = 0;
    double command_sample_at_ = -1;
    bool have_clock_ = false;
    std::optional<Action> pending_;
    std::vector<std::string> consumed_activations_; // bounded in-flight nonce quarantine
    bool nonce_overflow_ = false;
    std::uint64_t serial_ = 0;
};
} // namespace wallbox::automation
