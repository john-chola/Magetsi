// Upgrading a database made by the old version (groups A-F shared by all towns, demo data on).
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'magetsi-migrate-'));
const file = path.join(tmp, 'old.db');
{
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE groups (code TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE areas (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, group_code TEXT NOT NULL REFERENCES groups(code), town TEXT NOT NULL DEFAULT 'Lusaka');
    CREATE TABLE slots (id INTEGER PRIMARY KEY AUTOINCREMENT, group_code TEXT NOT NULL REFERENCES groups(code),
      date TEXT NOT NULL, start TEXT NOT NULL, "end" TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'admin', created_at INTEGER NOT NULL,
      UNIQUE (group_code, date, start));
    CREATE TABLE outages (id INTEGER PRIMARY KEY AUTOINCREMENT, area_id INTEGER NOT NULL REFERENCES areas(id), device_id TEXT NOT NULL,
      off_at INTEGER NOT NULL, on_at INTEGER, manual INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    INSERT INTO groups VALUES ('A', 'Group A'), ('D', 'Group D');
    INSERT INTO areas VALUES (6, 'Chelston', 'A', 'Lusaka'), (12, 'Jack Compound', 'A', 'Lusaka'), (2, 'Bauleni', 'D', 'Lusaka');
    INSERT INTO slots (group_code, date, start, "end", source, created_at) VALUES
      ('A', '2026-11-01', '06:00', '10:00', 'demo-rotation', 0), ('D', '2026-11-01', '06:00', '10:00', 'admin', 0);
    INSERT INTO outages (area_id, device_id, off_at, on_at, created_at) VALUES
      (6, 'seed-6-0', 1, 2, 0), (6, 'real-phone-0001', 1, 2, 0), (12, 'real-phone-0001', 3, 4, 0);
  `);
  old.close();
}
process.env.DB_FILE = file;
delete process.env.SEED_DEMO;
const C = require('../public/core.js');
const { db } = require('../server.js');
test.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('areas keep their ids, take real names and groups, and retired ones are hidden', () => {
  const a6 = db.prepare('SELECT * FROM areas WHERE id = 6').get();
  assert.equal(a6.name, 'Chelstone');
  assert.equal(a6.group_code, 'LSK-D');
  assert.equal(a6.retired, 0);
  const a12 = db.prepare('SELECT * FROM areas WHERE id = 12').get();
  assert.equal(a12.retired, 1);
  assert.equal(a12.name, 'Jack Compound (retired #12)');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM areas WHERE retired = 0').get().n, C.AREAS.length);
});

test('old demo data is removed, real reports and admin slots are kept', () => {
  assert.deepEqual(db.prepare('SELECT device_id FROM outages ORDER BY id').all().map((r) => r.device_id), ['real-phone-0001', 'real-phone-0001']);
  assert.deepEqual(db.prepare('SELECT source FROM slots').all().map((r) => r.source), ['admin']);
  assert.equal(db.prepare("SELECT v FROM kv WHERE k = 'data_version'").get().v, '2');
});

test('every per-town group exists', () => {
  const codes = new Set(db.prepare('SELECT code FROM groups').all().map((r) => r.code));
  for (const g of C.GROUPS) assert.ok(codes.has(g.code), g.code);
});
