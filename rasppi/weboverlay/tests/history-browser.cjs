'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { calendarQuery } = require('../static/history.js');
const { FIELDS } = require('../static/newcalendar.js');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, colorScheme: 'dark' });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  let historyRequests = 0, fail = false, live = false, disabled = false, hold = false;
  let heldReady = null;
  const pending = [];
  const calendarRequests = [], heldCalendar = [];
  let calendarFail = false, calendarHold = false;
  const values = { error_code: 0, socket_lock_state: 273, charging_state_raw: 33024, charging_state: 1,
    below_commanded_current: false, plugged_in: true, charging: false, current_limit_a: 6,
    current_a: [0, 0, 0], voltage_v: [235, 234, 236], active_power_w: 1500, session_energy_wh: 2 };
  const iso = t => new Date(t).toISOString();
  await page.clock.install({ time: new Date('2026-10-28T12:00:00Z') });
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
  await page.route('**/api/history?period=**', async route => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(request.method(), 'GET');
    assert.equal(new URL(calendarQuery(Object.fromEntries(url.searchParams)), 'http://test').search, url.search,
      'Only the validated read-only calendar parameter shape is permitted');
    calendarRequests.push(url.search);
    const period = url.searchParams.get('period'), selected = url.searchParams.get('date');
    const dates = { hour: '2026-10-27T12:00', day: '2026-10-25', week: '2026-W44', month: '2026-10', year: '2024', custom: 'Zeitraum' };
    const ranges = { hour: ['2026-10-27T11:00:00Z', '2026-10-27T12:00:00Z'],
      day: ['2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z'],
      week: ['2026-10-25T23:00:00Z', '2026-11-01T23:00:00Z'],
      month: ['2026-09-30T22:00:00Z', '2026-10-31T23:00:00Z'],
      year: ['2023-12-31T23:00:00Z', '2024-12-31T23:00:00Z'],
      custom: ['2026-10-01T22:00:00Z', '2026-10-02T22:00:00Z'] };
    let [from, to] = ranges[period];
    if (url.searchParams.has('at')) {
      const duration = Date.parse(to) - Date.parse(from); from = url.searchParams.get('at'); to = iso(Date.parse(from) + duration);
    }
    const now = await page.evaluate(() => Date.now());
    const weekHours = Math.max(1, Math.min(168, Math.floor((now - Date.parse(from)) / 3600000)));
    const statistics = Object.fromEntries(FIELDS.map((field, i) => [field, { count: 30, nulls: 0,
      mean: i === 0 || i >= 3 && i <= 8 ? 0 : null, min: i === 2 ? 6 : 0, max: i === 2 ? 6 : 0,
      last: i >= 9 && i <= 11 ? false : i === 2 ? 6 : 0, mixed: false }]));
    const bounds = period === 'year' && !url.searchParams.has('at') ? Array.from({ length: 367 }, (_, i) => {
      const date = iso(Date.UTC(2024, 0, i + 1)).slice(0, 10);
      // Known fixture boundaries, including the 23/25-hour days of 2024.
      return iso(Date.parse(date + 'T00:00:00Z') - (date >= '2024-04-01' && date <= '2024-10-27' ? 2 : 1) * 3600000);
    }) : period === 'hour' ? Array.from({ length: 61 }, (_, i) => iso(Date.parse(from) + i * 60000))
      : period === 'week' ? Array.from({ length: 169 }, (_, i) => iso(Date.parse(from) + i * 3600000)) : [from, to];
    const json = { schema_version: 2, read_only: true, status: calendarFail ? 'unavailable' : 'ok', reason: '<img src=x>',
      generated_at: iso(now), range: { from, to, timezone: 'Europe/Vienna' },
      selection: { period, date: selected && selected !== 'now' ? selected : dates[period], timezone: 'Europe/Vienna' },
      navigation: { previous: { period, at: iso(Date.parse(from) - (Date.parse(to) - Date.parse(from))), tz: 'Europe/Vienna' },
        next: { period, at: to, tz: 'Europe/Vienna' }, now: { period, date: 'now', tz: 'Europe/Vienna' } },
      aggregation: 'sample_mean', complete: true, progress: { samples_done: true, events_done: true },
      buckets: calendarFail ? [] : bounds.slice(0, -1).map((a, i) => {
        const empty = period === 'hour' && i >= 20 && i < 44 || period === 'week' && i >= weekHours;
        const metrics = JSON.parse(JSON.stringify(statistics));
        const samples = period === 'week' ? Math.floor(81478 / weekHours) + (i < 81478 % weekHours ? 1 : 0) : 30;
        if (period === 'week') {
          for (const stat of Object.values(metrics)) stat.count = samples;
          Object.assign(metrics.charging, { count: 0, nulls: samples, min: null, max: null, last: null });
          for (const [phase, field] of ['voltage_l1_v', 'voltage_l2_v', 'voltage_l3_v'].entries())
            Object.assign(metrics[field], { min: 228 + phase, max: 242 + phase,
              mean: 235 + phase + Math.sin(i / 8), last: 235 + phase, mixed: true });
          const power = i >= 20 && i < 26 ? 4000 : i === 26 ? 2000 : 0;
          Object.assign(metrics.active_power_w, { min: power ? power - 500 : 0, max: power + (power ? 500 : 0), mean: power, last: power, mixed: power > 0 });
          if (!empty && i === Math.floor(weekHours / 2)) for (const field of FIELDS.slice(0, 9))
            Object.assign(metrics[field], { count: samples - 1, nulls: 1 });
        }
        if (empty) {
          for (const stat of Object.values(metrics)) Object.assign(stat, { count: 0, nulls: 0, mean: null, min: null, max: null, last: null });
        } else if (period === 'hour') {
          for (const [phase, field] of ['voltage_l1_v', 'voltage_l2_v', 'voltage_l3_v'].entries()) {
            const mean = 236 + phase + Math.sin(i / 4);
            Object.assign(metrics[field], { mean, min: mean - .8, max: mean + 1, last: mean });
          }
        }
        return { from: a, to: bounds[i + 1], samples: empty ? 0 : samples,
          has_gap: period === 'hour' || period === 'week' && (empty || i === Math.floor(weekHours / 2)), complete: period !== 'hour',
          coverage_seconds: empty || period === 'hour' ? 0 : period === 'week' ? i === Math.floor(weekHours / 2) ? 0 : 3600 : 58, metrics };
      }) };
    if (period === 'custom') json.navigation = { previous: null, next: null, now: null };
    if (calendarHold) { heldCalendar.push({ route, json }); return; }
    await route.fulfill({ status: calendarFail ? 503 : 200, json });
  });
  const path = () => page.locator('[data-series="power"]').getAttribute('d');
  const base = process.env.WEB_TEST_URL || 'http://127.0.0.1:8080';
  try {
    fs.mkdirSync('/artifacts', { recursive: true });
    await page.goto(base);
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Offline');
    assert.equal(historyRequests, 0, 'Dashboard never starts history requests');
    await page.goto(base + '/diagramme');
    await page.waitForFunction(() => document.getElementById('history-source').dataset.historyStatus === 'ok');
    await page.waitForFunction(() => document.querySelector('[data-series="power"]')?.getAttribute('d')?.includes('L'));
    assert.match(await page.locator('#history-source').innerText(), /Wallbox-Archiv/);
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'Offline');
    assert.equal(await page.locator('#status').innerText(), 'Offline');
    assert((await path()).includes('L'), 'Archive renders while MQTT is offline');
    assert.equal(await page.locator('#chart-grid > figure').count(), 4);
    assert.equal(await page.locator('#chart-diagnostics-grid > figure').count(), 5);
    assert.deepEqual(await page.locator('.sidebar nav a').allTextContents(), ['Übersicht', 'Diagramme', 'Settings']);
    assert.equal(await page.locator('#theme-toggle').getAttribute('role'), 'switch');
    assert.equal(await page.locator('#chart-range').inputValue(), '5');
    assert.equal(await page.locator('.display-options, #metric-options, .history-note').count(), 0);
    assert.equal(await page.locator('ul.chart-options').count(), 9);
    assert.equal(await page.locator('ul.chart-options input').count(), 16);
    assert(await page.locator('.section-heading #reset-display').isVisible());
    assert.equal(await page.locator('#calendar-mode').isVisible(), false);
    assert.equal(await page.locator('button[data-calendar-period]').count(), 7);
    assert.equal(await page.locator('[data-calendar-period="live"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#smartmeter #chart-house').count(), 1);
    assert.equal(await page.locator('img').count(), 1, 'Only the static brand logo may be an image');
    assert.equal(await page.locator('.brand-mark img[src="/static/icon.svg"]').count(), 1);
    await page.screenshot({ path: '/artifacts/history-sql-desktop.png',
      fullPage: true, animations: 'disabled' });
    await page.reload();
    await page.waitForFunction(() => document.getElementById('history-source').dataset.historyStatus === 'ok');
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
    await page.screenshot({ path: '/artifacts/history-sql-mobile.png',
      fullPage: true, animations: 'disabled' });
    const stored = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
    assert(Object.keys(stored).every(key => ['evse-display-v1', 'evse-theme-v1'].includes(key)));
    assert(!JSON.stringify(stored).includes('received_at'));

    // A pending archive generation must not survive a hidden page or BFCache.
    fail = false; hold = true;
    const heldRequest = new Promise(resolve => { heldReady = resolve; });
    await page.locator('#chart-range').selectOption('1'); await page.clock.runFor(200);
    let heldTimer;
    try {
      await Promise.race([heldRequest, new Promise((_, reject) => {
        heldTimer = setTimeout(() => reject(new Error('Archive fixture request deadline')), 5000);
      })]);
    } finally { clearTimeout(heldTimer); }
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
    // restore() immediately shows the RAM-only reset note. Wait for the actual
    // disabled response acknowledgement before fast-forwarding network timeouts.
    await page.waitForFunction(() => document.getElementById('history-source').dataset.historyStatus === 'disabled');
    assert.match(await page.locator('#history-source').innerText(), /Live-Verlauf/);
    assert.match(await page.locator('#history-detail').innerText(), /Browser|RAM|Seitenöffnung/);
    assert.equal(await page.locator('#chart-range').inputValue(), '1', 'Restoration preserves range preference');
    const disabledRequests = historyRequests;
    await page.evaluate(() => {
      window.__historyStatusTrace = [];
      const source = document.getElementById('history-source');
      new MutationObserver(() => {
        window.__historyStatusTrace.push({ status: source.dataset.historyStatus,
          wall: Date.now(), mono: performance.now() });
        window.__historyStatusTrace.splice(0, Math.max(0, window.__historyStatusTrace.length - 12));
      }).observe(source, { attributes: true, attributeFilter: ['data-history-status'] });
    });
    await page.clock.runFor(65000);
    const trace = await page.evaluate(() => window.__historyStatusTrace);
    assert.equal(historyRequests, disabledRequests,
      'Disabled history stops automatic refresh: ' + JSON.stringify(trace));
    disabled = false;
    // Keep calendar selection checks independent of real-time live expiry.
    // runFor() below explicitly exercises live ticks and late responses again.
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 1000));
    const pickerDates = { hour: '2026-10-27T12:00', day: '2026-10-25', week: '2026-W44', month: '2026-10', year: '2024' };
    for (const period of ['hour', 'day', 'week', 'month', 'year']) {
      await page.locator(`[data-calendar-period="${period}"]`).click();
      await page.waitForFunction(() => document.getElementById('history-source').dataset.historyStatus === 'ok');
      await page.clock.runFor(32); // Explicit RAF barrier with the paused browser clock.
      assert.equal(await page.locator('#calendar-mode').inputValue(), period);
      assert.equal(await page.locator(`[data-calendar-period="${period}"]`).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('[data-calendar-period][aria-pressed="true"]').count(), 1);
      assert(!await page.locator('#house-chart-svg').isVisible(), 'Calendar cannot imply a house archive');
      // This suite has a virtual date and no house fixture. A disabled server
      // response outside that clock's freshness window is unavailable, never
      // a fabricated house curve. Exact status cases have their own suite.
      // HOUSE completes independently of the Wallbox request. Its response
      // can queue a RAF after the preceding 32ms barrier; waiting with a
      // paused clock then deadlocks that paint forever. Let real frames run
      // only until this status is painted, then freeze again for assertions.
      await page.clock.resume();
      try {
        await page.waitForFunction(() => /Hausarchiv ist (deaktiviert|nicht verfügbar)/i.test(
          document.getElementById('house-chart-description')?.textContent || ''), null, { timeout: 5000 });
      } finally {
        await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 1000));
      }
      await page.clock.runFor(32);
      assert.equal(await page.locator('#chart-range').isDisabled(), true);
      assert.equal(await page.locator('#chart-range').isVisible(), false, 'Minute picker is not presented as the archive window');
      assert((await page.locator('#calendar-label').innerText()).includes('Europe/Vienna'));
      // A successful fetch status is not a DOM/render barrier. Live/clock
      // lifecycle callbacks may run between the preceding awaited assertions.
      try {
        await page.waitForFunction(short => (document.querySelector(short
          ? '#chart-power .archive-line' : '#chart-power .summary-value')?.getAttribute('d') || '').length > 0,
        ['hour', 'day', 'week'].includes(period), { timeout: 5000 });
      } catch (error) {
        console.error('Calendar render readiness', JSON.stringify({ period, requests: calendarRequests.slice(-6),
          state: await page.evaluate(() => ({ mode: document.getElementById('calendar-mode').value,
            status: document.getElementById('history-source').dataset.historyStatus,
            label: document.getElementById('calendar-label').textContent })), errors }));
        throw error;
      }
      if (['hour', 'day', 'week'].includes(period)) {
        assert.equal(await page.locator('#chart-grid .summary-glyph').count(), 0, 'No min/max bands or bucket ticks in short periods');
        assert.equal(await page.locator('#chart-power .archive-line').evaluate(el => getComputedStyle(el).strokeWidth), '2px');
        assert.equal(await page.locator('#chart-power .archive-line').evaluate(el => getComputedStyle(el).strokeDasharray), 'none');
      } else assert(await page.locator('[data-summary-series="power"]').count() > 0);
      if (period === 'week') {
        assert.equal(await page.locator('#chart-power svg').getAttribute('data-bucket-count'), '168');
        assert.match(await page.locator('#chart-power .chart-description').innerText(), /81478 Messwerte/);
        for (const id of ['power', 'current', 'voltage', 'energy'])
          assert(await page.locator(`#chart-${id} svg *`).count() < 100);
        const curve = await page.locator('#chart-voltage .archive-line').first().getAttribute('d');
        assert.equal((curve.match(/M/g) || []).length, 3, 'A genuine gap isolates its value between two connected numeric runs');
        assert((curve.match(/L/g) || []).length > 50, 'Unknown charging must not isolate known voltages');
        await page.evaluate(() => {
          window.__archiveWork = { plots: 0, layouts: 0, mutations: 0 };
          const original = OverlayCalendar.buildSummaryPlot;
          OverlayCalendar.buildSummaryPlot = (...args) => { window.__archiveWork.plots++; return original(...args); };
          const measure = Element.prototype.getBoundingClientRect;
          Element.prototype.getBoundingClientRect = function () {
            if (this.matches('#chart-grid figure, #chart-diagnostics-grid figure')) window.__archiveWork.layouts++;
            return measure.call(this);
          };
          const observer = new MutationObserver(records => window.__archiveWork.mutations += records.length);
          for (const svg of document.querySelectorAll('#chart-grid svg')) observer.observe(svg, { subtree: true, attributes: true, childList: true });
        });
        await page.clock.runFor(10000);
        assert.deepEqual(await page.evaluate(() => window.__archiveWork), { plots: 0, layouts: 0, mutations: 0 },
          '100 freshness ticks cause no archive builds, layouts or SVG writes');
        const viewport = page.viewportSize();
        for (const [width, colorScheme, label] of [[1440, 'dark', 'desktop'], [390, 'light', 'mobile']]) {
          await page.setViewportSize({ width, height: 1050 });
          await page.emulateMedia({ colorScheme });
          await page.clock.runFor(32);
          assert(await page.locator('#chart-grid .archive-line').evaluateAll(lines => lines.every(el =>
            getComputedStyle(el).strokeWidth === '2px' && getComputedStyle(el).strokeDasharray === 'none')),
          'All selected weekly series use Live thickness and solid lines (requires the scoped archive-line CSS rule)');
          await page.screenshot({ path: `/artifacts/calendar-week-connected-${label}.png`, fullPage: true, animations: 'disabled' });
        }
        await page.setViewportSize(viewport); await page.clock.runFor(32);
      }
      if (period === 'hour') {
        assert.equal(await page.locator('#chart-power .archive-line').count(), 1, '36 available means share one path');
        assert.equal(await page.locator('#chart-power .summary-range').count(), 0);
        const isolated = await page.locator('#chart-power .archive-line').getAttribute('d');
        assert.equal((isolated.match(/M/g) || []).length, 2, 'Empty minutes split two aggregate runs');
        assert.equal((isolated.match(/L/g) || []).length, 34, 'Available means connect without waiting for coarse coverage/completion');
        assert(!/[HVZ]/.test(isolated), 'No raw-like ticks, bands or invented samples');
        assert.equal(await page.locator('#chart-power [data-series-marker]').count(), 1, 'Batched small Live-style markers show isolated evidence');
        await page.screenshot({ path: '/artifacts/calendar-hour-gaps-mobile.png', fullPage: true });
        const viewport = page.viewportSize();
        await page.setViewportSize({ width: 1440, height: 1050 });
        await page.evaluate(() => dispatchEvent(new Event('resize')));
        await page.clock.runFor(32);
        await page.screenshot({ path: '/artifacts/calendar-hour-gaps-desktop.png', fullPage: true });
        await page.setViewportSize(viewport);
        await page.evaluate(() => dispatchEvent(new Event('resize')));
        await page.clock.runFor(32);
      }
      if (['month', 'year'].includes(period))
        assert.equal(await page.locator('[data-series-marker]').count(), 0, 'Legacy summaries keep their previous glyph renderer');
      assert.equal(await page.locator('img').count(), 1, 'DTO reasons cannot add images');
      await page.locator('#calendar-date').fill(pickerDates[period]);
      await page.locator('#calendar-date').dispatchEvent('change');
      await page.waitForFunction(() => document.getElementById('history-source').dataset.historyStatus === 'ok');
      await page.clock.runFor(32);
      assert.equal(new URLSearchParams(calendarRequests.at(-1)).get('date'), pickerDates[period]);
    }
    assert.equal(await page.locator('#chart-power svg').getAttribute('data-bucket-count'), '366');
    assert.equal(await page.locator('[data-summary-series="power"]').count(), 2, '366 days share one band and one trend');
    assert.notEqual(await page.locator('#chart-power .summary-range').evaluate(el => getComputedStyle(el).fill), 'none',
      'Min/max is a filled band rather than a vertical stroke forest');
    assert.equal(await page.locator('#chart-power .summary-value').evaluate(el => getComputedStyle(el).strokeDasharray), 'none',
      'The aggregate trend remains a calm solid line in the active theme');
    assert(await page.locator('#chart-power *').count() <= 100, 'DOM budget is independent of 366 buckets');
    assert.equal(await page.locator('#chart-diagnostics-grid svg > *').count(), 0, 'Closed diagnostics have not been drawn');
    await page.locator('#chart-power svg').focus();
    await page.keyboard.press('End');
    assert.match(await page.locator('#chart-power svg > title').textContent(), /30 Werte/);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.clock.runFor(32);
    assert(await page.locator('#chart-power svg').evaluate(svg => {
      const width = Math.max(240, Math.round(svg.closest('figure').getBoundingClientRect().width - 40));
      return svg.viewBox.baseVal.width === width;
    }), 'Archive resize recomputes pixel geometry, not compressed text');
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.clock.runFor(32);
    await page.evaluate(() => { window.__retainedCalendarPath = document.querySelector('#chart-power .summary-value'); });
    await page.evaluate(() => { for (let i = 0; i < 25; i++) window.dispatchEvent(new Event('resize')); });
    await page.clock.runFor(32);
    assert(await page.evaluate(() => window.__retainedCalendarPath === document.querySelector('#chart-power .summary-value')),
      'Resize updates the keyed path in place rather than replacing the SVG tree');
    await page.evaluate(() => {
      window.__calendarMutations = 0;
      new MutationObserver(() => window.__calendarMutations++).observe(document.querySelector('#chart-power svg'), { childList: true });
    });
    const stableRequests = calendarRequests.length;
    await page.clock.runFor(2100);
    assert.equal(calendarRequests.length, stableRequests, 'A completed past year is not polled every second');
    assert.equal(await page.evaluate(() => window.__calendarMutations), 0, 'Live ticks do not rebuild an unchanged archive plot');
    await page.locator('#calendar-date').fill('2024'); await page.locator('#calendar-date').dispatchEvent('change');
    await page.waitForFunction(() => document.getElementById('history-source').dataset.historyStatus === 'ok');
    await page.locator('#calendar-next').click();
    await page.waitForFunction(() => document.getElementById('history-source').dataset.historyStatus === 'ok');
    assert(new URLSearchParams(calendarRequests.at(-1)).has('at'), 'Navigation uses the server UTC anchor');
    await page.locator('#calendar-prev').click();
    await page.waitForFunction(() => document.getElementById('history-source').dataset.historyStatus === 'ok');
    await page.locator('#calendar-now').click();
    await page.waitForFunction(() => document.getElementById('history-source').dataset.historyStatus === 'ok');
    assert.equal(new URLSearchParams(calendarRequests.at(-1)).get('date'), 'now');
    await page.reload();
    await page.waitForFunction(() => document.getElementById('history-source').dataset.historyStatus === 'ok');
    await page.clock.runFor(32);
    assert.equal(await page.locator('#calendar-mode').inputValue(), 'year');
    assert.equal(await page.locator('#chart-power svg').getAttribute('data-bucket-count'), '366');
    assert(await page.locator('[data-summary-series="power"]').count() <= 4);
    await page.setViewportSize({ width: 320, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: '/artifacts/calendar-year-flat-mobile.png', fullPage: true });
    await page.locator('[data-calendar-period="custom"]').click();
    await page.locator('#calendar-from').fill('2026-10-02T00:00');
    await page.locator('#calendar-to').fill('2026-10-03T00:00');
    await page.locator('#calendar-custom button').click();
    await page.waitForFunction(() => document.getElementById('history-source').dataset.historyStatus === 'ok');
    assert(new URLSearchParams(calendarRequests.at(-1)).has('date_from'));
    calendarHold = true;
    await page.locator('[data-calendar-period="day"]').click();
    await page.waitForFunction(() => document.getElementById('history-source').dataset.historyStatus === 'browser');
    await page.locator('[data-calendar-period="year"]').click();
    calendarHold = false;
    for (const item of heldCalendar.splice(0)) await item.route.fulfill({ json: item.json }).catch(() => {});
    await page.clock.runFor(5000);
    // Retry only the selected year, never a late day response.
    await page.locator('#calendar-now').click();
    await page.waitForFunction(() => document.getElementById('history-source').dataset.historyStatus === 'ok');
    assert.equal(await page.locator('#calendar-mode').inputValue(), 'year');
    const retainedGlyphs = await page.locator('[data-summary-series="power"]').count();
    calendarFail = true;
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
      delete document.hidden; document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.runFor(300);
    await page.waitForFunction(() => document.getElementById('history-source').dataset.historyStatus === 'unavailable');
    assert.equal(await page.locator('[data-summary-series="power"]').count(), retainedGlyphs);
    const calendarStored = await page.evaluate(() => localStorage.getItem('evse-calendar-v1'));
    assert.equal(JSON.parse(calendarStored).period, 'year'); assert(!calendarStored.includes('buckets'));
    // Native limits are not sufficient: scripted/manual future changes must
    // not issue requests or replace the last accepted preference either.
    assert.equal(await page.locator('#calendar-date').getAttribute('max'), '2026');
    const requestCount = calendarRequests.length;
    await page.locator('#calendar-date').fill('2027');
    await page.locator('#calendar-date').dispatchEvent('change');
    assert.equal(calendarRequests.length, requestCount);
    assert.equal(await page.evaluate(() => localStorage.getItem('evse-calendar-v1')), calendarStored);
    assert((await page.locator('#calendar-label').innerText()).includes('Zukünftige'));
    await page.locator('[data-calendar-period="live"]').click();
    assert.equal(await page.locator('#chart-range').isDisabled(), false);
    assert.equal(await page.locator('ul.chart-options input').count(), 16);
    assert.deepEqual(errors, []);
    console.log('History browser: offline archive/reload, isolated SQL failure, unchanged controls, RAM-only, hidden and BFCache passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
