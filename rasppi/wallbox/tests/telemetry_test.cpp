#include "telemetry.hpp"

#include <cmath>
#include <iostream>
#include <stdexcept>

namespace {
void check(bool condition, const char *message) {
    if (!condition) throw std::runtime_error(message);
}

void set(wallbox::Registers &r, int address, std::uint32_t value) {
    const auto offset = static_cast<std::size_t>(address - wallbox::first_register);
    r.at(offset) = static_cast<std::uint16_t>(value >> 16);
    r.at(offset + 1) = static_cast<std::uint16_t>(value);
}

void test() {
    wallbox::Registers r{};
    for (unsigned state = 0; state < 128; ++state) {
        for (unsigned flag = 0; flag < 2; ++flag) {
            set(r, 0x400C, 0xABCD0000U | ((state | (flag << 7)) << 8) | 0x55U);
            const auto v = wallbox::decode(r);
            check(v.charging_state == state, "state byte/mask incorrect");
            check(v.below_commanded_current == (flag != 0), "flag mask incorrect");
            if (state <= 4) {
                check(v.plugged_in == std::optional<bool>(state != 0), "plugged state incorrect");
                check(v.charging == std::optional<bool>(state == 4), "charging state incorrect");
            } else check(!v.plugged_in && !v.charging, "unknown states must be null");
        }
    }
    for (const auto raw : {33792U, 33024U, 34048U, 33280U}) {
        set(r, 0x400C, raw);
        const auto v = wallbox::decode(r);
        check(v.charging_state == ((raw >> 8) & 0x7FU), "documented raw sample mismatch");
        check(v.below_commanded_current, "documented sample reduction flag missing");
    }
    set(r, 0x4008, 0xFEDCBA98U);
    set(r, 0x400A, 0x0111);
    set(r, 0x400E, 16000);
    set(r, 0x4010, 6123);
    set(r, 0x4012, 7890);
    set(r, 0x4014, 12345);
    set(r, 0x4016, 2301);
    set(r, 0x4018, 2312);
    set(r, 0x401A, 2299);
    set(r, 0x401C, 11000);
    set(r, 0x401E, 0xFFFFFFFFU);
    auto v = wallbox::decode(r);
    check(v.error_code == 0xFEDCBA98U, "32-bit big-endian decode failed");
    check(v.socket_lock_state == 273, "socket lock decode failed");
    check(v.current_limit_a == 16.0, "limit scaling failed");
    check(std::abs(v.current_a[0] - 6.123) < 0.000001 &&
          std::abs(v.current_a[1] - 7.890) < 0.000001 &&
          std::abs(v.current_a[2] - 12.345) < 0.000001, "current offsets/scaling failed");
    check(std::abs(v.voltage_v[0] - 230.1) < 0.000001 &&
          std::abs(v.voltage_v[1] - 231.2) < 0.000001 &&
          std::abs(v.voltage_v[2] - 229.9) < 0.000001, "voltage offsets/scaling failed");
    check(v.active_power_w == 11000 && v.session_energy_wh == 0xFFFFFFFFU,
          "power/energy decode failed");
    const std::string stamp = "2026-10-03T16:00:00Z";
    const auto ok = wallbox::sample_json(stamp, stamp, v, std::nullopt);
    check(ok.find("\"status\":\"ok\"") != std::string::npos, "success JSON missing");
    check(ok.find("4294967295") != std::string::npos, "unsigned JSON overflow");
    check(ok.find("\"error\":null") != std::string::npos, "success error must be null");
    const auto err = wallbox::sample_json(stamp, stamp, std::nullopt, "timeout\n\"test\"");
    check(err.find("\"values\":null") != std::string::npos, "stale values must be null");
    check(err.find("\"last_success_at\":\"" + stamp + "\"") != std::string::npos,
          "last success lost on error");
    const auto first_error = wallbox::sample_json(stamp, std::nullopt, std::nullopt, "offline");
    check(first_error.find("\"last_success_at\":null") != std::string::npos,
          "first failure must have no last success");
    check(wallbox::json_string(std::string("\"\\\n\r\t") + char(1)) ==
          "\"\\\"\\\\\\n\\r\\t\\u0001\"", "JSON escaping failed");
    set(r, 0x400C, 0x8500);
    v = wallbox::decode(r);
    const auto unknown = wallbox::sample_json(stamp, stamp, v, std::nullopt);
    check(unknown.find("\"plugged_in\":null,\"charging\":null") != std::string::npos,
          "unknown state serialization failed");
}
} // namespace

int main() {
    try {
        test();
        std::cout << "All wallbox telemetry tests passed\n";
        return 0;
    } catch (const std::exception &e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
