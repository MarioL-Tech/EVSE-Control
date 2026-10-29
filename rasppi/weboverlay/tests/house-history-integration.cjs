'use strict';

// Container-only test against a disposable, already HOUSE-migrated fixture.
// Required: HOUSE_TEST_ISOLATED=1, HOUSE_TEST_DB=evse_house_test[_suffix],
// HOUSE_TEST_ADMIN_FILE (MariaDB CLI defaults file), HOUSE_TEST_READER_FILE,
// HISTORY_DB_PORT (loopback TCP), HISTORY_DB_USERNAME, HISTORY_DB_PASSWORD_FILE.
// Admin/reader defaults files must target the SAME disposable server/database.
// Reader: SELECT only on the five HOUSE tables; no Wallbox tables are needed.
// HOUSE_TEST_EMPTY_DB=evse_house_test_empty[_suffix] must exist, have no HOUSE
// tables, and allow the same reader to SELECT (schema-wide grant for this fixture).
// The exact storage migration must be mounted read-only at /fixtures/003_house.sql.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

assert.equal(process.env.HOUSE_TEST_ISOLATED, '1', 'Disposable-fixture acknowledgement required');
const database = process.env.HOUSE_TEST_DB || '';
assert.match(database, /^evse_house_test(?:_[a-z0-9_]+)?$/);
for (const key of ['HOUSE_TEST_ADMIN_FILE', 'HOUSE_TEST_READER_FILE', 'HISTORY_DB_PASSWORD_FILE', 'HISTORY_DB_USERNAME']) {
  assert.ok(process.env[key], 'Missing isolated fixture setting');
}
assert.match(process.env.HISTORY_DB_PORT || '', /^[0-9]{1,5}$/);
// Refuse defaults targeting a remote host. Neither deployment URLs nor secrets are logged.
for (const key of ['HOUSE_TEST_ADMIN_FILE', 'HOUSE_TEST_READER_FILE']) {
  const defaults = fs.readFileSync(process.env[key], 'utf8');
  assert.ok(/^host\s*=\s*127\.0\.0\.1\s*$/m.test(defaults), 'CLI fixture must be loopback');
  assert.ok(!/^\s*!include/m.test(defaults), 'No external defaults');
}
const root = path.resolve(__dirname, '..');
const prefix = `test/house/${crypto.randomUUID()}`;
const epoch = crypto.randomBytes(16).toString('hex');
const schemaChecksum = 'db10ad75e9947799db2a896f3211c2c3ba6f64afa75219620630dcbb8a139391';
assert.equal(crypto.createHash('sha256').update(fs.readFileSync('/fixtures/003_house.sql')).digest('hex'), schemaChecksum,
  'Mounted HOUSE migration must match the PHP registry pin');
const children = new Set();
let web, port, checks = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchdog = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); process.exit(1); }, 90000);

