// Admin accounts: scrypt password hashes, sessions and an audit log, stored in SQLite.
// Shared by server.js and admin-cli.js.
'use strict';

const crypto = require('node:crypto');

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEYLEN = 64;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${h.toString('base64url')}`;
}

function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, salt, hash] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const want = Buffer.from(hash, 'base64url');
    const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64url'), want.length, { N: Number(N), r: Number(r), p: Number(p) });
    return crypto.timingSafeEqual(got, want);
  } catch { return false; }
}

/** Same check without blocking the event loop (scrypt runs on the libuv thread pool). */
function verifyPasswordAsync(pw, stored) {
  return new Promise((resolve) => {
    try {
      const [alg, N, r, p, salt, hash] = String(stored).split('$');
      if (alg !== 'scrypt') return resolve(false);
      const want = Buffer.from(hash, 'base64url');
      crypto.scrypt(String(pw), Buffer.from(salt, 'base64url'), want.length, { N: Number(N), r: Number(r), p: Number(p) },
        (err, got) => resolve(!err && crypto.timingSafeEqual(got, want)));
    } catch { resolve(false); }
  });
}

// Checked against when a username doesn't exist, so a wrong username takes as long as a wrong password.
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));

const normUsername = (u) => String(u || '').trim().toLowerCase();
const validUsername = (u) => /^[a-z0-9][a-z0-9._-]{2,31}$/.test(u);
const USERNAME_RULE = 'Username: 3 to 32 characters, letters, digits, dot, dash or underscore.';

function passwordProblem(pw, username) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 200) return 'Password is too long (200 characters at most).';
  if (username && pw.toLowerCase().includes(username.toLowerCase())) return 'Password must not contain the username.';
  return null;
}

/** A temporary password for a new or reset account (must be changed at first sign-in). */
const tempPassword = () => crypto.randomBytes(9).toString('base64url');

function initAdminTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      pw_hash TEXT NOT NULL,
      must_change INTEGER NOT NULL DEFAULT 0,
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, created_by INTEGER, last_login INTEGER);
    CREATE TABLE IF NOT EXISTS admin_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER, username TEXT, action TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS admin_audit_time ON admin_audit(created_at);
  `);
  // Sessions from the shared-token version had no admin_id: drop them (everyone signs in again).
  const cols = db.prepare('PRAGMA table_info(admin_sessions)').all();
  if (cols.length && !cols.some((c) => c.name === 'admin_id')) db.exec('DROP TABLE admin_sessions');
  db.exec('CREATE TABLE IF NOT EXISTS admin_sessions (id_hash TEXT PRIMARY KEY, admin_id INTEGER NOT NULL, expires INTEGER NOT NULL)');
}

