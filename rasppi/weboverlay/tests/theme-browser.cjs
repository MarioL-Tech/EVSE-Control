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
async function logo(page) {
  assert.equal(await page.locator('.brand-logo').count(), 1);
  assert.equal(await page.locator('.brand-logo').getAttribute('alt'), '');
  assert.equal(await page.locator('.brand-logo').getAttribute('src'), '/static/icon.svg');
  assert.equal(await page.locator('link[rel="icon"]').getAttribute('href'), '/static/icon.svg');
  await page.waitForFunction(() => {
    const image = document.querySelector('.brand-logo');
    return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
  });
}
async function ready(page) {
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Live');
  await page.locator('#theme-toggle').waitFor();
  await page.waitForFunction(() => {
    const toggle = document.getElementById('theme-toggle');
    return toggle && !toggle.disabled;
  });
  assert(await page.locator('#theme-toggle').isEnabled());
  await logo(page);
}
async function colors(page) {
  return page.evaluate(() => {
    const style = getComputedStyle(document.body);
    return [style.backgroundColor, style.color];
  });
}
async function mode(page, expected) {
  assert.equal(await page.locator('html').getAttribute('data-theme'), expected === 'system' ? null : expected);
  if (expected !== 'system') assert.equal(await page.locator('html').evaluate(el => getComputedStyle(el).colorScheme), expected);
  const effective = await page.locator('html').getAttribute('data-effective-theme');
  assert.equal(await page.locator('#theme-toggle').getAttribute('aria-checked'), String(effective === 'dark'));
  assert.equal(await page.locator('.theme-moon').isVisible(), effective === 'dark');
  assert.equal(await page.locator('.theme-sun').isVisible(), effective === 'light');
  const toggle = page.getByRole('switch', { name: 'Dunkles Design', exact: true });
  assert.equal(await toggle.evaluate(el => el.tagName), 'INPUT');
  assert.equal(await toggle.getAttribute('type'), 'checkbox');
  assert.equal(await toggle.isChecked(), effective === 'dark');
  assert.equal((await page.locator('#theme-caption').innerText()).replace(/\s+/g, ' ').trim(), effective === 'dark' ? 'DARK MODE' : 'LIGHT MODE');
  assert(await page.locator('#theme-caption').isVisible());
  await page.waitForFunction(dark => {
    const track = document.querySelector('.theme-track').getBoundingClientRect();
    const thumb = document.querySelector('.theme-thumb').getBoundingClientRect();
    const center = thumb.x + thumb.width / 2;
    return dark ? center > track.x + track.width * 0.7 : center < track.x + track.width * 0.3;
  }, effective === 'dark');
}
async function switchLayout(page) {
  assert.equal(await page.locator('.quick-controls').count(), 0);
  assert.deepEqual(await page.locator('nav[aria-label="Hauptnavigation"] a').evaluateAll(links => links.map(a => [a.getAttribute('href'), a.textContent.trim()])),
    [['/', 'Übersicht'], ['/wallbox', 'Wallbox'], ['/diagramme', 'Diagramme'], ['/einstellungen', 'Settings']]);
  const settings = page.getByRole('link', { name: 'Settings', exact: true });
  assert.equal(await settings.locator('svg').count(), 1);
  const label = page.locator('label.theme-switch');
  assert.equal(await label.locator('#theme-toggle').count(), 1);
  assert.equal(await page.locator('.sidebar .sidebar-footer .theme-switch').count(), 1);
  const [control, track, thumb, input] = await Promise.all([
    label.boundingBox(), page.locator('.theme-track').boundingBox(),
    page.locator('.theme-thumb').boundingBox(), page.locator('#theme-toggle').boundingBox()
  ]);
  assert(control && track && thumb && input);
  assert(Math.abs(track.width - 160) <= 1 && Math.abs(track.height - 52) <= 1, '160×52 native switch pill');
  assert(Math.abs(thumb.width - 42) <= 1 && Math.abs(thumb.height - 42) <= 1, '42px sliding thumb');
  for (const axis of ['x', 'y', 'width', 'height']) assert(Math.abs(input[axis] - control[axis]) <= 1, 'Input covers the entire clickable label');
  assert.equal(await page.locator('#theme-toggle').evaluate(el => getComputedStyle(el).opacity), '0');
  assert.equal(await page.locator('#theme-toggle').evaluate(el => getComputedStyle(el).position), 'absolute');
  const viewport = page.viewportSize(), bottom = viewport.height - control.y - control.height;
  if (viewport.width > 900) {
    const sidebar = await page.locator('.sidebar').boundingBox();
    assert(control.x >= sidebar.x && control.x + control.width <= sidebar.x + sidebar.width);
    assert(Math.abs(control.x - 18) <= 2 && Math.abs(bottom - 30) <= 3, 'Desktop switch at sidebar bottom left');
    assert.equal(await page.locator('.sidebar-footer').evaluate(el => getComputedStyle(el).position === 'fixed'), false);
    const diagrams = await page.getByRole('link', { name: 'Diagramme', exact: true }).boundingBox();
    const gear = await settings.boundingBox();
    assert(gear.y >= diagrams.y + diagrams.height, 'Settings follows Diagramme vertically');
  } else {
    assert.equal(await page.locator('.sidebar-footer').evaluate(el => getComputedStyle(el).position), 'fixed');
    assert(Math.abs(control.x - 12) <= 2 && Math.abs(bottom - 12) <= 2, 'Mobile switch fixed bottom left');
    const previousScroll = await page.evaluate(() => scrollY);
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    const scrolled = await label.boundingBox();
    assert(Math.abs(scrolled.x - 12) <= 2 && Math.abs(viewport.height - scrolled.y - scrolled.height - 12) <= 2,
      'Mobile switch remains reachable after scrolling');
    await page.evaluate(y => scrollTo(0, y), previousScroll);
  }
}
async function choose(page, selected) {
  if (selected === 'system') {
    const route = new URL(page.url()).pathname;
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.waitForURL(new URL('/einstellungen', base).href);
    assert.match(await page.locator('main').innerText(), /Dienstkonfiguration/);
    await page.locator('#theme-system').click();
    if (route !== '/einstellungen') {
      await page.locator(`nav a[href="${route}"]`).click();
      await ready(page);
    }
  } else if (await page.locator('html').getAttribute('data-theme') !== selected) {
    if (await page.locator('html').getAttribute('data-effective-theme') === selected) await page.locator('#theme-toggle').click();
    await page.locator('#theme-toggle').click();
  }
  await mode(page, selected);
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
  assert.deepEqual(await page.locator('button:not([data-calendar-period])').evaluateAll(nodes => nodes.map(n => n.id).sort()),
    (route === '/' ? ['control-apply', 'control-start', 'control-stop'] : ['calendar-load', 'calendar-next', 'calendar-now', 'calendar-prev', 'reset-display']).sort());
  assert.equal(await page.locator('[role="button"], #theme-mode[role]').count(), 0);
  assert.equal(await page.locator('.display-options, #metric-options, .history-note').count(), 0);
  assert.equal(await page.locator('ul.chart-options input[type="checkbox"]').count(), route === '/' ? 0 : 16);
  if (route === '/diagramme') {
    assert.equal(await page.locator('ul.chart-options').count(), 9);
    assert.equal(await page.locator('button[data-calendar-period]').count(), 7);
    assert(!await page.locator('#calendar-mode').isVisible());
    assert(await page.locator('.section-heading #reset-display').isVisible());
  } else assert.equal(await page.locator('#reset-display').count(), 0);
  assert.equal(await page.locator('.current-data h2').innerText(), 'Aktuelle Wallbox-Messdaten');
  assert(await page.locator('.current-data').evaluate(panel => {
    const visible = [...document.querySelectorAll('main > section')].filter(el => !el.hidden);
    const warning = document.getElementById('wallbox-warning');
    return visible.at(-1) === panel && warning.tagName === 'P' && warning.parentElement.tagName === 'MAIN'
      && !!(warning.compareDocumentPosition(visible[0]) & Node.DOCUMENT_POSITION_FOLLOWING);
  }));
  if (route === '/') assert.equal(await page.locator('.summary-card').count(), 4);
  await switchLayout(page);
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
  await context.route('**/api/wallbox-control', route => route.fulfill({ json: {
    status: 'unavailable', csrf: null, inspection: null, command: null, command_sent: false
  } }));
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
    if (url.pathname === '/api/history') assert.equal(url.search, '?minutes=15');
    assert(routes.includes(url.pathname) || ['/einstellungen', '/api/state', '/api/smartmeter', '/api/history', '/api/house-history', '/api/settings-env', '/api/wallbox-control'].includes(url.pathname) || url.pathname.startsWith('/static/')
      || ['/favicon.ico', '/manifest.webmanifest', '/service-worker.js'].includes(url.pathname), request.url);
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
        assert.equal(await page.getByRole('switch', { name: 'Dunkles Design' }).count(), 1);
        assert.equal(await page.locator('#theme-mode').count(), 0);
        const systemColors = await colors(page);
        await choose(page, selected);
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
        await choose(page, 'system');
        assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null);
        assert.deepEqual(await colors(page), systemColors);
        await page.emulateMedia({ colorScheme: selected });
        assert.deepEqual(await colors(page), forced, 'System follows live OS preference changes');
        clean(run);
      } finally { await run.context.close(); }
    }

    // The editor is off by default; the catalog does not poll hardware or MQTT.
    for (const width of [320, 390, 768, 1440]) for (const scheme of ['light', 'dark']) {
      const run = await setup(browser, { colorScheme: scheme, viewport: { width, height: 900 } });
      try {
        const { page } = run;
        await page.goto(new URL('/einstellungen', base).href);
        await logo(page);
        await page.waitForFunction(() => !document.getElementById('theme-toggle').disabled);
        assert.equal(await page.title(), 'Settings · EVSE Control');
        assert.equal(await page.locator('h1').innerText(), 'Settings');
        await page.waitForFunction(() => document.getElementById('env-status').textContent === 'Konfigurationseditor noch nicht freigeschaltet');
        assert.match(await page.locator('main').innerText(), /Dienstkonfiguration/);
        assert(await page.locator('#env-save').isDisabled());
        assert.equal(await page.locator('#env-fields').evaluate(fieldset => fieldset.disabled), true);
        assert.equal(await page.locator('#env-fields input:enabled').count(), 0);
        assert.equal(await page.locator('#env-form').count(), 1);
        assert.deepEqual(await page.locator('button').evaluateAll(nodes => nodes.map(n => n.id)), ['env-save', 'env-reload', 'theme-system']);
        assert.equal(await page.locator('.pwa-card, #pwa-heading, #pwa-install, #pwa-update').count(), 0);
        assert.equal(await page.getByRole('link', { name: 'Settings', exact: true }).getAttribute('aria-current'), 'page');
        await mode(page, 'system'); await switchLayout(page);
        await page.locator('#theme-toggle').focus(); await page.keyboard.press('Enter');
        await mode(page, 'system'); // Native checkboxes toggle with Space, not Enter.
        await page.keyboard.press('Space');
        await mode(page, scheme === 'dark' ? 'light' : 'dark');
        await page.keyboard.press('Space'); await mode(page, scheme);
        await page.keyboard.press('Space'); await mode(page, scheme === 'dark' ? 'light' : 'dark');
        await page.locator('#theme-system').click(); await mode(page, 'system');
        assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        const cardWidths = await page.locator('.settings-placeholder > .card').evaluateAll(cards => cards.map(el => {
          const main = el.closest('main'), css = getComputedStyle(main);
          return Math.abs(el.getBoundingClientRect().width - (main.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight))) < 2;
        }));
        assert(cardWidths.every(Boolean), 'Settings cards use the full available browser content width');
        assert.deepEqual(run.requests.filter(request => new URL(request.url).pathname.startsWith('/api/'))
          .map(request => [request.method, new URL(request.url).pathname]), [['GET', '/api/settings-env']],
          'Settings reads only its disabled catalog, never measurement/SQL APIs or commands');
        if (width === 320 || width === 1440) await page.screenshot({
          path: `/artifacts/settings-${scheme}-${width}.png`, fullPage: true
        });
        clean(run);
      } finally { await run.context.close(); }
    }

    // Hold a deferred script so the full HTML/CSS can paint before DOMContentLoaded.
    // This catches a saved dark choice rendered as an unchecked/light switch on navigation.
    for (const selected of ['dark', 'light']) for (const width of [390, 1440]) {
      const run = await setup(browser, {
        colorScheme: selected === 'dark' ? 'light' : 'dark', viewport: { width, height: 900 }
      });
      let release;
      try {
        await run.context.addInitScript(({ key, selected }) => localStorage.setItem(key, selected), { key, selected });
        let gate;
        await run.context.route('**/static/pwa.js', async route => { await gate; await route.continue(); });
        for (const path of ['/', '/diagramme', '/einstellungen', null]) {
          gate = new Promise(resolve => { release = resolve; });
          if (path) await run.page.goto(new URL(path, base).href, { waitUntil: 'commit' });
          else await run.page.reload({ waitUntil: 'commit' });
          await run.page.waitForFunction(() => document.querySelector('.theme-thumb') &&
            getComputedStyle(document.querySelector('.theme-thumb')).width === '42px');
          const before = await run.page.evaluate(() => {
            const thumb = document.querySelector('.theme-thumb'), label = document.querySelector('.theme-mode-label');
            return {
              disabled: document.getElementById('theme-toggle').disabled,
              checked: document.getElementById('theme-toggle').checked,
              effective: document.documentElement.dataset.effectiveTheme,
              preference: document.documentElement.dataset.theme,
              transform: getComputedStyle(thumb).transform,
              caption: getComputedStyle(label, '::after').content,
              moon: getComputedStyle(document.querySelector('.theme-moon')).display,
              track: getComputedStyle(document.querySelector('.theme-track')).backgroundColor
            };
          });
          assert.equal(before.disabled, true, 'Still before binding / DOMContentLoaded');
          assert.equal(before.checked, false, 'Parser checkbox default must not control first paint');
          assert.equal(before.effective, selected);
          assert.equal(before.preference, selected);
          assert.equal(before.transform, selected === 'dark' ? 'matrix(1, 0, 0, 1, 108, 0)' : 'none');
          assert.match(before.caption, selected === 'dark' ? /DARK/ : /LIGHT/);
          assert.equal(before.moon, selected === 'dark' ? 'block' : 'none');
          assert.equal(before.track, selected === 'dark' ? 'rgb(5, 10, 16)' : 'rgb(226, 232, 240)');
          release();
          await run.page.waitForLoadState('load');
          await mode(run.page, selected);
          assert.equal(await run.page.locator('.theme-thumb').evaluate(el => getComputedStyle(el).transform), before.transform);
          assert.equal(await run.page.evaluate(key => localStorage.getItem(key), key), selected);
        }
        clean(run);
      } finally { if (release) release(); await run.context.close(); }
    }

    // Real keyboard selection plus same-context navigation/reload and independent display preferences.
    const persisted = await setup(browser, { colorScheme: 'dark' });
    try {
      const { page } = persisted;
      await page.goto(new URL('/', base).href); await ready(page);
      await page.locator('#theme-toggle').focus(); await page.keyboard.press('Space'); await mode(page, 'light');
      await page.locator('nav a[href="/diagramme"]').click(); await page.waitForURL(new URL('/diagramme', base).href);
      await ready(page); await mode(page, 'light');
      await page.locator('#show-power').uncheck();
      const display = await page.evaluate(() => localStorage.getItem('evse-display-v1'));
      assert(display !== null);
      for (const route of ['/diagramme', '/']) {
        await page.locator(`nav a[href="${route}"]`).click(); await page.waitForURL(new URL(route, base).href);
        await ready(page); await mode(page, 'light');
        await page.reload(); await ready(page); await mode(page, 'light');
        if (route === '/diagramme') {
          assert.equal(await page.locator('#show-power').isChecked(), false);
          assert(await page.locator('#chart-power').isVisible());
          assert(!await page.locator('#chart-power svg').isVisible());
        } else {
          assert.equal(await page.locator('.display-options, #metric-options, #reset-display').count(), 0);
          assert(await page.locator('#power').isVisible(), 'Diagram preferences never suppress overview values');
          assert.equal(await page.locator('.summary-card:visible').count(), 4);
        }
        await choose(page, 'dark');
        assert.equal(await page.evaluate(() => localStorage.getItem('evse-display-v1')), display);
        await choose(page, 'light');
      }
      // Lifecycle restores from storage, not stale in-memory state.
      await page.evaluate(key => localStorage.setItem(key, 'dark'), key);
      await pageshow(page); await mode(page, 'dark'); await ready(page);
      // Real cross-document storage events, not synthetic event handlers alone.
      const other = await persisted.context.newPage();
      try {
        await other.goto(new URL('/diagramme', base).href); await ready(other);
        await choose(other, 'light');
        await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
        await mode(page, 'light');
        await choose(other, 'system');
        await page.waitForFunction(() => !document.documentElement.hasAttribute('data-theme'));
        await mode(page, 'system');
      } finally { await other.close(); }
      await page.evaluate(key => localStorage.setItem(key, '<img src=x onerror=alert(1)>'), key);
      await pageshow(page); await mode(page, 'system');
      await page.reload(); await ready(page); await mode(page, 'system');
      assert.equal(await page.locator('img').count(), 1);
      assert.equal(await page.locator('.brand-mark img[src="/static/icon.svg"]').count(), 1);
      assert.equal(await page.evaluate(() => localStorage.getItem('evse-display-v1')), display);
      // A theme change cannot turn failed or expired telemetry back into live measurements.
      await page.route('**/api/state', route => route.fulfill({ json: {
        ...sample(), status: 'read_error', reason: 'Test-Lesefehler', fresh_for_seconds: 0,
        values: null, error: 'Test-Lesefehler'
      } }));
      await page.waitForFunction(() => document.querySelector('#status').textContent === 'Lesefehler');
      await choose(page, 'dark');
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
        for (const selected of ['light', 'dark', 'light']) {
          await choose(page, selected);
          await pageshow(page); await ready(page); await mode(page, selected);
          if (blocked === 'writes') assert.equal(await page.evaluate(key => localStorage.getItem(key), key), 'dark');
          await protectedUI(page, route);
        }
        // A denied persistence operation is intentionally page-local, including System reset.
        await page.goto(new URL('/einstellungen', base).href);
        await page.locator('#theme-system').click(); await mode(page, 'system');
        await pageshow(page); await mode(page, 'system');
        assert(await page.locator('#env-save').isDisabled());
        assert.equal(await page.locator('#env-fields input:enabled').count(), 0);
        clean(run);
      } finally { await run.context.close(); }
    }
    // Enabled editor UI with synthetic responses only: real file/CSRF checks
    // run separately in the disposable PHP test image, never on this backend.
    const editor = await setup(browser, { viewport: { width: 390, height: 900 } });
    try {
      const { page } = editor, posts = [];
      let revision = 'a'.repeat(64), port = '8080', configured = true, conflict = false;
      const definitions = {
        WEB_PORT: { type: 'integer', min: 1, max: 65535, secret: false, readonly: false, choices: [] },
        SMARTMETER_URL: { type: 'url', min: null, max: null, secret: true, readonly: false, choices: [] },
        HISTORY_DB_PASSWORD_HOST_FILE: { type: 'mount', min: null, max: null, secret: true, readonly: true, choices: [] }
      };
      const response = () => ({ status: 'ok', csrf: 'isolated-csrf-fixture',
        services: { uart: {}, wallbox: {}, storage: {}, weboverlay: definitions },
        snapshot: { status: 'ok', service: 'weboverlay', revision, entries: {
          WEB_PORT: { present: true, configured: true, secret: false, readonly: false, value: port },
          SMARTMETER_URL: { present: true, configured, secret: true, readonly: false },
          HISTORY_DB_PASSWORD_HOST_FILE: { present: true, configured: true, secret: true, readonly: true }
        } } });
      await editor.context.route('**/api/settings-env*', async route => {
        if (route.request().method() === 'POST') {
          const body = route.request().postDataJSON(); posts.push(body);
          assert.equal(route.request().headers()['x-csrf-token'], 'isolated-csrf-fixture');
          assert.equal(body.revision, revision);
          if (conflict) return route.fulfill({ status: 409, json: { status: 'conflict' } });
          if (Object.hasOwn(body.changes, 'WEB_PORT')) port = body.changes.WEB_PORT;
          if (Object.hasOwn(body.changes, 'SMARTMETER_URL')) configured = body.changes.SMARTMETER_URL !== '';
          revision = (revision[0] === 'a' ? 'b' : 'c').repeat(64);
        }
        await route.fulfill({ json: response() });
      });
      await page.goto(new URL('/einstellungen', base).href);
      await page.waitForFunction(() => !document.getElementById('env-fields').disabled);
      assert.equal(await page.locator('#env-key-SMARTMETER_URL').inputValue(), '');
      assert(await page.locator('#env-key-HISTORY_DB_PASSWORD_HOST_FILE').isDisabled());
      assert(await page.locator('#env-save').isDisabled());
      await page.locator('#env-key-WEB_PORT').fill('8081');
      await page.locator('#env-save').click();
      await page.waitForFunction(() => document.getElementById('env-status').textContent.startsWith('.env gespeichert;'));
      assert.deepEqual(posts[0].changes, { WEB_PORT: '8081' }, 'Untouched secret omitted');
      await page.locator('#env-key-SMARTMETER_URL-clear').check();
      await page.locator('#env-save').click();
      await page.waitForFunction(() => document.getElementById('env-status').textContent.startsWith('.env gespeichert;') && !document.getElementById('env-fields').disabled);
      assert.deepEqual(posts[1].changes, { SMARTMETER_URL: '' }, 'Secret clear must be explicit');
      conflict = true;
      await page.locator('#env-key-WEB_PORT').fill('8082');
      await page.locator('#env-save').click();
      await page.waitForFunction(() => document.getElementById('env-status').textContent.startsWith('Konflikt:'));
      assert.equal(await page.locator('#env-key-WEB_PORT').inputValue(), '8082');
      assert(await page.locator('#env-save').isDisabled());
      page.once('dialog', dialog => dialog.accept());
      await page.locator('#env-reload').click();
      await page.waitForFunction(() => document.getElementById('env-status').textContent === 'Konfiguration geladen.');
      assert.equal(await page.locator('#env-key-WEB_PORT').inputValue(), '8081');
      assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), []);
      assert.equal(await page.locator('#env-key-SMARTMETER_URL').inputValue(), '');
      assert.equal(editor.errors.filter(e => !e.includes('409')).length, 0);
      assert(editor.requests.filter(r => r.method !== 'GET').every(r => new URL(r.url).pathname === '/api/settings-env'));
      cases++;
    } finally { await editor.context.close(); }
    // With JavaScript disabled, the native control must not promise an action it cannot perform.
    const noScript = await setup(browser, { javaScriptEnabled: false });
    try {
      for (const route of [...routes, '/einstellungen']) {
        const response = await noScript.page.goto(new URL(route, base).href);
        assert.equal(response.status(), 200);
        assert(await noScript.page.locator('#theme-toggle').isDisabled());
        assert.equal(await noScript.page.locator('#theme-toggle').getAttribute('type'), 'checkbox');
        assert.equal(await noScript.page.locator('#theme-toggle').getAttribute('role'), 'switch');
        if (route === '/einstellungen') assert(await noScript.page.locator('#theme-system').isDisabled());
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
