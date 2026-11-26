#!/usr/bin/env bash
# Disposable GitHub-hosted Linux runner ONLY. No production config or hardware.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && ${RUNNER_OS:-} == Linux ]]
existing=$(docker ps -aq); [[ -z $existing ]] # refuse shared/unavailable daemons
git check-ignore -q bin/.env
tracked=$(git ls-files -- bin/.env); [[ -z $tracked ]]
fixture=$(mktemp -d)
# Exercise tracked WORKTREE bytes, not a stale HEAD; never copy ignored site
# config, secrets, or other untracked files into the disposable fixture.
git ls-files -z -- bin rasppi | tar --null -T - -cf - | tar -x -C "$fixture"
cd "$fixture"
wp=$fixture/rasppi/weboverlay
sp=$fixture/rasppi/storage
stack() { bash bin/stack.sh "$@"; }
reject() { if "$@"; then echo 'Expected refusal' >&2; exit 1; fi; }
# A first build creates the unapproved plan, then builds ALL runtime images,
# including roles not selected for operation, with no site env,
# secrets, devices, networks, or containers. Existing plans are never replaced.
stack build
cmp bin/.env bin/stack-plan.example
[[ -z $(docker ps -aq) ]]
docker image inspect evse-storage:local weboverlay-weboverlay weboverlay-https wallbox-wallbox-reader rasppi-uart-bridge >/dev/null
cp bin/.env unapproved-plan
reject stack up
reject stack build-up
cmp bin/.env unapproved-plan
[[ -z $(docker ps -aq) ]]
printf 'web auth+history\nstorage auth\nrollup on\nhttps on\nreader auth\nuart gateway\n' > bin/.env
cp bin/.env expected-build-plan
stack build
cmp bin/.env expected-build-plan
[[ -z $(docker ps -aq) ]]
docker image inspect evse-storage:local weboverlay-weboverlay weboverlay-https wallbox-wallbox-reader rasppi-uart-bridge >/dev/null
# A nonempty existing invalid plan must be rejected, not silently replaced.
printf 'invalid entry\n' > bin/.env
reject stack build
grep -Fxq 'invalid entry' bin/.env
# An empty existing plan is also preserved and refused.
: > bin/.env
reject stack build
[[ ! -s bin/.env ]]
mkdir -p "$wp/secrets" "$sp/secrets"
printf 'dummy-only-reader\n' > "$wp/secrets/history.txt"
printf 'dummy-mqtt\n' > "$wp/secrets/mqtt.txt"
printf 'dummy-only-writer\n' > "$sp/secrets/db-password.txt"
printf 'dummy-mqtt\n' > "$sp/secrets/mqtt-password.txt"
cat > "$wp/.env" <<'SITE'
COMPOSE_PROJECT_NAME=stackci-web
COMPOSE_PROFILES=https
WEB_BIND_ADDRESS=127.0.0.1
WEB_PORT=18080
WEB_HTTPS_PORT=18443
WEB_HOUSE_HISTORY_ENABLED=1
DB_NETWORK=stackci-data
HISTORY_DB_HOST=stackci-maria
HISTORY_DB_NAME=evse_history_test
HISTORY_DB_USERNAME=history_reader
HISTORY_DB_PASSWORD_HOST_FILE=./secrets/history.txt
MQTT_USERNAME=stackci
MQTT_PASSWORD_HOST_FILE=./secrets/mqtt.txt
MQTT_CLIENT_ID=stackci-web-only
SITE
cat > "$sp/.env" <<'SITE'
COMPOSE_PROJECT_NAME=stackci-storage
COMPOSE_PROFILES=tools
DB_NETWORK=stackci-data
DB_HOST=stackci-maria
DB_NAME=evse_history_test
DB_USERNAME=history_writer
MQTT_USERNAME=stackci
MQTT_CLIENT_ID=stackci-storage-only
SITE
printf 'MQTT_PASSWORD_HOST_FILE=./dummy-not-mounted\n' > rasppi/wallbox/.env
printf 'UART_MODE=gateway\nUART_RESTART_POLICY=unless-stopped\nUART_NETWORK_MODE=evse-mqtt\n' > rasppi/.env
printf 'web auth+history\nstorage auth\nrollup on\nreader auth\nuart gateway\n' > bin/.env
# Deliberately conflicting process env must not leak into either project's
# Compose model. dotenv profiles and explicit profile selection are both used.
export COMPOSE_PROJECT_NAME=wrong-from-process MQTT_CLIENT_ID=wrong-from-process
plan=$(stack plan)
unset COMPOSE_PROJECT_NAME MQTT_CLIENT_ID
grep -Fxq 'storage: storage history-rollup (stackci-storage)' <<< "$plan"
grep -Fxq 'web: weboverlay https (stackci-web)' <<< "$plan"
grep -Fq 'reader: wallbox-reader' <<< "$plan"; grep -Fq 'uart: uart-bridge' <<< "$plan"
[[ $plan != *migrate* ]]
printf 'UART_RESTART_POLICY=no\n' >> rasppi/.env; reject stack plan; sed -i '$d' rasppi/.env
# No PTY or host hardware. Two plans claiming the same nonexistent path must
# be rejected before either port-owning service is created.
printf 'WALLBOX_DEVICE=/dev/evse-ci-nonexistent\n' >> rasppi/wallbox/.env
printf 'UART_DEVICE=/dev/evse-ci-nonexistent\n' >> rasppi/.env
reject stack plan
sed -i '$d' rasppi/wallbox/.env; sed -i '$d' rasppi/.env
printf 'web auth+history\nstorage auth\n' > bin/.env
printf 'DB_NETWORK=wrong-fixture-network\n' >> "$sp/.env"
reject stack plan
sed -i '$d' "$sp/.env"
printf 'export COMPOSE_FILE: other-overlay.yaml\n' >> "$sp/.env"; reject stack plan; sed -i '$d' "$sp/.env"
# Reject an I/O error while checking for a competing Compose selection.
mkdir "$fixture/failed-grep"; printf '#!/bin/sh\nexit 2\n' > "$fixture/failed-grep/grep"; chmod 755 "$fixture/failed-grep/grep"
PATH="$fixture/failed-grep:$PATH" reject stack plan
# With no .env profile, explicit https is needed and migrate remains excluded.
sed -i '/^COMPOSE_PROFILES=https$/d' "$wp/.env"; printf 'web auth+history\nstorage auth\n' > bin/.env
plan=$(stack plan); grep -Fxq 'web: weboverlay (stackci-web)' <<< "$plan"
grep -Fxq 'storage: storage (stackci-storage)' <<< "$plan"
printf 'https on\nrollup on\n' >> bin/.env; plan=$(stack plan)
grep -Fxq 'web: weboverlay https (stackci-web)' <<< "$plan"
grep -Fxq 'storage: storage history-rollup (stackci-storage)' <<< "$plan"
printf 'COMPOSE_PROFILES=https\n' >> "$wp/.env"
printf 'COMPOSE_FILE=compose.yaml:other-overlay.yaml\n' >> "$sp/.env"
reject stack plan
sed -i '$d' "$sp/.env"
printf 'web base\n' > bin/.env
reject stack plan # enabled HOUSE cannot be deployed without actual DB overlay
printf 'web auth+history\nstorage auth\n' > bin/.env

