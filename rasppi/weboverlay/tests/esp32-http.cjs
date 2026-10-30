'use strict';
// Disposable Docker stage only. No production endpoint, secrets, or serial device.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const session = 'b'.repeat(32), lease = 'c'.repeat(32);
const string = text => { const b = Buffer.from(text); const n = Buffer.alloc(2); n.writeUInt16BE(b.length); return Buffer.concat([n, b]); };
function frame(type, body) {
  let n = body.length; const length = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; length.push(b); } while (n);
  return Buffer.concat([Buffer.from([type, ...length]), body]);
}
function result(id, operation) {
  return { schema_version: 1, id, operation, status: operation === 'inspect' ? 'ok' : 'acknowledged',
    reason: operation === 'inspect' ? 'inspection_complete' : 'protocol_ack_only', session,
    lease: operation === 'inspect' ? lease : null, fresh_for_seconds: 8, firmware_version: 2,
    state: { charging: false, antitheft: true, store_ready: true, cards: 0, enrolling: false,
      reader_ready: true, servo_ready: true }, command_sent: operation !== 'inspect',
    result_code: operation === 'inspect' ? null : 'OK' };
}
(async () => {
  let mode = 'normal'; let commands = []; let subscriptions = []; const sockets = new Set();
  const clientIds = new Set();
  const broker = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let pending = Buffer.alloc(0); let acked = new Set();
    socket.on('data', data => {
      pending = Buffer.concat([pending, data]);
      while (pending.length >= 2) {
        let n = 0, shift = 0, pos = 1, byte;
        do { if (pos >= pending.length) return; byte = pending[pos++]; n += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128);
        if (pending.length < pos + n) return;
        const type = pending[0], body = pending.subarray(pos, pos + n); pending = pending.subarray(pos + n);
        if ((type >> 4) === 1) {
          const clientId = body.subarray(12, 12 + body.readUInt16BE(10)).toString();
          assert.match(clientId, /^evse-esp32-[a-f0-9]{32}$/);
          assert(!clientIds.has(clientId)); clientIds.add(clientId);
          socket.write(Buffer.from([0x20, 2, 0, 0]));
        }
        if ((type >> 4) === 8) {
          const topic = body.subarray(4, 4 + body.readUInt16BE(2)).toString(); subscriptions.push(topic);
          // A cached retained result before SUBACK must never become the inspection.
          const cached = result(topic.split('/').at(-1), 'inspect');
          cached.state.cards = 16;
          socket.write(frame(0x31, Buffer.concat([string(topic), Buffer.from(JSON.stringify(cached))])));
          if (mode !== 'no-suback' && !(mode === 'no-command-suback' && acked.size === 1)) {
            acked.add(topic); socket.write(Buffer.from([0x90, 3, body[0], body[1], 0]));
          }
        }
        if ((type >> 4) === 3) {
          const size = body.readUInt16BE(0), topic = body.subarray(2, 2 + size).toString();
          const payload = body.subarray(2 + size).toString();
          commands.push({ type, topic, payload, socket });
          const [v, id, s, l, operation, ma] = payload.split('|');
          assert.equal(type, 0x30, 'only QoS0 non-retained'); assert.equal(v, 'v1'); assert.match(id, /^[a-f0-9]{32}$/);
          const replyTopic = `fixture/control/result/${id}`;
          assert(acked.has(replyTopic), 'matching SUBACK precedes publish');
          assert.equal(topic, 'fixture/control/request');
          if (operation === 'inspect') { assert.equal(s, '-'); assert.equal(l, '-'); assert.equal(ma, '-'); }
          else { assert.equal(s, session); assert.equal(l, lease);
            assert.equal(ma, operation === 'revoke' ? '01:23:45:67' : '-'); }
          if (mode === 'disconnect-command' && operation !== 'inspect') { socket.destroy(); continue; }
          const r = result(id, operation);
          if (mode === 'invalid-result') r.firmware_version = 'secret-marker';
          if (mode === 'invalid-command-result' && operation !== 'inspect') r.uid = 'secret-marker';
          if (mode === 'changed-session' && operation !== 'inspect') r.session = 'd'.repeat(32);
          if (mode === 'unsupported' && operation === 'inspect') {
            r.status = 'unavailable'; r.reason = 'firmware_unsupported'; r.firmware_version = null;
            r.lease = null; r.fresh_for_seconds = 0;
            for (const key of Object.keys(r.state)) r.state[key] = null;
          }
          const retained = mode === 'retained' || (mode === 'retained-command' && operation !== 'inspect');
          const response = frame(retained ? 0x31 : 0x30, Buffer.concat([string(replyTopic), Buffer.from(JSON.stringify(r))]));
          socket.write(response);
        }
        if ((type >> 4) === 12) socket.write(Buffer.from([0xd0, 0]));
      }
    });
  });
  await new Promise(resolve => broker.listen(0, '127.0.0.1', resolve));
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`, endpoint = `${origin}/api/esp32-control`;
  const dir = await fs.mkdtemp('/tmp/evse-esp32-http-');
  const router = `${dir}/router.php`;
  await fs.writeFile(router, `<?php
