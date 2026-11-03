// Web Push, SMS and dashboard against a temporary database and a fake push service. Run: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'magetsi-alerts-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.ADMIN_TOKEN = 'test-token';
process.env.PUSH_ALLOW_ANY_ENDPOINT = '1'; // the fake push service is plain http on localhost
delete process.env.AT_API_KEY; // SMS in log mode: messages land in sms_outbox
const C = require('../public/core.js');
const { server, db, runAlerts } = require('../server.js');

// fake push service: records requests, answers with `pushStatus`
const received = [];
let pushStatus = 201;
const pushSvc = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => { received.push({ headers: req.headers, body: Buffer.concat(chunks), url: req.url }); res.writeHead(pushStatus); res.end(); });
});

let base, pushBase;
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));
test.before(async () => { base = await listen(server); pushBase = await listen(pushSvc); });
test.after(() => { server.close(); pushSvc.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const get = (p) => fetch(base + p).then(async (r) => ({ status: r.status, headers: r.headers, text: await r.text() }));
const getJson = async (p) => { const r = await get(p); return { status: r.status, body: JSON.parse(r.text) }; };
const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const form = (p, fields) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const outbox = (phone) => db.prepare('SELECT message, kind FROM sms_outbox WHERE phone = ? ORDER BY id').all(phone);

// A browser's side of push: key pair + auth secret, and decryption.
const ua = crypto.createECDH('prime256v1');
ua.generateKeys();
const auth = crypto.randomBytes(16);
function openPush(body) {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ua.computeSecret(asPublic), auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(-16));
  const plain = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  return JSON.parse(plain.subarray(0, -1).toString());
}

/** First scheduled window for an area that starts between 07:00 and 21:00 Lusaka time, after now. */
async function daytimeWindow(areaId) {
  const { body } = await getJson(`/api/schedule?area=${areaId}&days=7`);
  return C.mergedWindows(body.slots).find((w) => w.startMs > Date.now() && C.lusakaHour(w.startMs) >= 7 && C.lusakaHour(w.startMs) <= 21);
}

const device = 'push-device-0001';

test('push: subscribe validates input', async () => {
  const sub = { endpoint: `${pushBase}/sub/1`, keys: { p256dh: ua.getPublicKey('base64url'), auth: auth.toString('base64url') } };
  assert.equal((await post('/api/push/subscribe', { device, subscription: sub, areas: [9999] })).status, 400);
  assert.equal((await post('/api/push/subscribe', { device, subscription: sub, areas: [1, 2, 3, 4, 5, 6] })).status, 400);
  assert.equal((await post('/api/push/subscribe', { device, subscription: { ...sub, keys: { p256dh: 'abc', auth: 'x' } }, areas: [7] })).status, 400);
  const ok = await post('/api/push/subscribe', { device, subscription: sub, areas: [7, 31], settings: { leadMin: 30, quiet: true, junk: 1 } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.areas, [7, 31]);
  assert.equal(ok.body.settings.junk, undefined);
  const key = await getJson('/api/push/key');
  assert.equal(Buffer.from(key.body.publicKey, 'base64url').length, 65);
});

test('push: the alert loop sends an encrypted reminder once', async () => {
  const w = await daytimeWindow(7);
  assert.ok(w, 'demo schedule has a daytime window');
  received.length = 0;
  const now = w.startMs - 20 * C.MIN;
  await runAlerts(now);
  const off = received.map((r) => ({ r, msg: openPush(r.body) })).find((x) => x.msg.tag === `off-7-${w.startMs}`);
  assert.ok(off, 'reminder for Chilenje was pushed');
  assert.equal(off.msg.title, `Power off at ${C.lusakaTime(w.startMs)} in Chilenje`);
  assert.equal(off.r.headers['content-encoding'], 'aes128gcm');
  assert.match(off.r.headers.authorization, /^vapid t=.+, k=.+$/);
  assert.ok(Number(off.r.headers.ttl) > 0);

  const before = received.length;
  await runAlerts(now + 60 * 1000);
  assert.ok(!received.slice(before).some((r) => openPush(r.body).tag === off.msg.tag), 'not sent twice');
});

test('push: a failed send is retried, a gone subscription is removed', async () => {
  const w = await daytimeWindow(31); // Nkana East, Kitwe
  const now = w.startMs - 25 * C.MIN;
  pushStatus = 500;
  received.length = 0;
  await runAlerts(now);
  assert.ok(received.length >= 1);
  pushStatus = 201;
  received.length = 0;
  await runAlerts(now + 60 * 1000);
  assert.ok(received.some((r) => openPush(r.body).tag === `off-31-${w.startMs}`), 'retried after failure');

  pushStatus = 410;
  assert.equal((await post('/api/push/test', { device })).status, 502);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM push_subs WHERE device_id = ?').get(device).n, 0);
  pushStatus = 201;
});

test('push: endpoints outside browser push services are refused without the test flag', () => {
  const wp = require('../lib/webpush.js');
  assert.equal(wp.validEndpoint(`${pushBase}/x`), false);
});

const phone = '+260971234567';

test('SMS inbound: JOIN, TIMES, STOP, and the webhook key', async () => {
  assert.equal((await form('/api/sms/inbound?key=wrong', { from: phone, text: 'JOIN CHILENJE' })).status, 401);
  const j = await form('/api/sms/inbound?key=test-token', { from: phone, text: 'join chilenje', to: '1234' });
  assert.match(j.body.reply, /alerts for Chilenje, Lusaka \(Group B\)/);
  const t = await form('/api/sms/inbound?key=test-token', { from: phone, text: 'TIMES' });
  assert.match(t.body.reply, /Chilenje/);
  const amb = await form('/api/sms/inbound?key=test-token', { from: '0961111111', text: 'JOIN KAB' });
  assert.match(amb.body.reply, /which area/);
  const msgs = outbox(phone);
  assert.equal(msgs.length, 2);
  assert.ok(msgs.every((m) => m.kind === 'reply'));
});

test('SMS alerts: morning summary goes out once', async () => {
  const tomorrow = C.addDays(C.lusakaDate(Date.now()), 1);
  const now = C.toMs(tomorrow, '05:45');
  const n0 = outbox(phone).length;
  await runAlerts(now);
  await runAlerts(now + 60 * 1000);
  const sent = outbox(phone).slice(n0);
  const daily = sent.filter((m) => /power off today|no load-shedding/.test(m.message));
  assert.equal(daily.length, 1);
  assert.equal(daily[0].kind, 'alert');
  assert.ok(daily[0].message.startsWith('Magetsi: Chilenje'));

  await form('/api/sms/inbound?key=test-token', { from: phone, text: 'STOP' });
  const n1 = outbox(phone).length;
  await runAlerts(C.toMs(C.addDays(tomorrow, 1), '05:45'));
  assert.equal(outbox(phone).length, n1, 'nothing after STOP');
});

test('SMS web sign-up needs the code sent to the phone', async () => {
  const dev = 'sms-device-0001', ph = '0977000111', e164 = '+260977000111';
  assert.equal((await post('/api/sms/start', { device: dev, phone: '12345', area: 7 })).status, 400);
  const s = await post('/api/sms/start', { device: dev, phone: ph, area: 31, daily: true, before: 60 });
  assert.equal(s.status, 200);
  const code = outbox(e164).at(-1).message.match(/code: (\d{6})/)[1];
  assert.equal((await post('/api/sms/verify', { device: 'other-device-01', phone: ph, code })).status, 400);
  assert.equal((await post('/api/sms/verify', { device: dev, phone: ph, code: code === '000000' ? '111111' : '000000' })).status, 400);
  const v = await post('/api/sms/verify', { device: dev, phone: ph, code });
  assert.equal(v.status, 200);
  assert.equal(v.body.before, 60);
  const row = db.prepare('SELECT * FROM sms_subs WHERE phone = ?').get(e164);
  assert.equal(row.active, 1);
  assert.equal(row.area_id, 31);
  assert.equal((await post('/api/sms/stop', { device: 'other-device-01', phone: ph })).status, 403);
  assert.equal((await post('/api/sms/stop', { device: dev, phone: ph })).status, 200);
});

test('SMS codes are rate limited per phone', async () => {
  let last;
  for (let i = 0; i < 4; i++) last = await post('/api/sms/start', { device: `rl-device-000${i}`, phone: '0955000999', area: 1 });
  assert.equal(last.status, 429);
});

test('public dashboard and CSV export', async () => {
  const d = await getJson('/api/dashboard?days=7');
  assert.equal(d.status, 200);
  assert.equal(d.body.rows.length, C.AREAS.length);
  assert.ok(d.body.towns.includes('Kitwe'));
  assert.ok(d.body.rows.some((r) => r.enough && r.onSchedulePct != null));
  const csv = await get('/api/dashboard.csv?days=30');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /magetsi-adherence-.*-30d\.csv/);
  const lines = csv.text.trim().split('\r\n');
  assert.equal(lines.length, C.AREAS.length + 2);
});

test('admin overview needs the token', async () => {
  assert.equal((await getJson('/api/admin/overview')).status, 401);
  const r = await fetch(base + '/api/admin/overview', { headers: { 'X-Admin-Token': 'test-token' } }).then((x) => x.json());
  assert.equal(r.smsDriver, 'log');
  assert.ok(r.outbox.length > 0);
  assert.ok(r.outbox.every((m) => m.phone.includes('***')));
});
