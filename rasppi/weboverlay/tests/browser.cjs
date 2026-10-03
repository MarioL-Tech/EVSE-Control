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
  let networkFailure = false;
  await page.route('**/api/state', route => networkFailure ? route.abort() : route.fulfill({ json: data }));
  try {
    await page.goto(process.env.WEB_TEST_URL || 'http://127.0.0.1:8080');
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Live');
    assert.equal(await page.locator('#plugged').innerText(), 'Ja');
    assert.equal(await page.locator('#charging').innerText(), 'Nein');
    assert.equal(await page.locator('#limit').innerText(), '6,0 A');
    assert.equal(await page.locator('#voltage-0').innerText(), '235,7 V');
    assert.equal(await page.locator('button, input, form').count(), 0);
    fs.mkdirSync('/artifacts', { recursive: true });
    await page.screenshot({ path: '/artifacts/weboverlay-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'light' });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile horizontal overflow');
    await page.screenshot({ path: '/artifacts/weboverlay-mobile.png', fullPage: true });
    data = { ...data, values: { ...data.values, plugged_in: null, charging: null, error_code: 7 } };
    await page.waitForFunction(() => document.getElementById('plugged').textContent === 'Unbekannt');
    assert.equal(await page.locator('#wallbox-error').innerText(), 'Wallbox-Fehler · Code 7');
    data = { ...data, status: 'read_error', values: null, fresh_for_seconds: 0,
      error: '<img src=x onerror=alert(1)>', reason: 'Lesefehler' };
    await page.waitForFunction(() => document.getElementById('read-error').textContent.includes('<img'));
    assert.equal(await page.locator('#power').innerText(), '—');
    assert.equal(await page.locator('#plugged').innerText(), 'Unbekannt');
    assert.equal(await page.locator('img').count(), 0, 'MQTT text must not create markup');
    networkFailure = true;
    await page.waitForFunction(() => document.getElementById('reason').textContent.includes('nicht abgerufen'));
    assert.equal(await page.locator('#current-0').innerText(), '—');
    assert.deepEqual(errors, []);
    console.log('Browser: live/unknown/offline, safe text rendering, mobile layout and network failure passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
