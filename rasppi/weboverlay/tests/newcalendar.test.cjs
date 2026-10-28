'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const calendar = require('../static/newcalendar.js');
const charts = require('../static/charts.js');
const { calendarQuery } = require('../static/history.js');
const now = Date.parse('2026-10-27T12:00:00Z');
const metrics = samples => Object.fromEntries(calendar.FIELDS.map((key, i) => {
  const flags = i >= 9 && i <= 11, value = flags ? 0 : i === 2 ? 6 : 0;
  return [key, { count: samples, nulls: 0,
    mean: samples && (i === 0 || i >= 3 && i <= 8) ? value : null,
    min: samples ? value : null, max: samples ? value : null,
    last: samples ? flags ? false : value : null, mixed: false }];
}));
function fixture(overrides = {}) {
  return { schema_version: 2, read_only: true, status: 'ok', reason: 'Archiv', generated_at: new Date(now).toISOString(),
    range: { from: '2026-10-26T23:00:00Z', to: '2026-10-27T23:00:00Z', timezone: 'Europe/Vienna' },
    selection: { period: 'day', date: '2026-10-27', timezone: 'Europe/Vienna' },
    navigation: { previous: { period: 'day', at: '2026-10-25T23:00:00Z', tz: 'Europe/Vienna' },
      next: { period: 'day', at: '2026-10-27T23:00:00Z', tz: 'Europe/Vienna' },
      now: { period: 'day', date: 'now', tz: 'Europe/Vienna' } },
    aggregation: 'sample_mean', complete: true, progress: { samples_done: true, events_done: true },
    buckets: [{ from: '2026-10-26T23:00:00Z', to: '2026-10-26T23:05:00Z', samples: 150,
      has_gap: false, complete: true, coverage_seconds: 298, metrics: metrics(150) }], ...overrides };
}
test('calendar request whitelist is fixed-endpoint, single-form, no DTO URL or unknown fields', () => {
  for (const [period, date] of [['hour', '2026-10-27T12:00'], ['day', '2026-10-27'], ['week', '2026-W44'],
    ['month', '2026-10'], ['year', '2026']]) {
    const url = calendarQuery({ period, date, tz: 'Europe/Vienna' });
    assert(url.startsWith('/api/history?'));
    assert.equal(new URL(url, 'http://test').searchParams.get('date'), date);
  }
  assert(calendarQuery({ period: 'hour', at: '2026-10-25T01:00:00Z', tz: 'Europe/Vienna' }));
  assert(calendarQuery({ period: 'custom', from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z', tz: 'UTC' }));
  assert(calendarQuery({ period: 'custom', date_from: '2026-10-01T00:00', date_to: '2026-10-30T00:00', tz: 'Europe/Vienna' }));
  for (const value of [null, [], { period: 'day', date: 'now', tz: 'America/New_York' },
    { period: 'day', date: 'now', tz: 'UTC', url: 'https://foreign/' },
    { period: 'day', date: 'now', at: '2026-10-25T01:00:00Z', tz: 'UTC' },
    { period: 'year', date: '2026&minutes=15', tz: 'UTC' },
    { period: 'custom', date: 'now', tz: 'UTC' }]) assert.equal(calendarQuery(value), null);
});
test('archive remains independent of raw/live buffer, has copy ownership and preserves false/zero', () => {
  const store = calendar.createArchiveStore(), b = fixture();
  assert(store.importHistory(b, now, { period: 'day', date: '2026-10-27', tz: 'Europe/Vienna' }));
  b.buckets[0].metrics.active_power_w.last = 99;
  const first = store.snapshot();
  assert.equal(first.buckets[0].metrics.active_power_w.last, 0);
  assert.equal(first.buckets[0].metrics.charging.last, false);
  first.buckets.length = 0; assert.equal(store.size, 1);
  store.clear(); assert.equal(store.snapshot(), null); assert.equal(store.size, 0);
});
test('full response validation is atomic, bounded, rejects foreign navigation and wrong selection', () => {
  const invalid = [b => b.buckets.push(...Array(512).fill(b.buckets[0])),
    b => b.buckets[0].metrics.active_power_w.mean = Infinity,
    b => b.buckets[0].metrics.active_power_w.last = '0',
    b => b.buckets[0].metrics.charging.last = 0,
    b => b.buckets[0].metrics.charging.mean = 0,
    b => b.buckets[0].metrics.error_code.max = 4294967296,
    b => b.buckets[0].metrics.active_power_w.count = -1,
    b => b.buckets[0].coverage_seconds = 301,
    b => b.buckets[0].metrics.extra = {}, b => b.buckets[0].metrics = [],
    b => b.navigation.next.url = 'https://foreign/',
    b => b.generated_at = '2026-02-30T00:00:00Z',
    b => b.generated_at = new Date(now + 6000).toISOString(),
    b => b.range.to = '2028-01-01T00:00:00Z',
    b => b.selection.date = '2026-10-26', b => b.read_only = false];
  for (const corrupt of invalid) {
    const store = calendar.createArchiveStore(); assert(store.importHistory(fixture(), now));
    const previous = store.snapshot(), b = fixture(); corrupt(b);
    assert.equal(store.importHistory(b, now, { period: 'day', date: '2026-10-27', tz: 'Europe/Vienna' }), false);
    assert.deepEqual(store.snapshot(), previous);
  }
});
test('server supplied DST/leap ranges are retained exactly, never fixed-24h civil arithmetic', () => {
  for (const [date, from, to, hours] of [
    ['2026-03-29', '2026-03-28T23:00:00Z', '2026-03-29T22:00:00Z', 23],
    ['2026-10-25', '2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z', 25],
    ['2024-02-29', '2024-02-28T23:00:00Z', '2024-02-29T23:00:00Z', 24]
  ]) {
    const b = fixture({ range: { from, to, timezone: 'Europe/Vienna' }, buckets: [] });
    b.selection.date = date;
    assert(calendar.validate(b, now)); assert.equal((calendar.utc(to) - calendar.utc(from)) / 3600000, hours);
    assert(calendar.axisLabel(calendar.utc(from), 'day').includes(date.slice(8, 10)));
  }
  assert.notEqual(calendar.axisLabel(Date.parse('2026-10-25T00:30:00Z'), 'hour'),
    calendar.axisLabel(Date.parse('2026-10-25T01:30:00Z'), 'hour'), 'Duplicate civil hours have explicit distinct UTC offsets');
  const leap = fixture({ range: { from: '2023-12-31T23:00:00Z', to: '2024-12-31T23:00:00Z', timezone: 'Europe/Vienna' }, buckets: [] });
  leap.selection = { period: 'year', date: '2024', timezone: 'Europe/Vienna' };
  leap.navigation = { previous: null, next: null, now: { period: 'year', date: 'now', tz: 'Europe/Vienna' } };
  assert(calendar.validate(leap, now));
});
test('summary plots use weighted API mean and interval ranges, no connected line/marker pills', () => {
  const b = fixture();
  b.buckets[0].metrics.active_power_w = { count: 150, nulls: 0, mean: 2000, min: 0, max: 4000, last: 3000, mixed: true };
  const p = calendar.buildSummaryPlot(b, charts.GROUPS[0], charts.defaults().selected, charts);
  assert.equal(p.count, 150); assert.equal(p.paths[0].markers.length, 0);
  assert.equal(p.paths[0].glyphs.length, 1); assert(p.paths[0].glyphs[0].path.includes('V'));
  assert(p.paths[0].glyphs[0].path.includes('H')); assert.equal(p.paths[0].path, '');
  assert(!/NaN|Infinity/.test(p.paths[0].glyphs[0].path));
  b.buckets[0].has_gap = true; b.buckets[0].metrics.charging = { count: 150, nulls: 0, mean: null, min: 0, max: 1, last: false, mixed: true };
  const mixed = calendar.buildSummaryPlot(b, charts.GROUPS.find(g => g.id === 'flags'), charts.defaults().selected, charts)
    .paths.find(p => p.metric.id === 'charging').glyphs[0];
  assert(mixed.gap); assert(mixed.path.includes('V')); assert(!mixed.path.includes('H'));
});
test('empty/pre-data archive has no fabricated zero samples; null-only bins produce no glyph', () => {
  for (const buckets of [[], [{ ...fixture().buckets[0], samples: 0, metrics: metrics(0), coverage_seconds: 0 }]]) {
    const b = fixture({ buckets }); assert(calendar.validate(b, now));
    const p = calendar.buildSummaryPlot(b, charts.GROUPS[0], charts.defaults().selected, charts);
    assert.equal(p.count, 0); assert.equal(p.paths[0].glyphs.length, 0);
  }
  const b = fixture();
  b.buckets[0].metrics.active_power_w = { count: 0, nulls: 150, mean: null, min: null, max: null, last: null, mixed: false };
  assert(calendar.validate(b, now));
  assert.equal(calendar.buildSummaryPlot(b, charts.GROUPS[0], charts.defaults().selected, charts).paths[0].glyphs.length, 0);
});
test('custom ranges permit the server null-navigation DTO and never invent adjacent civil periods', () => {
  const b = fixture({ navigation: null, buckets: [] });
  b.selection = { period: 'custom', date: 'custom', timezone: 'Europe/Vienna' };
  assert(calendar.validate(b, now, { period: 'custom', from: b.range.from, to: b.range.to, tz: 'Europe/Vienna' }));
  b.selection.period = 'day'; assert.equal(calendar.validate(b, now), null);
});
test('floating aggregate rounding is tolerated at the server precision, not converted into null/zero', () => {
  const b = fixture(), m = b.buckets[0].metrics.current_l1_a;
  m.min = m.max = m.last = 6.123; m.mean = 6.123 - 1e-14;
  assert(calendar.validate(b, now));
  m.mean = 5; assert.equal(calendar.validate(b, now), null);
});
test('latest NULL is not replaced by an older known state and partial states never span an interval', () => {
  const b = fixture();
  b.buckets[0].metrics.charging = { count: 149, nulls: 1, mean: null, min: 0, max: 0, last: null, mixed: false };
  assert(calendar.validate(b, now));
  const group = charts.GROUPS.find(g => g.id === 'flags');
  const p = calendar.buildSummaryPlot(b, group, charts.defaults().selected, charts);
  assert(!p.paths.find(s => s.metric.id === 'charging').glyphs[0].path.includes('H'));
  b.buckets[0].has_gap = true;
  const q = calendar.buildSummaryPlot(b, group, charts.defaults().selected, charts);
  assert(q.paths.every(s => s.glyphs.every(g => !g.path.includes('H'))));
});
