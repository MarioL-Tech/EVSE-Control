#!/usr/bin/env bash
# Linux operator entry point. Docker owns containers; no resident controller.
set -euo pipefail
die() { printf '%s\n' "$*" >&2; exit 1; }
(( EUID != 0 )) || die 'Checkout nur als unprivilegierter Docker-Betreiber ausführen.'
[[ $# == 1 ]] || die 'Aufruf: bash bin/stack.sh plan|up|build-up|stop|check|archive-pin'
action=$1
case $action in plan|up|build-up|stop|check|archive-pin) ;; *) die 'Unbekannte Stack-Aktion.';; esac
shopt -s inherit_errexit
root=$(cd "$(dirname "$0")/.." && pwd -P)
exec 9<"$root"
flock -n 9 || die 'Andere Stack-Operation läuft.'
[[ -f $root/bin/.env ]] || die 'Zuerst bin/stack-plan.example nach bin/.env kopieren und gegen den Bestand prüfen.'
if [[ $action == archive-pin ]]; then before=$(bash "$root/bin/archive-link.sh" --witness "$root"); fi
declare -A opt=() projects=() db=() wall=() house=() device=() targets=() files=() paths=(
  [web]=rasppi/weboverlay [storage]=rasppi/storage [reader]=rasppi/wallbox [uart]=rasppi
)
while read -r k v extra || [[ -n ${k:-} ]]; do
  [[ -z $k || $k == '#'* ]] && continue
  case "$k:$v" in web:base|web:history|web:auth|web:auth+history|storage:base|storage:auth|reader:base|reader:auth|rollup:on|https:on|uart:gateway) ;;
    *) die 'Unbekannter Planeintrag (keine Env-/Secretwerte im Plan).';; esac
  [[ -z $extra && -z ${opt[$k]+x} ]] || die 'Ungültiger oder doppelter Planeintrag.'
  opt[$k]=$v
