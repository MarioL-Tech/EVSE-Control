'use strict';
// Disposable Docker test stage only. No production mount, credentials or daemon.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

(async () => {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const dir = '/run/evse-settings/weboverlay';
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const filename = `${dir}/.env`;
  await fs.writeFile(filename, '# retained\nWEB_PORT=8080\nMQTT_PASSWORD=private-test-marker\n', { mode: 0o600 });
  async function run(enabled, check) {
    const child = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', 'public', 'public/index.php'], {
      cwd: '/app', stdio: 'ignore', env: { ...process.env,
        SETTINGS_EDITOR_ENABLED: enabled, SETTINGS_EDITOR_ORIGIN: origin }
    });
    let ready = false;
    try {
      for (let i = 0; i < 100; i++) {
        try { if ((await fetch(`${origin}/healthz`)).ok) { ready = true; break; } } catch (_) { /* bounded startup */ }
        if (child.exitCode !== null) break;
        await delay(30);
      }
      assert(ready, 'disposable PHP listener starts');
      await check();
    } finally {
      const done = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([done, delay(2000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
  try {
    await run('0', async () => {
      const response = await fetch(`${origin}/api/settings-env?service=weboverlay`);
      assert.equal((await response.json()).status, 'disabled');
      assert.equal((await fetch(`${origin}/api/settings-env`, { method: 'POST', body: '{}' })).status, 405);
    });
    await run('1', async () => {
      const response = await fetch(`${origin}/api/settings-env?service=weboverlay`);
      assert.match(response.headers.get('cache-control'), /no-store/);
      const cookie = response.headers.get('set-cookie').split(';')[0];
      assert.match(response.headers.get('set-cookie'), /HttpOnly/i);
      const data = await response.json();
      assert.equal(data.snapshot.status, 'ok');
      assert(!JSON.stringify(data).includes('private-test-marker'));
      const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': data.csrf };
      const body = JSON.stringify({ service: 'weboverlay', revision: data.snapshot.revision, changes: { WEB_PORT: '8081' }, create: false });
      const post = h => fetch(`${origin}/api/settings-env`, { method: 'POST', headers: h, body });
      assert.equal((await post({ ...headers, Origin: 'http://foreign.invalid' })).status, 403);
      assert.equal((await post({ ...headers, 'X-CSRF-Token': 'wrong' })).status, 403);
      const saved = await post(headers);
      assert.equal(saved.status, 200);
      assert.equal((await saved.json()).snapshot.entries.WEB_PORT.value, '8081');
      assert.match(await fs.readFile(filename, 'utf8'), /WEB_PORT='8081'/);
      assert.match(await fs.readFile(filename, 'utf8'), /MQTT_PASSWORD=private-test-marker/);
      assert.equal((await post(headers)).status, 409);
      assert.equal((await fetch(`${origin}/api/state`, { method: 'POST', headers, body: '{}' })).status, 405);
      assert.equal((await fetch(`${origin}/api/settings-env?service=../storage`, { headers: { Cookie: cookie } })).status, 400);
      // Host headers cannot select an alternate origin (including rebinding).
      const status = await new Promise((resolve, reject) => {
        const request = http.get(`${origin}/api/settings-env?service=weboverlay`, { headers: { Host: 'foreign.invalid' } }, r => {
          r.resume(); resolve(r.statusCode);
        }); request.on('error', reject);
      });
      assert.equal(status, 403);
    });
    console.log('Env settings HTTP checks passed (disposable Docker only)');
  } finally { await fs.rm('/run/evse-settings/weboverlay', { recursive: true, force: true }); }
})().catch(() => { console.error('Env settings HTTP checks failed'); process.exitCode = 1; });