function adminStore(db) {
  initAdminTables(db);
  const s = {
    count: db.prepare('SELECT COUNT(*) n FROM admins'),
    activeCount: db.prepare('SELECT COUNT(*) n FROM admins WHERE disabled = 0'),
    byName: db.prepare('SELECT * FROM admins WHERE username = ?'),
    byId: db.prepare('SELECT * FROM admins WHERE id = ?'),
    list: db.prepare(`SELECT a.id, a.username, a.must_change, a.disabled, a.created_at, a.last_login, c.username AS created_by
      FROM admins a LEFT JOIN admins c ON c.id = a.created_by ORDER BY a.username`),
    insert: db.prepare('INSERT INTO admins (username, pw_hash, must_change, created_at, created_by) VALUES (?, ?, ?, ?, ?)'),
    setPassword: db.prepare('UPDATE admins SET pw_hash = ?, must_change = ? WHERE id = ?'),
    setDisabled: db.prepare('UPDATE admins SET disabled = ? WHERE id = ?'),
    touchLogin: db.prepare('UPDATE admins SET last_login = ? WHERE id = ?'),
    audit: db.prepare('INSERT INTO admin_audit (admin_id, username, action, detail, created_at) VALUES (?, ?, ?, ?, ?)'),
    auditList: db.prepare('SELECT username, action, detail, created_at FROM admin_audit ORDER BY id DESC LIMIT ?'),
    sessAdd: db.prepare('INSERT INTO admin_sessions (id_hash, admin_id, expires) VALUES (?, ?, ?)'),
    sessGet: db.prepare(`SELECT a.id, a.username, a.must_change FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
      WHERE s.id_hash = ? AND s.expires > ? AND a.disabled = 0`),
    sessDel: db.prepare('DELETE FROM admin_sessions WHERE id_hash = ?'),
    sessDelAdmin: db.prepare('DELETE FROM admin_sessions WHERE admin_id = ?'),
    sessDelOthers: db.prepare('DELETE FROM admin_sessions WHERE admin_id = ? AND id_hash <> ?'),
    sessPrune: db.prepare('DELETE FROM admin_sessions WHERE expires <= ?'),
  };
  const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');

  return {
    count: () => s.count.get().n,
    list: () => s.list.all(),
    get: (id) => s.byId.get(id),
    byName: (u) => s.byName.get(normUsername(u)),
    audit(admin, action, detail = null) {
      s.audit.run(admin ? admin.id : null, admin ? admin.username : null, action, detail, Date.now());
    },
    auditList: (n = 100) => s.auditList.all(n),

    /** Create an account. Returns {id} or {error}. */
    create({ username, password, mustChange = false, by = null }) {
      const u = normUsername(username);
      if (!validUsername(u)) return { error: USERNAME_RULE };
      const bad = passwordProblem(password, u);
      if (bad) return { error: bad };
      if (s.byName.get(u)) return { error: `"${u}" already exists.` };
      const r = s.insert.run(u, hashPassword(password), mustChange ? 1 : 0, Date.now(), by ? by.id : null);
      return { id: Number(r.lastInsertRowid), username: u };
    },

    /** Check a username and password. Returns the admin row or null. Same work whether or not the user exists. */
    async check(username, password) {
      const row = s.byName.get(normUsername(username));
      const ok = await verifyPasswordAsync(password, row ? row.pw_hash : DUMMY_HASH);
      return row && ok && !row.disabled ? row : null;
    },

    setPassword(id, password, { mustChange = false } = {}) {
      const row = s.byId.get(id);
      const bad = passwordProblem(password, row && row.username);
      if (bad) return { error: bad };
      s.setPassword.run(hashPassword(password), mustChange ? 1 : 0, id);
      return { ok: true };
    },

    /** Disable or enable. Refuses to disable the last active admin. Disabling signs them out. */
    setDisabled(id, disabled) {
      const row = s.byId.get(id);
      if (!row) return { error: 'No such admin.' };
      if (disabled && !row.disabled && s.activeCount.get().n <= 1) return { error: 'Cannot disable the last active admin.' };
      s.setDisabled.run(disabled ? 1 : 0, id);
      if (disabled) s.sessDelAdmin.run(id);
      return { ok: true, username: row.username };
    },

    // sessions: only a hash of the session id is stored
    startSession(adminId, ms) {
      const sid = crypto.randomBytes(32).toString('base64url');
      const now = Date.now();
      s.sessPrune.run(now);
      s.sessAdd.run(sha(sid), adminId, now + ms);
      s.touchLogin.run(now, adminId);
      return sid;
    },
    session: (sid) => (sid ? s.sessGet.get(sha(sid), Date.now()) || null : null),
    endSession: (sid) => { if (sid) s.sessDel.run(sha(sid)); },
    endSessionsOf: (adminId) => s.sessDelAdmin.run(adminId),
    endOtherSessions: (adminId, sid) => s.sessDelOthers.run(adminId, sha(sid)),
  };
}

module.exports = { adminStore, hashPassword, verifyPassword, verifyPasswordAsync, passwordProblem, tempPassword, normUsername, validUsername, USERNAME_RULE };
