'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { METRICS } = require('../static/charts.js');
// Unsigned 32-bit raw-code boundary fixture: retain the original low bytes/state
// while exercising billion-scale diagnostic axis labels (not a hardware claim).
const LIVE_RAW_CODE = 0x80008100;

async function liveChartGeometry(page, width) {
  const figures = page.locator('#chart-grid > figure, #chart-diagnostics-grid > figure');
  assert.equal(await figures.count(), 9);
  for (const figure of await figures.all()) {
    const id = await figure.getAttribute('id');
    const svg = figure.locator('svg');
    assert(await svg.isVisible(), `${width} ${id}: selected chart is visible, including open diagnostics`);
    const geometry = await svg.evaluate(element => {
      const view = element.viewBox.baseVal;
      return {
        view: { x: view.x, y: view.y, width: view.width, height: view.height },
        axes: element.querySelectorAll('.chart-axis').length,
        gridlines: element.querySelectorAll('.chart-gridline').length,
        series: [...element.querySelectorAll('path[data-series]')].map(path => ({
          id: path.dataset.series, d: path.getAttribute('d'), dash: getComputedStyle(path).strokeDasharray
        })),
        boxes: [...element.querySelectorAll('.chart-gridline, .chart-axis, .chart-line')].map(node => {
          const box = node.getBBox();
          return { label: node.getAttribute('data-series') || node.textContent || node.tagName,
            x: box.x, y: box.y, width: box.width, height: box.height };
        })
      };
    });
    assert(geometry.view.width > 0 && geometry.view.height > 0, `${width} ${id}: usable viewBox`);
    assert(geometry.axes >= 4 && geometry.gridlines >= 2, `${width} ${id}: numeric/boolean and time axes plus grid exist`);
    assert(geometry.series.length > 0, `${width} ${id}: actual data series exist`);
    for (const series of geometry.series) {
      assert(series.d && /[LH]/.test(series.d), `${width} ${id}/${series.id}: collected Live samples form a nonempty line or step`);
      if (id === 'chart-voltage') assert.equal(series.dash, 'none',
        `${width} ${series.id}: actual Live voltage path is solid (not merely the legend)`);
    }
    if (id === 'chart-voltage') assert.equal(geometry.series.length, 3, 'All three voltage phases checked');
    assert(geometry.boxes.length > geometry.series.length, `${width} ${id}: axes/grid are checked too`);
    for (const box of geometry.boxes) {
      assert(Object.values(box).filter(value => typeof value === 'number').every(Number.isFinite),
        `${width} ${id}/${box.label}: finite SVG geometry`);
      // One SVG unit tolerates glyph rounding, not an axis label outside the viewport.
      assert(box.x >= geometry.view.x - 1 && box.y >= geometry.view.y - 1
        && box.x + box.width <= geometry.view.x + geometry.view.width + 1
        && box.y + box.height <= geometry.view.y + geometry.view.height + 1,
      `${width} ${id}/${box.label}: SVG grid/axis/line bounding box stays inside viewBox: ${JSON.stringify(box)}`);
    }
  }
  const flagLabels = await page.locator('#chart-flags .chart-axis').allTextContents();
  assert(flagLabels.includes('Nein') && flagLabels.includes('Ja'), 'Boolean 0/1 endpoints remain labelled');
}

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
  const paint = () => page.clock.runFor(32);
  await page.route('**/api/state', async route => {
    const now = await page.evaluate(() => Date.now());
    const timestamp = new Date(now).toISOString();
    sequence++;
    await route.fulfill({ json: {
      schema_version: 1, read_only: true, status: offline ? 'offline' : 'live', reason: offline ? 'Reader offline' : 'Aktuelle Messwerte',
      broker_connected: true, availability: offline ? 'offline' : 'online', timestamp, last_success_at: timestamp,
      age_seconds: 0, fresh_for_seconds: offline ? 0 : 8, error: null,
      values: offline ? null : { error_code: 7, socket_lock_state: 273, charging_state_raw: LIVE_RAW_CODE, charging_state: 1,
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
    assert.deepEqual(errors, [], 'Initial calendar publication must not access uninitialized renderer state');
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'Live');
    await paint();
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
    await paint();
    assert(!await page.locator('#chart-power svg').isVisible(), 'Selection must survive reload');
    assert.equal(await page.locator('#chart-range').inputValue(), '1');
    assert(!await page.locator('#show-current-1').isChecked());
    await page.locator('#reset-display').click();
    await paint();
    assert(await page.locator('#chart-energy svg').isVisible());
    assert(await page.locator('#chart-power').isVisible());
    const initialColor = await page.locator('[data-series="current-1"]').getAttribute('class');
    await page.locator('#show-current-1').uncheck();
    await paint();
    assert.equal(await page.locator('[data-series="current-1"], [data-legend="current-1"]').count(), 0);
    await page.locator('#show-current-1').check();
    await paint();
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
      await paint();
    }
    const line = await page.locator('[data-series="power"]').getAttribute('d');
    assert(line.includes('L'), 'Distinct sample timestamps should form a line');
    // Reuse the collected HTTP samples; resizing must not need fabricated chart
    // points or longer polling deadlines. Open the lazy diagnostic renderer first.
    await page.locator('.history-diagnostics > summary').click();
    for (const width of [1920, 2560, 320]) {
      await page.setViewportSize({ width, height: width === 320 ? 844 : 1050 });
      await paint();
      await liveChartGeometry(page, width);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${width}: open diagnostics do not overflow the browser`);
      if (width === 1920 || width === 320) {
        fs.mkdirSync('/artifacts', { recursive: true });
        await page.screenshot({ path: `/artifacts/live-diagnostics-${width}.png`, fullPage: true });
        await page.locator('#chart-raw').screenshot({ path: `/artifacts/live-raw-code-${width}.png` });
      }
    }
    await page.locator('.history-diagnostics > summary').click();
    await page.setViewportSize({ width: 1440, height: 1050 });
    await paint();
    fs.mkdirSync('/artifacts', { recursive: true });
    await page.screenshot({ path: '/artifacts/weboverlay-charts-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await paint();
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
    assert(await page.locator('.history-diagnostics').evaluate(details => details.open), 'Native diagnostics disclosure opens');
    await page.locator('#show-charging').check();
    await paint();
    assert(await page.locator('#chart-diagnostics-grid .chart-line').count() > 0, 'Diagnostics render lazily on opening');
    const wallboxFigures = page.locator('#chart-grid > figure, #chart-diagnostics-grid > figure');
    for (const checkbox of await page.locator('ul.chart-options input').all()) await checkbox.uncheck();
    await paint();
    assert(await page.locator('#status').isVisible());
    assert(await page.locator('#wallbox-warning').isVisible());
    assert.equal(await wallboxFigures.count(), 9);
    for (const figure of await wallboxFigures.all()) {
      assert(await figure.isVisible(), 'All-off figure remains visible');
      assert(!await figure.locator('svg').isVisible(), 'Only SVG is hidden');
      const controls = figure.locator('ul.chart-options input');
      assert(await controls.first().isVisible(), 'Own controls remain available');
      await controls.first().check();
      await paint();
      assert(await figure.locator('svg').isVisible(), 'Each figure can recover without global reset');
    }
    await page.locator('#reset-display').click();
    await paint();
    const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('evse-display-v1')));
    assert.deepEqual(Object.keys(prefs).sort(), ['minutes', 'selected']);
    assert.equal(Object.keys(prefs.selected).length, 16);
    assert(!Object.hasOwn(prefs.selected, 'house-power'), 'House selection is not a wallbox preference');
    assert(Object.values(prefs.selected).every(v => typeof v === 'boolean'));
    await page.evaluate(() => localStorage.setItem('evse-display-v1', '{broken'));
    await page.reload();
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Live');
    await paint();
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
    await paint();
    assert(!(await page.locator('[data-series="energy"]').getAttribute('d')).includes('L'), 'Cached page restoration starts fresh history');
    assert(!await page.locator('#chart-power svg').isVisible(), 'Cached page reloads diagram preferences');
    assert.equal(await page.locator('#chart-range').inputValue(), '15');
    assert(!await page.locator('#show-current-1').isChecked());
    assert.equal(await page.locator('[data-series="current-1"], [data-legend="current-1"]').count(), 0);
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('evse-display-v1')))).minutes, 15);
    assert.deepEqual(errors, []);
    console.log('Charts browser: solid Live voltage, 1920/2560/320px SVG bounds including billion-scale raw codes and boolean diagnostics, mobile, selection, persistence, reset, warnings and outage gaps passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
