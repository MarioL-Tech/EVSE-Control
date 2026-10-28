#!/bin/sh
# Disposable CI container only. Never installs a CA on the Pi or client host.
set -eu
ca=/pwa-ca/root.crt
test -s "$ca"
install -m 0644 "$ca" /usr/local/share/ca-certificates/evse-pwa-fixture.crt
update-ca-certificates >/dev/null
mkdir -p "$HOME/.pki/nssdb"
certutil -N --empty-password -d "sql:$HOME/.pki/nssdb"
certutil -A -d "sql:$HOME/.pki/nssdb" -n EVSE-PWA-fixture -t 'C,,' -i "$ca"
export NODE_EXTRA_CA_CERTS="$ca"
exec node /tests/pwa-browser.cjs
