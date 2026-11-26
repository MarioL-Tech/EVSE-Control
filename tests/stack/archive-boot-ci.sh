#!/usr/bin/env bash
# Dedicated empty, disposable GitHub VM. Tests the installed unit and real
# Docker races. The image is deliberately inert; SQL/API is in isolated-ci.sh.
set -Eeuo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && ${RUNNER_OS:-} == Linux ]]
existing=$(docker ps -aq); [[ -z $existing ]]
# Copy only tracked paths, but their WORKTREE bytes. git archive HEAD silently
# tested the old helper/unit when this script was run before committing a fix.
fixture=$(mktemp -d)
git ls-files -z -- bin rasppi/weboverlay | tar --null -T - -cf - | tar -x -C "$fixture"
stage=setup
trap 'rc=$?; echo "Archive boot CI failed: stage=$stage line=$LINENO exit=$rc" >&2; sudo journalctl -u evse-archive-link.service -n 30 --no-pager >&2 || :; exit "$rc"' ERR
cd "$fixture"; wp=$fixture/rasppi/weboverlay
printf 'web history\n' > bin/.env
printf 'synthetic-only\n' > "$wp/dummy.txt"
printf 'COMPOSE_PROJECT_NAME=archive-ci\nHISTORY_DB_PASSWORD_HOST_FILE=./dummy.txt\nDB_NETWORK=fixture-archive\n' > "$wp/.env"
mkdir -p .evse-settings/weboverlay
docker network create --internal evse-mqtt >/dev/null
docker network create --internal fixture-archive >/dev/null
docker build -qt archive-ci-weboverlay - <<'IMAGE'
FROM busybox:1.37
USER 10001:10001
CMD ["sleep", "86400"]
IMAGE
compose() (cd "$wp" && docker compose -f compose.yaml -f compose.history.yaml "$@");
reconcile() { bash bin/archive-link.sh --reconcile < "$fixture/expected"; }
reject() { if "$@"; then echo 'Expected refusal' >&2; exit 1; fi; }
compose up -d --no-build --pull never weboverlay
stage=initial-pin
w=$(compose ps -q weboverlay); [[ $w =~ ^[0-9a-f]{64}$ ]]
endpoint() { docker inspect --format '{{with index .NetworkSettings.Networks "fixture-archive"}}{{.EndpointID}}{{else}}absent{{end}}' "$1"; }
live() { [[ $(endpoint "$1") =~ ^[0-9a-f]{64}$ ]]; }
live "$w"
docker run -d --name untouched --network fixture-archive archive-ci-weboverlay >/dev/null
fingerprint() { docker inspect --format '{{.Id}} {{.State.StartedAt}} {{json .NetworkSettings.Networks}}' untouched; }
untouched=$(fingerprint)
mounts=$(docker inspect --format '{{range .Mounts}}{{if eq .Type "bind"}}{{println .Destination}}{{end}}{{end}}' "$w" | sed '/^$/d' | sort)
[[ $mounts == $'/run/evse-settings\n/run/secrets/history-password' ]]
printf 'WEB_STALE_SECONDS=18\n' >> "$wp/.env"
reject bash bin/stack.sh archive-pin # same labels/paths, different resolved service hash
sed -i '$d' "$wp/.env"
bash bin/stack.sh archive-pin > expected
# Legacy regular dotenv and the exact setup-settings.sh link are supported.
# No arbitrary env symlink (even byte-identical), device, or FIFO witness.
target=$fixture/.evse-settings/weboverlay/.env
mv "$wp/.env" "$target"; ln -s "$target" "$wp/.env"
bash bin/stack.sh archive-pin > expected
mv "$target" "$target.saved"; ln -s "$target.saved" "$target"; reject reconcile; rm "$target"
mkfifo "$target"; rc=0; timeout 3 bash bin/archive-link.sh --witness "$fixture" >/dev/null || rc=$?
[[ $rc == 1 ]]; rm "$target"; mv "$target.saved" "$target"

