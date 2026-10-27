'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { createViewState, present } = require('../static/smartmeter.js');
const epoch = Date.parse('2026-10-26T12:00:00Z');
function sample(overrides = {}) {
  return { schema_version: 1, read_only: true, status: 'live', reason: 'Aktuelle Daten',
    power_w: 1549.4, fetched_at: new Date(epoch).toISOString(), age_seconds: 0, fresh_for_seconds: 10, ...overrides };
}
function setup() {
  const time = { wall: epoch, mono: 0 }, model = createViewState(() => ({ ...time }));
  return { time, model, receive(data = sample()) { return model.receive(model.begin(), data); },
    advance(ms) { time.wall += ms; time.mono += ms; } };
}
test('API seventh-field semantics: watts, import positive, export negative; actual zero is not unknown', () => {
  // The browser consumes only the API power_w; parsing source fields belongs to PHP.
  const s = setup();
  for (const [power_w, power, direction] of [[1549.4, '+1,55 kW', 'Netzbezug'],
    [-799.4, '-0,80 kW', 'Einspeisung'], [0, '0,00 kW', 'Ausgeglichen'], [-0, '0,00 kW', 'Ausgeglichen']]) {
    assert(s.receive(sample({ power_w })));
    const p = present(s.model.snapshot());
    assert.equal(p['grid-power'], power); assert.equal(p['grid-direction'], direction);
  }
});
test('every non-live status hides power and uses bounded known reasons', () => {
  const s = setup();
  for (const [status, label] of Object.entries({ disabled: 'Nicht eingerichtet', waiting: 'Warten',
    stale: 'Veraltet', offline: 'Offline', read_error: 'Lesefehler', clock_error: 'Zeitfehler' })) {
    s.receive(sample({ status, power_w: null, fresh_for_seconds: 0, reason: '<img src=x onerror=alert(1)>' }));
    const p = present(s.model.snapshot());
    assert.equal(p['grid-status'], label); assert.equal(p['grid-power'], '—');
    assert.equal(p['grid-direction'], 'Unbekannt'); assert(!p['grid-reason'].includes('<'));
  }
});
test('invalid schemas, types, timestamps, non-finite values and budgets fail closed', () => {
  const cases = [null, [], {}, sample({ schema_version: 2 }), sample({ read_only: 1 }), sample({ read_only: false }),
    sample({ status: 'invalid' }), sample({ power_w: null }), sample({ power_w: '1549.4' }),
    ...[NaN, Infinity, -Infinity].map(power_w => sample({ power_w })),
    sample({ fresh_for_seconds: 0 }), sample({ fresh_for_seconds: 121 }), sample({ fresh_for_seconds: 2 }),
    sample({ age_seconds: -1 }), sample({ age_seconds: null }), sample({ age_seconds: '0' }),
    sample({ fetched_at: null }), sample({ fetched_at: '2026-02-30T00:00:00Z' }),
    sample({ fetched_at: '2026-10-26T12:00:00' }), sample({ fetched_at: '2026-10-26T12:00:00+01:00' }),
    sample({ reason: {} }), sample({ reason: 'x'.repeat(1025) }), sample({ unexpected: 1 }),
    sample({ status: 'offline', fresh_for_seconds: 0 }), sample({ status: 'offline', power_w: null }),
    sample({ status: 'offline', power_w: null, fresh_for_seconds: 0, fetched_at: null })];
  for (const data of cases) {
    const s = setup(); s.receive(data);
    assert.equal(s.model.snapshot().power_w, null, JSON.stringify(data));
    assert.equal(present(s.model.snapshot())['grid-direction'], 'Unbekannt');
  }
});
test('UTC fractions and bounded clock skew accepted; excessive future time rejected', () => {
  const s = setup();
  assert(s.receive(sample({ fetched_at: '2026-10-26T12:00:00.000000+00:00' })));
  assert(s.receive(sample({ fetched_at: '2026-10-26T12:00:01Z' })));
  assert(!s.receive(sample({ fetched_at: '2026-10-26T12:00:06Z' })));
  assert.equal(s.model.snapshot().status, 'clock_error');
});
test('rollback above the original anchor never restores consumed freshness', () => {
  const s = setup(); assert(s.receive());
  s.time.wall += 8000; s.time.mono += 1000;
  assert.equal(s.model.snapshot().remaining, 2000);
  s.time.wall -= 6000; s.time.mono += 1000;
  assert.equal(s.model.snapshot().status, 'clock_error');
  assert.equal(s.model.snapshot().power_w, null);
  assert.equal(s.model.snapshot().remaining, 0);
});
test('budget subtracts RTT and elapsed maximum wall/monotonic, expires at equality', () => {
  const s = setup(), token = s.model.begin();
  s.advance(500); assert(s.model.receive(token, sample()));
  assert.equal(s.model.snapshot().remaining, 9500);
  s.time.mono += 9500;
  assert.equal(s.model.snapshot().status, 'stale');
  assert.equal(s.model.snapshot().power_w, null);
  assert.equal(present(s.model.snapshot())['grid-age'], '10,0 s');
});
test('timestamp age and existing age prevent extended freshness', () => {
  const s = setup();
  assert(!s.receive(sample({ fetched_at: '2026-10-26T11:59:50Z' })));
  assert.equal(s.model.snapshot().status, 'stale');
  assert(s.receive(sample({ age_seconds: 9, fresh_for_seconds: 1 })));
  s.advance(1000); assert.equal(s.model.snapshot().power_w, null);
});
test('both clock rollbacks clear values; request rollback fails conservatively', () => {
  for (const key of ['wall', 'mono']) {
    const s = setup(); s.receive(); s.time[key]--;
    assert.equal(s.model.snapshot().status, 'clock_error'); assert.equal(s.model.snapshot().power_w, null);
    const t = setup(), token = t.model.begin(); t.time[key]--;
    assert(!t.model.receive(token, sample())); assert.equal(t.model.snapshot().power_w, null);
  }
});
test('request timeout, failure, resets and late responses cannot resurrect values', () => {
  const s = setup(); s.receive();
  const token = s.model.begin(); s.advance(3000);
  assert.equal(s.model.snapshot().status, 'read_error');
  assert(!s.model.receive(token, sample()));
  const old = s.model.begin(); s.model.reset(); const next = s.model.begin();
  assert(!s.model.receive(old, sample()));
  s.model.fail(old); assert(s.model.receive(next, sample({ fetched_at: new Date(s.time.wall).toISOString() })));
  const failed = s.model.begin(); s.model.fail(failed);
  assert.equal(s.model.snapshot().power_w, null);
});
test('unconfigured with no successful receipt shows no invented date or age', () => {
  const s = setup(); s.receive(sample({ status: 'disabled', power_w: null, fresh_for_seconds: 0,
    fetched_at: null, age_seconds: null }));
  const p = present(s.model.snapshot());
  assert.equal(p['grid-fetched'], '—'); assert.equal(p['grid-age'], '—');
});
test('without smartmeter article script does not poll or access storage', () => {
  vm.runInNewContext(fs.readFileSync(require.resolve('../static/smartmeter.js'), 'utf8'), {
    document: { getElementById: () => null }, fetch() { assert.fail('unexpected request'); },
    setInterval() { assert.fail('unexpected timer'); }
  });
});
