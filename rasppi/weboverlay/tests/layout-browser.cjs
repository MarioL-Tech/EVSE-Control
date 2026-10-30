'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = process.env.WEB_TEST_URL || 'http://127.0.0.1:8080';
const routes = ['/', '/diagramme'];
const palettes = {
  dark: { bg: '#0c151a', surface: '#111b22', 'surface-top': '#18242d', border: '#2b3c47',
    text: '#edf4f8', muted: '#acc0cb', accent: '#55dab6', 'on-accent': '#072b23',
    blue: '#8bbaff', 'blue-soft': '#172b3a', 'power-top': '#14364c',
    'power-bg': '#10212b', 'power-text': '#c7f4ff' },
  light: { bg: '#f2f5f6', surface: '#f8fafb', 'surface-top': '#ffffff', border: '#cbd6de',
    text: '#172630', muted: '#4f6472', accent: '#006b51', 'on-accent': '#ffffff',
    blue: '#2e638f', 'blue-soft': '#e8eef3', 'power-top': '#deedf6',
    'power-bg': '#edf4f8', 'power-text': '#123b54' }
};

async function compactTheme(page, scheme) {
  const signature = await page.evaluate(tokens => {
    const root = getComputedStyle(document.documentElement);
    const probe = document.createElement('canvas').getContext('2d');
    const normalize = color => { probe.fillStyle = color; return probe.fillStyle; };
    return {
      tokens: Object.fromEntries(Object.keys(tokens).map(name =>
        [name, root.getPropertyValue(`--${name}`).trim().toLowerCase()])),
      badges: ['#status', '#grid-status'].flatMap(selector => {
        const element = document.querySelector(selector);
        if (!element || !element.getClientRects().length || element.textContent.trim() !== 'Live') return [];
        const style = getComputedStyle(element);
        return [{ selector, background: normalize(style.backgroundColor), color: normalize(style.color) }];
      }),
      weights: [...document.querySelectorAll('h1, h2, #power')].map(element =>
        ({ selector: element.id || element.tagName, weight: getComputedStyle(element).fontWeight,
          expected: element.matches('.summary-card .card-top h2') ? '650' : '700' }))
    };
  }, palettes[scheme]);
  assert.deepEqual(signature.tokens, palettes[scheme], `${scheme}: effective Compact / Dense palette`);
  assert(signature.badges.some(badge => badge.selector === '#status'), 'Live wallbox badge is checked');
  for (const badge of signature.badges) {
    assert.equal(badge.background, palettes[scheme].accent, `${scheme} ${badge.selector}: filled live badge`);
    assert.equal(badge.color, palettes[scheme]['on-accent'], `${scheme} ${badge.selector}: live foreground`);
  }
  for (const { selector, weight, expected } of signature.weights)
    assert.equal(weight, expected, `${selector}: restrained bold weight`);
}

