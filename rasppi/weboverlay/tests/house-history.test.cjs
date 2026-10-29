'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const house = require('../static/house-history.js');
const chart = require('../static/smartmeter-chart.js');
const epoch = Date.parse('2026-10-29T12:00:00Z');
const iso = t => new Date(t).toISOString();
function raw(values = [-1000, 0, null, 500], at = epoch) {
  return { schema_version: 1, read_only: true, status: 'ok', reason: 'Hausverlauf', generated_at: iso(at),
    minutes: 15, range: { from: iso(at - 900000), to: iso(at) }, complete: true,
    samples: values.map((v, i) => ({ id: String(i + 1), timestamp: iso(at - 10000 + i * 1000),
      received_at: iso(at - 9000 + i * 1000), status: v === null ? 'error' : 'ok', power_w: v, break_before: i === 0 })) };
}
function calendar(from = '2024-01-01T00:00:00Z', to = '2025-01-01T00:00:00Z', period = 'year', date = '2024', tz = 'UTC') {
  return { schema_version: 2, read_only: true, status: 'ok', reason: 'Hausverlauf', generated_at: iso(epoch),
    range: { from, to, timezone: tz }, selection: { period, date, timezone: tz }, navigation: { previous: null, next: null, now: null },
    aggregation: 'sample_mean', complete: true, progress: { samples_done: true, events_done: true }, buckets: [] };
}
function bucket(from, to, value, options = {}) {
  return { from, to, samples: 1, has_gap: false, complete: true, coverage_seconds: (Date.parse(to) - Date.parse(from)) / 1000,
    metrics: { power_w: { count: value === null ? 0 : 1, nulls: value === null ? 1 : 0,
      mean: value, min: value, max: value, last: value, mixed: false } }, ...options };
}
function minuteRaw() {
  const b = raw([], epoch + 180000); b.schema_version = 3;
  b.samples = [-1000, 0, 500].map((power_w, i) => ({ id: String(epoch / 60000 + i + 1),
    timestamp: iso(epoch + i * 60000 + 30000), received_at: iso(epoch + (i + 1) * 60000),
    status: 'ok', power_w, break_before: i === 0,
    interval: { from: iso(epoch + i * 60000), to: iso(epoch + (i + 1) * 60000), complete: true, has_gap: false, break_fields: [] } }));
  return b;
}
test('HOUSE schema 3 joins only validated adjacent complete minutes and retains intra-minute NULL evidence', () => {
  const now = epoch + 180000, s = house.createStore(), b = minuteRaw();
  assert(s.importHistory(b, now));
  assert.equal((chart.buildPlot(s.points([], now, 15), epoch, now).path.match(/L/g) || []).length, 2);
  const revision = s.revision;
  assert(s.importHistory(JSON.parse(JSON.stringify(b)), now)); assert.equal(s.revision, revision);
  assert(Object.isFrozen(s.rawView().samples[0].interval.break_fields));
  b.samples[1].interval.break_fields = ['power_w'];
  assert(s.importHistory(b, now));
  assert.equal((chart.buildPlot(s.points([], now, 15), epoch, now).path.match(/M/g) || []).length, 3);
  assert.deepEqual(s.points([], now, 15).map(p => p.power_w), [-1000, 0, 500]);
  b.samples[1].interval.break_fields = []; b.samples[1].interval.has_gap = true;
  assert(s.importHistory(b, now)); assert(!chart.buildPlot(s.points([], now, 15), epoch, now).path.includes('L'));
  b.samples[1].power_w = null; b.samples[1].interval.break_fields = ['power_w'];
  assert(s.importHistory(b, now)); assert.equal(s.points([], now, 15)[1].power_w, null);
  assert(!chart.buildPlot(s.points([], now, 15), epoch, now).path.includes('L'));
});
test('HOUSE schema 3 missing/partial minutes, raw seam and SQL/live tail cannot reconnect', () => {
  const now = epoch + 180000;
  for (const cause of ['missing', 'partial']) {
    const s = house.createStore(), b = minuteRaw();
    if (cause === 'missing') b.samples.splice(1, 1); else b.samples[1].interval.complete = false;
    assert(s.importHistory(b, now)); assert(!chart.buildPlot(s.points([], now, 15), epoch, now).path.includes('L'));
  }
  const s = house.createStore(), b = minuteRaw();
  b.samples.unshift({ id: '99', timestamp: iso(epoch - 2000), received_at: iso(epoch - 1000), status: 'ok', power_w: 0, break_before: true, interval: null });
  b.samples[1].break_before = false;
  assert(s.importHistory(b, now));
  const points = s.points([{ t: now - 2000, power_w: 1 }, { t: now + 1000, power_w: 2 }], now + 1000, 15);
  assert.equal(points.length, 5); assert(points[1].breakBefore); assert(points.at(-1).breakBefore);
  assert.equal(points.at(-1).source, 'live'); assert.equal(points[1].recordType, 'minute');
});
test('HOUSE schema 3 rejects unsupported evidence and cloned/forged minute parameters do not grant continuity', () => {
  for (const mutate of [b => delete b.samples[0].interval, b => b.samples[0].interval.extra = true,
    b => b.samples[0].interval.break_fields = ['active_power_w'], b => b.samples[0].interval.break_fields = ['power_w', 'power_w'],
    b => b.samples[0].interval.complete = 1, b => b.samples[0].id = '1', b => b.samples[0].timestamp = b.samples[0].interval.from,
    b => b.samples[0].received_at = b.samples[0].timestamp]) {
    const b = minuteRaw(); mutate(b); assert.equal(house.validate(b, epoch + 180000), null);
  }
  const s = house.createStore(); assert(s.importHistory(minuteRaw(), epoch + 180000));
  const copied = JSON.parse(JSON.stringify(s.points([], epoch + 180000, 15)));
  assert(!chart.buildPlot(copied, epoch, epoch + 180000).path.includes('L'));
  assert(s.importHistory({ ...raw([], epoch + 180000), status: 'unavailable' }, epoch + 180000), 'Current schema 1 failures stay accepted');
});
test('microsecond raw range includes a valid zero from the current fractional second', () => {
  const batch = raw([0]);
  batch.generated_at = '2026-10-29T12:00:00.900000Z';
  batch.range = { from: '2026-10-29T11:45:00.900000Z', to: batch.generated_at };
  batch.samples[0].timestamp = '2026-10-29T12:00:00.100000Z';
  batch.samples[0].received_at = '2026-10-29T12:00:00.200000Z';
  assert(house.validate(batch, epoch + 900));
});
test('signed zero/NULL survive raw reload; no synthetic preactivation values; two pollers have one broken seam', () => {
  const s = house.createStore(); assert(s.importHistory(raw(), epoch));
  const points = s.points([{ t: epoch - 8500, power_w: 9 }, { t: epoch - 6000, power_w: -9 }], epoch, 15);
  assert.deepEqual(points.map(p => p.power_w), [-1000, 0, null, 500, -9]);
  assert(points.at(-1).breakBefore); assert(points[0].breakBefore);
  const plot = chart.buildPlot(points, epoch - 900000, epoch);
  assert.equal((plot.path.match(/L/g) || []).length, 1);
  assert(s.importHistory({ ...raw([]), status: 'unavailable' }, epoch));
  assert.equal(s.raw().samples.length, 4, 'Failures retain historical baseline');
  const fresh = house.createStore(); assert(fresh.importHistory(raw(), epoch));
  assert.deepEqual(fresh.points([], epoch, 15), s.points([], epoch, 15));
});
test('HOUSE immutable render views keep public copy ownership and ignore timestamp-only refreshes', () => {
  const s = house.createStore(), b = raw();
  assert(s.importHistory(b, epoch));
  const view = s.rawView(), revision = s.revision;
  assert(Object.isFrozen(view.samples[0]));
  assert.throws(() => { view.samples[0].power_w = 999; }, TypeError);
  const copy = s.raw(); copy.samples.length = 0;
  assert.equal(s.rawView().samples.length, 4);
  b.generated_at = iso(epoch + 1000);
  assert(s.importHistory(b, epoch + 1000)); assert.equal(s.revision, revision); assert.equal(s.rawView(), view);
  const archive = calendar(), selection = { period: 'year', date: '2024', tz: 'UTC' };
  assert(s.importHistory(archive, epoch, selection));
  assert(Object.isFrozen(s.archiveView().range));
  const a = s.archive(); a.range.from = 'invalid';
  assert.notEqual(s.archiveView().range.from, 'invalid');
});
test('raw and calendar validation rejects malformed values, mixed metrics, excess slots and foreign fields', () => {
  for (const value of [NaN, Infinity, '0', true, Number.MAX_SAFE_INTEGER + 1]) assert.equal(house.validate(raw([value]), epoch), null);
  for (const mutate of [b => b.samples.push(...Array(1200).fill(b.samples[0])), b => b.samples[0].power_w = null,
    b => b.samples[0].timestamp = '2026-02-30T00:00:00Z', b => b.samples[0].id = '18446744073709551616',
    b => b.samples[0].break_before = false, b => b.samples[0] = null,
    b => b.samples[1].timestamp = iso(Date.parse(b.samples[0].timestamp) - 1000), b => b.extra = 1]) {
    const b = raw(); mutate(b); assert.equal(house.validate(b, epoch), null);
  }
  const b = calendar(), selection = { period: 'year', date: '2024', tz: 'UTC' };
  b.buckets = [bucket(b.range.from, '2024-01-02T00:00:00Z', -10)];
  assert(house.validate(b, epoch, selection)); b.buckets[0].metrics.power_w.mixed = true;
  assert.equal(house.validate(b, epoch, selection), null);
});
test('calendar year and both DST days use server UTC bounds without assuming 24-hour days', () => {
  for (const [date, from, to, hours] of [['2026-03-29', '2026-03-28T23:00:00Z', '2026-03-29T22:00:00Z', 23],
    ['2026-10-25', '2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z', 25]]) {
    const b = calendar(from, to, 'day', date, 'Europe/Vienna');
    assert(house.validate(b, epoch, { period: 'day', date, tz: 'Europe/Vienna' }));
    assert.equal((house.utc(to) - house.utc(from)) / 3600000, hours);
  }
  assert(house.validate(calendar(), epoch, { period: 'year', date: '2024', tz: 'UTC' }));
});
test('archive curves/bands connect only fully covered adjacent intervals; NULL/gaps never heal', () => {
  const b = calendar(), from = Date.parse(b.range.from);
  b.selection.period = 'custom';
  b.buckets = Array.from({ length: 5 }, (_, i) => bucket(iso(from + i * 60000), iso(from + (i + 1) * 60000), i === 2 ? null : -500));
  const geometry = { left: 62, right: 480, top: 24, bottom: 210 };
  let plot = chart.buildArchivePlot(b, geometry);
  assert.equal((plot.path.match(/L/g) || []).length, 2); assert(plot.band.includes('Z'));
  assert(plot.band.split('M').filter(Boolean).every(part => part.endsWith('Z')), 'Min/max coverage is a band, never vertical spikes');
  b.buckets[1].has_gap = true; b.buckets[4].complete = false;
  plot = chart.buildArchivePlot(b, geometry); assert(!plot.path.includes('L'));
  assert(!/NaN|Infinity/.test(plot.path)); assert.equal(plot.markers.length, 0);
  const incomplete = calendar(); incomplete.selection.period = 'custom'; incomplete.buckets = [bucket(incomplete.range.from, '2024-01-02T00:00:00Z', -500,
    { has_gap: true, complete: false, coverage_seconds: 0 })];
  plot = chart.buildArchivePlot(incomplete, geometry);
  assert.match(plot.path, /H/); assert.equal(plot.band, '', 'Unproven coverage keeps a local value mark without a false envelope');
});
function harness() {
  let wall = epoch, mono = 0, calls = [], timers = new Map(), timerID = 0;
  const states = [];
  const store = house.createStore();
  const loader = house.createLoader({ fetch: (url, init) => new Promise(resolve => calls.push({ url, init, resolve })),
    clock: () => ({ wall, mono }), setTimer: f => { timers.set(++timerID, f); return timerID; }, clearTimer: id => timers.delete(id),
    importHistory: (b, now) => store.importHistory(b, now), importArchive: (b, now, s) => store.importHistory(b, now, s),
    onState: state => states.push(state), onReset: () => store.clearRaw() });
  const response = b => ({ status: b.status === 'unavailable' ? 503 : 200, headers: { get: () => null }, text: async () => JSON.stringify(b) });
  return { loader, store, calls, timers, states, response, advance(ms) { wall += ms; mono += ms; }, rollback() { wall--; } };
}
test('short house aggregate lines do not depend on coarse coverage/completion, but retain NULL and missing intervals', () => {
  for (const period of ['hour', 'day', 'week', 'month', 'year']) {
    const b = calendar(); b.selection.period = period;
    const from = Date.parse(b.range.from);
    b.buckets = [-500, 0, 500, 250].map((value, i) => bucket(iso(from + i * 60000), iso(from + (i + 1) * 60000), value,
      { has_gap: true, complete: false, coverage_seconds: 0 }));
    const plot = chart.buildArchivePlot(b);
    assert.equal((plot.path.match(/L/g) || []).length, 3);
    assert.equal((plot.path.match(/M/g) || []).length, 1);
    assert.equal(plot.band, '');
    b.buckets.splice(1, 1);
    const missing = chart.buildArchivePlot(b);
    assert.equal((missing.path.match(/M/g) || []).length, 2);
    assert.equal((missing.path.match(/L/g) || []).length, 1);
    b.buckets[1].metrics.power_w.nulls = 1;
    b.buckets[1].samples = 2;
    const unknown = chart.buildArchivePlot(b);
    assert.equal(unknown.path, missing.path, 'Partial NULL retains a known aggregate mean');
    Object.assign(b.buckets[1].metrics.power_w, { count: 0, nulls: 2, mean: null, min: null, max: null, last: null });
    assert(!chart.buildArchivePlot(b).path.includes('L'), 'Entirely unknown interval breaks both edges');
    assert(b.buckets.every(bin => bin.has_gap && !bin.complete && bin.coverage_seconds === 0));
  }
});
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
test('independent HOUSE loader uses one request, hidden cancellation and late replies cannot import', async () => {
  const h = harness(); h.loader.tick(); h.loader.tick(); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, '/api/house-history?minutes=15');
  h.loader.setVisible(false); assert(h.calls[0].init.signal.aborted);
  h.calls[0].resolve(h.response(raw())); await settle(); assert.equal(h.store.raw(), null);
  h.loader.setVisible(true); h.loader.tick(); h.calls[1].resolve(h.response(raw())); await settle();
  assert.equal(h.store.raw().samples.length, 4);
});
test('disabled pauses automatic retries including clock rollback; explicit lifecycle restores; 4s timeout releases slot', async () => {
  const h = harness(); h.loader.tick(); h.calls[0].resolve(h.response({ ...raw([]), status: 'disabled' })); await settle();
  h.advance(60000); h.loader.tick(); h.rollback(); h.loader.tick(); assert.equal(h.calls.length, 1);
  h.loader.restore(); h.loader.tick(); assert.equal(h.calls.length, 2);
  [...h.timers.values()][0](); assert(h.calls[1].init.signal.aborted);
  h.advance(9999); h.loader.tick(); assert.equal(h.calls.length, 2);
  h.advance(1); h.loader.tick(); assert.equal(h.calls.length, 3);
  h.calls[1].resolve(h.response(raw())); await settle(); assert.equal(h.store.raw(), null);
});
test('year request never depends on wallbox schema or endpoint; selection change aborts previous generation', async () => {
  const h = harness(); h.loader.tick(); h.loader.select({ period: 'year', date: '2024', tz: 'UTC' }); h.loader.tick();
  assert(h.calls[0].init.signal.aborted); assert.match(h.calls[1].url, /^\/api\/house-history\?period=year/);
  h.calls[1].resolve(h.response(calendar())); await settle(); assert(h.store.archive());
  h.calls[0].resolve(h.response(raw())); await settle(); assert.equal(h.store.raw(), null);
});
test('unavailable backoff is 10/30/60 seconds; success refreshes at 60 seconds', async () => {
  const h = harness(); h.loader.tick();
  for (const [i, delay] of [10000, 30000, 60000].entries()) {
    const b = raw([], epoch + [0, 10000, 40000][i]); b.status = 'unavailable';
    h.calls[i].resolve(h.response(b)); await settle();
    h.advance(delay - 1); h.loader.tick(); assert.equal(h.calls.length, i + 1);
    h.advance(1); h.loader.tick(); assert.equal(h.calls.length, i + 2);
  }
  const b = raw(undefined, epoch + 100000);
  h.calls[3].resolve(h.response(b)); await settle(); assert(h.store.raw());
  h.advance(59999); h.loader.tick(); assert.equal(h.calls.length, 4);
  h.advance(1); h.loader.tick(); assert.equal(h.calls.length, 5);
});
test('existing description distinguishes loading, disabled, failure, empty success and incomplete processing', () => {
  const base = { archive: true, count: 0, complete: true, hasSnapshot: false, checked: true };
  for (const [status, text] of [['loading', /wird geladen/], ['disabled', /ist deaktiviert/],
    ['unavailable', /ist nicht verfügbar/], ['ok', /Keine Messpunkte im gewählten Zeitraum/]]) {
    const description = chart.historyDescription({ ...base, status });
    assert.match(description, text); assert.doesNotMatch(description, /Zuvor geladene|0 Messpunkte/);
  }
  assert.match(chart.historyDescription({ ...base, status: 'ok', complete: false }), /noch unvollständig/);
  assert.match(chart.historyDescription({ ...base, status: 'ok', count: 3, complete: false }), /^3 Messpunkte.*noch unvollständig/);
  for (const status of ['disabled', 'unavailable', 'loading']) {
    assert.match(chart.historyDescription({ ...base, status, hasSnapshot: true, count: 3 }),
      /Zuvor geladene Daten; kein erfolgreicher aktueller Abruf/);
  }
  assert.match(chart.historyDescription({ ...base, status: 'unavailable', checked: false }), /nicht verfügbar.*Kurve ausgeblendet/);
  assert.equal(chart.buildPlot([], epoch - 900000, epoch).path, '');
  assert.equal(chart.buildArchivePlot(calendar()).path, '', 'Empty history never becomes a zero line');
});
test('loader status survives HTTP/payload errors after success and recovers without discarding baseline', async () => {
  for (const failure of ['503', '500', 'json', 'timeout']) {
    const h = harness(); h.loader.tick();
    h.calls[0].resolve(h.response(raw())); await settle();
    assert.equal(h.states.at(-1).status, 'ok');
    h.advance(60000); h.loader.tick();
    if (failure === 'timeout') [...h.timers.values()][0]();
    else h.calls[1].resolve(failure === '503' ? h.response({ ...raw([], epoch + 60000), status: 'unavailable' })
      : { status: failure === '500' ? 500 : 200, headers: { get: () => null }, text: async () => '{' });
    await settle();
    assert.equal(h.states.at(-1).status, 'unavailable', failure);
    assert.equal(h.store.raw().samples.length, 4, 'Retain baseline, not successful status');
    h.advance(10000); h.loader.tick();
    h.calls[2].resolve(h.response(raw([], epoch + 70000))); await settle();
    assert.equal(h.states.at(-1).status, 'ok'); assert.equal(h.store.raw().samples.length, 0);
  }
});
