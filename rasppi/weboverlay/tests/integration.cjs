'use strict';

// Docker-only: real loopback Mosquitto -> production entrypoint -> HTTP.
// No npm dependencies, production credentials, broker, hardware, or host services.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const PREFIX = 'isolated/wallbox';
const PASSWORD = 'dummy-integration-password';
const WRONG_PASSWORD = 'dummy-rejected-password';
const MARKER = 'dummy-private-field-marker';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let completed = 0;
let activeScenario = 'setup';

function sample(age = 0) {
  const timestamp = new Date(Date.now() - age * 1000).toISOString();
  return {
    schema_version: 1, device: 'abb_terra_ac', timestamp, status: 'ok',
    last_success_at: timestamp, error: null,
    values: {
      error_code: 0, socket_lock_state: 273, charging_state_raw: 33024,
      charging_state: 1, below_commanded_current: true, plugged_in: true,
      charging: false, current_limit_a: 6, current_a: [0, 0, 0],
      voltage_v: [235.7, 233.4, 235.3], active_power_w: 0, session_energy_wh: 0,
    },
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function poll(label, probe, timeout = 12000) {
  const deadline = performance.now() + timeout;
  let delay = 30;
  while (performance.now() < deadline) {
    if (await probe()) return;
    await pause(Math.min(delay, Math.max(0, deadline - performance.now())));
    delay = Math.min(150, delay * 1.3);
  }
  // Deliberately do not print response bodies, command arguments, or child logs.
  throw new Error(`Timed out: ${label}`);
}

function launch(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: '/app', detached: true, stdio: ['ignore', 'pipe', 'pipe'], ...options,
  });
  // Keep only bounded diagnostics from these isolated dummy-credential processes.
  const record = { child, ended: false, result: null, log: '' };
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => { record.log = (record.log + chunk.toString('utf8')).slice(-8192); });
  }
  record.done = new Promise(resolve => {
    child.once('error', () => {
      record.ended = true;
      record.result = { code: null, signal: null, spawnError: true };
      resolve(record.result);
    });
    child.once('close', (code, signal) => {
      record.ended = true;
      record.result = { code, signal };
      resolve(record.result);
    });
  });
  return record;
}

