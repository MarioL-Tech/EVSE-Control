#include "mqtt.hpp"

#include <mosquitto.h>
#include <fcntl.h>
#include <unistd.h>

#include <algorithm>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <mutex>
#include <optional>
#include <set>
#include <stdexcept>
#include <thread>

namespace wallbox {
namespace {
// Docker supplies stderr as a pipe. Never let a stalled logging sink hold the
// callback/sample mutex and thereby stall Modbus. Diagnostics are best effort.
class Diagnostics {
public:
    Diagnostics() : flags_(fcntl(STDERR_FILENO, F_GETFL)),
        writable_(flags_ >= 0 && fcntl(STDERR_FILENO, F_SETFL, flags_ | O_NONBLOCK) == 0) {}
    ~Diagnostics() {
        if (writable_) fcntl(STDERR_FILENO, F_SETFL, flags_);
    }
    void write(const std::string &message) const {
        if (writable_) {
            const auto ignored = ::write(STDERR_FILENO, message.data(), message.size());
            (void)ignored; // Drop on EAGAIN; no retry/backpressure on diagnostics.
        }
    }
private:
    int flags_;
    bool writable_;
};

std::string environment(const char *name, const std::string &fallback = "") {
    const char *value = std::getenv(name);
    return value && *value ? value : fallback;
}

void require(int result, const char *operation) {
    if (result != MOSQ_ERR_SUCCESS)
        throw std::runtime_error(std::string(operation) + ": " + mosquitto_strerror(result));
}
} // namespace

MqttOptions mqtt_options_from_environment() {
    MqttOptions result;
    const auto enabled = environment("MQTT_ENABLED", "false");
    if (enabled != "true" && enabled != "false" && enabled != "1" && enabled != "0")
        throw std::invalid_argument("MQTT_ENABLED must be true/false or 1/0");
    result.enabled = enabled == "true" || enabled == "1";
    if (!result.enabled) return result;
    result.host = environment("MQTT_HOST", result.host);
    const auto port = environment("MQTT_PORT", "1883");
    if (port.find_first_not_of("0123456789") != std::string::npos)
        throw std::invalid_argument("MQTT_PORT must be a decimal integer");
    const long parsed = std::stol(port);
    if (parsed < 1 || parsed > 65535) throw std::invalid_argument("MQTT_PORT out of range");
    result.port = static_cast<int>(parsed);
    result.prefix = environment("MQTT_TOPIC_PREFIX", result.prefix);
    if (result.prefix.size() > 240 || result.prefix.front() == '/' ||
        result.prefix.back() == '/' ||
        mosquitto_pub_topic_check((result.prefix + "/state").c_str()) != MOSQ_ERR_SUCCESS)
        throw std::invalid_argument("Invalid MQTT_TOPIC_PREFIX (no wildcards or edge slashes)");
    result.client_id = environment("MQTT_CLIENT_ID", result.client_id);
    result.username = environment("MQTT_USERNAME");
    result.password = environment("MQTT_PASSWORD");
    const auto file = environment("MQTT_PASSWORD_FILE");
    if (!file.empty()) {
        if (!result.password.empty())
            throw std::invalid_argument("Use MQTT_PASSWORD or MQTT_PASSWORD_FILE, not both");
        std::ifstream input(file);
        if (!input || !std::getline(input, result.password))
            throw std::invalid_argument("Cannot read MQTT_PASSWORD_FILE");
        if (!result.password.empty() && result.password.back() == '\r') result.password.pop_back();
    }
    if (!result.password.empty() && result.username.empty())
        throw std::invalid_argument("MQTT password requires MQTT_USERNAME");
    return result;
}

struct MqttPublisher::Impl {
    using Clock = std::chrono::steady_clock;
    Diagnostics diagnostics;
    MqttOptions options;
    std::chrono::milliseconds fresh_for;
    mosquitto *client = nullptr;
    std::thread worker;
    std::mutex mutex;
    std::condition_variable wake;
    bool stopping = false;
    bool connected = false;
    bool restart = false;
    std::string latest;
    bool healthy = false;
    Clock::time_point updated{};
    std::uint64_t generation = 0;
    std::uint64_t sent_generation = 0;
    std::optional<bool> sent_available;
    std::set<int> pending;
    Clock::time_point batch_started{};

