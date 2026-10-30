ARG DEBIAN_RELEASE=bookworm
FROM debian:${DEBIAN_RELEASE}-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    g++ cmake make pkg-config libmodbus-dev mosquitto mosquitto-clients python3 \
    curl ca-certificates patch libssl-dev \
    && rm -rf /var/lib/apt/lists/*
COPY docker/libmosquitto-incoming.patch /tmp/libmosquitto-incoming.patch
# Same Debian release in both stages: no newer-libc dependency in the runtime.
# Keep upstream framing/threading/TLS; only cap client incoming allocation.
RUN curl -fsSL --proto '=https' --tlsv1.2 \
        https://mosquitto.org/files/source/mosquitto-2.0.21.tar.gz -o /tmp/mosquitto.tar.gz \
    && printf '%s  %s\n' 7ad5e84caeb8d2bb6ed0c04614b2a7042def961af82d87f688ba33db857b899d /tmp/mosquitto.tar.gz | sha256sum -c - \
    && tar -xzf /tmp/mosquitto.tar.gz -C /tmp \
    && patch --batch --fuzz=0 -d /tmp/mosquitto-2.0.21 -p1 < /tmp/libmosquitto-incoming.patch \
    && cmake -S /tmp/mosquitto-2.0.21 -B /tmp/mosquitto-build \
        -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local -DCMAKE_INSTALL_LIBDIR=lib \
        -DWITH_TLS=ON -DWITH_THREADING=ON -DWITH_BROKER=OFF -DWITH_CLIENTS=OFF \
        -DWITH_APPS=OFF -DWITH_PLUGINS=OFF -DDOCUMENTATION=OFF -DWITH_CJSON=OFF \
        -DWITH_LIB_CPP=OFF -DWITH_STATIC_LIBRARIES=OFF \
    && cmake --build /tmp/mosquitto-build --parallel 2 \
    && cmake --install /tmp/mosquitto-build \
    && ldconfig \
    && mkdir -p /usr/share/doc/evse-libmosquitto \
    && cp /tmp/mosquitto-2.0.21/LICENSE.txt /tmp/mosquitto-2.0.21/edl-v10 /tmp/mosquitto-2.0.21/epl-v20 /usr/share/doc/evse-libmosquitto/ \
    && rm -rf /tmp/mosquitto*
ENV PKG_CONFIG_PATH=/usr/local/lib/pkgconfig
WORKDIR /src
COPY CMakeLists.txt ./
COPY src ./src
COPY tests ./tests
RUN dpkg-query -W libmodbus-dev \
    && printf '%s\n' 'libmosquitto: pinned upstream 2.0.21 + EVSE preallocation guard (4096 bytes)' \
    && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --parallel 2 \
    && ctest --test-dir build --output-on-failure

FROM debian:${DEBIAN_RELEASE}-slim
RUN apt-get update && apt-get install -y --no-install-recommends libmodbus5 libmosquitto1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/build/evse-wallbox /usr/local/bin/evse-wallbox
COPY --from=build /usr/local/lib/libmosquitto.so* /usr/local/lib/
COPY --from=build /usr/share/doc/evse-libmosquitto /usr/share/doc/evse-libmosquitto
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN ldconfig && chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
