'use strict';
// E2 evidence, served HTML/CSS/JS from the integrated runtime image. All API
// traffic is intercepted; this suite cannot issue hardware/production writes.
// Run each profile in a separately built CI job, not as a retry/shared context.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { FIELDS } = require('../static/newcalendar.js');
const pass = process.env.GUI_EVIDENCE_PASS || '1';
assert(['1', '2'].includes(pass), 'GUI_EVIDENCE_PASS must be 1 or 2');
const negative = pass === '2';
const base = process.env.WEB_TEST_URL || 'http://127.0.0.1:8080';
const root = path.join(process.env.ARTIFACT_DIR || '/artifacts', `gui-e2-pass-${pass}`);
const iso = n => new Date(n).toISOString();
const pages = [['overview', '/', 'Übersicht'], ['diagrams', '/diagramme', 'Diagramme'],
  ['diagnostics', '/diagnose', 'Diagnose'], ['settings', '/einstellungen', 'Settings']];
const unavailable = { status: 'unavailable', csrf: null, inspection: null, command: null, command_sent: false };
const values = { error_code: 0, socket_lock_state: 273, charging_state_raw: 33024, charging_state: 1,
  below_commanded_current: false, plugged_in: true, charging: false, current_limit_a: 6,
  current_a: [0, 0, 0], voltage_v: [230, 231, 232], active_power_w: 0, session_energy_wh: 0 };