# Distinguish the effective-model refusal from a compose parser failure.
# Never mount the socket: plan only and a fictitious path.
cp "$wp/compose.yaml" "$fixture/original-web"
sed -i '\|^      - ../../.evse-settings:|a\      - /nonexistent-ci.sock:/run/extra-ci.sock:ro' "$wp/compose.yaml"
if result=$(stack plan 2>&1); then exit 1; fi
grep -Fq 'Ungültiges wirksames Stack-Modell' <<< "$result"
cp "$fixture/original-web" "$wp/compose.yaml"

# The production base declares evse-mqtt external; create it only here, on an
# empty ephemeral runner. The two infrastructure containers aren't Compose-owned.
# Represent the ordinary external MQTT bridge, not a second internal-only
# network. Docker 29 can retain the configured HostPort but publish nothing
# when every attached network is internal. Keep the DB internal, disable
# outbound masquerading on the fixture bridge and publish only on loopback.
docker network create --driver bridge --opt com.docker.network.bridge.enable_ip_masquerade=false evse-mqtt >/dev/null
docker network create --internal stackci-data >/dev/null
# Simulated serial ownership on the disposable Docker VM. Only stat metadata
# on dummy/null devices; never execute a gateway or open serial hardware.
docker build -qt stackci-port-uart-bridge - <<'IMAGE'
FROM debian:bookworm-slim
CMD ["sleep", "86400"]
IMAGE
cp bin/.env original-plan; printf 'ready yes\nuart gateway\n' > bin/.env
mkdir -p .evse-settings/uart shim
mv rasppi/.env .evse-settings/uart/.env; ln -s "$fixture/.evse-settings/uart/.env" rasppi/.env
devdir=$(mktemp -d /dev/shm/stack-ci-port.XXXXXXXX); port=$devdir/uart
ln -s /dev/null "$port"
printf 'COMPOSE_PROJECT_NAME=stackci-port\nUART_DEVICE=%s\n' "$port" >> .evse-settings/uart/.env
cp .evse-settings/uart/.env original-uart
docker run -d --name fixture-port-owner --device /dev/zero:/dev/fixture-zero stackci-port-uart-bridge >/dev/null
command -v docker > shim/real
cat > shim/docker <<'SH'
#!/bin/bash
set -eu
dir=${0%/*}; real=$(cat "$dir/real")
if [[ $1 == --host && $3 == compose && " $* " == *' up -d '* ]]; then
  # Same atomic rename as a successful settings save, after stack ownership
  # checks and immediately before real Compose reads its interpolation input.
  target=${dir%/*}/.evse-settings/uart/.env
  sed 's|^UART_DEVICE=.*|UART_DEVICE=/dev/zero|' "$target" > "$target.new"
  mv -T "$target.new" "$target"
fi
exec "$real" "$@"
SH
chmod 0755 shim/docker
PATH="$fixture/shim:$PATH" stack up
u=$(docker ps -q --filter label=com.docker.compose.service=uart-bridge)
[[ -n $u && $(docker exec "$u" stat -Lc '%t:%T' /dev/serial0) == "$(stat -Lc '%t:%T' /dev/null)" ]]
grep -Fxq 'UART_DEVICE=/dev/zero' rasppi/.env # ensure shim really interleaved
reject stack plan # new invocation sees that this proposed port is owned
docker rm -f fixture-port-owner >/dev/null
if result=$(stack check 2>&1); then exit 1; fi
grep -Fq 'tatsächliches Containergerät' <<< "$result" # desired source != actual host mapping
cp original-uart .evse-settings/uart/.env; stack check
ln -sfn /dev/zero "$port"; reject stack check # same source spelling, stale in-container rdev
ln -sfn /dev/null "$port"; stack check
cp rasppi/compose.yaml original-uart-compose
sed -i 's|}:/dev/serial0|}:/dev/fixture-other|' rasppi/compose.yaml
(cd rasppi && docker compose --profile tools up -d --no-build --force-recreate uart-bridge)
mv original-uart-compose rasppi/compose.yaml
reject stack check # correct host, wrong destination
docker rm -f stackci-port-uart-bridge-1 >/dev/null
rm -- "$port"; rmdir -- "$devdir"; mv original-plan bin/.env
docker create --name stackci-order --label com.docker.compose.service=weboverlay \
  --label com.docker.compose.project=stackci-web --label com.docker.compose.oneoff=False \
  --label "com.docker.compose.project.working_dir=$wp" \
  --label "com.docker.compose.project.config_files=$wp/compose.yaml,$wp/compose.history.yaml,$wp/compose.auth.yaml" eclipse-mosquitto:2 >/dev/null
reject stack plan; docker rm stackci-order >/dev/null
docker run -d --name stackci-broker --network evse-mqtt --network-alias mqtt-broker \
  -v "$sp/tests/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro" eclipse-mosquitto:2 >/dev/null
cat > "$fixture/registry.sql" <<'SQL'
USE evse_history_test;
INSERT INTO evse_house_schema_versions VALUES (1,UNHEX('db10ad75e9947799db2a896f3211c2c3ba6f64afa75219620630dcbb8a139391'),UTC_TIMESTAMP(6));
GRANT SELECT ON evse_history_test.* TO 'history_reader'@'%';
SQL
docker run -d --name stackci-maria --network stackci-data -v stackci-fixture-db:/var/lib/mysql \
  -e MARIADB_DATABASE=evse_history_test -e MARIADB_ROOT_PASSWORD=dummy-ci-only \
  -v "$sp/migrations/001_initial.sql:/docker-entrypoint-initdb.d/010.sql:ro" \
  -v "$wp/tests/history-init.sql:/docker-entrypoint-initdb.d/020.sql:ro" \
  -v "$sp/migrations/003_house.sql:/docker-entrypoint-initdb.d/030.sql:ro" \
  -v "$fixture/registry.sql:/docker-entrypoint-initdb.d/040.sql:ro" mariadb:11.8.8 >/dev/null
# Fresh opt-out deploy must accept two explicitly disabled endpoints, not
# require the website's DB membership. The same project may then add overlays.
sed -i 's/^WEB_HOUSE_HISTORY_ENABLED=1$/WEB_HOUSE_HISTORY_ENABLED=0/' "$wp/.env"
printf 'ready yes\nweb base\nstorage auth\n' > bin/.env
stack build-up
sed -i 's/^WEB_HOUSE_HISTORY_ENABLED=0$/WEB_HOUSE_HISTORY_ENABLED=1/' "$wp/.env"
printf 'ready yes\nweb auth+history\nstorage auth\n' > bin/.env
# Replacing PWD/.env during the actual web up must not override --env-file
# (including interpolation of auth/history bind sources, port and profile).
cp "$wp/.env" web-before
cat > shim/docker <<'SH'
#!/bin/bash
set -eu
dir=${0%/*}; real=$(cat "$dir/real")
if [[ $1 == --host && $3 == compose && $PWD == */rasppi/weboverlay && " $* " == *' up -d '* ]]; then
  sed -e 's/^COMPOSE_PROFILES=https$/COMPOSE_PROFILES=/' \
      -e 's/^WEB_PORT=18080$/WEB_PORT=18081/' \
      -e 's|^HISTORY_DB_PASSWORD_HOST_FILE=.*|HISTORY_DB_PASSWORD_HOST_FILE=./nonexistent|' \
      -e 's|^MQTT_PASSWORD_HOST_FILE=.*|MQTT_PASSWORD_HOST_FILE=./nonexistent|' .env > .env.new
  mv -T .env.new .env
