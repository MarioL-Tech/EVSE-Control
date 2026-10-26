'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = process.env.WEB_TEST_URL || 'http://127.0.0.1:8080';
const origin = new URL(base).origin;
const key = 'evse-theme-v1';
const routes = ['/', '/diagramme'];
let cases = 0;
function sample() {
  const timestamp = new Date().toISOString();
  return { schema_version: 1, read_only: true, status: 'live', reason: 'Aktuelle Wallbox-Messdaten',
    broker_connected: true, availability: 'online', timestamp, last_success_at: timestamp,
    age_seconds: 0, fresh_for_seconds: 10, error: null,
    values: { error_code: 7, socket_lock_state: 273, charging_state_raw: 33024, charging_state: 1,
      below_commanded_current: true, plugged_in: true, charging: false, current_limit_a: 6,
      current_a: [0, 0, 0], voltage_v: [235.7, 233.4, 235.3], active_power_w: 0, session_energy_wh: 0 } };
}
async function ready(page) {
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Live');
  await page.locator('#theme-mode').waitFor();
  assert(await page.locator('#theme-mode').isEnabled());
}
async function colors(page) {
  return page.evaluate(() => {
    const style = getComputedStyle(document.body);
    return [style.backgroundColor, style.color];
  });
}
async function mode(page, expected) {
  assert.equal(await page.locator('#theme-mode').inputValue(), expected);
  assert.equal(await page.locator('html').getAttribute('data-theme'), expected === 'system' ? null : expected);
  if (expected !== 'system') assert.equal(await page.locator('html').evaluate(el => getComputedStyle(el).colorScheme), expected);
}
async function protectedUI(page, route) {
  for (const id of ['status', 'reason', 'timestamp', 'freshness', 'wallbox-warning']) {
    assert(await page.locator(`#${id}`).isVisible(), id);
    assert((await page.locator(`#${id}`).innerText()).trim(), id);
  }
  assert.match(await page.locator('#wallbox-warning').innerText(), /7/);
  assert.notEqual(await page.locator('#timestamp').innerText(), '—');
  assert.notEqual(await page.locator('#freshness').innerText(), '—');
  assert.equal(await page.locator('.sidebar').count(), 1);
  assert.equal(await page.locator('button').count(), 1);
  assert.equal(await page.locator('button').getAttribute('id'), 'reset-display');
  assert.equal(await page.locator('[role="button"], #theme-mode[role]').count(), 0);
  assert.equal(await page.locator('#metric-options input[type="checkbox"]').count(), 16);
  if (route === '/') assert.equal(await page.locator('.summary-card').count(), 4);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth));
}
async function pageshow(page) {
  // Deterministic BFCache lifecycle simulation: actual BFCache admission is browser-dependent.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
}
async function setup(browser, options = {}, blocked = null) {
  const context = await browser.newContext(options), errors = [], requests = [];
  context.setDefaultTimeout(7000); context.setDefaultNavigationTimeout(15000);
  if (blocked) await context.addInitScript(kind => {
    // Playwright also initializes about:blank; its opaque origin has no storage.
    // Install the simulated failure only on the real HTTP(S) application document.
    if (!['http:', 'https:'].includes(location.protocol)) return;
    if (kind === 'getter') Object.defineProperty(window, 'localStorage', { get() { throw new Error('denied'); } });
    else {
      localStorage.setItem('evse-theme-v1', 'dark');
      Storage.prototype.setItem = function () { throw new Error('write denied'); };
      Storage.prototype.removeItem = function () { throw new Error('remove denied'); };
    }
  }, blocked);
  await context.route('**/api/state', route => route.fulfill({ json: sample() }));
  context.on('page', page => {
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', request => requests.push({ method: request.method(), url: request.url() }));
  });
  return { context, page: await context.newPage(), errors, requests };
}
function clean(run) {
  assert.deepEqual(run.errors, [], 'No JavaScript / CSP errors');
  for (const request of run.requests) {
    assert.equal(request.method, 'GET', 'Theme controls must not send commands');
    const url = new URL(request.url); assert.equal(url.origin, origin, 'No foreign resources');
    assert(routes.includes(url.pathname) || url.pathname === '/api/state' || url.pathname.startsWith('/static/')
      || url.pathname === '/favicon.ico', request.url);
  }
  cases++;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  fs.mkdirSync('/artifacts', { recursive: true });
  try {
    // Two pages, both forced modes opposite to the OS, all required breakpoints.
    for (const route of routes) for (const selected of ['light', 'dark']) for (const width of [320, 390, 768, 1440]) {
      const opposite = selected === 'light' ? 'dark' : 'light';
      const run = await setup(browser, { colorScheme: opposite, viewport: { width, height: 900 } });
      try {
        const { page } = run;
        const response = await page.goto(new URL(route, base).href); await ready(page);
        const csp = response.headers()['content-security-policy'];
        assert(csp && csp.split(';').some(part => part.trim() === "script-src 'self'"));
        assert(!/unsafe-inline|unsafe-eval/.test(csp));
        assert.equal(await page.getByLabel('Darstellung', { exact: true }).count(), 1);
        assert.deepEqual(await page.locator('#theme-mode option').evaluateAll(options => options.map(o => [o.value, o.textContent.trim()])),
          [['system', 'System'], ['light', 'Hell'], ['dark', 'Dunkel']]);
        assert.equal(await page.locator('#theme-mode').evaluate(el => el.tagName), 'SELECT');
        const systemColors = await colors(page);
        await page.locator('#theme-mode').selectOption(selected); await mode(page, selected);
        assert.notDeepEqual(await colors(page), systemColors, 'Manual theme must actually override opposite OS colors');
        const forced = await colors(page);
        const brightness = await page.evaluate(() => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          const style = getComputedStyle(document.body);
          function luminance(color) {
            ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
            const pixel = [...ctx.getImageData(0, 0, 1, 1).data];
            if (pixel[3] !== 255) throw new Error('Expected opaque body theme colors');
            const rgb = pixel.slice(0, 3).map(value => {
              const n = value / 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
            });
            return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
          }
          return { background: luminance(style.backgroundColor), foreground: luminance(style.color) };
        });
        assert(selected === 'light' ? brightness.background > brightness.foreground
          : brightness.background < brightness.foreground, `${selected} must have the correct actual color polarity`);
        assert((Math.max(brightness.background, brightness.foreground) + 0.05)
          / (Math.min(brightness.background, brightness.foreground) + 0.05) >= 4.5, 'Body text contrast >= 4.5:1');
        await page.emulateMedia({ colorScheme: selected });
        assert.deepEqual(await colors(page), forced);
        await page.emulateMedia({ colorScheme: opposite });
        assert.deepEqual(await colors(page), forced);
        assert.equal(await page.evaluate(key => localStorage.getItem(key), key), selected);
        await protectedUI(page, route);
        if (width === 320 || width === 1440) await page.screenshot({
          path: `/artifacts/theme-${route === '/' ? 'dashboard' : 'diagrams'}-forced-${selected}-${width}.png`, fullPage: true
        });
        await page.locator('#theme-mode').selectOption('system'); await mode(page, 'system');
        assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null);
        assert.deepEqual(await colors(page), systemColors);
        await page.emulateMedia({ colorScheme: selected });
        assert.deepEqual(await colors(page), forced, 'System follows live OS preference changes');
        clean(run);
      } finally { await run.context.close(); }
    }

    // Real keyboard selection plus same-context navigation/reload and independent display preferences.
    const persisted = await setup(browser, { colorScheme: 'dark' });
    try {
      const { page } = persisted;
      await page.goto(new URL('/', base).href); await ready(page);
      await page.locator('#theme-mode').focus(); await page.keyboard.press('Home');
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await mode(page, 'light');
      await page.locator('.display-options > summary').click();
      await page.locator('#metric-options input').first().uncheck();
      const display = await page.evaluate(() => localStorage.getItem('evse-display-v1'));
      assert(display !== null);
      for (const route of ['/diagramme', '/']) {
        await page.locator(`nav a[href="${route}"]`).click(); await page.waitForURL(new URL(route, base).href);
        await ready(page); await mode(page, 'light');
        await page.reload(); await ready(page); await mode(page, 'light');
        assert.equal(await page.locator('#metric-options input').first().isChecked(), false);
        await page.locator('#theme-mode').selectOption('dark');
        assert.equal(await page.evaluate(() => localStorage.getItem('evse-display-v1')), display);
        await page.locator('#theme-mode').selectOption('light');
      }
      // Lifecycle restores from storage, not stale in-memory state.
      await page.evaluate(key => localStorage.setItem(key, 'dark'), key);
      await pageshow(page); await mode(page, 'dark'); await ready(page);
      // Real cross-document storage events, not synthetic event handlers alone.
      const other = await persisted.context.newPage();
      try {
        await other.goto(new URL('/diagramme', base).href); await ready(other);
        await other.locator('#theme-mode').selectOption('light');
        await page.waitForFunction(() => document.querySelector('#theme-mode').value === 'light');
        await mode(page, 'light');
        await other.locator('#theme-mode').selectOption('system');
        await page.waitForFunction(() => !document.documentElement.hasAttribute('data-theme'));
        await mode(page, 'system');
      } finally { await other.close(); }
      await page.evaluate(key => localStorage.setItem(key, '<img src=x onerror=alert(1)>'), key);
      await pageshow(page); await mode(page, 'system');
      await page.reload(); await ready(page); await mode(page, 'system');
      assert.equal(await page.locator('img').count(), 0);
      assert.equal(await page.evaluate(() => localStorage.getItem('evse-display-v1')), display);
      // A theme change cannot turn failed or expired telemetry back into live measurements.
      await page.route('**/api/state', route => route.fulfill({ json: {
        ...sample(), status: 'read_error', reason: 'Test-Lesefehler', fresh_for_seconds: 0,
        values: null, error: 'Test-Lesefehler'
      } }));
      await page.waitForFunction(() => document.querySelector('#status').textContent === 'Lesefehler');
      await page.locator('#theme-mode').selectOption('dark'); await mode(page, 'dark');
      assert.equal(await page.locator('#status').innerText(), 'Lesefehler');
      assert.equal(await page.locator('#freshness').innerText(), '—');
      assert(!await page.locator('#wallbox-warning').isVisible(), 'Old error-code warning is not presented as current');
      clean(persisted);
    } finally { await persisted.context.close(); }

    for (const blocked of ['getter', 'writes']) for (const route of routes) {
      const run = await setup(browser, { colorScheme: 'dark' }, blocked);
      try {
        const { page } = run;
        await page.goto(new URL(route, base).href); await ready(page);
        for (const selected of ['light', 'system']) {
          await page.locator('#theme-mode').selectOption(selected); await mode(page, selected);
          await pageshow(page); await ready(page); await mode(page, selected);
          if (blocked === 'writes') assert.equal(await page.evaluate(key => localStorage.getItem(key), key), 'dark');
          await protectedUI(page, route);
        }
        clean(run);
      } finally { await run.context.close(); }
    }
    // With JavaScript disabled, the native control must not promise an action it cannot perform.
    const noScript = await setup(browser, { javaScriptEnabled: false });
    try {
      for (const route of routes) {
        const response = await noScript.page.goto(new URL(route, base).href);
        assert.equal(response.status(), 200);
        assert(await noScript.page.locator('#theme-mode').isDisabled());
        const source = await response.text();
        const script = source.match(/<script\b[^>]*src=["'][^"']*\/static\/theme\.js["'][^>]*>/i);
        assert(script, 'Self-hosted theme script is present');
        assert(!/\b(?:async|defer)\b/i.test(script[0]), 'Theme script is synchronous');
        const cssIndex = source.search(/<link\b[^>]*rel=["']stylesheet["']/i);
        assert(cssIndex >= 0 && script.index < cssIndex, 'Theme applies before stylesheet load / first paint');
      }
      clean(noScript);
    } finally { await noScript.context.close(); }
    console.log(`Theme browser: ${cases} cases; forced colors, keyboard, persistence, lifecycle, blocked storage, responsive/CSP/read-only checks passed`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