    Impl(MqttOptions config, std::chrono::milliseconds freshness)
        : options(std::move(config)), fresh_for(freshness) {
        require(mosquitto_lib_init(), "MQTT library init");
        try {
            create_client();
            worker = std::thread([this] { run(); });
        } catch (...) {
            if (client) mosquitto_destroy(client);
            mosquitto_lib_cleanup();
            throw;
        }
    }

    ~Impl() {
        {
            std::lock_guard<std::mutex> lock(mutex);
            stopping = true;
        }
        wake.notify_all();
        worker.join();
        if (client) mosquitto_destroy(client);
        mosquitto_lib_cleanup();
    }

    void create_client() {
        client = mosquitto_new(options.client_id.c_str(), true, this);
        if (!client) throw std::runtime_error("Cannot create MQTT client");
        require(mosquitto_int_option(client, MOSQ_OPT_PROTOCOL_VERSION, MQTT_PROTOCOL_V311),
                "MQTT protocol");
        require(mosquitto_will_set(client, (options.prefix + "/availability").c_str(),
                                   7, "offline", 1, true), "MQTT Last Will");
        if (!options.username.empty())
            require(mosquitto_username_pw_set(client, options.username.c_str(),
                        options.password.empty() ? nullptr : options.password.c_str()), "MQTT authentication");
        mosquitto_connect_callback_set(client, [](mosquitto *, void *user, int result) {
            auto &self = *static_cast<Impl *>(user);
            std::lock_guard<std::mutex> lock(self.mutex);
            self.connected = result == 0;
            self.restart = result != 0;
            if (result == 0) self.diagnostics.write("MQTT connected\n");
            else self.diagnostics.write("MQTT connection rejected (code " + std::to_string(result) + ")\n");
            self.wake.notify_all();
        });
        mosquitto_disconnect_callback_set(client, [](mosquitto *, void *user, int) {
            auto &self = *static_cast<Impl *>(user);
            std::lock_guard<std::mutex> lock(self.mutex);
            self.connected = false;
            if (!self.stopping) self.restart = true;
            self.wake.notify_all();
        });
        mosquitto_publish_callback_set(client, [](mosquitto *, void *user, int mid) {
            auto &self = *static_cast<Impl *>(user);
            std::lock_guard<std::mutex> lock(self.mutex);
            self.pending.erase(mid);
            self.wake.notify_all();
        });
    }

    // Caller holds mutex, including during publish: ACK callbacks cannot race
    // ahead of inserting their MID into the bounded pending set.
    bool publish(const std::string &topic, const std::string &payload) {
        int mid = 0;
        const int result = mosquitto_publish(client, &mid, topic.c_str(),
                                             static_cast<int>(payload.size()), payload.data(), 1, true);
        if (result != MOSQ_ERR_SUCCESS) {
            diagnostics.write(std::string("MQTT publish failed: ") + mosquitto_strerror(result) + '\n');
            restart = true;
            return false;
        }
        pending.insert(mid);
        return true;
    }

    void publish_latest() {
        std::lock_guard<std::mutex> lock(mutex);
        if (!connected || !pending.empty() || stopping) return;
        const bool available = healthy && Clock::now() - updated <= fresh_for;
        const bool changed = generation != sent_generation;
        if (!changed && sent_available && *sent_available == available) return;
        batch_started = Clock::now();
        if (changed && !publish(options.prefix + "/state", latest)) return;
        if (!publish(options.prefix + "/availability", available ? "online" : "offline")) return;
        sent_generation = generation;
        sent_available = available;
        wake.notify_all();
    }

    void stop_loop(bool &running) {
        // Never join the network thread while holding the callback mutex.
        if (running) mosquitto_loop_stop(client, true);
        running = false;
    }

