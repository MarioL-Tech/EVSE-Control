#pragma once
#include "hardware.h"
inline void esp_fill_random(void *out, std::size_t length) {
  sim.trace.emplace_back("ENTROPY_FILL");
  auto *bytes = static_cast<uint8_t *>(out);
  for (std::size_t i = 0; i < length; ++i) bytes[i] = sim.entropyBroken ? 0 : static_cast<uint8_t>(i);
}