function signalGroup(record, signal) {
  if (!record.child.pid) return;
  try { process.kill(-record.child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

async function stop(record) {
  if (!record) return;
  // Kill remaining descendants even when the original leader already exited.
  signalGroup(record, 'SIGTERM');
  await Promise.race([record.done, pause(1500)]);
  signalGroup(record, 'SIGKILL');
  await Promise.race([record.done, pause(1500)]);
  assert.ok(record.ended, 'Child process cleanup exceeded its bound');
}

async function command(scope, executable, args, environment = {}) {
  const child = launch(executable, args, { env: { ...process.env, ...environment } });
  scope.children.push(child);
  const result = await Promise.race([child.done, pause(5000).then(() => null)]);
  if (!result) await stop(child);
  assert.ok(result && result.code === 0, `${executable} failed (output withheld)`);
}

function request(port, target = '/api/state', method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: target, method,
      agent: false, headers: { Connection: 'close' } }, response => {
      const chunks = [];
      let length = 0;
      response.on('data', chunk => {
        length += chunk.length;
        if (length > 1024 * 1024) response.destroy(new Error('HTTP response too large'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ code: response.statusCode,
        headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    const timer = setTimeout(() => req.destroy(new Error('HTTP deadline exceeded')), 1500);
    req.once('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end();
  });
}

async function state(scope) {
  const response = await request(scope.webPort);
  assert.equal(response.code, 200);
  return JSON.parse(response.body);
}

async function expect(scope, status, timeout = 12000) {
  let latest;
  await poll(`HTTP state ${status}`, async () => {
    assert.ok(!scope.web.ended, 'Production entrypoint exited unexpectedly');
    try { latest = await state(scope); }
    catch (error) {
      if (['ECONNREFUSED', 'ECONNRESET'].includes(error.code)) return false;
      throw error;
    }
    return latest.status === status;
  }, timeout);
  assert.equal(latest.read_only, true);
  if (status !== 'live') assert.equal(latest.values, null);
  return latest;
}

async function startBroker(scope) {
  scope.broker = launch('mosquitto', ['-c', scope.config]);
  scope.children.push(scope.broker);
  await poll('isolated broker listener', async () => {
    assert.ok(!scope.broker.ended, 'Isolated broker exited unexpectedly');
    return new Promise(resolve => {
      const socket = net.createConnection({ host: '127.0.0.1', port: scope.mqttPort });
      socket.setTimeout(200);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
    });
  }, 4000);
}

async function publish(scope, suffix, value) {
  const args = ['-h', '127.0.0.1', '-p', String(scope.mqttPort), '-q', '1', '-r',
    '-t', `${PREFIX}/${suffix}`, '-m', typeof value === 'string' ? value : JSON.stringify(value)];
  if (scope.auth) args.push('-u', 'publisher', '-P', PASSWORD);
  await command(scope, 'mosquitto_pub', args);
}

async function launchWeb(scope, rejected = false) {
  const env = { ...process.env,
    EVSE_HTTP_PORT: String(scope.webPort), WEB_STATE_DIR: path.join(scope.directory, 'private-state'),
    WEB_STALE_SECONDS: '3', MQTT_HOST: '127.0.0.1', MQTT_PORT: String(scope.mqttPort),
    MQTT_CLIENT_ID: `isolated-web-${scope.webPort}`, MQTT_TOPIC_PREFIX: PREFIX,
    MQTT_USERNAME: scope.auth ? 'subscriber' : '', MQTT_PASSWORD: '',
    MQTT_PASSWORD_FILE: scope.auth ? scope.secret : '',
  };
  if (rejected) {
    env.MQTT_PASSWORD_FILE = path.join(scope.directory, 'rejected-secret');
    await fs.writeFile(env.MQTT_PASSWORD_FILE, WRONG_PASSWORD + '\n', { mode: 0o600 });
  }
  scope.web = launch('/app/docker/entrypoint.sh', [], { env });
  scope.children.push(scope.web);
}

async function graceful(scope) {
  const started = performance.now();
  // Signal only the supervisor, not the group: it must stop its own children.
  scope.web.child.kill('SIGTERM');
  const result = await Promise.race([scope.web.done, pause(6900).then(() => null)]);
  assert.ok(result, 'Entrypoint did not shut down within seven seconds');
  assert.equal(result.code, 0, 'Entrypoint SIGTERM exit must be zero');
  assert.equal(result.signal, null);
  assert.ok(performance.now() - started < 7000);
  let reachable = false;
  try { await request(scope.webPort, '/healthz'); reachable = true; } catch { /* closed */ }
  assert.equal(reachable, false, 'HTTP child survived supervisor shutdown');
}

async function scenario(name, options, run) {
  activeScenario = name;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evse-http-integration-'));
  const scope = { directory, children: [], auth: Boolean(options.auth) };
  try {
    scope.mqttPort = await freePort();
    do { scope.webPort = await freePort(); } while (scope.webPort === scope.mqttPort);
    scope.config = path.join(directory, 'mosquitto.conf');
    let config = `listener ${scope.mqttPort} 127.0.0.1\npersistence false\n`;
    if (scope.auth) {
      const passwords = path.join(directory, 'passwords');
      scope.secret = path.join(directory, 'subscriber-secret');
      await fs.writeFile(scope.secret, PASSWORD + '\n', { mode: 0o600 });
      await command(scope, 'mosquitto_passwd', ['-b', '-c', passwords, 'publisher', PASSWORD]);
      await command(scope, 'mosquitto_passwd', ['-b', passwords, 'subscriber', PASSWORD]);
      const acl = path.join(directory, 'acl');
      const allowed = options.onlyTopic ? `${PREFIX}/${options.onlyTopic}` : `${PREFIX}/#`;
      await fs.writeFile(acl, `user publisher\ntopic readwrite ${PREFIX}/#\nuser subscriber\ntopic read ${allowed}\n`, { mode: 0o600 });
      config += `allow_anonymous false\npassword_file ${passwords}\nacl_file ${acl}\n`;
    } else config += 'allow_anonymous true\n';
    await fs.writeFile(scope.config, config, { mode: 0o600 });
    await run(scope);
    await graceful(scope);
    completed++;
    console.log(`ok ${completed} - ${name}`);
  } catch (error) {
    const redact = text => [PASSWORD, WRONG_PASSWORD, MARKER].reduce((s, value) => s.split(value).join('[redacted]'), text);
    console.error(redact(String(error.stack || error)));
    if (scope.web) console.error(redact(scope.web.log));
    throw error;
  } finally {
    const results = await Promise.allSettled(scope.children.map(stop));
    await fs.rm(directory, { recursive: true, force: true });
    assert.ok(results.every(result => result.status === 'fulfilled'), 'Child cleanup failed');
  }
}

function security(response) {
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  const csp = response.headers['content-security-policy'] || '';
  for (const directive of ["default-src 'self'", "object-src 'none'", "frame-ancestors 'none'",
    "base-uri 'none'", "form-action 'none'"]) assert.ok(csp.includes(directive));
  assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'));
  for (const secret of [PASSWORD, WRONG_PASSWORD, MARKER]) {
    assert.ok(!response.body.includes(secret), 'Private information exposed over HTTP');
  }
}

async function httpContract(scope) {
  await command(scope, 'php', ['/app/docker/healthcheck.php'], { EVSE_HTTP_PORT: String(scope.webPort) });
  for (const [url, title] of [['/', 'Übersicht · EVSE Control'], ['/diagramme', 'Diagramme · EVSE Control']]) {
    const response = await request(scope.webPort, url);
    assert.equal(response.code, 200);
    assert.ok(response.body.includes(`<title>${title}</title>`));
    security(response);
  }
  for (const asset of ['app.js', 'charts.js', 'style.css', 'icon.svg']) {
    const response = await request(scope.webPort, `/static/${asset}`);
    assert.equal(response.code, 200);
    assert.ok(response.body.length > 0);
    security(response);
  }
  for (const target of ['/missing', '/.env', '/php/Config.php', '/docker/entrypoint.sh',
    '/static/missing.js', '/static/.env', '/static/../php/Config.php',
    '/static/%2e%2e/php/Config.php', '/static/%2e%2e%2f.env',
    '/static/%252e%252e%252f.env', '/static/..%5c.env', '/static/index.html.bak',
    '/static/subscriber-secret', '/private-state/state.json']) {
    const response = await request(scope.webPort, target);
    assert.ok([400, 403, 404].includes(response.code), 'Unsafe/static unknown path was served');
    for (const text of [PASSWORD, WRONG_PASSWORD, MARKER, '<?php', '#!/bin/']) {
      assert.ok(!response.body.includes(text), 'Source or secret exposed');
    }
  }
  assert.equal((await request(scope.webPort, '/missing')).code, 404);
  for (const method of ['POST', 'PUT']) {
    for (const url of ['/api/state', '/healthz', '/', '/diagramme']) {
      const response = await request(scope.webPort, url, method);
      assert.equal(response.code, 405);
      security(response);
    }
  }
  const response = await request(scope.webPort, '/healthz');
  assert.equal(response.code, 200);
  assert.deepEqual(JSON.parse(response.body), { status: 'ok', read_only: true });
  security(response);
}

async function main() {
  await scenario('MQTT/HTTP lifecycle, read-only contract, concurrent readers, SIGTERM', {}, async scope => {
    await launchWeb(scope);
    await expect(scope, 'offline');
    await httpContract(scope);
    await startBroker(scope);
    await publish(scope, 'state', sample(60));
    await publish(scope, 'availability', 'online');
    await expect(scope, 'stale');
    const data = sample();
    data.private_extra = MARKER;
    data.values.private_extra = MARKER;
    await publish(scope, 'state', data);
    const live = await expect(scope, 'live');
    const expectedKeys = ['schema_version', 'read_only', 'status', 'reason', 'broker_connected',
      'availability', 'timestamp', 'last_success_at', 'age_seconds', 'fresh_for_seconds', 'values', 'error'];
    assert.deepEqual(Object.keys(live).sort(), expectedKeys.sort());
    assert.deepEqual(live.values, sample().values);
    assert.equal(live.broker_connected, true);
    assert.ok(live.fresh_for_seconds > 0 && live.fresh_for_seconds <= 3);
    const readers = await Promise.all(Array.from({ length: 24 }, () => request(scope.webPort)));
    for (const response of readers) {
      assert.equal(response.code, 200);
      security(response);
      const snapshot = JSON.parse(response.body);
      assert.deepEqual(snapshot.values, sample().values);
      assert.equal(snapshot.status, 'live');
    }
    await expect(scope, 'stale', 6000); // No MQTT messages renew the age.
    await publish(scope, 'state', 'not-json');
    await expect(scope, 'invalid');
    await publish(scope, 'state', sample());
    await expect(scope, 'live');
    await publish(scope, 'availability', 'offline');
    await expect(scope, 'offline');
    await publish(scope, 'availability', 'online');
    await expect(scope, 'live');
    await publish(scope, 'state', { ...sample(), status: 'error', values: null, error: 'read: timeout' });
    await expect(scope, 'read_error');
    await publish(scope, 'state', sample());
    await expect(scope, 'live');

    await stop(scope.broker);
    await expect(scope, 'offline');
    await startBroker(scope); // persistence=false: no retained data after restart.
    await expect(scope, 'waiting');
    await publish(scope, 'state', sample());
    await expect(scope, 'waiting'); // Prior online must have been cleared.
    await publish(scope, 'availability', 'online');
    await expect(scope, 'live');
    await stop(scope.broker);
    await expect(scope, 'offline');
    await startBroker(scope);
    await expect(scope, 'waiting');
    await publish(scope, 'availability', 'online');
    await expect(scope, 'waiting'); // Prior sample must also have been cleared.
    await publish(scope, 'state', sample());
    await expect(scope, 'live');
  });

  await scenario('password-file subscriber authentication and rejected credentials', { auth: true }, async scope => {
    await startBroker(scope);
    await publish(scope, 'availability', 'online');
    await publish(scope, 'state', sample());
    await launchWeb(scope);
    await expect(scope, 'live');
    security(await request(scope.webPort));
    await graceful(scope);
    await launchWeb(scope, true);
    await expect(scope, 'offline');
    // Observe repeated fresh publications, not just an initial disconnected frame.
    for (let i = 0; i < 8; i++) {
      await publish(scope, 'state', sample());
      await publish(scope, 'availability', 'online');
      await pause(400);
      const snapshot = await state(scope);
      assert.equal(snapshot.status, 'offline');
      assert.equal(snapshot.broker_connected, false);
      assert.equal(snapshot.values, null);
    }
    await httpContract(scope); // HTTP liveness does not depend on MQTT authentication.
  });

  for (const onlyTopic of ['state', 'availability']) {
    await scenario(`ACL allows only ${onlyTopic}: never live`, { auth: true, onlyTopic }, async scope => {
      await startBroker(scope);
      await launchWeb(scope);
      await poll('HTTP startup under restricted ACL', async () => {
        try { return (await request(scope.webPort, '/healthz')).code === 200; }
        catch (error) { if (error.code === 'ECONNREFUSED') return false; throw error; }
      });
      // Mosquitto may grant SUBACK but filter delivery: this checks fail-closed
      // behavior for an incomplete topic pair, not proof of SUBACK rejection.
      for (let i = 0; i < 10; i++) {
        await publish(scope, 'state', sample());
        await publish(scope, 'availability', 'online');
        await pause(350);
        const snapshot = await state(scope);
        assert.notEqual(snapshot.status, 'live');
        assert.equal(snapshot.values, null);
      }
      assert.equal((await request(scope.webPort, '/healthz')).code, 200);
    });
  }
  console.log(`${completed} integration scenarios passed; real MQTT, HTTP, auth/ACL, lifecycle and shutdown covered.`);
}

// Every scenario cleans up all process groups in finally before propagating errors.
// Avoid dumping assertion values, stack traces, broker logs, or environment secrets.
main().catch(() => {
  console.error(`Integration failure in ${activeScenario}; ${completed} completed scenarios (diagnostics redacted).`);
  process.exitCode = 1;
});