const config = () => {
  const limits = { max_import_w: null, max_current_ma: null, adjust_seconds: null, pause_seconds: null, resume_seconds: null };
  return { schema_version: 1, timezone: 'Europe/Vienna', manual: { current_ma: null }, pv: { ...limits },
    installation: { phases: null, meter_includes_wallbox: null },
    custom: { ...limits, use_schedule: null, pv_enabled: null, weekdays: [], windows: [], outside_window: null } };
};
function inspection() {
  return { schema_version: 1, status: 'ok', minimum_ma: 6000, software_max_ma: 32000,
    id: 'a'.repeat(32), session: 'b'.repeat(32), lease: 'c'.repeat(32), operation: 'inspect',
    reason: 'read_only_inspection', fresh_for_seconds: 8, read_only: true, hardware_max_ma: 16000,
    installation_max_ma: negative ? null : 16000, effective_max_ma: negative ? null : 16000,
    firmware_raw: 123, write: null, preparation: null,
    automation: { schema_version: 1, guard: 'd'.repeat(32), requested_mode: 'manual', activation_id: null,
      config_revision: null, state: 'manual', plan: 'disabled', house: 'disabled' } };
}
function archive(query, house, failure) {
  const now = Date.now(), from = now - 900000;
  const common = { schema_version: 1, read_only: true, status: failure ? 'unavailable' : 'ok',
    reason: failure ? 'Simulierter Archivausfall' : 'Simuliertes Archiv', generated_at: iso(now), minutes: 15,
    range: { from: iso(from), to: iso(now) }, complete: !failure,
    samples: negative ? [] : [8000, 6000, 4000, 2000].map((ago, i) => ({ id: String(i + 1),
      timestamp: iso(now - ago), received_at: iso(now - ago), status: 'ok', break_before: i === 0,
      ...(house ? { power_w: -500 + i * 200 } : { values: { ...values, active_power_w: 1200 + i * 300 } }) })) };
  if (!query.has('period')) return common;
  // Fixed completed UTC hour: independent of CI timezone, DST and wall clock.
  const start = Date.parse('2024-01-02T11:00:00Z');
  const stats = (value, mean = true) => ({ count: 30, nulls: 0, mean: mean ? value : null,
    min: Number(value), max: Number(value), last: value, mixed: false });
  return { schema_version: 2, read_only: true, status: failure ? 'unavailable' : 'ok', reason: common.reason,
    generated_at: iso(now), range: { from: iso(start), to: iso(start + 3600000), timezone: query.get('tz') },
    selection: { period: 'hour', date: query.get('date'), timezone: query.get('tz') },
    navigation: { previous: null, next: null, now: null }, aggregation: 'sample_mean', complete: !failure,
    progress: { samples_done: !failure, events_done: !failure },
    buckets: failure ? [] : Array.from({ length: 60 }, (_, i) => ({ from: iso(start + i * 60000),
      to: iso(start + (i + 1) * 60000), samples: 30, has_gap: i === 30, complete: true, coverage_seconds: 58,
      metrics: house ? { power_w: stats((i % 10 - 5) * 100) } : Object.fromEntries(FIELDS.map((field, j) =>
        [field, stats(j >= 9 && j <= 11 ? false : j >= 6 && j <= 8 ? 230 + Math.sin(i / 5) : j === 0 ? 1200 + i * 10 : j === 2 ? 6 : 0,
          j === 0 || j >= 3 && j <= 8)])) })) };
}
async function fixture(context) {
  const observed = { posts: [], archives: [], unexpected: [] };
  await context.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), endpoint = url.pathname;
    const post = req.method() === 'POST';
    if (post) observed.posts.push(endpoint); // Never record request bodies/UIDs.
    const send = (json, status = 200) => route.fulfill({ json, status });
    if (endpoint === '/api/wallbox-control') {
      const envelope = { status: 'ok', csrf: 'fixture-only', inspection: inspection(), command: null, command_sent: false };
      if (!post) return send(envelope);
      assert.equal(req.postDataJSON().operation, 'stop', 'Only deliberate synthetic Stop permitted');
      return send(negative ? { ...envelope, status: 'outcome_unknown', command_sent: true } : {
        ...envelope, command_sent: true, command: { ...inspection(), operation: 'stop',
          write: { status: 'acknowledged', attempted: true, acknowledged: true } } }, negative ? 504 : 200);
    }
    if (endpoint === '/api/charging-settings') {
      if (post) return negative ? route.abort('failed') : send({ schema_version: 1, status: 'conflict', automation_available: false }, 409);
      return send({ schema_version: 1, status: 'ok', csrf: 'c'.repeat(64), revision: null, config: config(), automation_available: false });
    }
    if (req.method() !== 'GET') {
      observed.unexpected.push(`${req.method()} ${endpoint}`); return route.abort('blockedbyclient');
    }
    if (endpoint === '/api/state') return send({ schema_version: 1, read_only: true,
      status: negative ? 'offline' : 'live', reason: negative ? 'Simulierter Brokerausfall' : 'Simulierte Messwerte',
      broker_connected: !negative, availability: negative ? 'offline' : 'online', timestamp: negative ? null : iso(Date.now()),
      last_success_at: negative ? null : iso(Date.now()), age_seconds: negative ? null : 0,
      fresh_for_seconds: negative ? 0 : 10, error: null, values: negative ? null : values });
    if (endpoint === '/api/smartmeter') return send({ schema_version: 1, read_only: true, status: negative ? 'offline' : 'live',
      reason: 'Simulierter Hauszähler', power_w: negative ? null : -420, fetched_at: negative ? null : iso(Date.now()),
      age_seconds: negative ? null : 0, fresh_for_seconds: negative ? 0 : 10 });
    if (['/api/history', '/api/house-history'].includes(endpoint)) {
      observed.archives.push(`${endpoint}${url.search}`);
      const failure = negative && url.searchParams.has('period');
      return send(archive(url.searchParams, endpoint === '/api/house-history', failure), failure ? 503 : 200);
    }
    if (endpoint === '/api/charging-mode') return send({ schema_version: 1, status: 'disabled', csrf: null,
      automation_available: true, semantics: 'activation_requested' });
    if (endpoint === '/api/esp32-control') return send(unavailable);
    if (endpoint === '/api/settings-env') {
      const service = url.searchParams.get('service');
      return send({ status: 'ok', csrf: 'fixture-only', services: { uart: {}, wallbox: {}, storage: {},
        weboverlay: { WEB_PORT: { type: 'integer', min: 1, max: 65535, secret: false, readonly: false, choices: [] } } },
        snapshot: { service, status: 'missing', revision: null, entries: service === 'weboverlay' ? {
          WEB_PORT: { present: false, configured: false, readonly: false, secret: false, value: null } } : {} } });
    }
    observed.unexpected.push(`${req.method()} ${endpoint}`);
    return route.abort('blockedbyclient');
  });
  return observed;
}
async function layout(page) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal document overflow');
  assert.equal(await page.locator('nav[aria-label="Hauptnavigation"] a').count(), 4);
  assert.equal(await page.locator('nav [aria-current="page"]').count(), 1);
}
async function focus(page, selector, touch) {
  const target = page.locator(selector);
  await target.scrollIntoViewIfNeeded();
  if (touch) await target.tap();
  // A real Tab movement, not merely DOM focus, gives :focus-visible styling.
  await target.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
  assert(await target.evaluate(el => el === document.activeElement), `Keyboard focus ${selector}`);
  assert(await target.evaluate(el => el.matches(':focus-visible')), `Visible keyboard focus ${selector}`);
}
async function interactions(page, name, observed, shot, touch) {
  if (name === 'overview') {
    await page.waitForFunction(() => !document.getElementById('control-stop').disabled);
    assert.equal(await page.locator('#control-start').isDisabled(), negative);
    await page.locator('#control-current').focus(); await page.keyboard.press('ArrowRight');
    assert.deepEqual(observed.posts, [], 'Slider is a draft, not a write');
    await focus(page, '#control-stop', false); await shot('focus-stop', false);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /ACK|unbekannt/.test(document.getElementById('control-result').textContent));
    assert.deepEqual(observed.posts, ['/api/wallbox-control']);
    assert.match(await page.locator('#control-result').innerText(), negative ? /unklar|unbekannt/i : /bestätigt|ACK|quittiert/i);
    assert(await page.locator('#esp32-lock').isDisabled(), 'Independent unavailable ESP cannot block Stop');
    await shot(negative ? 'unknown-stop' : 'acknowledged-stop');
  } else if (name === 'settings') {
    await page.waitForFunction(() => !document.getElementById('charging-fields').disabled);
    await page.locator('details.charging-profile > summary').nth(1).click();
    const input = page.locator('#charging-pv-max_import_w');
    assert.equal(await input.inputValue(), ''); assert.match(await input.getAttribute('placeholder'), /^z\. B\./);
    await input.fill('-1');
    assert.equal(await input.getAttribute('aria-invalid'), 'true');
    await focus(page, '#charging-pv-max_import_w', false); await shot('focus-invalid-input', false);
    await shot('invalid-draft');
    await input.fill('250');
    assert.notEqual(await input.getAttribute('aria-invalid'), 'true');
    assert.deepEqual(observed.posts, [], 'Input editing cannot save/activate');
    await page.locator('#charging-save').click();
    await page.waitForFunction(() => /Zwischenzeitlich|Speicherstatus unklar/.test(document.getElementById('charging-status').textContent));
    assert.equal(await input.inputValue(), '250', 'Error retains draft');
    assert.deepEqual(observed.posts, ['/api/charging-settings']);
    await shot(negative ? 'unknown-save' : 'conflict-save');
    // UID help is exercised without ever entering or recording a UID.
    const trigger = page.locator('[data-setting-info="esp32-uid"] .setting-help > summary');
    if (touch) await trigger.tap(); else await trigger.hover();
    await page.locator('[data-setting-info="esp32-uid"] [role="tooltip"]').waitFor();
    await trigger.scrollIntoViewIfNeeded(); await shot('field-help', false);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('env-fields').disabled);
    await page.locator('#env-service').selectOption('weboverlay');
    const port = page.locator('#env-key-WEB_PORT');
    await port.waitFor({ state: 'attached' });
    await page.locator('.env-group > summary').click();
    assert.equal(await port.inputValue(), '');
    await port.fill('65536'); assert.equal(await port.getAttribute('aria-invalid'), 'true');
    await port.focus(); await shot('env-invalid-draft', false);
    await port.fill('8081'); assert.notEqual(await port.getAttribute('aria-invalid'), 'true');
    assert.deepEqual(observed.posts, ['/api/charging-settings'], '.env drafts cannot save or recreate a container');
  } else {
    const selector = name === 'diagrams' ? '#show-power' : '#show-charging';
    await focus(page, selector, touch); await shot('focus-preference', false);
    const selected = await page.locator(selector).isChecked(); await page.keyboard.press('Space');
    assert.equal(await page.locator(selector).isChecked(), !selected);
    await page.locator('#reset-display').click(); assert(await page.locator(selector).isChecked());
    await page.locator('[data-calendar-period="hour"]').click();
    const request = page.waitForResponse(r => new URL(r.url()).pathname === '/api/history' && new URL(r.url()).searchParams.get('date') === '2024-01-02T12:00');
    await page.locator('#calendar-date').fill('2024-01-02T12:00');
    await page.locator('#calendar-date').dispatchEvent('change'); await request;
    if (!negative) await page.waitForFunction(() => document.getElementById('history-source').dataset.historyStatus === 'ok' && document.querySelector('.chart-line'));
    else await page.waitForFunction(() => /nicht verfügbar|fehlgeschlagen|Fehler/i.test(document.querySelector('.history-state').textContent));
    await shot(negative ? 'archive-unavailable' : 'archive-populated');
    assert(observed.archives.some(url => url.includes('period=hour')), 'Real calendar request');
    assert.deepEqual(observed.posts, [], 'Charts/diagnosis never write');
    if (name === 'diagnostics') assert.equal(await page.locator('#wallbox-control, #esp32-control, #chart-house').count(), 0);
  }
}
(async () => {
  fs.mkdirSync(root, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const manifest = { schema_version: 1, pass, profile: negative ? 'offline-empty-error-touch-keyboard' : 'live-archive-input-keyboard',
    revision: process.env.GUI_EVIDENCE_REVISION || null,
    simulated: true, visual_review: 'NOT PERFORMED: parent must inspect images', cells: [] };
  const write = () => fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  try {
    for (const [name, route, title] of pages) for (const scheme of ['light', 'dark']) for (const device of ['desktop', 'mobile']) {
      const touch = device === 'mobile', width = touch ? (negative ? 320 : 390) : 1440;
      const cell = { page: name, route, scheme, device, viewport: { width, height: touch ? 844 : 1000 }, status: 'running', images: [] };
      manifest.cells.push(cell); write();
      const context = await browser.newContext({ viewport: cell.viewport, colorScheme: scheme, hasTouch: touch,
        isMobile: touch, locale: 'de-AT', timezoneId: 'Europe/Vienna', reducedMotion: 'reduce', serviceWorkers: 'block' });
      context.setDefaultTimeout(10000); context.setDefaultNavigationTimeout(15000);
      const errors = [], external = [], observed = await fixture(context);
      context.on('request', req => { if (new URL(req.url()).origin !== new URL(base).origin) external.push(req.url()); });
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      const shot = async (state, fullPage = true) => {
        await layout(page);
        const file = `${name}--${scheme}--${device}-${width}--${state}.png`;
        await page.screenshot({ path: path.join(root, file), fullPage, animations: 'disabled' });
        cell.images.push({ file, state, full_page: fullPage }); write();
      };
      try {
        assert.equal((await page.goto(new URL(route, base).href)).status(), 200);
        assert.equal(await page.locator('h1').innerText(), title);
        if (name !== 'settings') await page.waitForFunction(expected => document.getElementById('status').textContent === expected, negative ? 'Offline' : 'Live');
        else await page.waitForFunction(() => !document.getElementById('charging-fields').disabled);
        if (name === 'overview') await page.waitForFunction(() => !document.getElementById('control-stop').disabled);
        if (name === 'diagrams' && !negative) await page.waitForFunction(() => document.querySelector('#chart-grid .chart-line') && document.querySelector('#chart-house .chart-line'));
        await shot(negative ? 'offline-empty' : 'live-default');
        await interactions(page, name, observed, shot, touch);
        assert.deepEqual(errors, [], 'No page JavaScript errors');
        assert.deepEqual(external, [], 'No external resources'); assert.deepEqual(observed.unexpected, [], 'No unhandled API traffic');
        cell.status = 'passed'; cell.posts = observed.posts; cell.archive_requests = observed.archives.length;
      } catch (error) {
        cell.status = 'failed'; cell.error = error.message;
        await page.screenshot({ path: path.join(root, `${name}--${scheme}--${device}-${width}--FAILURE.png`), fullPage: true }).catch(() => {});
        throw error;
      } finally { write(); await context.close(); }
    }
    assert.equal(manifest.cells.length, 16);
    fs.writeFileSync(path.join(root, 'index.md'), `# E2 GUI pass ${pass}\n\nSynthetic API fixtures; real runtime HTML/CSS/JS. Not hardware or visual acceptance.\n\n` +
      manifest.cells.map(cell => `## ${cell.page} / ${cell.scheme} / ${cell.device}\n` +
        cell.images.map(image => `- [${image.state}](${image.file})`).join('\n')).join('\n\n') + '\n');
    console.log(`E2 pass ${pass}: 16 independent page/theme/device cells; see manifest.json and index.md; visual inspection still required.`);
  } finally { write(); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
