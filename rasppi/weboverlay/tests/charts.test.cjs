'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { METRICS, GROUPS, MAX_POINTS, RETENTION_MS, createHistory, buildPlot,
  defaults, normalizePreferences, loadPreferences, savePreferences, readings } = require('../static/charts.js');
const epoch = Date.parse('2026-10-04T12:00:00Z');
const values = { active_power_w: 7400, session_energy_wh: 1500, current_limit_a: 16,
  current_a: [6.123, 5, 0], voltage_v: [235.7, 234, 236], plugged_in: true, charging: false,
  below_commanded_current: true, error_code: 0, charging_state: 1, charging_state_raw: 33024, socket_lock_state: 273 };
const live = (t, overrides = {}) => ({ status: 'live', envelope: { timestamp: new Date(t).toISOString() },
  values: { ...values, ...overrides } });
const plot = (history, id, now, selected = defaults().selected) => buildPlot(history.window(now, 15),
  GROUPS.find(g => g.id === id), selected, now - RETENTION_MS, now);

test('readings keep units, genuine zero, and unknown flags distinct', () => {
  const v = readings({ ...values, plugged_in: null, charging: false });
  assert.equal(v.power, 7.4); assert.equal(v.energy, 1.5); assert.equal(v['current-0'], 6.123);
  assert.equal(v.plugged, null); assert.equal(v.charging, 0); assert.equal(v.below, 1);
  assert.equal(readings({ ...values, active_power_w: Infinity }).power, null);
});
test('polling a cached timestamp adds no measurements, same-second updates replace only values', () => {
  const h = createHistory();
  for (let i = 0; i < 50; i++) h.observe(live(epoch), epoch + i * 100);
  assert.equal(h.size, 1);
  h.observe(live(epoch, { active_power_w: 8000 }), epoch + 5000);
  assert.equal(h.size, 1); assert.equal(h.window(epoch + 5000, 15)[0].values.power, 8);
});
test('offline/recovery gaps cannot be filled by the same cached timestamp', () => {
  const h = createHistory();
  h.observe(live(epoch), epoch);
  h.observe({ status: 'offline', values: null }, epoch + 1000);
  h.observe(live(epoch, { active_power_w: 9000 }), epoch + 2000);
  assert.equal(h.size, 1); assert.equal(h.window(epoch + 2000, 15)[0].values.power, 7.4);
  h.observe(live(epoch + 4000), epoch + 4000);
  const path = plot(h, 'power', epoch + 4000).paths[0].path;
  assert.equal((path.match(/M/g) || []).length, 2); assert(!path.includes('L'));
});
test('all nonlive states create gaps, without invented zero measurements', () => {
  for (const status of ['waiting', 'offline', 'stale', 'clock_error', 'invalid', 'read_error']) {
    const h = createHistory(); h.observe(live(epoch), epoch);
    h.observe({ status, values: null }, epoch + 1000);
    h.observe(live(epoch + 2000), epoch + 2000);
    assert.equal(h.size, 2);
    assert.equal((plot(h, 'power', epoch + 2000).paths[0].path.match(/M/g) || []).length, 2);
  }
});
test('regular samples connect; unknown values and missed intervals break individual lines', () => {
  const h = createHistory();
  h.observe(live(epoch), epoch); h.observe(live(epoch + 2000), epoch + 2000);
  assert(plot(h, 'power', epoch + 2000).paths[0].path.includes('L'));
  h.observe(live(epoch + 4000, { plugged_in: null }), epoch + 4000);
  h.observe(live(epoch + 6000), epoch + 6000);
  const flag = plot(h, 'flags', epoch + 6000).paths.find(p => p.metric.id === 'plugged').path;
  assert.equal((flag.match(/M/g) || []).length, 2); assert(flag.includes('H') && flag.includes('V'));
  h.observe(live(epoch + 20000), epoch + 20000);
  assert.equal((plot(h, 'power', epoch + 20000).paths[0].path.match(/M/g) || []).length, 2);
});
test('buffer has point and 15 minute bounds even at high sample rates', () => {
  const h = createHistory();
  for (let i = 0; i < MAX_POINTS + 100; i++) h.observe(live(epoch + i), epoch + i);
  assert.equal(h.size, MAX_POINTS);
  h.observe({ status: 'offline' }, epoch + RETENTION_MS + 5000);
  assert.equal(h.size, 0);
});
test('same-second unknown transitions keep gaps on both sides of only that series', () => {
  for (const key of ['plugged_in', 'charging']) {
    const id = key === 'plugged_in' ? 'plugged' : 'charging';
    const h = createHistory();
    h.observe(live(epoch, { [key]: true }), epoch);
    h.observe(live(epoch + 2000, { [key]: null }), epoch + 2000);
    h.observe(live(epoch + 2000, { [key]: true }), epoch + 2100);
    h.observe(live(epoch + 4000, { [key]: true }), epoch + 4000);
    const path = plot(h, 'flags', epoch + 4000).paths.find(p => p.metric.id === id).path;
    assert.equal((path.match(/M/g) || []).length, 3);
    assert.equal((plot(h, 'power', epoch + 4000).paths[0].path.match(/M/g) || []).length, 1);
    const copy = h.window(epoch + 4000, 15); copy[1].seriesBreak[id] = false;
    assert(h.window(epoch + 4000, 15)[1].seriesBreak[id]);
  }
});
test('clock reversal resets history; future/old/invalid timestamps do not enter it', () => {
  const h = createHistory(); h.observe(live(epoch), epoch);
  h.observe({ status: 'waiting' }, epoch - 1000); assert.equal(h.size, 0);
  h.observe(live(epoch + 20000), epoch); assert.equal(h.size, 0);
  h.observe(live(epoch - RETENTION_MS - 1), epoch); assert.equal(h.size, 0);
  h.observe({ status: 'live', values, envelope: { timestamp: 'not-a-date' } }, epoch);
  assert.equal(h.size, 0);
});
test('late out-of-order samples cannot rewrite time order or bridge a gap', () => {
  const h = createHistory(); h.observe(live(epoch), epoch);
  h.observe(live(epoch - 1000), epoch + 1000); h.observe(live(epoch + 2000), epoch + 2000);
  assert.equal(h.size, 2);
  assert.equal((plot(h, 'power', epoch + 2000).paths[0].path.match(/M/g) || []).length, 2);
});
test('window has copy ownership and restricts selected time range', () => {
  const h = createHistory(); h.observe(live(epoch), epoch);
  const result = h.window(epoch, 1); result[0].values.power = 99;
  assert.equal(h.window(epoch, 1)[0].values.power, 7.4);
  assert.equal(h.window(epoch + 120000, 1).length, 0);
  assert.equal(h.window(epoch + 120000, 5).length, 1);
});
test('hidden metrics vanish from plot series; booleans use fixed 0/1 axes', () => {
  const h = createHistory(); h.observe(live(epoch), epoch);
  const selected = { ...defaults().selected, 'current-1': false };
  assert(!plot(h, 'current', epoch, selected).metrics.some(m => m.id === 'current-1'));
  const flags = plot(h, 'flags', epoch); assert.equal(flags.lo, 0); assert.equal(flags.hi, 1);
  assert.deepEqual(plot(h, 'current', epoch, Object.fromEntries(METRICS.map(m => [m.id, false]))).paths, []);
});
test('empty and constant charts have finite coordinates and defined axes', () => {
  for (const g of GROUPS) {
    const p = buildPlot([], g, defaults().selected, epoch - 60000, epoch);
    assert(Number.isFinite(p.lo) && Number.isFinite(p.hi) && p.hi > p.lo);
  }
  const h = createHistory(); h.observe(live(epoch, { active_power_w: 0 }), epoch);
  assert(!/NaN|Infinity/.test(plot(h, 'power', epoch).paths[0].path));
});
test('preferences persist booleans only and whitelist IDs/ranges', () => {
  const normal = normalizePreferences({ minutes: 15, selected: { power: false, charging: 'false', injected: true } });
  assert.equal(normal.minutes, 15); assert.equal(normal.selected.power, false);
  assert.equal(normal.selected.charging, true); assert(!Object.hasOwn(normal.selected, 'injected'));
  assert.equal(normalizePreferences({ minutes: Infinity }).minutes, 5);
  const storage = { value: null, getItem() { return this.value; }, setItem(key, value) { this.value = value; } };
  assert(savePreferences(storage, normal)); assert.deepEqual(loadPreferences(storage), normal);
  storage.value = '{broken'; assert.deepEqual(loadPreferences(storage), defaults());
});
test('disabled/unavailable storage degrades without losing current-page preferences', () => {
  const denied = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } };
  assert.deepEqual(loadPreferences(denied), defaults()); assert.equal(savePreferences(denied, defaults()), false);
  assert.deepEqual(loadPreferences(null), defaults());
});
