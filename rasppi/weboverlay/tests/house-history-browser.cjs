'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = process.env.TEST_URL || process.env.WEB_TEST_URL || 'http://127.0.0.1:8080';
const iso = t => new Date(t).toISOString();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function raw(now) {
  return { schema_version: 1, read_only: true, status: 'ok', reason: 'Hausverlauf', generated_at: iso(now), minutes: 15,
    range: { from: iso(now - 900000), to: iso(now) }, complete: true,
    samples: Array.from({ length: 1200 }, (_, i) => ({ id: String(i + 1), timestamp: iso(now - 620000 + i * 500),
      received_at: iso(now - 619999 + i * 500), status: i === 600 ? 'error' : 'ok', power_w: i === 600 ? null : i % 2 ? 0 : -800,
      break_before: true })) };
}
function year(query) {
  const requestedDate = query.get('date'), at = query.get('at');
  const date = /^\d{4}$/.test(requestedDate) ? requestedDate
    : new Intl.DateTimeFormat('en', { timeZone: 'Europe/Vienna', year: 'numeric' }).format(at ? new Date(at) : new Date());
  const n = Number(date);
  // Real API tests verify DST boundaries. This renderer fixture uses bounded
  // daily UTC slots across the requested Vienna year, including a real gap.
  const from = `${n - 1}-12-31T23:00:00Z`, to = `${n}-12-31T23:00:00Z`;
  const nav = date => ({ period: 'year', date: String(date), tz: 'Europe/Vienna' });
  const start = Date.parse(from), count = n % 5 + 1, days = (Date.parse(to) - start) / 86400000;
  const availableDays = Math.min(days, Math.max(0, Math.ceil((Date.now() + 5000 - start) / 86400000)));
  const bucket = (index, value, options = {}) => ({ from: iso(start + index * 86400000), to: iso(start + (index + 1) * 86400000),
    samples: count, has_gap: false, complete: true, coverage_seconds: 86400,
    metrics: { power_w: { count, nulls: 0, mean: value, min: value - 400, max: value + 400, last: value, mixed: false } },
    ...options });
  return { schema_version: 2, read_only: true, status: 'ok', reason: 'Hausverlauf', generated_at: iso(Date.now()),
    range: { from, to, timezone: 'Europe/Vienna' }, selection: { period: 'year', date, timezone: 'Europe/Vienna' },
    navigation: { previous: nav(n - 1), next: nav(n + 1), now: { period: 'year', date: 'now', tz: 'Europe/Vienna' } },
    aggregation: 'sample_mean', complete: true, progress: { samples_done: true, events_done: true },
    buckets: Array.from({ length: availableDays }, (_, i) => bucket(i, (i % 9 - 4) * 125,
      i === Math.floor(availableDays / 2) ? { has_gap: true, complete: false, coverage_seconds: 0 } : {})) };
}
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    let houseRequests = 0, holdDate = null, releaseHeld = null, heldReady = null;
    let houseMode = 'ok', liveMeter = false, releaseStatus = null;
    await context.route('**/api/state', route => route.fulfill({ json: { schema_version: 1, read_only: true,
      status: 'offline', reason: 'MQTT nicht verbunden.', broker_connected: false, availability: null, timestamp: null,
      last_success_at: null, age_seconds: null, fresh_for_seconds: 0, values: null, error: null } }));
    await context.route('**/api/history?**', route => {
      const q = new URL(route.request().url()).searchParams;
      if (q.has('period')) {
        const data = year(q); data.status = 'disabled'; data.reason = 'Nicht eingerichtet'; data.complete = false; data.buckets = [];
        return route.fulfill({ json: data });
      }
      const data = raw(Date.now()); data.status = 'disabled'; data.reason = 'Nicht eingerichtet'; data.complete = false; data.samples = [];
      return route.fulfill({ json: data });
    });
    await context.route('**/api/smartmeter', route => route.fulfill({ json: liveMeter ? { schema_version: 1, read_only: true,
      status: 'live', reason: 'Aktuell', power_w: 420, fetched_at: iso(Date.now()), age_seconds: 0, fresh_for_seconds: 10 }
      : { schema_version: 1, read_only: true,
      status: 'offline', reason: 'Nicht verfügbar', power_w: null, fetched_at: null, age_seconds: null, fresh_for_seconds: 0 } }));
    await context.route('**/api/house-history?**', async route => {
      houseRequests++;
      const q = new URL(route.request().url()).searchParams;
      const fixtureMode = houseMode;
      if (fixtureMode === 'loading') await new Promise(resolve => { releaseStatus = resolve; });
      if (fixtureMode === 'http') return route.fulfill({ status: 500, body: '' });
      if (fixtureMode === 'json') return route.fulfill({ status: 200, contentType: 'application/json', body: '{' });
      if (fixtureMode === 'network') return route.abort('failed');
      if (['disabled', 'unavailable', 'empty', 'incomplete'].includes(fixtureMode)) {
        const data = q.has('period') ? year(q) : raw(Date.now());
        if (['disabled', 'unavailable'].includes(fixtureMode)) data.status = fixtureMode;
        if (fixtureMode !== 'incomplete') {
          if (q.has('period')) data.buckets = []; else data.samples = [];
        }
        data.complete = fixtureMode === 'empty';
        if (data.progress) data.progress = { samples_done: data.complete, events_done: data.complete };
        return route.fulfill({ status: fixtureMode === 'unavailable' ? 503 : 200, json: data });
      }
      if (holdDate && q.get('date') === holdDate && !releaseHeld) {
        const data = year(q);
        await new Promise(resolve => {
          releaseHeld = async () => { await route.fulfill({ json: data }).catch(() => {}); resolve(); };
          heldReady?.();
        });
        return;
      }
      return route.fulfill({ json: q.has('period') ? year(q) : raw(Date.now()) });
    });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(String(e)));
    await page.goto(new URL('/diagramme', base).href);
    await page.selectOption('#chart-range', '15');
    const curve = page.locator('#house-chart-svg [data-house-series]');
    await page.waitForFunction(() => (document.querySelector('#house-chart-svg [data-house-series]')?.getAttribute('d') || '').length > 1000);
    assert((await curve.getAttribute('d')).length > 1000, 'SQL survives without live or wallbox data');
    assert((await curve.getAttribute('d')).split('M').length > 1000, 'Persisted barriers remain separate path segments');
    assert.equal(await page.locator('#grid-power').innerText(), '—', 'Archive import cannot revive live grid values');
    assert(await page.locator('#house-chart-svg *').count() < 15, '1200 points use bounded DOM');
    assert.equal(await page.locator('#house-chart-svg circle, #house-chart-svg title').count(), 0);
    const mutations = await page.evaluate(async () => {
      let count = 0; const observer = new MutationObserver(r => count += r.length);
      observer.observe(document.getElementById('house-chart-svg'), { subtree: true, childList: true, attributes: true });
      await new Promise(resolve => setTimeout(resolve, 700)); observer.disconnect(); return count;
    });
    assert.equal(mutations, 0, '250ms smartmeter ticks do not redraw an unchanged history');
    const beforeReload = houseRequests; await page.reload();
    await page.waitForFunction(() => (document.querySelector('#house-chart-svg [data-house-series]')?.getAttribute('d') || '').length > 1000);
    assert(houseRequests > beforeReload, 'Reload fetches persistent SQL baseline');
    await page.locator('[data-calendar-period="year"]').click();
    await page.locator('#calendar-date').fill('2024'); await page.locator('#calendar-date').dispatchEvent('change');
    await page.waitForFunction(() => !!document.querySelector('#house-chart-svg [data-house-band]'));
    assert(await page.locator('#house-chart-svg').isVisible(), 'House year archive is independent of disabled wallbox');
    assert.equal(await page.locator('#calendar-prev').isEnabled(), true, 'Validated house metadata supplies navigation fallback');
    assert.equal(await page.locator('#grid-power').innerText(), '—');
    const yearRequests = houseRequests;
    await page.reload();
    await page.waitForFunction(() => !!document.querySelector('#house-chart-svg [data-house-band]'));
    assert(houseRequests > yearRequests, 'Reload restores the selected house year while wallbox history stays disabled');
    assert.equal(await page.locator('#calendar-date').inputValue(), '2024');
    const yearPath = await curve.getAttribute('d');
    assert(yearPath.includes('L'), 'Daily means are connected as a line, not isolated ticks');
    assert.equal((yearPath.match(/M/g) || []).length, 3, 'One uncertain bucket separates the two continuous runs');

    let ready;
    const readyPromise = new Promise(resolve => { ready = resolve; });
    heldReady = ready; holdDate = '2023'; releaseHeld = null;
    await page.locator('#calendar-date').fill('2023'); await page.locator('#calendar-date').dispatchEvent('change');
    await readyPromise;
    await page.locator('#calendar-date').fill('2022'); await page.locator('#calendar-date').dispatchEvent('change');
    await page.waitForFunction(() => document.getElementById('house-chart-description')?.textContent.startsWith('1095 Messpunkte'));
    const currentDescription = await page.locator('#house-chart-description').innerText();
    const release = releaseHeld; holdDate = null; releaseHeld = null; await release(); await pause(100);
    assert.equal(await page.locator('#calendar-date').inputValue(), '2022');
    assert.equal(await page.locator('#house-chart-description').innerText(), currentDescription, 'Late year reply cannot replace the active selection');
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert(await page.locator('#house-chart-svg *').count() < 15);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if ([320, 1440].includes(width)) {
        fs.mkdirSync('/artifacts', { recursive: true });
        for (const colorScheme of ['light', 'dark']) {
          await page.emulateMedia({ colorScheme });
          await page.waitForFunction(scheme => document.documentElement.dataset.effectiveTheme === scheme, colorScheme);
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          await page.screenshot({ path: `/artifacts/house-year-${width}-${colorScheme}.png`, fullPage: true, animations: 'disabled' });
        }
      }
    }
    await page.locator('#show-house-power').uncheck(); assert(!await page.locator('#house-chart-svg').isVisible());
    await page.locator('#show-house-power').check(); assert(await page.locator('#house-chart-svg').isVisible());
    // Exercise the existing description only, with real loader callbacks and
    // live HTTP values independent from every archive availability state.
    liveMeter = true;
    const description = page.locator('#house-chart-description');
    const expectDescription = async text => {
      await page.waitForFunction(text => document.getElementById('house-chart-description')?.textContent.includes(text), text);
      await page.waitForFunction(() => document.getElementById('grid-power')?.textContent.includes('0,42'));
    };
    for (const [fixture, text] of [['disabled', 'ist deaktiviert'], ['unavailable', 'ist nicht verfügbar'],
      ['http', 'ist nicht verfügbar'], ['json', 'ist nicht verfügbar'], ['network', 'ist nicht verfügbar'],
      ['empty', 'Keine Messpunkte im gewählten Zeitraum'], ['incomplete', 'noch unvollständig']]) {
      houseMode = fixture; await page.reload(); await expectDescription(text);
      if (fixture !== 'incomplete') {
        assert.equal(await curve.count() ? await curve.getAttribute('d') : '', '', 'No invented zero line');
        assert(!(await description.innerText()).includes('Zuvor geladene'));
      }
      if (['disabled', 'empty'].includes(fixture))
        await page.screenshot({ path: `/artifacts/house-status-${fixture}.png`, fullPage: true, animations: 'disabled' });
    }
    houseMode = 'loading'; releaseStatus = null; await page.reload();
    await expectDescription('wird geladen');
    await page.waitForFunction(() => document.getElementById('house-chart-svg')?.getAttribute('display') === 'none');
    assert(releaseStatus, 'Loading fixture holds the request');
    releaseStatus(); await expectDescription('Messpunkte ·');
    const retainedPath = await curve.getAttribute('d');
    const refreshSameSelection = async () => page.locator('#calendar-date').dispatchEvent('change');
    for (const fixture of ['unavailable', 'disabled', 'http', 'json', 'network']) {
      houseMode = fixture; await refreshSameSelection();
      await expectDescription(fixture === 'disabled' ? 'ist deaktiviert' : 'ist nicht verfügbar');
      assert.match(await description.innerText(), /Zuvor geladene Daten; kein erfolgreicher aktueller Abruf/);
      assert.equal(await curve.getAttribute('d'), retainedPath, 'Failures retain the matching historical curve');
      assert(await page.locator('#house-chart-svg').isVisible());
      if (fixture === 'unavailable')
        await page.screenshot({ path: '/artifacts/house-status-retained-error.png', fullPage: true, animations: 'disabled' });
      houseMode = 'ok'; await refreshSameSelection(); await expectDescription('Messpunkte ·');
      assert.doesNotMatch(await description.innerText(), /nicht verfügbar|deaktiviert|Zuvor geladene/);
    }
    assert.deepEqual(errors, []); await context.close();
    console.log('House history browser checks passed');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