fi
exec "$real" "$@"
SH
PATH="$fixture/shim:$PATH" stack up
grep -Fxq WEB_PORT=18081 "$wp/.env"; mv web-before "$wp/.env"
w=$(docker ps -q --filter label=com.docker.compose.service=weboverlay)
s=$(docker ps -q --filter label=com.docker.compose.service=storage)
[[ -n $w && -n $s && -z $(docker ps -aq --filter label=com.docker.compose.service=migrate) ]]
[[ -z $(docker ps -aq --filter label=com.docker.compose.service=history-rollup) ]]
[[ $(docker port "$w" 8080/tcp) == 127.0.0.1:18080 ]]
curl --noproxy '*' --fail --silent --show-error --max-time 3 http://127.0.0.1:18080/healthz >/dev/null
binds=$(docker inspect --format '{{range .Mounts}}{{println .Source .Destination}}{{end}}' "$w")
grep -Fxq "$wp/secrets/history.txt /run/secrets/history-password" <<< "$binds"
grep -Fxq "$wp/secrets/mqtt.txt /run/secrets/mqtt-password" <<< "$binds"
proxy=$(docker ps -q --filter label=com.docker.compose.service=https)
[[ $(docker port "$proxy" 8443/tcp) == 127.0.0.1:18443 ]]
# Validate the real production Compose wiring, not just a port in the model.
deadline=$((SECONDS+45)); until docker exec "$proxy" cat /data/caddy/pki/authorities/local/root.crt > "$fixture/tls-public.crt" 2>/dev/null &&
  curl --noproxy '*' --max-time 3 -fsS --cacert "$fixture/tls-public.crt" https://127.0.0.1:18443/healthz | grep -Fq '"status":"ok"'; do
  ((SECONDS < deadline)) || exit 1; sleep 1
