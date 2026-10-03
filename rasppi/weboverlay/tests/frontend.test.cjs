'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createViewState, present, flag } = require('../static/app.js');
const telemetry = {
  error_code: 0, socket_lock_state: 2, charging_state_raw: 3, charging_state: 3,
  below_commanded_current: false, plugged_in: true, charging: false,
  current_limit_a: 16, current_a: [0, 0, 0], voltage_v: [230, 231, 229],
  active_power_w: 0, session_energy_wh: 1234
};
const live = (overrides = {}) => ({ schema_version: 1, read_only: true, status: 'live', reason: 'Aktuell',
  broker_connected: true, availability: 'online', timestamp: '2026-01-01T12:00:00Z',
  last_success_at: '2026-01-01T12:00:00Z', age_seconds: 0, fresh_for_seconds: 5,
  values: { ...telemetry }, error: null, ...overrides });
function setup() {
  const time = { mono: 0, wall: 100000 };
  const state = createViewState(() => ({ ...time }));
  const advance = ms => { time.mono += ms; time.wall += ms; };
  return { state, time, advance };
}
test('freshness subtracts full request roundtrip and expires without another response', () => {
  const { state, advance } = setup();
  const token = state.begin(); advance(800); state.receive(token, live());
  assert.equal(state.snapshot().remaining, 4200);
  advance(4199); assert.ok(state.snapshot().values);
  advance(1); assert.equal(state.snapshot().values, null);
  assert.equal(state.snapshot().status, 'stale');
});
test('zero or exhausted freshness never displays live values', () => {
  for (const seconds of [0, 0.1]) {
    const { state, advance } = setup(); const token = state.begin(); advance(200);
    assert.equal(state.receive(token, live({ fresh_for_seconds: seconds })), false);
    assert.equal(state.snapshot().values, null);
  }
});
test('timeout hides old values and rejects a delayed response', () => {
  const { state, advance } = setup(); state.receive(state.begin(), live({ fresh_for_seconds: 20 }));
  const token = state.begin(); advance(3000);
  assert.equal(state.snapshot().status, 'read_error');
  assert.equal(state.snapshot().values, null);
  assert.equal(state.receive(token, live()), false);
});
test('delayed response cannot bypass timeout when timeout callback has not run', () => {
  const { state, advance } = setup(); const token = state.begin(); advance(3001);
  assert.equal(state.receive(token, live()), false);
  assert.equal(state.snapshot().values, null);
});
test('fetch failure clears immediately and invalidates its token', () => {
  const { state } = setup(); state.receive(state.begin(), live());
  const token = state.begin(); state.fail(token);
  assert.equal(state.snapshot().values, null);
  assert.equal(state.receive(token, live()), false);
});
test('wall clock detects suspend even if the monotonic clock stopped', () => {
  const { state, time } = setup(); state.receive(state.begin(), live());
  time.wall += 60000;
  assert.equal(state.snapshot().values, null);
});
test('backwards clock movement invalidates conservatively', () => {
  const { state, time } = setup(); state.receive(state.begin(), live()); time.wall -= 1;
  assert.equal(state.snapshot().values, null);
});
test('visibility reset removes old data and rejects in-flight responses until refetched', () => {
  const { state } = setup(); state.receive(state.begin(), live()); const old = state.begin();
  state.reset(); assert.equal(state.snapshot().values, null);
  const current = state.begin(); assert.equal(state.receive(old, live()), false);
  assert.equal(state.receive(current, live()), true);
});
test('expiry still works while a request hangs, before the request timeout', () => {
  const { state, advance } = setup(); state.receive(state.begin(), live({ fresh_for_seconds: 1 }));
  state.begin(); advance(1000); assert.equal(state.snapshot().status, 'stale');
});
test('unknown flags remain unknown, plugged in and charging are distinct', () => {
  assert.equal(flag(null), 'Unbekannt'); assert.equal(flag(false), 'Nein');
  const { state } = setup(); state.receive(state.begin(), live());
  assert.equal(present(state.snapshot()).plugged, 'Ja');
  assert.equal(present(state.snapshot()).charging, 'Nein');
  state.receive(state.begin(), live({ values: { ...telemetry, plugged_in: null, charging: null } }));
  assert.equal(present(state.snapshot()).plugged, 'Unbekannt');
  assert.equal(present(state.snapshot()).charging, 'Unbekannt');
});
test('all nonlive statuses mask telemetry, even if a payload contains old values', () => {
  for (const status of ['waiting', 'offline', 'stale', 'clock_error', 'invalid', 'read_error']) {
    const { state } = setup(); state.receive(state.begin(), live({ status })); const p = present(state.snapshot());
    for (const key of ['power', 'energy', 'limit', 'current-0', 'voltage-2', 'lock', 'wallbox-error', 'charging-state', 'charging-raw', 'age']) assert.equal(p[key], '—');
    for (const key of ['plugged', 'charging', 'below']) assert.equal(p[key], 'Unbekannt');
  }
});
test('online telemetry does not mask a wallbox error', () => {
  const { state } = setup(); state.receive(state.begin(), live({ values: { ...telemetry, error_code: 7 } }));
  const p = present(state.snapshot()); assert.equal(p.availability, 'Online');
  assert.equal(p['wallbox-error'], 'Wallbox-Fehler · Code 7');
});
test('invalid envelope and invalid telemetry fail closed', () => {
  for (const bad of [null, live({ schema_version: 2 }), live({ read_only: false }), live({ status: 'constructor' }),
    live({ fresh_for_seconds: -1 }), live({ fresh_for_seconds: Infinity }), live({ values: null }),
    live({ values: { ...telemetry, current_a: [1] } }), live({ values: { ...telemetry, charging: 'false' } })]) {
    const { state } = setup(); state.receive(state.begin(), live()); state.receive(state.begin(), bad);
    assert.equal(state.snapshot().status, 'invalid'); assert.equal(state.snapshot().values, null);
  }
});
