'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, colorScheme: 'dark' });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  let sequence = 0, offline = false;
  await page.clock.install();
  await page.route('**/api/state', async route => {
    const now = await page.evaluate(() => Date.now());
    const timestamp = new Date(now).toISOString();
    sequence++;
    await route.fulfill({ json: {
      schema_version: 1, read_only: true, status: offline ? 'offline' : 'live', reason: offline ? 'Reader offline' : 'Aktuelle Messwerte',
      broker_connected: true, availability: offline ? 'offline' : 'online', timestamp, last_success_at: timestamp,
      age_seconds: 0, fresh_for_seconds: offline ? 0 : 8, error: null,
      values: offline ? null : { error_code: 7, socket_lock_state: 273, charging_state_raw: 33024, charging_state: 1,
        below_commanded_current: true, plugged_in: true, charging: false, current_limit_a: 6,
        current_a: [2 + Math.sin(sequence / 3), 1 + Math.cos(sequence / 4), 0],
        voltage_v: [235.7 + Math.sin(sequence / 5), 233.4, 235.3],
        active_power_w: 1500 + Math.sin(sequence / 5) * 250, session_energy_wh: sequence * 2 }
    } });
  });
  try {
    await page.goto(process.env.WEB_TEST_URL || 'http://127.0.0.1:8080');
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Live');
    assert.equal(await page.locator('.chart-card, #chart-range').count(), 0, 'Dashboard has no charts');
    assert.equal(await page.locator('#metric-options input').count(), 16);
    await page.locator('.display-options summary').click();
    await page.locator('#show-power').uncheck();
    assert(!await page.locator('#power').isVisible());
    await page.locator('#show-current-1').uncheck();
    assert(!await page.locator('#current-1').isVisible());
    assert(await page.locator('#voltage-1').isVisible());
    await page.locator('#show-current-0').uncheck();
    await page.locator('#show-current-2').uncheck();
    assert(!await page.locator('thead .phase-current').isVisible());
    assert(await page.locator('thead .phase-voltage').isVisible());
    await page.locator('#show-wallbox-error').uncheck();
    assert(await page.locator('#wallbox-warning').isVisible(), 'Hiding a value must not hide an active warning');
    assert(await page.locator('#timestamp').isVisible());
    await page.locator('.sidebar nav a[href="/diagramme"]').click();
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Live');
    assert(new URL(page.url()).pathname === '/diagramme');
    assert.equal(await page.locator('#chart-grid > figure').count(), 4);
    assert.equal(await page.locator('#chart-diagnostics-grid > figure').count(), 5);
    assert(!await page.locator('#chart-power').isVisible(), 'Selection shared between pages');
    assert.equal(await page.locator('[data-series="current-1"], [data-legend="current-1"]').count(), 0);
    assert(await page.locator('#wallbox-warning').isVisible());
    await page.locator('#chart-range').selectOption('1');
    await page.reload();
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Live');
    assert(!await page.locator('#chart-power').isVisible(), 'Selection must survive reload');
    assert.equal(await page.locator('#chart-range').inputValue(), '1');
    await page.locator('.display-options summary').click();
    assert(!await page.locator('#show-current-1').isChecked());
    await page.locator('#reset-display').click();
    assert(await page.locator('#chart-power').isVisible());
    const initialColor = await page.locator('[data-series="current-1"]').getAttribute('class');
    await page.locator('#show-current-1').uncheck();
    assert.equal(await page.locator('[data-series="current-1"], [data-legend="current-1"]').count(), 0);
    await page.locator('#show-current-1').check();
    assert.equal(await page.locator('[data-series="current-1"]').getAttribute('class'), initialColor);
    const energyAxes = (await page.locator('#chart-energy .chart-axis').allTextContents()).slice(0, 2);
    assert.notEqual(energyAxes[0], energyAxes[1], 'Small kWh ranges must not round both axes to zero');
    await page.locator('#chart-range').selectOption('1');

    // Fast-forward browser timers, not host time: collect multiple real HTTP
    // responses through the chart integration without a long wall-clock test.
    for (let i = 0; i < 25; i++) {
      await page.clock.runFor(1100);
      await page.waitForFunction(() => document.getElementById('status').textContent === 'Live');
    }
    const line = await page.locator('[data-series="power"]').getAttribute('d');
    assert(line.includes('L'), 'Distinct sample timestamps should form a line');
    fs.mkdirSync('/artifacts', { recursive: true });
    await page.screenshot({ path: '/artifacts/weboverlay-charts-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'light' });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Charts overflow mobile width');
    await page.screenshot({ path: '/artifacts/weboverlay-charts-mobile.png', fullPage: true });
    offline = true;
    await page.clock.runFor(1100);
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Offline');
    assert.equal(await page.locator('#freshness').innerText(), '—');
    assert((await page.locator('[data-series="power"]').getAttribute('d')).includes('L'), 'Past history should remain, labelled historical');
    offline = false;
    await page.clock.runFor(1100);
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Live');
    assert(((await page.locator('[data-series="power"]').getAttribute('d')).match(/M/g) || []).length >= 2,
      'Recovery must start a disconnected segment');
    await page.locator('.display-options summary').click(); // Close, then reopen consistently.
    if (!await page.locator('#show-power').isVisible()) await page.locator('.display-options summary').click();
    for (const checkbox of await page.locator('#metric-options input').all()) await checkbox.uncheck();
    assert(await page.locator('#display-empty').isVisible());
    assert(await page.locator('#status').isVisible());
    assert(await page.locator('#wallbox-warning').isVisible());
    assert.equal(await page.locator('.chart-card:visible').count(), 0);
    await page.locator('#reset-display').click();
    const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('evse-display-v1')));
    assert.deepEqual(Object.keys(prefs).sort(), ['minutes', 'selected']);
    assert(Object.values(prefs.selected).every(v => typeof v === 'boolean'));
    await page.evaluate(() => localStorage.setItem('evse-display-v1', '{broken'));
    await page.reload();
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Live');
    assert(await page.locator('#chart-power').isVisible(), 'Corrupt storage should fall back to defaults');
    assert(!(await page.locator('[data-series="power"]').getAttribute('d')).includes('L'), 'Reload discards history');
    await page.evaluate(() => {
      const prefs = JSON.parse(localStorage.getItem('evse-display-v1'));
      prefs.minutes = 15; prefs.selected.power = false; prefs.selected['current-1'] = false;
      localStorage.setItem('evse-display-v1', JSON.stringify(prefs));
      const event = new Event('pageshow');
      Object.defineProperty(event, 'persisted', { value: true });
      window.dispatchEvent(event);
    });
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Live');
    assert(!(await page.locator('[data-series="energy"]').getAttribute('d')).includes('L'), 'Cached page restoration starts fresh history');
    assert(!await page.locator('#chart-power').isVisible(), 'Cached page reloads shared preferences');
    assert.equal(await page.locator('#chart-range').inputValue(), '15');
    assert(!await page.locator('#show-current-1').isChecked());
    assert.equal(await page.locator('[data-series="current-1"], [data-legend="current-1"]').count(), 0);
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('evse-display-v1')))).minutes, 15);
    assert.deepEqual(errors, []);
    console.log('Charts browser: SVG lines, mobile, display/series/column selection, persistence, reset, warnings and outage gaps passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