done
docker exec "$w" php -r 'exit(getenv("MQTT_CLIENT_ID")==="stackci-web-only" ? 0 : 1);'
docker exec "$s" python -c 'import os; assert os.environ["MQTT_CLIENT_ID"] == "stackci-storage-only"'
docker volume inspect stackci-web_https-data >/dev/null
# Check BOTH archives, including their distinct empty/unavailable responses.
# Return only a digest of sample identity/time/value, never the API payload.
archive_snapshot() {
  local status=$1 count=$2 current
  current=$(docker ps -q --filter label=com.docker.compose.service=weboverlay)
  docker exec "$current" php -r '
    [$script,$status,$count]=$argv; $count=(int)$count; $snapshot=[];
    foreach (["history","house-history"] as $endpoint) {
      $body=file_get_contents("http://127.0.0.1:8080/api/".$endpoint."?minutes=15",false,
        stream_context_create(["http"=>["timeout"=>5,"ignore_errors"=>true]]));
      $r=json_decode($body === false ? "" : $body,true);
      $code=$status === "unavailable" ? 503 : 200;
      if (!str_contains($http_response_header[0] ?? "", " ".$code." ") ||
          ($r["read_only"] ?? null)!==true || ($r["status"] ?? null)!==$status ||
          !is_array($r["samples"] ?? null) || count($r["samples"])!==$count) exit(1);
      $snapshot[$endpoint]=[];
      foreach ($r["samples"] as $s) {
        $value=$endpoint === "history" ? ($s["values"]["active_power_w"] ?? null) : ($s["power_w"] ?? null);
        if ($value !== ($endpoint === "history" ? 1729 : -619)) exit(1);
        $snapshot[$endpoint][]=[$s["id"],$s["timestamp"],$value];
      }
    }
    echo hash("sha256",json_encode($snapshot)),"\n";
  ' -- "$status" "$count"
}
archive_snapshot ok 0 >/dev/null
# Known synthetic observations in both SQL sources survive every outage below.
# No rollup/migration/reaggregation is used as a repair.
# Pure build on an installed stack: retain IDs, start epochs, restart counts,
# mounts, endpoints and publications, even with unusable site interpolation.
# This must not read/repair the service env or replace the approved plan.
runtime_state() {
  # Docker does not promise an order for the mount array. Keep every mount
  # and all its fields, keyed by container, without comparing enumeration order.
  docker inspect --format '{{.Id}}|{{.State.Status}}|{{.State.StartedAt}}|{{.RestartCount}}|{{json .NetworkSettings.Networks}}|{{json .HostConfig.PortBindings}}{{range .Mounts}}{{printf "\n%s|mount|%s" $.Id (json .)}}{{end}}' $(docker ps -aq) | sort
}
runtime_state > before-build-state
cp "$wp/.env" before-build-web-env
printf 'COMPOSE_FILE=nonexistent-ci-overlay.yaml\n' >> "$wp/.env"
sha256sum bin/.env "$wp/.env" "$sp/.env" rasppi/wallbox/.env rasppi/.env > before-build-inputs
stack build
# Test the actual filtered context (including nested site files in the fixture),
# not the text of ignore rules. Never print the contents of any input.
docker build -q -f - rasppi <<'IMAGE'
FROM busybox:1.37
COPY . /context
WORKDIR /context
RUN test -f src/main.py && test -f tests/uart_gateway_interactive.py && \
    test -z "$(find . -type f ! -path './Dockerfile.uart' ! -path './requirements.txt' ! -path './src/main.py' ! -path './src/uart_gateway.py' ! -path './tests/uart_gateway*.py')"
