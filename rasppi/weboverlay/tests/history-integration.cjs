'use strict';

// Docker-only, disposable MariaDB 11.8.8 + real production HTTP supervisor.
// Diagnostics deliberately contain neither child output, SQL, nor HTTP bodies.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const PREFIX = 'isolated/wallbox';
const DB = 'evse_history_test';
const READER = 'dummy-only-reader';
const MARKER = 'private-history-payload-marker';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const children = [];
let directory, rootFile, readerFile, web, port, mqttPort;
let scenario = 'setup', completed = 0, sequence = 0;
const watchdog = setTimeout(() => {
  console.error('History integration exceeded its global deadline (diagnostics withheld).');
  for (const record of children) signal(record, 'SIGKILL');
  process.exit(1);
}, 110000);
watchdog.unref();

function launch(executable, args, options = {}) {
  const { logFile, ...rest } = options;
  const fd = logFile ? syncFs.openSync(logFile, 'a', 0o600) : null;
  const child = spawn(executable, args, { cwd: '/app', detached: true,
    stdio: fd === null ? ['pipe', 'pipe', 'pipe'] : ['ignore', fd, fd], ...rest });
  if (fd !== null) syncFs.closeSync(fd);
  const record = { child, ended: false, output: '' };
  child.stdout?.on('data', data => { record.output = (record.output + data).slice(-65536); });
  child.stderr?.resume(); // Never retain or print database/server diagnostics.
  record.done = new Promise(resolve => {
    child.once('error', () => { record.ended = true; resolve(-1); });
    child.once('close', code => { record.ended = true; resolve(code); });
  });
  children.push(record);
  return record;
}
function signal(record, value) {
  if (!record?.child.pid) return;
  try { process.kill(-record.child.pid, value); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function stop(record) {
  if (!record) return;
  signal(record, 'SIGTERM');
  await Promise.race([record.done, sleep(900)]);
  signal(record, 'SIGKILL');
  await Promise.race([record.done, sleep(500)]);
}
async function command(executable, args, input = '') {
  const record = launch(executable, args);
  record.child.stdin.on('error', () => {});
  record.child.stdin.end(input);
  const code = await Promise.race([record.done, sleep(5000).then(() => -2)]);
  if (code === -2) await stop(record);
  assert.notEqual(code, -2, 'Child deadline');
  return { code, output: record.output };
}
async function sql(text, reader = false, succeeds = true) {
  // Host and database cannot be supplied by a developer's deployment config.
  const result = await command('/usr/bin/mariadb', [
    `--defaults-file=${reader ? readerFile : rootFile}`, '--batch', '--skip-column-names', DB,
  ], text);
  if (succeeds) assert.equal(result.code, 0, 'Isolated SQL fixture failed');
  else assert.notEqual(result.code, 0, 'Reader unexpectedly allowed a write');
  return result.output.trim();
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
async function poll(probe, timeout = 6500) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (await probe()) return;
    await sleep(60);
  }
  throw new Error('Bounded readiness deadline');
}
function request(target = '/api/history?minutes=15', method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: target, method, agent: false }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; if (body.length > 2 * 1024 * 1024) res.destroy(); });
      res.on('error', reject);
      res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body }));
    });
    req.setTimeout(1500, () => req.destroy(new Error('HTTP deadline')));
    req.on('error', reject); req.end();
  });
}
function safeResponse(response) {
  for (const forbidden of [MARKER, READER, process.env.HISTORY_TEST_ROOT_PASSWORD,
    'history-db', DB, 'history_reader', 'payload_json', 'communication_error']) {
    assert.ok(!response.body.includes(forbidden), 'Private data leaked');
  }
  assert.match(response.headers['cache-control'] || '', /no-store/);
}
async function history(status = 'ok') {
  const response = await request();
  safeResponse(response);
  assert.equal(response.code, status === 'unavailable' ? 503 : 200);
  const value = JSON.parse(response.body);
  assert.equal(value.schema_version, 1); assert.equal(value.read_only, true);
  assert.equal(value.status, status); assert.equal(value.minutes, 15);
  assert.equal(value.reason, { ok: 'Historische Wallbox-Messdaten',
    disabled: 'SQL-Verlauf ist deaktiviert', unavailable: 'SQL-Verlauf ist nicht verfügbar' }[status]);
  for (const timestamp of [value.generated_at, value.range.from, value.range.to]) {
    assert.match(timestamp, /Z$|\+00:00$/); assert.ok(Number.isFinite(Date.parse(timestamp)));
  }
  assert.equal(typeof value.complete, 'boolean');
  assert.ok(Array.isArray(value.samples) && value.samples.length <= 1200);
  for (const item of value.samples) {
    assert.equal(typeof item.id, 'string'); assert.match(item.id, /^\d+$/);
    assert.ok(Number.isFinite(Date.parse(item.timestamp)));
    assert.ok(Number.isFinite(Date.parse(item.received_at)));
    assert.equal(typeof item.break_before, 'boolean');
  }
  return value;
}
async function launchWeb(overrides = {}) {
  await stop(web);
  const env = {
    ...process.env, EVSE_HTTP_PORT: String(port), WEB_STATE_DIR: path.join(directory, `state-${++sequence}`),
    WEB_STALE_SECONDS: '10', SMARTMETER_URL: '',
    MQTT_HOST: '127.0.0.1', MQTT_PORT: String(mqttPort), MQTT_TOPIC_PREFIX: PREFIX,
    MQTT_CLIENT_ID: `history-test-${sequence}`, MQTT_USERNAME: '', MQTT_PASSWORD: '', MQTT_PASSWORD_FILE: '',
    WEB_HISTORY_ENABLED: '1', HISTORY_DB_HOST: 'history-db', HISTORY_DB_PORT: '3306',
    HISTORY_DB_NAME: DB, HISTORY_DB_USERNAME: 'history_reader', HISTORY_DB_PASSWORD: '',
    HISTORY_DB_PASSWORD_FILE: path.join(directory, 'reader-password'), ...overrides,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  web = launch('/app/docker/entrypoint.sh', [], { logFile: path.join(directory, 'web.log'), env });
  await poll(async () => {
    assert.ok(!web.ended, 'Production supervisor exited');
    try { return (await request('/healthz')).code === 200; } catch { return false; }
  });
}
async function reset() {
  await sql('DELETE FROM evse_ingest_events; DELETE FROM evse_wallbox_samples;');
}
const instant = seconds => new Date(Date.now() + seconds * 1000).toISOString().replace('T', ' ').replace('Z', '');
const quote = text => `'${String(text).replaceAll("'", "''")}'`;
function row(seconds, options = {}) {
  const time = instant(seconds), received = instant(options.received ?? seconds);
  const source = options.source ?? PREFIX, error = options.error ?? false;
  return `(${quote(source)},UNHEX(SHA2('${++sequence}',256)),${quote(time)},${quote(received)},${quote(time)},${options.retained ? 1 : 0},'${error ? 'error' : 'ok'}',${error ? quote(MARKER) : 'NULL'},0,273,33024,1,0,1,0,6.125,0,NULL,2.500,235.1,NULL,236.3,0,0,'{"private":"${MARKER}"}')`;
}
async function rows(values) {
  await sql(`INSERT INTO evse_wallbox_samples (source,payload_sha256,measured_at,received_at,last_success_at,retained,status,communication_error,error_code,socket_lock_state,charging_state_raw,charging_state,below_commanded_current,plugged_in,charging,current_limit_a,current_l1_a,current_l2_a,current_l3_a,voltage_l1_v,voltage_l2_v,voltage_l3_v,active_power_w,session_energy_wh,payload_json) VALUES ${values.join(',')};`);
}
async function event(kind, seconds, availability = null, retained = false) {
  await sql(`INSERT INTO evse_ingest_events VALUES (UNHEX(MD5('${++sequence}')),${quote(PREFIX)},${quote(instant(seconds))},${quote(kind)},${availability === null ? 'NULL' : quote(availability)},${retained ? 1 : 0},'{}');`);
}
async function baseline() { await event('availability', -80, 'online'); }
async function run(name, callback) {
  scenario = name; await callback(); completed++;
  console.log(`ok ${completed} - ${name}`);
}
async function publishLive() {
  const timestamp = new Date().toISOString();
  const sample = { schema_version: 1, device: 'abb_terra_ac', timestamp, last_success_at: timestamp,
    status: 'ok', error: null, values: { error_code: 0, socket_lock_state: 273,
      charging_state_raw: 33024, charging_state: 1, below_commanded_current: false,
      plugged_in: true, charging: false, current_limit_a: 6, current_a: [0, 0, 0],
      voltage_v: [235, 235, 235], active_power_w: 0, session_energy_wh: 0 } };
  // Only the isolated test publisher publishes; the production worker is subscribe-only.
  for (const [suffix, payload] of [['availability', 'online'], ['state', JSON.stringify(sample)]]) {
    const result = await command('mosquitto_pub', ['-h', '127.0.0.1', '-p', String(mqttPort),
      '-q', '1', '-r', '-t', `${PREFIX}/${suffix}`, '-s'], payload);
    assert.equal(result.code, 0, 'Loopback fixture publish failed');
  }
}
async function liveIndependent() {
  await poll(async () => {
    await publishLive();
    return JSON.parse((await request('/api/state')).body).status === 'live';
  });
  assert.equal((await request('/healthz')).code, 200);
}

(async () => {
  assert.equal(process.env.HISTORY_TEST_DB_HOST, 'history-db', 'Only isolated Compose fixture permitted');
  assert.equal(process.env.HISTORY_TEST_ROOT_PASSWORD, 'dummy-only-history-root');
  directory = await fs.mkdtemp('/tmp/evse-history-');
  await fs.chmod(directory, 0o700);
  rootFile = path.join(directory, 'root.cnf'); readerFile = path.join(directory, 'reader.cnf');
  for (const [file, user, password] of [[rootFile, 'root', process.env.HISTORY_TEST_ROOT_PASSWORD], [readerFile, 'history_reader', READER]]) {
    await fs.writeFile(file, `[client]\nhost=history-db\nport=3306\nprotocol=tcp\nuser=${user}\npassword=${password}\nconnect-timeout=2\n`, { mode: 0o600 });
  }
  await fs.writeFile(path.join(directory, 'reader-password'), READER + '\n', { mode: 0o600 });
  await fs.writeFile(path.join(directory, 'wrong-password'), 'dummy-only-wrong\n', { mode: 0o600 });
  port = await freePort(); do { mqttPort = await freePort(); } while (port === mqttPort);
  const brokerConfig = path.join(directory, 'mosquitto.conf');
  await fs.writeFile(brokerConfig, `listener ${mqttPort} 127.0.0.1\nallow_anonymous true\npersistence false\n`, { mode: 0o600 });
  launch('mosquitto', ['-c', brokerConfig]);
  await poll(async () => {
    const result = await command('mosquitto_pub', ['-h', '127.0.0.1', '-p', String(mqttPort), '-t', 'isolated/readiness', '-n']);
    return result.code === 0;
  });
  await launchWeb();
  await run('real least-privilege grants deny writes', async () => {
    assert.equal(await sql('SELECT version FROM evse_schema_versions;', true), '1');
    for (const statement of [
      'INSERT INTO evse_schema_versions VALUES (2,UTC_TIMESTAMP(6));',
      'UPDATE evse_wallbox_samples SET charging=1 WHERE id=0;',
      'DELETE FROM evse_ingest_events WHERE source=0x00;',
      'CREATE TABLE forbidden_history_write (id INT);',
    ]) await sql(statement, true, false);
  });
  await run('typed values, binary source, time bounds and same-second identities', async () => {
    await reset(); await baseline();
    const first = row(-50); // Duplicate measurement timestamp with distinct stored identity.
    await rows([first, first.replace(/SHA2\('[0-9]+'/, `SHA2('${++sequence}'`),
      row(-40, { source: 'isolated/Wallbox' }), row(-40, { source: 'other/wallbox' }), row(-1000), row(120)]);
    const result = await history(); assert.equal(result.complete, true); assert.equal(result.samples.length, 2);
    const [a, b] = result.samples;
    assert.notEqual(a.id, b.id); assert.equal(a.timestamp, b.timestamp);
    assert.equal(a.break_before, true); assert.equal(b.break_before, false);
    assert.equal(a.values.current_limit_a, 6.125); assert.equal(a.values.active_power_w, 0);
    assert.equal(a.values.charging, false); assert.equal(a.values.below_commanded_current, false);
    assert.equal(a.values.plugged_in, true);
    assert.deepEqual(a.values.current_a, [0, null, 2.5]); assert.deepEqual(a.values.voltage_v, [235.1, null, 236.3]);
    for (const key of ['error_code', 'socket_lock_state', 'charging_state_raw', 'charging_state', 'session_energy_wh']) {
      assert.equal(typeof a.values[key], 'number');
    }
  });
  await run('read errors have no values and break continuity', async () => {
    await reset(); await baseline(); await rows([row(-60), row(-58, { error: true }), row(-56)]);
    const value = await history(); assert.equal(value.samples.length, 3);
    assert.equal(value.samples[1].status, 'error'); assert.equal(value.samples[1].values, null);
    assert.equal(value.samples[2].break_before, true);
  });
  await run('nonretained online permits normal consecutive edges', async () => {
    await reset(); await baseline(); await rows([row(-60), row(-58)]);
    const value = await history(); assert.equal(value.samples[1].break_before, false);
  });
  await run('availability, lifecycle and gap barriers forbid edges', async () => {
    for (const [kind, availability] of [['availability', 'offline'], ['availability', 'online'],
      ['collector_started', null], ['collector_stopping', null], ['broker_connected', null],
      ['broker_disconnected', null], ['ingestion_gap', null]]) {
      await reset(); await baseline(); await rows([row(-60), row(-56)]);
      // A recovered online notice cannot bridge an intervening offline boundary.
      if (availability === 'online') await event('availability', -59, 'offline');
      await event(kind, -58, availability);
      assert.equal((await history()).samples[1].break_before, true);
    }
  });
  await run('retained availability and retained samples are conservative', async () => {
    await reset(); await event('availability', -80, 'online', true); await rows([row(-60), row(-58)]);
    assert.ok((await history()).samples.every(item => item.break_before));
    await reset(); await baseline(); await rows([row(-60, { retained: true }), row(-58)]);
    assert.equal((await history()).samples[1].break_before, true);
  });
  await run('tied baseline events cannot invent prior availability', async () => {
    await reset();
    const time = quote(instant(-1000));
    await sql(`INSERT INTO evse_ingest_events VALUES
      (UNHEX(REPEAT('00',16)),${quote(PREFIX)},${time},'broker_disconnected',NULL,0,'{}'),
      (UNHEX(REPEAT('ff',16)),${quote(PREFIX)},${time},'availability','online',0,'{}');`);
    await rows([row(-60), row(-58)]);
    const value = await history();
    assert.equal(value.samples.length, 2);
    assert.ok(value.samples.every(item => item.break_before));
  });
  await run('sample bound is explicit and conservatively disconnected', async () => {
    await reset(); await baseline();
    await rows(Array.from({ length: 1201 }, (_, i) => row(-700 + i * 0.5)));
    const value = await history(); assert.equal(value.complete, false);
    assert.equal(value.samples.length, 1200); assert.ok(value.samples.every(item => item.break_before));
  });
  await run('event bound is explicit and conservatively disconnected', async () => {
    await reset(); await baseline(); await rows([row(-60), row(-58)]);
    const events = Array.from({ length: 2401 }, (_, i) => `(UNHEX(MD5('bound-${i}')),${quote(PREFIX)},${quote(instant(-70))},'availability','online',0,'{}')`);
    await sql(`INSERT INTO evse_ingest_events VALUES ${events.join(',')};`);
    const value = await history(); assert.equal(value.complete, false);
    assert.ok(value.samples.every(item => item.break_before));
  });
  await run('measurement or receipt rollback disconnects partial history', async () => {
    for (const values of [[row(-50), row(-60)], [row(-60, { received: -40 }), row(-58, { received: -50 })]]) {
      await reset(); await baseline(); await rows(values);
      const value = await history(); assert.equal(value.complete, false);
      assert.ok(value.samples.every(item => item.break_before));
    }
  });
  await run('strict query contract, HEAD and method rejection', async () => {
    for (const query of ['minutes=0', 'minutes=16', 'minutes=1&minutes=5', 'minutes%5B%5D=15', 'extra=1', 'minutes=15%20OR%201=1']) {
      assert.equal((await request(`/api/history?${query}`)).code, 400);
    }
    for (const minutes of [1, 5, 15]) {
      const response = await request(`/api/history?minutes=${minutes}`); safeResponse(response);
      assert.equal(response.code, 200); assert.equal(JSON.parse(response.body).minutes, minutes);
    }
    const head = await request('/api/history', 'HEAD'); assert.equal(head.code, 200); assert.equal(head.body, '');
    assert.equal((await request('/api/history', 'POST')).code, 405);
    assert.equal(JSON.parse((await request('/api/history')).body).minutes, 15);
  });
  await run('GET cannot mutate fixture tables', async () => {
    const count = () => sql('SELECT COUNT(*) FROM evse_wallbox_samples; SELECT COUNT(*) FROM evse_ingest_events; SELECT version,applied_at FROM evse_schema_versions;');
    const before = await count(); await history(); await history(); assert.equal(await count(), before);
  });
  await run('wrong reader password leaves HTTP and live MQTT available', async () => {
    await launchWeb({ HISTORY_DB_PASSWORD_FILE: path.join(directory, 'wrong-password') });
    await history('unavailable'); await liveIndependent();
  });
  await run('missing database leaves HTTP and live MQTT available', async () => {
    await launchWeb({ HISTORY_DB_NAME: 'evse_history_missing' });
    await history('unavailable'); await liveIndependent();
  });
  await run('unsupported and missing schema versions fail closed', async () => {
    await launchWeb();
    try {
      await sql('UPDATE evse_schema_versions SET version=2;'); await history('unavailable');
      await sql('DELETE FROM evse_schema_versions;'); await history('unavailable');
      await liveIndependent();
    } finally {
      await sql('DELETE FROM evse_schema_versions; INSERT INTO evse_schema_versions VALUES (1,UTC_TIMESTAMP(6));');
    }
  });
  await run('missing secret fails closed without killing workers', async () => {
    await launchWeb({ HISTORY_DB_PASSWORD_FILE: path.join(directory, 'absent-secret') });
    await history('unavailable'); await liveIndependent();
  });
  await run('default disabled history works without database settings', async () => {
    await launchWeb({ WEB_HISTORY_ENABLED: undefined, HISTORY_DB_HOST: '', HISTORY_DB_NAME: '',
      HISTORY_DB_USERNAME: '', HISTORY_DB_PASSWORD_FILE: '' });
    await history('disabled'); await liveIndependent();
  });
  console.log(`History integration: ${completed} scenarios passed (isolated Docker fixtures only).`);
})().catch(() => {
  // Do not stringify assertions: Node includes actual/expected private payloads.
  console.error(`History integration failed: ${scenario} (diagnostics withheld).`);
  process.exitCode = 1;
}).finally(async () => {
  for (const record of children.reverse()) await stop(record);
  if (directory) await fs.rm(directory, { recursive: true, force: true });
  clearTimeout(watchdog);
});
