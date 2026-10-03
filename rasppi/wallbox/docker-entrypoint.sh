#!/bin/sh
set -eu

# Container defaults; appended CLI arguments can override these values.
exec /usr/local/bin/evse-wallbox \
    --device "${WALLBOX_PORT:-/dev/ttyWallbox}" \
    --baud "${WALLBOX_BAUD:-57600}" \
    --parity "${WALLBOX_PARITY:-E}" \
    --slave "${WALLBOX_SLAVE:-9}" \
    --interval-ms "${WALLBOX_INTERVAL_MS:-2000}" \
    --timeout-ms "${WALLBOX_TIMEOUT_MS:-1000}" \
    "$@"
