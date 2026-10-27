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
    const errors = [], requests = [];
    let mode = 'positive', count = 0;
    await context.route('**/api/state', route => route.fulfill({ json: {
      schema_version: 1, read_only: true, status: 'offline', reason: 'MQTT nicht verbunden.',
      broker_connected: false, availability: null, timestamp: null, last_success_at: null,
      age_seconds: null, fresh_for_seconds: 0, values: null, error: null
    } }));
    await context.route('**/api/smartmeter', async route => {
      count++;
      if (mode === 'hung') { await pause(3500); await route.abort().catch(() => {}); return; }
      if (mode === 'missing') { await route.fulfill({ json: {} }); return; }
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
    const text = (id, value) => page.waitForFunction(({ id, value }) =>
      document.getElementById(id)?.textContent === value, { id, value });
    await text('grid-power', '+1,55 kW'); await text('grid-direction', 'Netzbezug');
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
          path: path.join(artifacts, `HOUSE-${width}-${scheme}.png`), fullPage: true });
      }
    }
    await page.goto(new URL('/diagramme', base).href);
    const before = count;
    await pause(1200); assert.equal(count, before, 'No house polling without dashboard article');
    assert.deepEqual(errors, [], 'JavaScript/console/CSP errors');
    for (const request of requests) {
      assert.equal(request.method, 'GET', 'Read-only requests');
      assert.equal(new URL(request.url).origin, new URL(base).origin, 'Same-origin resources only');
    }
    await context.close();
    console.log('Smartmeter browser checks passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
