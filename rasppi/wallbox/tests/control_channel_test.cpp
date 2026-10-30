// Pure, network-free tests, including the private JSON vocabulary/serializer.
// Build THIS translation unit, not control_channel.cpp a second time. Link the
// existing write_core.cpp, libmodbus, libmosquitto and Threads; no client is made.
// Explicit checks (not assert) remain active in Release/NDEBUG builds.
#include "../src/control_channel.cpp"

#include <cstdlib>
#include <iostream>
#include <limits>
#include <vector>

namespace {
unsigned checks = 0;
void check(bool condition, const char *description) {
    ++checks;
    if (!condition) {
        std::cerr << "control_channel_test: " << description << '\n';
        std::exit(EXIT_FAILURE);
    }
}
const std::string id = "0123456789abcdef0123456789abcdef";
const std::string session = "abcdef0123456789abcdef0123456789";
const std::string lease = "ffffffffffffffffffffffffffffffff";

std::string payload(const std::string &operation, const std::string &current,
                    const std::string &sid = session, const std::string &key = lease) {
    return "v1|" + id + "|" + sid + "|" + key + "|" + operation + "|" + current;
}
void rejected(const std::string &wire) {
    check(!wallbox::parse_control_payload(wire), "invalid wire rejected");
}
void contains(const std::string &body, const std::string &fragment) {
    check(body.find(fragment) != std::string::npos, "expected JSON field");
}
void parser_tests() {
    using namespace wallbox;
    const auto inspect = parse_control_payload(payload("inspect", "0", "-", "-"));
    check(inspect.has_value(), "inspect accepted");
    check(inspect->id == id && inspect->session == "-" && inspect->lease == "-", "inspect identity");
    check(inspect->operation == ControlOperation::Inspect && inspect->current_ma == 0, "inspect fields");
    check(inspect->deadline == WriteClock::time_point{}, "parser does not assign deadline");
    for (const auto *operation : {"start", "set_current"}) {
        for (const auto current : {6000U, 6001U, 16000U, 31999U, 32000U}) {
            const auto request = parse_control_payload(payload(operation, std::to_string(current)));
            check(request.has_value(), "current bounds accepted");
            check(request->id == id && request->session == session && request->lease == lease, "command identity");
            check(request->current_ma == current && request->deadline == WriteClock::time_point{}, "typed current");
            check(std::string(control_operation_name(request->operation)) == operation, "typed operation");
        }
        for (const auto *current : {"0", "1", "5999", "32001", "4294967295", "4294967296",
                                   "18446744073709551616", "-6000", "+6000", "6000.0", "6e3",
                                   "06000", "00006000", "", " 6000", "6000 ", "6000\n", "6000\r",
                                   "\t6000", "6000|", "6\xC2\xA0" "000", "\xEF\xBC\x96" "000"})
            rejected(payload(operation, current));
        rejected(payload(operation, "6000", "-", lease));
        rejected(payload(operation, "6000", session, "-"));
    }
    const auto stop = parse_control_payload(payload("stop", "0"));
    check(stop && stop->operation == ControlOperation::Stop && stop->current_ma == 0, "stop accepted");
    for (const auto *current : {"1", "6000", "32000", "00", "000", "+0", "-0", "0\n", ""}) {
        rejected(payload("stop", current));
        rejected(payload("inspect", current, "-", "-"));
    }
    rejected(payload("inspect", "0", session, "-"));
    rejected(payload("inspect", "0", "-", lease));
    rejected(payload("inspect", "0", session, lease));
    rejected(payload("stop", "0", "-", "-"));
    for (const auto *operation : {"", "START", "Inspect", "set-current", "restart", "unlock", "start\n", " start"})
        rejected(payload(operation, "6000"));
    for (const auto &bad : std::vector<std::string>{"", std::string(31, 'a'), std::string(33, 'a'),
             std::string(32, 'A'), std::string(32, 'g'), std::string(32, ' '), std::string(32, '\0'),
             "0123456789abcdef0123456789abcde\n", "0123456789abcdef0123456789abcde/"}) {
        rejected("v1|" + bad + "|-|-|inspect|0");
        rejected(payload("stop", "0", bad, lease));
        rejected(payload("stop", "0", session, bad));
    }
    const std::string valid = payload("inspect", "0", "-", "-");
    rejected("");
    rejected("v2" + valid.substr(2));
    rejected(valid.substr(3));
    rejected("|" + valid);
    rejected(valid + "|");
    rejected(valid + "|unused");
    rejected(valid + '\0');
    rejected(valid + "\n");
    rejected(valid + "\r\n");
    rejected(valid.substr(0, valid.size() - 1));
    rejected(std::string(161, 'a'));
    rejected(payload("start", std::string(60, '9')));
    auto embedded_null = payload("start", "6000");
    embedded_null[embedded_null.size() - 2] = '\0';
    rejected(embedded_null);
    check(std::string(control_operation_name(ControlOperation::Inspect)) == "inspect", "inspect name");
    check(std::string(control_operation_name(ControlOperation::SetCurrent)) == "set_current", "current name");
    check(std::string(control_operation_name(ControlOperation::Start)) == "start", "start name");
    check(std::string(control_operation_name(ControlOperation::Stop)) == "stop", "stop name");
    check(std::string(control_operation_name(static_cast<ControlOperation>(99))) == "invalid", "unknown enum name");
}
void json_tests() {
    using namespace wallbox;
    auto request = *parse_control_payload(payload("inspect", "0", "-", "-"));
    ControlReply reply;
    reply.status = "ok";
    reply.reason = "inspection_complete";
    reply.hardware_max_ma = 63000;
    reply.installation_max_ma = 16000;
    reply.firmware_raw = std::numeric_limits<std::uint32_t>::max();
    auto body = serialize(request, reply, session, lease);
    contains(body, "\"schema_version\":1");
    contains(body, "\"id\":\"" + id + "\"");
    contains(body, "\"operation\":\"inspect\"");
    contains(body, "\"session\":\"" + session + "\"");
    contains(body, "\"lease\":\"" + lease + "\"");
    contains(body, "\"fresh_for_seconds\":8");
    contains(body, "\"read_only\":true");
    contains(body, "\"minimum_ma\":6000,\"software_max_ma\":32000");
    contains(body, "\"effective_max_ma\":16000");
    contains(body, "\"firmware_raw\":4294967295");
    contains(body, "\"write\":null,\"preparation\":null");
    reply.installation_max_ma = 32000;
    reply.hardware_max_ma = 32000;
    contains(serialize(request, reply, session, {}), "\"effective_max_ma\":32000");
    reply.hardware_max_ma = 10000;
    contains(serialize(request, reply, session, {}), "\"effective_max_ma\":10000");
    for (const auto invalid : {0U, 5999U, 32001U, 4294967295U}) {
        reply.installation_max_ma = invalid;
        contains(serialize(request, reply, session, {}), "\"effective_max_ma\":null");
    }
    reply.installation_max_ma = 16000;
    reply.hardware_max_ma = 5999;
    contains(serialize(request, reply, session, {}), "\"effective_max_ma\":null");
    reply.hardware_max_ma.reset();
    contains(serialize(request, reply, session, {}), "\"effective_max_ma\":null");
    reply.installation_max_ma.reset();
    reply.firmware_raw.reset();
    reply.status = "untrusted\"host";
    reply.reason = "untrusted\"payload";
    body = serialize(request, reply, session, {});
    contains(body, "\"status\":\"unavailable\",\"reason\":\"reader_unavailable\"");
    contains(body, "\"lease\":null,\"fresh_for_seconds\":0");
    check(body.find("untrusted") == std::string::npos, "untrusted labels not serialized");
    request = *parse_control_payload(payload("start", "16000"));
    WriteResult outcome;
    outcome.status = WriteStatus::OutcomeUnknown;
    outcome.reason = "write_outcome_unknown";
    outcome.attempted = true;
    outcome.hardware_max_ma = 32000;
    outcome.effective_current_ma = 0;
    outcome.charging_state_raw = 0x8500;
    outcome.charging_observed = false;
    outcome.transport_errno = 12345;
    reply.write = outcome;
    outcome.status = WriteStatus::Acknowledged;
    outcome.reason = "protocol_ack_only";
    outcome.acknowledged = true;
    reply.preparation = outcome;
    body = serialize(request, reply, session, {});
    contains(body, "\"read_only\":false");
    contains(body, "\"status\":\"outcome_unknown\",\"reason\":\"write_outcome_unknown\"");
    contains(body, "\"attempted\":true,\"acknowledged\":false");
    contains(body, "\"status\":\"acknowledged\",\"reason\":\"protocol_ack_only\"");
    contains(body, "\"effective_current_ma\":0");
    contains(body, "\"charging_state_raw\":34048,\"charging_observed\":false");
    check(body.find("transport_errno") == std::string::npos && body.find("12345") == std::string::npos,
          "transport details not exposed");
    reply.write->reason = "secret\"raw";
    reply.write->charging_observed.reset();
    body = serialize(request, reply, session, {});
    contains(body, "\"charging_observed\":null");
    check(body.find("secret") == std::string::npos, "write reason sanitized");
    check(body.size() <= 4096, "bounded JSON result");
    for (const auto status : {WriteStatus::Disabled, WriteStatus::InvalidRequest, WriteStatus::ExpiredNotSent,
             WriteStatus::CancelledNotSent, WriteStatus::WrongThread, WriteStatus::NotConnected,
             WriteStatus::PreflightFailedNotSent, WriteStatus::PreparationRequired, WriteStatus::RecoveryRequired,
             WriteStatus::Acknowledged, WriteStatus::RejectedByDevice, WriteStatus::OutcomeUnknown}) {
        const auto name = std::string(write_status_name(status));
        check(label(name, true) == name, "all WriteCore status labels preserved");
    }
    for (const auto *reason : {"inspection_complete", "reader_unavailable", "queue_full", "lease_capacity",
             "invalid_session", "invalid_lease", "deadline_elapsed", "invalid_request", "writes_disabled",
             "owner_thread_required", "new_session_required", "invalid_operation", "explicit_installation_limit_required",
             "invalid_current", "deadline_too_distant", "shutdown_requested", "connected_context_required",
             "unicast_rtu_context_required", "fresh_limit_ack_required", "cancelled_after_ack", "deadline_after_ack",
             "timeout_configuration_failed", "observation_read_failed", "invalid_hardware_limit", "above_hardware_limit",
             "active_wallbox_fault", "charging_state_unknown", "effective_limit_above_request", "write_outcome_unknown",
             "device_exception", "protocol_ack_only", "session_changed", "inspection_failed", "serial_unavailable",
             "inspection_read_failed", "hardware_read_failed", "modbus_unavailable", "read_only_inspection",
             "fresh_inspection_required"})
        check(label(reason) == reason, "trusted reason preserved");
    for (const auto *reason : {"", "UNKNOWN", "device_exception:private", "host.example", "ok\n", "\"", "\\"})
        check(label(reason) == "reader_unavailable", "unknown reason replaced");
}
} // namespace

int main() {
    parser_tests();
    json_tests();
    std::cout << "control_channel_test: " << checks << " checks passed\n";
    return EXIT_SUCCESS;
}
