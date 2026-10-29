'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseResponse, createDraft, editDraft, changesFor } = require('../static/env-settings.js');

function response() {
  const definition = (secret = false, readonly = false) => ({ type: 'text', min: 0, max: 4096, secret, readonly, choices: [] });
  return { status: 'ok', csrf: 'test-token', services: { uart: {}, wallbox: {}, storage: {},
    weboverlay: { TEXT: definition(), SECRET: definition(true), MOUNT: definition(true, true) } },
  snapshot: { status: 'ok', service: 'weboverlay', revision: 'a'.repeat(64), entries: {
    TEXT: { present: true, configured: true, readonly: false, secret: false, value: 'before' },
    SECRET: { present: true, configured: true, readonly: false, secret: true },
    MOUNT: { present: true, configured: true, readonly: true, secret: true }
  } } };
}
test('only explicitly changed fields; reverting a normal field removes dirty state', () => {
  const draft = createDraft(parseResponse(response(), 'weboverlay').snapshot);
  assert.deepEqual(changesFor(draft), {});
  editDraft(draft, 'TEXT', 'after');
  assert.deepEqual(changesFor(draft), { TEXT: 'after' });
  editDraft(draft, 'TEXT', 'before');
  assert.deepEqual(changesFor(draft), {});
  editDraft(draft, 'TEXT', '');
  assert.deepEqual(changesFor(draft), { TEXT: '' });
});
test('empty secrets preserve values; only explicit clear submits empty string', () => {
  const draft = createDraft(response().snapshot);
  editDraft(draft, 'SECRET', '');
  assert.deepEqual(changesFor(draft), {});
  editDraft(draft, 'SECRET', 'replacement');
  assert.deepEqual(changesFor(draft), { SECRET: 'replacement' });
  editDraft(draft, 'SECRET', '');
  assert.deepEqual(changesFor(draft), {});
  editDraft(draft, 'SECRET', '', true);
  assert.deepEqual(changesFor(draft), { SECRET: '' });
  editDraft(draft, 'SECRET', '', false);
  assert.deepEqual(changesFor(draft), {});
});
test('readonly and unknown fields are never submitted', () => {
  const draft = createDraft(response().snapshot);
  editDraft(draft, 'MOUNT', 'replacement'); editDraft(draft, 'UNKNOWN', 'x');
  assert.deepEqual(changesFor(draft), {});
});
test('disabled catalog is available without snapshot or CSRF', () => {
  const body = response(); delete body.snapshot; delete body.csrf; body.status = 'disabled';
  const parsed = parseResponse(body, 'weboverlay');
  assert.equal(parsed.status, 'disabled');
  assert.equal(parsed.services.weboverlay.SECRET.secret, true);
  assert.equal(parsed.snapshot, undefined);
});
test('reject invalid status and HTTP errors even with apparently valid data', () => {
  for (const status of ['unavailable', 'unexpected', null, 'missing']) {
    assert.throws(() => parseResponse({ ...response(), status }, 'weboverlay'), /invalid_status/);
  }
  assert.throws(() => parseResponse(response(), 'weboverlay', false), /http_error/);
  assert.throws(() => parseResponse({ status: 'conflict' }, 'weboverlay', false), /conflict/);
  assert.throws(() => parseResponse(null, 'weboverlay'), /invalid_response/);
});
test('snapshot must match service, revision, flags and CSRF; secret values are discarded', () => {
  for (const mutate of [body => { body.snapshot.service = 'uart'; },
    body => { body.snapshot.revision = null; }, body => { delete body.csrf; },
    body => { body.snapshot.entries.MOUNT.readonly = false; }]) {
    const body = response(); mutate(body);
    assert.throws(() => parseResponse(body, 'weboverlay'), /invalid_response/);
  }
  const body = response(); body.snapshot.entries.SECRET.value = 'must-not-reach-ui';
  assert.equal(ownValue(parseResponse(body, 'weboverlay').snapshot.entries.SECRET), false);
});
function ownValue(entry) { return Object.prototype.hasOwnProperty.call(entry, 'value'); }
test('missing files preserve absent state; edits do not invent defaults', () => {
  const body = response(); body.snapshot.status = 'missing'; body.snapshot.revision = null;
  body.snapshot.entries.TEXT = { present: false, configured: false, readonly: false, secret: false, value: null };
  const draft = createDraft(parseResponse(body, 'weboverlay').snapshot);
  assert.deepEqual(changesFor(draft), {});
  editDraft(draft, 'TEXT', '');
  assert.deepEqual(changesFor(draft), { TEXT: '' });
});
test('POST response may reuse catalog, but errors do not alter pending changes', () => {
  const body = response(); const draft = createDraft(body.snapshot);
  editDraft(draft, 'TEXT', 'pending');
  const services = body.services; delete body.services;
  assert.equal(parseResponse(body, 'weboverlay', true, services).status, 'ok');
  assert.throws(() => parseResponse({ status: 'unavailable' }, 'weboverlay', false), /http_error/);
  assert.deepEqual(changesFor(draft), { TEXT: 'pending' });
});
