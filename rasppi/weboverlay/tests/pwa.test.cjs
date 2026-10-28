'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { CACHE_PREFIX, CACHE_NAME, STATIC_PATHS, requestKind, navigation, staticResponse } = require('../static/service-worker.js');
const { standalone, supported, createController } = require('../static/pwa.js');
const origin = 'https://evse.test:8443';
const request = (path, extra = {}) => ({ url: origin + path, method: 'GET', mode: 'cors', ...extra });

test('Nur exakte lokale GET-Ressourcen sind cachefähig', () => {
  for (const path of STATIC_PATHS) assert.equal(requestKind(request(path), origin), 'static');
  for (const path of ['/api/state', '/api/smartmeter', '/api/history?minutes=15', '/healthz?x=1']) {
    assert.equal(requestKind(request(path), origin), 'live');
  }
  for (const path of ['/', '/diagramme', '/einstellungen']) {
    assert.equal(requestKind(request(path, { mode: 'navigate' }), origin), 'navigation');
    assert(!STATIC_PATHS.includes(path), 'Keine Dashboard-Dokumente im Shellcache');
  }
  for (const path of ['/static/app.js?v=evil', '/missing', '/static/missing.js', '/service-worker.js', '/static/../.env']) {
    assert.equal(requestKind(request(path), origin), null);
  }
  assert.equal(requestKind(request('/static/app.js', { method: 'POST' }), origin), null);
  assert.equal(requestKind(request('/api/state', { method: 'POST' }), origin), null);
  assert.equal(requestKind(request('/static/app.js', { url: 'https://foreign.test/static/app.js' }), origin), null);
  assert.equal(requestKind(request('/static/app.js', { method: 'HEAD' }), origin), null);
});

