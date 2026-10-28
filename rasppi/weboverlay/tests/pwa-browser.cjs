'use strict';
// Docker-only: trusted local TLS -> real PHP workers -> isolated broker.
// No certificate bypass, browser routes, production services, or external assets.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const { CACHE_NAME, CACHE_PREFIX, STATIC_PATHS } = require('../static/service-worker.js');
const base = process.env.PWA_BASE_URL || process.env.WEB_TEST_URL || 'https://evse.test:8443';
const broker = process.env.PWA_MQTT_HOST || process.env.MQTT_HOST || 'broker';
const prefix = process.env.PWA_MQTT_TOPIC_PREFIX || process.env.MQTT_TOPIC_PREFIX || 'evse/wallbox';
assert.equal(new URL(base).protocol, 'https:', 'Vertrauenswürdiges TLS ist Voraussetzung');

function mqttString(text) {
  const value = Buffer.from(text), length = Buffer.alloc(2);
  length.writeUInt16BE(value.length); return Buffer.concat([length, value]);
}
function packet(header, body) {
  let remaining = body.length;
  const bytes = [];
  do { let digit = remaining % 128; remaining = Math.floor(remaining / 128); if (remaining) digit |= 128; bytes.push(digit); } while (remaining);
  return Buffer.concat([Buffer.from([header, ...bytes]), body]);
}
async function publisher() {
  const socket = net.createConnection({ host: broker, port: 1883 });
  let failure = null, interval, power = 1234;
  socket.on('error', error => { failure = error; });
  await new Promise((resolve, reject) => {
    let reply = Buffer.alloc(0);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('MQTT-CONNACK fehlt')); }, 5000);
    function failed(error) { clearTimeout(timer); reject(error); }
    socket.once('error', failed);
    socket.once('connect', () => socket.write(packet(0x10, Buffer.concat([
      mqttString('MQTT'), Buffer.from([4, 2, 0, 30]), mqttString('isolated-pwa-browser')
    ]))));
    function receive(chunk) {
      reply = Buffer.concat([reply, chunk]);
      if (reply.length < 4) return;
      clearTimeout(timer); socket.off('data', receive); socket.off('error', failed);
      try { assert.deepEqual([...reply.subarray(0, 4)], [0x20, 2, 0, 0]); resolve(); }
      catch (error) { reject(error); }
    }
    socket.on('data', receive);
  });
  function publish(suffix, body) {
    socket.write(packet(0x31, Buffer.concat([mqttString(`${prefix}/${suffix}`), Buffer.from(body)])));
  }
  function pulse() {
    if (socket.destroyed) { failure ||= new Error('Isolierter MQTT-Publisher beendet'); return; }
    const timestamp = new Date().toISOString();
    // Same valid reader contract as tests/integration.cjs, deliberately dummy.
    publish('state', JSON.stringify({ schema_version: 1, device: 'abb_terra_ac', timestamp,
      status: 'ok', last_success_at: timestamp, error: null,
      values: { error_code: 0, socket_lock_state: 273, charging_state_raw: 33024,
        charging_state: 1, below_commanded_current: true, plugged_in: true, charging: false,
        current_limit_a: 6, current_a: [0, 0, 0], voltage_v: [235.7, 233.4, 235.3],
        active_power_w: power, session_energy_wh: 0 } }));
    publish('availability', 'online');
  }
  pulse(); interval = setInterval(pulse, 1000);
  return { setPower(value) { power = value; pulse(); }, check() { if (failure) throw failure; },
    stop() { clearInterval(interval); socket.end(Buffer.from([0xe0, 0])); socket.destroy(); } };
}

async function controlled(page) {
  await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
  assert.equal(await page.evaluate(() => navigator.serviceWorker.controller.state), 'activated');
}
async function cacheEntries(page) {
  return page.evaluate(async () => {
    const result = {};
    for (const key of await caches.keys()) result[key] = (await (await caches.open(key)).keys()).map(req => new URL(req.url).pathname).sort();
    return result;
  });
}
async function failedFetch(page, path, method = 'GET') {
  return page.evaluate(async ({ path, method }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try { await fetch(path, { method, cache: 'no-store', signal: controller.signal }); return false; }
    catch (_) { return true; }
    finally { clearTimeout(timer); }
  }, { path, method });
}

