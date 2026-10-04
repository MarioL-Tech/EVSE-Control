FROM debian:bookworm-slim AS native-tests
RUN apt-get update && apt-get install -y --no-install-recommends g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY include/ include/
COPY src/security.cpp src/protocol.cpp src/
COPY tests/ tests/
COPY src/main.cpp src/main.cpp
RUN g++ -std=c++17 -Wall -Wextra -Wpedantic -Werror -g \
      -fsanitize=address,undefined -fno-omit-frame-pointer -fno-pie -no-pie \
      -Iinclude src/security.cpp src/protocol.cpp tests/security_test.cpp -o /security-test \
    && ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 UBSAN_OPTIONS=halt_on_error=1 /security-test
RUN g++ -std=c++17 -Wall -Wextra -Wpedantic -Werror -g \
      -fsanitize=address,undefined -fno-omit-frame-pointer -fno-pie -no-pie \
      -Itests/stubs -Iinclude src/security.cpp src/protocol.cpp tests/hardware_test.cpp -o /hardware-test \
    && ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 UBSAN_OPTIONS=halt_on_error=1 /hardware-test

FROM python:3.12.12-slim-bookworm AS toolchain
RUN pip install --no-cache-dir platformio==6.1.18
ENV PLATFORMIO_CORE_DIR=/opt/platformio
WORKDIR /project
COPY platformio.ini partitions.csv ./
# Cache pinned packages independently of application sources.
RUN pio pkg install --environment esp32dev

FROM toolchain AS firmware-build
COPY include/ include/
COPY src/ src/
RUN pio run --environment esp32dev \
    && mkdir /firmware \
    && cp .pio/build/esp32dev/firmware.bin .pio/build/esp32dev/bootloader.bin \
          .pio/build/esp32dev/partitions.bin /firmware/

# Explicit flashing target, opt-in only. Requires a locally accessible ESP32 USB port.
FROM firmware-build AS flash
COPY --from=native-tests /security-test /tests/security-test
COPY --from=native-tests /hardware-test /tests/hardware-test
ENTRYPOINT ["pio", "run", "--environment", "esp32dev", "--target", "upload"]

# Force both native test suites into the default build dependency graph.
FROM scratch AS artifacts
COPY --from=native-tests /security-test /tests/security-test
COPY --from=native-tests /hardware-test /tests/hardware-test
COPY --from=firmware-build /firmware /firmware
CMD ["/artifacts-only-not-a-runtime-image"]
