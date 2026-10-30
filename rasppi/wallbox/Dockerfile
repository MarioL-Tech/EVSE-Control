ARG DEBIAN_RELEASE=bookworm
FROM debian:${DEBIAN_RELEASE}-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    g++ cmake make pkg-config libmodbus-dev libmosquitto-dev mosquitto mosquitto-clients python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY CMakeLists.txt ./
COPY src ./src
COPY tests ./tests
RUN dpkg-query -W libmodbus-dev libmosquitto-dev \
    && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --parallel 2 \
    && ctest --test-dir build --output-on-failure

FROM debian:${DEBIAN_RELEASE}-slim
RUN apt-get update && apt-get install -y --no-install-recommends libmodbus5 libmosquitto1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/build/evse-wallbox /usr/local/bin/evse-wallbox
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
