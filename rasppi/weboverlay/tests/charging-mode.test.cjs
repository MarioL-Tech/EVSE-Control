'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const api = require('../static/charging-mode.js');
const h = (n, char = 'a') => char.repeat(n);
const observation = overrides => ({ schema_version: 1, guard: h(32), requested_mode: 'pv', activation_id: h(32, 'b'),
  config_revision: h(64), state: 'charging', plan: 'ok', house: 'ok', ...overrides });
const mode = overrides => ({ schema_version: 1, status: 'ok', csrf: h(64), mode_revision: null, config_revision: h(64),
  activation: { mode: 'manual', id: h(32, '0'), guard: h(32, '0') }, required: [], automation_available: true,
  semantics: 'activation_requested', ...overrides });
const inspection = overrides => ({ status: 'ok', csrf: h(64), command_sent: false, command: null,
  inspection: { schema_version: 1, status: 'ok', operation: 'inspect', read_only: true, reason: 'read_only_inspection',
    id: h(32), session: h(32), lease: h(32), fresh_for_seconds: 8, minimum_ma: 6000, software_max_ma: 32000,
    hardware_max_ma: 32000, installation_max_ma: null, effective_max_ma: null, firmware_raw: null,
    write: null, preparation: null, automation: observation(), ...overrides } });
