'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { backup } = require('../backup.js');

test('backup copies a live WAL database and prunes old copies', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'magetsi-backup-'));
  const dbFile = path.join(tmp, 'live.db');
  const dir = path.join(tmp, 'backups');
  const live = new DatabaseSync(dbFile);
  try {
    live.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES (\'hello\');');

    const first = backup({ dbFile, dir, keep: 2, now: new Date(2026, 10, 5, 9, 30) });
    const copy = new DatabaseSync(first.target, { readOnly: true });
    assert.deepStrictEqual(copy.prepare('SELECT v FROM t').all().map((r) => r.v), ['hello']);
    copy.close();

    backup({ dbFile, dir, keep: 2, now: new Date(2026, 10, 5, 9, 30) }); // same minute: gets a -2 suffix
    const third = backup({ dbFile, dir, keep: 2, now: new Date(2026, 10, 5, 9, 31) });
    assert.strictEqual(third.removed.length, 1);
    assert.strictEqual(fs.readdirSync(dir).length, 2);
  } finally {
    live.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
