#!/bin/sh
# CI HOST orchestration only: all curl/OpenSSL/project checks run IN containers.
# The parent workflow builds images, starts broker/weboverlay/https, copies ONLY
# root.crt, launches the trusted browser runner, and cleans this fixture up.
set -eu
[ "${CI:-}" = true ] || { printf '%s\n' 'Disposable HTTPS integration is CI-only.' >&2; exit 1; }
cd "$(dirname "$0")/.."
dc() { docker compose -p "${PWA_TEST_PROJECT:-evse-pwa-test}" -f compose.pwa-test.yaml "$@"; }
fail() { printf '%s\n' "$1" >&2; exit 1; }
wait_healthy() {
    service=$1
    attempt=0
    while [ "$attempt" -lt 45 ]; do
        cid=$(dc ps -q "$service")
        if [ -n "$cid" ] && [ "$(docker inspect --format '{{.State.Health.Status}}' "$cid")" = healthy ]; then
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 2
    done
    fail 'HTTPS fixture did not become healthy.'
}
fingerprint() {
    dc exec -T https openssl x509 -in /data/caddy/pki/authorities/local/root.crt -noout -fingerprint -sha256
}
wait_healthy https
# Fresh-volume ownership, CA confidentiality, readonly/nonroot and stripped caps.
cid=$(dc ps -q https)
[ "$(docker inspect --format '{{.Config.User}}' "$cid")" = 10001:10001 ] || fail 'Wrong HTTPS user.'
[ "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$cid")" = true ] || fail 'Writable proxy rootfs.'
[ "$(docker inspect --format '{{json .HostConfig.CapDrop}}' "$cid")" = '["ALL"]' ] || fail 'Proxy capabilities not dropped.'
[ "$(docker inspect --format '{{json .HostConfig.SecurityOpt}}' "$cid")" = '["no-new-privileges:true"]' ] || fail 'Proxy permits privilege escalation.'
[ "$(docker inspect --format '{{len .NetworkSettings.Networks}}' "$cid")" = 1 ] || fail 'Proxy connected to additional networks.'
dc exec -T https sh -ec '
    test "$(id -u)" = 10001
    test "$(stat -c %u /data/caddy)" = 10001
    test "$(stat -c %a /data/caddy)" = 700
    test "$(stat -c %a /data/caddy/pki/authorities/local/root.key)" = 600
    test -z "$(getcap /usr/bin/caddy)"
    grep -q "^CapEff:[[:space:]]*0000000000000000$" /proc/1/status
    test ! -w /etc/caddy/Caddyfile
    /usr/local/bin/healthcheck.sh
    # Correct hostname WITHOUT our CA must fail specifically verification (60).
    set +e
    curl --silent --noproxy "*" --connect-timeout 2 --max-time 4 \
        --resolve evse.test:8443:127.0.0.1 https://evse.test:8443/healthz -o /dev/null
    result=$?
    set -e
    test "$result" = 60
    # Request the configured certificate, then verify a WRONG identity. Sending
    # wrong.test as SNI could fail cert selection instead of hostname validation.
    if timeout 8 openssl s_client -connect 127.0.0.1:8443 -servername evse.test \
        -verify_return_error -verify_hostname wrong.test \
        -CAfile /data/caddy/pki/authorities/local/root.crt \
        </dev/null >/tmp/wrong-host 2>&1; then exit 1; fi
    grep -qi "hostname mismatch" /tmp/wrong-host
    # No HSTS or accidental QUIC advertisement on the TLS response.
    curl --silent --show-error --fail --noproxy "*" --max-time 4 \
        --resolve evse.test:8443:127.0.0.1 --cacert /data/caddy/pki/authorities/local/root.crt \
        -D /tmp/headers https://evse.test:8443/healthz -o /dev/null
    ! grep -Ei "^(alt-svc|strict-transport-security):" /tmp/headers
'
# Invalid identities never reach Caddyfile substitution (including placeholders).
for host in '0.0.0.0' '256.1.2.3' '01.2.3.4' '1.2.3' 'https://evse.test' 'evse.test:443' '*.test' '{env.BAD}' 'a..test' '-a.test' 'a-.test' 'bad name' 'a/b'; do
    if dc exec -T -e "EVSE_TLS_HOST=$host" https /usr/local/bin/validate-host.sh >/dev/null 2>&1; then
        fail 'Unsafe TLS identity was accepted.'
    fi
done
dc exec -T https sh -ec '
    label=$(printf "%064d" 0)
    ! EVSE_TLS_HOST="$label.test" /usr/local/bin/validate-host.sh
    label63=$(printf "%063d" 0)
    ! EVSE_TLS_HOST="$label63.$label63.$label63.$label63" /usr/local/bin/validate-host.sh
    ! EVSE_TLS_HOST="" /usr/local/bin/validate-host.sh
    ! EVSE_TLS_HOST="$(printf "a\nb")" /usr/local/bin/validate-host.sh
    EVSE_TLS_HOST=192.0.2.10 /usr/local/bin/validate-host.sh
    EVSE_TLS_HOST=evse.example.test /usr/local/bin/validate-host.sh
'
before=$(fingerprint)
[ -n "$before" ] || fail 'Missing root certificate fingerprint.'
dc up -d --no-deps --force-recreate https
wait_healthy https
[ "$before" = "$(fingerprint)" ] || fail 'CA changed after proxy recreation.'
dc --profile tools up -d --no-deps https-ip
wait_healthy https-ip
# Explicitly omit SNI, verify the configured IP SAN, then exercise HTTP routing.
# The listener is loopback INSIDE the disposable IP proxy, not a host port.
dc exec -T https-ip sh -ec '
    printf "GET /healthz HTTP/1.1\r\nHost: 192.0.2.10\r\nConnection: close\r\n\r\n" | \
        timeout 8 openssl s_client -quiet -noservername -connect 127.0.0.1:8443 \
        -verify_return_error -verify_ip 192.0.2.10 \
        -CAfile /data/caddy/pki/authorities/local/root.crt > /tmp/no-sni-response
    grep -q "^HTTP/1.1 200" /tmp/no-sni-response
    /usr/local/bin/healthcheck.sh
'
printf '%s\n' 'HTTPS fixture checks passed; trusted-browser/PWA suite is separate.'
