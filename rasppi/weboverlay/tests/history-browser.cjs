'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, colorScheme: 'dark' });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  let historyRequests = 0, fail = false, live = false, disabled = false, hold = false;
  let heldReady = null;
  const pending = [];
  const values = { error_code: 0, socket_lock_state: 273, charging_state_raw: 33024, charging_state: 1,
    below_commanded_current: false, plugged_in: true, charging: false, current_limit_a: 6,
    current_a: [0, 0, 0], voltage_v: [235, 234, 236], active_power_w: 1500, session_energy_wh: 2 };
  const iso = t => new Date(t).toISOString();
  await page.clock.install();
  await page.route('**/api/state', async route => {
    const now = await page.evaluate(() => Date.now());
    await route.fulfill({ json: { schema_version: 1, read_only: true, status: live ? 'live' : 'offline',
      reason: live ? 'Aktuelle Messwerte' : 'Reader offline', broker_connected: true, availability: live ? 'online' : 'offline',
      timestamp: iso(now), last_success_at: iso(now), age_seconds: 0, fresh_for_seconds: live ? 8 : 0,
      error: null, values: live ? values : null } });
  });
  await page.route('**/api/history?minutes=15', async route => {
    historyRequests++;
    const now = await page.evaluate(() => Date.now());
    const json = { schema_version: 1, read_only: true, status: disabled ? 'disabled' : 'ok',
      reason: '<img src=x onerror=alert(1)>', generated_at: iso(now), minutes: 15,
      range: { from: iso(now - 900000), to: iso(now) }, complete: true,
      samples: disabled ? [] : [4000, 2000].map((ago, i) => ({ id: String(9007199254740992n + BigInt(i)),
        timestamp: iso(now - ago), received_at: iso(now - ago), status: 'ok', values,
        break_before: i === 0 })) };
    if (hold) { pending.push({ route, json }); heldReady?.(); return; }
    if (fail) await route.fulfill({ status: 503, json: { ...json, status: 'unavailable', samples: [] } });
    else await route.fulfill({ json });
  });
  const path = () => page.locator('[data-series="power"]').getAttribute('d');
  const base = process.env.WEB_TEST_URL || 'http://127.0.0.1:8080';
  try {
    await page.goto(base);
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Offline');
    assert.equal(historyRequests, 0, 'Dashboard never starts history requests');
    await page.goto(base + '/diagramme');
    await page.waitForFunction(() => document.getElementById('history-source').textContent.includes('Archiv und'));
    await page.waitForFunction(() => document.querySelector('[data-series="power"]')?.getAttribute('d')?.includes('L'));
    assert.equal(await page.locator('#status').innerText(), 'Offline');
    assert((await path()).includes('L'), 'Archive renders while MQTT is offline');
    assert.equal(await page.locator('#chart-grid > figure').count(), 4);
    assert.equal(await page.locator('#chart-diagnostics-grid > figure').count(), 5);
    assert.deepEqual(await page.locator('.sidebar nav a').allTextContents(), ['Übersicht', 'Diagramme', 'Settings']);
    assert.equal(await page.locator('#theme-toggle').getAttribute('role'), 'switch');
    assert.equal(await page.locator('#chart-range').inputValue(), '5');
    assert.equal(await page.locator('#metric-options input').count(), 16);
    assert.equal(await page.locator('img').count(), 0, 'API reason is not inserted into HTML');
    await page.reload();
    await page.waitForFunction(() => document.getElementById('history-source').textContent.includes('Archiv und'));
    await page.waitForFunction(() => document.querySelector('[data-series="power"]')?.getAttribute('d')?.includes('L'));
    assert((await path()).includes('L'), 'Reload fetches history rather than inventing live observations');
    live = true; fail = true;
    await page.clock.runFor(1100);
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Live');
    const retained = await path();
    await page.locator('#chart-range').selectOption('15');
    await page.clock.runFor(200);
    await page.waitForFunction(() => document.getElementById('history-detail').textContent.includes('bleiben erhalten'));
    assert.equal(await page.locator('#status').innerText(), 'Live');
    assert((await path()).includes('L') && retained.length > 0, 'SQL failure preserves SQL/local history');
    assert.equal(await page.locator('#chart-range').inputValue(), '15');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'light' });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const stored = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
    assert(Object.keys(stored).every(key => ['evse-display-v1', 'evse-theme-v1'].includes(key)));
    assert(!JSON.stringify(stored).includes('received_at'));

    // A pending archive generation must not survive a hidden page or BFCache.
    fail = false; hold = true;
    const heldRequest = new Promise(resolve => { heldReady = resolve; });
    await page.locator('#chart-range').selectOption('1'); await page.clock.runFor(200);
    await heldRequest;
    assert(pending.length > 0);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const before = historyRequests;
    await page.clock.runFor(65000);
    assert.equal(historyRequests, before, 'No hidden refresh or retries');
    for (const item of pending.splice(0)) await item.route.fulfill({ json: item.json }).catch(() => {});
    hold = false; disabled = true;
    await page.evaluate(() => {
      delete document.hidden;
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await page.clock.runFor(300);
    await page.waitForFunction(() => document.getElementById('history-detail').textContent.includes('kein Datenbankarchiv'));
    assert.equal(await page.locator('#chart-range').inputValue(), '1', 'Restoration preserves range preference');
    const disabledRequests = historyRequests;
    await page.clock.runFor(65000);
    assert.equal(historyRequests, disabledRequests, 'Disabled history stops automatic refresh');
    assert.deepEqual(errors, []);
    console.log('History browser: offline archive/reload, isolated SQL failure, unchanged controls, RAM-only, hidden and BFCache passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