done < "$root/bin/.env"
[[ ! ${opt[rollup]:-} || ${opt[storage]:-} ]] || die 'rollup benötigt storage.'
[[ ! ${opt[https]:-} || ${opt[web]:-} ]] || die 'https benötigt web.'
roles=()
for role in storage web reader uart; do [[ ! ${opt[$role]:-} ]] || roles+=("$role"); done
((${#roles[@]})) || die 'Leerer Plan.'

# No shared shell overrides (e.g. MQTT_CLIENT_ID). Preserve the installed
# Docker client config/context; operate on a local Linux engine, never via SSH.
[[ ! ${DOCKER_HOST:-} && ! ${DOCKER_CONTEXT:-} ]] || die 'Explizite Docker-Host-/Kontext-Overrides nicht unterstützt.'
client() { env -i PATH="$PATH" HOME="$HOME" DOCKER_CONFIG="${DOCKER_CONFIG:-$HOME/.docker}" \
  COMPOSE_REMOVE_ORPHANS=0 ${XDG_RUNTIME_DIR:+"XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR"} "$@"; }
host=$(client docker context inspect --format '{{.Endpoints.docker.Host}}')
[[ $host == unix:///* ]] || die 'Nur lokaler Unix-Docker-Kontext.'
d() { client docker --host "$host" "$@"; }
# The editor's persistent 0600 locks belong to the website uid, not to the
# operator. Freeze the interpolation inputs instead. An editor save renames
# its .env; a single open sees the complete old or new inode. Compose must
# consume the exact same private bytes for config/ownership, up and check.
# Stable per-checkout names preserve recognizable Compose environment_file
# labels. Atomic mkdir, never adopt or read a pre-existing scratch directory.
[[ $(stat -f -c %T /dev/shm) == tmpfs ]] || die 'Privates tmpfs für Compose-Snapshots nicht verfügbar.'
umask 077
key=$(printf '%s' "$root" | sha256sum); scratch=/dev/shm/evse-stack-$EUID-${key%% *}
mkdir -m 0700 -- "$scratch" || die 'Snapshotverzeichnis belegt; unter Betreiberkontrolle klären.'
trap 'rm -f -- "$scratch"/{storage,web,reader,uart}.env; rmdir -- "$scratch"' EXIT
for role in "${roles[@]}"; do
  src="$root/${paths[$role]}/.env"; dest="$scratch/$role.env"
  if [[ -L $src ]]; then
    case $role in reader) settings=wallbox;; web) settings=weboverlay;; *) settings=$role;; esac
    target="$root/.evse-settings/$settings/.env"
    [[ $(readlink -- "$src") == "$target" && $(realpath -e -- "${target%/*}") == "${target%/*}" ]] || die "Unerwarteter Settings-Link: $role."
    src=$target
  elif [[ ! -e $src ]]; then
    [[ -x ${src%/*} ]] || die "Dienstverzeichnis nicht zugänglich: $role."
    : > "$dest"; chmod 0400 -- "$dest"; continue
  fi
  [[ -f $src && ! -L $src ]] || die "Unerwartete Dienst-.env: $role."
  dd if="$src" iflag=nofollow,nonblock,count_bytes count=65537 status=none > "$dest"
  [[ $(stat -c %s -- "$dest") -le 65536 ]] || die "Dienst-.env zu groß: $role."
  chmod 0400 -- "$dest"
done
dc() (
  local r=$1; shift
  cd "$root/${paths[$r]}"
  local args=(--env-file "$scratch/$r.env" -f compose.yaml)
  [[ ${opt[$r]} != *auth* ]] || args+=(-f compose.auth.yaml)
  [[ ${opt[$r]} != *history* ]] || args+=(-f compose.history.yaml)
  [[ $r != storage || ! ${opt[rollup]:-} ]] || args+=(--profile history)
  [[ $r != web || ! ${opt[https]:-} ]] || args+=(--profile https)
  [[ $r != uart ]] || args+=(--profile tools)
  d compose "${args[@]}" "$@"
)
image=python:3.12-slim-bookworm@sha256:44cf1793efa7c7a476bb0f2cff81443f4a072c90c1cb127e2924933daa3e8c64
for role in "${roles[@]}"; do
  p="$root/${paths[$role]}"
  if [[ -s $scratch/$role.env ]]; then
    # -f is deliberate. Refuse a competing native selection rather than
    # silently applying the wrong files. Never source or print .env.
    # Both KEY=value and KEY: value are accepted by compose-go. A read error
    # (including an editor/symlink race) is NOT a negative grep result.
    if LC_ALL=C grep -aE $'^(\xef\xbb\xbf)?[[:space:]]*(export[[:space:]]+)?(COMPOSE_FILE|COMPOSE_ENV_FILES|COMPOSE_DISABLE_ENV_FILE|DOCKER_HOST|DOCKER_CONTEXT)[[:space:]]*[:=]' "$scratch/$role.env" >/dev/null; then
      die "Abweichende Compose-Dateiauswahl in $role; bisherigen Einzelaufruf beibehalten."
    else
      [[ $? == 1 ]] || die "Dienst-.env nicht prüfbar: $role."
    fi
  fi
  history=off; [[ ${opt[$role]} != *history* ]] || history=on
  model=$(dc "$role" config --format json | d run --rm -i --network none --read-only --log-driver none \
    --user 65534:65534 --cap-drop ALL --security-opt no-new-privileges:true \
    --mount "type=bind,src=$root/bin/stack-model.py,dst=/model.py,readonly" "$image" python -IB /model.py "$role" "$history" "$p")
  read -r project network w h dev services <<< "$model"
  for other in "${projects[@]}"; do [[ $project != "$other" ]] || die 'Projektname mehrfach vergeben.'; done
  projects[$role]=$project; db[$role]=$network; wall[$role]=$w; house[$role]=$h; device[$role]=$dev; targets[$role]=$services
  f="$p/compose.yaml"
  [[ ${opt[$role]} != *auth* ]] || f+=",$p/compose.auth.yaml"
  [[ $history != on ]] || f+=",$p/compose.history.yaml"
  files[$role]=$f
  if [[ $action != archive-pin ]]; then printf '%s: %s (%s)\n' "$role" "$services" "$project"; fi
done
if [[ ${db[web]:--} != - && ${db[storage]:--} != - && ${db[web]} != "${db[storage]}" ]]; then
  die 'Website und Storage nennen verschiedene externe DB-Netze.'
fi

# Compare prior Compose ownership and overlays, including stopped instances.
# A plan may add an overlay, never silently strip one. Do not adopt one-offs.
guard() {
  local role=$1 service=$2 ids id line project dir old one running envfile count=0 file
  ids=$(d ps -aq --filter "label=com.docker.compose.service=$service")
  for id in $ids; do
    line=$(d inspect --format '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}|{{index .Config.Labels "com.docker.compose.project.config_files"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}|{{.State.Running}}|{{index .Config.Labels "com.docker.compose.project.environment_file"}}' "$id")
    IFS='|' read -r project dir old one running envfile <<< "$line"
    if [[ ${one,,} == true ]]; then
      [[ $running == false ]] || die "Aktiver Einmalcontainer: $service. Erst manuell klären."
      continue
    fi
    [[ ${one,,} == false ]] || die "Fehlende/ungültige Compose-Eigentumslabels: $service."
    [[ $project == "${projects[$role]}" && $dir == "$root/${paths[$role]}" && -n $old ]] || die "Anderer/unklarer Besitzer: $service. Kein Zweitstart."
    [[ -z $envfile || $envfile == "$dir/.env" || $envfile == .env || $envfile == "$scratch/$role.env" ]] || die "Vorhandener abweichender --env-file-Aufruf für $service."
    ((++count == 1)) || die "Mehrere Instanzen: $service."
    local -a prior wanted
    IFS=, read -ra prior <<< "$old"
    IFS=, read -ra wanted <<< "${files[$role]}"
    [[ $old != *, && ${prior[0]} == "$dir/compose.yaml" ]] || die "Unklare bisherige Dateiauswahl für $service."
    local cursor=0
    for file in "${prior[@]}"; do
      while ((cursor < ${#wanted[@]})) && [[ ${wanted[cursor]} != "$file" ]]; do ((++cursor)); done
      ((cursor < ${#wanted[@]})) || die "Vorhandenes Overlay für $service fehlt oder hat andere Reihenfolge."
      ((++cursor))
    done
    if [[ $running == true && " ${targets[$role]} " != *" $service "* ]]; then
      die "Laufender optionaler Dienst $service fehlt im Plan."
    fi
  done
}
for role in "${roles[@]}"; do
  case $role in storage) known='storage history-rollup';; web) known='weboverlay https';; *) known=${targets[$role]};; esac
  for svc in $known; do guard "$role" "$svc"; done
done
# Catch other Docker device mappings even when the service was started without
# Compose or under a different service name. Not a lock on unmanaged host I/O.
device_key() {
  if [[ -c $1 ]]; then stat -Lc '%t:%T' -- "$1"; else realpath -m -- "$1"; fi
}
if [[ $action != stop && ( ${device[reader]:--} != - || ${device[uart]:--} != - ) ]]; then
  if [[ ${device[reader]:--} != - && ${device[uart]:--} != - && $(device_key "${device[reader]}") == "$(device_key "${device[uart]}")" ]]; then
    die 'UART und Wallbox konfigurieren dasselbe Gerät.'
  fi
  ids=$(d ps -q)
  for role in reader uart; do
    [[ ${device[$role]:--} != - ]] || continue
    key=$(device_key "${device[$role]}")
    own=$(dc "$role" ps -q "${targets[$role]}")
    for id in $ids; do
      [[ -z $own || $own != "$id"* ]] || continue
      mappings=$(d inspect --format '{{range .HostConfig.Devices}}{{println .PathOnHost}}{{end}}' "$id")
      while IFS= read -r path; do
        [[ -n $path ]] || continue
        mapped=$(device_key "$path")
        [[ $mapped != "$key" ]] || die "Gerät von $role ist bereits einem anderen Container zugeordnet."
      done <<< "$mappings"
    done
  done
fi
[[ $action != plan ]] || exit 0

# Enrol ONLY an already correctly deployed and attached archive client. The
# privileged boot path does not parse Compose or execute code from this checkout.
if [[ $action == archive-pin ]]; then
  [[ $host == unix:///var/run/docker.sock && ${db[web]:--} != - ]] || die 'Pin benötigt Standard-Docker-Socket und explizites Webarchiv.'
  id=$(dc web ps -q weboverlay)
  [[ $id =~ ^[0-9a-f]{64}$ ]] || die 'Kein eindeutiger laufender Webcontainer.'
  project=${projects[web]}; net=${db[web]}
  hash=$(dc web config --hash weboverlay)
  [[ $hash =~ ^weboverlay\ ([0-9a-f]{64})$ ]] || die 'Compose-Konfigurationshash fehlt.'
  hash=${BASH_REMATCH[1]}
  pins=(EVSE-ARCHIVE-2 "$root" "$project" "${opt[web]}" "$id" "$hash" "$net")
  for n in evse-mqtt "${project}_web" "$net"; do
    nid=$(d network inspect --format '{{.ID}}' "$n"); pins+=("$nid")
  done
  # Includes the witness from BEFORE loading the plan/model. Sealing rejects
  # changed inputs, even when the pre-change service hash matched the labels.
  pins+=("$before" "$EUID" "$(id -g)")
  printf '%s\n' "${pins[@]}" | client bash "$root/bin/archive-link.sh" --seal
  exit 0
fi

if [[ $action == stop ]]; then
  for ((i=${#roles[@]}-1;i>=0;i--)); do
    role=${roles[i]}; read -ra selected <<< "${targets[$role]}"; dc "$role" stop "${selected[@]}"
  done
  exit 0
fi
if [[ $action == up || $action == build-up ]]; then
  extra=(); [[ $action != build-up ]] || extra+=(--build)
  for role in "${roles[@]}"; do
    read -ra selected <<< "${targets[$role]}"
    dc "$role" up -d "${extra[@]}" "${selected[@]}"
  done
fi

# Read-only checks: service process, actual endpoint ID, two bounded public API
# projections. Report independent failures, do not repair or restart anything.
failed=0
# .PathOnHost is the stored source, NOT the container's device node. A host
# symlink can even be retargeted while the container still has the old rdev.
actual_device() {
  local id=$1 source=$2 target=$3 rec configured inside extra want got
  rec=$(d inspect --format '{{range .HostConfig.Devices}}{{printf "%s|%s\n" .PathOnHost .PathInContainer}}{{end}}' "$id") || return 1
  [[ $rec != *$'\n'* ]] || return 1
  IFS='|' read -r configured inside extra <<< "$rec"
  [[ -z $extra && $inside == "$target" && -c $configured && -c $source ]] || return 1
  want=$(stat -Lc '%t:%T' -- "$source") || return 1
  [[ $(stat -Lc '%t:%T' -- "$configured") == "$want" ]] || return 1
  got=$(client timeout -k 1 5 docker --host "$host" exec "$id" stat -Lc '%f:%t:%T' -- "$target") || return 1
  [[ $got =~ ^2[[:xdigit:]]{3}: && ${got#*:} == "$want" ]]
}
for role in "${roles[@]}"; do
  for svc in ${targets[$role]}; do
    id=$(dc "$role" ps -q "$svc")
    if [[ ! $id =~ ^[[:xdigit:]]{12,64}$ || $(d inspect --format '{{.State.Running}}' "$id") != true ]]; then
      echo "$svc: läuft nicht/eindeutig nicht prüfbar." >&2; failed=1; continue
    fi
    case $role in reader) port=/dev/ttyWallbox;; uart) port=/dev/serial0;; *) port=;; esac
    if [[ -n $port ]] && ! actual_device "$id" "${device[$role]}" "$port"; then
      echo "$svc: konfiguriertes Hostgerät und tatsächliches Containergerät nicht als identisch bestätigt." >&2; failed=1
    fi
    if [[ ${db[$role]} != - && $svc != https ]]; then
      netid=$(d network inspect --format '{{.ID}}' "${db[$role]}" 2>/dev/null) || netid=''
      attached=$(d inspect --format '{{range .NetworkSettings.Networks}}{{if .EndpointID}}{{println .NetworkID}}{{end}}{{end}}' "$id")
      if [[ ! $netid =~ ^[[:xdigit:]]{64}$ ]] || ! grep -Fxq -- "$netid" <<< "$attached"; then
        echo "$svc: konfigurierte DB-Netzmitgliedschaft fehlt tatsächlich." >&2; failed=1
      else echo "$svc: DB-Netzmitgliedschaft bestätigt."; fi
    fi
    [[ $svc == weboverlay ]] || continue
    for endpoint in history house-history; do
      flag=${wall[$role]}; [[ $endpoint == history ]] || flag=${house[$role]}
      expected=disabled; [[ $flag == 0 ]] || expected=ok
      seen=0
      for attempt in 1 2 3; do
        # Outer timeout bounds a stalled docker exec as well as PHP/cURL.
        if client timeout -k 1 6 docker --host "$host" exec -i "$id" php -- "$endpoint" "$expected" < "$root/bin/stack-api.php"; then seen=1; break; fi
        [[ $attempt == 3 ]] || sleep 1
      done
      if ((seen)); then echo "$svc: /api/$endpoint $expected."
      else echo "$svc: /api/$endpoint nicht wie erwartet ($expected)." >&2; failed=1; fi
    done
  done
done
exit "$failed"
