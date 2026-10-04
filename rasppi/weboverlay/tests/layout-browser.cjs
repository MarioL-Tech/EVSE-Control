'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = process.env.WEB_TEST_URL || 'http://127.0.0.1:8080';
const routes = ['/', '/diagramme'];

function sample() {
  const timestamp = new Date().toISOString();
  return { schema_version: 1, read_only: true, status: 'live', reason: 'Aktuelle Wallbox-Messdaten',
    broker_connected: true, availability: 'online', timestamp, last_success_at: timestamp,
    age_seconds: 0, fresh_for_seconds: 10, error: null,
    values: { error_code: 7, socket_lock_state: 273, charging_state_raw: 33024, charging_state: 1,
      below_commanded_current: true, plugged_in: true, charging: false, current_limit_a: 6,
      current_a: [0, 0, 0], voltage_v: [235.7, 233.4, 235.3], active_power_w: 0, session_energy_wh: 0 } };
}
async function live(page) {
  await page.waitForFunction(() => document.getElementById('status').textContent === 'Live');
}
async function globals(page) {
  for (const id of ['status', 'reason', 'wallbox-warning', 'timestamp', 'freshness']) {
    assert(await page.locator(`#${id}`).isVisible(), `${id} must remain visible`);
    assert((await page.locator(`#${id}`).innerText()).trim());
  }
  assert.match(await page.locator('#wallbox-warning').innerText(), /7/);
  assert.notEqual(await page.locator('#timestamp').innerText(), '—');
}
async function overflow(page, description) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth
    && document.body.scrollWidth <= innerWidth), description);
}
async function setup(browser, options = {}, denied = false) {
  const context = await browser.newContext(options), errors = [], requests = [];
  if (denied) await context.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage denied'); } });
  });
  await context.route('**/api/state', route => route.fulfill({ json: sample() }));
  context.on('page', page => {
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', request => requests.push({ method: request.method(), url: request.url() }));
  });
  return { context, page: await context.newPage(), errors, requests };
}
function clean(run) {
  assert.deepEqual(run.errors, [], 'Console / page errors (including CSP violations)');
  for (const request of run.requests) {
    assert.equal(request.method, 'GET', 'No commands or other write requests');
    const url = new URL(request.url);
    assert.equal(url.origin, new URL(base).origin, 'No external resources');
    assert(routes.includes(url.pathname) || url.pathname === '/api/state'
      || url.pathname.startsWith('/static/') || url.pathname === '/favicon.ico', request.url);
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  fs.mkdirSync('/artifacts', { recursive: true });
  try {
    for (const route of routes) for (const scheme of ['light', 'dark']) for (const width of [320, 390, 768, 1440]) {
      const run = await setup(browser, { viewport: { width, height: width >= 768 ? 1050 : 844 }, colorScheme: scheme });
      const { page, context } = run;
      try {
        const response = await page.goto(new URL(route, base).href);
        assert.equal(response.status(), 200);
        const csp = response.headers()['content-security-policy'];
        for (const directive of ["default-src 'self'", "script-src 'self'", "style-src 'self'",
          "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'none'"])
          assert(csp && csp.split(';').some(part => part.trim() === directive), directive);
        assert(!/unsafe-inline|unsafe-eval/.test(csp));
        await live(page);
        assert.equal(await page.locator('h1').count(), 1);
        assert.equal(await page.locator('h1').innerText(), route === '/' ? 'Übersicht' : 'Diagramme');
        assert(await page.locator('h2').count() > 0);
        assert.equal(await page.locator('nav[aria-label="Hauptnavigation"]').count(), 1);
        assert.deepEqual(await page.locator('nav a').evaluateAll(links => links.map(a => a.getAttribute('href'))), routes);
        assert.equal(await page.locator('nav [aria-current="page"]').count(), 1);
        assert.equal(await page.locator('nav [aria-current="page"]').getAttribute('href'), route);
        assert(await page.evaluate(() => {
          const ids = [...document.querySelectorAll('[id]')].map(el => el.id);
          return new Set(ids).size === ids.length;
        }), 'Unique DOM IDs');
        assert.equal(await page.locator('form, input:not([type="checkbox"]), [role="button"], [role="checkbox"]').count(), 0);
        assert.equal(await page.locator('button').count(), 1);
        assert.equal(await page.locator('button').getAttribute('id'), 'reset-display');
        assert.equal(await page.locator('button').getAttribute('type'), 'button');
        const boxes = page.locator('#metric-options input[type="checkbox"]');
        assert.equal(await boxes.count(), 16);
        assert(await boxes.evaluateAll(inputs => inputs.every(input => input.checked && !input.disabled
          && [...input.labels].some(label => label.textContent.trim()))), 'Native labelled checkboxes');
        assert.equal(await page.locator('details[open]').count(), 0);
        if (route === '/') {
          assert.equal(await page.locator('.summary-card').count(), 4);
          assert.equal(await page.locator('#chart-grid, .chart-card, .chart-line').count(), 0);
          assert.equal(await page.locator('#power').innerText(), '0,00 kW');
          assert.equal(await page.locator('#plugged').innerText(), 'Ja');
          assert.equal(await page.locator('#charging').innerText(), 'Nein');
        } else {
          assert.equal(await page.locator('#chart-grid > figure').count(), 4);
          assert.equal(await page.locator('.history-diagnostics figure').count(), 5);
          assert.equal(await page.locator('#chart-grid svg[role="img"][aria-label]').count(), 4);
          await page.waitForFunction(() => document.querySelector('#chart-grid .chart-line'));
        }
        await globals(page);
        await overflow(page, `${route} ${scheme} ${width}: default`);
        const size = { 390: 'mobile', 768: 'tablet', 1440: 'desktop' }[width];
        if (size) await page.screenshot({ path: `/artifacts/${route === '/' ? 'dashboard' : 'diagrams'}-${scheme}-${size}.png`, fullPage: true });
        await page.locator('.display-options > summary').click();
        await overflow(page, `${route} ${width}: display options`);
        await page.locator('.technical-details > summary').click();
        await overflow(page, `${route} ${width}: technical details`);
        await page.locator('.technical-details > summary').click();
        for (let i = 0; i < 16; i++) await boxes.nth(i).uncheck();
        assert(await boxes.evaluateAll(inputs => inputs.every(input => !input.checked)));
        await globals(page);
        assert(await page.locator('#display-empty').isVisible());
        assert.equal(await page.locator('.summary-card:visible, .chart-card:visible').count(), 0);
        await overflow(page, `${route} ${width}: all off`);
        await page.locator('#reset-display').click();
        assert(await boxes.evaluateAll(inputs => inputs.every(input => input.checked)));
        clean(run);
      } finally { await context.close(); }
    }
    // Real keyboard navigation and shared persistence, without comparing changing clock text / SVG paths.
    const run = await setup(browser);
    try {
      await run.page.goto(new URL('/', base).href); await live(run.page);
      await run.page.keyboard.press('Tab');
      assert(await run.page.locator('.skip-link').evaluate(el => el === document.activeElement));
      await run.page.keyboard.press('Enter');
      assert(await run.page.locator('#main-content').evaluate(el => el === document.activeElement));
      await run.page.locator('.display-options > summary').click();
      await run.page.locator('#metric-options input').first().uncheck();
      assert(await run.page.evaluate(() => localStorage.getItem('evse-display-v1') !== null));
      await run.page.locator('nav a[href="/diagramme"]').focus(); await run.page.keyboard.press('Enter');
      await run.page.waitForURL(new URL('/diagramme', base).href); await live(run.page);
      assert.equal(await run.page.locator('#metric-options input').first().isChecked(), false);
      await run.page.reload(); await live(run.page);
      assert.equal(await run.page.locator('#metric-options input').first().isChecked(), false);
      clean(run);
    } finally { await run.context.close(); }
    for (const route of routes) {
      const denied = await setup(browser, {}, true);
      try {
        await denied.page.goto(new URL(route, base).href); await live(denied.page);
        await denied.page.locator('.display-options > summary').click();
        const first = denied.page.locator('#metric-options input').first();
        await first.uncheck(); assert.equal(await first.isChecked(), false);
        await globals(denied.page);
        await denied.page.reload(); await live(denied.page);
        assert.equal(await first.isChecked(), true); clean(denied);
      } finally { await denied.context.close(); }
    }
    const failure = await setup(browser);
    try {
      await failure.page.goto(new URL('/diagramme', base).href); await live(failure.page);
      await failure.page.route('**/api/state', route => route.fulfill({ json: {
        ...sample(), status: 'read_error', reason: '<img src=x onerror=alert(1)>',
        fresh_for_seconds: 0, values: null, error: 'Test-Lesefehler'
      } }));
      await failure.page.waitForFunction(() => document.getElementById('status').textContent === 'Lesefehler');
      assert.equal(await failure.page.locator('#freshness').innerText(), '—');
      assert.equal(await failure.page.locator('#reason').innerText(), '<img src=x onerror=alert(1)>');
      assert.equal(await failure.page.locator('img').count(), 0);
      assert(!await failure.page.locator('#wallbox-warning').isVisible(), 'Stale hardware warning not kept as current');
      clean(failure);
    } finally { await failure.context.close(); }
    console.log('Layout browser: both pages, dark/light, 320/390/768/1440px, navigation, keyboard, CSP, storage and protected status passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
