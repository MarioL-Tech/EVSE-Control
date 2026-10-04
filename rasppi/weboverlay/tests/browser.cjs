'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, colorScheme: 'dark' });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const stamp = new Date().toISOString();
  let data = { schema_version: 1, read_only: true, status: 'live', reason: 'Aktuelle Wallbox-Messdaten',
    broker_connected: true, availability: 'online', timestamp: stamp, last_success_at: stamp,
    age_seconds: 1, fresh_for_seconds: 8, error: null,
    values: { error_code: 0, socket_lock_state: 273, charging_state_raw: 33024, charging_state: 1,
      below_commanded_current: true, plugged_in: true, charging: false, current_limit_a: 6,
      current_a: [0, 0, 0], voltage_v: [235.7, 233.4, 235.3], active_power_w: 0, session_energy_wh: 0 }
  };
  let networkFailure = false, holdRequests = false;
  const held = [], requests = new Set();
  let peakRequests = 0;
  page.on('request', request => {
    if (request.url().endsWith('/api/state')) {
      requests.add(request);
      peakRequests = Math.max(peakRequests, requests.size);
    }
  });
  page.on('requestfinished', request => requests.delete(request));
  page.on('requestfailed', request => requests.delete(request));
  await page.route('**/api/state', route => {
    if (holdRequests) { held.push(route); return; }
    return networkFailure ? route.abort() : route.fulfill({ json: data });
  });
  async function releaseHeld(count = held.length) {
    for (const route of held.splice(0, count)) {
      // A browser-aborted request can no longer be fulfilled. Both outcomes
      // must leave its invalidated token unable to restore old measurements.
      await route.fulfill({ json: data }).catch(() => {});
    }
  }
  try {
    await page.goto(process.env.WEB_TEST_URL || 'http://127.0.0.1:8080');
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Live');
    assert.equal(await page.locator('#plugged').innerText(), 'Ja');
    assert.equal(await page.locator('#charging').innerText(), 'Nein');
    assert.equal(await page.locator('#limit').innerText(), '6,0 A');
    assert.equal(await page.locator('#voltage-0').innerText(), '235,7 V');
    assert.equal(await page.locator('input:not([type="checkbox"]), form').count(), 0);
    assert.equal(await page.locator('button').count(), 1); // Display reset, not a wallbox command.
    fs.mkdirSync('/artifacts', { recursive: true });
    await page.screenshot({ path: '/artifacts/weboverlay-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'light' });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile horizontal overflow');
    await page.screenshot({ path: '/artifacts/weboverlay-mobile.png', fullPage: true });
    data = { ...data, values: { ...data.values, plugged_in: null, charging: null, error_code: 7 } };
    await page.waitForFunction(() => document.getElementById('plugged').textContent === 'Unbekannt');
    assert(await page.locator('#wallbox-warning').isVisible(), 'Active warning remains outside closed diagnostics');
    await page.locator('.technical-details > summary').click();
    assert.equal(await page.locator('#wallbox-error').innerText(), 'Wallbox-Fehler · Code 7');
    await page.locator('.technical-details > summary').click();
    assert(await page.locator('#wallbox-warning').isVisible());
    data = { ...data, status: 'read_error', values: null, fresh_for_seconds: 0,
      error: '<img src=x onerror=alert(1)>', reason: 'Lesefehler' };
    await page.waitForFunction(() => document.getElementById('read-error').textContent.includes('<img'));
    assert.equal(await page.locator('#power').innerText(), '—');
    assert.equal(await page.locator('#plugged').innerText(), 'Unbekannt');
    assert.equal(await page.locator('img').count(), 0, 'MQTT text must not create markup');
    networkFailure = true;
    await page.waitForFunction(() => document.getElementById('reason').textContent.includes('nicht abgerufen'));
    assert.equal(await page.locator('#current-0').innerText(), '—');

    networkFailure = false;
    data = { ...data, status: 'live', values: { error_code: 0, socket_lock_state: 273,
      charging_state_raw: 33024, charging_state: 1, below_commanded_current: true,
      plugged_in: true, charging: false, current_limit_a: 6, current_a: [0, 0, 0],
      voltage_v: [235.7, 233.4, 235.3], active_power_w: 0, session_energy_wh: 0 },
      error: null, reason: 'Aktuelle Wallbox-Messdaten', fresh_for_seconds: 2 };
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Live');
    holdRequests = true;
    await page.waitForRequest('**/api/state');
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Daten veraltet');
    assert.equal(await page.locator('#power').innerText(), '—');
    await page.waitForFunction(() => document.getElementById('reason').textContent.includes('Zeitüberschreitung'));
    assert.equal(await page.locator('#limit').innerText(), '—');
    data = { ...data, fresh_for_seconds: 8 };
    await releaseHeld(1); // Deliver only the timed-out response, not a later request.
    assert.notEqual(await page.locator('#status').innerText(), 'Live');
    holdRequests = false;
    await releaseHeld();
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Live');

    // Exercise real DOM listeners and fetch cancellation, not just the helper
    // state machine. The hidden property is simulated deterministically because
    // headless tab visibility differs between Chromium versions.
    holdRequests = true;
    await page.waitForRequest('**/api/state');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.equal(await page.locator('#plugged').innerText(), 'Unbekannt');
    assert.equal(await page.locator('#power').innerText(), '—');
    await releaseHeld();
    await page.waitForTimeout(100); // Let aborted fetch finally run while hidden.
    holdRequests = false;
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Live');
    holdRequests = true;
    await page.waitForRequest('**/api/state');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    assert.equal(await page.locator('#current-0').innerText(), '—');
    await releaseHeld();
    holdRequests = false;
    await releaseHeld();
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Live');
    assert(peakRequests <= 1, `Overlapping API requests: ${peakRequests}`);

    const unchangedMutations = await page.evaluate(async () => {
      let changes = 0;
      const observer = new MutationObserver(records => { changes += records.length; });
      observer.observe(document.getElementById('reason'), { childList: true, characterData: true, subtree: true });
      await new Promise(resolve => setTimeout(resolve, 400));
      observer.disconnect();
      return changes;
    });
    assert.equal(unchangedMutations, 0, 'Unchanged status text should not be re-announced');
    assert.deepEqual(errors, []);
    console.log('Browser: layout, safe text, freshness, timeout/late responses, visibility/pageshow, nonoverlapping fetch and stable live region passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
