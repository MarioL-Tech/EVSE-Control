#!/bin/sh
# Executed before Caddyfile environment substitution. Never echo bad input.
set -eu
export LC_ALL=C
invalid() { printf '%s\n' 'Invalid TLS identity: use one IPv4 address or ASCII DNS name.' >&2; exit 1; }
host=${EVSE_TLS_HOST:-}
[ -n "$host" ] && [ "${#host}" -le 253 ] || invalid
case "$host" in
    *[!A-Za-z0-9.-]*|.*|*.|*..*|0.0.0.0) invalid ;;
esac
set -f
IFS=.
set -- $host
unset IFS
case "$host" in
    *[!0-9.]*)
        for label do
            [ "${#label}" -le 63 ] || invalid
            case "$label" in ''|-*|*-) invalid ;; esac
        done
        ;;
    *)
        [ "$#" -eq 4 ] || invalid
        for octet do
            case "$octet" in ''|0[0-9]*|????*) invalid ;; esac
            [ "$octet" -le 255 ] || invalid
        done
        ;;
esac
