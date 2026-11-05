// API smoke test against a temporary database. Run: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'magetsi-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.ADMIN_TOKEN = 'test-token';
process.env.SEED_DEMO = '1'; // schedule and stats tests need the demo data
const { server, db, topUpDemo } = require('../server.js');

let base;
server.keepAliveTimeout = 60_000; // the demo top-up test blocks for a few seconds
test.before(() => new Promise((r) => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => { server.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const get = (p) => fetch(base + p).then(async (r) => ({ status: r.status, body: await r.json() }));
const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

const device = 'test-device-0001';

test('a demo server says so, and its CSV export is labelled', async () => {
  assert.equal((await get('/api/health')).body.demo, true);
  assert.equal((await get('/api/dashboard?days=7')).body.demo, true);
  const csv = await fetch(base + '/api/dashboard.csv?days=7').then((r) => r.text());
  assert.match(csv.split('\r\n')[0], /^# DEMO DATA/);
});

test('demo data tops up without duplicates', () => {
  const count = (sql) => db.prepare(sql).get().n;
  const slots0 = count("SELECT COUNT(*) n FROM slots WHERE source = 'demo-rotation'");
  const reports0 = count("SELECT COUNT(*) n FROM outages WHERE device_id LIKE 'seed-%'");
  topUpDemo(); // nothing new has happened
  assert.equal(count("SELECT COUNT(*) n FROM outages WHERE device_id LIKE 'seed-%'"), reports0);
  for (const hours of [3, 27, 51]) topUpDemo(Date.now() + hours * 3600_000); // the demo keeps running for two days
  assert.ok(count("SELECT COUNT(*) n FROM slots WHERE source = 'demo-rotation'") > slots0, 'schedule extended');
  assert.ok(count("SELECT COUNT(*) n FROM outages WHERE device_id LIKE 'seed-%'") > reports0, 'new reports added');
  assert.equal(count("SELECT COUNT(*) n FROM (SELECT device_id, off_at FROM outages WHERE device_id LIKE 'seed-%' GROUP BY 1, 2 HAVING COUNT(*) > 1)"), 0);
});

test('areas are seeded', async () => {
  const r = await get('/api/areas');
  assert.equal(r.status, 200);
  assert.ok(r.body.areas.length >= 20);
});

test('schedule and stats for an area', async () => {
  const s = await get('/api/schedule?area=7&days=7');
  assert.equal(s.status, 200);
  assert.ok(s.body.slots.length > 0);
  const st = await get('/api/stats?area=7');
  assert.equal(st.body.stats.enough, true);
});

test('off -> duplicate off -> on', async () => {
  const a = await post('/api/outages/off', { area: 7, device });
  assert.equal(a.status, 201);
  const b = await post('/api/outages/off', { area: 7, device });
  assert.equal(b.body.duplicate, true);
  const s = await get(`/api/status?area=7&device=${device}`);
  assert.ok(s.body.status.myOpenOutage);
  const c = await post('/api/outages/on', { area: 7, device });
  assert.equal(c.status, 200);
  const d = await post('/api/outages/on', { area: 7, device });
  assert.equal(d.status, 409);
});

test('manual outage validation on the server', async () => {
  const now = Date.now();
  const ok = await post('/api/outages', { area: 7, device, off_at: now - 3 * 3600e3, on_at: now - 3600e3 });
  assert.equal(ok.status, 201);
  const bad = await post('/api/outages', { area: 7, device, off_at: now - 3600e3, on_at: now - 3 * 3600e3 });
  assert.equal(bad.status, 400);
});

test('admin import needs the token and saves slots', async () => {
  const csv = 'group,date,start,end\nLSK-B,2030-01-01,06:00,10:00';
  assert.equal((await post('/api/admin/slots', { csv }, { 'X-Admin-Token': 'nope' })).status, 401);
  const r = await post('/api/admin/slots', { csv, replace: true }, { 'X-Admin-Token': 'test-token' });
  assert.equal(r.body.saved, 1);
});

test('rate limit kicks in after 20 writes an hour', async () => {
  const dev = 'rate-limit-device';
  let last;
  for (let i = 0; i < 22; i++) last = await post('/api/outages/on', { area: 1, device: dev });
  assert.equal(last.status, 429);
});
