'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { number, parseResponse, validConfig } = require('../static/charging-settings.js');
test('Optional profile values have no invented defaults and A convert to mA', () => {
  assert.equal(number(''), null); assert.equal(number('', true), null);
  assert.equal(number('6', true), 6000); assert.equal(number('12.345', true), 12345);
  assert.equal(number('0'), 0); assert.equal(number('123'), 123);
  for (const v of ['-1', '1e3', 'NaN', '6.0001', ' ', '0.2']) assert.throws(() => number(v));
});
test('Incomplete or unexpected server fields must never become blank saved values', () => {
  const p = { max_import_w: 0, max_current_ma: null, adjust_seconds: 3, pause_seconds: 0, resume_seconds: 4 };
  const blank = () => ({ schema_version: 1, timezone: 'Europe/Vienna', installation: { phases: null, meter_includes_wallbox: false }, manual: { current_ma: null },
    pv: { ...p }, custom: { ...p, weekdays: [1], windows: [{ from: '23:00', to: '01:00' }], pv_enabled: null, use_schedule: null, outside_window: null } });
  assert.equal(validConfig(blank()), true); const old = blank(); delete old.installation; assert.equal(validConfig(old), true);
  for (const mutate of [v => delete v.pv.adjust_seconds, v => { v.installation = null; }, v => { v.installation.phases = 0; },
    v => { v.custom.pv_enabled = 'false'; }, v => { v.manual.current_ma = 32; }, v => { v.custom.windows.push(v.custom.windows[0]); },
    v => { v.custom.weekdays = [null]; }, v => { v.custom.behavior = 'unknown'; }]) {
    const v = blank(); mutate(v); assert.equal(validConfig(v), false);
  }
});
test('Configuration response never advertises active automation', () => {
  assert.equal(parseResponse({ schema_version: 1, status: 'disabled', automation_available: false }).status, 'disabled');
  for (const body of [null, {}, { schema_version: 1, status: 'ok', automation_available: true },
    { schema_version: 1, status: 'ok', automation_available: false, csrf: 'bad' }]) assert.throws(() => parseResponse(body));
});
