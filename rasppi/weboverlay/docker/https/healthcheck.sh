#!/bin/sh
set -eu
/usr/local/bin/validate-host.sh
# HTTP liveness through authenticated TLS, independent of MQTT readiness.
exec curl --silent --show-error --fail --noproxy '*' \
    --connect-timeout 2 --max-time 4 \
    --resolve "$EVSE_TLS_HOST:8443:127.0.0.1" \
    --cacert /data/caddy/pki/authorities/local/root.crt \
    "https://$EVSE_TLS_HOST:8443/healthz" --output /dev/null
