(function () {
  'use strict';
  function standalone(env) {
    return Boolean(env.navigator.standalone || env.matchMedia('(display-mode: standalone)').matches);
  }
  function supported(env) {
    return env.location.protocol === 'https:' && env.isSecureContext === true && 'serviceWorker' in env.navigator;
  }
  function createController(env, render = () => {}) {
    let deferred = null, registration = null, busy = false;
    const state = { canInstall: false, canUpdate: false, status: '', update: '' };
    function refresh() {
      const installed = standalone(env);
      state.canInstall = supported(env) && !installed && deferred !== null && !busy;
      state.canUpdate = registration !== null && !busy;
      state.status = installed ? 'Die WebApp ist im eigenen Fenster geöffnet.' :
        !supported(env) ? 'Installation hier nicht verfügbar. HTTPS mit vertrauenswürdigem Zertifikat und einen geeigneten Browser verwenden.' :
        deferred ? 'Dieser Browser bietet die Installation an.' :
        'Installation über das Browsermenü, sofern verfügbar. Auf iPhone/iPad Safari und „Teilen“ verwenden.';
      render({ ...state });
    }
    function updateStatus() {
      state.update = registration?.waiting ?
        'Neue Version bereit. Alle App-Fenster und Website-Tabs schließen, dann erneut öffnen.' :
        registration?.installing ? 'Aktualisierung wird vorbereitet.' : 'Aktualisierungen werden automatisch beim Öffnen geprüft.';
      refresh();
    }
    function watch() {
      const worker = registration?.installing;
      if (worker) worker.addEventListener('statechange', updateStatus);
      updateStatus();
    }
    async function start() {
      refresh();
      if (!supported(env)) return;
      try {
        registration = await env.navigator.serviceWorker.register('/service-worker.js', { scope: '/', updateViaCache: 'none' });
        registration.addEventListener('updatefound', watch);
        watch();
      } catch (_) {
        state.update = 'Offline-Hinweis konnte nicht eingerichtet werden. Verbindung und Zertifikatsvertrauen prüfen.';
        refresh();
      }
    }
    function beforeInstall(event) {
      if (!supported(env) || standalone(env)) return;
      event.preventDefault();
      deferred = event;
      refresh();
    }
    async function install() {
      if (!state.canInstall) return;
      const prompt = deferred;
      deferred = null;
      busy = true;
      refresh();
      try { await prompt.prompt(); await prompt.userChoice; }
      catch (_) { /* The browser may dismiss or invalidate a one-use prompt. */ }
      finally { busy = false; refresh(); }
    }
    async function update() {
      if (!state.canUpdate) return;
      busy = true;
      refresh();
      try { await registration.update(); updateStatus(); }
      catch (_) { state.update = 'Aktualisierung nicht möglich. Verbindung zur Website prüfen.'; }
      finally { busy = false; refresh(); }
    }
    function installed() { deferred = null; refresh(); }
    refresh();
    return { start, beforeInstall, install, update, installed, refresh };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { standalone, supported, createController };
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const controller = createController(window, state => {
    const install = document.getElementById('pwa-install');
    if (install) { install.disabled = !state.canInstall; install.hidden = !state.canInstall; }
    const update = document.getElementById('pwa-update');
    if (update) update.disabled = !state.canUpdate;
    const status = document.getElementById('pwa-status');
    if (status) status.textContent = state.status;
    const message = document.getElementById('pwa-update-status');
    if (message && state.update) message.textContent = state.update;
  });
  window.addEventListener('beforeinstallprompt', event => controller.beforeInstall(event));
  window.addEventListener('appinstalled', () => controller.installed());
  window.addEventListener('pageshow', () => controller.refresh());
  window.matchMedia('(display-mode: standalone)').addEventListener('change', () => controller.refresh());
  document.getElementById('pwa-install')?.addEventListener('click', () => controller.install());
  document.getElementById('pwa-update')?.addEventListener('click', () => controller.update());
  void controller.start();
})();
