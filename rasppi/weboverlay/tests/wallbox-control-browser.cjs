'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.TEST_URL || process.env.WEB_TEST_URL || 'http://127.0.0.1:8080';
const artifacts = process.env.ARTIFACT_DIR || '/artifacts';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const inspection = (extra = {}) => ({ schema_version: 1, status: 'ok', minimum_ma: 6000, software_max_ma: 32000,
  hardware_max_ma: 22000, installation_max_ma: 13700, effective_max_ma: 13700, firmware_raw: 123,
  write: null, preparation: null, ...extra });
const ack = { status: 'acknowledged', attempted: true, acknowledged: true };
(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    let configMissing = false, hardwareUnknown = false, getFailure = false, outcomeUnknown = false, partial = false, live = true;
    let postCount = 0, getCount = 0;
    const payloads = [], errors = [];
    const envelope = () => ({ status: 'ok', csrf: 'fixture-csrf', inspection: inspection({
      installation_max_ma: configMissing ? null : 13700, hardware_max_ma: hardwareUnknown ? null : 22000,
      effective_max_ma: configMissing || hardwareUnknown ? null : 13700 }), command: null, command_sent: false });
    await context.route('**/api/wallbox-control', async route => {
      if (route.request().method() === 'GET') {
        getCount++;
        if (getFailure) return route.abort();
        return route.fulfill({ json: envelope() });
      }
      assert.equal(route.request().method(), 'POST');
      assert.equal(route.request().headers()['x-csrf-token'], 'fixture-csrf');
      const body = route.request().postDataJSON();
      assert.deepEqual(Object.keys(body).sort(), ['current_ma', 'operation']);
      payloads.push(body); postCount++;
      await pause(250); // Exposes duplicate-click races while a response is pending.
      return route.fulfill({ json: { ...envelope(), status: outcomeUnknown ? 'outcome_unknown' : 'ok', command_sent: true,
        command: outcomeUnknown ? null : inspection({ operation: body.operation, write: partial ? null : ack,
          preparation: body.operation === 'start' ? ack : null }) } });
    });
    await context.route('**/api/state', route => route.fulfill({ json: {
      schema_version: 1, read_only: true, status: live ? 'live' : 'offline', reason: 'Simulierte Messwerte',
      broker_connected: live, availability: live ? 'online' : 'offline', timestamp: new Date().toISOString(),
      last_success_at: new Date().toISOString(), age_seconds: 0, fresh_for_seconds: live ? 10 : 0, error: null,
      values: live ? { active_power_w: 0, session_energy_wh: 0, current_limit_a: 6, current_a: [0, 0, 0],
        voltage_v: [230, 231, 232], error_code: 0, socket_lock_state: 257, charging_state_raw: 34048,
        charging_state: 5, plugged_in: true, charging: null, below_commanded_current: false } : null
    } }));
    await context.route('**/api/smartmeter', route => route.fulfill({ json: { schema_version: 1, read_only: true,
      status: 'disabled', reason: 'Test deaktiviert', power_w: null, fetched_at: null, age_seconds: null, fresh_for_seconds: 0 } }));
    // No archive/database or hardware is exercised by these fixtures.
    await context.route('**/api/history?**', route => route.fulfill({ json: { schema_version: 1, read_only: true,
      status: 'disabled', samples: [], complete: false, minutes: 15, generated_at: new Date().toISOString(),
      range: { from: new Date(Date.now() - 900000).toISOString(), to: new Date().toISOString() } } }));
    await context.route('**/api/house-history?**', route => route.fulfill({ json: { schema_version: 1, read_only: true,
      status: 'disabled', samples: [], complete: false, minutes: 15, generated_at: new Date().toISOString(),
      range: { from: new Date(Date.now() - 900000).toISOString(), to: new Date().toISOString() } } }));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(String(error)));
    const untilText = (id, pattern) => page.waitForFunction(({ id, source }) => new RegExp(source).test(document.getElementById(id)?.textContent || ''), { id, source: pattern.source });
    const ready = () => page.waitForFunction(() => !document.getElementById('control-stop').disabled);
    const refresh = async () => {
      const previous = getCount;
      await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
      await page.waitForFunction(() => document.getElementById('control-status')?.textContent.includes('geprüft'));
      assert(getCount > previous);
    };
    await page.goto(base); await ready();
    assert.equal(await page.locator('.overview .summary-card').count(), 4);
    assert(await page.locator('.overview').evaluate(el => el.nextElementSibling.id === 'wallbox-control'));
    assert.equal(await page.locator('.page-header .readonly').count(), 0);
    assert.equal(await page.locator('main > section.current-data').evaluate(el => el.nextElementSibling.tagName), 'NOSCRIPT');
    await untilText('control-actual', /Limit 6 A.*Lädt: Unbekannt/);
    await page.evaluate(() => {
      window.controlMutations = 0;
      new MutationObserver(records => { window.controlMutations += records.length; })
        .observe(document.getElementById('control-actual'), { subtree: true, childList: true, characterData: true });
    });
    await pause(350); assert.equal(await page.evaluate(() => window.controlMutations), 0, 'Unchanged 100ms view ticks do not mutate control text');
    assert.equal(await page.locator('#limit').textContent(), '6,0 A');
    const range = page.locator('#control-current');
    assert.equal(await range.getAttribute('max'), '13');
    await range.focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await range.inputValue(), '7');
    assert.equal(await page.locator('#control-draft').textContent(), '7 A');
    await range.evaluate(el => { el.value = '10'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await pause(150); assert.equal(postCount, 0, 'Keyboard and slider change only draft');
    await page.locator('#control-apply').evaluate(el => { el.click(); el.click(); });
    await untilText('control-write', /Protokoll-ACK/); await ready();
    assert.equal(postCount, 1); assert.deepEqual(payloads[0], { operation: 'set_current', current_ma: 10000 });
    assert.equal(await page.locator('#limit').textContent(), '6,0 A', 'ACK never overwrites actual telemetry');
    partial = true;
    await page.locator('#control-start').click(); await untilText('control-result', /Start: Nicht gesendet/); await ready();
    assert.equal(postCount, 2); assert.deepEqual(payloads[1], { operation: 'start', current_ma: 10000 });
    await untilText('control-preparation', /Protokoll-ACK/);
    partial = false;
    await page.locator('#control-stop').click(); await untilText('control-requested', /^Stop$/); await untilText('control-write', /Protokoll-ACK/); await ready();
    assert.equal(postCount, 3); assert.deepEqual(payloads[2], { operation: 'stop', current_ma: 0 });
    assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => /wallbox|command|control-request/.test(key))), false);
    await page.goto(new URL('/wallbox', base).href); await ready();
    assert.equal(postCount, 3, 'Navigation never replays');
    for (const [width, colorScheme] of [[1440, 'dark'], [390, 'light'], [320, 'light']]) {
      await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ colorScheme });
      assert.equal(await page.locator('.brand img').count(), 1);
      assert.equal(await page.locator('nav .nav-link[aria-current="page"]').count(), 1);
      assert.deepEqual(await page.locator('nav .nav-link').allTextContents(), ['Übersicht', 'Wallbox', 'Diagramme', 'Settings']);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(artifacts, `wallbox-${width}-${colorScheme}.png`), fullPage: true, animations: 'disabled' });
    }
    configMissing = true; await refresh(); await ready();
    assert(await page.locator('#control-start').isDisabled()); assert(await page.locator('#control-apply').isDisabled());
    await untilText('control-hint', /WALLBOX_INSTALLATION_MAX_MA.*neu erstellen/);
    await page.locator('#control-stop').click(); await untilText('control-write', /Protokoll-ACK/); await ready();
    assert.equal(postCount, 4, 'Stop needs no installation maximum');
    configMissing = false; hardwareUnknown = true; await refresh();
    assert(await page.locator('#control-start').isDisabled()); assert(!await page.locator('#control-stop').isDisabled());
    hardwareUnknown = false; live = false; await refresh(); await untilText('control-actual', /Unbekannt – keine frischen Livewerte/);
    assert.equal(await page.locator('#current-0').textContent(), '—');
    outcomeUnknown = true;
    await page.locator('#control-start').click(); await untilText('control-result', /Ausgang unbekannt.*nicht automatisch wiederholt/); await ready();
    assert.equal(postCount, 5);
    getFailure = true;
    const retained = await page.locator('#control-result').textContent();
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await untilText('control-status', /fehlgeschlagen/);
    assert.equal(await page.locator('#control-result').textContent(), retained, 'GET failure retains last command outcome');
    assert(await page.locator('#control-stop').isDisabled());
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const before = getCount; await pause(100); assert.equal(getCount, before);
    getFailure = false;
    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    await ready(); assert.equal(postCount, 5, 'Visibility/pageshow never repeat a command');
    await page.reload(); await ready(); assert.equal(postCount, 5, 'Reload never replays');
    await page.locator('#control-start').click();
    await page.waitForFunction(() => document.getElementById('control-start').disabled);
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await untilText('control-result', /Ausgang unbekannt.*nicht automatisch wiederholt/);
    await pause(350);
    const afterAbort = postCount;
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await ready(); assert.equal(postCount, afterAbort, 'Aborted POST is never replayed');
    for (const target of ['/diagramme', '/einstellungen']) {
      await page.goto(new URL(target, base).href);
      assert.equal(await page.locator('nav .nav-link').count(), 4);
      assert.equal(await page.locator('nav .nav-link[aria-current="page"]').count(), 1);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    assert.deepEqual(errors, []);
    await context.close();
    console.log('Wallbox mocked browser checks passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
