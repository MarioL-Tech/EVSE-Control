#!/bin/bash
# stdin = approved non-executable receipt. The installed copy has one Docker
# mutation: connect two previously approved full IDs. No compose/exec/up/down.
set -euo pipefail
shopt -s inherit_errexit
export LC_ALL=C
die() { echo "Archiv-Netz: $*" >&2; exit 1; }
d() { docker --host unix:///var/run/docker.sock "$@"; }
witness() {
  (( EUID != 0 )) || die 'Keine privilegierten Konfigurationslesezugriffe.'
  local root=$1 wp=$1/rasppi/weboverlay f target digest
  digest=$({
    for f in "$root/bin/.env" "$wp/compose.yaml" "$wp/compose.auth.yaml" "$wp/compose.history.yaml" "$wp/.env"; do
      if [[ $f == "$wp/.env" && -L $f ]]; then
        target="$root/.evse-settings/weboverlay/.env"
        [[ $(readlink -- "$f") == "$target" ]] || die 'Unerwarteter Settings-Link.'
        f=$target; echo settings
      fi
      # Pin cwd before opening the leaf. No arbitrary .env symlink, linked
      # ancestor, FIFO or unbounded stream. Only metadata/digest leaves here.
      (
        cd -P -- "${f%/*}" && [[ $(/bin/pwd -P) == "${f%/*}" ]] || die 'Unzulässiges Konfigurationsverzeichnis.'
        if [[ $f == "$wp/.env" && ! -e .env && ! -L .env ]]; then echo absent; exit 0; fi
        f=./${f##*/}
        [[ ! -L $f && -f $f && $(stat -c '%h' -- "$f") == 1 && $(stat -c %s -- "$f") -le 65536 ]] || die 'Unerwartete Konfigurationsdatei.'
        dd if="$f" iflag=nofollow,nonblock,count_bytes count=65537 status=none | sha256sum
      ) || exit 1
    done
  } | sha256sum) || die 'Konfigurationsfingerabdruck nicht vollständig.'
  printf '%s\n' "${digest%% *}"
}
if [[ $# == 2 && $1 == --witness ]]; then witness "$2"; exit; fi
seal=false; boot=false
case $#:${1:-} in
  1:--seal) seal=true;; 1:--reconcile) ;; 1:--boot) boot=true;; *) die 'Ungültiger Aufruf.';;
esac
if $boot; then
  [[ $EUID == 0 && $(id -u) == 0 && $(id -g) == 0 ]] || die 'Bootdienst benötigt Root-Identität.'
  [[ $(readlink -f /proc/self/fd/0) == /etc/evse-archive-link/expected && ! -L /etc/evse-archive-link/expected &&
     $(stat -Lc '%u:%g:%a:%h:%F' /proc/self/fd/0) == '0:0:600:1:regular file' ]] || die 'Freigabedatei nicht rootgeschützt.'
