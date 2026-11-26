#!/usr/bin/env bash
# Manual, disposable QEMU/KVM fixture. Never run on the operator's Pi. The
# hypervisor powers the guest off/on BETWEEN prepare and verify; this script
# neither reboots a host nor fabricates a second boot by restarting Docker.
set -euo pipefail
[[ $# == 1 && ($1 == prepare || $1 == verify) && $EUID != 0 ]]
[[ $(systemd-detect-virt --vm) =~ ^(kvm|qemu)$ && $(id -un) == qa ]]
[[ -f /etc/evse-disposable-cold-boot && ! -L /etc/evse-disposable-cold-boot && $(stat -c '%u:%g:%a' /etc/evse-disposable-cold-boot) == 0:0:600 ]]
[[ ! ${DOCKER_HOST:-} && ! ${DOCKER_CONTEXT:-} && $(docker context inspect --format '{{.Endpoints.docker.Host}}') == unix:///var/run/docker.sock ]]
root=$(cd "$(dirname "$0")/../.." && pwd -P); cd "$root"
wp=$root/rasppi/weboverlay; sp=$root/rasppi/storage
dc() (cd "$wp"; docker compose -f compose.yaml -f compose.history.yaml "$@");
stack() { bash bin/stack.sh "$@"; }
unit=evse-archive-link.service
db=kvm-archive-db
net=kvm-archive-sql
rows() {
  # Both observations must come back over HTTP, not merely a healthy port.
  docker exec -i "$w" php <<'PHP'
<?php
$ctx = stream_context_create(['http'=>['timeout'=>5]]);
foreach (['history'=>1729, 'house-history'=>-251] as $api=>$value) {
    $body = @file_get_contents("http://127.0.0.1:8080/api/$api?minutes=15", false, $ctx);
    $r = $body === false ? null : json_decode($body, true);
    if (($r['status'] ?? null) !== 'ok' || ($r['read_only'] ?? null) !== true) exit(1);
    $values = array_map(static fn($s) => $api === 'history' ? $s['values']['active_power_w'] : $s['power_w'], $r['samples']);
    if ($values !== [$value] && $values !== [(float)$value]) exit(1);
}
PHP
}
if [[ $1 == verify ]]; then
  read -r original w database < "$HOME/cold-ids"
  [[ $original != "$(cat /proc/sys/kernel/random/boot_id)" && $(dc ps -q weboverlay) == "$w" && $(docker inspect --format '{{.Id}}' "$db") == "$database" ]]
  [[ $(systemctl show -p Result --value "$unit") == success ]]
  [[ $(sudo journalctl -b -u "$unit" -o cat --no-pager) == *'Archiv-Endpunkt im Readback vorhanden (Connect-Exit 0).'* ]]
  deadline=$((SECONDS+75)); until rows; do ((SECONDS < deadline)) || exit 1; sleep 1; done
  stack check
  echo 'Kaltstart: neue Boot-ID, dieselben Web-/DB-IDs und beide alten SQL-Werte.'; exit
fi
# Fail before touching anything on an already-used guest or checkout. Supply
# only a committed git archive, no site configs, no existing units/approvals.
[[ -z $(docker ps -aq) && ! -e /etc/evse-archive-link && ! -e /etc/systemd/system/$unit ]]
for f in bin/.env "$wp/.env" "$wp/dummy-reader" .evse-settings "$HOME/cold-ids"; do [[ ! -e $f && ! -L $f ]]; done
docker network create evse-mqtt >/dev/null; docker network create --internal "$net" >/dev/null
docker volume create kvm-archive-test-db >/dev/null
mkdir .evse-settings; printf 'web history\n' > bin/.env
printf 'dummy-only-reader\n' > "$wp/dummy-reader"; chmod 0644 "$wp/dummy-reader"
cat > "$wp/.env" <<ENV
COMPOSE_PROJECT_NAME=kvm-archive
DB_NETWORK=$net
HISTORY_DB_HOST=$db
HISTORY_DB_NAME=evse_history_test
HISTORY_DB_USERNAME=history_reader
HISTORY_DB_PASSWORD_HOST_FILE=./dummy-reader
WEB_HOUSE_HISTORY_ENABLED=1
ENV
cat > "$HOME/kvm-init.sql" <<'SQL'
USE evse_history_test;
INSERT INTO evse_house_schema_versions VALUES (1,UNHEX('db10ad75e9947799db2a896f3211c2c3ba6f64afa75219620630dcbb8a139391'),UTC_TIMESTAMP(6));
GRANT SELECT ON evse_history_test.* TO 'history_reader'@'%';
SQL
docker run -d --name "$db" --restart unless-stopped --network "$net" -v kvm-archive-test-db:/var/lib/mysql \
  -e MARIADB_DATABASE=evse_history_test -e MARIADB_ROOT_PASSWORD=dummy-ci-only \
  -v "$sp/migrations/001_initial.sql:/docker-entrypoint-initdb.d/010.sql:ro" \
  -v "$wp/tests/history-init.sql:/docker-entrypoint-initdb.d/020.sql:ro" \
  -v "$sp/migrations/003_house.sql:/docker-entrypoint-initdb.d/030.sql:ro" \
  -v "$HOME/kvm-init.sql:/docker-entrypoint-initdb.d/040.sql:ro" mariadb:11.8.8 >/dev/null
dc up -d --build --wait weboverlay
w=$(dc ps -q weboverlay); database=$(docker inspect --format '{{.Id}}' "$db")
deadline=$((SECONDS+90)); until docker exec "$db" healthcheck.sh --connect --innodb_initialized; do ((SECONDS < deadline)) || exit 1; sleep 1; done
docker exec -i "$db" mariadb -uhistory_writer -pdummy-only-writer evse_history_test <<'SQL'
SET @t=UTC_TIMESTAMP(6);
INSERT INTO evse_wallbox_samples(source,payload_sha256,measured_at,received_at,retained,status,active_power_w,payload_json)
VALUES ('evse/wallbox',UNHEX(SHA2('fixture',256)),@t,@t,0,'ok',1729,'{}');
INSERT INTO evse_house_samples(source,publisher_id,sequence,fetched_at,received_at,status,last_success_at,power_w,error_code,retained,digest)
VALUES ('evse/house',UNHEX(REPLACE(UUID(),'-','')),1,@t,@t,'ok',@t,-251,NULL,0,UNHEX(SHA2('fixture',256)));
SQL
rows; stack archive-pin > "$HOME/cold-pin"
sudo install -d -m 0700 /etc/evse-archive-link{,/docker-config}
sudo install -m 0600 "$HOME/cold-pin" /etc/evse-archive-link/expected
sudo install -D -m 0755 bin/archive-link.sh /usr/local/libexec/evse-archive-link
sudo install -m 0644 "bin/$unit" "/etc/systemd/system/$unit"; sudo systemctl daemon-reload; sudo systemctl enable "$unit"
docker network disconnect "$net" "$w"; ! rows || exit 1
docker exec "$w" php /app/docker/healthcheck.php
printf '%s %s %s\n' "$(cat /proc/sys/kernel/random/boot_id)" "$w" "$database" > "$HOME/cold-ids"
echo 'Archive getrennt, HTTP lebt. Jetzt ausschließlich den Wegwerfgast ausschalten und erneut starten.'
