'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bounds, draftAmps, commandBody, parseResponse, stepText, resultText, GET_TIMEOUT_MS, POST_TIMEOUT_MS, REFRESH_MS } = require('../static/wallbox-control.js');
const inspection = (extra = {}) => ({ schema_version: 1, status: 'ok', minimum_ma: 6000, software_max_ma: 32000,
  hardware_max_ma: 22000, installation_max_ma: 13700, effective_max_ma: 13700, firmware_raw: 123, write: null, preparation: null, ...extra });
const envelope = (extra = {}) => ({ status: 'ok', csrf: 'test-csrf', inspection: inspection(), command: null, command_sent: false, ...extra });
const ack = { status: 'acknowledged', attempted: true, acknowledged: true };
test('API parser preserves nullable maxima and separate steps', () => {
  const body = envelope({ inspection: inspection({ installation_max_ma: null, effective_max_ma: null }) });
  assert.equal(parseResponse(body), body);
  assert.equal(parseResponse(envelope({ status: 'unavailable', csrf: null, inspection: null })).inspection, null);
  const command = inspection({ operation: 'start', write: null, preparation: ack });
  assert.equal(parseResponse(envelope({ command, command_sent: true })).command.preparation, ack);
  for (const bad of [null, {}, envelope({ command_sent: 'true' }), envelope({ csrf: '' }), envelope({ status: 'anything' }),
    envelope({ inspection: inspection({ hardware_max_ma: '16000' }) }), envelope({ command: inspection({ write: {} }) })]) assert.throws(() => parseResponse(bad));
});
test('HTTP error envelope vocabulary distinguishes no publish from unknown outcome', () => {
  // HTTP codes describe the fixtures; this pure test does not perform HTTP I/O.
  for (const [httpCode, status, commandSent] of [[403, 'forbidden', false], [400, 'invalid', false],
    [503, 'unavailable', false], [504, 'outcome_unknown', true]]) {
    const body = envelope({ status, csrf: null, inspection: null, command: null, command_sent: commandSent });
    const parsed = parseResponse(body);
    assert.equal(parsed.command_sent, commandSent, `HTTP ${httpCode}`);
    if (commandSent) {
      assert.match(resultText(parsed), /Ausgang unbekannt.*nicht automatisch wiederholt/, `HTTP ${httpCode}`);
      assert.doesNotMatch(resultText(parsed), /Kein Schreibauftrag versendet/);
    } else {
      assert.match(resultText(parsed), /Kein Schreibauftrag versendet/, `HTTP ${httpCode}`);
      assert.doesNotMatch(resultText(parsed), /Ausgang unbekannt/, `HTTP ${httpCode}`);
    }
  }
});
test('Bounds take minimum of hardware, installation and software, then floor slider', () => {
  assert.deepEqual(bounds(inspection()), { min: 6, max: 13, effective_ma: 13700 });
  assert.equal(bounds(inspection({ hardware_max_ma: 10000, effective_max_ma: 10000 })).max, 10);
  assert.equal(bounds(inspection({ hardware_max_ma: 32000, installation_max_ma: 32000, effective_max_ma: 32000 })).max, 32);
  // The conservative backend rejects hardware maxima above 32 A; it does not
  // return an invented capped effective maximum for that unavailable result.
  const unavailable = envelope({ status: 'unavailable', inspection: inspection({ status: 'unavailable',
    hardware_max_ma: 64000, installation_max_ma: 32000, effective_max_ma: null }) });
  assert.equal(bounds(parseResponse(unavailable).inspection), null);
  for (const overrides of [{ installation_max_ma: null }, { hardware_max_ma: null }, { effective_max_ma: null },
    { hardware_max_ma: 5999 }, { installation_max_ma: 32001 }, { effective_max_ma: 16000 }, { minimum_ma: 0 }, { software_max_ma: 64000 }]) assert.equal(bounds(inspection(overrides)), null);
  assert.equal(bounds(null), null);
});
test('Drafts do not create commands, commands only have operation/current_ma', () => {
  const limits = bounds(inspection());
  assert.equal(draftAmps(6, limits), 6);
  for (const value of [5, 14, 6.5, NaN, '6', null]) assert.equal(draftAmps(value, limits), null);
  assert.equal(draftAmps(6, null), null);
  assert.deepEqual(commandBody('start', 13, limits), { operation: 'start', current_ma: 13000 });
  assert.deepEqual(commandBody('set_current', 6, limits), { operation: 'set_current', current_ma: 6000 });
  assert.deepEqual(commandBody('stop', null, null), { operation: 'stop', current_ma: 0 });
  assert.equal(commandBody('start', 16, limits), null);
  assert.equal(commandBody('start', 6, null), null);
  assert.equal(commandBody('inspect', 6, limits), null);
});
test('Partial Start never claims charging or a Start ACK', () => {
  const body = envelope({ command_sent: true, command: inspection({ operation: 'start', preparation: ack, write: null }) });
  assert.match(resultText(body), /Stromvorbereitung: Protokoll-ACK/);
  assert.match(resultText(body), /Start: Nicht gesendet/);
  assert.match(stepText(ack), /keine Ladebestätigung/);
  assert.match(stepText({ status: 'rejected_by_device', attempted: true, acknowledged: false }), /abgelehnt/);
});
test('Unknown outcomes and no publish remain distinct', () => {
  assert.match(resultText(envelope({ status: 'outcome_unknown', command_sent: true })), /unbekannt.*nicht automatisch wiederholt/);
  assert.match(resultText(envelope()), /Kein Schreibauftrag versendet/);
  assert.match(resultText(envelope({ command_sent: true })), /versendet, Ergebnis unbekannt/);
  assert.match(stepText({ status: 'outcome_unknown', attempted: true, acknowledged: false }), /nicht automatisch wiederholt/);
  assert.equal(GET_TIMEOUT_MS, 12000); assert.equal(POST_TIMEOUT_MS, 15000); assert.equal(REFRESH_MS, 15000);
});
