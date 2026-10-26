'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { STORAGE_KEY, MODES, normalize, createController } = require('../static/theme.js');

function storage(initial = null) {
  let value = initial;
  const calls = [];
  return { calls, get value() { return value; }, external(next) { value = next; },
    getItem(key) { calls.push(['get', key]); return value; },
    setItem(key, next) { calls.push(['set', key, next]); value = next; },
    removeItem(key) { calls.push(['remove', key]); value = null; } };
}

test('exact key, modes and strict normalization', () => {
  assert.equal(STORAGE_KEY, 'evse-theme-v1');
  assert.deepEqual(MODES, ['system', 'light', 'dark']);
  for (const mode of MODES) assert.equal(normalize(mode), mode);
  for (const value of [null, undefined, '', 'LIGHT', ' dark ', 'auto', 0, false, {}, [],
    '<img src=x onerror=alert(1)>', '"light"']) assert.equal(normalize(value), 'system');
});

test('constructor restores and notifies; getMode reflects subsequent choices', () => {
  const store = storage('dark'), changes = [];
  const controller = createController(store, mode => changes.push(mode));
  assert.equal(controller.getMode(), 'dark');
  assert.deepEqual(changes, ['dark']);
  controller.setMode('light');
  assert.equal(controller.getMode(), 'light');
  assert.equal(changes.at(-1), 'light');
  assert.equal(store.value, 'light');
});

test('restore follows external persisted changes including removal and invalid values', () => {
  const store = storage('light'), controller = createController(store);
  for (const [value, expected] of [['dark', 'dark'], [null, 'system'], ['invalid', 'system'], ['light', 'light']]) {
    store.external(value); controller.restore(); assert.equal(controller.getMode(), expected);
  }
});

test('invalid persisted input initializes System and never reaches the change callback verbatim', () => {
  const changes = [], controller = createController(storage('<script>alert(1)</script>'), mode => changes.push(mode));
  assert.equal(controller.getMode(), 'system');
  assert.deepEqual(changes, ['system']);
});

test('only raw manual modes are written; system and invalid selections remove the exact key', () => {
  const store = storage(), controller = createController(store);
  for (const mode of ['light', 'dark', 'system', '<script>', null]) controller.setMode(mode);
  assert.deepEqual(store.calls.filter(call => call[0] !== 'get'), [
    ['set', STORAGE_KEY, 'light'], ['set', STORAGE_KEY, 'dark'],
    ['remove', STORAGE_KEY], ['remove', STORAGE_KEY], ['remove', STORAGE_KEY]
  ]);
  assert(store.calls.every(call => call[1] === STORAGE_KEY), 'No display, credentials or measurement keys touched');
  assert.equal(controller.getMode(), 'system');
});

test('read failure preserves current selection and later successful restore works', () => {
  const store = storage('dark'), controller = createController(store);
  const read = store.getItem;
  store.getItem = () => { throw new Error('denied'); };
  controller.restore(); assert.equal(controller.getMode(), 'dark');
  controller.setMode('light'); controller.restore(); assert.equal(controller.getMode(), 'light');
  store.getItem = read; store.external('dark'); controller.restore();
  assert.equal(controller.getMode(), 'dark');
});

for (const [operation, selected] of [['setItem', 'light'], ['removeItem', 'system']]) {
  test(`${operation} failure is session-only even with readable stale storage; successful write clears latch`, () => {
    const store = storage('dark'), changes = [], controller = createController(store, mode => changes.push(mode));
    const original = store[operation];
    store[operation] = () => { throw new Error('quota / denied'); };
    controller.setMode(selected);
    assert.equal(controller.getMode(), selected);
    assert.equal(changes.at(-1), selected);
    assert.equal(store.value, 'dark');
    store.external('dark'); controller.restore(); controller.restore();
    assert.equal(controller.getMode(), selected);
    store[operation] = original;
    controller.setMode(selected); // A successful persistence operation clears the session-only latch.
    store.external(selected === 'light' ? 'dark' : 'light'); controller.restore();
    assert.equal(controller.getMode(), selected === 'light' ? 'dark' : 'light');
  });
}

test('null storage remains functional and retains local choices through restore', () => {
  const changes = [], controller = createController(null, mode => changes.push(mode));
  assert.equal(controller.getMode(), 'system');
  assert.deepEqual(changes, ['system']);
  for (const mode of MODES) {
    controller.setMode(mode); controller.restore();
    assert.equal(controller.getMode(), mode); assert.equal(changes.at(-1), mode);
  }
});
