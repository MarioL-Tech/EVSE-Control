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

const house = require('../static/smartmeter-chart.js');
function houseView(t, power_w = 1000, status = 'live') {
  return { status, power_w, remaining: status === 'live' ? 10000 : 0,
    envelope: { fetched_at: typeof t === 'string' ? t : new Date(t).toISOString() } };
}
test('house keeps signed watts and actual zero; fetched_at dedupes even changed payloads', () => {
  const h = house.createHistory();
  h.observe(houseView(epoch, 1549.4), epoch);
  h.observe(houseView(epoch, -999), epoch + 100);
  h.observe(houseView(epoch + 1000, -799.4), epoch + 1000);
  h.observe(houseView(epoch + 2000, 0), epoch + 2000);
  assert.deepEqual(h.window(epoch + 2000).map(p => p.power_w), [1549.4, -799.4, 0]);
  const plot = house.buildPlot(h.window(epoch + 2000), epoch, epoch + 3000);
  assert(plot.lo < -.7994 && plot.hi > 1.5494);
  assert.equal((plot.path.match(/L/g) || []).length, 2);
  assert.equal(plot.markers.length, 1, 'Connected samples need only the latest marker');
  assert(Number.isFinite(plot.zeroY));
});
test('house fetched_at normalizes UTC fractions without losing microsecond deduplication', () => {
  const h = house.createHistory();
  h.observe(houseView('2026-10-26T12:00:00.000001Z'), epoch + 1);
  h.observe(houseView('2026-10-26T12:00:00.000001+00:00'), epoch + 2);
  h.observe(houseView('2026-10-26T12:00:00.000002Z'), epoch + 3);
  assert.equal(h.size, 2);
});
test('house failure, stale, null, bad timestamps and lifecycle never heal on a duplicate', () => {
  for (const invalid of [houseView(epoch + 500, null), houseView(epoch + 500, NaN),
    houseView(epoch + 500, Infinity), houseView('bad'), houseView('2026-02-30T00:00:00Z'),
    houseView(epoch + 6000), { ...houseView(epoch), remaining: 0 },
    ...['waiting', 'disabled', 'offline', 'read_error', 'stale', 'clock_error'].map(s => houseView(epoch, null, s))]) {
    const h = house.createHistory();
    h.observe(houseView(epoch), epoch);
    h.observe(invalid, epoch + 500);
    h.observe(houseView(epoch), epoch + 750);
    h.observe(houseView(epoch + 1000), epoch + 1000);
    assert.equal(h.size, 2);
    assert.equal(h.window(epoch + 1000)[1].breakBefore, true);
    assert(!house.buildPlot(h.window(epoch + 1000), epoch, epoch + 1000).path.includes('L'));
  }
  const h = house.createHistory(); h.observe(houseView(epoch), epoch); h.gap();
  h.observe(houseView(epoch), epoch + 100); h.observe(houseView(epoch + 1000), epoch + 1000);
  assert(h.window(epoch + 1000)[1].breakBefore);
});
test('house clock rollback clears RAM conservatively; request pauses and fetched clock rollback break edges', () => {
  const h = house.createHistory();
  h.observe(houseView(epoch), epoch); h.observe(houseView(epoch + 1000), epoch + 1000);
  h.observe(houseView(epoch + 500), epoch + 2000);
  h.observe(houseView(epoch + 3000), epoch + 3000);
  assert(h.window(epoch + 3000)[2].breakBefore);
  h.observe(houseView(epoch + 14000), epoch + 14000);
  assert(h.window(epoch + 14000)[3].breakBefore);
  h.observe(houseView(epoch), epoch);
  assert.equal(h.size, 1, 'A new clock epoch accepts its first valid fetch');
  h.observe(houseView(epoch + 1000), epoch + 1000);
  assert.equal(h.size, 2, 'Clock rollback must not keep the old timestamp gate');
  h.observe(houseView(epoch + 15000), epoch + 15000);
  assert.equal(h.size, 3); assert(h.window(epoch + 15000).at(-1).breakBefore);
});
test('house bounds RAM to 1200 / 15 minutes and synchronizes 1/5/15 minute windows', () => {
  const h = house.createHistory();
  for (let i = 0; i < 1500; i++) h.observe(houseView(epoch + i * 100, i), epoch + i * 100);
  assert.equal(h.size, 1200);
  assert(h.window(epoch + 149900, 1).length < h.window(epoch + 149900, 5).length);
  assert.equal(h.window(epoch + 149900, 15).length, 1200);
  assert.equal(h.window(epoch + 150000 + house.RETENTION_MS, 15).length, 0);
  assert.equal(h.size, 0);
});
test('house plotting preserves NULL barriers and isolated points instead of fake zero', () => {
  const points = [{ t: epoch, power_w: 0 }, { t: epoch + 1000, power_w: null },
    { t: epoch + 2000, power_w: -1000 }];
  const plot = house.buildPlot(points, epoch, epoch + 2000);
  assert.equal(plot.count, 2); assert.equal(plot.markers.length, 2);
  assert.equal((plot.path.match(/M/g) || []).length, 2); assert(!plot.path.includes('L'));
  assert(!/NaN|Infinity/.test(house.buildPlot([], epoch, epoch + 2000).path));
});
test('house module stays inert on overview and absent chart DOM without storage/timers/requests', () => {
  for (const pathname of ['/', '/diagramme']) vm.runInNewContext(
    fs.readFileSync(require.resolve('../static/smartmeter-chart.js'), 'utf8'), {
      window: { location: { pathname }, get localStorage() { assert.fail('storage'); } },
      document: { getElementById: () => null }, fetch() { assert.fail('request'); },
      setInterval() { assert.fail('timer'); }
    });
});
