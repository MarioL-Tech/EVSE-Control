#include "automation.hpp"
#include "automation_http.hpp"
#include <chrono>
#include <ctime>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <thread>

using namespace wallbox;
using namespace wallbox::automation;
// Do NOT use assert: all checks remain active in Release builds.
void check(bool yes,const char *why) { if(!yes) throw std::runtime_error(why); }
Profile profile() {
    Profile p; p.max_import_w=0; p.max_current_ma=32000; p.adjust_seconds=0;
    p.pause_seconds=0; p.resume_seconds=0; p.use_schedule=false; p.pv_enabled=false; return p;
}
Input input() {
    Input i; i.now=100; i.sample_at=100; i.utc=1793383200; i.bus_connected=true;
    i.sample_expires=i.hardware_expires=10000; i.installation_max_ma=32000; i.hardware_max_ma=32000;
    Telemetry v{}; v.plugged_in=true; v.charging=false; v.voltage_v={230,240,235}; v.active_power_w=0;
    i.sample=v; i.sources.settings.valid=true; i.sources.settings.expires=10000;
    i.sources.settings.revision=std::string(64,'a'); i.sources.settings.activation=std::string(32,'a');
    i.activation_guard=i.sources.settings.guard=std::string(32,'1');
    i.sources.settings.mode=Mode::Pv; i.sources.settings.pv=profile(); i.sources.settings.custom=profile();
    i.sources.settings.phases=3; i.sources.settings.meter_includes_wallbox=false;
    i.sources.house={true,10000,1793383199,-7200}; return i;
}
void tick(Input &i,double seconds=1) { i.now+=seconds; i.utc+=seconds; i.sample_at=i.now; }
void activate(Engine &e,Input &i) {
    check(!e.step(i),"boot must not activate");
    i.sources.settings.activation=std::string(32,'b'); tick(i);
    // Observe the explicit activation before a case tests a later override,
    // save or clock failure. Account for the initial ticket without any IO.
    if (auto initial=e.step(i)) e.complete(*initial,{false,false});
}
Action need(Engine &e,Input &i,Operation op,int ma=0) {
    auto a=e.step(i); check(a.has_value(),"missing action"); check(a->operation==op,"wrong operation");
    check(a->target_ma==ma,"wrong target"); return *a;
}
void tests() {
    initialize_vienna_timezone();
    { Engine e; auto i=input(); i.utc+=58; i.sources.settings.mode=Mode::Custom;
      const auto epoch=static_cast<time_t>(i.utc); tm local{}; localtime_r(&epoch,&local);
      const int minute=local.tm_hour*60+local.tm_min;
      auto &p=i.sources.settings.custom; p.use_schedule=true; p.weekdays={local.tm_wday==0?7:local.tm_wday};
      p.windows={{minute,(minute+1)%1440}}; p.outside=Profile::Outside::Pause;
      activate(e,i); auto a=need(e,i,Operation::Start,32000); tick(i);
      check(!action_is_current(a,i),"time-window end cancels increase even inside its monotonic ticket"); }
    { Engine e; auto i=input(); activate(e,i); auto a=need(e,i,Operation::Start,10000);
      e.complete(a,{true,false});
      for(char old : {'a','b'}) { i.sources.settings.activation=std::string(32,old); tick(i);
        check(!e.step(i) && e.status()==Status::Frozen,"replayed activation cannot clear freeze"); }
      i.sources.settings.activation=std::string(32,'c'); tick(i); need(e,i,Operation::Start,10000); }
    { Engine e; auto i=input(); activate(e,i);
      for(int n=0;n<4096;++n) { auto id=std::to_string(n); i.sources.settings.activation=std::string(32-id.size(),'0')+id;
        tick(i); if(auto a=e.step(i)) e.complete(*a,{false,false}); }
      check(!e.step(i) && e.status()==Status::Frozen,"bounded activation history never evicts replay evidence"); }
    { Engine e; auto i=input(); activate(e,i); auto a=need(e,i,Operation::Start,10000);
      check(action_is_current(a,i),"valid ticket"); ++i.sources.generation; check(!action_is_current(a,i),"cancel generation");
      --i.sources.generation;
      i.sources.house.power_w=-7300; check(action_is_current(a,i),"newer sufficient surplus is not a cancelled session");
      i.sources.house.power_w=-7100; check(!action_is_current(a,i),"latest insufficient budget prevents IO");
      i.sources.house.power_w=-7200; ++i.sources.generation;
      --i.sources.generation; i.sources.house.expires=i.now; check(!action_is_current(a,i),"cancel house expiry");
      i.sources.house.expires=10000; e.complete(a,{true,true}); tick(i); check(!e.step(i),"no duplicate start");
      i.sample->charging=true; tick(i); check(!e.step(i),"ACK desired target, ignore effective limit");
      i.sample->charging=false; tick(i); check(!e.step(i) && e.status()==Status::VehicleFinished,"vehicle finished");
      i.sample->plugged_in=false; tick(i); check(!e.step(i),"unplug");
      i.sample->plugged_in=true; tick(i); need(e,i,Operation::Start,10000); }
    { Engine e; auto i=input(); activate(e,i); auto a=need(e,i,Operation::Start,10000);
      e.complete(a,{true,false}); tick(i); check(!e.step(i) && e.status()==Status::Frozen,"unknown freezes");
      e.complete(a,{true,true}); tick(i); check(!e.step(i),"late ACK cannot unfreeze");
      i.sources.settings.activation=std::string(32,'c'); tick(i); need(e,i,Operation::Start,10000); }
    { Engine e; auto i=input(); activate(e,i); e.manual_override(); tick(i);
      check(!e.step(i) && e.status()==Status::ManualOverride,"manual stop latch");
      i.sources.settings.revision=std::string(64,'c'); tick(i); check(!e.step(i),"save cannot activate");
      i.sources.settings.activation=std::string(32,'c'); tick(i); need(e,i,Operation::Start,10000); }
    { Engine e; auto i=input(); activate(e,i); auto a=need(e,i,Operation::Start,10000);
      check(e.accepts(a,i),"owner gate before IO"); e.manual_override();
      check(!e.accepts(a,i),"manual override cancels outstanding ticket"); }
    { Engine e; auto i=input(); activate(e,i); i.sample->charging=true;
      i.sources.house.power_w=1; auto a=need(e,i,Operation::Stop); e.complete(a,{true,true});
      i.sample->charging=false; check(!e.step(i) && e.status()==Status::AwaitingStop,"pre-command false cannot prove stop");
      tick(i); check(!e.step(i),"fresh stopped observation"); }
    { Engine e; auto i=input(); activate(e,i); i.sample->charging=true;
      auto a=need(e,i,Operation::SetCurrent,10000); e.complete(a,{true,true});
      i.sample->current_limit_a=6; tick(i); check(!e.step(i),"internal load manager not echo");
      i.sources.house.valid=false; tick(i); a=need(e,i,Operation::Stop); e.complete(a,{true,true});
      tick(i); check(!e.step(i),"stop ACK no resend while charging");
      i.sample->charging=false; tick(i); check(!e.step(i),"unavailable stopped");
      i.sources.house.valid=true; i.sources.settings.pv.resume_seconds=2; tick(i); check(!e.step(i),"resume delay");
      tick(i,2); need(e,i,Operation::Start,10000); }
    { Engine e; auto i=input(); activate(e,i); i.sources.settings.pv.pause_seconds=2; i.sources.house.power_w=1; i.sample->charging=true;
      check(!e.step(i),"pause delay"); tick(i); check(!e.step(i),"pause delay second"); tick(i); auto a=need(e,i,Operation::Stop);
      e.complete(a,{true,true}); tick(i); check(!e.step(i),"hold stop"); }
    { Engine e; auto i=input(); activate(e,i); i.sources.settings.pv.adjust_seconds=2; i.sample->charging=true;
      check(!e.step(i),"adjust delay"); tick(i,2); need(e,i,Operation::SetCurrent,10000); }
    for(int missing=0;missing<13;++missing) {
      Engine e; auto i=input(); activate(e,i);
      switch(missing) {
      case 0:i.sources.settings.phases.reset();break; case 1:i.sources.settings.meter_includes_wallbox.reset();break;
      case 2:i.installation_max_ma.reset();break;case 3:i.hardware_max_ma.reset();break;
      case 4:i.sources.settings.pv.max_import_w.reset();break;case 5:i.sources.settings.pv.max_current_ma.reset();break;
      case 6:i.sources.settings.pv.adjust_seconds.reset();break;case 7:i.sources.settings.pv.pause_seconds.reset();break;
      case 8:i.sources.settings.pv.resume_seconds.reset();break;case 9:i.sample->plugged_in.reset();break;
      case 10:i.sample->charging.reset();break;case 11:i.sample->voltage_v={0,0,230};break;
      case 12:i.hardware_expires=i.now;break;
      } check(!e.step(i),"missing required evidence must not start");
    }
    { Engine e; auto i=input(); activate(e,i); i.sources.settings.phases=1; i.sources.house.power_w=-1000000;
      i.hardware_max_ma=32000; i.installation_max_ma=16000; need(e,i,Operation::Start,16000); }
    { Engine e; auto i=input(); activate(e,i); i.sources.settings.phases=1;
      i.sources.settings.meter_includes_wallbox=true; i.sources.house.power_w=0; i.sample->active_power_w=1440;
      need(e,i,Operation::Start,6000); }
    { Engine e; auto i=input(); activate(e,i); i.sources.house.power_w=-4319;
      check(!e.step(i),"below six whole amps must pause"); }
    { Engine e; auto i=input(); activate(e,i); i.sources.house.power_w=-7199;
      need(e,i,Operation::Start,9000); }
    { Engine e; auto i=input(); check(!e.step(i),"restart persisted activation baseline");
      tick(i); check(!e.step(i),"persisted activation cannot resume"); }
    { Engine e; auto i=input(); activate(e,i); tick(i); i.utc+=10; check(!e.step(i) && e.status()==Status::Frozen,"clock jump"); }
    { Engine e; auto i=input(); activate(e,i); i.sample->charging=true;
      auto adjust=need(e,i,Operation::SetCurrent,10000); e.complete(adjust,{true,true});
      tick(i); i.utc+=10;
      auto stop=need(e,i,Operation::Stop);
      check(stop.clock_protection && e.accepts(stop,i),"clock fault permits only one bounded protective Stop");
      auto invalid=i; invalid.now=stop.deadline;
      check(!e.accepts(stop,invalid),"clock protection does not extend monotonic deadline");
      e.complete(stop,{true,true});
      tick(i); check(!e.step(i),"clock fault cannot repeat Stop");
      tick(i); check(!e.step(i) && e.status()==Status::Frozen,"stable corrected clock never resumes automatically");
      i.sources.settings.activation=std::string(32,'c'); i.sample->charging=false; tick(i);
      need(e,i,Operation::Start,10000); }
    { Engine e; auto i=input(); activate(e,i); i.bus_connected=false; check(!e.step(i),"disconnect");
      i.bus_connected=true; tick(i); check(!e.step(i) && e.status()==Status::Frozen,"disconnect latch"); }
    { Engine e; auto i=input(); activate(e,i); i.sources.settings.revision=std::string(64,'c');
      check(!e.step(i) && e.status()==Status::Frozen,"revision is not activation"); }
    { Engine e; auto i=input(); i.sources.settings.mode=Mode::Custom; activate(e,i);
      i.sources.house.valid=false; need(e,i,Operation::Start,32000); }
    { Engine e; auto i=input(); i.sources.settings.mode=Mode::Custom; activate(e,i);
      auto &p=i.sources.settings.custom; p.use_schedule=true; p.weekdays={1}; p.windows={{0,1}}; p.outside=Profile::Outside::Manual;
      check(!e.step(i) && e.status()==Status::ManualHandling,"outside manual leaves charge unchanged");
      p.outside=Profile::Outside::Pause; i.sample->charging=true; need(e,i,Operation::Stop); }
    { Engine e; auto i=input(); activate(e,i); auto a=need(e,i,Operation::Start,10000);
      e.complete(a,{true,true}); i.sources.settings.valid=false; tick(i); need(e,i,Operation::Stop); }
    // A new nonce must not erase a fault in the very same observation.
    for (int fault=0;fault<4;++fault) {
      Engine e; auto i=input(); activate(e,i); i.sources.settings.activation=std::string(32,'c'); auto good=i;
      if(fault==0) i.utc=std::numeric_limits<double>::quiet_NaN();
      if(fault==1) i.utc=std::numeric_limits<double>::infinity();
      if(fault==2) i.utc-=10;
      if(fault==3) i.utc+=10;
      check(!e.step(i) && e.status()==Status::Frozen,"same-step nonce cannot erase clock fault");
      i=good; check(!e.step(i) && e.status()==Status::Frozen,"good clock cannot erase freeze");
      i.sources.settings.activation=std::string(32,'d'); tick(i); need(e,i,Operation::Start,10000);
    }
    for (int fault=0;fault<4;++fault) {
      Engine e; auto i=input(); activate(e,i); auto a=need(e,i,Operation::Start,10000); auto good=i;
      if(fault==0) i.utc=std::numeric_limits<double>::quiet_NaN();
      if(fault==1) i.utc=std::numeric_limits<double>::infinity();
      if(fault==2) i.utc-=1;
      if(fault==3) i.utc+=10;
      check(!action_is_current(a,i) && !e.accepts(a,i),"invalid clock forbids IO");
      e.complete(a,{false,false}); i=good; tick(i);
      check(!e.step(i) && e.status()==Status::Frozen,"IO clock fault is latched");
    }
    for(int expiry=0;expiry<2;++expiry) {
      Engine e; auto i=input(); activate(e,i); i.sample->charging=true;
      auto a=need(e,i,Operation::SetCurrent,10000); e.complete(a,{true,true}); tick(i);
      if(expiry) i.sample_expires=i.now; else i.sample->charging.reset();
      a=need(e,i,Operation::Stop); check(e.accepts(a,i),"safety stop needs no fresh bool/sample/cap");
      i.hardware_max_ma.reset(); i.hardware_expires=0;
      check(action_is_current(a,i),"Stop independent of hardware readback");
      e.complete(a,{true,true}); tick(i); check(!e.step(i),"unknown cannot repeat acknowledged Stop");
      i.sample_expires=10000; i.sample->charging=true; tick(i); check(!e.step(i),"new true does not repeat Stop");
      i.sample->charging=false; tick(i); check(!e.step(i),"new false settles Stop");
    }
    { Engine e; auto i=input(); activate(e,i); auto a=need(e,i,Operation::Start,10000);
      e.complete(a,{true,true}); tick(i); i.sample.reset();
      a=need(e,i,Operation::Stop); check(e.accepts(a,i),"started authorization survives sample loss");
      e.complete(a,{true,false}); tick(i); check(!e.step(i) && e.status()==Status::Frozen,"failed safety Stop freezes"); }
    for(int manual=0;manual<2;++manual) {
      Engine e; auto i=input(); activate(e,i); auto a=need(e,i,Operation::Start,10000);
      if(manual) { e.manual_override(); i.activation_guard=std::string(32,'2'); }
      i.sources.settings.guard=i.activation_guard; i.sources.settings.activation=std::string(32,'c'); tick(i);
      check(!e.step(i),"pending action retained across activation/manual change");
      e.complete(a,{true,false}); tick(i);
      check(!e.step(i) && e.status()==Status::Frozen,"pre-outcome nonce cannot erase late unknown freeze");
      i.sources.settings.activation=std::string(32,'d'); tick(i); need(e,i,Operation::Start,10000);
    }
    { Engine e; auto i=input(); activate(e,i); auto a=need(e,i,Operation::Start,10000);
      i.sources.settings.activation=std::string(32,'c'); check(!e.accepts(a,i),"IO gate consumes in-flight nonce");
      i.sources.settings.activation=std::string(32,'d'); check(!e.step(i),"second in-flight nonce");
      e.complete(a,{true,false}); i.sources.settings.activation=std::string(32,'c'); tick(i);
      check(!e.step(i) && e.status()==Status::Frozen,"all observed pending nonces quarantined");
      i.sources.settings.activation=std::string(32,'e'); tick(i); need(e,i,Operation::Start,10000); }
    { Engine e; auto i=input(); i.sources.settings.guard=std::string(32,'0'); activate(e,i);
      check(!e.step(i),"boot guard mismatch cannot arm");
      i.sources.settings.guard=i.activation_guard; tick(i); check(!e.step(i),"matching guard alone is not activation");
      i.sources.settings.activation=std::string(32,'c'); tick(i); auto a=need(e,i,Operation::Start,10000);
      i.activation_guard=std::string(32,'2'); check(!e.accepts(a,i),"rotated owner guard cancels increase");
      e.complete(a,{false,false}); e.manual_override();
      i.sources.settings.activation=std::string(32,'d'); tick(i);
      check(!e.step(i) && e.status()==Status::ManualOverride,"late mode POST cannot undo manual Stop");
      i.sources.settings.guard=i.activation_guard; tick(i); check(!e.step(i),"same stale nonce stays consumed");
      i.sources.settings.activation=std::string(32,'e'); tick(i); need(e,i,Operation::Start,10000); }
    { Engine e; auto i=input(); i.sources.settings.mode=Mode::Custom;
      i.sources.settings.custom.max_import_w.reset(); i.sources.settings.meter_includes_wallbox.reset();
      i.sources.house.valid=false; activate(e,i); need(e,i,Operation::Start,32000); }
    for(int fault=0;fault<6;++fault) {
      Engine e; auto i=input(); activate(e,i);
      if(fault==0) i.sources.settings.pv.max_import_w=100001;
      if(fault==1) i.hardware_max_ma=32001;
      if(fault==2) i.hardware_max_ma=5999;
      // Wallbox power is UInt32, so NaN/Inf/negative injections there only
      // produce invalid C++ conversions, not malformed telemetry. Exercise
      // representable untrusted floating-point source values instead.
      if(fault==3) i.sources.house.power_w=std::numeric_limits<double>::quiet_NaN();
      if(fault==4) i.sources.house.power_w=std::numeric_limits<double>::infinity();
      if(fault==5) i.sample->voltage_v.fill(std::numeric_limits<double>::quiet_NaN());
      check(!e.step(i),"invalid feedback budget/cap cannot start");
    }
    { Profile p; p.weekdays={1}; p.windows={{23*60,60}};
      // Monday 2026-10-26 22:00 UTC = 23:00 local; Tuesday 00:59 local.
      check(schedule_contains(p,1793052000),"cross midnight start");
      check(schedule_contains(p,1793059140),"cross midnight previous weekday");
      check(!schedule_contains(p,1793059200),"end exclusive");
      p.weekdays={7}; p.windows={{120,180}};
      check(schedule_contains(p,1792888200),"autumn first 02:30");
      check(schedule_contains(p,1792891800),"autumn repeated 02:30");
      // Count real seconds for full Sunday via overlapping OR windows.
      p.windows={{0,1439},{1438,0}};
      int spring=0,autumn=0;
      for(int n=0;n<26*60;++n) {
          spring+=schedule_contains(p,1774738800+n*60)?1:0;
          autumn+=schedule_contains(p,1792879200+n*60)?1:0;
      }
      check(spring==23*60,"23h local spring day"); check(autumn==25*60,"25h local autumn day"); }
}
int main(int argc,char **argv) {
    try {
        if(argc==4 && (std::string(argv[1])=="--http" || std::string(argv[1])=="--http-stable")) {
            HttpSource source(argv[2]);
            const bool stable=std::string(argv[1])=="--http-stable";
            std::uint64_t initial=0;
            if(stable) { std::this_thread::sleep_for(std::chrono::milliseconds(600)); initial=source.snapshot()->sources.generation; }
            std::this_thread::sleep_for(std::chrono::milliseconds(std::stoi(argv[3])-(stable?600:0)));
            auto s=source.snapshot(); double now=std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
            std::cout<<http_status_name(s->plan_status)<<" "<<http_status_name(s->house_status)<<" "
                <<(s->sources.settings.valid && s->sources.settings.expires>now)<<" "
                <<(s->sources.house.valid && s->sources.house.expires>now);
            if(stable) std::cout<<" "<<(initial>0 && initial==s->sources.generation);
            std::cout<<"\n";
        } else { tests(); std::cout<<"automation checks passed\n"; }
        return EXIT_SUCCESS;
    } catch(const std::exception &e) { std::cerr<<e.what()<<"\n"; return EXIT_FAILURE; }
}
