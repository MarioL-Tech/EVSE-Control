#!/usr/bin/env bash
# Host wrapper: Docker runs all application logic; shell only links OS config files.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../.." && pwd -P)"
cd "$repo"
test ! -L .evse-settings || { echo 'Refusing linked settings root.' >&2; exit 1; }
services=(uart wallbox storage weboverlay)
paths=(rasppi rasppi/wallbox rasppi/storage rasppi/weboverlay)
for i in "${!services[@]}"; do
  path="${paths[$i]}/.env"
  target="$repo/.evse-settings/${services[$i]}/.env"
  if test -L "$path"; then
    test "$(readlink "$path")" = "$target" || { echo 'Unexpected .env link; stopped.' >&2; exit 1; }
  elif test -e "$path"; then
    test -f "$path" && test ! -e "$path.before-settings" && test ! -L "$path.before-settings" || {
      echo 'Unexpected file/backup; stopped without replacing it.' >&2; exit 1;
    }
  fi
done
docker build --target runtime -t evse-settings-setup:local rasppi/weboverlay
mkdir -p .evse-settings
docker run --rm --network none --read-only --user 0:0 \
  --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE --cap-add FSETID \
  --security-opt no-new-privileges:true --entrypoint php \
  --mount "type=bind,src=$repo,dst=/source,readonly" \
  --mount "type=bind,src=$repo/.evse-settings,dst=/run/evse-settings" \
  evse-settings-setup:local /app/docker/provision-settings.php "$(id -g)" "$repo"
for i in "${!services[@]}"; do
  path="${paths[$i]}/.env"
  target="$repo/.evse-settings/${services[$i]}/.env"
  if test -L "$path"; then continue; fi
  if test -e "$path"; then
    mv -n -- "$path" "$path.before-settings"
    test ! -e "$path" || { echo 'Backup conflict; stopped.' >&2; exit 1; }
    chmod 600 "$path.before-settings"
    if ! cmp -s "$path.before-settings" "$target"; then
      mv -n -- "$path.before-settings" "$path"
      echo 'Concurrent .env change; restored original, stopped.' >&2; exit 1
    fi
  fi
  ln -s -- "$target" "$path"
done
echo 'Editor files linked. Backups retained. Recreate only the website with your existing Compose selection.'
echo 'No login: every reachable client can edit. Restrict access to a trusted LAN.'
