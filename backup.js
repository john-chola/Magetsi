// Copies magetsi.db to backups/magetsi-YYYY-MM-DD-HHMM.db. Safe while Magetsi is running:
// VACUUM INTO writes a consistent snapshot, including anything still in the WAL file.
// Keeps the newest BACKUP_KEEP copies (default 30). Usage: npm run backup
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function backup({
  dbFile = process.env.DB_FILE || path.join(__dirname, 'magetsi.db'),
  dir = process.env.BACKUP_DIR || path.join(__dirname, 'backups'),
  keep = Number(process.env.BACKUP_KEEP || 30),
  now = new Date(),
} = {}) {
  if (!fs.existsSync(dbFile)) throw new Error(`Database not found: ${dbFile}`);
  fs.mkdirSync(dir, { recursive: true });
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  let target = path.join(dir, `magetsi-${stamp}.db`);
  for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, `magetsi-${stamp}-${i}.db`);

  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }

  const mtime = (f) => fs.statSync(path.join(dir, f)).mtimeMs;
  const old = fs.readdirSync(dir)
    .filter((f) => /^magetsi-.*\.db$/.test(f))
    .sort((a, b) => mtime(b) - mtime(a) || b.localeCompare(a)) // newest first
    .slice(Math.max(keep, 1));
  for (const f of old) fs.unlinkSync(path.join(dir, f));
  return { target, removed: old };
}

if (require.main === module) {
  try {
    const { target, removed } = backup();
    console.log(`Backup saved: ${target}`);
    if (removed.length) console.log(`Removed ${removed.length} old backup(s).`);
  } catch (err) {
    console.error(`Backup failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { backup };
