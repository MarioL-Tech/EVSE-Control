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
test('identical freshness ticks do not reread metrics but still enforce clock, age and outage barriers', () => {
  const h = createHistory(), view = live(epoch);
  let reads = 0;
  Object.defineProperty(view.values, 'active_power_w', { get() { reads++; return 7400; } });
  h.observe(view, epoch);
  const first = reads, revision = h.revision;
  for (let i = 1; i <= 100; i++) h.observe(view, epoch + i * 100);
  assert.equal(reads, first); assert.equal(h.revision, revision);
  h.observe({ status: 'stale', values: null }, epoch + 10100);
  h.observe(view, epoch + 10200);
  h.observe(live(epoch + 12000), epoch + 12000);
  assert.equal((plot(h, 'power', epoch + 12000).paths[0].path.match(/M/g) || []).length, 2);
  h.observe(view, epoch - 1); assert.equal(h.size, 1, 'Rollback clears the old timeline even for a reused envelope');
  h.observe(view, epoch + RETENTION_MS + 1); assert.equal(h.size, 0);
});
test('page restoration clears measurements, timestamp identity and clock anchors', () => {
  const h = createHistory();
  h.observe(live(epoch), epoch); h.observe(live(epoch + 2000), epoch + 2000);
  const revision = h.revision;
  h.clear();
  assert.equal(h.size, 0); assert(h.revision > revision);
  h.observe(live(epoch), epoch);
  assert.equal(h.size, 1);
  const p = plot(h, 'power', epoch);
  assert(!p.paths[0].path.includes('L')); assert.equal(p.paths[0].markers.length, 1);
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
  assert.equal(plot(h, 'power', epoch + 4000).paths[0].markers.length, 1,
    'Subpixel-near isolated markers are thinned without joining their paths');
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
  assert.equal(plot(h, 'power', epoch + 2000).paths[0].markers.length, 1);
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
test('offline and responsive geometry preserve already observed connected history', () => {
  const h = createHistory();
  h.observe(live(epoch), epoch); h.observe(live(epoch + 2000), epoch + 2000);
  const narrow = { width: 244, height: 230, left: 54, right: 226, top: 20, bottom: 188 };
  const group = GROUPS.find(g => g.id === 'power');
  h.observe({ status: 'offline', values: null }, epoch + 3000);
  const p = buildPlot(h.window(epoch + 3000, 1), group, defaults().selected,
    epoch + 3000 - 60000, epoch + 3000, narrow);
  assert.equal(p.count, 2); assert(p.paths[0].path.includes('L'));
  assert(!/NaN|Infinity/.test(p.paths[0].path));
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
test('bounds-only archive scaling retains extrema without constructing raw paths', () => {
  const geometry = { width: 320, height: 230, left: 54, right: 302, top: 20, bottom: 188 };
  const points = [{ t: epoch - 1000, values: { power: 0 } },
    { t: epoch, values: { power: Number.MAX_SAFE_INTEGER / 1000 } }];
  const p = buildPlot(points, GROUPS[0], defaults().selected, epoch - 1000, epoch, geometry, true);
  assert.deepEqual(p.paths, []); assert.equal(p.count, 2); assert.equal(p.points, points);
  assert.equal(p.lo, 0); assert(p.hi > Number.MAX_SAFE_INTEGER / 1000);
  assert(Number.isFinite(p.hi), 'Extreme but valid input keeps a finite archive scale');
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

const iso = t => new Date(t).toISOString();
const row = (t, id = '18446744073709551615', overrides = {}) => ({ id, timestamp: iso(t), received_at: iso(t),
  status: 'ok', values: { ...values }, break_before: true, ...overrides });
const batch = (samples, overrides = {}) => ({ schema_version: 1, read_only: true, status: 'ok', reason: 'Archiv',
  generated_at: iso(epoch), minutes: 15, range: { from: iso(epoch - RETENTION_MS), to: iso(epoch) },
  complete: true, samples, ...overrides });

test('archive import is independent, bounded and idempotent; string uint64 IDs stay exact', () => {
  const h = createHistory(), data = batch([row(epoch - 2000), row(epoch, '2', { break_before: false })]);
  assert.equal(h.importHistory(data, epoch), true);
  assert.equal(h.size, 2);
  assert.equal(h.window(epoch, 15)[0].id, '18446744073709551615');
  assert.equal(h.window(epoch, 15)[0].values.charging, 0);
  assert(plot(h, 'power', epoch).paths[0].path.includes('L'));
  const revision = h.revision;
  assert.equal(h.importHistory(data, epoch), true); assert.equal(h.revision, revision);
  assert.equal(h.importHistory(batch([], { status: 'disabled' }), epoch), true);
  assert.equal(h.size, 2);
});
test('archive validation is whole-batch atomic and rejects type, shape, time and uint64 errors', () => {
  const invalids = [
    b => { b.schema_version = 2; }, b => { b.read_only = false; }, b => { b.complete = null; },
    b => { b.extra = 'secret'; }, b => { b.samples[1].id = 9007199254740992; },
    b => { b.samples[1].id = '18446744073709551616'; }, b => { b.samples[1].id = '01'; },
    b => { b.samples[1].values.charging = 0; }, b => { b.samples[1].values.plugged_in = 'false'; },
    b => { b.samples[1].values.current_a = [0, 0]; }, b => { b.samples[1].values.active_power_w = Infinity; },
    b => { b.samples[1].values.error_code = -1; }, b => { b.samples[1].values.charging_state_raw = 4294967296; },
    b => { b.samples[1].timestamp = iso(epoch + 6000); }, b => { b.generated_at = iso(epoch + 6000); },
    b => { b.samples[1].received_at = iso(epoch + 6000); },
    b => { b.samples[1].received_at = '2026-02-30T00:00:00Z'; },
    b => { b.samples[1].timestamp = iso(epoch - RETENTION_MS - 1); },
    b => { b.samples.reverse(); }, b => { b.samples[0].break_before = false; },
    b => { b.range.from = iso(epoch - 60000); }, b => { b.status = 'disabled'; },
    b => { b.samples[1].status = 'error'; }, b => { b.samples[1].values = null; }
  ];
  for (const corrupt of invalids) {
    const h = createHistory(); h.observe(live(epoch - 1000), epoch);
    const before = h.window(epoch, 15), revision = h.revision;
    const data = batch([row(epoch - 2000, '1'), row(epoch, '2', { break_before: false })]); corrupt(data);
    assert.equal(h.importHistory(data, epoch), false);
    assert.deepEqual(h.window(epoch, 15), before); assert.equal(h.revision, revision);
  }
});
test('same-time SQL null/error transitions protect both neighbours, including receipt/ID ties', () => {
  for (const error of [false, true]) {
    const h = createHistory();
    const middle = error ? { status: 'error', values: null } : { values: { ...values, plugged_in: null } };
    const data = batch([
      row(epoch - 4000, '1'),
      row(epoch - 2000, '9007199254740992', { break_before: false }),
      row(epoch - 2000, '9007199254740993', { break_before: false, ...middle }),
      row(epoch - 2000, '9007199254740994', { break_before: false }),
      row(epoch, '5', { break_before: false })
    ]);
    assert(h.importHistory(data, epoch)); assert.equal(h.size, 3);
    const path = plot(h, 'flags', epoch).paths.find(p => p.metric.id === 'plugged').path;
    assert.equal((path.match(/M/g) || []).length, 3);
    if (error) assert.equal((plot(h, 'power', epoch).paths[0].path.match(/M/g) || []).length, 3);
    const rev = h.revision; h.importHistory(data, epoch); assert.equal(h.revision, rev);
  }
});
test('receipt timestamps normalize Z/+00:00 and retain submillisecond ordering', () => {
  const h = createHistory();
  assert(h.importHistory(batch([
    row(epoch, '9', { received_at: '2026-10-04T12:00:00.000001+00:00' }),
    row(epoch, '1', { received_at: '2026-10-04T12:00:00.000002Z', values: { ...values, active_power_w: 8000 } })
  ]), epoch));
  assert.equal(h.window(epoch, 15)[0].values.power, 8);
});
test('six-fraction live and SQL timestamps share precise keys, live priority and the normal live edge', () => {
  for (const sqlFirst of [false, true]) {
    const h = createHistory();
    const stamps = [iso(epoch - 2000), iso(epoch - 1000)].map(s => s.replace('.000Z', '.123456Z'));
    const data = batch(stamps.map((timestamp, i) => row(epoch - 2000 + i * 1000, String(i + 1), {
      timestamp: timestamp.replace('Z', '+00:00'), break_before: i === 0,
      values: { ...values, active_power_w: 99000 }
    })));
    if (sqlFirst) assert(h.importHistory(data, epoch));
    stamps.forEach((timestamp, i) => h.observe({ ...live(epoch), envelope: { timestamp },
      values: { ...values, active_power_w: 7000 + i * 1000 } }, epoch));
    if (!sqlFirst) assert(h.importHistory(data, epoch));
    assert.equal(h.size, 2);
    const points = h.window(epoch, 15);
    assert(points.every(p => p.source === 'live'));
    assert.deepEqual(points.map(p => p.values.power), [7, 8]);
    assert(points.every(p => p.t !== Math.trunc(p.t)), 'Keys retain the fractional milliseconds');
    const path = plot(h, 'power', epoch).paths[0].path;
    assert.equal((path.match(/M/g) || []).length, 1); assert(path.includes('L'));
  }
});
test('distinct SQL microsecond timestamps within one millisecond retain null barriers and separate points', () => {
  const h = createHistory();
  const stamps = ['123455', '123456', '123457'].map(fraction => iso(epoch - 1000).replace('.000Z', `.${fraction}Z`));
  assert(h.importHistory(batch(stamps.map((timestamp, i) => row(epoch - 1000, String(i + 1), {
    timestamp, break_before: i === 0, values: { ...values, plugged_in: i === 1 ? null : true }
  }))), epoch));
  const points = h.window(epoch, 15);
  assert.equal(h.size, 3); assert(points[0].t < points[1].t && points[1].t < points[2].t);
  assert.equal(Math.trunc(points[0].t), Math.trunc(points[2].t));
  assert.deepEqual(points.map(p => p.values.plugged), [1, null, 1]);
  const flags = plot(h, 'flags', epoch).paths.find(p => p.metric.id === 'plugged').path;
  assert.equal((flags.match(/M/g) || []).length, 2); assert(!flags.includes('H'));
  assert(plot(h, 'power', epoch).paths[0].path.includes('L'));
});
test('receipt/ID metadata-only changes do not redraw; newer SQL values win independently of import order', () => {
  for (const reverse of [false, true]) {
    const h = createHistory();
    const a = batch([row(epoch, '9007199254740992')]);
    const b = batch([row(epoch, '9007199254740993', { values: { ...values, active_power_w: 8000 } })]);
    for (const data of reverse ? [b, a] : [a, b]) assert(h.importHistory(data, epoch));
    assert.equal(h.window(epoch, 15)[0].values.power, 8);
    const rev = h.revision;
    assert(h.importHistory(batch([row(epoch, '9007199254740994', { values: { ...values, active_power_w: 8000 } })]), epoch));
    assert.equal(h.revision, rev);
  }
});
test('SQL cannot overwrite live or heal an offline same-timestamp gap; seams disconnect', () => {
  const h = createHistory(); h.observe(live(epoch - 4000), epoch - 4000);
  h.observe({ status: 'offline' }, epoch - 3000);
  const data = batch([row(epoch - 4000, '1', { values: { ...values, active_power_w: 99000 } }),
    row(epoch - 2000, '2', { break_before: false }), row(epoch, '3', { break_before: false })]);
  assert(h.importHistory(data, epoch));
  h.observe(live(epoch - 4000, { active_power_w: 12000 }), epoch - 1000);
  assert.equal(h.window(epoch, 15)[0].values.power, 7.4);
  h.observe(live(epoch), epoch);
  const path = plot(h, 'power', epoch).paths[0].path;
  assert.equal((path.match(/M/g) || []).length, 3);
  assert.equal(h.window(epoch, 15).at(-1).source, 'live');
});
test('newer SQL points never steal live timestamp anchors or clock anchors', () => {
  const h = createHistory(); h.observe(live(epoch - 4000), epoch - 4000);
  assert(h.importHistory(batch([row(epoch - 2000), row(epoch, '2', { break_before: false })]), epoch));
  h.observe(live(epoch - 4000, { active_power_w: 8000 }), epoch - 3000);
  assert.equal(h.window(epoch, 15)[0].values.power, 8);
  assert.equal(h.window(epoch, 15).at(-1).values.power, 7.4);
  h.observe(live(epoch - 1000), epoch - 1000);
  assert.equal(h.size, 4);
  assert.equal((plot(h, 'power', epoch).paths[0].path.match(/M/g) || []).length, 1,
    'Overlapping measured live and SQL edges prove continuity without changing live clocks');
});
test('shared SQL/live retained allocation never exceeds 1200; rollback and clear remove both', () => {
  const h = createHistory();
  for (let i = 0; i < MAX_POINTS; i++) h.observe(live(epoch - 5000 + i), epoch - 5000 + i);
  const rows = Array.from({ length: MAX_POINTS }, (_, i) => row(epoch - 2400 + i, String(i + 1), { break_before: i === 0 }));
  assert(h.importHistory(batch(rows), epoch)); assert.equal(h.size, MAX_POINTS);
  h.observe(live(epoch), epoch); assert.equal(h.size, MAX_POINTS);
  h.observe({ status: 'offline' }, epoch - 1); assert.equal(h.size, 0);
  h.importHistory(batch(rows), epoch); h.clear(); assert.equal(h.size, 0);
  assert.equal(h.importHistory(batch([...rows, row(epoch)]), epoch), false);
});
test('partial archives preserve proven edges; error rows are gaps not zeros', () => {
  const h = createHistory();
  assert(h.importHistory(batch([row(epoch - 4000), row(epoch - 2000, '2', { status: 'error', values: null }),
    row(epoch, '3', { break_before: false })], { complete: false }), epoch));
  assert.equal(h.window(epoch, 15)[1].values.power, null);
  assert(!plot(h, 'power', epoch).paths[0].path.includes('L'));
});

for (const status of ['waiting', 'read_error']) test(`browser ${status} transport gap is repaired by continuous SQL, not permanent gapFloor poisoning`, () => {
  const h = createHistory();
  h.observe(live(epoch - 10000, { active_power_w: 0 }), epoch - 10000);
  h.observe({ status }, epoch - 9000);
  h.observe(live(epoch - 6000, { active_power_w: 0 }), epoch - 6000);
  const data = batch(Array.from({ length: 6 }, (_, i) => row(epoch - 10000 + i * 2000, String(i + 1), {
    break_before: i === 0, values: { ...values, active_power_w: 0, current_limit_a: 6 }
  })), { complete: false });
  assert(h.importHistory(data, epoch));
  const p = plot(h, 'power', epoch).paths[0];
  assert.equal((p.path.match(/M/g) || []).length, 1); assert(p.path.includes('L'));
  assert.equal(p.markers.length, 1);
  assert.equal(h.window(epoch, 15).filter(p => p.source === 'live').length, 2);
});
test('a lone unproven seam does not isolate all later SQL edges', () => {
  const h = createHistory(); h.observe(live(epoch - 6000), epoch - 6000);
  assert(h.importHistory(batch([row(epoch - 4000, '1'), row(epoch - 2000, '2', { break_before: false }),
    row(epoch, '3', { break_before: false })]), epoch));
  assert.equal((plot(h, 'power', epoch).paths[0].path.match(/M/g) || []).length, 2);
});
test('explicit offline/clock/error barriers survive SQL overlap but do not poison subsequent edges', () => {
  for (const status of ['offline', 'clock_error', 'read_error', 'invalid']) {
    const h = createHistory(); h.observe(live(epoch - 8000), epoch - 8000);
    h.observe({ status, envelope: { timestamp: new Date(epoch - 7000).toISOString() } }, epoch - 7000);
    h.observe(live(epoch - 4000), epoch - 4000);
    assert(h.importHistory(batch([row(epoch - 8000, '1'), row(epoch - 6000, '2', { break_before: false }),
      row(epoch - 4000, '3', { break_before: false }), row(epoch - 2000, '4', { break_before: false }),
      row(epoch, '5', { break_before: false })]), epoch));
    const path = plot(h, 'power', epoch).paths[0].path;
    assert.equal((path.match(/M/g) || []).length, 3); assert(path.includes('L'));
  }
});
test('break_before belongs to its SQL predecessor edge, not an arbitrary merged predecessor', () => {
  const h = createHistory();
  assert(h.importHistory(batch([row(epoch - 8000, '1'), row(epoch - 4000, '2', { break_before: false }),
    row(epoch, '3', { break_before: true })]), epoch));
  h.observe(live(epoch - 6000), epoch - 6000);
  h.observe(live(epoch - 2000), epoch - 2000);
  const p = h.window(epoch, 15);
  assert.equal(p[1].breakBefore, false); assert.equal(p[2].breakBefore, false);
  assert.equal(p[3].breakBefore, true); assert.equal(p[4].breakBefore, true);
});
test('dense isolated flat samples have sparse pixel markers, never a marker pill or fabricated line', () => {
  const h = createHistory();
  assert(h.importHistory(batch(Array.from({ length: 1000 }, (_, i) => row(epoch - 1000 + i, String(i + 1), {
    values: { ...values, active_power_w: 0 }, break_before: true
  }))), epoch));
  const p = plot(h, 'power', epoch).paths[0];
  assert(!p.path.includes('L')); assert(p.markers.length <= 2);
});
