#include "automation.hpp"
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <ctime>
#include <mutex>

namespace wallbox::automation {
const char *status_name(Status s) noexcept {
    switch (s) {
#define S(a,b) case Status::a: return b
    S(AwaitingActivation,"awaiting_activation"); S(Manual,"manual");
    S(ManualOverride,"manual_override"); S(Frozen,"frozen");
    S(InvalidConfiguration,"invalid_configuration"); S(SourceUnavailable,"source_unavailable");
    S(ManualHandling,"manual_handling"); S(Unplugged,"unplugged");
    S(Adjusting,"adjusting"); S(Pausing,"pausing"); S(Resuming,"resuming");
    S(AwaitingStart,"awaiting_start"); S(AwaitingStop,"awaiting_stop");
    S(Charging,"charging"); S(VehicleFinished,"vehicle_finished");
#undef S
    }
    return "frozen";
}
void initialize_vienna_timezone() {
    static std::once_flag once;
    std::call_once(once, [] { setenv("TZ", "Europe/Vienna", 1); tzset(); });
}
bool schedule_contains(const Profile &p, double utc) {
    if (!std::isfinite(utc) || utc < 0 || utc > 4102444800.0) return false;
    const auto t = static_cast<time_t>(utc);
    tm local{};
    if (!localtime_r(&t, &local)) return false;
    const int day = local.tm_wday == 0 ? 7 : local.tm_wday;
    const int previous = day == 1 ? 7 : day - 1;
    const int minute = local.tm_hour * 60 + local.tm_min;
    auto has = [&](int d) { return std::find(p.weekdays.begin(), p.weekdays.end(), d) != p.weekdays.end(); };
    for (auto w : p.windows) {
        if (w.from < 0 || w.from > 1439 || w.to < 0 || w.to > 1439 || w.from == w.to) continue;
        if (w.from < w.to && has(day) && minute >= w.from && minute < w.to) return true;
        if (w.from > w.to && ((has(day) && minute >= w.from) || (has(previous) && minute < w.to))) return true;
    }
    return false;
}
namespace {
bool range(const std::optional<int> &v, int lo, int hi) { return v && *v >= lo && *v <= hi; }
bool valid_profile(const Profile &p) {
    return range(p.max_import_w,0,2000000000) && range(p.max_current_ma,6000,32000)
        && range(p.adjust_seconds,0,3600) && range(p.pause_seconds,0,3600) && range(p.resume_seconds,0,3600);
}
bool fresh(double expiry, double now) { return std::isfinite(expiry) && expiry > now; }
bool valid_schedule(const Profile &p) {
    if (!p.use_schedule || !p.pv_enabled) return false;
    if (!*p.use_schedule) return true;
    if (p.weekdays.empty() || p.weekdays.size()>7 || p.windows.empty() || p.windows.size()>16 || p.outside==Profile::Outside::Unset) return false;
    for (int d:p.weekdays) if (d<1 || d>7) return false;
    for (auto w:p.windows) if (w.from<0 || w.from>1439 || w.to<0 || w.to>1439 || w.from==w.to) return false;
    return true;
}
}
bool action_is_current(const Action &a, const Input &i) noexcept {
    return std::isfinite(i.now) && i.bus_connected && i.now < a.deadline
        && a.activation == i.sources.settings.activation && a.revision == i.sources.settings.revision
        && a.source_generation == i.sources.generation && !i.sources.clock_error
        && i.sample && std::isfinite(i.sample_at) && i.sample_at>=0 && i.sample_at<=i.now && fresh(i.sample_expires,i.now)
        && (a.operation == Operation::Stop || (i.sources.settings.valid && fresh(i.sources.settings.expires,i.now)
            && i.sample->plugged_in.value_or(false) && i.sample->error_code==0
            && i.hardware_max_ma && fresh(i.hardware_expires,i.now) && i.installation_max_ma
            && a.target_ma>=6000 && a.target_ma<=std::min({32000,*i.hardware_max_ma,*i.installation_max_ma})
            && (!a.requires_house || (i.sources.house.valid && fresh(i.sources.house.expires,i.now)))));
}
void Engine::reset_activation(const Settings &s) {
    activation_=s.activation; revision_=s.revision; mode_=s.mode; armed_=s.mode!=Mode::Manual;
    frozen_=manual_=start_wait_=stop_wait_=auto_stopped_=observed_running_=finished_=unplugged_=false;
    ack_target_.reset(); candidate_.reset(); pending_.reset();
}
void Engine::manual_override() noexcept { manual_=true; pending_.reset(); candidate_.reset(); status_=Status::ManualOverride; }
bool Engine::accepts(const Action &a,const Input &i) const noexcept {
    return pending_ && pending_->serial==a.serial && !manual_ && !frozen_ && action_is_current(a,i);
}
std::optional<Action> Engine::issue(Operation op,int ma,const Input &i) {
    Action a{op,ma,++serial_,i.sources.generation,i.sources.settings.activation,i.sources.settings.revision,i.now+3};
    a.requires_house=op!=Operation::Stop && (i.sources.settings.mode==Mode::Pv || i.sources.settings.custom.pv_enabled.value_or(true));
    command_sample_at_=i.sample_at;
    pending_=a; candidate_.reset(); return a;
}
void Engine::complete(const Action &a, Outcome result) {
    if (!pending_ || pending_->serial!=a.serial) return;
    pending_.reset();
    if (!result.acknowledged) {
        if (result.attempted) { frozen_=true; status_=Status::Frozen; }
        return;
    }
    if (a.operation==Operation::Stop) { stop_wait_=true; start_wait_=false; auto_stopped_=true; }
    else { ack_target_=a.target_ma; if(a.operation==Operation::Start) start_wait_=true; }
}
std::optional<Action> Engine::step(const Input &i) {
    const auto &s=i.sources.settings;
    if (!std::isfinite(i.now) || !std::isfinite(i.utc) || (have_clock_ &&
        (i.now<last_now_ || i.utc<last_utc_ || std::abs((i.utc-last_utc_)-(i.now-last_now_))>2))) frozen_=true;
    last_now_=i.now; last_utc_=i.utc; have_clock_=true;
    if (!i.bus_connected || i.sources.clock_error) frozen_=true;
    if (s.valid && fresh(s.expires,i.now) && !s.activation.empty()) {
        if (!baseline_) { baseline_=true; activation_=s.activation; revision_=s.revision; mode_=s.mode; }
        else if (s.activation!=activation_) reset_activation(s);
        else if (armed_ && (s.revision!=revision_ || s.mode!=mode_)) frozen_=true; // saving never activates
    }
    if (!i.bus_connected || i.sources.clock_error) frozen_=true;
    if (manual_) { status_=Status::ManualOverride; return {}; }
    if (frozen_) { status_=Status::Frozen; return {}; }
    if (!armed_) { status_=baseline_ && s.mode==Mode::Manual?Status::Manual:Status::AwaitingActivation; return {}; }
    if (pending_) return {};
    bool sample_ok=i.bus_connected && i.sample && std::isfinite(i.sample_at) && i.sample_at>=0 && i.sample_at<=i.now && fresh(i.sample_expires,i.now);
    const auto *v=sample_ok?&*i.sample:nullptr;
    if (v && v->plugged_in && !*v->plugged_in) {
        unplugged_=true; finished_=false; start_wait_=stop_wait_=false; observed_running_=false;
        ack_target_.reset(); candidate_.reset(); status_=Status::Unplugged; return {};
    }
    if (v && v->charging && (!(start_wait_ || stop_wait_) || i.sample_at>command_sample_at_)) {
        if (*v->charging) { observed_running_=true; start_wait_=false; }
        else {
            if (stop_wait_) { stop_wait_=false; observed_running_=false; }
            else if (observed_running_) { finished_=true; observed_running_=false; }
        }
    }
    if (unplugged_ && v && v->plugged_in.value_or(false)) { unplugged_=false; finished_=false; }
    const auto &p=s.mode==Mode::Pv?s.pv:s.custom;
    bool config_ok=valid_profile(p) && range(s.phases,1,3) && s.meter_includes_wallbox.has_value()
        && range(i.installation_max_ma,6000,32000)
        && (s.mode!=Mode::Custom || valid_schedule(p));
    bool outside=s.mode==Mode::Custom && p.use_schedule.value_or(false) && !schedule_contains(p,i.utc);
    if (s.valid && fresh(s.expires,i.now) && config_ok && outside && p.outside==Profile::Outside::Manual) {
        candidate_.reset(); status_=Status::ManualHandling; return {};
    }
    bool feedback=s.mode==Mode::Pv || p.pv_enabled.value_or(true);
    bool sources_ok=s.valid && fresh(s.expires,i.now) && config_ok && v && v->plugged_in.value_or(false)
        && v->charging.has_value() && v->error_code==0 && range(i.hardware_max_ma,6000,2000000000) && fresh(i.hardware_expires,i.now);
    double per_amp=0;
    if (sources_ok && feedback) {
        int count=0; double max_v=0;
        for (double voltage:v->voltage_v) if(std::isfinite(voltage) && voltage>=150 && voltage<=300) { ++count; max_v=std::max(max_v,voltage); }
        sources_ok=count>=*s.phases && i.sources.house.valid && fresh(i.sources.house.expires,i.now) && std::isfinite(i.sources.house.power_w);
        per_amp=*s.phases*max_v;
    }
    if (!sources_ok) {
        candidate_.reset(); status_=config_ok?Status::SourceUnavailable:Status::InvalidConfiguration;
        if (v && (v->charging.value_or(false) || start_wait_) && !stop_wait_) return issue(Operation::Stop,0,i);
        return {};
    }
    if (stop_wait_) { status_=Status::AwaitingStop; return {}; }
    if (start_wait_) { status_=Status::AwaitingStart; return {}; }
    int target=std::min({*p.max_current_ma,*i.installation_max_ma,*i.hardware_max_ma,32000});
    target=(target/1000)*1000;
    if (feedback) {
        double budget=*p.max_import_w-i.sources.house.power_w+(*s.meter_includes_wallbox?v->active_power_w:0.0);
        double amps=std::floor(budget/per_amp);
        target=amps<6?0:std::min(target,static_cast<int>(std::min(amps,32.0))*1000);
    }
    if (outside) target=0;
    if (target<6000) target=0;
    const bool charging=*v->charging;
    if (!target && !charging) { candidate_.reset(); status_=Status::Pausing; return {}; }
    if (target && finished_ && !charging && !auto_stopped_) { status_=Status::VehicleFinished; return {}; }
    if (target && charging && ack_target_ && target==*ack_target_) { candidate_.reset(); status_=Status::Charging; return {}; }
    if (!candidate_ || *candidate_!=target) { candidate_=target; candidate_since_=i.now; }
    const int delay=!target?*p.pause_seconds:(!charging?*p.resume_seconds:*p.adjust_seconds);
    status_=!target?Status::Pausing:(!charging?Status::Resuming:Status::Adjusting);
    if (i.now-candidate_since_<delay) return {};
    if (!target) return issue(Operation::Stop,0,i);
    if (!charging) { auto_stopped_=false; return issue(Operation::Start,target,i); }
    return issue(Operation::SetCurrent,target,i);
}
} // namespace wallbox::automation
