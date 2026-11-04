// Magetsi server: zero dependencies. Needs Node.js 22.5+ (built-in node:sqlite).
// Run:  node server.js        Open: http://localhost:3000
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const core = require('./public/core.js');
const webpush = require('./lib/webpush.js');
const { createSms } = require('./lib/sms.js');

const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'magetsi.db');
const PUBLIC = path.join(__dirname, 'public');
const SEED_DEMO = process.env.SEED_DEMO !== '0';
let ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) {
  ADMIN_TOKEN = crypto.randomBytes(6).toString('hex');
  console.log(`[magetsi] No ADMIN_TOKEN set. Admin token for this run: ${ADMIN_TOKEN}`);
}
const SMS_INBOUND_KEY = process.env.SMS_INBOUND_KEY || ADMIN_TOKEN;
const SMS_DAILY_LIMIT = Number(process.env.SMS_DAILY_LIMIT || 2000);
const SMS_SHORTCODE = process.env.AT_SHORTCODE || null;
const PUSH_ALLOW_ANY = process.env.PUSH_ALLOW_ANY_ENDPOINT === '1'; // tests only
const PUSH_HOSTS = process.env.PUSH_ENDPOINT_HOSTS ? process.env.PUSH_ENDPOINT_HOSTS.split(',').map((s) => s.trim()).filter(Boolean) : webpush.DEFAULT_PUSH_HOSTS;
const MAX_SAVED_AREAS = 5;

