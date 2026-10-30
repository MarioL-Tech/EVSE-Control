'use strict';
// Simulated UI/transport evidence only; no UART, production gateway or servo.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.TEST_URL || process.env.WEB_TEST_URL || 'http://127.0.0.1:8080';
const artifacts = process.env.ARTIFACT_DIR || '/artifacts';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const unavailable = { status: 'unavailable', csrf: null, inspection: null, command: null, command_sent: false };
function result(patch = {}) {
  return { schema_version: 1, id: 'a'.repeat(32), session: 'b'.repeat(32), lease: 'c'.repeat(32),
    operation: 'inspect', status: 'ok', reason: 'ready', fresh_for_seconds: 8, firmware_version: 2,
    state: { charging: false, antitheft: false, store_ready: true, cards: 0, enrolling: false, reader_ready: true, servo_ready: true },
    command_sent: false, result_code: null, ...patch };
}
function envelope(r = result(), command = null) {
  return { status: 'ok', csrf: 'd'.repeat(64), inspection: r, command, command_sent: !!command };
}
(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    for (const layout of [
      { width: 1440, height: 1000, colorScheme: 'dark', url: '/', root: 'esp32-control', image: 'ESP32manual1440dark.png' },
      { width: 390, height: 1000, colorScheme: 'light', url: '/', root: 'esp32-control', image: 'ESP32manual390light.png' },
      { width: 320, height: 1100, colorScheme: 'light', url: '/einstellungen', root: 'esp32-rfid', image: 'RFIDsettings320light.png' }
    ]) {
      const context = await browser.newContext({ viewport: { width: layout.width, height: layout.height }, colorScheme: layout.colorScheme });
      let current = result(), getMode = 'ok', postMode = 'ok', pendingPost = null;
      let posts = 0, gets = 0;
      const errors = [], bodies = [];
      // Prevent access to unrelated sources. The existing app remains independently offline.
      await context.route('**/api/**', route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/state') return route.fulfill({ json: {
          schema_version: 1, read_only: true, status: 'offline', reason: 'MQTT nicht verbunden.', broker_connected: false,
          availability: null, timestamp: null, last_success_at: null, age_seconds: null, fresh_for_seconds: 0, values: null, error: null
        } });
        if (url.pathname === '/api/settings-env') return route.fulfill({ json: { status: 'disabled', services: [], enabled: false } });
        if (url.pathname === '/api/smartmeter') return route.fulfill({ json: {
          schema_version: 1, read_only: true, status: 'disabled', reason: 'Nicht eingerichtet.', power_w: null,
          fetched_at: null, age_seconds: null, fresh_for_seconds: 0
        } });
        return route.fulfill({ json: unavailable });
      });
      await context.route('**/api/esp32-control', async route => {
        if (route.request().method() === 'POST') {
          posts++;
          // This is a synthetic fixture UID, never printed or put in artifacts.
          const body = route.request().postDataJSON(); bodies.push(body);
          assert.deepEqual(Object.keys(body).sort(), body.operation === 'revoke' ? ['operation', 'uid'] : ['operation']);
          assert(route.request().headers()['x-csrf-token']);
          if (postMode === 'hang') { pendingPost = route; return; }
          if (postMode === '400' || postMode === '403') return route.fulfill({ status: Number(postMode), json: {
            ...unavailable, status: postMode === '400' ? 'invalid' : 'forbidden'
          } });
          if (postMode === 'unknown') return route.fulfill({ json: { ...unavailable, status: 'outcome_unknown', command_sent: true } });
          return route.fulfill({ json: envelope(current, result({ operation: body.operation, status: 'acknowledged', command_sent: true })) });
        }
        gets++;
        if (getMode === 'hang') return; // Browser timeout, not a real gateway outage.
        if (getMode === 'offline') return route.fulfill({ status: 503, json: unavailable });
        return route.fulfill({ json: envelope(current) });
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base + layout.url);
      const root = page.locator('#' + layout.root);
      await root.waitFor({ state: 'visible' });
      const settings = layout.root === 'esp32-rfid', prefix = settings ? 'esp32-rfid-' : 'esp32-';
      const status = page.locator('#' + prefix + 'status'), action = page.locator('#esp32-' + (settings ? 'enroll' : 'lock'));
      const resultText = page.locator('#' + prefix + 'result');
      await page.waitForFunction(id => !document.getElementById(id).disabled, settings ? 'esp32-enroll' : 'esp32-lock');
      assert.equal(posts, 0, 'Inspection must never auto-enroll or write');
      await page.evaluate(id => {
        window.espStatusMutations = 0;
        new MutationObserver(records => { window.espStatusMutations += records.length; })
          .observe(document.getElementById(id), { childList: true, characterData: true, subtree: true });
      }, prefix + 'status');
      await delay(1000);
      assert.equal(await page.evaluate(() => window.espStatusMutations), 0, 'Unchanged freshness ticks do not rewrite the live region');
      if (settings) {
        assert.equal(await page.locator('#esp32-rfid-count').innerText(), '0 / 16');
        assert.equal(await page.locator('#esp32-uid').getAttribute('type'), 'password');
        assert.equal(await page.locator('#esp32-uid').getAttribute('autocomplete'), 'off');
        assert(await page.locator('#esp32-cancel').isDisabled());
      } else {
        assert.match(await page.locator('#esp32-state').innerText(), /inaktiv/);
      }
      await page.screenshot({ path: path.join(artifacts, layout.image), fullPage: true });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No page overflow');
      // Keyboard activation follows the same explicit one-POST path.
      await action.focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(id => document.getElementById(id).textContent.includes('Firmware bestätigt'), prefix + 'result');
      assert.equal(posts, 1);
      getMode = 'offline';
      await page.waitForFunction(id => document.getElementById(id).textContent.includes('nicht verfügbar'), prefix + 'status');
      assert.match(await resultText.innerText(), /Firmware bestätigt/, 'GET failure retains last action result');
      assert(await action.isDisabled());
      getMode = 'ok';
      current = result({ firmware_version: null });
      await delay(5200); assert(await action.isDisabled(), 'No legacy firmware fallback');
      current = result({ state: { ...result().state, store_ready: false } });
      await page.waitForFunction(id => document.getElementById(id).textContent.includes('Speicher'), prefix + 'status');
      assert(await action.isDisabled());
      current = result({ state: { ...result().state, reader_ready: false } });
      await page.waitForFunction(id => document.getElementById(id).textContent.includes('RFID-Leser'), prefix + 'status');
      assert.equal(await action.isDisabled(), settings, 'Reader failure blocks enrollment, not lock/unlock');
      current = result({ state: { ...result().state, servo_ready: false } });
      await page.waitForFunction(id => document.getElementById(id).textContent.includes('Servo'), prefix + 'status');
      assert(await action.isDisabled());
      current = result();
      await page.waitForFunction(id => !document.getElementById(id).disabled, settings ? 'esp32-enroll' : 'esp32-lock');
      for (const code of ['400', '403', 'unknown']) {
        postMode = code; await action.click();
        await page.waitForFunction(({ id, unknown }) => document.getElementById(id).textContent.includes(unknown ? 'Ausgang unbekannt' : 'Nicht gesendet'),
          { id: prefix + 'result', unknown: code === 'unknown' });
        await page.waitForFunction(id => !document.getElementById(id).disabled, settings ? 'esp32-enroll' : 'esp32-lock');
      }
      getMode = 'offline'; await delay(2200);
      assert.match(await resultText.innerText(), /Ausgang unbekannt/, 'Inspection failure cannot resolve an unknown POST');
      getMode = 'ok'; postMode = 'ok';
      await page.waitForFunction(id => !document.getElementById(id).disabled, settings ? 'esp32-enroll' : 'esp32-lock');
      if (settings) {
        const privateUid = ['12', '34', '56', '78'].join(':');
        await page.locator('#esp32-uid').fill(privateUid);
        await page.locator('#esp32-revoke').click();
        assert.equal(await page.locator('#esp32-uid').inputValue(), '');
        await page.waitForFunction(() => document.getElementById('esp32-rfid-result').textContent.includes('Firmware bestätigt'));
        assert.equal(bodies.at(-1).uid, privateUid);
        assert(!(await page.locator('body').innerText()).includes(privateUid));
        assert(!(await page.content()).includes(privateUid));
        assert(!page.url().includes(privateUid));
        assert(!(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).includes(privateUid));
        current = result({ state: { ...result().state, cards: 16, enrolling: true } });
        await page.waitForFunction(() => document.getElementById('esp32-rfid-count').textContent === '16 / 16');
        assert(await action.isDisabled()); assert(!(await page.locator('#esp32-cancel').isDisabled()));
        await page.evaluate(() => dispatchEvent(new CustomEvent('evse:manual-mode', { detail: { manual: false } })));
        assert(await root.isVisible(), 'Settings independent of charge mode');
      } else {
        postMode = 'hang'; await action.click();
        await page.waitForFunction(() => document.getElementById('esp32-result').textContent.includes('Aktion läuft'));
        assert(await page.locator('#esp32-unlock').isDisabled());
        const before = posts;
        await page.evaluate(() => dispatchEvent(new CustomEvent('evse:manual-mode', { detail: { manual: false } })));
        assert(await root.isHidden());
        const stoppedGets = gets; await delay(2200); assert.equal(gets, stoppedGets);
        if (pendingPost) await pendingPost.fulfill({ json: envelope(current, result({ operation: 'lock', status: 'acknowledged', command_sent: true })) }).catch(() => {});
        await page.evaluate(() => dispatchEvent(new CustomEvent('evse:manual-mode', { detail: { manual: true } })));
        await root.waitFor({ state: 'visible' });
        await delay(100); assert.match(await resultText.innerText(), /Ausgang unbekannt/);
        assert.equal(posts, before, 'No lifecycle replay');
        // ESP32 does not hide/remove the independent wallbox controller.
        assert(await page.locator('#wallbox-control').isVisible());
        getMode = 'hang'; await delay(8500);
        assert(await action.isDisabled(), 'Freshness expires without another successful response');
        assert.match(await page.locator('#esp32-state').innerText(), /unbekannt/);
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
