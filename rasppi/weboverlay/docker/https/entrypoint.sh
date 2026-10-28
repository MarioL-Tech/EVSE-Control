#!/bin/sh
set -eu
umask 077
/usr/local/bin/validate-host.sh
# New named volumes inherit image ownership. Existing foreign volumes fail
# closed: no root startup/chown or automatic CA replacement/repair.
if [ ! -w /data/caddy ] || [ ! -w /config ]; then
    printf '%s\n' 'HTTPS storage is not writable by the service user.' >&2
    exit 1
fi
exec "$@"
