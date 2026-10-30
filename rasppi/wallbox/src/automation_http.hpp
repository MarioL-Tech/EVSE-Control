#pragma once
#include "automation.hpp"
#include <atomic>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <thread>

namespace wallbox::automation {
enum class HttpStatus { Waiting, Ok, TransportUnavailable, InvalidResponse, Disabled, ClockError, InvalidBase };
const char *http_status_name(HttpStatus) noexcept;
struct Snapshot {
    Sources sources;
    HttpStatus plan_status=HttpStatus::Waiting, house_status=HttpStatus::Waiting;
};
// No hardware/MQTT/WriteCore dependency. Copies are immutable after publication.
class HttpSource {
public:
    explicit HttpSource(std::string base_url);
    ~HttpSource();
    HttpSource(const HttpSource &)=delete;
    HttpSource &operator=(const HttpSource &)=delete;
    static std::string environment_base_url();
    std::shared_ptr<const Snapshot> snapshot() const;
private:
    void run();
    std::string base_;
    bool valid_base_=false;
    std::atomic_bool stop_{false};
    mutable std::mutex mutex_;
    std::condition_variable wake_;
    std::shared_ptr<const Snapshot> snapshot_;
    std::thread thread_;
};
} // namespace wallbox::automation
