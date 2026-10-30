#include "control_channel.hpp"

#include <mosquitto.h>
#include <fcntl.h>
#include <sys/random.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <map>
#include <mutex>
#include <stdexcept>
#include <string_view>
#include <thread>

namespace wallbox {
namespace {
bool token(std::string_view value) {
    return value.size() == 32 && value.find_first_not_of("0123456789abcdef") == value.npos;
}

// Bounded, nonblocking entropy reads; failure disables this channel, never falls
// back to a timestamp, PRNG, guessed session or authentication credential.
std::string nonce() {
    std::array<unsigned char, 16> bytes{};
    std::size_t filled = 0;
    for (unsigned tries = 0; tries < 8 && filled < bytes.size(); ++tries) {
        const auto n = getrandom(bytes.data() + filled, bytes.size() - filled, GRND_NONBLOCK);
        if (n <= 0) break;
        filled += static_cast<std::size_t>(n);
    }
    if (filled != bytes.size()) {
        const int fd = open("/dev/urandom", O_RDONLY | O_CLOEXEC | O_NONBLOCK);
        if (fd < 0) throw std::runtime_error("Control entropy unavailable");
        for (unsigned tries = 0; tries < 8 && filled < bytes.size(); ++tries) {
            const auto n = read(fd, bytes.data() + filled, bytes.size() - filled);
            if (n <= 0) break;
            filled += static_cast<std::size_t>(n);
        }
        close(fd);
        if (filled != bytes.size()) throw std::runtime_error("Control entropy unavailable");
    }
    std::string result;
    result.reserve(32);
    for (const auto b : bytes) {
        result += "0123456789abcdef"[b >> 4];
        result += "0123456789abcdef"[b & 15];
    }
    return result;
}

// Only internal vocabulary is serialized, even if a caller supplies arbitrary
// text in ControlReply/WriteResult. No escaping/raw-request echo is necessary.
std::string label(std::string_view value, bool status = false) {
    constexpr std::string_view statuses[] = {
        "ok", "busy", "rejected", "unavailable", "disabled", "invalid_request",
        "expired_not_sent", "cancelled_not_sent", "wrong_thread", "not_connected",
        "preflight_failed_not_sent", "preparation_required", "recovery_required",
        "acknowledged", "rejected_by_device", "outcome_unknown"
    };
    constexpr std::string_view reasons[] = {
        "ok", "inspection_complete", "reader_unavailable", "busy", "queue_full",
        "lease_capacity", "invalid_session", "invalid_lease", "deadline_elapsed",
        "invalid_request", "writes_disabled", "owner_thread_required", "new_session_required",
        "invalid_operation", "explicit_installation_limit_required", "invalid_current",
        "deadline_too_distant", "shutdown_requested", "connected_context_required",
        "unicast_rtu_context_required", "fresh_limit_ack_required", "cancelled_after_ack",
        "deadline_after_ack", "timeout_configuration_failed", "observation_read_failed",
        "invalid_hardware_limit", "above_hardware_limit", "active_wallbox_fault",
        "charging_state_unknown", "effective_limit_above_request", "write_outcome_unknown",
        "device_exception", "protocol_ack_only", "session_changed", "inspection_failed",
        "serial_unavailable", "inspection_read_failed", "hardware_read_failed",
        "modbus_unavailable", "read_only_inspection", "fresh_inspection_required"
    };
    if (status) {
        for (auto s : statuses) if (s == value) return std::string(s);
        return "unavailable";
    }
    for (auto s : reasons) if (s == value) return std::string(s);
    return "reader_unavailable";
}
std::string number(const std::optional<std::uint32_t> &n) {
    return n ? std::to_string(*n) : "null";
}
std::string write_json(const std::optional<WriteResult> &r) {
    if (!r) return "null";
    return "{\"status\":\"" + label(write_status_name(r->status), true) +
        "\",\"reason\":\"" + label(r->reason ? r->reason : "") +
        "\",\"attempted\":" + (r->attempted ? "true" : "false") +
        ",\"acknowledged\":" + (r->acknowledged ? "true" : "false") +
        ",\"hardware_max_ma\":" + number(r->hardware_max_ma) +
        ",\"effective_current_ma\":" + number(r->effective_current_ma) +
        ",\"charging_state_raw\":" + number(r->charging_state_raw) +
        ",\"charging_observed\":" + (r->charging_observed ? (*r->charging_observed ? "true" : "false") : "null") + "}";
}
bool valid_limit(const std::optional<std::uint32_t> &n) {
    return n && *n >= minimum_write_current_ma && *n <= maximum_write_current_ma;
}
std::string serialize(const ControlRequest &request, const ControlReply &reply,
                      const std::string &session, const std::string &lease) {
    std::optional<std::uint32_t> effective;
    if (valid_limit(reply.installation_max_ma) && valid_limit(reply.hardware_max_ma))
        effective = std::min({*reply.installation_max_ma, *reply.hardware_max_ma, maximum_write_current_ma});
    const std::string result = "{\"schema_version\":1,\"id\":\"" + request.id +
        "\",\"operation\":\"" + control_operation_name(request.operation) +
        "\",\"status\":\"" + label(reply.status, true) + "\",\"reason\":\"" + label(reply.reason) +
        "\",\"session\":\"" + session + "\",\"lease\":" + (lease.empty() ? "null" : "\"" + lease + "\"") +
        ",\"fresh_for_seconds\":" + (lease.empty() ? "0" : "8") +
        ",\"read_only\":" + (request.operation == ControlOperation::Inspect ? "true" : "false") +
        ",\"minimum_ma\":6000,\"software_max_ma\":32000,\"hardware_max_ma\":" + number(reply.hardware_max_ma) +
        ",\"installation_max_ma\":" + number(reply.installation_max_ma) +
        ",\"effective_max_ma\":" + number(effective) + ",\"firmware_raw\":" + number(reply.firmware_raw) +
        ",\"write\":" + write_json(reply.write) + ",\"preparation\":" + write_json(reply.preparation) + "}";
    if (result.size() > 4096) throw std::runtime_error("Control result too large");
    return result;
}
} // namespace

const char *control_operation_name(ControlOperation op) noexcept {
    switch (op) {
    case ControlOperation::Inspect: return "inspect";
    case ControlOperation::SetCurrent: return "set_current";
    case ControlOperation::Start: return "start";
    case ControlOperation::Stop: return "stop";
    }
    return "invalid";
}

std::optional<ControlRequest> parse_control_payload(const std::string &payload) {
    if (payload.empty() || payload.size() > 160) return std::nullopt;
    std::array<std::string_view, 6> fields{};
    const std::string_view text(payload);
    std::size_t begin = 0;
    for (std::size_t i = 0; i < fields.size(); ++i) {
        const auto end = text.find('|', begin);
        if ((i == fields.size() - 1) != (end == text.npos)) return std::nullopt;
        fields[i] = text.substr(begin, end == text.npos ? text.size() - begin : end - begin);
        if (end != text.npos) begin = end + 1;
    }
    if (fields[0] != "v1" || !token(fields[1])) return std::nullopt;
    ControlRequest request;
    if (fields[4] == "inspect") request.operation = ControlOperation::Inspect;
    else if (fields[4] == "set_current") request.operation = ControlOperation::SetCurrent;
    else if (fields[4] == "start") request.operation = ControlOperation::Start;
    else if (fields[4] == "stop") request.operation = ControlOperation::Stop;
    else return std::nullopt;
    if (request.operation == ControlOperation::Inspect) {
        if (fields[2] != "-" || fields[3] != "-") return std::nullopt;
    } else if (!token(fields[2]) || !token(fields[3])) return std::nullopt;
    if (fields[5].empty() || (fields[5].size() > 1 && fields[5].front() == '0')) return std::nullopt;
    std::uint32_t current = 0;
    for (const char c : fields[5]) {
        if (c < '0' || c > '9' || current > (UINT32_MAX - static_cast<unsigned>(c - '0')) / 10)
            return std::nullopt;
        current = current * 10 + static_cast<unsigned>(c - '0');
    }
    if (request.operation == ControlOperation::Inspect || request.operation == ControlOperation::Stop) {
        if (current != 0) return std::nullopt;
    } else if (current < minimum_write_current_ma || current > maximum_write_current_ma) return std::nullopt;
    request.id = fields[1];
    request.session = fields[2];
    request.lease = fields[3];
    request.current_ma = current;
    return request;
}

struct ControlChannel::Impl {
    struct Entry {
        std::string payload, session, body;
        WriteClock::time_point deadline;
    };
    const MqttPublisher &library_owner; // Lifetime contract; does NOT init/cleanup libmosquitto.
    const MqttOptions options;
    const std::string request_topic;
    std::mutex mutex;
    std::condition_variable wake;
    std::thread worker;
    mosquitto *client = nullptr; // Worker owns lifecycle; callbacks use only its current instance.
    bool stopping = false, ready = false, restart = false;
    int subscription_mid = 0, result_mid = 0;
    WriteClock::time_point ack_deadline{};
    std::string session;
    std::map<std::string, WriteClock::time_point> leases;
    std::map<std::string, Entry> entries;
    std::deque<ControlRequest> waiting;
    std::optional<ControlRequest> active;
    std::deque<std::pair<std::string, std::string>> results;

