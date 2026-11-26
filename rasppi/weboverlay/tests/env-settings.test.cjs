'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseResponse, createDraft, editDraft, changesFor, problemFor, placeholder, presentation, relatedProblems } = require('../static/env-settings.js');

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
test('related checks use only known values, never invent missing device config', () => {
  const draft = createDraft({ service: 'wallbox', entries: { WALLBOX_TIMEOUT_MS: { value: '500' }, WALLBOX_INTERVAL_MS: { value: null } } });
  editDraft(draft, 'WALLBOX_TIMEOUT_MS', '1000'); assert.deepEqual(Object.keys(relatedProblems(draft)), []);
  editDraft(draft, 'WALLBOX_INTERVAL_MS', '1000'); assert.equal(Object.keys(relatedProblems(draft)).length, 2);
  editDraft(draft, 'WALLBOX_INTERVAL_MS', '1001'); assert.deepEqual(Object.keys(relatedProblems(draft)), []);
  const storage = createDraft({ service: 'storage', entries: { STORAGE_RETENTION_MINUTE_DAYS: {value:'0'}, STORAGE_RETENTION_HOUR_DAYS: {value:'0'} } });
  editDraft(storage, 'STORAGE_RETENTION_HOUR_DAYS', '30'); assert.deepEqual(Object.keys(relatedProblems(storage)), ['STORAGE_RETENTION_HOUR_DAYS']);
});
test('UI checks new edits without echoing submitted strings, placeholders are not values', () => {
  const def = { type: 'integer', min: 10, max: 20 };
  assert.match(placeholder(def), /z\. B\./); assert.equal(problemFor(def, '10'), '');
  for (const v of ['', '1e1', '21', '10.5', ' 11']) assert.match(problemFor(def, v), /Ganze Zahl/);
  for (const [type, good, bad] of [['url', 'https://beispiel.example/test', 'https://user@beispiel.example/test'],
    ['host', 'broker-a.example', '-.example'], ['host', '192.0.2.12', '300.0.2.1'], ['topic', 'bereich/rolle', 'bereich/+'],
    ['device', '/dev/geraet', '/dev/../etc'], ['identifier', 'dienst-a', 'dienst a'], ['database', 'Archiv1', '1Archiv'],
    ['network', 'daten.test', '.daten'], ['text', 'Beispiel', 'a$b'], ['enum', 'true', 'unknown']]) {
    const d = { type, min: 0, max: 100, choices: ['true'] }; assert.equal(problemFor(d, good), '', type);
    const message = problemFor(d, bad); assert(message); assert(!message.includes(bad));
  }
  assert.equal(problemFor({ type: 'url', secret: true }, ''), '');
  assert.match(presentation('STORAGE_RETENTION_DAY_DAYS', def).title, /Tagesdaten/);
});
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