require '/app/vendor/autoload.php';
require '/app/php/Esp32Http.php';
EvseOverlay\\Esp32Http::handle();
`);
  const child = spawn('php', ['-d', 'display_errors=0', '-S', `127.0.0.1:${port}`, router], {
    cwd: '/app', stdio: 'ignore', env: { ...process.env, WEB_CONTROL_ORIGIN: origin,
      SETTINGS_EDITOR_ORIGIN: 'http://wrong.invalid', MQTT_HOST: '127.0.0.1', MQTT_PORT: String(broker.address().port),
      MQTT_TOPIC_PREFIX: 'wallbox-untouched', ESP32_MQTT_TOPIC_PREFIX: 'fixture', MQTT_USERNAME: '', MQTT_PASSWORD: '', MQTT_PASSWORD_FILE: '' }
  });
  const request = (options = {}) => fetch(endpoint, { signal: AbortSignal.timeout(15000), ...options });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(endpoint, { method: 'OPTIONS' }); if (r.status === 405) { ready = true; break; } } catch (_) {}
      if (child.exitCode !== null) break;
      await delay(30);
    }
    assert(ready);
    const get = await request(); assert.equal(get.status, 200);
    assert.match(get.headers.get('cache-control'), /no-store/);
    const cookieHeader = get.headers.get('set-cookie');
    assert.match(cookieHeader, /HttpOnly/i); assert.match(cookieHeader, /SameSite=Strict/i);
    assert.match(cookieHeader, /path=\/api\/esp32-control/i);
    const cookie = cookieHeader.split(';')[0], data = await get.json();
    assert.deepEqual(Object.keys(data).sort(), ['command', 'command_sent', 'csrf', 'inspection', 'status']);
    assert.match(data.csrf, /^[a-f0-9]{64}$/); assert.equal(data.command_sent, false);
    assert.equal(data.command, null); assert.equal(data.inspection.state.cards, 0);
    const headers = { Cookie: cookie, Origin: origin, 'X-CSRF-Token': data.csrf, 'Content-Type': 'application/json' };
    const body = JSON.stringify({ operation: 'lock' });
    const post = (h = headers, b = body) => request({ method: 'POST', headers: h, body: b });
    let before = commands.length;
    const response = await post(); assert.equal(response.status, 200);
    const sent = await response.json(); assert.equal(sent.status, 'ok'); assert.equal(sent.command_sent, true);
    assert.equal(commands.length, before + 2); assert.equal(commands.at(-1).socket, commands.at(-2).socket);
    assert(!JSON.stringify(sent).includes('01:23:45:67'));
    for (const operation of ['unlock', 'enroll', 'cancel', 'revoke']) {
      const start = commands.length;
      const command = operation === 'revoke' ? { operation, uid: '01:23:45:67' } : { operation };
      const res = await post(headers, JSON.stringify(command));
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.command_sent, true);
      assert(!JSON.stringify(json).includes('01:23:45:67'));
      assert.equal(commands.length, start + 2);
      assert.equal(commands.at(-1).socket, commands.at(-2).socket);
    }
    assert.notEqual(sent.command.id, sent.inspection.id);
    before = commands.length;
    assert.equal((await post({ ...headers, Origin: 'http://foreign.invalid' })).status, 403);
    const noOrigin = { ...headers }; delete noOrigin.Origin;
    assert.equal((await post(noOrigin)).status, 403);
    assert.equal((await post({ ...headers, 'X-CSRF-Token': 'wrong' })).status, 403);
    assert.equal((await post({ ...headers, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await post({ ...headers, 'Content-Type': 'text/plain' })).status, 415);
    for (const b of ['[]', '{}', '{"operation":"lock","uid":null}',
      '{"operation":"lock","lease":"browser"}',
      '{"operation":"lock","operation":"unlock"}', ' '.repeat(1025)]) {
      const invalid = await post(headers, b);
      assert.equal(invalid.status, 400);
      assert(!JSON.stringify(await invalid.json()).includes('uid'));
    }
    assert.equal((await fetch(`${endpoint}?x=1`)).status, 400);
    assert.equal((await fetch(`${endpoint}?x=1`, { method: 'POST', headers, body })).status, 400);
    assert.equal((await request({ headers: { Origin: 'http://foreign.invalid' } })).status, 403);
    const foreignHost = await new Promise((resolve, reject) => {
      const r = http.get(endpoint, { headers: { Host: 'foreign.invalid' } }, res => { res.resume(); resolve(res.statusCode); });
      r.on('error', reject);
    }); assert.equal(foreignHost, 403);
    assert.equal(commands.length, before, 'invalid HTTP requests never contact control channel');
    const head = await request({ method: 'HEAD', headers: { Cookie: cookie } });
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
    assert.equal(commands.length, before + 1, 'HEAD only inspects');
    for (const failure of ['disconnect-command', 'invalid-command-result', 'retained-command', 'changed-session']) {
      mode = failure; before = commands.length;
      const started = Date.now();
      const unknown = await post(); assert.equal(unknown.status, 504);
      const json = await unknown.json();
      assert.equal(json.command_sent, true); assert.equal(json.status, 'outcome_unknown');
      assert(!JSON.stringify(json).includes('secret-marker'));
      assert.equal(commands.length, before + 2, 'no reconnect or resend after possible publish');
      assert(Date.now() - started < 12500, 'bounded I/O budget');
    }
    for (const failure of ['retained', 'invalid-result', 'no-suback', 'no-command-suback', 'unsupported']) {
      mode = failure; before = commands.length;
      const failed = await post(); assert.equal(failed.status, 503);
      const json = await failed.json(); assert.equal(json.command_sent, false); assert(json.csrf);
      assert.equal(commands.length - before, failure === 'no-suback' ? 0 : 1);
      assert(!JSON.stringify(json).includes('secret-marker'));
    }
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => broker.close(resolve));
    const offline = await request(); assert.equal(offline.status, 503);
    const offlineData = await offline.json(); assert(offlineData.csrf); assert.equal(offlineData.command_sent, false);
    assert.equal(new Set(subscriptions).size, subscriptions.length, 'unique result topic for every phase');
    console.log('ESP32 HTTP and isolated MQTT checks passed (Docker only)');
  } finally {
    const done = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
    await Promise.race([done, delay(2000)]); if (child.exitCode === null) child.kill('SIGKILL');
    for (const socket of sockets) socket.destroy();
    if (broker.listening) await new Promise(resolve => broker.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch(() => { console.error('ESP32 HTTP fixture failed'); process.exitCode = 1; });