function workerHarness() {
  const events = {}, deleted = [], added = [], fetched = [];
  const fallback = { offline: true };
  const cacheStorage = {
    keys: async () => ['another-app', CACHE_PREFIX + 'old', CACHE_NAME],
    delete: async name => { deleted.push(name); },
    open: async name => {
      assert.equal(name, CACHE_NAME);
      return { addAll: async entries => added.push(...entries), match: async () => fallback };
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../static/service-worker.js'), 'utf8'), {
    self: { location: { origin }, clients: { claim: async () => {} }, addEventListener: (name, handler) => { events[name] = handler; } },
    caches: cacheStorage, URL, Response, AbortController, setTimeout, clearTimeout,
    Request: class { constructor(url, options) { this.url = url; this.cache = options.cache; } },
    fetch: async (req, options) => { fetched.push({ req, options }); throw new Error('offline'); }
  });
  return { events, deleted, added, fetched, fallback };
}
test('Installation schreibt ausschließlich die versionierte Shell; Aktivierung erhält fremde Caches', async () => {
  const h = workerHarness();
  await new Promise((resolve, reject) => h.events.install({ waitUntil: promise => promise.then(resolve, reject) }));
  assert.deepEqual(h.added.map(entry => entry.url), STATIC_PATHS);
  assert(h.added.every(entry => entry.cache === 'reload'));
  await new Promise((resolve, reject) => h.events.activate({ waitUntil: promise => promise.then(resolve, reject) }));
  assert.deepEqual(h.deleted, [CACHE_PREFIX + 'old']);
  assert.equal(h.events.message, undefined, 'Kein erzwungenes skipWaiting per Nachricht');
});
test('API-/Healthfehler bleiben Fehler, selbst bei gefälschtem Cache; POST wird nicht abgefangen', async () => {
  const h = workerHarness();
  for (const path of ['/api/state', '/api/smartmeter', '/api/history', '/healthz']) {
    let response;
    h.events.fetch({ request: request(path), respondWith: promise => { response = promise; } });
    await assert.rejects(response, /offline/);
    assert.equal(h.fetched.at(-1).options.cache, 'no-store');
  }
  let intercepted = false;
  for (const req of [request('/api/state', { method: 'POST' }), request('/unknown'),
    request('/static/app.js', { url: 'https://foreign.test/static/app.js' })]) {
    h.events.fetch({ request: req, respondWith: () => { intercepted = true; } });
  }
  assert.equal(intercepted, false);
});
test('Navigation nutzt Netzwerk oder expliziten Offlinehinweis, niemals Dashboardcache', async () => {
  const paths = [];
  const offline = new Response('Offline');
  const storage = { open: async name => {
    assert.equal(name, CACHE_NAME);
    return { match: async path => { paths.push(path); return offline; } };
  } };
  const online = new Response('Netzwerk');
  assert.equal(await navigation(request('/'), storage, async (_, opts) => {
    assert.equal(opts.cache, 'no-store'); return online;
  }), online);
  assert.equal(await navigation(request('/'), storage, async () => { throw new Error('offline'); }), offline);
  assert.deepEqual(paths, ['/static/offline.html']);
  const notFound = new Response('Nicht gefunden', { status: 404 });
  assert.equal(await navigation(request('/'), storage, async () => notFound), notFound);
});
test('Navigation beendet auch ein hängendes Netz nach seiner Frist', async () => {
  let timeout, aborted = false;
  const box = { module: { exports: {} }, URL, Response, AbortController,
    setTimeout: callback => { timeout = callback; return 1; }, clearTimeout: () => {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../static/service-worker.js'), 'utf8'), box);
  const result = box.module.exports.navigation(request('/'), {
    open: async () => ({ match: async () => new Response('Offline') })
  }, (_, options) => {
    options.signal.addEventListener('abort', () => { aborted = true; });
    return new Promise(() => {});
  });
  timeout();
  assert.equal(await (await result).text(), 'Offline');
  assert.equal(aborted, true);
});
test('Statische Antworten werden online neu geladen, aber niemals zur Laufzeit gecacht', async () => {
  let opens = 0;
  const fallback = new Response('Shell');
  const storage = { open: async () => { opens++; return { match: async () => fallback }; } };
  const online = new Response('Neue Datei');
  assert.equal(await staticResponse(request('/static/app.js'), storage, async (_, options) => {
    assert.equal(options.cache, 'no-store'); return online;
  }), online);
  assert.equal(opens, 0);
  assert.equal(await staticResponse(request('/static/app.js'), storage, async () => { throw new Error('offline'); }), fallback);
});

function environment({ secure = true, worker = true, standaloneMode = false, ios = false, reject = false, protocol = 'https:' } = {}) {
  const calls = [], listeners = {}, registration = {
    waiting: null, installing: null,
    addEventListener: (name, handler) => { listeners[name] = handler; },
    update: async () => { calls.push('update'); if (reject) throw new Error('offline'); }
  };
  const env = { location: { protocol }, isSecureContext: secure, matchMedia: () => ({ matches: standaloneMode }), navigator: { standalone: ios } };
  if (worker) env.navigator.serviceWorker = { register: async (...args) => {
    calls.push(args); if (reject) throw new Error('offline'); return registration;
  } };
  let state;
  const controller = createController(env, value => { state = value; });
  return { env, calls, listeners, registration, controller, state: () => state };
}
test('HTTP und fehlende Browserunterstützung registrieren nichts und bieten keinen Installationsknopf', async () => {
  for (const options of [{ secure: false }, { worker: false }, { protocol: 'http:' }]) {
    const h = environment(options);
    assert.equal(supported(h.env), false);
    await h.controller.start();
    await h.controller.install(); await h.controller.update();
    h.controller.beforeInstall({ preventDefault() { assert.fail('Nicht unter HTTP'); } });
    assert.equal(h.calls.length, 0);
    assert.equal(h.state().canInstall, false);
    assert.equal(h.state().canUpdate, false);
    assert.match(h.state().status, /HTTPS/);
  }
});
test('Sichere Registrierung umgeht HTTP-Cache und erhält manuelle Installationshilfe', async () => {
  const h = environment(); await h.controller.start();
  assert.deepEqual(h.calls, [['/service-worker.js', { scope: '/', updateViaCache: 'none' }]]);
  assert.equal(h.state().canInstall, false);
  assert.equal(h.state().canUpdate, true);
  assert.match(h.state().status, /Browsermenü/);
});
test('Installation benötigt einen echten zurückgestellten Prompt und verbraucht ihn genau einmal', async () => {
  const h = environment(); let prevented = 0, prompted = 0;
  await h.controller.start();
  h.controller.beforeInstall({ preventDefault() { prevented++; }, prompt: async () => { prompted++; },
    userChoice: Promise.resolve({ outcome: 'dismissed' }) });
  assert.equal(h.state().canInstall, true);
  await h.controller.install(); await h.controller.install();
  assert.equal(prevented, 1); assert.equal(prompted, 1);
  assert.equal(h.state().canInstall, false);
  h.controller.installed(); assert.equal(h.state().canInstall, false);
});
test('Standalone-Erkennung deckt Displaymodus und iOS ab', async () => {
  for (const options of [{ standaloneMode: true }, { ios: true }]) {
    const h = environment(options); assert.equal(standalone(h.env), true);
    await h.controller.start();
    h.controller.beforeInstall({ preventDefault() { assert.fail('Bereits eigenständiges Fenster'); } });
    assert.equal(h.state().canInstall, false); assert.match(h.state().status, /eigenen Fenster/);
  }
});
test('Wartende Aktualisierungen erzwingen keinen Versionswechsel', async () => {
  const h = environment(); await h.controller.start();
  h.registration.waiting = {};
  await h.controller.update();
  assert.match(h.state().update, /Alle App-Fenster/);
  assert.equal(h.calls.at(-1), 'update');
  assert.equal(h.state().canUpdate, true);
});
test('Fehlgeschlagene Aktualisierungsprüfung bleibt wiederholbar und zeigt einen Verbindungsfehler', async () => {
  const h = environment(); await h.controller.start();
  h.registration.update = async () => { throw new Error('offline'); };
  await h.controller.update();
  assert.match(h.state().update, /Verbindung/);
  assert.equal(h.state().canUpdate, true);
});
test('Installations-/Registrierungsfehler lassen sichere, deaktivierte Zustände zurück', async () => {
  const h = environment({ reject: true }); await h.controller.start();
  assert.equal(h.state().canUpdate, false); assert.match(h.state().update, /Zertifikatsvertrauen/);
  const normal = environment();
  normal.controller.beforeInstall({ preventDefault() {}, prompt: async () => { throw new Error('abgebrochen'); } });
  await normal.controller.install(); assert.equal(normal.state().canInstall, false);
});
test('Manifest und alle drei Dokumente enthalten nur lokale Installationsressourcen', () => {
  const manifest = JSON.parse(fs.readFileSync(require.resolve('../static/manifest.webmanifest'), 'utf8'));
  assert.deepEqual([manifest.id, manifest.start_url, manifest.scope], ['/', '/', '/']);
  assert.equal(manifest.display, 'standalone'); assert.equal(manifest.lang, 'de');
  assert.equal(manifest.name, 'EVSE-Control'); assert.equal(manifest.short_name, 'EVSE');
  assert.deepEqual(manifest.icons.map(icon => [icon.sizes, icon.purpose]), [['192x192', 'any'], ['512x512', 'any'], ['512x512', 'maskable']]);
  for (const name of ['index', 'diagrams', 'settings']) {
    const html = fs.readFileSync(require.resolve(`../static/${name}.html`), 'utf8');
    assert.match(html, /rel="manifest" href="\/manifest.webmanifest"/);
    assert.match(html, /rel="apple-touch-icon" href="\/static\/apple-touch-icon.png"/);
    assert.match(html, /src="\/static\/pwa.js" defer/);
  }
});