function child(command, args, options = {}) {
  const process = spawn(command, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], ...options });
  children.add(process);
  process.stderr.resume(); // Never print DB/server diagnostics or credentials.
  process.once('close', () => children.delete(process));
  return process;
}
async function sql(statement, reader = false, success = true) {
  const p = child('/usr/bin/mariadb', [`--defaults-file=${process.env[reader ? 'HOUSE_TEST_READER_FILE' : 'HOUSE_TEST_ADMIN_FILE']}`,
    '--batch', '--skip-column-names', database]);
  p.stdout.resume(); p.stdin.on('error', () => {}); p.stdin.end(statement);
  const code = await new Promise(resolve => { p.once('error', () => resolve(-1)); p.once('close', resolve); });
  assert.equal(code === 0, success, 'Isolated SQL fixture outcome');
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
function requestPath(requestPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method, agent: false }, res => {
      let body = '';
      res.on('data', data => { body += data; if (Buffer.byteLength(body) > 2097152) res.destroy(); });
      res.on('error', reject);
      res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject); req.setTimeout(4000, () => req.destroy(new Error('Fixture HTTP deadline'))); req.end();
  });
}
function request(query = 'minutes=15', method = 'GET') {
  return requestPath(`/api/house-history?${query}`, method);
}
async function stopWeb() {
  if (!web) return;
  const p = web; web = null;
  const ended = new Promise(resolve => p.once('close', resolve));
  p.kill('SIGTERM'); await Promise.race([ended, sleep(400)]);
  if (children.has(p)) p.kill('SIGKILL');
}
async function startWeb(enabled, overrides = {}) {
  await stopWeb(); port = await freePort();
  web = child('php', ['-S', `127.0.0.1:${port}`, 'public/index.php'], { env: { ...process.env,
    WEB_HOUSE_HISTORY_ENABLED: enabled, WEB_HISTORY_ENABLED: '0', HOUSE_MQTT_TOPIC_PREFIX: prefix,
    HISTORY_DB_HOST: '127.0.0.1', HISTORY_DB_NAME: database, ...overrides } });
  web.stdout.resume(); web.stdin.end();
  for (let i = 0; i < 80; ++i) {
    try { await request(); return; } catch { await sleep(25); }
  }
  throw new Error('Fixture readiness deadline');
}
function body(response, code = 200, status = 'ok') {
  assert.equal(response.code, code); assert.equal(response.headers['cache-control'], 'no-store');
  const result = JSON.parse(response.body);
  assert.equal(result.status, status); assert.equal(result.read_only, true);
  assert.doesNotMatch(response.body, /SQLSTATE|mysql:|password|SELECT |http:\/\/|https:\/\//i);
  ++checks; return result;
}
async function simultaneousScenario(firstKind, firstAvailability, secondKind, secondAvailability) {
  const source = `test/house/${crypto.randomUUID()}`;
  const publisher = crypto.randomBytes(16).toString('hex');
  const availability = value => value === null ? 'NULL' : `'${value}'`;
  await sql(`SET @house_now=UTC_TIMESTAMP(6);
    INSERT INTO evse_house_events(source,event_id,kind,received_at,retained,availability,details) VALUES
      ('${source}',UNHEX(REPLACE(UUID(),'-','')),'availability',@house_now-INTERVAL 20 SECOND,0,'online','{}'),
      ('${source}',UNHEX(REPLACE(UUID(),'-','')),'${firstKind}',@house_now-INTERVAL 10 SECOND,0,${availability(firstAvailability)},'{}'),
      ('${source}',UNHEX(REPLACE(UUID(),'-','')),'${secondKind}',@house_now-INTERVAL 10 SECOND,0,${availability(secondAvailability)},'{}'),
      ('${source}',UNHEX(REPLACE(UUID(),'-','')),'availability',@house_now-INTERVAL 4 SECOND,0,'online','{}');
    INSERT INTO evse_house_samples(source,publisher_id,sequence,fetched_at,received_at,status,last_success_at,power_w,error_code,retained,digest) VALUES
      ('${source}',UNHEX('${publisher}'),1,@house_now-INTERVAL 12 SECOND,@house_now-INTERVAL 12 SECOND,'ok',@house_now-INTERVAL 12 SECOND,1,NULL,0,UNHEX(SHA2('s1',256))),
      ('${source}',UNHEX('${publisher}'),2,@house_now-INTERVAL 8 SECOND,@house_now-INTERVAL 8 SECOND,'ok',@house_now-INTERVAL 8 SECOND,2,NULL,0,UNHEX(SHA2('s2',256))),
      ('${source}',UNHEX('${publisher}'),3,@house_now-INTERVAL 6 SECOND,@house_now-INTERVAL 6 SECOND,'ok',@house_now-INTERVAL 6 SECOND,3,NULL,0,UNHEX(SHA2('s3',256))),
      ('${source}',UNHEX('${publisher}'),4,@house_now-INTERVAL 2 SECOND,@house_now-INTERVAL 2 SECOND,'ok',@house_now-INTERVAL 2 SECOND,4,NULL,0,UNHEX(SHA2('s4',256))),
      ('${source}',UNHEX('${publisher}'),5,@house_now-INTERVAL 1 SECOND,@house_now-INTERVAL 1 SECOND,'ok',@house_now-INTERVAL 1 SECOND,5,NULL,0,UNHEX(SHA2('s5',256)));`);
  await startWeb('1', { HOUSE_MQTT_TOPIC_PREFIX: source });
  const result = body(await request());
  assert.deepEqual(result.samples.map(sample => sample.break_before), [true, true, true, true, false]);
  ++checks;
}

(async () => {
  try {
    await startWeb('0', { HISTORY_DB_PASSWORD_FILE: '/not-readable' });
    body(await request(), 200, 'disabled');
    body(await request('period=year&date=2024&tz=Europe%2FVienna'), 200, 'disabled');
    assert.equal((await request('minutes=15', 'HEAD')).body, ''); ++checks;
    assert.equal((await request('minutes=15', 'POST')).code, 405); ++checks;
    for (const query of ['minutes=2', 'minutes=1&minutes=5', 'period=day&date=2026-02-30', 'minutes=15&url=x',
      'period=year&date=9998', 'period=hour&at=9998-01-01T00:00:00Z',
      'period=custom&from=9997-01-01T00:00:00Z&to=9998-01-01T00:00:00Z']) {
      assert.equal((await request(query)).code, 400); ++checks;
    }
    const asset = await requestPath('/static/house-history.js');
    assert.equal(asset.code, 200); assert.match(asset.headers['content-type'] || '', /^text\/javascript/);
    assert.ok(asset.body.length > 0); ++checks;
    assert.equal((await requestPath('/static/haus-history.js')).code, 404); ++checks;
    // Fixture deliberately has no evse_schema_versions: HOUSE must still work.
    await sql('SELECT version FROM evse_schema_versions;', true, false);
    await sql(`SELECT version, checksum, applied_at FROM evse_house_schema_versions;`, true);
    await sql(`INSERT INTO evse_house_events(source,event_id,kind,received_at,retained,availability,details)
      VALUES ('${prefix}',UNHEX(REPLACE(UUID(),'-','')),'availability',UTC_TIMESTAMP(6)-INTERVAL 20 MINUTE,0,'online','{}');
      INSERT INTO evse_house_samples(source,publisher_id,sequence,fetched_at,received_at,status,last_success_at,power_w,error_code,retained,digest)
      VALUES ('${prefix}',UNHEX('${epoch}'),1,UTC_TIMESTAMP(6)-INTERVAL 8 SECOND,UTC_TIMESTAMP(6)-INTERVAL 8 SECOND,'ok',UTC_TIMESTAMP(6)-INTERVAL 8 SECOND,-800.5,NULL,0,UNHEX(SHA2('one',256))),
      ('${prefix}',UNHEX('${epoch}'),2,UTC_TIMESTAMP(6)-INTERVAL 6 SECOND,UTC_TIMESTAMP(6)-INTERVAL 6 SECOND,'ok',UTC_TIMESTAMP(6)-INTERVAL 6 SECOND,0,NULL,0,UNHEX(SHA2('two',256))),
      ('${prefix}',UNHEX('${epoch}'),3,UTC_TIMESTAMP(6)-INTERVAL 4 SECOND,UTC_TIMESTAMP(6)-INTERVAL 4 SECOND,'error',NULL,NULL,'read_failed',0,UNHEX(SHA2('three',256)));`);
    for (const statement of [
      `INSERT INTO evse_house_schema_versions(version,checksum,applied_at) VALUES (99,'reader-write-must-fail',UTC_TIMESTAMP(6));`,
      'UPDATE evse_house_samples SET retained=retained WHERE id=0;',
      'DELETE FROM evse_house_events WHERE id=0;',
      `INSERT INTO evse_house_work(source,level,bucket_start,generation,processed_generation,pending) VALUES ('${prefix}','minute','2026-01-01',1,0,1);`,
      'CREATE TABLE forbidden_house_write (id INT);',
    ]) await sql(statement, true, false);
    // A random 32-byte value is not the storage migration identity.
    await sql(`UPDATE evse_house_schema_versions SET checksum=UNHEX('${'00'.repeat(32)}') WHERE version=1;`);
    await startWeb('1');
    body(await request(), 503, 'unavailable');
    await sql(`UPDATE evse_house_schema_versions SET checksum=UNHEX('${schemaChecksum}') WHERE version=1;`);
    await startWeb('1');
    const raw = body(await request());
    assert.equal(raw.schema_version, 1); assert.equal(raw.samples.length, 3);
    assert.deepEqual(Object.keys(raw), ['schema_version','read_only','status','reason','generated_at','minutes','range','complete','samples']);
    assert.deepEqual(Object.keys(raw.samples[0]), ['id','timestamp','received_at','status','power_w','break_before']);
    assert.deepEqual(raw.samples.map(s => s.power_w), [-800.5, 0, null]);
    assert.ok(raw.samples.every(s => typeof s.id === 'string'));
    assert.equal(raw.samples[1].break_before, false); assert.equal(raw.samples[2].break_before, true); ++checks;
    assert.equal((await request('minutes=15', 'HEAD')).body, ''); ++checks;
    await simultaneousScenario('availability', 'online', 'availability', 'offline');
    await simultaneousScenario('availability', 'offline', 'availability', 'online');
    await simultaneousScenario('broker_connected', null, 'ingestion_gap', null);
    await startWeb('1');
    const spring = body(await request('period=day&date=2026-03-29&tz=Europe%2FVienna'));
    assert.equal((Date.parse(spring.range.to)-Date.parse(spring.range.from))/3600000, 23);
    const fall = body(await request('period=day&date=2026-10-25&tz=Europe%2FVienna'));
    assert.equal((Date.parse(fall.range.to)-Date.parse(fall.range.from))/3600000, 25);
    assert.ok(fall.buckets.every(b => !b.complete && b.metrics.power_w.mean === null)); ++checks;
    // A full leap year of materialized hours, not millions of raw rows.
    await sql(`INSERT INTO evse_house_buckets(source,level,bucket_start,bucket_end,samples,valid_count,null_count,sum_w,min_w,max_w,first_w,last_w,first_at,last_at,coverage_ms,has_gap,complete)
      SELECT '${prefix}','hour',DATE_ADD('2024-01-01 00:00:00', INTERVAL seq HOUR),DATE_ADD('2024-01-01 00:00:00', INTERVAL seq+1 HOUR),
      2,2,0,-4,-2,-2,-2,-2,DATE_ADD('2024-01-01 00:00:00', INTERVAL seq HOUR),DATE_ADD('2024-01-01 00:00:00', INTERVAL seq HOUR),0,1,1 FROM seq_0_to_8783;`);
    const year = body(await request('period=year&date=2024&tz=UTC'));
    assert.equal(year.schema_version, 2); assert.equal(year.buckets.length, 53); assert.equal(year.complete, true);
    assert.deepEqual(Object.keys(year), ['schema_version','read_only','status','reason','generated_at','range','selection','navigation','aggregation','complete','progress','buckets']);
    assert.deepEqual(Object.keys(year.buckets[0]), ['from','to','samples','has_gap','complete','coverage_seconds','metrics']);
    assert.deepEqual(Object.keys(year.buckets[0].metrics.power_w), ['count','nulls','mean','min','max','last','mixed']);
    assert.ok(year.buckets.every(b => Object.keys(b.metrics).join() === 'power_w' && b.metrics.power_w.mean === -2 && b.has_gap)); ++checks;
    await sql(`INSERT INTO evse_house_work(source,level,bucket_start,generation,processed_generation,pending)
      VALUES ('${prefix}','minute','2024-01-01 00:00:00',1,0,1);`);
    const pending = body(await request('period=year&date=2024&tz=UTC'));
    assert.equal(pending.complete, false); assert.equal(pending.buckets[0].metrics.power_w.mean, null);
    assert.equal(pending.buckets[1].metrics.power_w.mean, -2); ++checks;
    await startWeb('1', { HISTORY_DB_PASSWORD_FILE: '/not-readable' });
    body(await request(), 503, 'unavailable');
    body(await request('period=year&date=2024&tz=UTC'), 503, 'unavailable');
    // Point at a separate empty schema provisioned by the fixture: no HOUSE registry.
    assert.match(process.env.HOUSE_TEST_EMPTY_DB || '', /^evse_house_test_empty(?:_[a-z0-9_]+)?$/);
    await startWeb('1', { HISTORY_DB_NAME: process.env.HOUSE_TEST_EMPTY_DB });
    body(await request(), 503, 'unavailable');
    await startWeb('0', { HISTORY_DB_NAME: process.env.HOUSE_TEST_EMPTY_DB });
    body(await request(), 200, 'disabled');
    console.log(`House history integration: ${checks} checks passed`);
  } finally {
    await stopWeb(); for (const p of children) p.kill('SIGKILL'); clearTimeout(watchdog);
  }
})().catch(() => { console.error('House history integration failed (diagnostics withheld).'); process.exitCode = 1; });
