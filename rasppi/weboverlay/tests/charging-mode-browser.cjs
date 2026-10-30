'use strict';
// Standalone simulated DOM/API contract, not a hardware or integrated-page test.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../static/charging-mode.js'), 'utf8');
const H = (n, c = 'a') => c.repeat(n);
const origin = 'http://charging-mode.test';
const auto = overrides => ({ schema_version: 1, guard: H(32), requested_mode: 'manual', activation_id: H(32, '0'),
  config_revision: H(64), state: 'manual', plan: 'ok', house: 'ok', ...overrides });
const draft = overrides => ({ schema_version: 1, status: 'ok', csrf: H(64), mode_revision: null, config_revision: H(64),
  activation: { mode: 'manual', id: H(32, '0'), guard: H(32, '0') }, automation_available: true,
  semantics: 'activation_requested', required: [], ...overrides });
const control = automation => ({ status: 'ok', csrf: H(64), command_sent: false, command: null, inspection: {
  schema_version: 1, id: H(32), operation: 'inspect', status: 'ok', reason: 'read_only_inspection',
  session: H(32), lease: H(32), fresh_for_seconds: 8, read_only: true, minimum_ma: 6000, software_max_ma: 32000,
  hardware_max_ma: 32000, installation_max_ma: null, effective_max_ma: null, firmware_raw: null,
  write: null, preparation: null, ...(automation ? { automation } : {}) } });
