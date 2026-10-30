#include "automation_http.hpp"
#include <curl/curl.h>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <ctime>
#include <map>
#include <regex>
#include <set>
#include <stdexcept>

namespace wallbox::automation {
namespace {
using Json=nlohmann::json;
double mono() { return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count(); }
double wall() { return std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count(); }
struct Buffer { std::string body; size_t headers=0; bool oversized=false; };
size_t body(char *p,size_t a,size_t b,void *context) {
    auto &s=*static_cast<Buffer *>(context);
    if (a && b>16384/a) { s.oversized=true; return 0; }
    size_t n=a*b;
    if (n>16384-s.body.size()) { s.oversized=true; return 0; }
    s.body.append(p,n); return n;
}
size_t header(char *,size_t a,size_t b,void *context) {
    auto &s=*static_cast<Buffer *>(context);
    if (a && b>8192/a) { s.oversized=true; return 0; }
    size_t n=a*b;
    if (n>8192-s.headers) { s.oversized=true; return 0; }
    s.headers+=n; return n;
}
int progress(void *p,curl_off_t,curl_off_t,curl_off_t,curl_off_t) { return static_cast<std::atomic_bool *>(p)->load()?1:0; }
bool valid_base(const std::string &s) {
    if(s.empty() || s.size()>2048) return false;
    CURLU *u=curl_url(); if(!u) return false;
    bool ok=curl_url_set(u,CURLUPART_URL,s.c_str(),0)==CURLUE_OK;
    auto part=[&](CURLUPart which) { char *p=nullptr; std::string result;
        if(curl_url_get(u,which,&p,0)==CURLUE_OK) { result=p; curl_free(p); } return result; };
    auto scheme=part(CURLUPART_SCHEME);
    ok=ok && (scheme=="http" || scheme=="https") && !part(CURLUPART_HOST).empty()
        && (part(CURLUPART_PATH).empty() || part(CURLUPART_PATH)=="/")
        && part(CURLUPART_QUERY).empty() && part(CURLUPART_FRAGMENT).empty()
        && part(CURLUPART_USER).empty() && part(CURLUPART_PASSWORD).empty();
    curl_url_cleanup(u); return ok;
}
Json strict_json(const std::string &s) {
    std::map<int,std::set<std::string>> keys;
    return Json::parse(s,[&](int depth,Json::parse_event_t event,Json &value) {
        if(depth>24) throw std::runtime_error("depth");
        if(event==Json::parse_event_t::object_start) keys[depth+1].clear();
        if(event==Json::parse_event_t::key && !keys[depth].insert(value.get<std::string>()).second) throw std::runtime_error("duplicate");
        return true;
    });
}
double number(const Json &v) {
    if(!v.is_number()) throw std::runtime_error("number");
    double n=v.get<double>(); if(!std::isfinite(n)) throw std::runtime_error("finite"); return n;
}
std::optional<int> integer(const Json &v,int lo,int hi) {
    if(v.is_null()) return {};
    if(!v.is_number_integer()) throw std::runtime_error("integer");
    double n=number(v); if(n<lo || n>hi) throw std::runtime_error("range"); return static_cast<int>(n);
}
std::optional<bool> boolean(const Json &v) {
    if(v.is_null()) return {}; if(!v.is_boolean()) throw std::runtime_error("bool"); return v.get<bool>();
}
const Json &field(const Json &v,const char *key) {
    static const Json nil;
    if(!v.is_object()) throw std::runtime_error("object");
    auto it=v.find(key); return it==v.end()?nil:*it;
}
int minute(const Json &v) {
    auto s=v.get<std::string>();
    if(!std::regex_match(s,std::regex("[0-2][0-9]:[0-5][0-9]"))) throw std::runtime_error("time");
    int h=std::stoi(s.substr(0,2)); if(h>23) throw std::runtime_error("hour"); return h*60+std::stoi(s.substr(3,2));
}
Profile profile(const Json &v,bool custom) {
    Profile p;
    p.max_import_w=integer(field(v,"max_import_w"),0,100000);
    p.max_current_ma=integer(field(v,"max_current_ma"),6000,32000);
    p.adjust_seconds=integer(field(v,"adjust_seconds"),0,3600);
    p.pause_seconds=integer(field(v,"pause_seconds"),0,3600);
    p.resume_seconds=integer(field(v,"resume_seconds"),0,3600);
    if(custom) {
        p.use_schedule=boolean(field(v,"use_schedule")); p.pv_enabled=boolean(field(v,"pv_enabled"));
        const auto &days=field(v,"weekdays"), &windows=field(v,"windows");
        if(!days.is_array() || days.size()>7 || !windows.is_array() || windows.size()>16) throw std::runtime_error("schedule");
        std::set<int> seen;
        for(const auto &d:days) { auto n=integer(d,1,7); if(!n || !seen.insert(*n).second) throw std::runtime_error("weekday"); p.weekdays.push_back(*n); }
        for(const auto &w:windows) { Window r{minute(w.at("from")),minute(w.at("to"))}; if(r.from==r.to) throw std::runtime_error("empty"); p.windows.push_back(r); }
        const auto &outside=field(v,"outside_window");
        if(!outside.is_null()) {
            if(outside=="pause") p.outside=Profile::Outside::Pause;
            else if(outside=="manual") p.outside=Profile::Outside::Manual;
            else throw std::runtime_error("outside");
        }
    }
    return p;
}
Settings plan(const Json &j,double now,double utc,double elapsed) {
    if(j.at("schema_version")!=1 || j.at("status")!="ok") throw std::runtime_error("schema");
    double generated=number(j.at("generated_at")), ttl=number(j.at("fresh_for_seconds"));
    if(ttl<=0 || ttl>6 || generated>utc+0.25 || utc-generated>ttl) throw std::runtime_error("clock");
    Settings s; s.revision=j.at("config_revision").get<std::string>();
    s.activation=j.at("activation").at("id").get<std::string>();
    s.guard=j.at("activation").at("guard").get<std::string>();
    if(!std::regex_match(s.guard,std::regex("[a-f0-9]{32}"))) throw std::runtime_error("guard");
    if(!std::regex_match(s.revision,std::regex("[a-f0-9]{64}")) || !std::regex_match(s.activation,std::regex("[a-f0-9]{32}"))) throw std::runtime_error("identity");
    auto mode=j.at("activation").at("mode");
    if(mode=="manual") s.mode=Mode::Manual; else if(mode=="pv") s.mode=Mode::Pv;
    else if(mode=="custom") s.mode=Mode::Custom; else throw std::runtime_error("mode");
    const auto &c=j.at("config");
    if(c.at("schema_version")!=1 || c.at("timezone")!="Europe/Vienna") throw std::runtime_error("config");
    integer(field(c.at("manual"),"current_ma"),6000,32000);
    s.pv=profile(c.at("pv"),false); s.custom=profile(c.at("custom"),true);
    const auto &install=field(c,"installation");
    if(!install.is_null()) { s.phases=integer(field(install,"phases"),1,3); s.meter_includes_wallbox=boolean(field(install,"meter_includes_wallbox")); }
    s.expires=now+std::max(0.0,ttl-std::max(0.0,utc-generated)-elapsed); s.valid=s.expires>now; return s;
}
double timestamp(const std::string &s) {
    std::smatch m;
    if(!std::regex_match(s,m,std::regex("([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\\.[0-9]{1,6})?Z"))) throw std::runtime_error("stamp");
    tm t{}; t.tm_year=std::stoi(m[1])-1900; t.tm_mon=std::stoi(m[2])-1; t.tm_mday=std::stoi(m[3]);
    t.tm_hour=std::stoi(m[4]); t.tm_min=std::stoi(m[5]); t.tm_sec=std::stoi(m[6]);
    auto epoch=timegm(&t); tm check{}; gmtime_r(&epoch,&check);
    char buffer[32]; strftime(buffer,sizeof buffer,"%Y-%m-%dT%H:%M:%S",&check);
    if(s.substr(0,19)!=buffer || epoch<0) throw std::runtime_error("stamp");
    return static_cast<double>(epoch)+(m[7].matched?std::stod(m[7]):0);
}
House meter(const Json &j,double now,double utc,double elapsed,const House &old) {
    if(j.at("schema_version")!=1 || j.at("status")!="live") throw std::runtime_error("meter");
    House h; h.power_w=number(j.at("power_w")); h.fetched_at=timestamp(j.at("fetched_at").get<std::string>());
    double age=number(j.at("age_seconds")), ttl=number(j.at("fresh_for_seconds"));
    if(age<0 || age>120 || ttl<=0 || ttl>120 || h.fetched_at>utc+0.25 || std::abs(utc-h.fetched_at-age)>2 || utc-h.fetched_at>120) throw std::runtime_error("age");
    h.expires=now+std::max(0.0,ttl-elapsed);
    if(h.fetched_at==old.fetched_at) h.expires=std::min(old.expires,h.expires);
    if(h.fetched_at<old.fetched_at) throw std::runtime_error("backwards");
    h.valid=h.expires>now; return h;
}
struct Response { HttpStatus status=HttpStatus::TransportUnavailable; Json value; double elapsed=0; };
Response get(const std::string &url,std::atomic_bool &stop) {
    Response r; Buffer b; auto start=mono(); CURL *c=curl_easy_init(); if(!c) return r;
    curl_easy_setopt(c,CURLOPT_URL,url.c_str()); curl_easy_setopt(c,CURLOPT_PROXY,"");
    curl_easy_setopt(c,CURLOPT_FOLLOWLOCATION,0L); curl_easy_setopt(c,CURLOPT_PROTOCOLS_STR,"http,https");
    curl_easy_setopt(c,CURLOPT_CONNECTTIMEOUT_MS,500L); curl_easy_setopt(c,CURLOPT_TIMEOUT_MS,1500L);
    curl_easy_setopt(c,CURLOPT_NOSIGNAL,1L); curl_easy_setopt(c,CURLOPT_SSL_VERIFYPEER,1L); curl_easy_setopt(c,CURLOPT_SSL_VERIFYHOST,2L);
    curl_easy_setopt(c,CURLOPT_WRITEFUNCTION,body); curl_easy_setopt(c,CURLOPT_WRITEDATA,&b);
    curl_easy_setopt(c,CURLOPT_HEADERFUNCTION,header); curl_easy_setopt(c,CURLOPT_HEADERDATA,&b);
    curl_easy_setopt(c,CURLOPT_NOPROGRESS,0L); curl_easy_setopt(c,CURLOPT_XFERINFOFUNCTION,progress); curl_easy_setopt(c,CURLOPT_XFERINFODATA,&stop);
    auto result=curl_easy_perform(c); long code=0; curl_easy_getinfo(c,CURLINFO_RESPONSE_CODE,&code); curl_easy_cleanup(c);
    r.elapsed=mono()-start;
    if(b.oversized || (result==CURLE_OK && code!=200)) r.status=HttpStatus::InvalidResponse;
    else if(result==CURLE_OK) { try { r.value=strict_json(b.body); r.status=HttpStatus::Ok; } catch(...) { r.status=HttpStatus::InvalidResponse; } }
    return r;
}
}
const char *http_status_name(HttpStatus s) noexcept {
    switch(s) {
    case HttpStatus::Waiting:return "waiting"; case HttpStatus::Ok:return "ok";
    case HttpStatus::TransportUnavailable:return "transport_unavailable"; case HttpStatus::InvalidResponse:return "invalid_response";
    case HttpStatus::Disabled:return "disabled"; case HttpStatus::ClockError:return "clock_error";
    case HttpStatus::InvalidBase:return "invalid_base";
    } return "invalid_response";
}
std::string HttpSource::environment_base_url() { const char *s=std::getenv("WALLBOX_WEB_BASE_URL"); return s?s:"http://weboverlay:8080"; }
HttpSource::HttpSource(std::string base):base_(std::move(base)),snapshot_(std::make_shared<const Snapshot>()) {
    initialize_vienna_timezone();
    static std::once_flag once; std::call_once(once,[]{ if(curl_global_init(CURL_GLOBAL_DEFAULT)!=CURLE_OK) throw std::runtime_error("http_initialization"); });
    valid_base_=valid_base(base_); if(!base_.empty() && base_.back()=='/') base_.pop_back();
    thread_=std::thread(&HttpSource::run,this);
}
HttpSource::~HttpSource() { stop_=true; wake_.notify_all(); if(thread_.joinable()) thread_.join(); }
std::shared_ptr<const Snapshot> HttpSource::snapshot() const { std::lock_guard<std::mutex> lock(mutex_); return snapshot_; }
void HttpSource::run() {
    Snapshot s; double last_m=mono(),last_w=wall();
    // Publish each endpoint immediately, especially activation/revision changes:
    // a blocked house request must not conceal a newly cancelled plan.
    auto publish=[&] {
        const double m=mono(),w=wall();
        if(m<last_m || w<last_w || std::abs((w-last_w)-(m-last_m))>2) {
            s.sources.settings.valid=s.sources.house.valid=false;
            s.sources.house.expires=0; s.plan_status=s.house_status=HttpStatus::ClockError;
            s.sources.clock_error=true;
        }
        last_m=m; last_w=w;
        ++s.sources.generation;
        std::lock_guard<std::mutex> lock(mutex_); snapshot_=std::make_shared<const Snapshot>(s);
    };
    while(!stop_) {
        const double cycle=mono();
        if(!valid_base_) { s.plan_status=s.house_status=HttpStatus::InvalidBase; publish(); }
        else {
            auto p=get(base_+"/api/charging-plan",stop_);
            if(stop_) break;
            s.plan_status=p.status;
            if(p.status==HttpStatus::Ok) {
                try {
                    if(p.value.at("status")=="disabled" || p.value.at("status")=="unavailable") {
                        s.plan_status=p.value.at("status")=="disabled"?HttpStatus::Disabled:HttpStatus::InvalidResponse; s.sources.settings.valid=false;
                    } else {
                        auto next=plan(p.value,mono(),wall(),p.elapsed);
                        if(next.activation!=s.sources.settings.activation) s.sources.clock_error=false;
                        s.sources.settings=std::move(next);
                    }
                } catch(...) { s.plan_status=HttpStatus::InvalidResponse; s.sources.settings.valid=false; }
            } else if(p.status!=HttpStatus::TransportUnavailable) s.sources.settings.valid=false;
            publish();
            auto h=get(base_+"/api/smartmeter",stop_);
            if(stop_) break;
            s.house_status=h.status;
            if(h.status==HttpStatus::Ok) {
                try { s.sources.house=meter(h.value,mono(),wall(),h.elapsed,s.sources.house); }
                catch(...) { s.house_status=HttpStatus::InvalidResponse; s.sources.house.valid=false; s.sources.house.expires=0; }
            } else if(h.status!=HttpStatus::TransportUnavailable) { s.sources.house.valid=false; s.sources.house.expires=0; }
            publish();
        }
        std::unique_lock<std::mutex> lock(mutex_);
        wake_.wait_for(lock,std::chrono::duration<double>(std::max(0.0,2-(mono()-cycle))),[&]{return stop_.load();});
    }
}
} // namespace wallbox::automation
