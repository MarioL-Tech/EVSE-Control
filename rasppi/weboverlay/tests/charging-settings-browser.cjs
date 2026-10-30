'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = process.env.WEB_TEST_URL || 'http://127.0.0.1:8080';
const defaults = () => {
  const limits = { max_import_w: null, max_current_ma: null, adjust_seconds: null, pause_seconds: null, resume_seconds: null };
  return { schema_version: 1, timezone: 'Europe/Vienna', manual: { current_ma: null }, pv: { ...limits },
    installation: { phases: null, meter_includes_wallbox: null },
    custom: { ...limits, use_schedule: null, pv_enabled: null, weekdays: [], windows: [], outside_window: null } };
};
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark', locale: 'de-AT', serviceWorkers: 'block' });
    // Independent inspection fixture: never contact the ESP32 MQTT gateway.
    await context.route('**/api/esp32-control', route => {
      assert.equal(route.request().method(), 'GET', 'No ESP32 commands in this fixture');
      return route.fulfill({ json: { status: 'unavailable', csrf: null, inspection: null,
        command: null, command_sent: false } });
    });
    let config = defaults(), revision = null, posts = 0, conflict = false, disabled = false, drop = false, hold = false, release = null;
    const requests = [], errors = [], allRequests = [];
    context.on('request', req => allRequests.push([req.method(), new URL(req.url()).pathname]));
    await context.route('**/api/settings-env*', route => route.fulfill({ json: { status: 'disabled',
      services: { uart: {}, wallbox: {}, storage: {}, weboverlay: {} }, snapshot: null, csrf: null } }));
    await context.route('**/api/charging-settings', async route => {
      const req = route.request(); requests.push([req.method(), new URL(req.url()).pathname]);
      if (req.method() === 'POST') {
        posts++; assert.equal(req.headers()['x-csrf-token'], 'c'.repeat(64));
        const data = req.postDataJSON(); assert.deepEqual(Object.keys(data).sort(), ['config', 'revision']);
        if (drop) return route.abort();
        if (hold) {
          await new Promise(resolve => { release = resolve; });
          return route.fulfill({ json: { schema_version: 1, status: 'ok', csrf: 'c'.repeat(64),
            revision: 'a'.repeat(64), config, automation_available: false } }).catch(() => {});
        }
        if (conflict) return route.fulfill({ status: 409, json: { schema_version: 1, status: 'conflict', automation_available: false } });
        assert.equal(data.revision, revision); config = data.config; revision = 'a'.repeat(64);
      }
      return route.fulfill({ json: { schema_version: 1, status: disabled ? 'disabled' : 'ok',
        csrf: 'c'.repeat(64), revision, config, automation_available: false } });
    });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(String(e)));
    await page.goto(base + '/einstellungen');
    await page.waitForFunction(() => !document.getElementById('charging-fields').disabled);
    assert.equal(await page.locator('details.charging-profile').count(), 3);
    assert.equal(await page.locator('details.charging-profile[open]').count(), 0, 'Profiles initially collapse');
    assert(await page.locator('#charging-status').isHidden(), 'No boilerplate while idle');
    fs.mkdirSync('/artifacts', { recursive: true });
    await page.screenshot({ path: '/artifacts/charging-settings-collapsed-1440-dark.png', fullPage: true });
    for (const summary of await page.locator('details.charging-profile > summary').all()) await summary.click();
    assert.equal(await page.locator('#charging-pv-max_import_w').inputValue(), '');
    assert(await page.locator('#charging-save').isDisabled());
    await page.locator('#charging-pv-max_import_w').fill('-1');
    await page.locator('details.charging-profile').nth(1).locator('summary').click();
    await page.locator('#charging-save').click();
    await page.waitForFunction(() => document.getElementById('charging-pv-max_import_w').closest('details').open);
    assert.equal(posts, 0, 'Invalid collapsed profile opens without saving');
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
    await page.waitForFunction(() => document.getElementById('charging-status').textContent === 'Gespeichert.');
    assert.equal(posts, 1); assert.equal(config.pv.max_current_ma, 10000);
    assert.deepEqual(config.custom.weekdays, [1, 5]); assert.equal(config.custom.windows.length, 2);
    assert.equal(config.pv.pause_seconds, null, 'No invented timing default');
    await page.reload(); await page.waitForFunction(() => !document.getElementById('charging-fields').disabled);
    assert.equal(await page.locator('details.charging-profile[open]').count(), 0);
    for (const summary of await page.locator('details.charging-profile > summary').all()) await summary.click();
    assert.equal(await page.locator('#charging-pv-max_import_w').inputValue(), '123');
    assert.equal(await page.locator('.charging-window').count(), 2); assert.equal(posts, 1);
    for (const [width, colorScheme] of [[1440, 'dark'], [390, 'light'], [320, 'light']]) {
      await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ colorScheme });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert(await page.locator('.charging-profile input[type="number"], .charging-window input').evaluateAll(inputs =>
        inputs.every(input => input.getBoundingClientRect().height >= 44)), 'Numeric/time inputs have touch-sized targets');
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
    drop = false; await page.locator('#charging-reload').click();
    await page.waitForFunction(() => !document.getElementById('charging-fields').disabled);
    hold = true; await page.locator('#charging-pv-max_import_w').fill('789');
    await page.locator('#charging-save').click();
    await page.waitForFunction(() => document.getElementById('charging-save').disabled);
    for (let i = 0; i < 100 && !release; i++) await page.waitForTimeout(10);
    assert(release, 'Bounded in-flight save fixture entered');
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await page.waitForFunction(() => document.getElementById('charging-status').textContent.includes('Speicherstatus unklar'));
    release();
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    assert(await page.locator('#charging-save').isDisabled()); assert.equal(posts, 4, 'Pagehide cannot replay or confirm a late save');
    hold = false; disabled = true; await page.locator('#charging-reload').click();
    await page.waitForFunction(() => document.getElementById('charging-fields').disabled);
    assert.equal(posts, 4); assert(requests.every(([method, target]) => target === '/api/charging-settings' && ['GET', 'POST'].includes(method)));
    assert(allRequests.filter(([method]) => method !== 'GET').every(([method, target]) => method === 'POST' && target === '/api/charging-settings'));
    assert.deepEqual(errors, []);
    await context.close(); console.log('Charging profile browser: structured drafts, windows, conflicts, inactive automation, no hardware requests passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
