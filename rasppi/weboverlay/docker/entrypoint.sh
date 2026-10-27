#!/bin/bash
set -Eeuo pipefail
cd /app
umask 077
export WEB_STATE_DIR="${WEB_STATE_DIR:-/tmp/evse-weboverlay}"
export EVSE_HTTP_PORT="${EVSE_HTTP_PORT:-8080}"
pids=()
stop_children() {
    trap '' TERM INT
    if ((${#pids[@]})); then
        kill -TERM "${pids[@]}" 2>/dev/null || true
        for ((i=0; i<40; i++)); do
            alive=0
            for pid in "${pids[@]}"; do
                if kill -0 "$pid" 2>/dev/null; then alive=1; fi
            done
            ((alive)) || break
            sleep 0.05
        done
        kill -KILL "${pids[@]}" 2>/dev/null || true
        wait "${pids[@]}" 2>/dev/null || true
    fi
}
trap 'stop_children; exit 0' TERM INT
php php/worker.php &
pids+=("$!")
php php/smartmeter-worker.php &
pids+=("$!")
apache2 -DFOREGROUND &
pids+=("$!")
wait -n "${pids[@]}" || true
stop_children
exit 1