// ---------- database ----------
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS groups (code TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS areas (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
    group_code TEXT NOT NULL REFERENCES groups(code));
  CREATE TABLE IF NOT EXISTS slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_code TEXT NOT NULL REFERENCES groups(code),
    date TEXT NOT NULL, start TEXT NOT NULL, "end" TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'admin', created_at INTEGER NOT NULL,
    UNIQUE (group_code, date, start));
  CREATE INDEX IF NOT EXISTS slots_group_date ON slots(group_code, date);
  CREATE TABLE IF NOT EXISTS outages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    area_id INTEGER NOT NULL REFERENCES areas(id),
    device_id TEXT NOT NULL,
    off_at INTEGER NOT NULL, on_at INTEGER,
    manual INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS outages_area_time ON outages(area_id, off_at);
  CREATE INDEX IF NOT EXISTS outages_device_open ON outages(device_id, on_at);

  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS push_subs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL UNIQUE, endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL, auth TEXT NOT NULL,
    areas TEXT NOT NULL, settings TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sms_subs (
    phone TEXT PRIMARY KEY,
    area_id INTEGER REFERENCES areas(id),
    daily INTEGER NOT NULL DEFAULT 1, before_min INTEGER NOT NULL DEFAULT 30,
    active INTEGER NOT NULL DEFAULT 0, source TEXT, device_id TEXT,
    code_hash TEXT, code_expires INTEGER, code_tries INTEGER NOT NULL DEFAULT 0, pending TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sent_alerts (
    channel TEXT NOT NULL, target TEXT NOT NULL, tag TEXT NOT NULL, sent_at INTEGER NOT NULL,
    PRIMARY KEY (channel, target, tag));
  CREATE INDEX IF NOT EXISTS sent_alerts_time ON sent_alerts(sent_at);
  CREATE TABLE IF NOT EXISTS sms_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL, message TEXT NOT NULL, kind TEXT NOT NULL,
    status TEXT, provider_id TEXT, created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS sms_outbox_time ON sms_outbox(created_at);
  CREATE TABLE IF NOT EXISTS admin_sessions (id_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
`);
// databases from before towns existed
if (!db.prepare('PRAGMA table_info(areas)').all().some((c) => c.name === 'town')) {
  db.exec("ALTER TABLE areas ADD COLUMN town TEXT NOT NULL DEFAULT 'Lusaka'");
}

function seed() {
  const hasAreas = db.prepare('SELECT COUNT(*) n FROM areas').get().n > 0;
  if (hasAreas) return;
  const now = Date.now();
  const insG = db.prepare('INSERT INTO groups (code, name) VALUES (?, ?)');
  const insS = db.prepare('INSERT OR IGNORE INTO slots (group_code, date, start, "end", source, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const insO = db.prepare('INSERT INTO outages (area_id, device_id, off_at, on_at, manual, flagged, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  core.GROUPS.forEach((g) => insG.run(g.code, g.name));
  syncAreas();
  if (SEED_DEMO) {
    const start = core.addDays(core.lusakaDate(now), -8);
    const slots = core.rotationSlots(start, 22); // 8 days back, 14 ahead
    slots.forEach((s) => insS.run(s.group_code, s.date, s.start, s.end, s.source, now));
    core.demoOutages(core.AREAS, slots, now, 7).forEach((o) =>
      insO.run(o.area_id, o.device_id, o.offMs, o.onMs, 0, 0, now));
  }
  db.exec('COMMIT');
  console.log(`[magetsi] Seeded ${core.AREAS.length} areas in ${core.TOWNS.length} towns${SEED_DEMO ? ' + demo schedule and reports' : ''}.`);
}

// Add areas that core.AREAS has and the database doesn't yet (new towns). Existing rows are left alone.
function syncAreas() {
  const ins = db.prepare('INSERT OR IGNORE INTO areas (id, name, town, group_code) VALUES (?, ?, ?, ?)');
  let added = 0;
  for (const a of core.AREAS) added += Number(ins.run(a.id, a.name, a.town, a.group_code).changes);
  return added;
}
seed();
{
  const added = syncAreas();
  if (added) console.log(`[magetsi] Added ${added} new area(s) from public/core.js.`);
}

// Close outages left open for more than 24 h and flag them (left out of stats)
function autoClose() {
  const cutoff = Date.now() - core.RULES.maxOutageMs;
  db.prepare('UPDATE outages SET on_at = off_at + ?, flagged = 1 WHERE on_at IS NULL AND off_at < ?')
    .run(core.RULES.maxOutageMs, cutoff);
}
autoClose();
setInterval(autoClose, 10 * 60 * 1000).unref();

// ---------- queries ----------
const q = {
  areas: db.prepare('SELECT a.id, a.name, a.town, a.group_code, g.name AS group_name FROM areas a JOIN groups g ON g.code = a.group_code ORDER BY a.town, a.name'),
  area: db.prepare('SELECT id, name, town, group_code FROM areas WHERE id = ?'),
  slots: db.prepare('SELECT id, group_code, date, start, "end" AS end, source FROM slots WHERE group_code = ? AND date BETWEEN ? AND ? ORDER BY date, start'),
  outagesSince: db.prepare('SELECT id, device_id, off_at, on_at, flagged FROM outages WHERE area_id = ? AND (on_at IS NULL OR on_at >= ?) AND off_at <= ?'),
  openForDevice: db.prepare('SELECT * FROM outages WHERE device_id = ? AND on_at IS NULL AND flagged = 0 ORDER BY off_at DESC LIMIT 1'),
  insertOutage: db.prepare('INSERT INTO outages (area_id, device_id, off_at, on_at, manual, flagged, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)'),
  closeOutage: db.prepare('UPDATE outages SET on_at = ? WHERE id = ?'),
  groupCodes: db.prepare('SELECT code FROM groups'),
  upsertSlot: db.prepare('INSERT INTO slots (group_code, date, start, "end", source, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(group_code, date, start) DO UPDATE SET "end" = excluded."end", source = excluded.source, created_at = excluded.created_at'),
  deleteSlots: db.prepare('DELETE FROM slots WHERE group_code = ? AND date = ?'),

  kvGet: db.prepare('SELECT v FROM kv WHERE k = ?'),
  kvSet: db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),

  pushSubs: db.prepare('SELECT * FROM push_subs'),
  pushByDevice: db.prepare('SELECT * FROM push_subs WHERE device_id = ?'),
  pushDropEndpoint: db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND device_id <> ?'),
  pushUpsert: db.prepare(`INSERT INTO push_subs (device_id, endpoint, p256dh, auth, areas, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth,
    areas = excluded.areas, settings = excluded.settings, updated_at = excluded.updated_at`),
  pushDelete: db.prepare('DELETE FROM push_subs WHERE id = ?'),
  pushDeleteDevice: db.prepare('DELETE FROM push_subs WHERE device_id = ?'),
  pushCount: db.prepare('SELECT COUNT(*) n FROM push_subs'),

  smsSub: db.prepare('SELECT * FROM sms_subs WHERE phone = ?'),
  smsActive: db.prepare('SELECT * FROM sms_subs WHERE active = 1 AND area_id IS NOT NULL'),
  smsCount: db.prepare('SELECT COUNT(*) n FROM sms_subs WHERE active = 1'),
  smsNew: db.prepare('INSERT OR IGNORE INTO sms_subs (phone, created_at, updated_at) VALUES (?, ?, ?)'),
  smsSetCode: db.prepare('UPDATE sms_subs SET code_hash = ?, code_expires = ?, code_tries = 0, pending = ?, updated_at = ? WHERE phone = ?'),
  smsTry: db.prepare('UPDATE sms_subs SET code_tries = code_tries + 1 WHERE phone = ?'),
  smsActivate: db.prepare(`UPDATE sms_subs SET area_id = ?, daily = ?, before_min = ?, active = 1, source = ?, device_id = ?,
    code_hash = NULL, code_expires = NULL, code_tries = 0, pending = NULL, updated_at = ? WHERE phone = ?`),
  smsStop: db.prepare('UPDATE sms_subs SET active = 0, updated_at = ? WHERE phone = ?'),

  claim: db.prepare('INSERT OR IGNORE INTO sent_alerts (channel, target, tag, sent_at) VALUES (?, ?, ?, ?)'),
  unclaim: db.prepare('DELETE FROM sent_alerts WHERE channel = ? AND target = ? AND tag = ?'),
  pruneSent: db.prepare('DELETE FROM sent_alerts WHERE sent_at < ?'),

  sessionAdd: db.prepare('INSERT INTO admin_sessions (id_hash, expires) VALUES (?, ?)'),
  sessionGet: db.prepare('SELECT 1 FROM admin_sessions WHERE id_hash = ? AND expires > ?'),
  sessionDelete: db.prepare('DELETE FROM admin_sessions WHERE id_hash = ?'),
  sessionPrune: db.prepare('DELETE FROM admin_sessions WHERE expires <= ?'),

  outboxAdd: db.prepare('INSERT INTO sms_outbox (phone, message, kind, status, provider_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  outboxSince: db.prepare("SELECT COUNT(*) n FROM sms_outbox WHERE created_at >= ? AND status <> 'over-limit'"),
  outboxRecent: db.prepare('SELECT phone, message, kind, status, created_at FROM sms_outbox ORDER BY id DESC LIMIT 30'),
};

const toOutage = (r) => ({ id: r.id, device_id: r.device_id, offMs: r.off_at, onMs: r.on_at, flagged: r.flagged });

function slotsFor(area, fromDate, toDate) {
  // include the day before so slots running past midnight are seen
  return q.slots.all(area.group_code, core.addDays(fromDate, -1), toDate);
}

function areaStatus(area, now) {
  const today = core.lusakaDate(now);
  const slots = slotsFor(area, today, core.addDays(today, 2));
  const outages = q.outagesSince.all(area.id, now - core.DAY, now).map(toOutage);
  return { slots, outages };
}

// ---------- Web Push keys ----------
function loadVapid() {
  let publicKey = process.env.VAPID_PUBLIC_KEY, privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    const row = q.kvGet.get('vapid');
    if (row) ({ publicKey, privateKey } = JSON.parse(row.v));
    else {
      ({ publicKey, privateKey } = webpush.generateVapidKeys());
      q.kvSet.run('vapid', JSON.stringify({ publicKey, privateKey }));
      console.log('[magetsi] Generated Web Push (VAPID) keys and saved them in the database.');
    }
  }
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
  if (!process.env.VAPID_SUBJECT && require.main === module) console.log('[magetsi] Set VAPID_SUBJECT=mailto:you@yourdomain so push services can contact you.');
  return webpush.makeVapid({ publicKey, privateKey, subject });
}
const vapid = loadVapid();

const sms = createSms();

// ---------- rate limiting (in memory) ----------
const hits = new Map();
function allow(key, max, windowMs = core.HOUR) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) { hits.set(key, list); return false; }
  list.push(now);
  hits.set(key, list);
  return true;
}
const allowWrite = (deviceId) => allow('w:' + deviceId, core.RULES.writesPerHour);
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < core.DAY)) hits.delete(k); }, core.HOUR).unref();

// ---------- http helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(data);
}
const fail = (res, status, error) => send(res, status, { error });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 200_000) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const raw = await readBody(req);
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new Error('Invalid JSON'); }
}
async function readForm(req) {
  if (/json/.test(req.headers['content-type'] || '')) return readJson(req);
  return Object.fromEntries(new URLSearchParams(await readBody(req)));
}

const validDevice = (d) => typeof d === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(d);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sameHash = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const maskPhone = (p) => p.slice(0, 7) + '***' + p.slice(-3);

// ---------- admin sign-in ----------
// The admin page lives outside public/ and is only sent to a signed-in session.
// Sign in with ADMIN_TOKEN -> random session id in an HttpOnly, SameSite=Strict cookie (only its hash is stored).
// Scripts can still call /api/admin/* with an X-Admin-Token header.
const ADMIN_DIR = path.join(__dirname, 'admin');
const SESSION_COOKIE = 'mg_admin';
const SESSION_MS = 12 * core.HOUR;
const tokenOk = (t) => typeof t === 'string' && t.length > 0 && sameHash(sha(t), sha(ADMIN_TOKEN));

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const isHttps = (req) => !!req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
const sessionCookie = (req, value, maxAgeS) =>
  `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${isHttps(req) ? '; Secure' : ''}`;

function isAdmin(req) {
  if (tokenOk(req.headers['x-admin-token'])) return true;
  const sid = cookies(req)[SESSION_COOKIE];
  return !!(sid && q.sessionGet.get(sha(sid), Date.now()));
}

const ADMIN_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' };
function adminPage(res, status, file, error = '') {
  let html = fs.readFileSync(path.join(ADMIN_DIR, file), 'utf8');
  if (error) html = html.replace('<!--ERROR-->', error);
  res.writeHead(status, ADMIN_HEADERS);
  res.end(html);
}
const redirect = (res, to, extra = {}) => { res.writeHead(303, { Location: to, 'Cache-Control': 'no-store', ...extra }); res.end(); };

/** /admin, /admin/login, /admin/logout. Returns true if handled. */
async function adminRoutes(req, res, url) {
  const p = url.pathname.replace(/\/+$/, '') || '/';
  if (p === '/admin' && req.method === 'GET') {
    adminPage(res, 200, isAdmin(req) ? 'admin.html' : 'login.html');
    return true;
  }
  if (p === '/admin/login' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || '?';
    if (!allow('login:' + ip, 10, 15 * core.MIN)) { adminPage(res, 429, 'login.html', 'Too many attempts. Wait 15 minutes and try again.'); return true; }
    const body = await readForm(req);
    if (!tokenOk(String(body.token || '').trim())) { adminPage(res, 401, 'login.html', 'Wrong admin token.'); return true; }
    const sid = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    q.sessionPrune.run(now);
    q.sessionAdd.run(sha(sid), now + SESSION_MS);
    redirect(res, '/admin', { 'Set-Cookie': sessionCookie(req, sid, SESSION_MS / 1000) });
    return true;
  }
  if (p === '/admin/logout' && req.method === 'POST') {
    const sid = cookies(req)[SESSION_COOKIE];
    if (sid) q.sessionDelete.run(sha(sid));
    redirect(res, '/admin', { 'Set-Cookie': sessionCookie(req, '', 0) });
    return true;
  }
  if (p.startsWith('/admin/')) { fail(res, 404, 'Not found'); return true; }
  return false;
}

function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? '/index.html' : pathname;
  if (file === '/dashboard') file = '/dashboard.html';
  const full = path.normalize(path.join(PUBLIC, file));
  if (!full.startsWith(PUBLIC)) return fail(res, 403, 'Forbidden');
  fs.readFile(full, (err, buf) => {
    if (err) return fail(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

// ---------- SMS ----------
function smsSentToday(now = Date.now()) {
  return q.outboxSince.get(core.toMs(core.lusakaDate(now), '00:00')).n;
}
/** Send and record one SMS. Never throws. */
async function sendSms(phone, message, kind) {
  const now = Date.now();
  if (smsSentToday(now) >= SMS_DAILY_LIMIT) {
    q.outboxAdd.run(phone, message, kind, 'over-limit', null, now);
    console.warn(`[magetsi] SMS_DAILY_LIMIT (${SMS_DAILY_LIMIT}) reached; not sending to ${maskPhone(phone)}`);
    return { ok: false, status: 'over-limit' };
  }
  let r;
  try { r = await sms.send(phone, message); } catch (e) { r = { ok: false, id: null, status: e.message }; }
  q.outboxAdd.run(phone, message, kind, String(r.status || ''), r.id || null, Date.now());
  return r;
}

const SMS_HELP = 'Magetsi power alerts. Text JOIN and your area (e.g. JOIN CHILENJE) for today\'s times each morning and a reminder before outages. TIMES for today. STOP to end.';

/** Handle one SMS from a phone. Returns the reply text (also sent by SMS). */
async function handleInbound(phone, text) {
  const now = Date.now();
  const c = core.parseSmsCommand(text, q.areas.all());
  const sub = q.smsSub.get(phone);
  let reply;
  if (c.cmd === 'join') {
    q.smsNew.run(phone, now, now);
    const daily = sub ? sub.daily : 1, before = sub ? sub.before_min : 30;
    q.smsActivate.run(c.area.id, daily, before, 'sms', sub ? sub.device_id : null, now, phone);
    reply = `Magetsi: you will get alerts for ${c.area.name}, ${c.area.town} (Group ${c.area.group_code}). Reply TIMES for today, STOP to end.`;
  } else if (c.cmd === 'stop') {
    if (sub) q.smsStop.run(now, phone);
    reply = 'Magetsi: alerts stopped. Text JOIN and your area to start again.';
  } else if (c.cmd === 'times') {
    const area = sub && sub.active && q.area.get(sub.area_id);
    if (!area) reply = 'Magetsi: text JOIN and your area first, e.g. JOIN CHILENJE.';
    else {
      const list = core.todayWindowsText(areaStatus(area, now).slots, now);
      reply = list ? `Magetsi: ${area.name} power off today ${list}.` : `Magetsi: no more load-shedding scheduled in ${area.name} today.`;
    }
  } else if (c.cmd === 'ambiguous') {
    reply = `Magetsi: which area? Reply JOIN with one of: ${c.options.map((a) => a.name).join(', ')}.`;
  } else if (c.cmd === 'unknown') {
    reply = 'Magetsi: area not found. Text JOIN and your area, e.g. JOIN CHILENJE.';
  } else reply = SMS_HELP;
  await sendSms(phone, reply, 'reply');
  return reply;
}

// ---------- alert loop: Web Push + SMS ----------

async function pushTo(sub, payload) {
  try {
    const r = await webpush.sendPush(sub, payload, vapid);
    if (r.gone) { q.pushDelete.run(sub.id); return { ok: false, gone: true }; }
    if (!r.ok) console.warn(`[magetsi] push to sub ${sub.id} failed: HTTP ${r.status}`);
    return r;
  } catch (e) {
    console.warn(`[magetsi] push to sub ${sub.id} failed: ${e.message}`);
    return { ok: false };
  }
}

async function runLimited(jobs, n) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => { while (i < jobs.length) await jobs[i++](); }));
}

/** Work out which alerts are due and send them. Each (channel, target, tag) goes out once; failures retry next run. */
async function runAlerts(now = Date.now()) {
  q.pruneSent.run(now - 3 * core.DAY);
  const ctxCache = new Map();
  const ctx = (id) => {
    if (!ctxCache.has(id)) {
      const area = q.area.get(id);
      if (!area) ctxCache.set(id, null);
      else {
        const { slots, outages } = areaStatus(area, now);
        ctxCache.set(id, { area, slots, status: core.computeStatus({ slots, outages, now }) });
      }
    }
    return ctxCache.get(id);
  };
  const claim = (channel, target, tag) => q.claim.run(channel, target, tag, now).changes > 0;
  const jobs = [];

  for (const sub of q.pushSubs.all()) {
    let areas, settings;
    try { areas = JSON.parse(sub.areas); settings = JSON.parse(sub.settings); } catch { continue; }
    for (const id of areas) {
      const c = ctx(id);
      if (!c) continue;
      for (const a of core.dueAlerts({ ...c, settings, now })) {
        if (!claim('push', String(sub.id), a.tag)) continue;
        jobs.push(async () => {
          const r = await pushTo(sub, { title: a.title, body: a.body, tag: a.tag, url: './' });
          if (!r.ok && !r.gone) q.unclaim.run('push', String(sub.id), a.tag);
        });
      }
    }
  }

  for (const sub of q.smsActive.all()) {
    const c = ctx(sub.area_id);
    if (!c) continue;
    for (const m of core.smsDue({ area: c.area, slots: c.slots, sub, now })) {
      if (!claim('sms', sub.phone, m.tag)) continue;
      jobs.push(async () => {
        const r = await sendSms(sub.phone, m.text, 'alert');
        if (!r.ok && r.status !== 'over-limit') q.unclaim.run('sms', sub.phone, m.tag);
      });
    }
  }

  await runLimited(jobs, 10);
  return jobs.length;
}

// ---------- public dashboard ----------
const dashCache = new Map();
function dashboard(days, now) {
  const hit = dashCache.get(days);
  if (hit && now - hit.at < 60_000) return hit.data;
  const fromMs = now - days * core.DAY;
  const rows = q.areas.all().map((area) => {
    const slots = slotsFor(area, core.lusakaDate(fromMs), core.lusakaDate(now));
    const outages = q.outagesSince.all(area.id, fromMs, now).map(toOutage);
    const s = core.adherence({ slots, outages, fromMs, toMs: now });
    return {
      id: area.id, name: area.name, town: area.town, group_code: area.group_code,
      households: s.households, enough: s.enough, onSchedulePct: s.onSchedulePct, extraHoursPerDay: s.extraHoursPerDay,
      lateRestoreMinPerDay: s.lateRestoreMinPerDay, actualHoursPerDay: s.actualHoursPerDay, scheduledHoursPerDay: s.scheduledHoursPerDay,
    };
  });
  const data = { days, from: core.lusakaDate(fromMs), to: core.lusakaDate(now), generatedAt: now, minHouseholds: core.RULES.statsMinHouseholds, towns: core.TOWNS, rows };
  dashCache.set(days, { at: now, data });
  return data;
}

// ---------- routes ----------
function parseAreas(list) {
  if (!Array.isArray(list) || list.length > MAX_SAVED_AREAS) return null;
  const ids = [...new Set(list.map(Number))];
  return ids.every((id) => q.area.get(id)) ? ids : null;
}

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  const now = Date.now();

  if (m === 'GET' && p === '/api/health') return send(res, 200, { ok: true, mode: 'server', now });

  if (m === 'GET' && p === '/api/areas') return send(res, 200, { areas: q.areas.all(), groups: core.GROUPS, towns: core.TOWNS });

  // area-scoped GETs
  if (m === 'GET' && ['/api/schedule', '/api/status', '/api/stats'].includes(p)) {
    const area = q.area.get(Number(url.searchParams.get('area')));
    if (!area) return fail(res, 404, 'Unknown area');

    if (p === '/api/schedule') {
      const days = Math.min(14, Math.max(1, Number(url.searchParams.get('days')) || 7));
      const from = core.lusakaDate(now);
      return send(res, 200, { area, slots: slotsFor(area, from, core.addDays(from, days)) });
    }
    if (p === '/api/status') {
      const { slots, outages } = areaStatus(area, now);
      const status = core.computeStatus({ slots, outages, now, deviceId: url.searchParams.get('device') });
      return send(res, 200, { area, status });
    }
    if (p === '/api/stats') {
      const days = Math.min(30, Math.max(1, Number(url.searchParams.get('days')) || 7));
      const fromMs = now - days * core.DAY;
      const slots = slotsFor(area, core.lusakaDate(fromMs), core.lusakaDate(now));
      const outages = q.outagesSince.all(area.id, fromMs, now).map(toOutage);
      return send(res, 200, { area, stats: core.adherence({ slots, outages, fromMs, toMs: now }) });
    }
  }

  if (m === 'GET' && (p === '/api/dashboard' || p === '/api/dashboard.csv')) {
    const days = [7, 30].includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 7;
    const data = dashboard(days, now);
    if (p === '/api/dashboard') return send(res, 200, data);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="magetsi-adherence-${data.to}-${days}d.csv"`,
      'Cache-Control': 'no-store',
    });
    return res.end(core.dashboardCsv(data.rows, data));
  }

  if (m === 'POST' && p.startsWith('/api/outages')) {
    const body = await readJson(req);
    if (!validDevice(body.device)) return fail(res, 400, 'Missing or invalid device id');
    const area = q.area.get(Number(body.area));
    if (!area && p !== '/api/outages/on') return fail(res, 400, 'Unknown area');
    if (!allowWrite(body.device)) return fail(res, 429, 'Too many reports from this device. Try again later.');

    if (p === '/api/outages/off') {
      const open = q.openForDevice.get(body.device);
      if (open) return send(res, 200, { outage: toOutage(open), duplicate: true });
      const r = q.insertOutage.run(area.id, body.device, now, null, 0, now);
      return send(res, 201, { outage: { id: Number(r.lastInsertRowid), offMs: now, onMs: null } });
    }
    if (p === '/api/outages/on') {
      const open = q.openForDevice.get(body.device);
      if (!open) return fail(res, 409, 'No open outage for this device');
      q.closeOutage.run(now, open.id);
      return send(res, 200, { outage: { ...toOutage(open), onMs: now } });
    }
    if (p === '/api/outages') {
      const offMs = Number(body.off_at), onMs = Number(body.on_at);
      const err = core.validateManualOutage(offMs, onMs, now);
      if (err) return fail(res, 400, err);
      const r = q.insertOutage.run(area.id, body.device, offMs, onMs, 1, now);
      return send(res, 201, { outage: { id: Number(r.lastInsertRowid), offMs, onMs } });
    }
  }

  // ----- Web Push -----
  if (m === 'GET' && p === '/api/push/key') return send(res, 200, { publicKey: vapid.publicKey });

  if (m === 'POST' && p.startsWith('/api/push/')) {
    const body = await readJson(req);
    if (!validDevice(body.device)) return fail(res, 400, 'Missing or invalid device id');
    if (!allow('push:' + body.device, 60)) return fail(res, 429, 'Too many requests. Try again later.');

    if (p === '/api/push/subscribe') {
      const s = body.subscription || {};
      const keys = s.keys || {};
      if (!webpush.validEndpoint(s.endpoint, { allowAny: PUSH_ALLOW_ANY, hosts: PUSH_HOSTS })) return fail(res, 400, 'Push endpoint not accepted');
      if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' || keys.p256dh.length > 200 || keys.auth.length > 100
        || webpush.fromB64u(keys.p256dh).length !== 65 || webpush.fromB64u(keys.auth).length < 16) return fail(res, 400, 'Bad subscription keys');
      const areas = parseAreas(body.areas || []);
      if (!areas) return fail(res, 400, `Up to ${MAX_SAVED_AREAS} known areas`);
      const settings = core.cleanSettings(body.settings);
      q.pushDropEndpoint.run(s.endpoint, body.device);
      q.pushUpsert.run(body.device, s.endpoint, keys.p256dh, keys.auth, JSON.stringify(areas), JSON.stringify(settings), now, now);
      return send(res, 200, { ok: true, areas, settings });
    }
    if (p === '/api/push/unsubscribe') {
      q.pushDeleteDevice.run(body.device);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/push/test') {
      const sub = q.pushByDevice.get(body.device);
      if (!sub) return fail(res, 404, 'This device has no push subscription');
      const r = await pushTo(sub, { title: 'Magetsi test', body: 'Push works. Alerts reach you even when Magetsi is closed.', tag: 'test-' + now, url: './' });
      if (!r.ok) return fail(res, 502, r.gone ? 'Subscription expired. Turn notifications off and on again.' : `Push service answered ${r.status || 'with an error'}`);
      return send(res, 200, { ok: true });
    }
  }

  // ----- SMS -----
  if (m === 'GET' && p === '/api/sms/info') {
    return send(res, 200, { driver: sms.driver, shortcode: SMS_SHORTCODE, beforeChoices: [0, 30, 60] });
  }

  if (m === 'POST' && p === '/api/sms/inbound') {
    if (url.searchParams.get('key') !== SMS_INBOUND_KEY && !isAdmin(req)) return fail(res, 401, 'Wrong key');
    const body = await readForm(req);
    const phone = core.normalizePhone(body.from);
    if (!phone) return send(res, 200, { ignored: 'Not a Zambian mobile number' });
    if (!allow('in:' + phone, 10)) return send(res, 200, { ignored: 'Rate limited' });
    return send(res, 200, { reply: await handleInbound(phone, body.text) });
  }

  if (m === 'POST' && p.startsWith('/api/sms/')) {
    const body = await readJson(req);
    if (!validDevice(body.device)) return fail(res, 400, 'Missing or invalid device id');
    const phone = core.normalizePhone(body.phone);
    if (!phone) return fail(res, 400, 'Enter a Zambian mobile number, e.g. 097 123 4567');

    if (p === '/api/sms/start') {
      const area = q.area.get(Number(body.area));
      if (!area) return fail(res, 400, 'Unknown area');
      const before = [0, 30, 60].includes(Number(body.before)) ? Number(body.before) : 30;
      const daily = body.daily === false ? 0 : 1;
      if (!daily && !before) return fail(res, 400, 'Choose at least one kind of SMS');
      if (!allow('code-dev:' + body.device, 5) || !allow('code-phone:' + phone, 3)) return fail(res, 429, 'Too many codes requested. Try again in an hour.');
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      q.smsNew.run(phone, now, now);
      q.smsSetCode.run(sha(phone + code), now + 10 * core.MIN, JSON.stringify({ area: area.id, daily, before, device: body.device }), now, phone);
      const r = await sendSms(phone, `Magetsi code: ${code}. Enter it in the app to get power alerts for ${area.name}. Ignore this if you did not ask for it.`, 'code');
      if (!r.ok) return fail(res, 502, 'Could not send the SMS. Try again later.');
      return send(res, 200, { sent: true, phone: maskPhone(phone) });
    }
    if (p === '/api/sms/verify') {
      const sub = q.smsSub.get(phone);
      if (!sub || !sub.code_hash || !sub.pending) return fail(res, 400, 'Ask for a code first');
      if (sub.code_expires < now || sub.code_tries >= 5) return fail(res, 400, 'Code expired. Ask for a new one.');
      const pend = JSON.parse(sub.pending);
      if (pend.device !== body.device) return fail(res, 400, 'Ask for a code from this phone first');
      q.smsTry.run(phone);
      if (!sameHash(sha(phone + String(body.code || '').trim()), sub.code_hash)) return fail(res, 400, 'Wrong code');
      q.smsActivate.run(pend.area, pend.daily, pend.before, 'web', body.device, now, phone);
      const area = q.area.get(pend.area);
      await sendSms(phone, `Magetsi: alerts on for ${area.name}. Reply TIMES for today's times, STOP to end.`, 'reply');
      return send(res, 200, { active: true, phone: maskPhone(phone), area: area.id, daily: !!pend.daily, before: pend.before });
    }
    if (p === '/api/sms/stop') {
      const sub = q.smsSub.get(phone);
      if (!sub || sub.device_id !== body.device) return fail(res, 403, 'This number was not set up from this device. Text STOP from the phone instead.');
      q.smsStop.run(now, phone);
      return send(res, 200, { active: false });
    }
  }

  // ----- admin -----
  if (p.startsWith('/api/admin/') && !isAdmin(req)) return fail(res, 401, 'Sign in at /admin first');

  if (m === 'POST' && p === '/api/admin/slots') {
    const body = await readJson(req);
    const groups = q.groupCodes.all().map((r) => r.code);
    const { slots, errors } = core.parseScheduleCsv(String(body.csv || ''), groups);
    if (errors.length) return send(res, 400, { error: 'CSV has errors; nothing was saved.', errors });
    db.exec('BEGIN');
    try {
      if (body.replace) {
        const seen = new Set(slots.map((s) => `${s.group_code}|${s.date}`));
        for (const k of seen) { const [g, d] = k.split('|'); q.deleteSlots.run(g, d); }
      }
      for (const s of slots) q.upsertSlot.run(s.group_code, s.date, s.start, s.end, 'admin', now);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    dashCache.clear();
    return send(res, 200, { saved: slots.length });
  }

  if (m === 'GET' && p === '/api/admin/overview') {
    return send(res, 200, {
      pushSubscribers: q.pushCount.get().n,
      smsSubscribers: q.smsCount.get().n,
      smsDriver: sms.driver,
      smsSentToday: smsSentToday(now),
      smsDailyLimit: SMS_DAILY_LIMIT,
      outbox: q.outboxRecent.all().map((r) => ({ ...r, phone: maskPhone(r.phone) })),
    });
  }

  return fail(res, 404, 'Unknown endpoint');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (!(await adminRoutes(req, res, url))) serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error(e);
    fail(res, 500, e.message || 'Server error');
  }
});

function startAlertLoop() {
  const tick = () => runAlerts().catch((e) => console.error('[magetsi] alert loop', e));
  tick();
  return setInterval(tick, 60 * 1000);
}

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[magetsi] Running at http://localhost:${PORT}  (admin: /admin, dashboard: /dashboard)`);
    console.log(`[magetsi] SMS: ${sms.driver}${sms.driver === 'log' ? ' (set AT_API_KEY to send real SMS)' : ''}`);
    startAlertLoop();
  });
}
module.exports = { server, db, runAlerts, handleInbound };