test('automation exact shape and fixed state/HTTP vocabularies', () => {
  assert.deepEqual(api.automation(observation()), observation());
  for (const overrides of [{ guard: 'raw-secret' }, { state: '<script>' }, { house: 'arbitrary' },
    { requested_mode: 'on' }, { activation_id: false }, { config_revision: h(32) }, { extra: true }])
    assert.equal(api.automation(observation(overrides)), null);
  assert.equal(api.automation(null), null);
  for (const state of api.STATES) assert.ok(api.automation(observation({ state })));
  for (const value of api.HTTP) assert.ok(api.automation(observation({ house: value, plan: value })));
});
test('mode response validates activation intent, not actual charging', () => {
  assert.equal(api.modeResponse(mode()).semantics, 'activation_requested');
  for (const overrides of [{ schema_version: 2 }, { csrf: 'token' }, { semantics: 'active' },
    { config_revision: null }, { mode_revision: 5 }, { activation: { mode: 'pv' } }, { required: ['x'] }])
    assert.throws(() => api.modeResponse(mode(overrides)));
  assert.equal(api.modeResponse(mode({ status: 'invalid', reason: 'missing_configuration', required: ['installation.phases'] })).status, 'invalid');
  assert.throws(() => api.modeResponse(mode({ status: 'invalid', reason: 'missing_configuration', required: ['<script>'] })));
  assert.throws(() => api.modeResponse(mode({ missing_by_mode: { pv: ['custom.windows'], custom: [] } })));
  assert.throws(() => api.modeResponse(mode({ missing_by_mode: { pv: [], custom: ['unknown'] } })));
  assert.doesNotThrow(() => api.modeResponse(mode({ missing_by_mode: { pv: ['pv.resume_seconds'], custom: [] } })));
});
test('fresh successful protocol inspection required, installation max not a guard gate', () => {
  assert.equal(api.controlResponse(inspection()).guard, h(32));
  assert.equal(api.controlResponse(inspection({ automation: undefined })), null);
  for (const overrides of [{ status: 'busy' }, { read_only: false }, { lease: null }, { fresh_for_seconds: 0 },
    { operation: 'start' }, { reason: 'raw' }, { hardware_max_ma: -1 }, { write: {} }])
    assert.throws(() => api.controlResponse(inspection(overrides)));
});
test('bounded JSON rejects duplicate escaped keys, malformed values and nested bombs', () => {
  assert.deepEqual(api.strictJSON('{"a":[true,null,1]}'), { a: [true, null, 1] });
  for (const value of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '1e999', '{"x":}', '[1,]',
    'null trailing', '[01]', '"\u0000"', '['.repeat(30) + '0' + ']'.repeat(30), ' '.repeat(16385), '"' + '€'.repeat(6000) + '"'])
    assert.throws(() => api.strictJSON(value));
});
test('stream reader caps actual bytes and rejects non-JSON and invalid UTF8', async () => {
  assert.deepEqual(await api.readBody(new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } })), { ok: true });
  await assert.rejects(api.readBody(new Response('{}', { headers: { 'Content-Type': 'text/html' } })));
  await assert.rejects(api.readBody(new Response(' '.repeat(16385), { headers: { 'Content-Type': 'application/json' } })));
  await assert.rejects(api.readBody(new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json' } })));
});
test('actual mode controller: disabled URL, stale support, draft recovery and manual fallback never replay', { timeout: 5000 }, async () => {
  class ViewEvent extends Event { constructor(name, { detail }) { super(name); this.detail = detail; } }
  class Element extends EventTarget {
    constructor() { super(); this.attributes = new Map(); }
    getAttribute(k) { return this.attributes.get(k); } setAttribute(k,v) { this.attributes.set(k,v); }
  }
  const win = Object.assign(new EventTarget(), { AbortController, CustomEvent: ViewEvent, performance, setTimeout, clearTimeout });
  const doc = Object.assign(new EventTarget(), { hidden: false, activeElement: null });
  const nodes = new Map(['wallbox-control','automation-status','automation-feedback','automation-profile-link','automation-setup-link', ...api.MODES.map(m => 'control-mode-' + m)].map(id => [id, new Element()]));
  doc.getElementById = id => nodes.get(id); const radio = m => nodes.get('control-mode-' + m);
  nodes.get('wallbox-control').querySelectorAll = () => api.MODES.map(radio);
  const status = nodes.get('automation-status'), link = nodes.get('automation-setup-link'), feedback = nodes.get('automation-feedback');
  let reader = observation({ requested_mode: 'manual', state: 'manual', plan: 'disabled', house: 'disabled' });
  let draft = mode({ missing_by_mode: { pv: ['installation.phases', 'pv.resume_seconds'], custom: [] } });
  let detail, holdNextControl = null; const calls = [];
  win.addEventListener('evse:automation-mode', e => { detail = e.detail; });
  const observe = () => win.dispatchEvent(new ViewEvent('evse:automation-observation', { detail: { automation: reader } }));
  const settle = () => !detail.pending ? Promise.resolve() : new Promise(resolve => {
    const done = e => { if (!e.detail.pending) { win.removeEventListener('evse:automation-mode', done); resolve(); } };
    win.addEventListener('evse:automation-mode', done);
  });
  const choose = async m => { assert.equal(radio(m).disabled, false); radio(m).dispatchEvent(new Event('click')); await settle(); };
  const controller = api.mount(win, doc, async (path, opts) => {
    calls.push([path, opts.method || 'GET']);
    if (holdNextControl && path.endsWith('wallbox-control')) { const wait = holdNextControl; holdNextControl = null; await wait; }
    const body = path.endsWith('wallbox-control') ? inspection({ automation: reader }) : opts.method === 'POST' ?
      mode({ mode_revision: h(64, 'd'), activation: { mode: JSON.parse(opts.body).mode,
        id: h(32, calls.filter(c => c[1] === 'POST').length === 1 ? 'd' : 'e'), guard: reader.guard } }) : draft;
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  });
  assert.equal(detail.mode, 'manual'); assert(!radio('manual').disabled, 'passive GET does not gate the independent manual choice');
  await settle(); observe(); assert(radio('pv').disabled); assert(!radio('manual').disabled);
  assert.match(status.textContent, /Regler-Verbindung.*http:\/\/weboverlay:8080.*Reader neu erstellen/); assert.match(link.getAttribute('href'), /#env-heading$/);
  await choose('manual'); assert.equal(calls.length, 1, 'disabled reader needs no mode API for hand control');
  reader = { ...reader, plan: 'ok', house: 'ok' }; observe();
  reader = { ...reader, plan: 'invalid_base' }; // different result in the mandatory fresh inspect
  await choose('pv'); assert.match(status.textContent, /Reader-URL ungültig/); assert.equal(calls.length, 2);
  reader = { ...reader, plan: 'ok' }; observe(); await choose('pv'); observe();
  assert.match(feedback.textContent, /Phasenanzahl, Wiederaufnahmeverzögerung/); assert(!nodes.get('automation-profile-link').hidden);
  assert(calls.every(c => c[1] === 'GET'));
  const beforeUpdates = calls.length;
  reader = { ...reader, state: 'source_unavailable' }; observe();
  assert.match(status.textContent, /Messquelle nicht verfügbar/); assert.match(feedback.textContent, /Phasenanzahl/);
  draft = mode({ status: 'disabled', csrf: null }); await controller.refresh();
  reader = { ...reader, state: 'frozen' }; observe();
  assert.match(status.textContent, /Automatik gesperrt/);
  assert.equal(calls.length, beforeUpdates + 1, 'Only the explicit passive draft refresh read; no requests for reader observations');
  draft = mode({ missing_by_mode: { pv: [], custom: [] } }); await controller.refresh();
  assert(calls.every(c => c[1] === 'GET'), 'fixing a draft cannot activate it');
  await choose('pv'); assert.equal(calls.filter(c => c[1] === 'POST').length, 1);
  reader = observation({ activation_id: h(32, 'd') }); observe(); assert(radio('pv').checked);
  draft = mode({ status: 'disabled', csrf: null }); await choose('manual'); observe();
  assert(radio('manual').checked); assert.equal(detail.mode, 'manual');
  assert.match(feedback.textContent, /Wechsel des Reglers nicht bestätigt/); assert.match(status.textContent, /Regler meldet Ladebetrieb/);
  assert.equal(calls.filter(c => c[1] === 'POST').length, 1, 'local manual fallback sends no hardware or mode write');
  draft = mode(); let release;
  holdNextControl = new Promise(resolve => { release = resolve; });
  radio('pv').dispatchEvent(new Event('click')); assert(detail.pending);
  await choose('manual'); release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(c => c[1] === 'POST').length, 2, 'manual can preempt held PV lookup; no deferred PV POST');
  assert(radio('manual').checked);
  assert(!calls.some(c => c[0].endsWith('wallbox-control') && c[1] === 'POST'));
});
