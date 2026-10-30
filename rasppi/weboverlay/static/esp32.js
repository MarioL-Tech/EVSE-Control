(function (scope) {
  'use strict';
  const operations = ['inspect', 'lock', 'unlock', 'enroll', 'cancel', 'revoke'];
  const statuses = ['ok', 'disabled', 'busy', 'rejected', 'outcome_unknown', 'unavailable', 'acknowledged'];
  const fields = ['charging', 'antitheft', 'store_ready', 'enrolling', 'reader_ready', 'servo_ready'];
  const token = v => typeof v === 'string' && /^[a-fA-F0-9]{32}$/.test(v);
  const fixed = v => typeof v === 'string' && /^[a-zA-Z][a-zA-Z0-9_]{0,95}$/.test(v);
  const keys = (v, expected) => v && typeof v === 'object' && !Array.isArray(v) &&
    Object.keys(v).length === expected.length && expected.every(k => Object.prototype.hasOwnProperty.call(v, k));
  function validateUid(v) {
    return typeof v === 'string' && [11, 20, 29].includes(v.length) && /^(?:[a-fA-F0-9]{2}:){3,9}[a-fA-F0-9]{2}$/.test(v);
  }
  function validResult(r) {
    return keys(r, ['schema_version', 'id', 'operation', 'status', 'reason', 'session', 'lease', 'fresh_for_seconds', 'firmware_version', 'state', 'command_sent', 'result_code']) &&
      r.schema_version === 1 && token(r.id) && token(r.session) &&
      (r.lease === null || token(r.lease)) && operations.includes(r.operation) && statuses.includes(r.status) &&
      fixed(r.reason) && (r.result_code === null || fixed(r.result_code)) &&
      [0, 8].includes(r.fresh_for_seconds) && [null, 2].includes(r.firmware_version) &&
      typeof r.command_sent === 'boolean' && keys(r.state, [...fields, 'cards']) && fields.every(k => r.state[k] === null || typeof r.state[k] === 'boolean') &&
      (r.state.cards === null || (Number.isInteger(r.state.cards) && r.state.cards >= 0 && r.state.cards <= 16));
  }
  function validateEnvelope(e) {
    return !!(keys(e, ['status', 'csrf', 'inspection', 'command', 'command_sent']) && ['ok', 'unavailable', 'outcome_unknown', 'forbidden', 'invalid'].includes(e.status) &&
      (e.csrf === null || (typeof e.csrf === 'string' && /^[a-zA-Z0-9_-]{16,256}$/.test(e.csrf))) &&
      typeof e.command_sent === 'boolean' && (e.inspection === null || validResult(e.inspection)) &&
      (e.command === null || validResult(e.command)));
  }
  function createFreshness(wall = () => Date.now(), mono = () => performance.now()) {
    let value = null, startW = 0, startM = 0, lastW = wall(), lastM = mono(), epoch = 0;
    function read() {
      const w = wall(), m = mono();
      if (w < lastW || m < lastM) { value = null; epoch++; }
      if (w - startW >= 8000 || m - startM >= 8000) value = null;
      lastW = w; lastM = m;
      return value;
    }
    return { read, stamp() { read(); return epoch; }, clear() { value = null; }, set(v, w, m, expected = epoch) {
      // Roundtrip belongs to the lease; a late reply cannot restart eight seconds.
      read();
      if (expected !== epoch) { value = null; return null; }
      startW = w; startM = m;
      value = v; return read();
    } };
  }
  function mount(root, env = scope) {
    const doc = root.ownerDocument, settings = root.id === 'esp32-rfid';
    const prefix = settings ? 'esp32-rfid-' : 'esp32-';
    const get = id => doc.getElementById(id);
    const put = (id, text) => { const el = get(prefix + id); if (el) el.textContent = text; };
    const fresh = createFreshness(() => env.Date.now(), () => env.performance.now());
    const names = settings ? ['enroll', 'cancel', 'revoke'] : ['lock', 'unlock'];
    const uid = get('esp32-uid');
    if (uid) { uid.type = 'password'; uid.autocomplete = 'off'; uid.value = ''; }
    let manual = true, active = null, generation = 0, csrf = null, lastResult = 'Noch keine Aktion.', destroyed = false;
    const allowed = () => !destroyed && !doc.hidden && (settings || manual);
    function render() {
      const r = fresh.read(), s = r?.state;
      const ready = !!(r && r.firmware_version === 2 && r.fresh_for_seconds === 8 && r.lease && ['ok', 'acknowledged'].includes(r.status));
      root.hidden = !settings && !manual;
      put('status', !ready ? 'ESP32 nicht verfügbar / veraltet.' : s.store_ready !== true ? 'Speicher nicht bereit.' :
        s.servo_ready !== true ? 'Servo nicht bereit.' : s.reader_ready !== true ? 'RFID-Leser nicht bereit.' : 'ESP32 aktuell (max. 8 s).');
      put('state', 'Verriegelungsziel ' + (!ready || s.antitheft === null ? 'unbekannt' : s.antitheft ? 'aktiv' : 'inaktiv'));
      put('count', ready && s.cards !== null ? String(s.cards) + ' / 16' : 'Unbekannt');
      put('enrolling', !ready || s.enrolling === null ? 'Unbekannt' : s.enrolling ? 'Anlernen aktiv (30 s / eine Karte).' : 'Anlernen inaktiv.');
      put('result', lastResult);
      for (const name of names) {
        const button = get('esp32-' + name);
        let permit = ready && !!csrf && s.store_ready === true;
        if (name === 'lock' || name === 'unlock') permit = permit && s.servo_ready === true;
        if (name === 'enroll') permit = permit && s.reader_ready === true && s.servo_ready === true && s.enrolling === false && s.cards !== null && s.cards < 16;
        if (name === 'cancel') permit = ready && !!csrf && s.enrolling === true;
        if (name === 'revoke') permit = permit && validateUid(uid?.value);
        if (button) button.disabled = !allowed() || !!active || !permit;
      }
    }
    function cancel() {
      generation++;
      if (active?.post) lastResult = 'Ausgang unbekannt. Nicht automatisch wiederholen.';
      if (active) { env.clearTimeout(active.timeout); active.controller.abort(); active = null; }
      fresh.clear(); csrf = null; render();
    }
    async function request(operation) {
      if (!allowed() || active) return;
      render();
      const post = operation !== 'inspect';
      if (post && get('esp32-' + operation)?.disabled) return;
      let payload;
      if (post) {
        payload = { operation };
        if (operation === 'revoke') { payload.uid = uid.value; uid.value = ''; }
        lastResult = 'Aktion läuft …';
      }
      const clockEpoch = fresh.stamp();
      const w = env.Date.now(), m = env.performance.now(), gen = ++generation;
      const controller = new env.AbortController();
      const job = { controller, post, timeout: null }; active = job; render();
      job.timeout = env.setTimeout(() => {
        if (active !== job) return;
        generation++; controller.abort(); active = null; fresh.clear(); csrf = null;
        if (post) lastResult = 'Ausgang unbekannt. Nicht automatisch wiederholen.';
        render();
      }, post ? 12000 : 4000);
      try {
        const response = await env.fetch('/api/esp32-control', { method: post ? 'POST' : 'GET', cache: 'no-store',
          credentials: 'same-origin', signal: controller.signal,
          headers: post ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : { Accept: 'application/json' },
          ...(post ? { body: JSON.stringify(payload) } : {}) });
        payload = null;
        const e = await response.json();
        if (gen !== generation || !allowed()) return;
        if (!validateEnvelope(e)) throw new Error('invalid');
        fresh.clear(); csrf = null;
        if (response.ok && e.status === 'ok' && e.inspection && e.inspection.operation === 'inspect') {
          fresh.set(e.inspection, w, m, clockEpoch); csrf = e.csrf;
        }
        if (post) {
          const c = e.command;
          if ([400, 403].includes(response.status) && e.command_sent === false) lastResult = 'Nicht gesendet / abgewiesen.';
          else if (e.status === 'outcome_unknown' || c?.status === 'outcome_unknown') lastResult = 'Ausgang unbekannt. Nicht automatisch wiederholen.';
          else if (response.ok && e.status === 'ok' && e.command_sent && c?.command_sent && c.firmware_version === 2 &&
            c.operation === operation && ['ok', 'acknowledged'].includes(c.status))
            lastResult = 'Firmware bestätigt Ziel / Speicherung. Keine mechanische Bestätigung.';
          else lastResult = e.command_sent ? 'Ausgang unbekannt. Nicht automatisch wiederholen.' : 'Nicht gesendet / abgewiesen.';
        }
      } catch (_) {
        if (gen !== generation) return;
        fresh.clear(); csrf = null;
        if (post) lastResult = 'Ausgang unbekannt. Nicht automatisch wiederholen.';
      } finally {
        payload = null;
        env.clearTimeout(job.timeout);
        if (active === job) active = null;
        if (gen === generation) render();
      }
    }
    const listeners = [];
    function on(el, type, fn) { if (el) { el.addEventListener(type, fn); listeners.push(() => el.removeEventListener(type, fn)); } }
    for (const name of names) on(get('esp32-' + name), 'click', () => request(name));
    on(uid, 'input', render);
    on(env, 'evse:manual-mode', e => { if (!settings) { manual = e.detail?.manual === true; cancel(); if (allowed()) request('inspect'); } });
    on(doc, 'visibilitychange', () => { cancel(); if (allowed()) request('inspect'); });
    on(env, 'pagehide', cancel);
    on(env, 'pageshow', () => { cancel(); if (allowed()) request('inspect'); });
    const timer = env.setInterval(() => { render(); if (allowed() && !active) request('inspect'); }, 2000);
    const expiry = env.setInterval(render, 200);
    render(); request('inspect');
    return { render, inspect: () => request('inspect'), destroy() { destroyed = true; cancel(); env.clearInterval(timer); env.clearInterval(expiry); listeners.forEach(fn => fn()); } };
  }
  const api = { validateEnvelope, validateUid, createFreshness, mount };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    scope.EvseEsp32 = api;
    const boot = () => { const root = document.getElementById('esp32-control') || document.getElementById('esp32-rfid'); if (root) mount(root); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
  }
})(typeof window === 'undefined' ? globalThis : window);
