#!/bin/sh
# CI host only. No Docker socket is exposed to the browser or application.
# Real proxy loss affects page AND service-worker network requests alike.
set -eu
[ "${CI:-}" = true ] || { echo 'Disposable PWA integration is CI-only.' >&2; exit 1; }
cd "$(dirname "$0")/.."
dc() { docker compose -f compose.pwa-test.yaml "$@"; }
output=../../artifacts/pwa
rm -f "$output/pwa-offline-request" "$output/pwa-is-offline" \
    "$output/pwa-online-request" "$output/pwa-is-online"
browser=$(dc run -d --no-deps -T browser)
trap 'docker logs "$browser"; docker rm -f "$browser" >/dev/null' EXIT
wait_for() {
    marker=$1
    attempt=0
    while [ "$attempt" -lt 90 ]; do
        [ ! -f "$output/$marker" ] || return 0
        [ "$(docker inspect --format '{{.State.Running}}' "$browser")" = true ] || return 1
        attempt=$((attempt + 1))
        sleep 1
    done
    echo 'PWA test phase did not finish.' >&2
    return 1
}
wait_for pwa-offline-request
dc stop https
printf ready > "$output/pwa-is-offline"
wait_for pwa-online-request
dc up -d --no-deps --wait https
printf ready > "$output/pwa-is-online"
result=$(docker wait "$browser")
[ "$result" = 0 ]
