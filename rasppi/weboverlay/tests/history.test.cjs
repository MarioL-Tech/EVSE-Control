'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHistoryLoader, MAX_BYTES, ARCHIVE_MAX_BYTES, TIMEOUT_MS } = require('../static/history.js');
const { createHistory } = require('../static/charts.js');
const epoch = Date.parse('2026-10-04T12:00:00Z');
const iso = t => new Date(t).toISOString();
const batch = (status = 'ok') => ({ schema_version: 1, read_only: true, status, reason: '<img src=x>',
  generated_at: iso(epoch), minutes: 15, range: { from: iso(epoch - 900000), to: iso(epoch) },
  complete: true, samples: [] });
const response = (data, status = 200) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(data) });
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function setup() {
  const calls = [], pending = [], timers = new Map(), states = [], imports = [], archives = [];
  let now = { wall: epoch, mono: 0 }, nextTimer = 0, resets = 0;
  const history = createHistory();
  const loader = createHistoryLoader({
    clock: () => ({ ...now }),
    fetch: (url, options) => { calls.push({ url, options }); return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
    setTimer: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimer: id => timers.delete(id),
    onState: s => states.push(s), onReset: () => { resets++; history.clear(); },
    importHistory: (b, t) => { imports.push(b); return history.importHistory(b, t); },
    importArchive: (b, t, selection) => { archives.push({ b, t, selection }); return b.schema_version === 2 && b.read_only === true; }
  });
  return { loader, calls, pending, timers, states, imports, archives, history,
    get resets() { return resets; },
    advance(ms) { now.wall += ms; now.mono += ms; },
    setClock(value) { now = value; }
  };
}
test('initial full range, single request, 60-second visible refresh and no extra refresh timer', async () => {
  const s = setup(); s.loader.tick(); s.loader.tick();
  assert.equal(s.calls.length, 1); assert.equal(s.calls[0].url, '/api/history?minutes=15');
  assert.equal(s.calls[0].options.cache, 'no-store');
  assert.equal([...s.timers.values()][0].ms, TIMEOUT_MS);
  s.pending[0].resolve(response(batch())); await flush();
  assert.equal(s.imports.length, 1); assert.equal(s.timers.size, 0);
  s.advance(59999); s.loader.tick(); assert.equal(s.calls.length, 1);
  s.advance(1); s.loader.tick(); assert.equal(s.calls.length, 2);
});
test('disabled preserves browser-only mode and stops automatic refresh until visible or restored', async () => {
  const s = setup(); s.loader.tick(); s.pending[0].resolve(response(batch('disabled'))); await flush();
  assert.deepEqual(s.states.at(-1), { status: 'disabled', loaded: false, complete: true });
  s.advance(120000); s.loader.tick(); s.loader.invalidate(); s.loader.tick(); assert.equal(s.calls.length, 1);
  s.loader.setVisible(false); s.loader.tick(); assert.equal(s.calls.length, 1);
  s.loader.setVisible(true); s.loader.tick(); assert.equal(s.calls.length, 2);
  s.loader.restore(); s.loader.tick(); assert.equal(s.calls.length, 3); assert.equal(s.resets, 1);
});
test('clock rollback cannot re-enable a confirmed disabled history', async () => {
  for (const field of ['wall', 'mono']) {
    const s = setup(); s.loader.tick();
    s.pending[0].resolve(response(batch('disabled'))); await flush();
    s.advance(2000); s.loader.tick();
    const now = { wall: epoch + 2000, mono: 2000 }; now[field]--;
    s.setClock(now); s.loader.tick();
    assert.equal(s.resets, 1); assert.equal(s.calls.length, 1);
    assert.equal(s.states.at(-1).status, 'disabled');
    s.advance(120000); s.loader.tick(); assert.equal(s.calls.length, 1);
  }
});
test('failure/authorization/malformed responses do not clear history; retry is bounded 10/30/60 seconds', async () => {
  const s = setup(); s.loader.tick(); s.pending[0].resolve(response(batch())); await flush();
  for (const [i, invalid] of [response({}, 401), response({ ...batch(), complete: 1 }), response(batch('unavailable'), 503)].entries()) {
    if (i === 0) { s.advance(60000); s.loader.tick(); }
    s.pending.at(-1).resolve(invalid); await flush();
    assert.equal(s.states.at(-1).status, 'unavailable'); assert.equal(s.states.at(-1).loaded, true);
    assert.equal(s.resets, 0);
    const count = s.calls.length, delay = [10000, 30000, 60000][i];
    s.advance(delay - 1); s.loader.tick(); assert.equal(s.calls.length, count);
    s.advance(1); s.loader.tick(); assert.equal(s.calls.length, count + 1);
  }
});
test('timeout aborts, late responses cannot import, only one timeout exists', async () => {
  const s = setup(); s.loader.tick();
  const timeout = [...s.timers.values()][0]; s.advance(4000); timeout.fn();
  assert(s.calls[0].options.signal.aborted); assert.equal(s.timers.size, 0);
  s.pending[0].resolve(response(batch())); await flush(); assert.equal(s.imports.length, 0);
  s.advance(10000); s.loader.tick(); assert.equal(s.calls.length, 2); assert.equal(s.timers.size, 1);
});
test('bad HTTP and excessive Content-Length abort unread never-ending bodies before releasing the request slot', async () => {
  for (const excessiveLength of [false, true]) {
    const s = setup(); let opened = 0, aborted = 0;
    s.loader.tick();
    s.calls[0].options.signal.addEventListener('abort', () => { aborted++; });
    s.pending[0].resolve({ status: excessiveLength ? 200 : 401,
      headers: { get: () => excessiveLength ? String(MAX_BYTES + 1) : null },
      body: { getReader() {
        opened++;
        return { read: () => new Promise(() => {}), async cancel() {}, releaseLock() {} };
      } }
    });
    await flush();
    assert.equal(opened, 0, 'Header rejection must not consume the body');
    assert.equal(aborted, 1); assert(s.calls[0].options.signal.aborted);
    assert.equal(s.timers.size, 0); assert.equal(s.imports.length, 0);
    assert.equal(s.states.length, 1); assert.equal(s.states[0].status, 'unavailable');
    // Even a noncompliant transport attempting a late resolution cannot import
    // or take ownership of a retry's active slot/timer.
    s.pending[0].resolve(response(batch())); await flush(); assert.equal(s.imports.length, 0);
    s.advance(9999); s.loader.tick(); assert.equal(s.calls.length, 1);
    s.advance(1); s.loader.tick(); assert.equal(s.calls.length, 2); assert.equal(s.timers.size, 1);
    assert(!s.calls[1].options.signal.aborted);
    s.pending[0].reject(Error('late transport error')); await flush();
    assert.equal(s.states.length, 1); assert.equal(s.timers.size, 1);
    s.pending[1].resolve(response({}, 403)); await flush();
    assert(s.calls[1].options.signal.aborted); assert.equal(s.timers.size, 0);
    s.advance(29999); s.loader.tick(); assert.equal(s.calls.length, 2);
    s.advance(1); s.loader.tick(); assert.equal(s.calls.length, 3);
    s.loader.stop(); assert.equal(s.timers.size, 0);
    assert(s.calls.every(call => call.options.signal.aborted));
  }
});
test('reader exceptions abort before cleanup even when cleanup depends on the transport abort', async () => {
  const s = setup(); let cleanupAborted = false, released = false;
  s.loader.tick();
  const signal = s.calls[0].options.signal;
  s.pending[0].resolve({ status: 200, body: { getReader: () => ({
    async read() { throw Error('broken stream'); },
    cancel() {
      cleanupAborted = signal.aborted;
      return signal.aborted ? Promise.resolve() : new Promise(() => {});
    }, releaseLock() { released = true; }
  }) } });
  await flush();
  assert(signal.aborted && cleanupAborted && released);
  assert.equal(s.timers.size, 0); assert.equal(s.imports.length, 0);
  assert.equal(s.states.length, 1); assert.equal(s.states[0].status, 'unavailable');
});
test('hidden, range invalidation and BFCache reset invalidate tokens; late results cannot resurrect data', async () => {
  for (const event of ['hidden', 'range', 'restore']) {
    const s = setup(); s.loader.tick();
    if (event === 'hidden') s.loader.setVisible(false);
    if (event === 'range') s.loader.invalidate();
    if (event === 'restore') s.loader.restore();
    assert(s.calls[0].options.signal.aborted);
    s.pending[0].resolve(response(batch())); await flush(); assert.equal(s.imports.length, 0);
    s.loader.tick(); assert.equal(s.calls.length, event === 'hidden' ? 1 : 2);
    if (event === 'hidden') { s.loader.setVisible(true); s.loader.tick(); assert.equal(s.calls.length, 2); }
  }
});
test('wall and monotonic rollback reset both histories and invalidate pending fetches', async () => {
  for (const field of ['wall', 'mono']) {
    const s = setup(); s.loader.tick(); s.advance(2000); s.loader.tick();
    const now = { wall: epoch + 2000, mono: 2000 }; now[field]--;
    s.setClock(now); s.loader.tick(); assert.equal(s.resets, 1);
    s.pending[0].resolve(response(batch())); await flush(); assert.equal(s.imports.length, 0);
    assert.equal(s.calls.length, 2);
  }
});
test('rollback between HTTP completion and ticks cannot import a stale generation', async () => {
  const s = setup(); s.loader.tick(); s.setClock({ wall: epoch - 1, mono: 1 });
  s.pending[0].resolve(response(batch())); await flush();
  assert.equal(s.resets, 1); assert.equal(s.imports.length, 0);
});
test('stream byte budget is 1 MiB and excess cancels before JSON/import', async () => {
  const s = setup(); let reads = 0, cancelled = false, released = false;
  s.loader.tick();
  s.pending[0].resolve({ status: 200, headers: { get: () => null }, body: { getReader: () => ({
    async read() { reads++; return { done: false, value: new Uint8Array(MAX_BYTES / 2 + 1) }; },
    async cancel() { cancelled = true; }, releaseLock() { released = true; }
  }) } });
  await flush(); assert.equal(reads, 2); assert(cancelled && released);
  assert(s.calls[0].options.signal.aborted);
  assert.equal(s.imports.length, 0); assert.equal(s.states.at(-1).status, 'unavailable');
});
test('valid streaming response decodes split UTF-8 and imports only after complete body', async () => {
  const s = setup();
  const bytes = new TextEncoder().encode(JSON.stringify({ ...batch(), reason: 'Lücken' }));
  let offset = 0;
  s.loader.tick();
  s.pending[0].resolve({ status: 200, headers: { get: () => String(bytes.length) }, body: { getReader: () => ({
    async read() {
      if (offset === bytes.length) return { done: true };
      const end = Math.min(bytes.length, offset + 8), value = bytes.slice(offset, end); offset = end;
      return { done: false, value };
    }, async cancel() {}, releaseLock() {}
  }) } });
  for (let i = 0; i < 20; i++) await flush();
  assert.equal(s.imports.length, 1); assert.equal(s.imports[0].reason, 'Lücken');
  assert.equal(s.states.at(-1).status, 'ok');
});
test('advertised excessive body, invalid UTF-8 and invalid JSON reject without mutation', async () => {
  const bodies = [
    { status: 200, headers: { get: () => String(MAX_BYTES + 1) }, text: async () => { throw Error('must not read'); } },
    { status: 200, text: async () => '{broken' },
    { status: 200, body: { getReader: () => ({ async read() { return { done: false, value: new Uint8Array([255]) }; },
      async cancel() {}, releaseLock() {} }) } }
  ];
  for (const body of bodies) {
    const s = setup(); s.loader.tick(); s.pending[0].resolve(body); await flush();
    assert.equal(s.imports.length, 0); assert.equal(s.states.at(-1).status, 'unavailable');
    assert(s.calls[0].options.signal.aborted); assert.equal(s.timers.size, 0);
  }
});
test('successful complete/partial responses report own metadata and never expose reason as HTML', async () => {
  const s = setup(); s.loader.tick(); s.pending[0].resolve(response({ ...batch(), complete: false })); await flush();
  assert.deepEqual(s.states.at(-1), { status: 'ok', loaded: true, complete: false });
  assert(!JSON.stringify(s.states).includes('<img'));
  s.loader.stop(); s.advance(60000); s.loader.tick(); assert.equal(s.calls.length, 1);
});

const calendarBatch = (to = epoch + 3600000, complete = true) => ({ schema_version: 2, read_only: true,
  status: 'ok', complete, range: { from: iso(epoch - 3600000), to: iso(to) }, buckets: [] });
test('calendar selection replaces raw query, aborts old generations, never imports archive into live', async () => {
  const s = setup(); s.loader.tick();
  assert(s.loader.select({ period: 'year', date: '2026', tz: 'Europe/Vienna' })); s.loader.tick();
  assert(s.calls[0].options.signal.aborted);
  assert.equal(new URL(s.calls[1].url, 'http://test').searchParams.get('period'), 'year');
  s.pending[0].resolve(response(batch())); await flush(); assert.equal(s.imports.length, 0);
  s.pending[1].resolve(response(calendarBatch())); await flush();
  assert.equal(s.archives.length, 1); assert.equal(s.imports.length, 0); assert.equal(s.history.size, 0);
  assert(s.loader.select({ period: 'day', date: 'now', tz: 'Europe/Vienna' })); s.loader.tick();
  assert.equal(s.calls.length, 3); assert.equal(s.states.at(-1).loaded, false);
  assert.equal(s.loader.select({ period: 'day', date: 'now', tz: 'Europe/Vienna', url: 'https://evil' }), false);
});
test('calendar current/partial refresh is bounded; completed past periods are not repeatedly fetched', async () => {
  for (const [to, complete, refresh] of [[epoch - 1000, true, false], [epoch + 3600000, true, true], [epoch - 1000, false, true]]) {
    const s = setup(); s.loader.select({ period: 'day', date: '2026-10-04', tz: 'Europe/Vienna' }); s.loader.tick();
    s.pending[0].resolve(response(calendarBatch(to, complete))); await flush();
    s.advance(59999); s.loader.tick(); assert.equal(s.calls.length, 1);
    s.advance(1); s.loader.tick(); assert.equal(s.calls.length, refresh ? 2 : 1);
  }
});
test('API 2 alone has 2 MiB budget; hiding, restore, failure and late response cannot leak selections', async () => {
  const s = setup(); s.loader.select({ period: 'month', date: '2026-10', tz: 'Europe/Vienna' }); s.loader.tick();
  s.pending[0].resolve({ ...response(calendarBatch()), headers: { get: () => String(MAX_BYTES + 1) } }); await flush();
  assert.equal(s.archives.length, 1);
  s.loader.invalidate(); s.loader.tick();
  s.pending[1].resolve({ ...response(calendarBatch()), headers: { get: () => String(ARCHIVE_MAX_BYTES + 1) } }); await flush();
  assert(s.calls[1].options.signal.aborted); assert.equal(s.states.at(-1).loaded, true);
  s.loader.invalidate(); s.loader.tick(); s.loader.setVisible(false);
  s.pending[2].resolve(response(calendarBatch())); await flush(); assert.equal(s.archives.length, 1);
  s.loader.setVisible(true); s.loader.restore(); s.loader.tick();
  assert.equal(s.resets, 1); assert.equal(s.states.at(-1).loaded, false);
  s.loader.select(null); s.loader.tick();
  assert(s.calls[3].options.signal.aborted); assert.equal(s.calls[4].url, '/api/history?minutes=15');
});
test('unsubmitted custom picker suspends all SQL requests through visibility/restore until valid selection', () => {
  const s = setup(); s.loader.tick(); s.loader.suspend(); assert(s.calls[0].options.signal.aborted);
  s.loader.setVisible(false); s.loader.setVisible(true); s.loader.restore(); s.loader.tick(); assert.equal(s.calls.length, 1);
  s.loader.select({ period: 'custom', date_from: '2026-10-01T00:00', date_to: '2026-10-02T00:00', tz: 'Europe/Vienna' });
  s.loader.tick(); assert.equal(s.calls.length, 2);
});
