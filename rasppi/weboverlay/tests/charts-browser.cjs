'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { METRICS } = require('../static/charts.js');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, colorScheme: 'dark' });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  let sequence = 0, offline = false;
  await page.clock.install();
  // Keep elapsed test time explicit. Full-page captures / responsive viewport
  // work must not advance a one-minute history window behind our assertions.
  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 1000));
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
    assert.equal(await page.locator('.display-options, #metric-options, #reset-display').count(), 0);
    // Seed diagram-only preferences before navigation. Overview must ignore them.
    await page.evaluate(ids => localStorage.setItem('evse-display-v1', JSON.stringify({ minutes: 1,
      selected: Object.fromEntries(ids.map(id => [id, false])) })), METRICS.map(m => m.id));
    await page.reload();
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'Live');
    for (const id of ['power', 'current-0', 'current-1', 'current-2', 'voltage-1']) assert(await page.locator(`#${id}`).isVisible(), id);
    assert(await page.locator('thead .phase-current').isVisible());
    assert.equal(await page.locator('.summary-card:visible').count(), 4);
    await page.locator('.technical-details > summary').click();
    for (const metric of await page.locator('[data-metric]').all()) assert(await metric.isVisible(), 'Overview ignores all-off diagram preferences');
    assert(await page.locator('#wallbox-warning').isVisible());
    assert(await page.locator('#timestamp').isVisible());
    await page.locator('.sidebar nav a[href="/diagramme"]').click();
    await page.waitForURL('**/diagramme', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'Live');
    assert(new URL(page.url()).pathname === '/diagramme');
    assert.equal(await page.locator('#chart-grid > figure').count(), 4);
    assert.equal(await page.locator('#chart-diagnostics-grid > figure').count(), 5);
    assert.equal(await page.locator('.display-options, #metric-options, .history-note').count(), 0);
    assert.equal(await page.locator('#chart-grid > figure > ul.chart-options, #chart-diagnostics-grid > figure > ul.chart-options').count(), 9);
    assert.equal(await page.locator('ul.chart-options input[type="checkbox"]').count(), 16);
    const owners = await page.locator('ul.chart-options').evaluateAll(lists => Object.fromEntries(lists.map(list =>
      [list.closest('figure').id, [...list.querySelectorAll('input')].map(input => input.id).sort()])));
    assert.deepEqual(owners, {
      'chart-power': ['show-power'], 'chart-current': ['show-current-0', 'show-current-1', 'show-current-2', 'show-limit'],
      'chart-voltage': ['show-voltage-0', 'show-voltage-1', 'show-voltage-2'], 'chart-energy': ['show-energy'],
      'chart-flags': ['show-below', 'show-charging', 'show-plugged'], 'chart-error': ['show-wallbox-error'],
      'chart-state': ['show-charging-state'], 'chart-raw': ['show-charging-raw'], 'chart-lock': ['show-lock']
    }, 'Each metric belongs to its own figure, exactly once');
    assert(await page.locator('#chart-power').isVisible(), 'Figure and controls remain reachable');
    assert(!await page.locator('#chart-power svg').isVisible(), 'Diagram preference hides only SVG');
    assert.equal(await page.locator('#smartmeter #chart-house').count(), 1);
    assert.equal(await page.locator('#chart-grid #chart-house, ul.chart-options #show-house-power').count(), 0);
    assert(await page.locator('#show-house-power').isVisible());
    assert.equal(await page.locator('[data-series="current-1"], [data-legend="current-1"]').count(), 0);
    assert(await page.locator('#wallbox-warning').isVisible());
    await page.locator('#chart-range').selectOption('1');
    await page.reload();
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Live');
    assert(!await page.locator('#chart-power svg').isVisible(), 'Selection must survive reload');
    assert.equal(await page.locator('#chart-range').inputValue(), '1');
    assert(!await page.locator('#show-current-1').isChecked());
    await page.locator('#reset-display').click();
    assert(await page.locator('#chart-energy svg').isVisible());
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
      const previous = await page.locator('#timestamp').innerText();
      await page.clock.runFor(1100);
      await page.waitForFunction(before => document.getElementById('status')?.textContent === 'Live'
        && document.getElementById('timestamp')?.textContent !== before, previous);
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
    // Live can precede the next distinct plottable timestamp (history correctly
    // ignores duplicate/out-of-order measurements). Wait for the same SVG
    // evidence asserted below, not merely the transport/status label.
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Live'
      && ((document.querySelector('[data-series="power"]').getAttribute('d') || '').match(/M/g) || []).length >= 2);
    assert(((await page.locator('[data-series="power"]').getAttribute('d')).match(/M/g) || []).length >= 2,
      'Recovery must start a disconnected segment');
    await page.locator('.history-diagnostics > summary').click();
    const wallboxFigures = page.locator('#chart-grid > figure, #chart-diagnostics-grid > figure');
    for (const checkbox of await page.locator('ul.chart-options input').all()) await checkbox.uncheck();
    assert(await page.locator('#status').isVisible());
    assert(await page.locator('#wallbox-warning').isVisible());
    assert.equal(await wallboxFigures.count(), 9);
    for (const figure of await wallboxFigures.all()) {
      assert(await figure.isVisible(), 'All-off figure remains visible');
      assert(!await figure.locator('svg').isVisible(), 'Only SVG is hidden');
      const controls = figure.locator('ul.chart-options input');
      assert(await controls.first().isVisible(), 'Own controls remain available');
      await controls.first().check();
      assert(await figure.locator('svg').isVisible(), 'Each figure can recover without global reset');
    }
    await page.locator('#reset-display').click();
    const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('evse-display-v1')));
    assert.deepEqual(Object.keys(prefs).sort(), ['minutes', 'selected']);
    assert.equal(Object.keys(prefs.selected).length, 16);
    assert(!Object.hasOwn(prefs.selected, 'house-power'), 'House selection is not a wallbox preference');
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
    assert(!await page.locator('#chart-power svg').isVisible(), 'Cached page reloads diagram preferences');
    assert.equal(await page.locator('#chart-range').inputValue(), '15');
    assert(!await page.locator('#show-current-1').isChecked());
    assert.equal(await page.locator('[data-series="current-1"], [data-legend="current-1"]').count(), 0);
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('evse-display-v1')))).minutes, 15);
    assert.deepEqual(errors, []);
    console.log('Charts browser: SVG lines, mobile, display/series/column selection, persistence, reset, warnings and outage gaps passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