IMAGE
sha256sum --status -c before-build-inputs
runtime_state > after-build-state
cmp before-build-state after-build-state
mv before-build-web-env "$wp/.env"
docker exec -i stackci-maria mariadb -uhistory_writer -pdummy-only-writer evse_history_test <<'SQL'
SET @observed=UTC_TIMESTAMP(6);
INSERT INTO evse_wallbox_samples(source,payload_sha256,measured_at,received_at,retained,status,active_power_w,payload_json)
VALUES ('evse/wallbox',UNHEX(SHA2('stack-ci-row',256)),@observed,@observed,0,'ok',1729,'{}');
INSERT INTO evse_house_samples(source,publisher_id,sequence,fetched_at,received_at,status,last_success_at,power_w,error_code,retained,digest)
VALUES ('evse/house',UNHEX('00000000000000000000000000000001'),1,@observed,@observed,'ok',@observed,-619,NULL,0,UNHEX(SHA2('stack-ci-house-row',256)));
SQL
archive_before=$(archive_snapshot ok 1)
assert_archive_row() {
  [[ $(archive_snapshot ok 1) == "$archive_before" ]]
}
assert_archive_row
stack archive-pin > "$fixture/expected"

# Existing file-auth must not disappear merely because a new invocation omitted -f.
printf 'ready yes\nweb history\nstorage auth\n' > bin/.env
reject stack up
printf 'ready yes\nweb auth+history\nstorage auth\n' > bin/.env
docker create --name stackci-conflict --label com.docker.compose.service=weboverlay \
  --label com.docker.compose.project=other-site eclipse-mosquitto:2 >/dev/null