async function networkPhase(request, confirmed) {
  // CDP's context.setOffline does not reliably cover service-worker-owned
  // network targets. The CI host really stops/restarts only this test proxy.
  fs.writeFileSync(`/artifacts/${request}`, 'ready');
  const deadline = Date.now() + 60000;
  while (!fs.existsSync(`/artifacts/${confirmed}`)) {
    if (Date.now() > deadline) throw new Error(`Testnetz-Phase fehlt: ${confirmed}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

(async () => {
  fs.mkdirSync('/artifacts', { recursive: true });
  const fixture = await publisher();
  let browser, context;
  const errors = [], posts = [];
  try {
    // TLS is trusted by the parent-installed OS/NSS root, not ignored by flags.
    browser = await chromium.launch({ headless: true });
    const plainContext = await browser.newContext();
    try {
      const plain = await plainContext.newPage();
      await plain.goto(new URL('/einstellungen', process.env.PWA_HTTP_URL || 'http://weboverlay:8080').href);
      assert.equal(await plain.locator('.pwa-card, #pwa-status, #pwa-install, #pwa-update').count(), 0);
      assert.equal(await plain.evaluate(async () => 'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0), 0);
    } finally { await plainContext.close(); }
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
    context.setDefaultTimeout(15000); context.setDefaultNavigationTimeout(20000);
    context.on('page', page => page.on('pageerror', error => errors.push(String(error))));
    context.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
    const page = await context.newPage();
    const response = await page.goto(new URL('/static/offline.html', base).href);
    assert.equal(response.status(), 200);
    const tls = await response.securityDetails();
    assert.match(tls.protocol, /^TLS/);
    assert.equal(await page.evaluate(() => isSecureContext), true);
    // Seed before first registration: activation may remove only our old shell.
    await page.evaluate(async ({ prefix }) => {
      await (await caches.open('unrelated-pwa-test')).put('/unrelated', new Response('bleibt erhalten'));
      await (await caches.open(prefix + 'old')).put('/old', new Response('alte Shell'));
    }, { prefix: CACHE_PREFIX });
    await page.goto(new URL('/einstellungen', base).href);
    await controlled(page);
    assert.equal(await page.locator('.pwa-card, #pwa-status, #pwa-install, #pwa-update').count(), 0);
    // Registration and browser-managed updates remain available without Settings UI.
    assert.equal(await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration('/');
      await registration.update();
      return Boolean(registration.active);
    }), true);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: '/artifacts/pwa-settings-dark-mobile.png', fullPage: true });

    const manifest = await page.evaluate(async () => {
      const result = await fetch('/manifest.webmanifest', { cache: 'no-store' });
      return { type: result.headers.get('content-type'), body: await result.json() };
    });
    assert.match(manifest.type, /^application\/manifest\+json/);
    assert.deepEqual([manifest.body.id, manifest.body.start_url, manifest.body.scope], ['/', '/', '/']);
    assert.equal(manifest.body.display, 'standalone'); assert.equal(manifest.body.lang, 'de');
    assert.equal(manifest.body.name, 'EVSE-Control');
    assert.deepEqual(manifest.body.icons.map(icon => [icon.sizes, icon.purpose]), [['192x192', 'any'], ['512x512', 'any'], ['512x512', 'maskable']]);
    const images = [...manifest.body.icons.map(icon => [icon.src, Number(icon.sizes.split('x')[0])]), ['/static/apple-touch-icon.png', 180]];
    for (const [path, expected] of images) {
      const image = await page.evaluate(async path => {
        const result = await fetch(path, { cache: 'no-store' });
        const bitmap = await createImageBitmap(await result.blob());
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
        const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
        const colors = new Set(); let opaque = 0;
        for (let offset = 0; offset < pixels.length; offset += 4) {
          if (pixels[offset + 3]) opaque++;
          colors.add(`${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]},${pixels[offset + 3]}`);
        }
        const center = [...ctx.getImageData(Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1).data];
        return { width: bitmap.width, height: bitmap.height, type: result.headers.get('content-type'), colors: colors.size, opaque, center };
      }, path);
      assert.equal(image.width, expected); assert.equal(image.height, expected);
      assert.match(image.type, /^image\/png/); assert(image.colors > 1); assert(image.opaque > expected * expected / 4);
      if (path.includes('maskable')) assert.equal(image.center[3], 255);
    }
    const swHeaders = await page.evaluate(async () => {
      const result = await fetch('/service-worker.js', { cache: 'no-store' });
      return { status: result.status, mime: result.headers.get('content-type'), allowed: result.headers.get('service-worker-allowed'), cache: result.headers.get('cache-control') };
    });
    assert.equal(swHeaders.status, 200); assert.match(swHeaders.mime, /javascript/);
    assert.equal(swHeaders.allowed, '/'); assert.equal(swHeaders.cache, 'no-store');
    let entries = await cacheEntries(page);
    assert.deepEqual(entries[CACHE_NAME], [...STATIC_PATHS].sort());
    assert.deepEqual(entries['unrelated-pwa-test'], ['/unrelated']);
    assert.equal(entries[CACHE_PREFIX + 'old'], undefined);
    assert(Object.values(entries).flat().every(path => !path.startsWith('/api/') && path !== '/healthz'));

    // Real telemetry, not route.fulfill: the worker receives the isolated broker.
    await page.goto(new URL('/', base).href);
    await controlled(page);
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Live' && document.getElementById('power').textContent === '1,23 kW');
    const initialStamp = await page.evaluate(async () => (await (await fetch('/api/state', { cache: 'no-store' })).json()).timestamp);
    const knownRoutes = ['/api/state', '/api/smartmeter', '/api/history', '/healthz'];
    for (const path of knownRoutes) {
      const headers = await page.evaluate(async path => {
        const result = await fetch(path, { cache: 'no-store' });
        return { cache: result.headers.get('cache-control'), body: await result.json() };
      }, path);
      assert.equal(headers.cache, 'no-store'); assert.equal(headers.body.read_only, true);
    }
    entries = await cacheEntries(page);
    assert.deepEqual(entries[CACHE_NAME], [...STATIC_PATHS].sort());
    // Deliberately forged unrelated API cache entries must never satisfy fetch.
    await page.evaluate(async paths => {
      const forged = await caches.open('forged-api-pwa-test');
      for (const path of paths) await forged.put(path, new Response('{"status":"live","forged":true}', { headers: { 'Content-Type': 'application/json' } }));
    }, knownRoutes);
    const onlineForged = await page.evaluate(async () => (await (await fetch('/api/state')).json()).forged);
    assert.equal(onlineForged, undefined);
    await networkPhase('pwa-offline-request', 'pwa-is-offline');
    const startOffline = Date.now();
    await Promise.all(knownRoutes.map(async path => assert.equal(await failedFetch(page, path), true, `${path}: kein Cache-Fallback`)));
    assert.equal(await failedFetch(page, '/api/state', 'POST'), true, 'Keine Offline-Befehlswarteschlange');
    await page.waitForFunction(() => document.getElementById('power').textContent === '—' && document.getElementById('status').textContent !== 'Live', null, { timeout: 15000 });
    assert(Date.now() - startOffline < 15000, 'Livewerte müssen ohne Antworten verfallen');
    assert.equal(await page.locator('#plugged').innerText(), 'Unbekannt');
    assert.equal(await page.locator('#limit').innerText(), '—');
    fixture.setPower(2345); fixture.check();
    const offlinePage = await context.newPage();
    await offlinePage.goto(new URL('/diagramme', base).href);
    assert.equal(await offlinePage.locator('h1').innerText(), 'Offline');
    assert.match(await offlinePage.locator('body').innerText(), /keine Livewerte/i);
    assert.equal(await offlinePage.locator('#status, #power, #chart-grid').count(), 0);
    await offlinePage.screenshot({ path: '/artifacts/pwa-offline-dark-mobile.png', fullPage: true });
    const offlineEntries = await cacheEntries(offlinePage);
    assert.deepEqual(offlineEntries[CACHE_NAME], [...STATIC_PATHS].sort());
    assert.equal(offlineEntries[CACHE_NAME].some(path => knownRoutes.includes(path)), false);
    await page.bringToFront();
    await networkPhase('pwa-online-request', 'pwa-is-online');
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Live' && document.getElementById('power').textContent === '2,35 kW');
    const recovered = await page.evaluate(async () => (await (await fetch('/api/state')).json()));
    assert.equal(recovered.values.active_power_w, 2345); assert.notEqual(recovered.timestamp, initialStamp);
    assert.equal(recovered.forged, undefined);
    await offlinePage.locator('a').click();
    await offlinePage.waitForFunction(() => document.getElementById('status')?.textContent === 'Live');
    // Allow a normal poll after recovery; it must not replay the offline POST.
    const countBefore = posts.length;
    await page.waitForResponse(response => new URL(response.url()).pathname === '/api/state');
    assert.equal(posts.length, countBefore);
    assert.equal(countBefore, 1, 'Nur der bewusst getestete Offline-POST');
    const postStatus = await page.evaluate(async () => (await fetch('/api/state', { method: 'POST' })).status);
    assert.equal(postStatus, 405);
    assert.deepEqual(errors, []); fixture.check();
    console.log('PWA-Browser: vertrauenswürdiges TLS, Manifest/PNG, Shellcache, Offlineablauf und echte MQTT-Wiederkehr geprüft');
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    fixture.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
