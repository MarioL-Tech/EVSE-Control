'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.TEST_URL || process.env.WEB_TEST_URL || 'http://127.0.0.1:8080';
const artifacts = process.env.ARTIFACT_DIR || '/artifacts';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function sample(power_w = 1549.4, overrides = {}) {
  return { schema_version: 1, read_only: true, status: 'live', reason: 'Aktuelle Netzaustauschleistung.',
    power_w, fetched_at: new Date().toISOString(), age_seconds: 0, fresh_for_seconds: 3, ...overrides };
}
(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    // Independent inspection fixture: never contact the ESP32 MQTT gateway.
    await context.route('**/api/esp32-control', route => {
      assert.equal(route.request().method(), 'GET', 'No ESP32 commands in this fixture');
      return route.fulfill({ json: { status: 'unavailable', csrf: null, inspection: null,
        command: null, command_sent: false } });
    });
    const errors = [], requests = [];
    await context.route('**/api/wallbox-control', route => route.fulfill({ json: {
      status: 'unavailable', csrf: null, inspection: null, command: null, command_sent: false
    } }));
    let mode = 'positive', count = 0, frozen = null;
    await context.route('**/api/house-history?**', route => {
      const now = Date.now(), query = new URL(route.request().url()).searchParams;
      if (query.has('period')) {
        const from = new Date(now).toISOString().slice(0, 10) + 'T00:00:00Z';
        return route.fulfill({ json: { schema_version: 2, read_only: true, status: 'disabled', reason: 'Nicht eingerichtet',
          generated_at: new Date(now).toISOString(), aggregation: 'sample_mean', complete: false,
          progress: { samples_done: false, events_done: false }, buckets: [],
          range: { from, to: new Date(Date.parse(from) + 86400000).toISOString(), timezone: 'Europe/Vienna' },
          selection: { period: query.get('period'), date: query.get('date') === 'now' ? from.slice(0, 10) : query.get('date'), timezone: 'Europe/Vienna' },
          navigation: { previous: null, next: null, now: null } } });
      }
      return route.fulfill({ json: {
      schema_version: 1, read_only: true, status: 'disabled', reason: 'Nicht eingerichtet',
      generated_at: new Date().toISOString(), minutes: 15,
      range: { from: new Date(now - 900000).toISOString(), to: new Date(now).toISOString() },
      complete: false, samples: []
    } }); });
    // No database or external sensor is used by this simulated browser scenario.
    await context.route('**/api/history?**', route => route.fulfill({ json: {
      schema_version: 1, read_only: true, status: 'disabled', reason: 'Test: kein Archiv',
      generated_at: new Date().toISOString(), minutes: 15,
      range: { from: new Date(Date.now() - 900000).toISOString(), to: new Date().toISOString() },
      complete: false, samples: []
    } }));
    await context.route('**/api/state', route => route.fulfill({ json: {
      schema_version: 1, read_only: true, status: 'offline', reason: 'MQTT nicht verbunden.',
      broker_connected: false, availability: null, timestamp: null, last_success_at: null,
      age_seconds: null, fresh_for_seconds: 0, values: null, error: null
    } }));
    await context.route('**/api/smartmeter', async route => {
      count++;
      if (mode === 'hung') { await pause(3500); await route.abort().catch(() => {}); return; }
      if (mode === 'missing') { await route.fulfill({ json: {} }); return; }
      if (mode === 'frozen') { await route.fulfill({ json: frozen }); return; }
      const data = mode === 'offline' ? sample(null, { status: 'offline', fresh_for_seconds: 0 })
        : mode === 'bad' ? sample(null, { reason: '<img src=x onerror=alert(1)>' })
          : mode === 'negative' ? sample(-799.4) : mode === 'zero' ? sample(0) : sample();
      await route.fulfill({ json: data });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', request => requests.push({ method: request.method(), url: request.url() }));
    await page.goto(base);
    assert.equal(await page.evaluate(() => typeof window.OverlayHouseChart?.observe), 'undefined',
      'Overview never mounts a house history collector');
    const text = (id, value) => page.waitForFunction(({ id, value }) =>
      document.getElementById(id)?.textContent === value, { id, value });
    await text('grid-power', '+1,55 kW'); await text('grid-direction', 'Netzbezug');
    assert(await page.locator('#grid-direction').evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 18),
      'Grid import/export direction is prominently readable, not a tiny subtitle');
    await text('status', 'Offline');
    assert.equal(await page.locator('.details-grid.measurements #smartmeter').count(), 1);
    assert.equal(await page.locator('.details-grid.measurements #voltage-0').count(), 1);
    assert(await page.locator('#smartmeter').isVisible(), 'House measurements remain visible with offline wallbox');
    assert.equal(await page.locator('.quick-controls').count(), 0);
    assert.equal(await page.locator('#grid-status').getAttribute('data-tone'), 'good');
    assert.match(await page.locator('#smartmeter').innerText(), /Letzter Abruf/);
    assert.match(await page.locator('#smartmeter').innerText(), /Abrufalter/);
    // No needless mutations of unchanged role-status text during countdown ticks.
    await page.evaluate(() => {
      window.houseMutations = 0;
      new MutationObserver(records => { window.houseMutations += records.length; })
        .observe(document.getElementById('grid-status'), { childList: true, characterData: true, subtree: true });
    });
    await pause(1100); assert.equal(await page.evaluate(() => window.houseMutations), 0);
    for (const [next, power, direction] of [['negative', '-0,80 kW', 'Einspeisung'], ['zero', '0,00 kW', 'Ausgeglichen']]) {
      mode = next; await text('grid-power', power); await text('grid-direction', direction);
      assert(await page.locator('#grid-direction').evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 18));
      await text('status', 'Offline');
    }
    for (const next of ['bad', 'missing', 'offline']) {
      mode = next; await text('grid-power', '—'); await text('grid-direction', 'Unbekannt');
      await text('grid-status', next === 'offline' ? 'Offline' : 'Lesefehler');
      assert(!((await page.locator('#grid-reason').innerText()).includes('<img')));
      assert.equal(await page.locator('#smartmeter img').count(), 0);
    }
    mode = 'positive'; await text('grid-status', 'Live');
    mode = 'hung';
    await page.waitForFunction(() => document.getElementById('grid-power').textContent === '—', null, { timeout: 3600 });
    await text('grid-direction', 'Unbekannt');
    mode = 'positive'; await text('grid-status', 'Live');
    // BFCache/pageshow reset discards previous values synchronously, even before a new response.
    mode = 'hung';
    assert.equal(await page.evaluate(() => {
      dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      return document.getElementById('grid-power').textContent;
    }), '—');
    mode = 'positive'; await text('grid-status', 'Live');
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const scheme of ['dark', 'light']) {
        await page.emulateMedia({ colorScheme: scheme });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth
          && document.body.scrollWidth <= innerWidth), `${width}/${scheme} overflow`);
        // Four representative captures; all eight combinations are checked above.
        if ((width === 320 || width === 1440)) await page.screenshot({
          path: path.join(artifacts, `HOUSE-${width}-${scheme}.png`), fullPage: true, animations: 'disabled' });
      }
    }
    await page.goto(new URL('/diagramme', base).href);
    await text('grid-status', 'Live');
    assert(await page.locator('#chart-house').isVisible());
    assert.equal(await page.locator('#show-house-power').count(), 1);
    const series = () => page.locator('#house-chart-svg [data-house-series]').getAttribute('d');
    const hasPoints = () => page.waitForFunction(() =>
      !!document.querySelector('#house-chart-svg [data-house-series]')?.getAttribute('d'));
    await hasPoints();
    for (const [next, power] of [['negative', '-0,80 kW'], ['zero', '0,00 kW']]) {
      mode = next; await text('grid-power', power); await text('status', 'Offline');
    }
    assert((await series()).includes('L'), 'House connects real successive live fetches despite offline MQTT');
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      const zero = page.locator('#house-chart-svg [data-house-zero]');
      assert.equal(await zero.count(), 1);
      assert.equal(await zero.getAttribute('y1'), await zero.getAttribute('y2'));
      assert.equal(await zero.getAttribute('stroke-dasharray'), '4 5');
      assert.equal(await zero.getAttribute('stroke-opacity'), '.55');
      assert.equal(await zero.getAttribute('stroke-width'), '1');
      assert.equal(await page.locator('#house-chart-svg [data-house-zero-label]').textContent(), '0');
      const y = Number(await zero.getAttribute('y1'));
      assert(Number.isFinite(y) && y >= 24 && y <= 212, 'Zero reference stays inside the signed plot');
    }
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.locator('#smartmeter').screenshot({ path: path.join(artifacts, 'house-chart-dark-mobile.png') });
    mode = 'offline'; await text('grid-status', 'Offline');
    mode = 'positive'; await text('grid-status', 'Live');
    assert((await series()).split('M').length >= 3, 'Offline creates a retained gap');
    // Fixed fetch timestamp is deduped, then expires even with successful HTTP responses.
    frozen = sample(0); mode = 'frozen'; await text('grid-power', '0,00 kW');
    await pause(100); // Allow the single scheduled SVG frame to finish.
    const pointCount = await page.locator('#house-chart-svg [data-house-series]').getAttribute('d');
    await pause(1100);
    assert.equal(await series(), pointCount, 'Duplicate fetch is not a measurement or a redraw');
    await text('grid-status', 'Veraltet');
    mode = 'negative'; await text('grid-status', 'Live');
    assert((await series()).split('M').length >= 4, 'Stale recovery does not bridge');
    await page.locator('#show-house-power').uncheck();
    assert(await page.locator('#chart-house').isVisible(), 'Control container remains recoverable');
    assert(!await page.locator('#house-chart-svg').isVisible());
    await page.locator('#show-house-power').check(); assert(await page.locator('#house-chart-svg').isVisible());
    await page.selectOption('#chart-range', '1');
    assert.equal(await page.locator('#chart-range').inputValue(), '1');
    await page.locator('[data-calendar-period="day"]').click();
    assert(!await page.locator('#house-chart-svg').isVisible());
    await page.waitForFunction(() => document.getElementById('house-chart-description')?.textContent === 'Hausarchiv ist deaktiviert.');
    assert.match(await page.locator('#house-chart-description').innerText(), /Hausarchiv ist deaktiviert/);
    mode = 'zero'; await text('grid-power', '0,00 kW');
    await page.locator('[data-calendar-period="live"]').click(); await hasPoints();
    // Visibility transitions break edges, pause polling, and discard stale replies.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await text('grid-power', '—');
    const before = count; await pause(1200); assert.equal(count, before, 'No hidden polling');
    await page.evaluate(() => {
      delete document.hidden; document.dispatchEvent(new Event('visibilitychange'));
    });
    await text('grid-status', 'Live');
    mode = 'hung';
    assert.equal(await page.evaluate(() => {
      dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      return document.getElementById('grid-power').textContent;
    }), '—');
    mode = 'positive'; await text('grid-status', 'Live');
    assert((await series()).startsWith('M'), 'Pageshow starts a separate segment');
    assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => /house/.test(key))), false,
      'House measurements/preferences are page-local');
    assert.deepEqual(errors, [], 'JavaScript/console/CSP errors');
    for (const request of requests) {
      assert.equal(request.method, 'GET', 'Read-only requests');
      assert.equal(new URL(request.url).origin, new URL(base).origin, 'Same-origin resources only');
    }
    await context.close();
    console.log('Smartmeter browser checks passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
