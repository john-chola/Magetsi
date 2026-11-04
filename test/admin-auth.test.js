// Admin page is only served after sign-in. Run: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'magetsi-admin-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.ADMIN_TOKEN = 'correct-horse-token';
const { server, db } = require('../server.js');

let base;
test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => { server.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const ADMIN_MARK = 'Import a ZESCO schedule';
const login = (token) => fetch(base + '/admin/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) });
const sessionFrom = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

test('without signing in, /admin shows only the sign-in form', async () => {
  const r = await fetch(base + '/admin');
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.match(html, /Sign in/);
  assert.ok(!html.includes(ADMIN_MARK));
  assert.equal(r.headers.get('cache-control'), 'no-store');
  for (const p of ['/admin/', '/admin.html', '/admin/admin.html', '/admin/../admin/admin.html']) {
    const x = await fetch(base + p);
    assert.ok(!(await x.text()).includes(ADMIN_MARK), p);
  }
});

test('a wrong token is refused', async () => {
  const r = await login('nope');
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('set-cookie'), null);
  assert.match(await r.text(), /Wrong admin token/);
});

test('sign in, use the admin page and API, sign out', async () => {
  const r = await login('correct-horse-token');
  assert.equal(r.status, 303);
  const setCookie = r.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = sessionFrom(r);

  const page = await fetch(base + '/admin', { headers: { cookie } });
  assert.ok((await page.text()).includes(ADMIN_MARK));
  const ov = await fetch(base + '/api/admin/overview', { headers: { cookie } });
  assert.equal(ov.status, 200);
  const imp = await fetch(base + '/api/admin/slots', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ csv: 'B,2030-01-01,06:00,10:00' }) });
  assert.equal((await imp.json()).saved, 1);

  const out = await fetch(base + '/admin/logout', { method: 'POST', redirect: 'manual', headers: { cookie } });
  assert.equal(out.status, 303);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await fetch(base + '/api/admin/overview', { headers: { cookie } })).status, 401);
  assert.ok(!(await (await fetch(base + '/admin', { headers: { cookie } })).text()).includes(ADMIN_MARK));
});

test('admin API refuses forged or missing sessions; header token still works for scripts', async () => {
  assert.equal((await fetch(base + '/api/admin/overview')).status, 401);
  assert.equal((await fetch(base + '/api/admin/overview', { headers: { cookie: 'mg_admin=forged' } })).status, 401);
  assert.equal((await fetch(base + '/api/admin/overview', { headers: { 'X-Admin-Token': 'correct-horse-token' } })).status, 200);
});

test('sign-in attempts are rate limited', async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await login('guess-' + i);
  assert.equal(last.status, 429);
  assert.equal((await login('correct-horse-token')).status, 429, 'even the right token waits');
});
