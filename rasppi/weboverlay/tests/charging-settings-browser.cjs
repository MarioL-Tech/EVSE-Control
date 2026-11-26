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
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, hasTouch: true, colorScheme: 'dark', locale: 'de-AT', serviceWorkers: 'block' });
    // Independent inspection fixture: never contact the ESP32 MQTT gateway.
    await context.route('**/api/esp32-control', route => {
      assert.equal(route.request().method(), 'GET', 'No ESP32 commands in this fixture');
      return route.fulfill({ json: { status: 'unavailable', csrf: null, inspection: null,
        command: null, command_sent: false } });
    });
    let config = defaults(), revision = null, posts = 0, conflict = false, disabled = false, drop = false, hold = false, release = null;
    const requests = [], errors = [], allRequests = [];
    context.on('request', req => allRequests.push([req.method(), new URL(req.url()).pathname]));
    await context.route('**/api/settings-env*', route => {
      const req = route.request(), service = new URL(req.url()).searchParams.get('service');
      assert.equal(req.method(), 'GET', 'Help/editing/reload must not write .env');
      const def = { type: 'integer', min: 1, max: 65535, secret: false, readonly: false, choices: [] };
      const baseUrl = { type: 'url', min: null, max: null, secret: true, readonly: false, choices: [] };
      return route.fulfill({ json: { status: 'ok', csrf: 'mock-only', services: { uart: {}, wallbox: { WALLBOX_AUTOMATION_WEB_URL: baseUrl }, storage: {}, weboverlay: { WEB_PORT: def } },
        snapshot: { service, status: 'missing', revision: null, entries: service === 'weboverlay' ? {
          WEB_PORT: { present: false, configured: false, readonly: false, secret: false, value: null } } : service === 'wallbox' ? {
          WALLBOX_AUTOMATION_WEB_URL: { present: false, configured: false, readonly: false, secret: true } } : {} } } });
    });
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
    // Each trigger has a real text description; help is usable even where no
    // field value is known. Neither hovering nor activating help writes data.
    const phases = page.locator('#charging-installation-phases');
    const help = page.locator('.setting-field').filter({ has: phases }).locator('.setting-help'), trigger = help.locator('summary');
    const text = help.locator('[role="tooltip"]');
    assert.equal(await phases.inputValue(), '');
    await trigger.hover(); assert(await text.isVisible());
    await text.hover(); assert(await text.isVisible(), 'Pointer can enter and read the open explanation');
    await page.mouse.move(1, 1); assert(await text.isHidden());
    await trigger.focus(); assert(await text.isVisible()); await page.keyboard.press('Escape'); assert(await text.isHidden());
    await phases.focus(); assert(await text.isVisible(), 'Focusing the field opens its explanation');
    await page.keyboard.press('Escape'); assert(await text.isHidden());
    await page.locator('h1').click(); await phases.hover(); assert(await text.isVisible(), 'Hovering the field opens its explanation');
    await page.mouse.move(1, 1); assert(await text.isHidden());
    await phases.focus(); await trigger.tap(); assert(await text.isVisible()); await trigger.tap(); assert(await text.isHidden());
    const descriptionId = await text.getAttribute('id');
    assert((await phases.getAttribute('aria-describedby')).split(/\s+/).includes(descriptionId));
    assert.equal(await trigger.getAttribute('aria-describedby'), descriptionId);
    assert.equal(await trigger.getAttribute('aria-label'), 'Info: ' + await page.locator(`label[for="charging-installation-phases"]`).innerText());
    assert(await trigger.evaluate(el => el.getBoundingClientRect().width >= 44 && el.getBoundingClientRect().height >= 44),
      'Touch help keeps a small icon inside a full touch target');
    assert.equal(posts, 0);
    fs.mkdirSync('/artifacts', { recursive: true });
    await page.screenshot({ path: '/artifacts/charging-settings-collapsed-1440-dark.png', fullPage: true });
    await page.waitForFunction(() => !document.getElementById('env-fields').disabled);
    await page.locator('.env-group > summary').click();
    const port = page.locator('#env-key-WEB_PORT');
    assert.equal(await port.inputValue(), ''); assert.match(await port.getAttribute('placeholder'), /^z\. B\./);
    await port.fill('65536'); assert.equal(await port.getAttribute('aria-invalid'), 'true');
    await page.locator('#env-create').check(); assert(await page.locator('#env-save').isDisabled());
    await port.fill('8081'); await port.press('Enter'); assert(!(await page.locator('#env-save').isDisabled()));
    assert(await page.locator('#charging-save').isDisabled(), 'Dirty .env does not dirty charging rules');
    await page.locator('#env-service').selectOption('wallbox');
    await page.waitForFunction(() => !document.getElementById('env-fields').disabled && !document.getElementById('env-key-WEB_PORT'));
    await page.locator('.env-group > summary').filter({ hasText: 'Gerät & Regelung' }).click();
    const origin = page.locator('#env-key-WALLBOX_AUTOMATION_WEB_URL');
    assert.equal(await origin.getAttribute('placeholder'), 'z. B. http://weboverlay:8080');
    assert.equal(await origin.inputValue(), '', 'A base origin example must not populate a new secret value');
    await page.locator('#env-service').selectOption('weboverlay');
    await page.waitForFunction(() => !document.getElementById('env-fields').disabled && document.getElementById('env-key-WEB_PORT')?.value === '8081');
    assert(!(await page.locator('#env-create').isChecked()), 'Missing file creation must be confirmed for this selection');
    assert(await page.locator('#env-save').isDisabled());
    await port.fill(''); assert.equal(await page.locator('#env-status').innerText(), 'Keine .env vorhanden.');
    await page.locator('.env-group > summary').click();
    for (const summary of await page.locator('details.charging-profile > summary').all()) await summary.click();
    assert.equal(await page.locator('#charging-pv-max_import_w').inputValue(), '');
    assert(await page.locator('#charging-save').isDisabled());
    assert.match(await page.locator('#charging-pv-max_import_w').getAttribute('placeholder'), /^z\. B\./);
    await page.locator('#charging-pv-max_import_w').fill('250');
    assert(await page.locator('#charging-save').isEnabled(), 'Partial profiles with unknown phases, topology and timings remain saveable drafts');
    await page.locator('#charging-pv-max_import_w').press('Enter'); assert.equal(posts, 0, 'Enter in a draft field cannot submit');
    await page.locator('#charging-pv-max_import_w').fill(''); assert(await page.locator('#charging-save').isDisabled(), 'Reverting a draft clears dirty state');
    await page.locator('#charging-pv-max_import_w').fill('-1');
    assert.equal(await page.locator('#charging-pv-max_import_w').getAttribute('aria-invalid'), 'true');
    assert.match(await page.locator('#charging-pv-max_import_w-error').innerText(), /0 bis 100000/);
    assert(await page.locator('#charging-save').isDisabled(), 'Invalid draft cannot display an enabled green save action');
    assert.equal(await page.locator('#charging-status').innerText(), 'Ungespeichert. Markierte Eingaben prüfen.');
    assert.equal(await page.locator('#charging-pv-max_import_w').evaluate(el => el.validity.rangeUnderflow), true, 'Real native range validation is retained');
    await page.locator('details.charging-profile > summary').nth(1).click();
    await page.locator('#charging-form').evaluate(el => el.requestSubmit());
    await page.waitForFunction(() => document.getElementById('charging-pv-max_import_w').closest('details').open);
    assert.equal(posts, 0, 'Invalid collapsed profile opens without saving');
    await page.locator('#charging-pv-max_import_w').fill('123');
    assert(await page.locator('#charging-save').isEnabled());
    for (const value of ['100001', '0.5', '1e3']) {
      await page.locator('#charging-pv-max_import_w').fill(value);
      assert(await page.locator('#charging-save').isDisabled(), `Invalid numeric draft ${value} blocks saving`);
      await page.locator('#charging-form').evaluate(el => el.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
      assert.equal(posts, 0, 'Synthetic submit cannot bypass validation');
    }
    await page.locator('#charging-pv-max_import_w').fill('123');
    await page.locator('#charging-pv-max_current_ma').fill('10');
    await page.locator('#charging-custom-use_schedule').selectOption('true');
    assert(await page.locator('#charging-save').isEnabled(), 'Missing activation prerequisites (days/windows) alone do not invalidate a saved draft');
    await page.locator('#charging-custom-pv_enabled').selectOption('true');
    await page.locator('#charging-custom-outside_window').selectOption('pause');
    await page.locator('#charging-day-1').check(); await page.locator('#charging-day-5').check();
    for (const [from, to] of [['07:15', '09:00'], ['22:30', '06:00']]) {
      await page.locator('#charging-add-window').click();
      assert(await page.locator('#charging-save').isDisabled(), 'New incomplete window is a genuinely invalid draft');
      await page.locator('.charging-window').last().locator('[data-time="from"]').fill(from);
      await page.locator('.charging-window').last().locator('[data-time="to"]').fill(to);
    }
    const secondWindow = page.locator('.charging-window').last();
    await secondWindow.locator('[data-time="to"]').fill('22:30');
    assert.match(await secondWindow.locator('.setting-error:visible').innerText(), /verschieden/);
    assert(await page.locator('#charging-save').isDisabled(), 'Equal endpoints block saving');
    await secondWindow.locator('[data-time="from"]').fill('07:15');
    await secondWindow.locator('[data-time="to"]').fill('09:00');
    assert.match(await secondWindow.locator('.setting-error:visible').innerText(), /bereits vorhanden/);
    assert(await page.locator('#charging-save').isDisabled(), 'Duplicate windows block saving');
    await secondWindow.locator('[data-time="from"]').fill('22:30');
    await secondWindow.locator('[data-time="to"]').fill('06:00');
    assert.equal(await secondWindow.locator('.setting-error:visible').count(), 0);
    assert(await page.locator('#charging-save').isEnabled(), 'Correcting schedules restores save without requiring optional fields');
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
      assert(await page.locator('.charging-days label').evaluateAll(labels =>
        labels.every(label => label.getBoundingClientRect().height >= 44)), 'Weekdays have touch-sized labels');
      assert(await page.locator('#charging-fields input:not([type=checkbox]), #charging-fields select, #env-key-WEB_PORT, #env-service, #esp32-uid').evaluateAll(inputs =>
        inputs.every(input => parseFloat(getComputedStyle(input).fontSize) >= 16)), 'Touch editing text is at least 16px');
      fs.mkdirSync('/artifacts', { recursive: true });
      await page.screenshot({ path: `/artifacts/charging-settings-${width}-${colorScheme}.png`, fullPage: true });
    }
    // Exercise actual focus, scrolling, wrapping and hit targets in a short
    // mobile viewport, rather than accepting a full-page screenshot as proof.
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 480 });
      const uid = page.locator('#esp32-uid');
      await uid.focus();
      const uidHelp = page.locator('.setting-heading[data-setting-info="esp32-uid"] .setting-help');
      assert(await uidHelp.locator('.setting-tip').isVisible());
      assert(await page.evaluate(() => {
        const heading = document.querySelector('[data-setting-info="esp32-uid"]');
        const tip = heading.querySelector('.setting-tip').getBoundingClientRect();
        const actions = document.querySelector('#esp32-rfid .esp32-actions').getBoundingClientRect();
        const input = document.getElementById('esp32-uid').getBoundingClientRect();
        const revoke = document.getElementById('esp32-revoke').getBoundingClientRect();
        return tip.top >= Math.max(actions.bottom, input.bottom, revoke.bottom) - 1 && tip.left >= 0 && tip.right <= innerWidth;
      }), 'UID explanation reserves real space below both groups without moving the revoke button');
      await page.keyboard.press('Escape');
      await page.locator('#esp32-enroll').scrollIntoViewIfNeeded();
      assert(await page.locator('#esp32-enroll').evaluate(el => {
        const r = el.getBoundingClientRect();
        return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;
      }), 'Enrollment action is hit-testable, not covered by UID help');
      const invalid = page.locator('#charging-pv-max_import_w');
      await invalid.fill('-1');
      await page.waitForFunction(() => {
        const error = document.getElementById('charging-pv-max_import_w-error').getBoundingClientRect();
        return error.top >= 0 && error.bottom <= innerHeight;
      });
      await page.locator('#charging-reload').focus();
      await invalid.focus();
      await page.waitForFunction(() => {
        const field = document.getElementById('charging-pv-max_import_w').getBoundingClientRect();
        const error = document.getElementById('charging-pv-max_import_w-error').getBoundingClientRect();
        return field.top >= 0 && error.bottom <= innerHeight && error.top >= field.bottom;
      });
      assert(await page.locator('#charging-pv-max_import_w-error').isVisible(), 'Focusing invalid field reveals input and inline error together');
      await invalid.fill('123');
      assert(await page.locator('#charging-save').isDisabled(), 'Returning to the saved value clears the invalid draft and dirty state');
      assert(await page.locator('#charging-status').isHidden());
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    conflict = true; await page.locator('#charging-pv-max_import_w').fill('456'); await page.locator('#charging-save').click();
    await page.waitForFunction(() => document.getElementById('charging-status').textContent.includes('Zwischenzeitlich'));
    assert.equal(await page.locator('#charging-pv-max_import_w').inputValue(), '456'); assert.equal(posts, 2);
    conflict = false; page.once('dialog', d => d.dismiss()); await page.locator('#charging-reload').click();
    assert.equal(await page.locator('#charging-pv-max_import_w').inputValue(), '456');
    page.once('dialog', d => d.accept()); await page.locator('#charging-reload').click();
    await page.waitForFunction(() => document.getElementById('charging-pv-max_import_w').value === '123');
    await page.locator('.charging-window button').last().click(); assert.equal(await page.locator('.charging-window').count(), 1);
    drop = true; await page.locator('#charging-save').click();
    await page.waitForFunction(() => document.getElementById('charging-status').textContent.includes('Speicherstatus unklar'));
    assert(await page.locator('#charging-save').isDisabled()); assert.equal(posts, 3);
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    assert.equal(posts, 3, 'No automatic POST retry after ambiguous save');
    drop = false; page.once('dialog', d => d.accept()); await page.locator('#charging-reload').click();
    await page.waitForFunction(() => !document.getElementById('charging-fields').disabled);
    hold = true; await page.locator('#charging-pv-max_import_w').fill('789');
    await page.locator('#charging-save').click();
    await page.waitForFunction(() => document.getElementById('charging-save').disabled);
    for (let i = 0; i < 100 && !release; i++) await page.waitForTimeout(10);
    assert(release, 'Bounded in-flight save fixture entered');
    assert.equal(await page.locator('#charging-status').innerText(), 'Regeln werden gespeichert …', 'Pending save is distinct from unsaved/saved');
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await page.waitForFunction(() => document.getElementById('charging-status').textContent.includes('Speicherstatus unklar'));
    release();
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    assert(await page.locator('#charging-save').isDisabled()); assert.equal(posts, 4, 'Pagehide cannot replay or confirm a late save');
    hold = false; disabled = true; page.once('dialog', d => d.accept()); await page.locator('#charging-reload').click();
    await page.waitForFunction(() => document.getElementById('charging-fields').disabled);
    assert.equal(posts, 4); assert(requests.every(([method, target]) => target === '/api/charging-settings' && ['GET', 'POST'].includes(method)));
    assert(allRequests.filter(([method]) => method !== 'GET').every(([method, target]) => method === 'POST' && target === '/api/charging-settings'));
    assert.deepEqual(errors, []);
    await context.close(); console.log('Charging profile browser: structured drafts, windows, conflicts, inactive automation, no hardware requests passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
