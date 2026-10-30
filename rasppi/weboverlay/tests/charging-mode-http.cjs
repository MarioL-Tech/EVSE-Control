'use strict';
// Disposable PHP listener only. This fixture does not use the public router, broker or hardware.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evse-mode-http-'));
  const dir = path.join(root, 'weboverlay'); await fs.mkdir(dir, { mode: 0o700 });
  await fs.writeFile(path.join(dir, '.env'), 'MQTT_PASSWORD=fixture-private-value\n', { mode: 0o600 });
  const router = path.join(root, 'router.php');
  await fs.writeFile(router, `<?php
require '/app/vendor/autoload.php';
require_once '/app/php/ChargingModeHttp.php';
require_once '/app/php/ChargingSettingsHttp.php';
$p = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($p === '/api/charging-mode') \\EvseOverlay\\ChargingModeHttp::handleMode();
if ($p === '/api/charging-plan') \\EvseOverlay\\ChargingModeHttp::handlePlan();
if ($p === '/api/charging-settings') \\EvseOverlay\\ChargingSettingsHttp::handle();
http_response_code($p === '/healthz' ? 200 : 404);
`);
  const probe = net.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const origin = `http://127.0.0.1:${port}`;
  const endpoint = `${origin}/api/charging-mode`, plan = `${origin}/api/charging-plan`, settings = `${origin}/api/charging-settings`;
  const child = spawn('php', ['-S', `127.0.0.1:${port}`, router], {
    cwd: '/app', stdio: 'ignore', env: { ...process.env, SETTINGS_EDITOR_ENABLED: '1',
      SETTINGS_EDITOR_ROOT: root, SETTINGS_EDITOR_ORIGIN: origin }
  });
  try {
    let ready = false;
    for (let i = 0; i < 100; ++i) {
      try { if ((await fetch(`${origin}/healthz`)).ok) { ready = true; break; } } catch (_) { /* bounded startup */ }
      await delay(30);
    }
    assert(ready);
    const get = await fetch(endpoint); assert.equal(get.status, 200);
    const cookie = get.headers.get('set-cookie').split(';')[0], initial = await get.json();
    assert.match(get.headers.get('set-cookie'), /Path=\/api\/charging-mode/i);
    assert.equal(initial.mode_revision, null); assert.equal(initial.activation.mode, 'manual');
    assert.equal(initial.activation.id, '0'.repeat(32)); assert.equal(initial.activation.guard, '0'.repeat(32));
    assert.equal(initial.semantics, 'activation_requested'); assert.equal(initial.automation_available, true);
    assert.match(initial.config_revision, /^[a-f0-9]{64}$/);
    await assert.rejects(fs.stat(path.join(dir, 'charging-active.json')));
    const initialPlan = await (await fetch(plan, { headers: { Host: 'weboverlay:8080' } })).json();
    assert.deepEqual(initialPlan.activation, initial.activation);
    assert.equal(initialPlan.config_revision, initial.config_revision);
    assert.equal(initialPlan.fresh_for_seconds, 6); assert(Math.abs(Date.now() / 1000 - initialPlan.generated_at) < 6);
    const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': initial.csrf };
    const command = { mode: 'manual', revision: null, config_revision: initial.config_revision, guard: 'a'.repeat(32) };
    const post = (data = command, h = headers) => fetch(endpoint, { method: 'POST', headers: h, body: JSON.stringify(data) });
    for (const h of [{ ...headers, Origin: 'http://foreign.invalid' }, { ...headers, 'X-CSRF-Token': 'bad' },
      { ...headers, 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await post(command, h)).status, 403);
    assert.equal((await post(command, { ...headers, 'Content-Type': 'text/plain' })).status, 415);
    for (const invalid of [{}, { ...command, extra: 1 }, { ...command, guard: 'A'.repeat(32) },
      { ...command, guard: null }, { ...command, mode: 'stop' }, { ...command, config_revision: null }])
      assert.equal((await post(invalid)).status, 400);
    const noGuard = { ...command }; delete noGuard.guard; assert.equal((await post(noGuard)).status, 400);
    for (const body of ['{"mode":"manual","mode":"manual"}', ' '.repeat(2049)])
      assert.equal((await fetch(endpoint, { method: 'POST', headers, body })).status, 400);
    const missing = await post({ ...command, mode: 'pv' }); assert.equal(missing.status, 400);
    const missingData = await missing.json(); assert.equal(missingData.reason, 'missing_configuration');
    assert.deepEqual(missingData.required, ['installation.phases', 'installation.meter_includes_wallbox', 'pv.max_import_w',
      'pv.max_current_ma', 'pv.adjust_seconds', 'pv.pause_seconds', 'pv.resume_seconds']);
    await assert.rejects(fs.stat(path.join(dir, 'charging-active.json')));
    const firstResponse = await post(); assert.equal(firstResponse.status, 200); const first = await firstResponse.json();
    assert.equal(first.activation.guard, command.guard); assert.notEqual(first.activation.id, initial.activation.id);
    assert.equal((await post()).status, 409);
    const reselect = await post({ ...command, revision: first.mode_revision }); assert.equal(reselect.status, 200);
    const selected = await reselect.json(); assert.notEqual(selected.activation.id, first.activation.id);
    const before = await fs.readFile(path.join(dir, 'charging-active.json'), 'utf8');
    // Draft saves cannot mutate the active snapshot, nonce or reader-owned guard.
    const draftResponse = await fetch(settings), draft = await draftResponse.json();
    const draftHeaders = { ...headers, Cookie: draftResponse.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': draft.csrf };
    const config = structuredClone(draft.config);
    config.installation = { phases: 3, meter_includes_wallbox: false };
    config.pv = { max_import_w: 100, max_current_ma: 32000, adjust_seconds: 2, pause_seconds: 3, resume_seconds: 4 };
    const save = await fetch(settings, { method: 'POST', headers: draftHeaders,
      body: JSON.stringify({ revision: draft.revision, config }) });
    assert.equal(save.status, 200); const saved = await save.json();
    assert.equal(await fs.readFile(path.join(dir, 'charging-active.json'), 'utf8'), before);
    const unchanged = await (await fetch(plan)).json(); assert.deepEqual(unchanged.config, initialPlan.config);
    assert.deepEqual(unchanged.activation, selected.activation);
    const stale = await post({ ...command, revision: selected.mode_revision }); assert.equal(stale.status, 409);
    const legacy = structuredClone(config); delete legacy.installation;
    assert.equal((await fetch(settings, { method: 'POST', headers: draftHeaders,
      body: JSON.stringify({ revision: saved.revision, config: legacy }) })).status, 400);
    const pvResponse = await post({ ...command, mode: 'pv', revision: selected.mode_revision, config_revision: saved.revision });
    assert.equal(pvResponse.status, 200); const pv = await pvResponse.json();
    const planResponse = await fetch(plan); const activePlan = await planResponse.json();
    assert.deepEqual(activePlan.config, config); assert.deepEqual(activePlan.activation, pv.activation);
    assert.equal(activePlan.config_revision, saved.revision); assert.equal(activePlan.activation.guard, command.guard);
    assert.equal(planResponse.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Object.keys(activePlan).sort(), ['activation', 'config', 'config_revision', 'fresh_for_seconds', 'generated_at', 'schema_version', 'status']);
    const disk = await fs.readFile(path.join(dir, 'charging-active.json'), 'utf8');
    for (const url of [endpoint, plan]) {
      assert.equal((await fetch(`${url}?x=1`)).status, 400);
      assert.equal((await fetch(url, { method: 'PUT' })).status, 405);
      const head = await fetch(url, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
    }
    assert.equal((await fetch(plan, { method: 'POST', headers, body: '{}' })).status, 405);
    assert.equal((await fetch(endpoint, { headers: { Host: 'foreign.invalid' } })).status, 403);
    assert.equal(await fs.readFile(path.join(dir, 'charging-active.json'), 'utf8'), disk);
    assert.equal(await fs.readFile(path.join(dir, '.env'), 'utf8'), 'MQTT_PASSWORD=fixture-private-value\n');
    assert(!JSON.stringify(activePlan).includes('fixture-private-value')); assert(!JSON.stringify(activePlan).includes(root));
    await fs.writeFile(path.join(dir, 'charging-active.json'), '{}');
    assert.equal((await fetch(plan)).status, 503); assert.equal((await fetch(endpoint)).status, 503);
    console.log('Charging mode HTTP: strict guard/CSRF/origin, revisions, immutable snapshots, plan/HEAD/no-store passed');
  } finally {
    const ended = new Promise(r => child.once('exit', r)); child.kill('SIGTERM');
    await Promise.race([ended, delay(2000)]); if (child.exitCode === null) child.kill('SIGKILL');
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(() => { console.error('Charging mode HTTP fixture failed'); process.exitCode = 1; });