fi
mapfile -t pin
[[ ${#pin[@]} == 13 && ${pin[0]} == EVSE-ARCHIVE-2 ]] || die 'Ungültige Freigabedatei (ggf. neu freigeben).'
root=${pin[1]} project=${pin[2]} choice=${pin[3]} id=${pin[4]} hash=${pin[5]} db=${pin[6]}
mqttid=${pin[7]} webid=${pin[8]} dbid=${pin[9]}
hex='^[0-9a-f]{64}$'
[[ $root =~ ^/[a-zA-Z0-9_./\ -]+$ && $root != / && -d $root && $(realpath -e -- "$root") == "$root" &&
   $project =~ ^[a-z0-9][a-z0-9_-]*$ && $db =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$ &&
   ( $choice == history || $choice == auth+history ) ]] || die 'Ungültige Projektfreigabe.'
for value in "$id" "$hash" "$webid" "$dbid" "$mqttid" "${pin[10]}"; do [[ $value =~ $hex ]] || die 'Ungültige Identität.'; done
uid=${pin[11]}; gid=${pin[12]}
for value in "$uid" "$gid"; do [[ $value =~ ^[1-9][0-9]{0,9}$ ]] && ((value < 4294967295)) || die 'Ungültige Betreiberkennung.'; done
[[ $webid != "$dbid" && $dbid != "$mqttid" && $mqttid != "$webid" ]] || die 'Netze nicht getrennt.'

# --seal is called with the checkout lock already held by stack.sh. The unit
# takes the identical directory flock, including during readback. Never run or
# source anything from this directory. Only hash the approved configuration.
if ! $seal; then
  cd -P -- "$root" && [[ $(/bin/pwd -P) == "$root" ]] || die 'Projektpfad nicht stabil.'
  exec 9<.; cd /; flock -n 9 || die 'Andere Stack-Operation läuft.'
fi
wp=$root/rasppi/weboverlay
files=$wp/compose.yaml
if [[ $choice == auth+history ]]; then files+=",$wp/compose.auth.yaml"; fi
files+=",$wp/compose.history.yaml"
check_stamp() {
  local stamp
  if (( EUID == 0 )); then
    # Fixed installed code ONLY, no supplementary groups, capabilities, shell
    # startup hooks or root-opened config streams passed to the hash reader.
    stamp=$(/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C /usr/bin/setpriv \
      --reuid="$uid" --regid="$gid" --clear-groups --no-new-privs \
      --inh-caps=-all --ambient-caps=-all --bounding-set=-all \
      /bin/bash --noprofile --norc /usr/local/libexec/evse-archive-link --witness "$root" 9<&- </dev/null)
  else
    [[ $EUID == "$uid" && $(id -g) == "$gid" ]] || die 'Andere Betreiberkennung.'
    stamp=$(witness "$root")
  fi
  [[ $stamp == "${pin[10]}" ]] || die 'Plan/Webkonfiguration seit Freigabe geändert.'
}
check_stamp

label='{{ index .Config.Labels'
labels="$label \"com.docker.compose.project\" }}|$label \"com.docker.compose.service\" }}|$label \"com.docker.compose.project.working_dir\" }}|$label \"com.docker.compose.project.config_files\" }}|$label \"com.docker.compose.oneoff\" }}|$label \"com.docker.compose.config-hash\" }}|$label \"com.docker.compose.container-number\" }}"
expected="$project|weboverlay|$wp|$files|False|$hash|1"
inspect() { d container inspect --format "$1" "$id"; }
# Docker's service being active does not mean its restart-policy containers
# have started. Wait only for the pinned container, before any network write.
# Any identity/configuration mismatch or unexpected state still fails closed.
if $boot; then
  deadline=$((SECONDS + 120))
  while :; do
    unique=$(d ps -aq --no-trunc --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=weboverlay)
    [[ $unique == "$id" && $(inspect "$labels") == "$expected" ]] || die 'Container ersetzt/mehrdeutig oder Compose-Modell veraltet.'
    state=$(inspect '{{.State.Status}}|{{.State.Paused}}|{{.State.Restarting}}')
    case $state in
      'running|false|false') break;;
      'created|false|false'|'exited|false|false'|'restarting|false|true') ;;
      *) die 'Unerwarteter Webcontainerzustand.';;
    esac
    (( SECONDS < deadline )) || die 'Webcontainer innerhalb der Startfrist nicht bereit.'
    sleep 1
  done
fi
running_epoch() {
  local line prefix="$id|/$project-weboverlay-1|running|false|false|"
  line=$(inspect '{{.Id}}|{{.Name}}|{{.State.Status}}|{{.State.Paused}}|{{.State.Restarting}}|{{.State.StartedAt}}')
  [[ $line == "$prefix"?* ]] || die 'Webcontainer läuft nicht stabil unter seiner freigegebenen Identität.'
  printf '%s\n' "${line#"$prefix"}"
}

# Check real mounts (not their contents), not just the compose-hash claim. A
# read-only bind to a socket is NOT an API access restriction. Standard web
# containers have exactly the settings bind, secret files and /tmp tmpfs.
check_mounts() {
  local rec type src dst rw seen=' ' required
  [[ $(inspect '{{.HostConfig.ReadonlyRootfs}}|{{.HostConfig.Privileged}}|{{len .HostConfig.Devices}}') == 'true|false|0' ]] || die 'Unerwartete Web-Laufzeitrechte.'
  rec=$(inspect '{{range .Mounts}}{{printf "%s|%s|%s|%t\n" .Type .Source .Destination .RW}}{{end}}')
  while IFS='|' read -r type src dst rw; do
    case "$dst" in
      /tmp) [[ $type == tmpfs ]] || die 'Unerwarteter /tmp-Mount.';;
      /run/evse-settings) [[ $type == bind && $src == "$root/.evse-settings" && -d $src && $(realpath -e -- "$src") == "$src" ]] || die 'Unerwarteter Settings-Mount.';;
      /run/secrets/history-password|/run/secrets/mqtt-password)
        [[ $type == bind && -f $src && $rw == false ]] || die 'Secret-Mount ist keine readonly reguläre Datei.';;
      *) die 'Unerwarteter Mount im Webcontainer.';;
    esac
    seen+="$dst "
  done <<< "$rec"
  for required in /run/evse-settings /run/secrets/history-password; do
    [[ $seen == *" $required "* ]] || die 'Erwarteter Mount fehlt.'
  done
  if [[ $choice == auth+history ]]; then [[ $seen == *' /run/secrets/mqtt-password '* ]] || die 'Auth-Mount fehlt.'
  else [[ $seen != *' /run/secrets/mqtt-password '* ]] || die 'Unerwarteter Auth-Mount.'; fi
}