# Install exactly the documented root-owned copy. No repo ExecStart, no socket
# mount into a project service. Do not enable any units on self-hosted runners.
unit=evse-archive-link.service
stage=installed-unit
sudo install -d -m 0755 /usr/local/libexec
sudo install -d -m 0700 /etc/evse-archive-link /etc/evse-archive-link/docker-config
sudo install -m 0755 bin/archive-link.sh /usr/local/libexec/evse-archive-link
sudo install -m 0600 expected /etc/evse-archive-link/expected
sudo install -m 0644 "bin/$unit" "/etc/systemd/system/$unit"
sudo systemctl daemon-reload
sudo systemctl enable "$unit"
sudo systemctl is-enabled --quiet "$unit"
reject bash bin/archive-link.sh --boot < expected
[[ $(sudo systemctl show -p ExecStart --value "$unit") == *'/bin/bash /usr/local/libexec/evse-archive-link --boot'* ]]
[[ $(stat -c '%u:%g:%a' /usr/local/libexec/evse-archive-link) == 0:0:755 ]]
# The unit and its unprivileged witness still work without any boot script
# at the checkout path. Do not execute a sentinel script as root for testing.
mv bin/archive-link.sh bin/archive-link.saved
old=$(endpoint "$w"); sudo systemctl start "$unit"; [[ $(endpoint "$w") == "$old" ]]
mv bin/archive-link.saved bin/archive-link.sh
docker network disconnect fixture-archive "$w"
# A writable or substituted receipt must not authorize a privileged connect.
sudo chmod 0666 /etc/evse-archive-link/expected
reject sudo systemctl start "$unit"; [[ $(endpoint "$w") == absent ]]
sudo systemctl reset-failed "$unit"; sudo chmod 0600 /etc/evse-archive-link/expected
# Same bytes and approved path, readable exclusively by root: even the
# installed unit must now fail, rather than hash as root and reconnect.
sudo chown root:root "$target"; sudo chmod 0600 "$target"
reject sudo systemctl start "$unit"; [[ $(endpoint "$w") == absent ]]
sudo systemctl reset-failed "$unit"; sudo chown "$(id -u):$(id -g)" "$target"
reject bash bin/stack.sh archive-pin
printf '# plan changed\n' >> bin/.env; reject reconcile; sed -i '$d' bin/.env
printf '# site changed\n' >> "$target"; reject reconcile; sed -i '$d' "$target"
flock "$fixture" bash -c 'if bash bin/archive-link.sh --reconcile < expected; then exit 1; fi'
docker pause "$w" >/dev/null; reject reconcile; docker unpause "$w" >/dev/null
docker stop "$w" >/dev/null; reject reconcile; docker start "$w" >/dev/null
[[ $(endpoint "$w") == absent ]]
# The installed service starts while the pinned container is still stopped,
# as can happen during Docker cold start. No Docker write is attempted until
# that exact container is running; then the endpoint is restored once.
docker stop "$w" >/dev/null
sudo systemctl start --no-block "$unit"
sleep 3
[[ $(systemctl show -p SubState --value "$unit") == start && $(endpoint "$w") == absent ]]
docker start "$w" >/dev/null
for i in {1..30}; do [[ $(systemctl show -p ActiveState --value "$unit") != activating ]] && break; sleep 1; done
[[ $(systemctl show -p Result --value "$unit") == success ]]; live "$w"; repaired=$(endpoint "$w")
sudo systemctl start "$unit"; [[ $(endpoint "$w") == "$repaired" ]]
docker network disconnect evse-mqtt "$w"; docker network disconnect fixture-archive "$w"
reject reconcile; [[ $(endpoint "$w") == absent ]]
docker network connect --alias weboverlay evse-mqtt "$w"

# Deterministic interleavings at the actual connect boundary. Only the fixture
# invocation has a CLI shim. One external writer wins; alternatively the old
# container vanishes and the same-name replacement MUST NOT be adopted.
stage=controlled-races
mkdir fake; export REAL_DOCKER; REAL_DOCKER=$(command -v docker)
export RACE_LOG=$fixture/races WEB_DIR=$wp PIN_NET PIN_WEB=$w
PIN_NET=$(docker network inspect --format '{{.ID}}' fixture-archive)
cat > fake/docker <<'SH'
#!/bin/bash
set -eu
if [[ $1 == --host && $3 == network && $4 == inspect && ${7:-} == "$PIN_NET" ]]; then
  case $RACE in
    noop-stamp) echo '# interleaved' >> "$WEB_DIR/.env";;
    noop-epoch) "$REAL_DOCKER" pause "$PIN_WEB" >/dev/null;;
    restored-epoch)
      echo inspect >> "$RACE_LOG.restored"
      if [[ $(wc -l < "$RACE_LOG.restored") == 1 ]]; then
        # First observation is absent on BOTH sides; external writer acts
        # only after we have obtained the real network-side reply.
        "$REAL_DOCKER" "$@"
        "$REAL_DOCKER" network connect --alias weboverlay "$PIN_NET" "$PIN_WEB"
        exit 0
      fi
      "$REAL_DOCKER" pause "$PIN_WEB" >/dev/null;;
  esac
fi
if [[ $RACE == pause && $1 == --host && $3 == network && $4 == inspect && ${7:-} == "$PIN_NET" ]]; then
  echo inspect >> "$RACE_LOG.seen"
  if [[ $(wc -l < "$RACE_LOG.seen") == 2 ]]; then "$REAL_DOCKER" pause "$PIN_WEB" >/dev/null; fi
fi
if [[ $1 == --host && $3 == network && $4 == connect ]]; then
  echo attempt >> "$RACE_LOG"
  case $RACE in
    winner) "$REAL_DOCKER" "$@";;
    replace)
      cd "$WEB_DIR"
      "$REAL_DOCKER" compose -f compose.yaml -f compose.history.yaml up -d --no-deps --no-build --pull never --force-recreate weboverlay
      "$REAL_DOCKER" network disconnect fixture-archive archive-ci-weboverlay-1;;
    *) exit 20;;
  esac
