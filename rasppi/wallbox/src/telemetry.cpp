#include "telemetry.hpp"

#include <iomanip>
#include <locale>
#include <sstream>

namespace wallbox {
namespace {

std::uint32_t value_at(const Registers &registers, int address) {
    const auto offset = static_cast<std::size_t>(address - first_register);
    return (static_cast<std::uint32_t>(registers.at(offset)) << 16) |
           registers.at(offset + 1);
}

const char *boolean(const std::optional<bool> &value) {
    return value ? (*value ? "true" : "false") : "null";
}

void array_json(std::ostream &out, const std::array<double, 3> &values) {
    out << '[' << values[0] << ',' << values[1] << ',' << values[2] << ']';
}

} // namespace

Telemetry decode(const Registers &registers) {
    Telemetry result{};
    result.error_code = value_at(registers, 0x4008);
    result.socket_lock_state = value_at(registers, 0x400A);
    result.charging_state_raw = value_at(registers, 0x400C);
    const auto state_byte = (result.charging_state_raw >> 8) & 0xFFU;
    result.charging_state = state_byte & 0x7FU;
    result.below_commanded_current = (state_byte & 0x80U) != 0;
    // ABB's "Others" (5) and unrecognized states do not prove connection/charging.
    if (result.charging_state <= 4) {
        result.plugged_in = result.charging_state != 0;
        result.charging = result.charging_state == 4;
    }
    result.current_limit_a = value_at(registers, 0x400E) / 1000.0;
    for (int phase = 0; phase < 3; ++phase) {
        result.current_a[phase] = value_at(registers, 0x4010 + phase * 2) / 1000.0;
        result.voltage_v[phase] = value_at(registers, 0x4016 + phase * 2) / 10.0;
    }
    result.active_power_w = value_at(registers, 0x401C);
    result.session_energy_wh = value_at(registers, 0x401E);
    return result;
}

std::string json_string(const std::string &text) {
    std::ostringstream out;
    out << '"';
    for (unsigned char c : text) {
        switch (c) {
        case '"': out << "\\\""; break;
        case '\\': out << "\\\\"; break;
        case '\n': out << "\\n"; break;
        case '\r': out << "\\r"; break;
        case '\t': out << "\\t"; break;
        default:
            if (c < 0x20) {
                out << "\\u" << std::hex << std::setw(4) << std::setfill('0')
                    << static_cast<unsigned>(c) << std::dec;
            } else {
                out << static_cast<char>(c);
            }
        }
    }
    out << '"';
    return out.str();
}

std::string sample_json(const std::string &timestamp,
                        const std::optional<std::string> &last_success,
                        const std::optional<Telemetry> &values,
                        const std::optional<std::string> &error) {
    std::ostringstream out;
    out.imbue(std::locale::classic());
    out << std::fixed << std::setprecision(3);
    out << "{\"schema_version\":1,\"device\":\"abb_terra_ac\",\"timestamp\":"
        << json_string(timestamp) << ",\"status\":" << (values ? "\"ok\"" : "\"error\"")
        << ",\"last_success_at\":" << (last_success ? json_string(*last_success) : "null")
        << ",\"values\":";
    if (!values) {
        out << "null"; // Do not present a stale snapshot as a current measurement.
    } else {
        const auto &v = *values;
        out << "{\"error_code\":" << v.error_code
            << ",\"socket_lock_state\":" << v.socket_lock_state
            << ",\"charging_state_raw\":" << v.charging_state_raw
            << ",\"charging_state\":" << v.charging_state
            << ",\"below_commanded_current\":" << (v.below_commanded_current ? "true" : "false")
            << ",\"plugged_in\":" << boolean(v.plugged_in)
            << ",\"charging\":" << boolean(v.charging)
            << ",\"current_limit_a\":" << v.current_limit_a
            << ",\"current_a\":";
        array_json(out, v.current_a);
        out << ",\"voltage_v\":";
        array_json(out, v.voltage_v);
        out << ",\"active_power_w\":" << v.active_power_w
            << ",\"session_energy_wh\":" << v.session_energy_wh << '}';
    }
    out << ",\"error\":" << (error ? json_string(*error) : "null") << '}';
    return out.str();
}

} // namespace wallbox
