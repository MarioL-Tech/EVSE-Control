'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const calendar = require('../static/newcalendar.js');
const charts = require('../static/charts.js');
const { calendarQuery } = require('../static/history.js');
const now = Date.parse('2026-10-27T12:00:00Z');
function mountedCalendar(saved = null) {
  class Element extends EventTarget {
    constructor() { super(); this.value = ''; this.hidden = false; this.attributes = {}; this.textContent = ''; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    removeAttribute(key) { delete this.attributes[key]; }
    closest() { return this.wrapper || null; }
  }
  const ids = Object.fromEntries(['calendar-mode', 'calendar-date', 'calendar-custom', 'calendar-label',
    'chart-range', 'calendar-picker-label', 'calendar-picker-caption', 'calendar-from', 'calendar-to',
    'calendar-prev', 'calendar-next', 'calendar-now'].map(id => [id, new Element()]));
  ids['chart-range'].wrapper = new Element();
  const buttons = calendar.PERIODS.map(period => {
    const button = new Element(); button.setAttribute('data-calendar-period', period); return button;
  });
  const calls = [], writes = [], events = [], eventTarget = new EventTarget();
  eventTarget.addEventListener('evse:calendar-change', event => events.push(event.detail));
  const instance = calendar.mount({
    eventTarget,
    document: { hidden: false, getElementById: id => ids[id], querySelectorAll: () => buttons },
    loader: { select: value => calls.push(value), setVisible() {}, tick() {}, suspend() { calls.push('suspend'); } },
    archive: { clear() {} }, onChange() {},
    storage: { getItem: () => JSON.stringify(saved), setItem: (key, value) => writes.push([key, value]) }
  });
  const click = period => buttons.find(b => b.getAttribute('data-calendar-period') === period).dispatchEvent(new Event('click'));
  const pressed = () => buttons.filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.getAttribute('data-calendar-period'));
  return { ids, buttons, instance, calls, writes, click, pressed, events, eventTarget };
}
test('native period buttons reuse hidden mode change selection and synchronize captions/wrappers', () => {
  const ui = mountedCalendar(), { ids } = ui;
  assert.deepEqual(ui.pressed(), ['live']); assert(ids['calendar-picker-label'].hidden);
  let changes = 0;
  ids['calendar-mode'].addEventListener('change', () => changes++);
  for (const [period, caption, type] of [['hour', 'Stunde', 'datetime-local'], ['day', 'Datum', 'date'],
    ['week', 'Kalenderwoche', 'week'], ['month', 'Monat', 'month'], ['year', 'Jahr', 'number']]) {
    ui.click(period);
    assert.equal(ids['calendar-mode'].value, period); assert.deepEqual(ui.pressed(), [period]);
    assert.deepEqual(ui.instance.selection, { period, date: 'now', tz: calendar.ZONE });
    assert.equal(ids['calendar-picker-caption'].textContent, caption);
    assert.equal(ids['calendar-date'].getAttribute('aria-label'), `${caption} wählen · ${calendar.ZONE}`);
    assert.equal(ids['calendar-date'].type, type);
    assert(!ids['calendar-picker-label'].hidden); assert(ids['calendar-custom'].hidden);
    assert(ids['chart-range'].disabled); assert(ids['chart-range'].wrapper.hidden);
  }
  ui.click('custom'); assert.deepEqual(ui.pressed(), ['custom']);
  assert(ids['calendar-picker-label'].hidden); assert(!ids['calendar-custom'].hidden);
  assert.equal(ui.calls.at(-1), 'suspend');
  ids['calendar-from'].value = '2026-10-25T01:00'; ids['calendar-to'].value = '2026-10-25T04:00';
  ids['calendar-custom'].dispatchEvent(new Event('submit', { cancelable: true }));
  assert.deepEqual(ui.instance.selection, { period: 'custom', date_from: '2026-10-25T01:00', date_to: '2026-10-25T04:00', tz: calendar.ZONE });
  ui.click('live'); assert.deepEqual(ui.pressed(), ['live']); assert.equal(ui.instance.selection, null);
  assert(ids['calendar-picker-label'].hidden); assert(ids['calendar-custom'].hidden);
  assert(!ids['chart-range'].disabled); assert(!ids['chart-range'].wrapper.hidden);
  assert.equal(changes, 7);
});
test('restoration, UTC navigation and existing mode/date change handlers keep period buttons in sync', () => {
  const ui = mountedCalendar({ period: 'hour', at: '2026-10-25T01:00:00Z', tz: calendar.ZONE });
  assert.deepEqual(ui.pressed(), ['hour']); assert.equal(ui.writes.length, 0);
  assert.equal(ui.instance.selection.at, '2026-10-25T01:00:00Z');
  const b = fixture();
  b.selection = { period: 'hour', date: '2026-10-25T02:00', timezone: calendar.ZONE };
  b.navigation.previous = { period: 'hour', at: '2026-10-25T00:00:00Z', tz: calendar.ZONE };
  ui.instance.loaded(b);
  ui.ids['calendar-prev'].dispatchEvent(new Event('click'));
  assert.equal(ui.instance.selection.at, '2026-10-25T00:00:00Z');
  assert.deepEqual(ui.pressed(), ['hour']);
  ui.ids['calendar-mode'].value = 'week'; ui.ids['calendar-mode'].dispatchEvent(new Event('change'));
  assert.deepEqual(ui.pressed(), ['week']);
  ui.ids['calendar-date'].value = '2026-W44'; ui.ids['calendar-date'].dispatchEvent(new Event('change'));
  assert.deepEqual(ui.instance.selection, { period: 'week', date: '2026-W44', tz: calendar.ZONE });
  ui.instance.reset(); assert.deepEqual(ui.pressed(), ['week']);
  assert(ui.ids['calendar-prev'].disabled); assert(ui.ids['calendar-next'].disabled);
});
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
test('immutable render views and unchanged data revisions avoid archive copies and duplicate rebuilding', () => {
  const store = calendar.createArchiveStore(), b = fixture();
  assert(store.importHistory(b, now));
  const view = store.view(), revision = store.revision;
  assert(Object.isFrozen(view)); assert(Object.isFrozen(view.buckets[0].metrics));
  assert.throws(() => { view.buckets.length = 0; }, TypeError);
  const newer = fixture({ generated_at: new Date(now + 1000).toISOString(), reason: 'Neu abgerufen' });
  assert(store.importHistory(newer, now + 1000));
  assert.equal(store.revision, revision); assert.equal(store.view(), view);
  newer.buckets[0].metrics.active_power_w.max = 100;
  assert(store.importHistory(newer, now + 1000));
  assert.equal(store.revision, revision + 1); assert.notEqual(store.view(), view);
});
test('archive plotting reads only selected group metrics and formats interval labels lazily', () => {
  const b = fixture();
  for (const field of calendar.FIELDS.filter(f => f !== 'active_power_w'))
    Object.defineProperty(b.buckets[0].metrics, field, { get() { throw Error('unselected metric touched'); } });
  const p = calendar.buildSummaryPlot(b, charts.GROUPS[0], charts.defaults().selected, charts);
  assert.equal(p.count, 150); assert.equal(p.paths.length, 1);
  assert(p.paths[0].renderPaths.length > 0);
  assert.match(p.paths[0].labelAt(0), /150 Werte/);
  assert.equal(p.paths[0].labelAt(9), null);
  assert.equal(p.paths[0].glyphs.length, 2, 'Optional logical glyph access stays compatible');
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
test('compact axes omit repeated date/zone while full labels retain DST context', () => {
  const stamp = Date.parse('2026-10-28T12:30:00Z');
  for (const period of ['hour', 'day']) {
    assert.match(calendar.axisLabel(stamp, period, calendar.ZONE, true), /^13:30$/);
    assert.match(calendar.axisLabel(stamp, period), /GMT\+1/);
  }
  assert(calendar.axisLabel(stamp, 'year', calendar.ZONE, true).length < 10);
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
  b.buckets[0].metrics.active_power_w = { count: 150, nulls: 0, mean: 1000, min: 0, max: 4000, last: 3000, mixed: true };
  const p = calendar.buildSummaryPlot(b, charts.GROUPS[0], charts.defaults().selected, charts);
  assert.equal(p.count, 150); assert.equal(p.paths[0].markers.length, 0);
  const [range, value] = p.paths[0].glyphs;
  assert.equal(p.paths[0].glyphs.length, 2);
  assert.equal(range.kind, 'range'); assert(range.path.endsWith('Z')); assert(!range.path.includes('H'));
  assert.equal(value.kind, 'value'); assert(value.path.includes('H')); assert(!value.path.includes('V'));
  assert.equal(p.paths[0].path, '');
  assert.equal(Number(value.path.split(',')[1].split('H')[0]), Number((180 - (1 - p.lo) / (p.hi - p.lo) * 155).toFixed(2)), 'API mean, not last or min/max midpoint reconstruction');
  assert(p.paths[0].glyphs.every(g => !/NaN|Infinity/.test(g.path)));
  b.buckets[0].has_gap = true; b.buckets[0].metrics.charging = { count: 150, nulls: 0, mean: null, min: 0, max: 1, last: false, mixed: true };
  const mixed = calendar.buildSummaryPlot(b, charts.GROUPS.find(g => g.id === 'flags'), charts.defaults().selected, charts)
    .paths.find(p => p.metric.id === 'charging').glyphs[0];
  assert(mixed.gap); assert(mixed.mixed); assert.equal(mixed.kind, 'range');
  assert(mixed.path.endsWith('Z')); assert(!mixed.path.includes('H'));
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
test('latest NULL is not replaced by an older known state; partial last marks are bucket-local', () => {
  const b = fixture();
  b.buckets[0].metrics.charging = { count: 149, nulls: 1, mean: null, min: 0, max: 0, last: null, mixed: false };
  assert(calendar.validate(b, now));
  const group = charts.GROUPS.find(g => g.id === 'flags');
  const p = calendar.buildSummaryPlot(b, group, charts.defaults().selected, charts);
  assert(p.paths.find(s => s.metric.id === 'charging').glyphs.every(g => g.kind === 'range'));
  b.buckets[0].has_gap = true;
  const q = calendar.buildSummaryPlot(b, group, charts.defaults().selected, charts);
  assert(q.paths.every(s => s.glyphs.every(g => g.gap)));
  assert(q.paths.find(s => s.metric.id === 'plugged').glyphs.some(g => g.kind === 'value'), 'known false last remains visible');
});

function hourSeries() {
  const b = fixture(), start = calendar.utc(b.range.from);
  b.range.to = new Date(start + 3600000).toISOString();
  b.selection = { period: 'hour', date: '2026-10-27T00:00', timezone: 'Europe/Vienna' };
  b.navigation = { previous: null, next: null, now: null };
  b.buckets = Array.from({ length: 60 }, (_, i) => ({
    from: new Date(start + i * 60000).toISOString(), to: new Date(start + (i + 1) * 60000).toISOString(),
    samples: 30, has_gap: true, complete: false, coverage_seconds: 58, metrics: metrics(30)
  }));
  return b;
}
const summary = (b, field) => {
  const metric = charts.METRICS.find(m => calendar.fieldFor(m) === field);
  const group = charts.GROUPS.find(g => g.id === metric.group);
  return calendar.buildSummaryPlot(b, group, charts.defaults().selected, charts).paths.find(p => p.metric.id === metric.id);
};
function assertIndependentTicks(series, expected) {
  assert.equal(series.path, ''); assert.deepEqual(series.markers, []);
  const values = series.glyphs.filter(g => g.kind === 'value');
  assert.equal(values.length, expected);
  let previous = -Infinity;
  for (const glyph of values) {
    const match = /^M([\d.]+),([\d.]+)H([\d.]+)$/.exec(glyph.path);
    assert(match, 'one solid aggregate tick, no multi-bucket path');
    const left = Number(match[1]), right = Number(match[3]);
    assert(left > previous); assert(right > left); previous = right;
  }
}
test('hour-long constant zero W and 6 A retain 60 solid-role aggregates despite incomplete/gap context', () => {
  const b = hourSeries(); assert(calendar.validate(b, now));
  for (const field of ['active_power_w', 'current_limit_a']) {
    const series = summary(b, field);
    assertIndependentTicks(series, 60);
    assert(series.glyphs.every(g => g.gap));
    assert(series.glyphs.filter(g => g.kind === 'value').every(g => g.label.includes(field === 'active_power_w' ? 'Stichprobenmittel 0' : 'letzter Wert 6')));
  }
});
test('only complete adjacent buckets connect; empty, NULL, offline and missing intervals split paths', () => {
  const b = hourSeries();
  b.buckets.forEach(bin => { bin.complete = true; bin.has_gap = false; bin.coverage_seconds = 60; });
  assertIndependentTicks(summary(b, 'active_power_w'), 60);
  assert.equal(summary(b, 'active_power_w').renderPaths.find(p => p.kind === 'value').path.match(/M/g).length, 1);
  b.buckets[10].samples = 0; b.buckets[10].metrics = metrics(0); b.buckets[10].coverage_seconds = 0;
  b.buckets[20].metrics.active_power_w = { count: 0, nulls: 30, mean: null, min: null, max: null, last: null, mixed: false };
  b.buckets[30].has_gap = true;
  b.buckets[31].complete = false;
  b.buckets.splice(40, 1);
  assert(calendar.validate(b, now));
  const series = summary(b, 'active_power_w');
  assertIndependentTicks(series, 57);
  assert.equal(series.glyphs.filter(g => g.kind === 'value' && g.gap).length, 2);
  const normal = series.renderPaths.find(p => p.kind === 'value' && !p.gap);
  assert.equal(normal.path.match(/M/g).length, 5, 'Five separated fully observed runs; no path across missing data');
  assert.equal(series.renderPaths.find(p => p.kind === 'value' && p.gap).path.match(/M/g).length, 2);
});
test('varying numeric means connect despite mixed ranges and an unrelated unknown charging state', () => {
  const b = hourSeries();
  for (const [i, bin] of b.buckets.entries()) {
    bin.complete = true; bin.has_gap = false; bin.coverage_seconds = 60;
    bin.metrics.voltage_l1_v = { count: 30, nulls: 0, min: 228, max: 236, mean: 230 + i % 5, last: 232, mixed: true };
    bin.metrics.charging = { count: 0, nulls: 30, min: null, max: null, mean: null, last: null, mixed: false };
  }
  assert(calendar.validate(b, now));
  const path = summary(b, 'voltage_l1_v').renderPaths.find(p => p.kind === 'value').path;
  assert.equal((path.match(/M/g) || []).length, 1);
  assert.equal((path.match(/L/g) || []).length, 59);
  assert.equal(summary(b, 'charging').renderPaths.length, 0);
  b.buckets[20].metrics.voltage_l1_v.nulls = 1;
  b.buckets[20].metrics.voltage_l1_v.count = 29;
  const broken = summary(b, 'voltage_l1_v').renderPaths;
  assert.equal((broken.find(p => p.kind === 'value' && !p.gap).path.match(/M/g) || []).length, 2);
  assert(broken.some(p => p.kind === 'value' && p.gap));
});
test('partial physical min/max stays separate from mean and never fabricates a zero for missing mean', () => {
  const b = hourSeries();
  b.buckets = b.buckets.slice(0, 1);
  b.buckets[0].metrics.voltage_l1_v = { count: 29, nulls: 1, min: 220, max: 240, mean: 231, last: null, mixed: true };
  assert(calendar.validate(b, now));
  const series = summary(b, 'voltage_l1_v');
  assert.equal(series.glyphs.length, 2);
  assert(series.glyphs.every(g => g.gap && g.mixed));
  assert(series.glyphs[0].path.endsWith('Z'));
  assert(series.glyphs[1].label.includes('Stichprobenmittel 231'));
  b.buckets[0].metrics.voltage_l1_v.mean = null;
  assert.deepEqual(summary(b, 'voltage_l1_v').glyphs.map(g => g.kind), ['range']);
});
test('flags/codes never average mixed states; limit/session use actual last including NULL', () => {
  const b = fixture();
  for (const field of ['charging', 'error_code']) {
    b.buckets[0].metrics[field] = { count: 150, nulls: 0, min: 0, max: 1, mean: null, last: field === 'charging' ? false : 0, mixed: true };
    assert.deepEqual(summary(b, field).glyphs.map(g => g.kind), ['range']);
  }
  for (const field of ['current_limit_a', 'session_energy_wh']) {
    b.buckets[0].metrics[field] = { count: 149, nulls: 1, min: 6, max: 16, mean: null, last: 7, mixed: true };
    const series = summary(b, field);
    assert.deepEqual(series.glyphs.map(g => g.kind), ['range', 'value']);
    assert(series.glyphs[1].label.includes(`letzter Wert ${new Intl.NumberFormat('de-AT', { maximumSignificantDigits: 6 }).format(7 / series.metric.divisor)}`));
    b.buckets[0].metrics[field].last = null;
    assert.deepEqual(summary(b, field).glyphs.map(g => g.kind), ['range']);
  }
  assert(calendar.validate(b, now));
});

test('512 buckets retain every extreme and label but need at most four paths per series', () => {
  const b = hourSeries(), start = calendar.utc(b.range.from);
  b.buckets = Array.from({ length: 512 }, (_, i) => ({
    ...b.buckets[0], metrics: metrics(30), has_gap: i % 7 === 0, complete: true,
    from: new Date(start + i * 6000).toISOString(), to: new Date(start + (i + 1) * 6000).toISOString(), coverage_seconds: 6
  }));
  b.buckets.forEach((bin, i) => Object.assign(bin.metrics.active_power_w, { min: i, max: i + 1000, mean: i + 500, last: i }));
  const p = calendar.buildSummaryPlot(b, charts.GROUPS[0], charts.defaults().selected, charts);
  const s = p.paths[0];
  assert.equal(p.bucketCount, 512); assert.equal(p.count, 15360);
  assert.equal(s.glyphs.length, 1024); assert(s.renderPaths.length <= 4);
  for (let i = 0; i < 512; i++) {
    const glyph = s.glyphs.find(g => g.bucketIndex === i && g.kind === 'range');
    assert(glyph); assert(glyph.label.includes('30 Werte'));
  }
  assert(p.hi >= 1.511); assert(p.lo <= 0);
  assert(s.renderPaths.every(g => !/NaN|Infinity/.test(g.path)));
  const uncertain = s.renderPaths.find(g => g.kind === 'value' && g.gap);
  assert(!uncertain.path.includes('L'), 'Incomplete intervals are independent subpaths, not a repaired trend');
});
test('calendar publishes metadata only and accepts HOUSE navigation only for the exact current query', () => {
  const ui = mountedCalendar();
  assert.equal(calendar.currentSelection, null); assert.equal(calendar.currentRange, null);
  assert.deepEqual(ui.events[0], { selection: null, range: null }, 'Late modules can read properties and early modules receive initial live state');
  ui.click('day');
  const original = { period: 'day', date: 'now', tz: calendar.ZONE };
  assert.deepEqual(calendar.currentSelection, original);
  const b = fixture(), metadata = { range: b.range, selection: b.selection, navigation: b.navigation };
  function deliver(query, value = metadata) {
    const event = new Event('evse:calendar-range');
    Object.defineProperty(event, 'detail', { value: { query, metadata: value } });
    ui.eventTarget.dispatchEvent(event);
  }
  deliver(calendarQuery({ period: 'year', date: 'now', tz: calendar.ZONE }));
  assert(ui.ids['calendar-prev'].disabled);
  deliver(calendarQuery(original), { ...metadata, buckets: [] });
  assert(ui.ids['calendar-prev'].disabled, 'Unknown metadata fields are not admitted');
  deliver(calendarQuery(original));
  assert(!ui.ids['calendar-prev'].disabled);
  assert.deepEqual(calendar.currentRange, b.range);
  assert.deepEqual(calendar.currentSelection, { period: 'day', at: b.range.from, tz: calendar.ZONE });
  assert.deepEqual(ui.instance.selection, original, 'Relative Now preference is not rewritten');
  assert(ui.events.every(e => Object.keys(e).sort().join() === 'range,selection'));
  const savedRange = calendar.currentRange;
  deliver(calendarQuery(original), metadata);
  assert.equal(ui.events.length, 3, 'Resolved fallback metadata is accepted only once');
  deliver(calendarQuery(calendar.currentSelection), { ...metadata, range: { ...b.range, from: 'invalid' } });
  assert.deepEqual(calendar.currentRange, savedRange);
  ui.click('live');
  deliver(calendarQuery(original));
  assert.equal(calendar.currentSelection, null); assert.equal(calendar.currentRange, null);
  assert(ui.ids['calendar-prev'].disabled);
});