(async () => {
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    let current = draft(), reader = auto(), failure = null, held = null, controlCount = 0, getCount = 0;
    const posts = [], calls = [];
    await context.route(`${origin}/fixture`, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="de"><meta charset="utf-8">
      <div id="wallbox-control"><label><input type="radio" id="control-mode-pv" name="charging-mode">PV-Regelung</label>
      <label><input type="radio" id="control-mode-manual" name="charging-mode">Manuell</label>
      <label><input type="radio" id="control-mode-custom" name="charging-mode">Benutzerdefiniert</label>
      <p id="automation-status" role="status"></p><button id="control-stop">Stop</button></div>
      <script>window.modeEvents=[];window.refreshes=0;addEventListener('evse:automation-mode',e=>modeEvents.push(e.detail));
      addEventListener('evse:refresh-control',()=>refreshes++);</script><script src="/charging-mode.js"></script></html>` }));
    await context.route(`${origin}/charging-mode.js`, route => route.fulfill({ contentType: 'application/javascript', body: source }));
    await context.route(`${origin}/api/wallbox-control`, route => {
      assert.equal(route.request().method(), 'GET'); controlCount++; calls.push('control');
      return route.fulfill({ json: control(reader) });
    });
    await context.route(`${origin}/api/charging-mode`, async route => {
      if (route.request().method() === 'GET') { getCount++; calls.push('mode'); return route.fulfill({ json: current }); }
      calls.push('post');
      const body = route.request().postDataJSON(); posts.push(body);
      assert.deepEqual(Object.keys(body).sort(), ['config_revision', 'guard', 'mode', 'revision']);
      assert.equal(route.request().headers()['x-csrf-token'], H(64));
      const response = draft({ mode_revision: H(64, 'b'), activation: { mode: body.mode, id: posts.length.toString(16).padStart(32, '0'), guard: body.guard } });
      if (held) { const wait = held; held = null; wait.enter(); await wait.promise; }
      if (failure === 'abort') return route.abort().catch(() => {});
      if (failure === 'oversize') return route.fulfill({ contentType: 'application/json', body: ' '.repeat(16385) }).catch(() => {});
      if (failure === 'duplicate') return route.fulfill({ contentType: 'application/json', body: '{"schema_version":1,"schema_version":1}' }).catch(() => {});
      if (failure) return route.fulfill({ status: failure, json: draft({ status: failure === 409 ? 'conflict' : failure === 403 ? 'forbidden' : 'invalid',
        ...(failure === 400 ? { reason: 'missing_configuration', required: ['installation.phases', 'pv.max_import_w'] } : {}) }) }).catch(() => {});
      current = response;
      return route.fulfill({ json: response }).catch(() => {});
    });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(String(error)));
    const settle = () => page.waitForFunction(() => window.modeEvents.length && !window.modeEvents.at(-1).pending);
    const observe = value => page.evaluate(automation => dispatchEvent(new CustomEvent('evse:automation-observation', { detail: { automation } })), value);
    const text = () => page.locator('#automation-status').textContent();
    const checked = async mode => { assert.equal(await page.locator('input:checked').count(), 1); assert.equal(await page.locator(`#control-mode-${mode}`).isChecked(), true); };
    const select = async mode => { await page.locator(`#control-mode-${mode}`).click(); await settle(); };
    await page.goto(`${origin}/fixture`); await settle();
    assert.equal(posts.length, 0); assert.equal(controlCount, 0); await checked('manual');
    assert.equal(await page.locator('#control-mode-pv').isDisabled(), true);
    await page.reload(); await settle();
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))); await settle();
    assert.equal(posts.length, 0); assert.equal(controlCount, 0);
    // Backend support is insufficient; legacy reader remains manual.
    await observe(null); await checked('manual'); assert.equal(await page.locator('#control-mode-custom').isDisabled(), true);
    await observe(reader); calls.length = 0;
    await select('pv');
    assert.deepEqual(calls, ['control', 'mode', 'post']);
    assert.match(await text(), /angefordert/); assert.doesNotMatch(await text(), /aktiviert/);
    await checked('pv');
    reader = auto({ requested_mode: 'pv', activation_id: current.activation.id, state: 'adjusting' });
    await observe(reader); assert.match(await text(), /passt Strom an/);
    const beforeForeign = posts.length;
    reader = auto({ requested_mode: 'custom', activation_id: H(32, '9'), state: 'resuming' });
    await observe(reader); await checked('custom');
    assert.equal(posts.length, beforeForeign, 'Another operator activation is observed, never overwritten or replayed');
    reader = auto({ guard: H(32, 'e'), state: 'manual_override', requested_mode: 'pv' });
    await observe(reader); await checked('manual'); assert.match(await text(), /manuellen Eingriff/);
    await select('pv'); await checked('pv');
    assert.match(await text(), /angefordert/, 'New matching-guard intent is pending, not the old manual override');
    reader = auto({ guard: H(32, 'd'), state: 'manual_override', requested_mode: 'pv' });
    await observe(reader); await checked('manual');
    // Reader restart requires deliberate reselection, no automatic replay.
    reader = auto({ guard: H(32, 'f'), requested_mode: 'pv', state: 'awaiting_activation' });
    const beforeRestart = posts.length; await observe(reader); await checked('pv');
    assert.match(await text(), /erneut wählen/); assert.equal(posts.length, beforeRestart);
    await select('pv'); assert.equal(posts.at(-1).guard, H(32, 'f')); assert.equal(posts.length, beforeRestart + 1);
    // Frozen state remains visible and can only be retried by an explicit click.
    reader = auto({ guard: H(32, 'f'), requested_mode: 'pv', state: 'frozen' }); await observe(reader);
    assert.match(await text(), /gesperrt/); await select('pv');
    // Every native arrow action produces exactly one request, still exclusive.
    reader = auto(); await observe(reader); await select('manual');
    const beforeKeys = posts.length;
    await page.locator('#control-mode-manual').focus(); await page.keyboard.press('ArrowRight'); await settle(); await checked('custom');
    await page.keyboard.press('ArrowRight'); await settle(); await checked('pv');
    await page.keyboard.press('ArrowRight'); await settle(); await checked('manual');
    assert.equal(posts.length, beforeKeys + 3);
    for (const code of [400, 403, 409]) {
      failure = code; const before = posts.length; await select('pv'); assert.equal(posts.length, before + 1);
      assert.match(await text(), code === 400 ? /Settings ergänzen: Phasenanzahl, Netzbezugsgrenze/ : code === 403 ? /nicht erlaubt/ : /Konflikt/);
      assert.doesNotMatch(await text(), /installation\.phases/);
      await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow'))); await settle(); assert.equal(posts.length, before + 1);
    }
    for (const kind of ['abort', 'oversize', 'duplicate']) {
      failure = kind; const before = posts.length; await select('pv');
      assert.match(await text(), /Ausgang unbekannt|Aktivierungsausgang unbekannt/);
      await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow'))); await settle();
      await observe(reader); assert.match(await text(), /unbekannt/); assert.equal(posts.length, before + 1);
    }
    failure = null;
    // Support cached from an earlier observation cannot replace the fresh inspection.
    reader = null; const beforeLegacy = posts.length; await select('pv');
    assert.equal(posts.length, beforeLegacy); await checked('manual');
    assert.equal(await page.locator('#control-mode-pv').isDisabled(), true);
    reader = auto(); await observe(reader);
    // A wall-clock jump between user action and read completion cannot POST.
    const beforeClock = posts.length;
    await page.evaluate(() => { window.realNow = Date.now; Date.now = () => realNow() - 60000; });
    await select('pv'); assert.equal(posts.length, beforeClock);
    await page.evaluate(() => { Date.now = window.realNow; });
    await select('pv'); assert.equal(posts.length, beforeClock, 'Restoring the clock also invalidates that old request epoch');
    // A timed-out POST is ambiguous and never queued/retried in the background.
    let timeoutRelease, timeoutEnter;
    const timeoutEntered = new Promise(resolve => { timeoutEnter = resolve; });
    held = { promise: new Promise(resolve => { timeoutRelease = resolve; }), enter: timeoutEnter };
    await page.locator('#control-mode-pv').click(); await timeoutEntered; await settle();
    const afterTimeout = posts.length; assert.match(await text(), /unbekannt/);
    timeoutRelease();
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow'))); await settle();
    assert.equal(posts.length, afterTimeout); assert.match(await text(), /unbekannt/);
    // A later manual Stop is independent, cancels our local flow and changes guard.
    let release, enter;
    const entered = new Promise(resolve => { enter = resolve; });
    held = { promise: new Promise(resolve => { release = resolve; }), enter };
    const beforePending = posts.length; await page.locator('#control-mode-pv').click();
    await entered;
    assert.equal(await page.locator('#control-stop').isEnabled(), true);
    await page.evaluate(() => dispatchEvent(new CustomEvent('evse:wallbox-busy', { detail: { busy: true } })));
    reader = auto({ guard: H(32, 'e'), state: 'manual_override' }); await observe(reader);
    release(); await settle(); await checked('manual');
    assert.match(await text(), /unbekannt|keine Aktivierung gesendet/);
    await page.evaluate(() => dispatchEvent(new CustomEvent('evse:wallbox-busy', { detail: { busy: false } })));
    await settle(); assert.ok(posts.length <= beforePending + 1);
    // Foreground refresh is readonly, no control polling or queued activation.
    const beforeForeground = posts.length, beforeControl = controlCount, beforeGet = getCount;
    await page.evaluate(() => { dispatchEvent(new Event('pagehide')); dispatchEvent(new PageTransitionEvent('pageshow')); });
    await settle(); assert.equal(posts.length, beforeForeground); assert.equal(controlCount, beforeControl); assert.ok(getCount > beforeGet);
    // Clock correction cancels the current flow, but a later explicit fresh
    // selection must work without reviving/retrying the cancelled request.
    const beforeRecoveryClock = posts.length;
    await page.evaluate(() => { window.realModeNow = Date.now; Date.now = () => window.realModeNow() + 10000; });
    await select('pv'); assert.equal(posts.length, beforeRecoveryClock); assert.match(await text(), /Zeitfehler/);
    await select('pv'); assert.equal(posts.length, beforeRecoveryClock + 1);
    await page.evaluate(() => { Date.now = window.realModeNow; delete window.realModeNow; });
    assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
    assert.deepEqual(errors, []);
    await context.close();
    console.log('Charging mode simulated browser contracts passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
