'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = process.env.WEB_TEST_URL || 'http://127.0.0.1:8080';
const defaults = () => {
  const limits = { max_import_w: null, max_current_ma: null, adjust_seconds: null, pause_seconds: null, resume_seconds: null };
  return { schema_version: 1, timezone: 'Europe/Vienna', manual: { current_ma: null }, pv: { ...limits },
    custom: { ...limits, use_schedule: null, pv_enabled: null, weekdays: [], windows: [], outside_window: null } };
};
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark', serviceWorkers: 'block' });
    let config = defaults(), revision = null, posts = 0, conflict = false, disabled = false, drop = false;
    const requests = [], errors = [], allRequests = [];
    context.on('request', req => allRequests.push([req.method(), new URL(req.url()).pathname]));
    await context.route('**/api/settings-env*', route => route.fulfill({ json: { status: 'disabled', services: {}, snapshot: null, csrf: null } }));
    await context.route('**/api/charging-settings', async route => {
      const req = route.request(); requests.push([req.method(), new URL(req.url()).pathname]);
      if (req.method() === 'POST') {
        posts++; assert.equal(req.headers()['x-csrf-token'], 'c'.repeat(64));
        const data = req.postDataJSON(); assert.deepEqual(Object.keys(data).sort(), ['config', 'revision']);
        if (drop) return route.abort();
        if (conflict) return route.fulfill({ status: 409, json: { schema_version: 1, status: 'conflict', automation_available: false } });
        assert.equal(data.revision, revision); config = data.config; revision = 'a'.repeat(64);
      }
      return route.fulfill({ json: { schema_version: 1, status: disabled ? 'disabled' : 'ok',
        csrf: 'c'.repeat(64), revision, config, automation_available: false } });
    });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(String(e)));
    await page.goto(base + '/einstellungen');
    await page.waitForFunction(() => !document.getElementById('charging-fields').disabled);
    assert.equal(await page.locator('#charging-pv-max_import_w').inputValue(), '');
    assert(await page.locator('#charging-save').isDisabled());
    await page.locator('#charging-pv-max_import_w').fill('123');
    await page.locator('#charging-pv-max_current_ma').fill('10');
    await page.locator('#charging-custom-use_schedule').selectOption('true');
    await page.locator('#charging-custom-pv_enabled').selectOption('true');
    await page.locator('#charging-custom-outside_window').selectOption('pause');
    await page.locator('#charging-day-1').check(); await page.locator('#charging-day-5').check();
    for (const [from, to] of [['07:15', '09:00'], ['22:30', '06:00']]) {
      await page.locator('#charging-add-window').click();
      await page.locator('.charging-window').last().locator('[data-time="from"]').fill(from);
      await page.locator('.charging-window').last().locator('[data-time="to"]').fill(to);
    }
    assert.equal(posts, 0, 'Configuration editing has no write until Save');
    await page.locator('#charging-save').click();
    await page.waitForFunction(() => document.getElementById('charging-status').textContent.includes('Vorlagen gespeichert'));
    assert.equal(posts, 1); assert.equal(config.pv.max_current_ma, 10000);
    assert.deepEqual(config.custom.weekdays, [1, 5]); assert.equal(config.custom.windows.length, 2);
    assert.equal(config.pv.pause_seconds, null, 'No invented timing default');
    await page.reload(); await page.waitForFunction(() => !document.getElementById('charging-fields').disabled);
    assert.equal(await page.locator('#charging-pv-max_import_w').inputValue(), '123');
    assert.equal(await page.locator('.charging-window').count(), 2); assert.equal(posts, 1);
    for (const [width, colorScheme] of [[1440, 'dark'], [390, 'light'], [320, 'light']]) {
      await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ colorScheme });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      fs.mkdirSync('/artifacts', { recursive: true });
      await page.screenshot({ path: `/artifacts/charging-settings-${width}-${colorScheme}.png`, fullPage: true });
    }
    conflict = true; await page.locator('#charging-pv-max_import_w').fill('456'); await page.locator('#charging-save').click();
    await page.waitForFunction(() => document.getElementById('charging-status').textContent.includes('Zwischenzeitlich'));
    assert.equal(await page.locator('#charging-pv-max_import_w').inputValue(), '456'); assert.equal(posts, 2);
    conflict = false; await page.locator('#charging-reload').click();
    await page.waitForFunction(() => document.getElementById('charging-pv-max_import_w').value === '123');
    await page.locator('.charging-window button').last().click(); assert.equal(await page.locator('.charging-window').count(), 1);
    drop = true; await page.locator('#charging-save').click();
    await page.waitForFunction(() => document.getElementById('charging-status').textContent.includes('Speicherstatus unklar'));
    assert(await page.locator('#charging-save').isDisabled()); assert.equal(posts, 3);
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    assert.equal(posts, 3, 'No automatic POST retry after ambiguous save');
    drop = false; disabled = true; await page.locator('#charging-reload').click();
    await page.waitForFunction(() => document.getElementById('charging-fields').disabled);
    assert.equal(posts, 3); assert(requests.every(([method, target]) => target === '/api/charging-settings' && ['GET', 'POST'].includes(method)));
    assert(allRequests.filter(([method]) => method !== 'GET').every(([method, target]) => method === 'POST' && target === '/api/charging-settings'));
    assert.deepEqual(errors, []);
    await context.close(); console.log('Charging profile browser: structured drafts, windows, conflicts, inactive automation, no hardware requests passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
