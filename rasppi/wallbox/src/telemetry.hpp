#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <string>

namespace wallbox {

constexpr int first_register = 0x4008;
constexpr int register_count = 24; // 0x4008 through 0x401F, no undocumented gaps
using Registers = std::array<std::uint16_t, register_count>;

struct Telemetry {
    std::uint32_t error_code;
    std::uint32_t socket_lock_state;
    std::uint32_t charging_state_raw;
    unsigned charging_state;
    bool below_commanded_current;
    std::optional<bool> plugged_in;
    std::optional<bool> charging;
    double current_limit_a;
    std::array<double, 3> current_a;
    std::array<double, 3> voltage_v;
    std::uint32_t active_power_w;
    std::uint32_t session_energy_wh;
};

Telemetry decode(const Registers &registers);
std::string json_string(const std::string &text);
std::string sample_json(const std::string &timestamp,
                        const std::optional<std::string> &last_success,
                        const std::optional<Telemetry> &values,
                        const std::optional<std::string> &error);

} // namespace wallbox
