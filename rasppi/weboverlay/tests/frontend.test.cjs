'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createViewState, present, presentStatic, createRenderer, flag } = require('../static/app.js');
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
test('vehicle booleans remain independent; unknown and stale never become yes or no', () => {
  for (const [plugged, charging, expectedPlugged, expectedCharging] of [
    [false, false, 'Nein', 'Nein'], [true, false, 'Ja', 'Nein'],
    [true, true, 'Ja', 'Ja'], [null, false, 'Unbekannt', 'Nein'],
    [true, null, 'Ja', 'Unbekannt'], [null, null, 'Unbekannt', 'Unbekannt']
  ]) {
    const { state, advance } = setup();
    state.receive(state.begin(), live({ values: { ...telemetry, plugged_in: plugged, charging } }));
    assert.equal(present(state.snapshot()).plugged, expectedPlugged);
    assert.equal(present(state.snapshot()).charging, expectedCharging);
    advance(5000);
    assert.equal(present(state.snapshot()).plugged, 'Unbekannt');
    assert.equal(present(state.snapshot()).charging, 'Unbekannt');
  }
});
test('Others may have independently known socket connection without invented charging', () => {
  const { state } = setup();
  state.receive(state.begin(), live({ values: { ...telemetry, charging_state: 5,
    charging_state_raw: 34048, socket_lock_state: 257, plugged_in: true, charging: null } }));
  const text = present(state.snapshot());
  assert.equal(text.plugged, 'Ja'); assert.equal(text.charging, 'Unbekannt');
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

function rendererSetup() {
  const context = setup(), elements = new Map(), writes = [], chartViews = [];
  const ids = [...Object.keys(present(context.state.snapshot())), 'wallbox-warning'];
  for (const id of ids) {
    let text = '', hidden = false, tone;
    elements.set(id, {
      get textContent() { return text; },
      set textContent(value) { writes.push([id, 'text', value]); text = value; },
      get hidden() { return hidden; },
      set hidden(value) { writes.push([id, 'hidden', value]); hidden = value; },
      dataset: {
        get tone() { return tone; },
        set tone(value) { writes.push([id, 'tone', value]); tone = value; }
      }
    });
  }
  let staticCalls = 0;
  const render = createRenderer({
    document: { getElementById: id => elements.get(id) || null },
    charts: { update: view => chartViews.push(view) },
    formatStatic: view => { staticCalls++; return presentStatic(view); }
  });
  return { ...context, elements, writes, chartViews, draw: () => render(context.state.snapshot()),
    get staticCalls() { return staticCalls; } };
}
test('unchanged freshness ticks cache static presentation but keep every chart/loader tick', () => {
  const r = rendererSetup();
  r.state.receive(r.state.begin(), live({ fresh_for_seconds: 20 })); r.draw();
  r.writes.length = 0;
  for (let i = 0; i < 100; i++) { r.advance(100); r.draw(); }
  assert.equal(r.staticCalls, 1);
  assert.equal(r.chartViews.length, 101);
  assert.ok(r.writes.length > 0, 'countdown remains active');
  assert.ok(r.writes.every(([id, type]) => ['freshness', 'age'].includes(id) && type === 'text'));
  assert.equal(r.elements.get('freshness').textContent, present(r.state.snapshot()).freshness);
  r.writes.length = 0; r.draw();
  assert.deepEqual(r.writes, [], 'identical tick writes neither text nor attributes');
});
test('cached presentation expires at the exact freshness boundary without another response', () => {
  const r = rendererSetup();
  r.state.receive(r.state.begin(), live({ fresh_for_seconds: 1 })); r.draw();
  r.state.begin(); // A pending request must not extend the old value lifetime.
  r.advance(999); r.draw();
  assert.equal(r.staticCalls, 1);
  assert.notEqual(r.elements.get('power').textContent, '—');
  r.advance(1); r.draw();
  assert.equal(r.staticCalls, 2);
  assert.equal(r.elements.get('power').textContent, '—');
  assert.equal(r.elements.get('plugged').textContent, 'Unbekannt');
  assert.equal(r.elements.get('freshness').textContent, '—');
  assert.equal(r.chartViews.at(-1).status, 'stale');
});
test('a new response with the same timestamp invalidates all static fields including unknown flags', () => {
  const r = rendererSetup();
  r.state.receive(r.state.begin(), live()); r.draw();
  const oldStamp = r.chartViews.at(-1).envelope.timestamp;
  r.state.receive(r.state.begin(), live({ values: { ...telemetry,
    active_power_w: 2750, error_code: 7, plugged_in: null, charging: null } })); r.draw();
  assert.equal(r.staticCalls, 2);
  assert.equal(r.chartViews.at(-1).envelope.timestamp, oldStamp);
  assert.equal(r.chartViews.at(-1).values.active_power_w, 2750);
  assert.equal(r.elements.get('power').textContent, present(r.state.snapshot()).power);
  assert.equal(r.elements.get('plugged').textContent, 'Unbekannt');
  assert.equal(r.elements.get('charging').textContent, 'Unbekannt');
  assert.equal(r.elements.get('wallbox-warning').hidden, false);
  assert.equal(r.elements.get('wallbox-error').dataset.tone, 'warning');
  r.writes.length = 0; r.draw();
  assert.deepEqual(r.writes, []);
});
test('offline/null views keep loader ticks alive without repeating static preparation or DOM writes', () => {
  const r = rendererSetup();
  r.state.receive(r.state.begin(), live()); r.draw();
  r.state.receive(r.state.begin(), live({ status: 'offline' })); r.draw();
  assert.equal(r.elements.get('power').textContent, '—');
  r.state.reset(); r.draw();
  const calls = r.staticCalls, chartCalls = r.chartViews.length;
  r.writes.length = 0;
  for (let i = 0; i < 610; i++) { r.advance(100); r.draw(); }
  assert.equal(r.staticCalls, calls);
  assert.equal(r.chartViews.length, chartCalls + 610);
  assert.deepEqual(r.writes, []);
});
test('timeout and either backwards clock invalidate cached live presentation on the next tick', () => {
  for (const mode of ['timeout', 'wall', 'mono', 'suspend']) {
    const r = rendererSetup();
    r.state.receive(r.state.begin(), live({ fresh_for_seconds: 20 })); r.draw();
    if (mode === 'timeout') { r.state.begin(); r.advance(3000); }
    else if (mode === 'suspend') r.time.wall += 60000;
    else r.time[mode]--;
    r.draw();
    assert.equal(r.staticCalls, 2, mode);
    assert.equal(r.elements.get('power').textContent, '—', mode);
    assert.equal(r.elements.get('plugged').textContent, 'Unbekannt', mode);
    assert.equal(r.chartViews.at(-1).values, null, mode);
  }
});
test('nonlive transitions and recovery never reuse cached live or unknown presentation', () => {
  for (const status of ['waiting', 'offline', 'stale', 'clock_error', 'invalid', 'read_error']) {
    const r = rendererSetup();
    r.state.receive(r.state.begin(), live({ values: { ...telemetry, error_code: 7 } })); r.draw();
    r.state.receive(r.state.begin(), live({ status })); r.draw();
    assert.equal(r.elements.get('power').textContent, '—', status);
    assert.equal(r.elements.get('charging').textContent, 'Unbekannt', status);
    assert.equal(r.elements.get('wallbox-warning').hidden, true, status);
    r.state.receive(r.state.begin(), live()); r.draw();
    assert.equal(r.elements.get('power').textContent, present(r.state.snapshot()).power, status);
    assert.equal(r.elements.get('charging').textContent, 'Nein', status);
    // A fresh envelope with identical contents may reformat, but must not
    // rewrite unchanged attributes or text (including warning.hidden).
    r.writes.length = 0;
    r.state.receive(r.state.begin(), live()); r.draw();
    assert.deepEqual(r.writes, [], status);
  }
});
