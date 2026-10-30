#pragma once
#include "hardware.h"
inline void bootloader_random_enable() { sim.trace.emplace_back("ENTROPY_ENABLE"); }
inline void bootloader_random_disable() { sim.trace.emplace_back("ENTROPY_DISABLE"); }
