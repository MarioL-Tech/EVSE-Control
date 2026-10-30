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
    let configMissing = false, hardwareUnknown = false, onlySix = false, getFailure = false, outcomeUnknown = false, partial = false, live = true;
    let postCount = 0, getCount = 0;
    let postMode = null, hangState = false, stateCharging = null, invalidCurrent = null, freshSeconds = 10;
    let stateResponses = 0, onStateHang = null;
    const payloads = [], errors = [];
    const envelope = () => ({ status: 'ok', csrf: 'fixture-csrf', inspection: inspection({
      installation_max_ma: configMissing ? null : onlySix ? 6000 : 13700, hardware_max_ma: hardwareUnknown ? null : 22000,
      effective_max_ma: configMissing || hardwareUnknown ? null : onlySix ? 6000 : 13700 }), command: null, command_sent: false });
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
      const mode = postMode || { responseCode: outcomeUnknown ? 504 : 200,
        status: outcomeUnknown ? 'outcome_unknown' : 'ok', commandSent: true };
      await pause(250); // Exposes duplicate-click races while a response is pending.
      return route.fulfill({ status: mode.responseCode, json: { ...envelope(),
        ...(mode.commandSent ? {} : { csrf: null, inspection: null }), status: mode.status,
        command_sent: mode.commandSent,
        command: !mode.commandSent || mode.status === 'outcome_unknown' ? null : inspection({ operation: body.operation, write: partial ? null : ack,
          preparation: body.operation === 'start' ? ack : null }) } });
    });
    await context.route('**/api/state', async route => {
      if (hangState) {
        if (onStateHang) { onStateHang(); onStateHang = null; }
        // No API response reaches the page. Bound fixture cleanup even if the
        // application never aborts the request itself.
        await pause(5500);
        await route.abort().catch(() => {});
        return;
      }
      stateResponses++;
      return route.fulfill({ json: {
      schema_version: 1, read_only: true, status: live ? 'live' : 'offline', reason: 'Simulierte Messwerte',
      broker_connected: live, availability: live ? 'online' : 'offline', timestamp: new Date().toISOString(),
      last_success_at: new Date().toISOString(), age_seconds: 0, fresh_for_seconds: live ? freshSeconds : 0, error: null,
      values: live ? { active_power_w: 0, session_energy_wh: 0, current_limit_a: 6,
        current_a: invalidCurrent === 'array' ? null : invalidCurrent === 'member' ? [0, null, 0] : [0, 0, 0],
        voltage_v: [230, 231, 232], error_code: 0, socket_lock_state: 257, charging_state_raw: 34048,
        charging_state: 5, plugged_in: true, charging: stateCharging, below_commanded_current: false } : null
    } });
    });
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
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(String(error)));
    const untilText = (id, pattern, timeout = 10000) => page.waitForFunction(({ id, source }) => new RegExp(source).test(document.getElementById(id)?.textContent || ''), { id, source: pattern.source }, { timeout });
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
    for (const [width, colorScheme] of [[1440, 'dark'], [390, 'light']]) {
      await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ colorScheme });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(artifacts, `wallbox-overview-${width}-${colorScheme}.png`), fullPage: true, animations: 'disabled' });
    }
    assert.equal(postCount, 0, 'Overview screenshot/layout changes never send commands');
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
    assert.equal(new URL(page.url()).pathname, '/', 'Old Wallbox URL redirects to the only overview');
    assert.equal(await page.locator('h1').textContent(), 'Übersicht');
    assert.equal(await page.locator('a[href="/wallbox"]').count(), 0, 'No duplicate navigation or details link');
    for (const [width, colorScheme] of [[1440, 'dark'], [390, 'light'], [320, 'light'], [320, 'dark']]) {
      await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ colorScheme });
      assert.equal(await page.locator('.brand img').count(), 1);
      assert.equal(await page.locator('nav .nav-link[aria-current="page"]').count(), 1);
      assert.deepEqual(await page.locator('nav .nav-link').allTextContents(), ['Übersicht', 'Diagramme', 'Settings']);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(artifacts, `overview-control-${width}-${colorScheme}.png`), fullPage: true, animations: 'disabled' });
    }
    configMissing = true; await refresh(); await ready();
    assert(await page.locator('#control-start').isDisabled()); assert(await page.locator('#control-apply').isDisabled());
    assert(!await range.isDisabled(), 'Missing cap must not disable local editing');
    await untilText('control-hint', /WALLBOX_INSTALLATION_MAX_MA.*neu erstellen/);
    await range.focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight');
    assert.equal(await range.inputValue(), '7');
    await untilText('control-draft', /7 A · Entwurf/);
    // A real pointer gesture, not just a synthetic input event, must move it.
    await range.evaluate(el => el.scrollIntoView({ block: 'center' }));
    const slider = await range.boundingBox();
    await page.mouse.move(slider.x + 5, slider.y + slider.height / 2);
    await page.mouse.down();
    await page.mouse.move(slider.x + slider.width * .5, slider.y + slider.height / 2, { steps: 8 });
    await page.mouse.up();
    assert(Number(await range.inputValue()) > 7, 'Pointer gesture edits an unapproved local draft');
    const localDraft = await range.inputValue();
    await refresh(); await ready();
    assert.equal(await range.inputValue(), localDraft, 'Metadata refresh preserves valid local draft');
    await page.locator('#control-apply').evaluate(el => el.click());
    await page.locator('#control-start').evaluate(el => el.click());
    await pause(150); assert.equal(postCount, 3, 'Local draft and disabled actions cannot dispatch');
    await page.screenshot({ path: path.join(artifacts, 'overview-control-missing-cap-320.png'), fullPage: true, animations: 'disabled' });
    await page.locator('#control-stop').click(); await untilText('control-write', /Protokoll-ACK/); await ready();
    assert.equal(postCount, 4, 'Stop needs no installation maximum');
    configMissing = false; onlySix = true; await refresh(); await ready();
    assert.equal(await range.getAttribute('max'), '6');
    assert.equal(await range.inputValue(), '6');
    await untilText('control-hint', /nur 6 A.*Kein verstellbarer Bereich/);
    assert(!await page.locator('#control-apply').isDisabled(), 'Verified 6 A is valid, just not an adjustable range');
    assert.equal(postCount, 4, 'Tighter verified limit only changes draft');
    onlySix = false; hardwareUnknown = true; await refresh();
    assert(await page.locator('#control-start').isDisabled()); assert(!await page.locator('#control-stop').isDisabled());
    assert(!await range.isDisabled()); assert.equal(await range.getAttribute('max'), '32');
    await range.focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight');
    await untilText('control-draft', /7 A · Entwurf/);
    await pause(100); assert.equal(postCount, 4, 'Unknown hardware draft never dispatches');
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
    assert(!await range.isDisabled(), 'Failed inspection still allows local draft, never a write');
    await range.focus(); await page.keyboard.press('ArrowRight');
    assert.equal(postCount, 5);
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
    // Non-2xx HTTP responses carry meaningful command_sent evidence. These
    // are UI fixtures, not coverage of the real PHP/MQTT/serial transport.
    for (const mode of [
      { responseCode: 403, status: 'forbidden', commandSent: false },
      { responseCode: 400, status: 'invalid', commandSent: false },
      { responseCode: 503, status: 'unavailable', commandSent: false },
      { responseCode: 504, status: 'outcome_unknown', commandSent: true }
    ]) {
      postMode = mode;
      const beforePost = postCount;
      await page.locator('#control-stop').click();
      await untilText('control-result', mode.commandSent ? /Ausgang unbekannt.*nicht automatisch wiederholt/ : /Kein Schreibauftrag versendet/);
      await ready();
      const result = await page.locator('#control-result').textContent();
      if (mode.commandSent) {
        assert.doesNotMatch(result, /Kein Schreibauftrag versendet/, `HTTP ${mode.responseCode}`);
        await untilText('control-ack', /Ausgang unbekannt/);
      } else {
        assert.doesNotMatch(result, /Ausgang unbekannt/, `HTTP ${mode.responseCode}`);
        await untilText('control-ack', /Kein Auftrag versendet/);
      }
      await pause(350);
      assert.equal(postCount, beforePost + 1, `HTTP ${mode.responseCode}: no automatic POST retry`);
      await refresh(); await ready();
      assert.equal(postCount, beforePost + 1, `HTTP ${mode.responseCode}: pageshow only refreshes GET`);
      assert.equal(await page.locator('#control-result').textContent(), result, 'Inspection preserves command evidence');
    }
    postMode = null;
    const beforeFreshness = postCount;
    live = true; stateCharging = true; freshSeconds = 2;
    await page.reload(); await ready();
    await untilText('control-actual', /Lädt: Ja/);
    const hung = new Promise(resolve => { onStateHang = resolve; });
    hangState = true;
    await Promise.race([hung, pause(2500).then(() => { throw new Error('State poll did not enter bounded hanging fixture'); })]);
    const fulfilledBeforeExpiry = stateResponses;
    await untilText('control-actual', /Unbekannt – keine frischen Livewerte/, 3500);
    await untilText('status', /Daten veraltet/, 500);
    assert.equal(stateResponses, fulfilledBeforeExpiry, 'Actual view expires without a new API response');
    assert.doesNotMatch(await page.locator('#control-actual').textContent(), /Lädt: Ja|\b0 A\b/);
    assert.equal(await page.locator('#current-0').textContent(), '—');
    assert.equal(postCount, beforeFreshness, 'Freshness expiry/hanging telemetry never creates a POST');
    hangState = false; freshSeconds = 10;
    for (const invalid of ['array', 'member']) {
      invalidCurrent = null;
      await page.reload(); await ready();
      await untilText('control-actual', /Lädt: Ja/);
      invalidCurrent = invalid;
      await untilText('status', /Ungültige Daten/);
      await untilText('control-actual', /Unbekannt – keine frischen Livewerte/);
      assert.doesNotMatch(await page.locator('#control-actual').textContent(), /Lädt: Ja|\b0 A\b/,
        `Null current ${invalid} must not become zero or preserve charging`);
      for (const id of ['current-0', 'current-1', 'current-2', 'voltage-0', 'limit', 'power']) {
        assert.equal(await page.locator(`#${id}`).textContent(), '—', `Null ${invalid} invalidates whole validated view: ${id}`);
      }
      assert.equal(await page.locator('#charging').textContent(), 'Unbekannt');
      assert.equal(postCount, beforeFreshness, 'Invalid telemetry/reloads never replay commands');
    }
    invalidCurrent = null; stateCharging = null;
    for (const target of ['/diagramme', '/einstellungen']) {
      await page.goto(new URL(target, base).href);
      assert.equal(await page.locator('nav .nav-link').count(), 3);
      assert.equal(await page.locator('nav .nav-link[aria-current="page"]').count(), 1);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    assert.deepEqual(errors, []);
    await context.close();
    console.log('Wallbox mocked browser checks passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
