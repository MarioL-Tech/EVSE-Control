#pragma once

#include "mqtt.hpp"
#include "write_core.hpp"

#include <memory>
#include <optional>
#include <string>

namespace wallbox {

enum class ControlOperation { Inspect, SetCurrent, Start, Stop };
const char *control_operation_name(ControlOperation operation) noexcept;

// v1|id(32 lower hex)|session(32 lower hex or -)|lease(same)|operation|milliamps
// No user-provided topic/register/path. Inspect uses -|- and zero current.
// All other commands consume ONE reader-issued, monotonic eight-second lease.
struct ControlRequest {
    std::string id;
    std::string session;
    std::string lease;
    ControlOperation operation = ControlOperation::Inspect;
    std::uint32_t current_ma = 0;
    WriteClock::time_point deadline{}; // Assigned by channel, NEVER refreshed on receipt/replay.
};
std::optional<ControlRequest> parse_control_payload(const std::string &payload);

struct ControlReply {
    std::string status = "unavailable";
    std::string reason = "reader_unavailable";
    std::optional<WriteResult> write;
    std::optional<WriteResult> preparation;
    std::optional<std::uint32_t> hardware_max_ma;
    std::optional<std::uint32_t> installation_max_ma;
    std::optional<std::uint32_t> firmware_raw;
};

// Separate bounded network connection; NEVER performs serial I/O. Needs the
// publisher (which initializes libmosquitto) to outlive this object. Main creates
// publisher first and destroys channel first. Same broker/credentials, unique ID.
// Request topic <prefix>/control/request, result <prefix>/control/result/<id>.
// Clean session; reject retained; subscribe ACK before ready; QoS0 commands from
// PHP, one pending QoS1 result plus <=8 queued results; no transport write replay.
class ControlChannel {
public:
    ControlChannel(const MqttOptions &options, const MqttPublisher &library_owner);
    ~ControlChannel();
    ControlChannel(const ControlChannel &) = delete;
    ControlChannel &operator=(const ControlChannel &) = delete;
    std::optional<ControlRequest> take(); // Main thread; queue <=4, one active.
    void finish(const ControlRequest &request, const ControlReply &reply);
    bool matches_session(const std::string &session) const;
    void invalidate_session(); // Bus disconnect: rotate session, drop leases/queue.
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace wallbox