    Impl(MqttOptions opts, const MqttPublisher &owner)
        : library_owner(owner), options(std::move(opts)), request_topic(options.prefix + "/control/request") {
        worker = std::thread([this] { run(); });
    }
    ~Impl() {
        {
            std::lock_guard<std::mutex> lock(mutex);
            stopping = true;
            ready = false;
        }
        wake.notify_all();
        worker.join();
    }
    void prune(WriteClock::time_point now) {
        for (auto it = leases.begin(); it != leases.end();)
            if (it->second <= now) it = leases.erase(it); else ++it;
        for (auto it = entries.begin(); it != entries.end();)
            if (it->second.deadline + std::chrono::seconds(2) <= now &&
                (!active || active->id != it->first)) it = entries.erase(it); else ++it;
    }
    // Caller holds mutex. Active is retained until main finishes; it must fail
    // matches_session before every serial operation. No callback touches Core.
    void rotate() {
        ready = false;
        session.clear();
        leases.clear();
        waiting.clear();
        results.clear();
        result_mid = 0;
        subscription_mid = 0;
        for (auto &entry : entries) entry.second.body.clear();
        session = nonce();
    }
    template<class F> static void callback(void *user, F fn) noexcept {
        auto &self = *static_cast<Impl *>(user);
        try {
            std::lock_guard<std::mutex> lock(self.mutex);
            fn(self);
        } catch (...) {
            // No exception crosses the C ABI; fail closed and discard transport.
            std::lock_guard<std::mutex> lock(self.mutex);
            self.ready = false;
            self.restart = true;
        }
        self.wake.notify_all();
    }
    void receive(const mosquitto_message *message) {
        if (!ready || restart || stopping || !message || message->retain || !message->topic ||
            request_topic != message->topic || message->payloadlen <= 0 || message->payloadlen > 160 || !message->payload)
            return;
        const std::string payload(static_cast<const char *>(message->payload), static_cast<std::size_t>(message->payloadlen));
        auto request = parse_control_payload(payload);
        if (!request) return;
        const auto now = WriteClock::now();
        prune(now);
        const auto previous = entries.find(request->id);
        if (previous != entries.end()) {
            if (previous->second.payload == payload && previous->second.session == session &&
                !previous->second.body.empty() && results.size() < 8)
                results.emplace_back(request->id, previous->second.body);
            return; // Different payload, pending, or expired response: never re-execute.
        }
        if (entries.size() >= 128 || results.size() >= 8) return;
        request->deadline = now + std::chrono::seconds(3);
        const bool inspect = request->operation == ControlOperation::Inspect;
        const auto lease = leases.find(request->lease);
        const char *denial = nullptr;
        if (!inspect) {
            if (request->session != session) denial = "invalid_session";
            else if (lease == leases.end()) denial = "invalid_lease";
            else {
                request->deadline = lease->second;
            }
        }
        // Reserve the ID before consuming a lease or admitting any action.
        entries.emplace(request->id, Entry{payload, session, {}, request->deadline});
        if (!inspect && !denial) leases.erase(lease);
        if (!denial && waiting.size() >= 4) denial = "queue_full";
        if (denial) {
            ControlReply reply;
            reply.status = "rejected";
            reply.reason = denial;
            auto body = serialize(*request, reply, session, {});
            entries.at(request->id).body = body;
            results.emplace_back(request->id, std::move(body));
        } else {
            // The wire inspector uses '-', but the owner needs the actual
            // admission session for cancellation before every serial read.
            request->session = session;
            waiting.push_back(std::move(*request));
        }
    }
    void create_client() {
        const auto id = "evse-control-" + nonce();
        client = mosquitto_new(id.c_str(), true, this);
        if (!client) throw std::runtime_error("Control MQTT unavailable");
        if (mosquitto_int_option(client, MOSQ_OPT_PROTOCOL_VERSION, MQTT_PROTOCOL_V311) != MOSQ_ERR_SUCCESS ||
            (!options.username.empty() && mosquitto_username_pw_set(client, options.username.c_str(),
                options.password.empty() ? nullptr : options.password.c_str()) != MOSQ_ERR_SUCCESS))
            throw std::runtime_error("Control MQTT configuration failed");
        mosquitto_connect_callback_set(client, [](mosquitto *c, void *u, int rc) noexcept {
            callback(u, [c, rc](Impl &s) {
                s.rotate();
                if (rc != 0 || s.stopping || mosquitto_subscribe(c, &s.subscription_mid, s.request_topic.c_str(), 1) != MOSQ_ERR_SUCCESS)
                    s.restart = true;
            });
        });
        mosquitto_subscribe_callback_set(client, [](mosquitto *, void *u, int mid, int count, const int *grants) noexcept {
            callback(u, [=](Impl &s) {
                if (!s.stopping && !s.restart && mid == s.subscription_mid && mid != 0 && count == 1 && grants &&
                    (grants[0] == 0 || grants[0] == 1)) {
                    s.ready = true;
                    s.subscription_mid = 0;
                } else { s.ready = false; s.restart = true; }
            });
        });
        mosquitto_disconnect_callback_set(client, [](mosquitto *, void *u, int) noexcept {
            callback(u, [](Impl &s) { s.rotate(); s.restart = true; });
        });
        mosquitto_message_callback_set(client, [](mosquitto *, void *u, const mosquitto_message *m) noexcept {
            callback(u, [m](Impl &s) { s.receive(m); });
        });
        mosquitto_publish_callback_set(client, [](mosquitto *, void *u, int mid) noexcept {
            callback(u, [mid](Impl &s) { if (s.result_mid == mid) s.result_mid = 0; });
        });
    }
    void run() noexcept {
        bool running = false;
        unsigned backoff = 1;
        try {
            while (true) {
                {
                    std::lock_guard<std::mutex> lock(mutex);
                    if (stopping) break;
                    rotate();
                    restart = false;
                }
                create_client(); // All connection/DNS work off the serial/main thread.
                const auto attempt = WriteClock::now();
                if (mosquitto_connect_async(client, options.host.c_str(), options.port, 15) == MOSQ_ERR_SUCCESS &&
                    mosquitto_loop_start(client) == MOSQ_ERR_SUCCESS) {
                    running = true;
                    std::unique_lock<std::mutex> lock(mutex);
                    while (!stopping && !restart) {
                        const auto now = WriteClock::now();
                        if (ready) backoff = 1;
                        if ((!ready && now - attempt >= std::chrono::seconds(3)) ||
                            (result_mid && now >= ack_deadline)) break;
                        if (ready && !result_mid && !results.empty()) {
                            const auto &result = results.front();
                            const auto topic = options.prefix + "/control/result/" + result.first;
                            if (mosquitto_publish(client, &result_mid, topic.c_str(), static_cast<int>(result.second.size()),
                                    result.second.data(), 1, false) != MOSQ_ERR_SUCCESS) break;
                            ack_deadline = now + std::chrono::seconds(3);
                            results.pop_front();
                        }
                        wake.wait_for(lock, std::chrono::milliseconds(50));
                    }
                    ready = false;
                }
                // Do not hold mutex while joining callbacks. Destroy, rather than
                // reconnecting an old object: no queued QoS1 replay across sessions.
                if (running) mosquitto_loop_stop(client, true);
                running = false;
                mosquitto_destroy(client);
                client = nullptr;
                std::unique_lock<std::mutex> lock(mutex);
                rotate();
                if (stopping) break;
                wake.wait_for(lock, std::chrono::seconds(backoff), [this] { return stopping; });
                backoff = std::min(30U, backoff * 2);
            }
        } catch (...) { /* No payload/error logging, no failure reaches serial owner. */ }
        if (running) mosquitto_loop_stop(client, true);
        if (client) mosquitto_destroy(client);
        client = nullptr;
        std::lock_guard<std::mutex> lock(mutex);
        ready = false;
        session.clear();
        leases.clear();
        waiting.clear();
        results.clear();
    }
};

ControlChannel::ControlChannel(const MqttOptions &options, const MqttPublisher &owner) {
    if (options.enabled) impl_ = std::make_unique<Impl>(options, owner);
}
ControlChannel::~ControlChannel() = default;

std::optional<ControlRequest> ControlChannel::take() {
    if (!impl_) return std::nullopt;
    std::lock_guard<std::mutex> lock(impl_->mutex);
    if (!impl_->ready || impl_->restart || impl_->stopping || impl_->active) return std::nullopt;
    while (!impl_->waiting.empty()) {
        auto request = std::move(impl_->waiting.front());
        impl_->waiting.pop_front();
        if (WriteClock::now() >= request.deadline) continue;
        impl_->active = request;
        return request;
    }
    return std::nullopt;
}

bool ControlChannel::matches_session(const std::string &session) const {
    if (!impl_) return false;
    std::lock_guard<std::mutex> lock(impl_->mutex);
    return impl_->ready && !impl_->restart && !impl_->stopping && impl_->session == session;
}

void ControlChannel::invalidate_session() {
    if (!impl_) return;
    {
        std::lock_guard<std::mutex> lock(impl_->mutex);
        const bool was_ready = impl_->ready && !impl_->restart;
        const bool pending_transport = impl_->result_mid != 0;
        try {
            impl_->rotate();
            // A bus-only invalidation does not disconnect an otherwise healthy
            // broker. This permits the known active error completion to reach
            // its caller, under the NEW session and without a lease/cache.
            // An in-flight old QoS1 packet cannot be cancelled in-place: destroy
            // that transport instead; an offline completion may be discarded.
            impl_->ready = was_ready && !pending_transport;
            if (pending_transport || !was_ready) impl_->restart = true;
        } catch (...) {
            impl_->ready = false;
            impl_->restart = true;
        }
    }
    impl_->wake.notify_all();
}

void ControlChannel::finish(const ControlRequest &request, const ControlReply &reply) {
    if (!impl_) return;
    std::lock_guard<std::mutex> lock(impl_->mutex);
    if (!impl_->active || impl_->active->id != request.id ||
        impl_->active->deadline != request.deadline || impl_->active->session != request.session ||
        impl_->active->lease != request.lease || impl_->active->operation != request.operation ||
        impl_->active->current_ma != request.current_ma) return;
    const auto entry = impl_->entries.find(request.id);
    const auto now = WriteClock::now();
    if (entry == impl_->entries.end() || !impl_->ready || impl_->restart || impl_->stopping ||
        impl_->results.size() >= 8) {
        impl_->active.reset();
        return;
    }
    try {
        auto response = reply;
        std::string lease;
        const bool same_session = entry->second.session == impl_->session;
        impl_->prune(now); // Active reservation remains protected, even after its deadline.
        if (request.operation == ControlOperation::Inspect && reply.status == "ok" && same_session &&
            now < request.deadline) {
            if (impl_->leases.size() >= 64) {
                response.status = "busy";
                response.reason = "lease_capacity";
            } else {
                lease = nonce();
                if (!impl_->leases.emplace(lease, now + std::chrono::seconds(8)).second)
                    throw std::runtime_error("Control entropy collision");
            }
        }
        // Never hide an attempted/acknowledged write merely because its deadline
        // elapsed during I/O. Only lease minting requires unexpired admission.
        auto body = serialize(request, response, impl_->session, lease);
        if (same_session) entry->second.body = body;
        impl_->results.emplace_back(request.id, std::move(body));
    } catch (...) {
        impl_->ready = false;
        impl_->restart = true;
        impl_->leases.clear();
        impl_->waiting.clear();
        impl_->results.clear();
    }
    impl_->active.reset();
    impl_->wake.notify_all();
}

} // namespace wallbox
