'use strict';
// Disposable PHP listener/config-only directory; no broker, device or production files.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evse-charging-http-'));
  await fs.mkdir(path.join(root, 'weboverlay'), { mode: 0o700 });
  const probe = net.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const origin = `http://127.0.0.1:${port}`, endpoint = `${origin}/api/charging-settings`;
  const child = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', 'public', 'public/index.php'], {
    cwd: '/app', stdio: 'ignore', env: { ...process.env, SETTINGS_EDITOR_ENABLED: '1',
      SETTINGS_EDITOR_ROOT: root, SETTINGS_EDITOR_ORIGIN: origin }
  });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${origin}/healthz`)).ok) { ready = true; break; } } catch (_) { /* bounded startup */ }
      await delay(30);
    }
    assert(ready);
    const get = await fetch(endpoint); assert.equal(get.status, 200);
    const cookie = get.headers.get('set-cookie').split(';')[0], initial = await get.json();
    assert.equal(initial.automation_available, false); assert.equal(initial.revision, null);
    assert.equal(initial.config.pv.max_import_w, null);
    const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': initial.csrf };
    const config = structuredClone(initial.config); config.pv.max_import_w = 123;
    config.custom.use_schedule = true; config.custom.weekdays = [1, 5];
    config.custom.windows = [{ from: '22:00', to: '06:00' }, { from: '12:00', to: '13:00' }];
    const body = JSON.stringify({ revision: null, config });
    const post = (h = headers, b = body) => fetch(endpoint, { method: 'POST', headers: h, body: b });
    assert.equal((await post({ ...headers, Origin: 'http://foreign.invalid' })).status, 403);
    assert.equal((await post({ ...headers, 'X-CSRF-Token': 'bad' })).status, 403);
    assert.equal((await post({ ...headers, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await post({ ...headers, 'Content-Type': 'text/plain' })).status, 415);
    for (const invalid of ['{}', '[]', '{"revision":null,"revision":null,"config":{}}', ' '.repeat(16385)])
      assert.equal((await post(headers, invalid)).status, 400);
    const saved = await post(); assert.equal(saved.status, 200);
    const result = await saved.json(); assert.match(result.revision, /^[a-f0-9]{64}$/);
    assert.deepEqual(result.config, config); assert.equal(result.automation_available, false);
    assert.equal((await post()).status, 409, 'stale revision cannot overwrite');
    const read = await fetch(endpoint); assert.deepEqual((await read.json()).config, config);
    assert.equal(read.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(`${endpoint}?x=1`)).status, 400);
    assert.equal((await fetch(endpoint, { headers: { Host: 'foreign.invalid' } })).status, 403);
    const head = await fetch(endpoint, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
    assert.equal((await fetch(endpoint, { method: 'PUT' })).status, 405);
    const files = await fs.readdir(path.join(root, 'weboverlay'));
    assert.deepEqual(files.sort(), ['charging.json', 'charging.lock']);
    console.log('Charging settings HTTP: CSRF/origin, strict input, persistence, revisions, no-store passed');
  } finally {
    const ended = new Promise(r => child.once('exit', r)); child.kill('SIGTERM');
    await Promise.race([ended, delay(2000)]); if (child.exitCode === null) child.kill('SIGKILL');
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(() => { console.error('Charging settings HTTP fixture failed'); process.exitCode = 1; });
