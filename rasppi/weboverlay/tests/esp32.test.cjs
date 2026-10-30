'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateEnvelope, validateUid, createFreshness } = require('../static/esp32.js');
function result(overrides = {}) {
  return { schema_version: 1, id: 'a'.repeat(32), operation: 'inspect', status: 'ok', reason: 'ready',
    session: 'b'.repeat(32), lease: 'c'.repeat(32), fresh_for_seconds: 8, firmware_version: 2,
    state: { charging: false, antitheft: false, store_ready: true, cards: 0, enrolling: false, reader_ready: true, servo_ready: true },
    command_sent: false, result_code: null, ...overrides };
}
function envelope(inspection = result()) { return { status: 'ok', csrf: 'd'.repeat(64), inspection, command: null, command_sent: false }; }
test('private UID accepts exactly colon-separated 4/7/10-byte hex; never normalizes invalid data', () => {
  for (const n of [4, 7, 10]) assert.equal(validateUid(Array(n).fill('aB').join(':')), true);
  for (const n of [0, 1, 3, 5, 6, 8, 9, 11]) assert.equal(validateUid(Array(n).fill('AB').join(':')), false);
  for (const v of [null, 123, ' AB:CD:EF:01', 'AB:CD:EF:01\n', 'AB-CD-EF-01', '<img>']) assert.equal(validateUid(v), false);
});
test('strict bounded envelope retains genuine false/zero and unknown; rejects fake compatibility', () => {
  assert.equal(validateEnvelope(envelope()), true);
  assert.equal(validateEnvelope(envelope(result({ firmware_version: null }))), true);
  for (const v of [1, 3, '2', undefined]) assert.equal(validateEnvelope(envelope(result({ firmware_version: v }))), false);
  for (const patch of [{ schema_version: 2 }, { fresh_for_seconds: 9 }, { lease: 'bad' }, { reason: '<img src=x>' }, { command_sent: 1 }])
    assert.equal(validateEnvelope(envelope(result(patch))), false);
  for (const cards of [null, 0, 16]) assert.equal(validateEnvelope(envelope(result({ state: { ...result().state, cards } }))), true);
  for (const cards of [-1, 17, '0', 0.5]) assert.equal(validateEnvelope(envelope(result({ state: { ...result().state, cards } }))), false);
  assert.equal(validateEnvelope(envelope(result({ state: { ...result().state, antitheft: null } }))), true);
  assert.equal(validateEnvelope(envelope(result({ state: { ...result().state, antitheft: 0 } }))), false);
});
test('freshness includes roundtrip; getter cannot resurrect expired values', () => {
  let w = 10000, m = 1000;
  const f = createFreshness(() => w, () => m), stamp = f.stamp();
  w += 3000; m += 3000; f.set(result(), 10000, 1000, stamp);
  assert(f.read()); w += 4999; m += 4999; assert(f.read());
  w++; m++; assert.equal(f.read(), null); w -= 100; m -= 100; assert.equal(f.read(), null);
});
test('either clock regression invalidates pending response and retained getter', () => {
  for (const clock of ['wall', 'mono']) {
    let w = 10000, m = 10000;
    const f = createFreshness(() => w, () => m), stamp = f.stamp();
    f.set(result(), w, m, stamp);
    if (clock === 'wall') w--; else m--;
    assert.equal(f.read(), null);
    w += 2; m += 2;
    assert.equal(f.set(result(), 10000, 10000, stamp), null);
  }
});
test('forward wall-clock jump or delayed monotonic clock expiry is fail-closed', () => {
  for (const clock of ['wall', 'mono']) {
    let w = 10000, m = 10000;
    const f = createFreshness(() => w, () => m); f.set(result(), w, m);
    if (clock === 'wall') w += 8000; else m += 8000;
    assert.equal(f.read(), null);
  }
});
module.exports = { result, envelope };