    void run() noexcept {
        bool running = false;
        unsigned retry_seconds = 1;
        auto attempt_started = Clock::now();
        try {
            while (true) {
                {
                    std::lock_guard<std::mutex> lock(mutex);
                    if (stopping) break;
                }
                if (!running) {
                    // DNS/connect preparation happens on this worker, not in the Modbus loop.
                    const int result = mosquitto_connect_async(client, options.host.c_str(), options.port, 15);
                    if (result == MOSQ_ERR_SUCCESS && mosquitto_loop_start(client) == MOSQ_ERR_SUCCESS) {
                        running = true;
                        attempt_started = Clock::now();
                    } else {
                        diagnostics.write("MQTT unavailable; retry in " + std::to_string(retry_seconds) + " s\n");
                        std::unique_lock<std::mutex> lock(mutex);
                        wake.wait_for(lock, std::chrono::seconds(retry_seconds), [this] { return stopping; });
                        retry_seconds = std::min(30U, retry_seconds * 2);
                        continue;
                    }
                }
                publish_latest();
                bool reset;
                {
                    std::lock_guard<std::mutex> lock(mutex);
                    if (connected) retry_seconds = 1;
                    reset = restart || (!connected && Clock::now() - attempt_started > std::chrono::seconds(3)) ||
                            (!pending.empty() && Clock::now() - batch_started > std::chrono::seconds(3));
                }
                if (reset) {
                    stop_loop(running);
                    mosquitto_destroy(client); // No DISCONNECT: broker Last Will marks offline.
                    client = nullptr;
                    {
                        std::unique_lock<std::mutex> lock(mutex);
                        connected = false;
                        restart = false;
                        pending.clear();
                        sent_generation = 0;
                        sent_available.reset();
                        diagnostics.write("MQTT reconnect in " + std::to_string(retry_seconds) + " s\n");
                        wake.wait_for(lock, std::chrono::seconds(retry_seconds), [this] { return stopping; });
                        if (stopping) break;
                    }
                    create_client(); // Drop old transport backlog; retain only latest application sample.
                    retry_seconds = std::min(30U, retry_seconds * 2);
                }
                std::unique_lock<std::mutex> lock(mutex);
                wake.wait_for(lock, std::chrono::milliseconds(50), [this] { return stopping; });
            }
            if (client) {
                std::unique_lock<std::mutex> lock(mutex);
                if (connected) {
                    // ACK the retained offline marker before suppressing the Will with DISCONNECT.
                    const bool offline_sent = publish(options.prefix + "/availability", "offline");
                    wake.wait_for(lock, std::chrono::seconds(1), [this] { return pending.empty() || !connected; });
                    if (offline_sent && connected && pending.empty()) mosquitto_disconnect(client);
                }
                lock.unlock();
            }
        } catch (const std::exception &error) {
            diagnostics.write(std::string("MQTT worker stopped: ") + error.what() + '\n');
        }
        if (client) {
            stop_loop(running);
            mosquitto_destroy(client);
            client = nullptr;
        }
        {
            std::lock_guard<std::mutex> lock(mutex);
            connected = false;
        }
        wake.notify_all();
    }
};

MqttPublisher::MqttPublisher(const MqttOptions &options, std::chrono::milliseconds fresh_for) {
    if (options.enabled) impl_ = std::make_unique<Impl>(options, fresh_for);
}
MqttPublisher::~MqttPublisher() = default;

void MqttPublisher::update(std::string json, bool healthy) {
    if (!impl_) return;
    {
        std::lock_guard<std::mutex> lock(impl_->mutex);
        impl_->latest = std::move(json);
        impl_->healthy = healthy;
        impl_->updated = Impl::Clock::now();
        ++impl_->generation;
    }
    impl_->wake.notify_all();
}

bool MqttPublisher::flush(std::chrono::milliseconds timeout) {
    if (!impl_) return true;
    std::unique_lock<std::mutex> lock(impl_->mutex);
    return impl_->wake.wait_for(lock, timeout, [this] {
        return impl_->connected && impl_->sent_generation == impl_->generation && impl_->pending.empty();
    });
}

} // namespace wallbox
