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