reject stack plan
docker rm stackci-conflict >/dev/null
docker restart "$w" >/dev/null
stack check
docker network disconnect stackci-data "$w"
if result=$(stack check 2>&1); then exit 1; fi
grep -Fq 'weboverlay: konfigurierte DB-Netzmitgliedschaft fehlt tatsächlich.' <<< "$result"
grep -Fq 'weboverlay: /api/history nicht wie erwartet (ok).' <<< "$result"
grep -Fq 'weboverlay: /api/house-history nicht wie erwartet (ok).' <<< "$result"
docker exec "$w" php /app/docker/healthcheck.php # liveness stays independent
archive_snapshot unavailable 0 >/dev/null

# Same exact action as the opt-in unit, here with real old SQL data.
bash bin/archive-link.sh --reconcile < "$fixture/expected"
assert_archive_row
stack check
# Regression for the original operator failure: recreate from base/auth only.
# Healthy HTTP, but the expected SQL attachment/Wallbox API disappeared.
(cd "$wp" && docker compose -f compose.yaml -f compose.auth.yaml up -d --force-recreate --no-deps weboverlay)
reject bash bin/archive-link.sh --reconcile < "$fixture/expected"
if result=$(stack check 2>&1); then exit 1; fi
grep -Fq 'weboverlay: konfigurierte DB-Netzmitgliedschaft fehlt tatsächlich.' <<< "$result"
grep -Fq 'weboverlay: /api/history nicht wie erwartet (ok).' <<< "$result"
stack up # project-local overlay selection restored; no new parallel web project
docker stop stackci-maria >/dev/null
if result=$(stack check 2>&1); then exit 1; fi
grep -Fq 'weboverlay: DB-Netzmitgliedschaft bestätigt.' <<< "$result"
grep -Fq 'weboverlay: /api/history nicht wie erwartet (ok).' <<< "$result"
grep -Fq 'weboverlay: /api/house-history nicht wie erwartet (ok).' <<< "$result"
archive_snapshot unavailable 0 >/dev/null
docker start stackci-maria >/dev/null
for i in {1..40}; do docker exec stackci-maria healthcheck.sh --connect --innodb_initialized && break; sleep 1; done
stack check
assert_archive_row # the original observation survived DB outage, not merely a healthy diagnostic
stack stop
[[ -z $(docker ps -q --filter label=com.docker.compose.project=stackci-web) ]]
[[ -z $(docker ps -q --filter label=com.docker.compose.project=stackci-storage) ]]
[[ $(docker inspect --format '{{.State.Running}}' stackci-maria) == true ]]
[[ $(docker inspect --format '{{.State.Running}}' stackci-broker) == true ]]
docker volume inspect stackci-web_https-data >/dev/null
stack up
assert_archive_row
echo 'Isolierter Projektstart/-stopp, Neustart, Drift, Recreate und SQL-Ausfall geprüft.'
