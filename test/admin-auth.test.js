// Admin accounts: first-admin setup, sign-in, temporary passwords, disabling, audit, CLI. Run: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'magetsi-admin-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.ADMIN_TOKEN = 'script-and-setup-token';
const { server, db } = require('../server.js');
const { main: cli } = require('../admin-cli.js');
const A = require('../lib/admins.js');

let base;
server.keepAliveTimeout = 60_000; // CPU-heavy scrypt tests can idle a socket past the 5 s default
test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => { server.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const ADMIN_MARK = 'Import a ZESCO schedule';
const form = (p, fields, cookie) => fetch(base + p, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams(fields),
});
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];
const page = async (cookie) => (await fetch(base + '/admin', { headers: cookie ? { cookie } : {} })).text();
const api = (p, cookie, body) => fetch(base + p, body === undefined
  ? { headers: { cookie } }
  : { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const login = (username, password) => form('/admin/login', { username, password });

const OWNER = { username: 'Owner', password: 'kalulu-pass-123' };
let ownerCookie;

test('passwords are hashed with scrypt and verified', () => {
  const h = A.hashPassword('correct horse');
  assert.match(h, /^scrypt\$16384\$8\$1\$/);
  assert.ok(A.verifyPassword('correct horse', h));
  assert.equal(A.verifyPassword('correct horsf', h), false);
  assert.notEqual(A.hashPassword('same'), A.hashPassword('same'), 'salted');
  assert.match(A.passwordProblem('short'), /10 characters/);
  assert.match(A.passwordProblem('mwila-is-great', 'mwila'), /username/);
});

test('fresh install: /admin asks for the setup token, nothing else is reachable', async () => {
  const html = await page();
  assert.match(html, /Create the first admin/);
  assert.ok(!html.includes(ADMIN_MARK));
  for (const p of ['/admin.html', '/admin/admin.html', '/admin/setup.html']) assert.ok(!(await (await fetch(base + p)).text()).includes(ADMIN_MARK), p);
  assert.equal((await login('anyone', 'whatever-123')).status, 401);
});

test('setup needs the right token and a good password; it only works once', async () => {
  const bad = await form('/admin/setup', { token: 'guess', ...OWNER, confirm: OWNER.password });
  assert.equal(bad.status, 401);
  assert.equal((await form('/admin/setup', { token: 'script-and-setup-token', username: 'owner', password: 'short', confirm: 'short' })).status, 400);
  assert.equal((await form('/admin/setup', { token: 'script-and-setup-token', ...OWNER, confirm: 'different-123' })).status, 400);

  const ok = await form('/admin/setup', { token: 'script-and-setup-token', ...OWNER, confirm: OWNER.password });
  assert.equal(ok.status, 303);
  assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  ownerCookie = cookieOf(ok);
  const html = await page(ownerCookie);
  assert.ok(html.includes(ADMIN_MARK));
  assert.match(html, /Signed in as <b>owner<\/b>/);

  const again = await form('/admin/setup', { token: 'script-and-setup-token', username: 'intruder', password: 'intruder-123', confirm: 'intruder-123' });
  assert.equal(again.status, 303);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM admins').get().n, 1);
});

test('sign in with username and password; wrong ones get one generic message', async () => {
  const wrongPw = await login('owner', 'not-the-password');
  const wrongUser = await login('nobody', 'not-the-password');
  assert.equal(wrongPw.status, 401);
  assert.equal(wrongUser.status, 401);
  assert.match(await wrongPw.text(), /Wrong username or password/);
  assert.match(await wrongUser.text(), /Wrong username or password/);
  const ok = await login('OWNER', OWNER.password); // usernames are case-insensitive
  assert.equal(ok.status, 303);
  assert.ok((await page(cookieOf(ok))).includes(ADMIN_MARK));
});

test('a new admin gets a temporary password and must replace it', async () => {
  const formPost = await fetch(base + '/api/admin/admins', { method: 'POST', headers: { cookie: ownerCookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=x' });
  assert.equal(formPost.status, 415, 'admin API only takes JSON (CSRF guard)');
  assert.equal((await api('/api/admin/admins', ownerCookie, { username: 'no spaces!' })).status, 400);

  const r = await api('/api/admin/admins', ownerCookie, { username: 'Mwila' });
  assert.equal(r.status, 201);
  const { username, tempPassword } = await r.json();
  assert.equal(username, 'mwila');
  assert.equal((await api('/api/admin/admins', ownerCookie, { username: 'mwila' })).status, 400, 'no duplicates');

  const s = await login('mwila', tempPassword);
  assert.equal(s.status, 303);
  const c = cookieOf(s);
  const html = await page(c);
  assert.match(html, /temporary password/);
  assert.ok(!html.includes(ADMIN_MARK));
  assert.equal((await api('/api/admin/overview', c)).status, 401, 'API locked until the password is changed');

  assert.equal((await form('/admin/password', { current: 'wrong-one-123', password: 'mwila-new-pass-1', confirm: 'mwila-new-pass-1' }, c)).status, 400);
  assert.equal((await form('/admin/password', { current: tempPassword, password: 'brand-new-pw-77', confirm: 'brand-new-pw-78' }, c)).status, 400);
  const changed = await form('/admin/password', { current: tempPassword, password: 'brand-new-pw-77', confirm: 'brand-new-pw-77' }, c);
  assert.equal(changed.status, 303);
  assert.ok((await page(c)).includes(ADMIN_MARK));
  assert.equal((await login('mwila', tempPassword)).status, 401, 'temporary password no longer works');
  assert.equal((await login('mwila', 'brand-new-pw-77')).status, 303);
});

test('disable and reset sign people out; you cannot lock yourself out', async () => {
  const list = await (await api('/api/admin/admins', ownerCookie)).json();
  const me = list.admins.find((a) => a.you);
  const mwila = list.admins.find((a) => a.username === 'mwila');
  assert.equal(me.username, 'owner');
  assert.equal(mwila.created_by, 'owner');

  assert.equal((await api('/api/admin/admins/disable', ownerCookie, { id: me.id })).status, 400);
  assert.equal((await api('/api/admin/admins/reset', ownerCookie, { id: me.id })).status, 400);

  const mc = cookieOf(await login('mwila', 'brand-new-pw-77'));
  assert.equal((await api('/api/admin/admins/disable', ownerCookie, { id: mwila.id })).status, 200);
  assert.equal((await api('/api/admin/overview', mc)).status, 401, 'session ended');
  assert.equal((await login('mwila', 'brand-new-pw-77')).status, 401, 'disabled cannot sign in');
  assert.equal((await api('/api/admin/admins/disable', ownerCookie, { id: mwila.id, disabled: false })).status, 200);

  const mc2 = cookieOf(await login('mwila', 'brand-new-pw-77'));
  const reset = await (await api('/api/admin/admins/reset', ownerCookie, { id: mwila.id })).json();
  assert.ok(reset.tempPassword);
  assert.equal((await api('/api/admin/overview', mc2)).status, 401, 'reset signs them out');
  assert.equal((await login('mwila', 'brand-new-pw-77')).status, 401);
  assert.equal((await login('mwila', reset.tempPassword)).status, 303);
});

test('the script token can use the admin API but not manage accounts', async () => {
  const h = { 'X-Admin-Token': 'script-and-setup-token' };
  assert.equal((await fetch(base + '/api/admin/overview', { headers: h })).status, 200);
  assert.equal((await fetch(base + '/api/admin/admins', { headers: h })).status, 403);
  assert.equal((await fetch(base + '/api/admin/overview', { headers: { 'X-Admin-Token': 'nope' } })).status, 401);
  assert.equal((await fetch(base + '/api/admin/overview', { headers: { cookie: 'mg_admin=forged' } })).status, 401);
});

test('audit log records who did what', async () => {
  await api('/api/admin/slots', ownerCookie, { csv: 'B,2030-01-01,06:00,10:00' });
  const { entries } = await (await api('/api/admin/audit', ownerCookie)).json();
  const seen = (who, action) => entries.some((e) => e.username === who && e.action === action);
  assert.ok(seen('owner', 'setup'));
  assert.ok(seen('owner', 'admin-create'));
  assert.ok(seen('owner', 'admin-disable'));
  assert.ok(seen('owner', 'schedule-import'));
  assert.ok(seen('mwila', 'password-change'));
  assert.ok(entries.some((e) => e.action === 'login-failed' && e.detail === 'nobody'));
  assert.ok(!JSON.stringify(entries).includes('brand-new-pw'), 'no passwords in the log');
});

test('sign out ends the session', async () => {
  const c = cookieOf(await login('owner', OWNER.password));
  const out = await form('/admin/logout', {}, c);
  assert.equal(out.status, 303);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await api('/api/admin/overview', c)).status, 401);
});

test('command line: create, reset, disable', () => {
  const lines = [];
  const log = (l) => lines.push(l);
  const dbFile = process.env.DB_FILE;
  assert.equal(cli(['create', 'chanda'], { dbFile, log }), 0);
  const pw = lines.at(-2).match(/Temporary password: (\S+)/)[1];
  assert.ok(A.verifyPassword(pw, db.prepare("SELECT pw_hash FROM admins WHERE username = 'chanda'").get().pw_hash));
  assert.equal(cli(['disable', 'chanda'], { dbFile, log }), 0);
  assert.equal(cli(['reset', 'chanda'], { dbFile, log }), 0);
  assert.match(lines.at(-1), /re-enabled/);
  assert.throws(() => cli(['reset', 'ghost'], { dbFile, log }), /No admin called/);
  cli(['list'], { dbFile, log });
  assert.ok(lines.some((l) => l.startsWith('chanda')));
});

test('sessions from the old shared-token version are dropped on upgrade', () => {
  const f = path.join(tmp, 'old.db');
  const old = new DatabaseSync(f);
  old.exec('CREATE TABLE admin_sessions (id_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL); INSERT INTO admin_sessions VALUES (\'x\', 9999999999999);');
  A.adminStore(old);
  assert.ok(old.prepare('PRAGMA table_info(admin_sessions)').all().some((c) => c.name === 'admin_id'));
  assert.equal(old.prepare('SELECT COUNT(*) n FROM admin_sessions').get().n, 0);
  old.close();
});

test('repeated wrong passwords lock that username for 15 minutes', async () => {
  let last;
  for (let i = 0; i < 11; i++) last = await login('owner', 'guess-' + i);
  assert.equal(last.status, 429);
  assert.equal((await login('owner', OWNER.password)).status, 429, 'even the right password waits');
});
