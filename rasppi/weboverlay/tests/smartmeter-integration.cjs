'use strict';

// Docker-only isolated loopback source; requires the parent's smartmeter route/supervisor wiring.
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let completed = 0;
let mode = 'positive';
let hits = 0;
let redirectFollows = 0;
let child;
let childDone;
let stoppedPid;
let port;
let directory;
let root;
const source = http.createServer((req, res) => {
  hits++;
  assert.equal(req.method, 'GET');
  if (req.url === '/must-not-follow') { redirectFollows++; return res.end('1 2 3 4 5 6 999'); }
  if (mode === 'slow') return; // Socket forcibly closed during cleanup.
  if (mode === '500') { res.writeHead(500); return res.end('private-source-marker'); }
  if (mode === 'redirect') { res.writeHead(302, { Location: '/must-not-follow' }); return res.end(); }
  if (mode === 'headers') { res.setHeader('X-Padding', 'x'.repeat(9000)); }
  if (mode === 'malformed') return res.end('private-source-marker not numeric');
  if (mode === 'oversize') return res.end('1 '.repeat(3000));
  const power = mode === 'negative' ? '-1200.5' : mode === 'zero' ? '0' : '1549.40';
  res.end(`234.40 232.90 234.40 348.60 164.90 309.90 ${power} 741.80 159.70 647.70 -799.40`);
});

async function freePort() {
  const s = net.createServer();
  await new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', resolve); });
  const p = s.address().port;
  await new Promise(resolve => s.close(resolve));
  return p;
}

function request(route = '/api/smartmeter', method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, timeout: 1500 }, res => {
      let body = '';
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 32768) req.destroy(new Error('Oversize API'));
      });
      res.on('end', () => resolve({ code: res.statusCode, body }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('API timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function state() {
  const response = await request();
  assert.equal(response.code, 200);
  assert(!response.body.includes('private-source-marker'));
  assert(!response.body.includes('/private-source-path'));
  assert(!response.body.includes('127.0.0.1'));
  const value = JSON.parse(response.body);
  assert.deepEqual(Object.keys(value).sort(), ['schema_version', 'read_only', 'status', 'reason',
    'power_w', 'fetched_at', 'age_seconds', 'fresh_for_seconds'].sort());
  assert.equal(value.read_only, true);
  assert.equal(value.schema_version, 1);
  if (value.status !== 'live') { assert.equal(value.power_w, null); assert.equal(value.fresh_for_seconds, 0); }
  return value;
}

async function until(probe, milliseconds = 10000) {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    try { if (await probe()) return; } catch { /* Startup or transient state. */ }
    await pause(70);
  }
  throw new Error('Smartmeter integration condition timed out');
}

function groupSignal(signal) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; }
}

async function stop(checkGraceful = false) {
  if (!child) return;
  if (stoppedPid) { try { process.kill(stoppedPid, 'SIGCONT'); } catch {} stoppedPid = undefined; }
  const start = performance.now();
  groupSignal('SIGTERM');
  const result = await Promise.race([childDone, pause(6800).then(() => null)]);
  groupSignal('SIGKILL');
  if (checkGraceful) {
    assert(result && result.code === 0 && performance.now() - start < 7000);
    completed++;
  }
  child = undefined;
}

async function launch(enabled) {
  directory = await fs.mkdtemp(root + '/state-');
  port = await freePort();
  const log = syncFs.openSync(directory + '/process.log', 'a', 0o600);
  child = spawn('/app/docker/entrypoint.sh', [], { cwd: '/app', detached: true,
    stdio: ['ignore', log, log], env: { ...process.env,
      EVSE_HTTP_PORT: String(port), WEB_STATE_DIR: directory,
      MQTT_HOST: '127.0.0.1', MQTT_PORT: String(await freePort()),
      MQTT_CLIENT_ID: 'isolated-smartmeter-test', MQTT_USERNAME: '', MQTT_PASSWORD: '', MQTT_PASSWORD_FILE: '',
      SMARTMETER_URL: enabled ? `http://127.0.0.1:${source.address().port}/private-source-path` : '',
      SMARTMETER_POLL_SECONDS: '1', SMARTMETER_TIMEOUT_SECONDS: '1', SMARTMETER_STALE_SECONDS: '3' } });
  syncFs.closeSync(log);
  childDone = new Promise(resolve => {
    child.once('error', () => resolve({ code: null }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  await until(async () => (await request('/healthz')).code === 200);
}

async function workerPid() {
  const children = (await fs.readFile(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8')).trim().split(/\s+/);
  for (const pid of children) {
    try {
      const cmd = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8');
      if (cmd.includes('php/smartmeter-worker.php')) return Number(pid);
    } catch { /* Process disappeared. */ }
  }
  throw new Error('Smartmeter worker not found');
}

(async () => {
  root = await fs.mkdtemp('/tmp/smartmeter-integration-');
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
  await launch(true);
  for (const [nextMode, expected] of [['positive', 1549.4], ['negative', -1200.5], ['zero', 0]]) {
    mode = nextMode;
    await until(async () => { const s = await state(); return s.status === 'live' && s.power_w === expected; });
    completed++;
  }
  // Independent API remains live with no MQTT broker listening.
  assert.equal((await request('/api/state')).code, 200);
  assert.equal((await state()).status, 'live'); completed++;
  const before = hits;
  await Promise.all(Array.from({ length: 20 }, () => state()));
  assert(hits - before <= 1, 'API reads must not fetch source'); completed++;
  for (const failure of ['500', 'malformed', 'oversize', 'headers', 'redirect', 'slow']) {
    mode = failure;
    await until(async () => (await state()).status === 'read_error');
    if (failure === 'redirect') assert.equal(redirectFollows, 0, 'Never follow source redirects');
    assert.equal((await request('/healthz')).code, 200);
    assert.equal((await request('/api/state')).code, 200);
    completed++;
    mode = 'positive';
    await until(async () => (await state()).status === 'live');
  }
  for (const method of ['POST', 'PUT']) {
    assert.equal((await request('/api/smartmeter', method)).code, 405); completed++;
  }
  stoppedPid = await workerPid();
  process.kill(stoppedPid, 'SIGSTOP');
  await until(async () => (await state()).status === 'offline', 6000);
  assert.equal((await request('/api/state')).code, 200); completed++;
  process.kill(stoppedPid, 'SIGCONT'); stoppedPid = undefined;
  await until(async () => (await state()).status === 'live');
  await stop(true);
  const disabledHits = hits;
  await launch(false);
  await until(async () => (await state()).status === 'disabled');
  await pause(1200);
  assert.equal(hits, disabledHits); completed++;
  await stop(true);
  console.log(`Smartmeter integration: ${completed} scenarios passed`);
})().catch(() => {
  // Do not expose source URLs, bodies, logs or environment even on failure.
  console.error(`Smartmeter integration failed (${completed} completed, mode=${mode})`); process.exitCode = 1;
}).finally(async () => {
  await stop();
  source.closeAllConnections();
  await new Promise(resolve => source.close(resolve));
  if (root) await fs.rm(root, { recursive: true, force: true });
});