async function layoutFreeze(page, width, route) {
  const layout = await page.evaluate(() => {
    const properties = (selector, names) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      return Object.fromEntries(names.map(name => [name, style[name]]));
    };
    return {
      shell: properties('.app-shell', ['display']),
      sidebar: properties('.sidebar', ['position', 'width']),
      main: properties('#main-content', ['paddingTop']),
      overview: properties('.overview', ['gridTemplateColumns', 'gap']),
      summary: properties('.summary-card', ['minHeight']),
      measurements: properties('.details-grid.measurements', ['gridTemplateColumns', 'gap'])
    };
  });
  assert.equal(layout.shell.display, width > 900 ? 'grid' : 'block', 'Unchanged shell breakpoint');
  assert.equal(layout.sidebar.position, width > 900 ? 'sticky' : 'static', 'Unchanged sidebar positioning');
  if (width > 900) assert.equal(layout.sidebar.width, '224px');
  assert.equal(layout.main.paddingTop, width > 900 ? '36px' : width > 480 ? '28px' : '24px');
  const bounds = await page.evaluate(() => {
    const main = document.getElementById('main-content');
    const box = main.getBoundingClientRect(), style = getComputedStyle(main);
    const header = main.querySelector('.page-header').getBoundingClientRect();
    return { left: box.left, right: box.right, width: box.width,
      viewport: document.documentElement.clientWidth,
      sidebarRight: document.querySelector('.sidebar').getBoundingClientRect().right,
      paddingLeft: parseFloat(style.paddingLeft), paddingRight: parseFloat(style.paddingRight),
      headerLeft: header.left, headerRight: header.right };
  });
  const expectedLeft = width > 900 ? bounds.sidebarRight : 0;
  const expectedPadding = width > 900 ? Math.min(44, Math.max(20, width * 0.03)) : width > 480 ? 24 : 16;
  const near = (actual, expected, message) => assert(Math.abs(actual - expected) <= 1,
    `${route} ${width}: ${message} (${actual} vs ${expected})`);
  near(bounds.left, expectedLeft, 'main begins immediately after sidebar');
  near(bounds.right, bounds.viewport, 'main reaches available viewport edge without a width cap');
  near(bounds.width, bounds.viewport - expectedLeft, 'main spans all available width');
  near(bounds.paddingLeft, expectedPadding, 'left content padding preserved');
  near(bounds.paddingRight, expectedPadding, 'right content padding preserved');
  near(bounds.headerLeft, bounds.left + bounds.paddingLeft, 'content respects left padding');
  near(bounds.headerRight, bounds.right - bounds.paddingRight, 'content respects right padding');
  if (route === '/') {
    // auto-fit reports collapsed empty tracks as 0px; they are not visible columns.
    const columns = grid => grid.gridTemplateColumns.trim().split(/\s+/)
      .filter(track => parseFloat(track) > 0).length;
    assert.equal(columns(layout.overview), width > 1200 ? 4 : width > 480 ? 2 : 1, 'Four/two/one summary columns');
    assert.equal(layout.overview.gap, '16px');
    assert.equal(layout.summary.minHeight, width > 480 ? '134px' : '140px');
    assert.equal(columns(layout.measurements), width >= 704 ? 2 : 1, 'Phase/house measurements retain auto-fit layout');
    assert.equal(layout.measurements.gap, '16px');
  }
}

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
  await page.waitForFunction(() => document.getElementById('status')?.textContent === 'Live');
}
async function paint(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
}
async function globals(page) {
  for (const id of ['status', 'reason', 'wallbox-warning', 'timestamp', 'freshness']) {
    assert(await page.locator(`#${id}`).isVisible(), `${id} must remain visible`);
    assert((await page.locator(`#${id}`).innerText()).trim());
  }
  assert.match(await page.locator('#wallbox-warning').innerText(), /7/);
  assert.notEqual(await page.locator('#timestamp').innerText(), '—');
  assert(await page.evaluate(() => {
    const main = document.getElementById('main-content');
    const content = [...main.children].filter(element => element.tagName !== 'NOSCRIPT');
    return content[0].matches('.page-header') && content[1].id === 'wallbox-warning'
      && content.at(-1).matches('.status-panel.current-data');
  }), 'Warning above content; current-data panel last on both pages');
}
async function overflow(page, description) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth
    && document.body.scrollWidth <= innerWidth), description);
}
async function textContrast(page, scheme) {
  const ratios = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    function rgba(color) {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    }
    function over(foreground, background) {
      const alpha = foreground[3] / 255;
      return foreground.slice(0, 3).map((value, i) => value * alpha + background[i] * (1 - alpha));
    }
    function luminance(rgb) {
      const linear = rgb.map(value => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    }
    // Composite transparent surface colors over their ancestors; no fixed palette.
    const root = getComputedStyle(document.documentElement);
    function contrast(element, background) {
      const foreground = over(rgba(getComputedStyle(element).color), background);
      const a = luminance(foreground), b = luminance(background);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    }
    const ratios = ['body', '.status-panel', '.card', '.metadata', '.subtle',
      '.nav-link[aria-current="page"]', '#status', '#grid-status', '#wallbox-warning', 'summary', '#power'].flatMap(selector => {
      const element = document.querySelector(selector);
      if (!element || !element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') return [];
      const ancestors = [];
      for (let node = element; node; node = node.parentElement) ancestors.unshift(node);
      let background = [255, 255, 255];
      for (const node of ancestors) background = over(rgba(getComputedStyle(node).backgroundColor), background);
      return { selector, ratio: contrast(element, background) };
    });
    // Computed backgroundColor alone misses the brighter end of a card gradient.
    for (const selector of ['.status-panel', '.card', '.metadata', '.subtle', '#power']) {
      for (const element of document.querySelectorAll(selector)) {
        if (!element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') continue;
        const endpoints = element.id === 'power' ? ['power-top', 'power-bg'] : ['surface-top', 'surface'];
        for (const token of endpoints)
          ratios.push({ selector: `${selector} against --${token}`,
            ratio: contrast(element, rgba(root.getPropertyValue(`--${token}`).trim())) });
      }
    }
    return ratios;
  });
  for (const { selector, ratio } of ratios)
    assert(ratio >= 4.5, `${scheme} ${selector}: normal text contrast ${ratio.toFixed(2)} must be >= 4.5:1`);
}
async function systemTheme(page, scheme) {
  async function settle(expected) {
    await page.waitForFunction(value => getComputedStyle(document.documentElement).colorScheme === value
      && document.documentElement.dataset.effectiveTheme === value, expected);
  }
  const colors = () => page.evaluate(() => ['body', '#main-content', '.status-panel'].map(selector => {
    const style = getComputedStyle(document.querySelector(selector));
    return [style.backgroundColor, style.color];
  }));
  // Palette/contrast checks compare stable end states; the independent theme suite
  // still exercises the actual sliding motion with the normal motion preference.
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  assert(await page.evaluate(value => matchMedia(`(prefers-color-scheme: ${value})`).matches, scheme));
  await settle(scheme);
  const initial = await colors();
  assert.equal(await page.locator('.card').first().evaluate(element => getComputedStyle(element).borderTopLeftRadius), '6px', 'Compact theme uses restrained card rounding');
  await compactTheme(page, scheme);
  await textContrast(page, scheme);
  await page.emulateMedia({ colorScheme: scheme === 'light' ? 'dark' : 'light', reducedMotion: 'reduce' });
  await settle(scheme === 'light' ? 'dark' : 'light');
  assert.notDeepEqual(await colors(), initial, 'System theme changes actual computed page colors');
  await compactTheme(page, scheme === 'light' ? 'dark' : 'light');
  await textContrast(page, scheme === 'light' ? 'dark' : 'light');
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await settle(scheme);
  assert.deepEqual(await colors(), initial, 'System theme restores without a theme control');
  await compactTheme(page, scheme);
}
async function setup(browser, options = {}, denied = false) {
  const context = await browser.newContext(options), errors = [], requests = [];
  if (denied) await context.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage denied'); } });
  });
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
  assert.deepEqual(run.errors, [], 'Console / page errors (including CSP violations)');
  for (const request of run.requests) {
    assert.equal(request.method, 'GET', 'No commands or other write requests');
    const url = new URL(request.url);
    assert.equal(url.origin, new URL(base).origin, 'No external resources');
    if (url.pathname === '/api/history') assert.equal(url.search, '?minutes=15');
    assert(routes.includes(url.pathname) || ['/api/state', '/api/smartmeter', '/api/history', '/api/house-history', '/api/wallbox-control'].includes(url.pathname)
      || url.pathname.startsWith('/static/') || ['/favicon.ico', '/manifest.webmanifest', '/service-worker.js'].includes(url.pathname), request.url);
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  fs.mkdirSync('/artifacts', { recursive: true });
  try {
    for (const route of routes) for (const scheme of ['light', 'dark']) for (const width of [320, 390, 768, 1440, 1920, 2560]) {
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
        assert.deepEqual(await page.locator('nav[aria-label="Hauptnavigation"] a').evaluateAll(links => links.map(a => a.getAttribute('href'))), ['/', '/wallbox', '/diagramme', '/einstellungen']);
        assert.deepEqual(await page.locator('nav[aria-label="Hauptnavigation"] a').allTextContents().then(labels => labels.map(label => label.trim())), ['Übersicht', 'Wallbox', 'Diagramme', 'Settings']);
        const settings = page.getByRole('link', { name: 'Settings', exact: true });
        assert.equal(await settings.getAttribute('href'), '/einstellungen');
        assert.equal(await settings.locator('svg').count(), 1);
        assert.equal(await page.locator('.quick-controls').count(), 0);
        const navBoxes = await page.locator('nav[aria-label="Hauptnavigation"] a').evaluateAll(links => links.map(link => {
          const { x, y, width, height } = link.getBoundingClientRect(); return { x, y, width, height };
        }));
        if (width > 900) {
          assert(navBoxes[3].y >= navBoxes[2].y + navBoxes[2].height, 'Settings below Diagramme');
        } else {
          assert(navBoxes.every(box => Math.abs(box.y - navBoxes[0].y) <= 1), 'Four compact navigation tabs in one row');
          assert(navBoxes.every(box => box.x >= 0 && box.x + box.width <= width), 'Tabs fit viewport');
        }
        assert.equal(await page.locator('nav [aria-current="page"]').count(), 1);
        assert.equal(await page.locator('nav [aria-current="page"]').getAttribute('href'), route);
        assert(await page.evaluate(() => {
          const ids = [...document.querySelectorAll('[id]')].map(el => el.id);
          return new Set(ids).size === ids.length;
        }), 'Unique DOM IDs');
         assert.deepEqual(await page.locator('form, input:not([type="checkbox"]), [role="button"], [role="checkbox"]').evaluateAll(nodes => nodes.map(n => n.id).sort()),
           route === '/' ? ['control-current'] : ['calendar-custom', 'calendar-date', 'calendar-from', 'calendar-to']);
         assert.deepEqual(await page.locator('button').evaluateAll(nodes => nodes.map(n => n.id).sort()),
           (route === '/' ? ['control-apply', 'control-start', 'control-stop'] : ['', '', '', '', '', '', '', 'calendar-load', 'calendar-next', 'calendar-now', 'calendar-prev', 'reset-display']).sort());
        if (route === '/diagramme') {
          assert.equal(await page.locator('#reset-display').getAttribute('type'), 'button');
          assert.deepEqual(await page.locator('button[data-calendar-period]').evaluateAll(nodes =>
            nodes.map(node => node.dataset.calendarPeriod)), ['live', 'hour', 'day', 'week', 'month', 'year', 'custom']);
        }
        assert.equal(await page.locator('#theme-toggle').getAttribute('role'), 'switch');
        assert.equal(await page.locator('#theme-toggle').getAttribute('type'), 'checkbox');
        const boxes = page.locator('ul.chart-options input[type="checkbox"]');
        assert.equal(await page.locator('#metric-options, .display-options, .history-note').count(), 0);
        assert.equal(await boxes.count(), route === '/' ? 0 : 16);
        if (route === '/diagramme') assert.deepEqual(await boxes.evaluateAll(inputs => inputs.map(input => input.id).sort()),
          ['power', 'energy', 'limit', 'current-0', 'current-1', 'current-2', 'voltage-0', 'voltage-1',
            'voltage-2', 'plugged', 'charging', 'below', 'wallbox-error', 'charging-state', 'charging-raw', 'lock']
            .map(id => `show-${id}`).sort(), 'All 16 preferences remain available per chart');
        assert(await boxes.evaluateAll(inputs => inputs.every(input => input.checked && !input.disabled
          && [...input.labels].some(label => label.textContent.trim()))), 'Native labelled checkboxes');
        assert.equal(await page.locator('details[open]').count(), 0);
        if (route === '/') {
          assert.equal(await page.locator('.summary-card').count(), 4);
          for (const id of ['power', 'energy', 'limit', 'current-0', 'current-1', 'current-2',
            'voltage-0', 'voltage-1', 'voltage-2', 'plugged', 'charging', 'below',
            'wallbox-error', 'charging-state', 'charging-raw', 'lock']) {
            assert.equal(await page.locator(`#${id}`).count(), 1, `Preserved wallbox metric ${id}`);
            assert.equal(await page.locator(`#show-${id}`).count(), 0, `No overview preference ${id}`);
          }
          assert.equal(await page.locator('#chart-grid, .chart-card, .chart-line').count(), 0);
          assert.equal(await page.locator('#power').innerText(), '0,00 kW');
          assert.equal(await page.locator('#plugged').innerText(), 'Ja');
          assert.equal(await page.locator('#charging').innerText(), 'Nein');
          assert.equal(await page.getByRole('heading', { name: 'Leistungsrahmen', exact: true }).count(), 0);
          assert.equal(await page.locator('.source-info').count(), 0);
          assert.equal(await page.locator('.details-grid.measurements #smartmeter').count(), 1);
          assert.equal(await page.locator('.details-grid.measurements #voltage-0').count(), 1);
          assert(await page.locator('#smartmeter').isVisible(), 'House data always visible');
          assert(!await page.locator('#below').isVisible(), 'Below-limit row starts in collapsed diagnostics');
        } else {
          assert.equal(await page.locator('#chart-grid > figure').count(), 4);
          const order = await page.evaluate(() => {
            const house = document.getElementById('smartmeter'), grid = document.getElementById('chart-grid');
            const toolbar = document.querySelector('.calendar-toolbar'), diagnostics = document.querySelector('.history-diagnostics');
            return { dom: !!(house.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING),
              belowControls: house.getBoundingClientRect().top >= toolbar.getBoundingClientRect().bottom,
              beforeWallbox: house.getBoundingClientRect().bottom <= grid.getBoundingClientRect().top,
              beforeDiagnostics: house.getBoundingClientRect().bottom <= diagnostics.getBoundingClientRect().top };
          });
          assert(Object.values(order).every(Boolean), 'Shared controls, HOUSE first, Wallbox curves, then diagnostics at every viewport');
          assert.equal(await page.locator('.history-diagnostics figure').count(), 5);
          assert.equal(await page.locator('#chart-grid svg[role="img"][aria-label]').count(), 4);
          await page.waitForFunction(() => document.querySelector('#chart-grid .chart-line'));
        }
        await globals(page);
        await layoutFreeze(page, width, route);
        await systemTheme(page, scheme);
        await overflow(page, `${route} ${scheme} ${width}: default`);
        const size = { 320: 'phone', 390: 'mobile', 768: 'tablet', 1440: 'desktop' }[width];
        if (size) await page.screenshot({ path: `/artifacts/${route === '/' ? 'dashboard' : 'diagrams'}-${scheme}-${size}.png`, fullPage: true });
        await page.locator('.technical-details > summary').click();
        if (route === '/') {
          assert(await page.locator('.technical-details #below').isVisible());
          assert((await page.locator('.technical-details article[data-metrics]').getAttribute('data-metrics')).split(/\s+/).includes('below'));
          assert.equal(await page.locator('#reset-display').count(), 0);
        } else {
          assert.equal(await page.locator('#reset-display').innerText(), 'Alle Kurven anzeigen');
          assert.equal(await page.locator('figure ul.chart-options').count(), 9);
          assert(await boxes.evaluateAll(inputs => inputs.every(input => input.getClientRects().length)),
            'Diagnostic controls reachable after opening details');
        }
        await overflow(page, `${route} ${width}: technical details`);
        if (route === '/diagramme') {
          for (let i = 0; i < 16; i++) await boxes.nth(i).uncheck();
          await paint(page);
          assert(await boxes.evaluateAll(inputs => inputs.every(input => !input.checked)));
          await globals(page);
          assert.equal(await page.locator('#display-empty').count(), 0);
          assert.equal(await page.locator('figure:has(ul.chart-options):visible').count(), 9);
          assert.equal(await page.locator('figure:has(ul.chart-options) svg:visible').count(), 0);
          assert.equal(await page.locator('figure:has(ul.chart-options) svg[hidden]').count(), 9);
          assert.equal(await page.locator('ul.chart-options input:visible').count(), 16);
          await overflow(page, `${route} ${width}: all off`);
          // Shared all-off preferences must not hide any overview card or diagnostic value.
          await page.locator('nav a[href="/"]').click(); await live(page);
          assert.equal(await page.locator('.summary-card:visible').count(), 4);
          assert.equal(await page.locator('ul.chart-options, #reset-display').count(), 0);
          assert(await page.locator('#smartmeter').isVisible());
          await page.locator('.technical-details > summary').click();
          assert.equal(await page.locator('[data-metric]:not(:visible), [data-metrics]:not(:visible)').count(), 0);
          await globals(page);
          await overflow(page, `${route} ${width}: overview ignores all-off preferences`);
          await page.locator('nav a[href="/diagramme"]').click(); await live(page);
          await paint(page);
          assert(await boxes.evaluateAll(inputs => inputs.every(input => !input.checked)));
          await page.locator('#reset-display').click();
          await paint(page);
          assert(await boxes.evaluateAll(inputs => inputs.every(input => input.checked)));
          assert.equal(await page.locator('#chart-grid svg[hidden], #chart-diagnostics-grid svg[hidden]').count(), 0);
        }
        if (await page.locator('.technical-details[open] > summary').count())
          await page.locator('.technical-details[open] > summary').click();
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
      await run.page.locator('nav a[href="/diagramme"]').focus(); await run.page.keyboard.press('Enter');
      await run.page.waitForURL(new URL('/diagramme', base).href); await live(run.page);
      await run.page.locator('ul.chart-options #show-power').uncheck();
      assert(await run.page.evaluate(() => localStorage.getItem('evse-display-v1') !== null));
      await run.page.locator('nav a[href="/"]').click(); await live(run.page);
      assert.equal(await run.page.locator('.summary-card:visible').count(), 4);
      assert(await run.page.locator('#power').isVisible());
      await run.page.locator('nav a[href="/diagramme"]').focus(); await run.page.keyboard.press('Enter');
      await run.page.waitForURL(new URL('/diagramme', base).href); await live(run.page);
      assert.equal(await run.page.locator('ul.chart-options #show-power').isChecked(), false);
      await run.page.reload(); await live(run.page);
      assert.equal(await run.page.locator('ul.chart-options #show-power').isChecked(), false);
      await run.page.evaluate(() => {
        const prefs = JSON.parse(localStorage.getItem('evse-display-v1'));
        prefs.selected.power = true;
        localStorage.setItem('evse-display-v1', JSON.stringify(prefs));
        const event = new Event('pageshow');
        Object.defineProperty(event, 'persisted', { value: true }); window.dispatchEvent(event);
      });
      await live(run.page);
      assert.equal(await run.page.locator('ul.chart-options #show-power').isChecked(), true,
        'Pageshow restores readable shared preferences');
      await run.page.evaluate(() => {
        window.layoutMutations = 0;
        window.layoutObserver = new MutationObserver(records => { window.layoutMutations += records.length; });
        for (const id of ['status', 'reason']) window.layoutObserver.observe(document.getElementById(id),
          { childList: true, subtree: true, characterData: true });
        window.layoutTimestamp = document.getElementById('timestamp').textContent;
      });
      await run.page.waitForFunction(() => document.getElementById('timestamp').textContent !== window.layoutTimestamp);
      assert.equal(await run.page.evaluate(() => {
        window.layoutObserver.disconnect(); return window.layoutMutations;
      }), 0, 'Unchanged live status text is not repeatedly replaced during polling');
      clean(run);
    } finally { await run.context.close(); }
    for (const route of routes) {
      const denied = await setup(browser, {}, true);
      try {
        await denied.page.goto(new URL(route, base).href); await live(denied.page);
        const first = denied.page.locator('ul.chart-options #show-power');
        if (route === '/diagramme') {
          await first.uncheck(); assert.equal(await first.isChecked(), false);
        } else {
          assert.equal(await denied.page.locator('ul.chart-options, #reset-display').count(), 0);
          assert.equal(await denied.page.locator('.summary-card:visible').count(), 4);
        }
        await globals(denied.page);
        await denied.page.evaluate(() => {
          const event = new Event('pageshow');
          Object.defineProperty(event, 'persisted', { value: true }); window.dispatchEvent(event);
        });
        await live(denied.page);
        if (route === '/diagramme')
          assert.equal(await first.isChecked(), false, 'Cached page keeps session-only choices without storage');
        else assert.equal(await denied.page.locator('.summary-card:visible').count(), 4);
        await denied.page.reload(); await live(denied.page);
        if (route === '/diagramme') assert.equal(await first.isChecked(), true);
        else assert.equal(await denied.page.locator('.summary-card:visible').count(), 4);
        clean(denied);
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
      assert.equal(await failure.page.locator('img').count(), 1);
      assert.equal(await failure.page.locator('.brand-mark img[src="/static/icon.svg"]').count(), 1);
      assert(!await failure.page.locator('#wallbox-warning').isVisible(), 'Stale hardware warning not kept as current');
      clean(failure);
    } finally { await failure.context.close(); }
    console.log('Layout browser: both pages, dark/light, 320/390/768/1440/1920/2560px full content width, navigation, keyboard, CSP, storage and protected status passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