# Results of a complete observation. Never call observe as an if/! condition:
# conditional bash functions turn off errexit, including in nested commands.
observe() {
  local unique line k n nid rec endpoint membership fmt alias prefix
  local -A actual=()
  unique=$(d ps -aq --no-trunc --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=weboverlay)
  [[ $unique == "$id" && $(inspect "$labels") == "$expected" ]] || die 'Container ersetzt/mehrdeutig oder Compose-Modell veraltet.'
  epoch=$(running_epoch)
  check_mounts
  rec=$(inspect '{{range $name,$e := .NetworkSettings.Networks}}{{printf "%s|%s|%s\n" $name $e.NetworkID $e.EndpointID}}{{end}}')
  while IFS='|' read -r n nid endpoint; do
    [[ ( $n == evse-mqtt || $n == "${project}_web" || $n == "$db" ) && $nid =~ $hex && $endpoint =~ $hex ]] || die 'Unerwartete oder unvollständige Container-Endpunkte.'
    actual[$n]="$nid|$endpoint"
  done <<< "$rec"
  present=0; others=''
  # Require the network-side endpoint and container-side ID to agree. Never
  # resolve the mutating call by name, even after a same-name recreation.
  # Network inspect may return a typed map of *value structs*: indexing an
  # absent key yields a truthy zero struct, not nil. Match actual keys only.
  fmt='{{.ID}}|{{.Name}}|{{.Driver}}|{{.Scope}}|{{$ep := "absent"}}{{range $cid,$e := .Containers}}{{if eq $cid "'"$id"'"}}{{$ep = $e.EndpointID}}{{end}}{{end}}{{$ep}}'
  for k in mqtt web archive; do
    case $k in mqtt) n=evse-mqtt; nid=$mqttid;; web) n=${project}_web; nid=$webid;; archive) n=$db; nid=$dbid;; esac
    line=$(d network inspect --format "$fmt" "$nid")
    prefix="$nid|$n|bridge|local|"; [[ $line == "$prefix"* ]] || die 'Freigegebenes lokales Bridge-Netz fehlt.'
    membership=${line#"$prefix"}
    if [[ $k == archive && $membership == absent && ! ${actual[$n]+x} ]]; then continue; fi
    [[ $membership =~ $hex && ${actual[$n]:-} == "$nid|$membership" ]] || die 'Netz-/Containerbefund unvollständig oder widersprüchlich.'
    alias=$(inspect '{{$ok := false}}{{with index .NetworkSettings.Networks "'"$n"'"}}{{range .Aliases}}{{if eq . "weboverlay"}}{{$ok = true}}{{end}}{{end}}{{end}}{{$ok}}')
    [[ $alias == true ]] || die 'Erwarteter Websitealias fehlt.'
    if [[ $k == archive ]]; then present=1; else others+="|$membership"; fi
  done
}
observe
start=$epoch; stable=$others
final_gate() {
  local last
  check_stamp
  last=$(running_epoch); [[ $last == "$start" ]] || die 'Laufzeitinstanz seit Beobachtung gewechselt.'
}
if $seal; then
  [[ $present == 1 ]] || die 'Nur vollständigen, unveränderten Sollzustand freigeben.'
  final_gate
  printf '%s\n' "${pin[@]}"; exit 0
fi
if ((present)); then final_gate; echo 'Archiv-Endpunkt bereits vorhanden.'; exit 0; fi
observe
[[ $epoch == "$start" && $others == "$stable" ]] || die 'Zustand wechselte vor dem Verbinden.'
final_gate
if ((present)); then echo 'Archiv-Endpunkt bereits wieder vorhanden.'; exit 0; fi
rc=0
d network connect --alias "$project-weboverlay-1" --alias weboverlay "$dbid" "$id" || rc=$?
# A competing operator may have won, or the reply may have been lost. NO
# retry or rollback: decide from readback without attributing causality.
observe
[[ $present == 1 && $epoch == "$start" && $others == "$stable" ]] || die 'Endzustand unklar; manuell prüfen, kein weiterer Versuch.'
final_gate
echo "Archiv-Endpunkt im Readback vorhanden (Connect-Exit $rc)."
