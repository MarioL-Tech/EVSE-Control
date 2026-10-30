'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { number, parseResponse } = require('../static/charging-settings.js');
test('Optional profile values have no invented defaults and A convert to mA', () => {
  assert.equal(number(''), null); assert.equal(number('', true), null);
  assert.equal(number('6', true), 6000); assert.equal(number('12.345', true), 12345);
  assert.equal(number('0'), 0); assert.equal(number('123'), 123);
  for (const v of ['-1', '1e3', 'NaN', '6.0001', ' ', '0.2']) assert.throws(() => number(v));
});
test('Configuration response never advertises active automation', () => {
  assert.equal(parseResponse({ schema_version: 1, status: 'disabled', automation_available: false }).status, 'disabled');
  for (const body of [null, {}, { schema_version: 1, status: 'ok', automation_available: true },
    { schema_version: 1, status: 'ok', automation_available: false, csrf: 'bad' }]) assert.throws(() => parseResponse(body));
});
