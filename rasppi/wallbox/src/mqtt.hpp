#pragma once

#include <chrono>
#include <memory>
#include <string>

namespace wallbox {

struct MqttOptions {
    bool enabled = false;
    std::string host = "mqtt-broker";
    int port = 1883;
    std::string prefix = "evse/wallbox";
    std::string client_id = "evse-wallbox-reader";
    std::string username;
    std::string password;
};

MqttOptions mqtt_options_from_environment();

// Network I/O runs separately from Modbus. Latest snapshot replaces older ones;
// at most one two-message QoS-1 batch is in flight, never a history backlog.
class MqttPublisher {
public:
    explicit MqttPublisher(const MqttOptions &options, std::chrono::milliseconds fresh_for);
    ~MqttPublisher();
    MqttPublisher(const MqttPublisher &) = delete;
    MqttPublisher &operator=(const MqttPublisher &) = delete;
    void update(std::string json, bool healthy);
    bool flush(std::chrono::milliseconds timeout);
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace wallbox
