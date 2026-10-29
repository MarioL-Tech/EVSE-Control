'use strict';
// Run ONLY inside the isolated Docker test image. No production endpoints.
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const pause = ms => new Promise(r => setTimeout(r, ms));
const children = new Set();
let logs = '', mode = 'positive', hits = 0;
function child(command, args, env = {}) {
  const childEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(childEnv)) if (value === null) delete childEnv[key];
  const p = spawn(command, args, { cwd: '/app', env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(p); p.output = '';
  for (const s of [p.stdout, p.stderr]) s.on('data', b => { p.output += b; logs += b; });
  p.done = new Promise((resolve, reject) => { p.once('error', reject); p.once('exit', (code, signal) => { children.delete(p); resolve({ code, signal }); }); });
  return p;
}
async function stop(p) {
  if (!p || p.exitCode !== null) return;
  p.kill('SIGTERM');
  const result = await Promise.race([p.done, pause(7000).then(() => null)]);
  if (!result) p.kill('SIGKILL');
  assert(result, 'bounded shutdown'); return result;
}
async function until(fn, timeout = 12000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) { if (await fn()) return; await pause(40); }
  throw new Error('House fixture timed out');
}
async function listen(server) {
  await new Promise(r => server.listen(0, '127.0.0.1', r)); return server.address().port;
}
async function port() { const s = net.createServer(); const p = await listen(s); await new Promise(r => s.close(r)); return p; }
const source = http.createServer((req, res) => {
  hits++; assert.equal(req.method, 'GET'); assert.equal(req.url, '/private-house-source');
  if (mode === 'slow') return;
  if (mode === 'http_error') { res.writeHead(503); return res.end('private-http-error-marker'); }
  if (mode === 'malformed') return res.end('private-body-marker');
  if (mode === 'oversafe') return res.end('1 2 3 4 5 6 9007199254740992');
  res.end(`1 2 3 4 5 6 ${mode === 'negative' ? '-800.5' : mode === 'zero' ? '0' : '1549.4'}`);
});
let publisher, subscriber, broker, root;
const sockets = new Set();
source.on('connection', s => { sockets.add(s); s.once('close', () => sockets.delete(s)); });
async function main() {
  root = await fs.mkdtemp(os.tmpdir() + '/house-fixture-');
  const httpPort = await listen(source), mqttPort = await port();
  const conf = root + '/mosquitto.conf';
  await fs.writeFile(conf, `listener ${mqttPort} 127.0.0.1\nallow_anonymous true\npersistence false\n`);
  broker = child('mosquitto', ['-c', conf]);
  await until(() => new Promise(r => { const s = net.connect(mqttPort, '127.0.0.1'); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); }));
  subscriber = child('stdbuf', ['-oL', '-eL', 'mosquitto_sub', '-d', '-q', '1', '-h', '127.0.0.1', '-p', String(mqttPort), '-t', 'evse/house/#', '-F', '%t %p']);
  await until(() => /received suback/i.test(subscriber.output));
  const env = { SMARTMETER_URL: `http://127.0.0.1:${httpPort}/private-house-source`, SMARTMETER_POLL_SECONDS: '1',
    SMARTMETER_TIMEOUT_SECONDS: '1', MQTT_HOST: '127.0.0.1', MQTT_PORT: String(mqttPort),
    HOUSE_MQTT_TOPIC_PREFIX: 'evse/house', HOUSE_PUBLISHER_CLIENT_ID: 'evse-house-publisher',
    MQTT_TOPIC_PREFIX: 'evse/wallbox-poison', MQTT_CLIENT_ID: 'evse-wallbox-poison',
    MQTT_USERNAME: '', MQTT_PASSWORD: '', MQTT_PASSWORD_FILE: '' };
  const states = () => subscriber.output.split('\n').filter(l => l.startsWith('evse/house/state ')).map(l => JSON.parse(l.slice(17)));
  const availability = () => subscriber.output.split('\n').filter(l => l.startsWith('evse/house/availability ')).map(l => l.slice(24));
  publisher = child('php', ['/app/php/house-publisher.php'], env);
  await until(() => states().some(s => s.status === 'ok' && s.power_w === 1549.4));
  await until(() => availability().at(-1) === 'online');
  for (const [m, power] of [['negative', -800.5], ['zero', 0]]) {
    mode = m; await until(() => states().some(s => s.status === 'ok' && s.power_w === power));
  }
  for (const m of ['http_error', 'malformed', 'oversafe']) {
    const before = states().length; mode = m;
    await until(() => states().slice(before).some(s => s.error === 'read_failed' && s.power_w === null));
    await until(() => availability().at(-1) === 'offline');
  }
  const health = child('php', ['/app/docker/house-healthcheck.php'], env);
  assert.equal((await health.done).code, 0);
  const snapshot = await fs.readFile('/tmp/evse-house-publisher/health.json', 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(snapshot)).sort(), ['heartbeat', 'pid', 'running', 'schema_version']);
  // New subscriber must receive retained QoS-1 state and availability.
  const retained = child('mosquitto_sub', ['-q', '1', '-h', '127.0.0.1', '-p', String(mqttPort), '-t', 'evse/house/#', '-C', '2', '-F', '%r %q %t %p']);
  await until(() => retained.exitCode !== null);
  assert.equal((await retained.done).code, 0);
  const retainedLines = retained.output.split('\n').filter(Boolean);
  assert.equal(retainedLines.length, 2); assert(retainedLines.every(l => l.startsWith('1 1 ')));
  assert.deepEqual(new Set(retainedLines.map(l => l.split(' ')[2])), new Set(['evse/house/state', 'evse/house/availability']));
  mode = 'positive'; await until(() => states().at(-1)?.status === 'ok');
  const old = states().at(-1), countBeforeOutage = hits;
  await stop(broker); broker = null;
  await until(() => hits >= countBeforeOutage + 3);
  broker = child('mosquitto', ['-c', conf]);
  await until(() => states().some(s => s.publisher_id === old.publisher_id && s.sequence > old.sequence && s.status === 'ok'), 18000);
  assert.equal((await stop(publisher)).code, 0); publisher = null;
  await until(() => availability().at(-1) === 'offline');
  const deadHealth = child('php', ['/app/docker/house-healthcheck.php'], env);
  assert.equal((await deadHealth.done).code, 1);
  publisher = child('php', ['/app/php/house-publisher.php'], env);
  const onlineBefore = subscriber.output.split('evse/house/availability online').length;
  await until(() => subscriber.output.split('evse/house/availability online').length > onlineBefore);
  const offlineBefore = subscriber.output.split('evse/house/availability offline').length;
  publisher.kill('SIGKILL'); await publisher.done; publisher = null;
  await until(() => subscriber.output.split('evse/house/availability offline').length > offlineBefore);
  const crashedHealth = child('php', ['/app/docker/house-healthcheck.php'], env);
  assert.equal((await crashedHealth.done).code, 1);
  await fs.writeFile('/tmp/evse-house-publisher/health.json', '{bad');
  const brokenHealth = child('php', ['/app/docker/house-healthcheck.php'], env);
  assert.equal((await brokenHealth.done).code, 1);
  assert(states().some(s => s.error === 'startup'));
  for (const s of states()) {
    assert.deepEqual(Object.keys(s).sort(), ['schema_version', 'device', 'publisher_id', 'sequence', 'timestamp', 'status', 'last_success_at', 'power_w', 'error'].sort());
    assert.equal(s.device, 'house_grid'); assert(s.sequence >= 1 && s.sequence <= 4294967295);
  }
  // Strict fake broker: deny CONNECT, then accept but deliberately omit PUBACK.
  let connections = 0, denies = true, publishes = [], connects = [], ack = false;
  const fakeSockets = new Set();
  function field(body, offset) {
    assert(offset + 2 <= body.length); const length = body.readUInt16BE(offset); offset += 2;
    assert(offset + length <= body.length); return { value: body.subarray(offset, offset + length).toString(), offset: offset + length };
  }
  function connectFields(body) {
    let item = field(body, 0); assert.equal(item.value, 'MQTT'); let offset = item.offset;
    assert.equal(body[offset++], 4); const flags = body[offset++]; assert.equal(body.readUInt16BE(offset), 15); offset += 2;
    item = field(body, offset); const clientId = item.value; offset = item.offset;
    item = field(body, offset); const willTopic = item.value; offset = item.offset;
    item = field(body, offset); const willPayload = item.value; offset = item.offset;
    let username = '', password = '';
    if (flags & 128) { item = field(body, offset); username = item.value; offset = item.offset; }
    if (flags & 64) { item = field(body, offset); password = item.value; offset = item.offset; }
    assert.equal(offset, body.length);
    return { flags, clientId, willTopic, willPayload, username, password };
  }
  const fake = net.createServer(socket => {
    const connection = ++connections;
    fakeSockets.add(socket); socket.on('error', () => {}); socket.on('close', () => fakeSockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]); assert(buffer.length < 32768);
      while (buffer.length >= 2) {
        let n = 0, scale = 1, i = 1, digit;
        do { if (i >= buffer.length) return; digit = buffer[i++]; n += (digit & 127) * scale; scale *= 128; assert(i <= 5); } while (digit & 128);
        if (buffer.length < i + n) return;
        const header = buffer[0], body = buffer.subarray(i, i + n); buffer = buffer.subarray(i + n);
        if (header === 16) {
          connects.push(connectFields(body));
          socket.write(Buffer.from([32, 2, 0, denies ? 5 : 0])); if (denies) socket.end();
        }
        else if (header === 0x33) {
          const len = body.readUInt16BE(0), topic = body.subarray(2, 2 + len).toString(), mid = body.subarray(2 + len, 4 + len);
          publishes.push({ connection, topic, payload: body.subarray(4 + len).toString() });
          if (ack) socket.write(Buffer.concat([Buffer.from([64, 2]), mid]));
        } else if (header === 0xc0) socket.write(Buffer.from([0xd0, 0]));
      }
    });
  });
  const fakePort = await listen(fake);
  try {
    // Missing HOUSE overrides must use HOUSE defaults, never the toxic generic
    // Wallbox namespace. Disabled source keeps one identity for retry checks.
    publisher = child('php', ['/app/php/house-publisher.php'], { ...env, HOUSE_MQTT_TOPIC_PREFIX: null,
      HOUSE_PUBLISHER_CLIENT_ID: null, MQTT_PORT: String(fakePort), SMARTMETER_URL: '',
      MQTT_USERNAME: 'fixture-user', MQTT_PASSWORD: 'private-password-marker' });
    await until(() => connects.length >= 2); assert.equal(publishes.length, 0);
    assert(connects.every(c => c.clientId === 'evse-house-publisher' && c.willTopic === 'evse/house/availability'
      && c.willPayload === 'offline' && c.username === 'fixture-user' && c.password === 'private-password-marker'
      && c.flags === 0xee));
    denies = false; await until(() => publishes.length >= 4, 18000);
    assert(publishes.every(p => p.topic === 'evse/house/state' || p.topic === 'evse/house/availability'));
    const retried = publishes.filter(p => p.topic.endsWith('/state'));
    assert(retried.length >= 2); assert.equal(retried[0].payload, retried[1].payload);
    for (const c of new Set(publishes.map(p => p.connection))) assert(publishes.filter(p => p.connection === c).length <= 2);
    ack = true; await stop(publisher); publisher = null;
    // HTTP polling continues while MQTT is denied; no source URL/body is logged.
    denies = true; const before = hits;
    publisher = child('php', ['/app/php/house-publisher.php'], { ...env, MQTT_PORT: String(fakePort) });
    await until(() => hits >= before + 3);
    mode = 'slow'; await pause(1100);
    assert.equal((await stop(publisher)).code, 0); publisher = null;
  } finally { for (const s of fakeSockets) s.destroy(); await new Promise(r => fake.close(r)); }
  assert(!logs.includes('private-house-source') && !logs.includes('private-body-marker')
    && !logs.includes('private-http-error-marker') && !logs.includes('private-password-marker'));
  console.log('House isolated HTTP/MQTT/health/shutdown checks passed');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  for (const p of [...children]) { try { await stop(p); } catch { p.kill('SIGKILL'); } }
  for (const s of sockets) s.destroy(); source.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});