fi
exec "$REAL_DOCKER" "$@"
SH
chmod 755 fake/docker
docker network connect --alias weboverlay fixture-archive "$w"
PATH="$fixture/fake:$PATH" RACE=noop-stamp reject reconcile; sed -i '$d' "$target"
PATH="$fixture/fake:$PATH" RACE=noop-epoch reject reconcile; docker unpause "$w" >/dev/null
docker network disconnect fixture-archive "$w"
PATH="$fixture/fake:$PATH" RACE=restored-epoch reject reconcile
[[ ! -e $RACE_LOG && $(wc -l < "$RACE_LOG.restored") == 2 ]]
docker unpause "$w" >/dev/null; docker network disconnect fixture-archive "$w"
PATH="$fixture/fake:$PATH" RACE=pause reject reconcile
[[ ! -e $RACE_LOG && $(wc -l < "$RACE_LOG.seen") == 2 && $(endpoint "$w") == absent ]]
docker unpause "$w" >/dev/null
PATH="$fixture/fake:$PATH" RACE=winner reconcile; live "$w"
[[ $(wc -l < "$RACE_LOG") == 1 ]]
docker network disconnect fixture-archive "$w"
PATH="$fixture/fake:$PATH" RACE=replace reject reconcile
new=$(compose ps -q weboverlay); [[ $new != "$w" && $(endpoint "$new") == absent && $(wc -l < "$RACE_LOG") == 2 ]]
reject reconcile; [[ $(endpoint "$new") == absent ]]
[[ $(fingerprint) == "$untouched" ]]

# Real Docker daemon cold starts, NOT a simulated stopped-container start or
# a claim of a VM reboot. This runner was checked empty before fixture creation.
# Do not run this test on a shared/self-hosted daemon. Restore the replacement
# deliberately and issue a NEW approval; the old receipt must never adopt it.
stage=daemon-cold-start
[[ $(docker info --format '{{.LiveRestoreEnabled}}') == false ]]
w=$new
docker network connect --alias weboverlay fixture-archive "$w"
bash bin/stack.sh archive-pin > expected
sudo install -m 0600 expected /etc/evse-archive-link/expected
# Docker's restart-policy monitor must have observed a successful initial run.
sleep 11
cold_start() {
  local want=$1 oldpid cursor before oldendpoint
  oldpid=$(systemctl show -p MainPID --value docker.service)
  [[ $oldpid =~ ^[1-9][0-9]*$ ]]
  sudo systemctl stop docker.service docker.socket
  [[ $(systemctl show -p ActiveState --value docker.service) == inactive ]]
  [[ $(systemctl show -p ActiveState --value docker.socket) == inactive ]]
  # Two intentional cold starts on a newly provisioned runner can exhaust
  # systemd's start-rate budget. Clear the counters only AFTER proving both
  # units stopped cleanly, never retry a failed startup or change site policy.
  [[ $(systemctl show -p Result --value docker.service) == success ]]
  [[ $(systemctl show -p Result --value docker.socket) == success ]]
  sudo systemctl reset-failed docker.service docker.socket
  # No Docker CLI while stopped: socket activation would invalidate the test.
  sudo systemctl start docker.service
  [[ $(systemctl show -p MainPID --value docker.service) != "$oldpid" ]]
  for i in {1..30}; do
    [[ $(docker inspect --format '{{.State.Running}}' "$w") == true ]] && break
    sleep 1
  done
  [[ $(docker inspect --format '{{.State.Running}}' "$w") == true ]]
  if [[ $want == present ]]; then live "$w"; else [[ $(endpoint "$w") == absent ]]; fi
  oldendpoint=$(endpoint "$w")
  # The unrelated fixture has no restart policy. Fingerprint it AFTER daemon
  # startup, so daemon effects cannot be attributed to the one-shot helper.
  before=$(fingerprint)
  cursor=$(sudo journalctl -u "$unit" -n 1 --show-cursor --no-pager | sed -n 's/^-- cursor: //p')
  [[ -n $cursor ]]
  sudo systemctl start "$unit"
  [[ $(systemctl show -p Result --value "$unit") == success ]]
  if [[ $want == present ]]; then
    sudo journalctl -u "$unit" --after-cursor="$cursor" --output=cat --no-pager | grep -Fxq 'Archiv-Endpunkt bereits vorhanden.'
  else
    sudo journalctl -u "$unit" --after-cursor="$cursor" --output=cat --no-pager | grep -Fq 'Archiv-Endpunkt im Readback vorhanden (Connect-Exit '
  fi
  live "$w"; [[ $(compose ps -q weboverlay) == "$w" && $(fingerprint) == "$before" ]]
  if [[ $want == present ]]; then [[ $(endpoint "$w") == "$oldendpoint" ]]; fi
}
cold_start present
docker network disconnect fixture-archive "$w"
cold_start absent
repaired=$(endpoint "$w")
sudo systemctl start "$unit"; [[ $(endpoint "$w") == "$repaired" ]]
sudo systemctl disable --now "$unit"; reject sudo systemctl is-enabled --quiet "$unit"
echo 'Archive boot unit: endpoints, refusals/races, two real daemon cold starts (no-op/repair), unrelated container and disable checked; no VM reboot.'
