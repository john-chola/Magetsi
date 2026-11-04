// Manage admin accounts from the server's command line (e.g. if every admin is locked out).
//   npm run admin -- list
//   npm run admin -- create <username>     prints a temporary password
//   npm run admin -- reset <username>      new temporary password, signs them out
//   npm run admin -- disable <username>
//   npm run admin -- enable <username>
// Uses DB_FILE (default ./magetsi.db), the same database as the server.
'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { adminStore, tempPassword } = require('./lib/admins.js');

function main(argv, { dbFile = process.env.DB_FILE || path.join(__dirname, 'magetsi.db'), log = console.log } = {}) {
  const [cmd, name] = argv;
  const db = new DatabaseSync(dbFile);
  try {
    const admins = adminStore(db);
    const cli = { id: null, username: 'command-line' };
    const need = () => {
      const a = admins.byName(name || '');
      if (!a) throw new Error(`No admin called "${name || ''}". Run "list" to see them.`);
      return a;
    };

    if (cmd === 'list') {
      const rows = admins.list();
      if (!rows.length) log('No admins yet. Create one with: npm run admin -- create <username>');
      for (const a of rows) {
        log(`${a.username.padEnd(24)} ${a.disabled ? 'disabled' : a.must_change ? 'must set password' : 'active'}` +
          `   last sign-in: ${a.last_login ? new Date(a.last_login).toISOString() : 'never'}`);
      }
      return 0;
    }
    if (cmd === 'create') {
      const pw = tempPassword();
      const r = admins.create({ username: name, password: pw, mustChange: true });
      if (r.error) throw new Error(r.error);
      admins.audit(cli, 'admin-create', r.username);
      log(`Created admin "${r.username}". Temporary password: ${pw}`);
      log('Sign in at /admin; you will be asked to choose your own password.');
      return 0;
    }
    if (cmd === 'reset') {
      const a = need();
      const pw = tempPassword();
      admins.setPassword(a.id, pw, { mustChange: true });
      admins.endSessionsOf(a.id);
      if (a.disabled) admins.setDisabled(a.id, false);
      admins.audit(cli, 'admin-reset-password', a.username);
      log(`New temporary password for "${a.username}": ${pw}${a.disabled ? ' (account re-enabled)' : ''}`);
      return 0;
    }
    if (cmd === 'disable' || cmd === 'enable') {
      const a = need();
      const r = admins.setDisabled(a.id, cmd === 'disable');
      if (r.error) throw new Error(r.error);
      admins.audit(cli, 'admin-' + cmd, a.username);
      log(`"${a.username}" ${cmd}d.`);
      return 0;
    }
    log('Usage: npm run admin -- list | create <username> | reset <username> | disable <username> | enable <username>');
    return cmd ? 1 : 0;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (e) { console.error('Error: ' + e.message); process.exitCode = 1; }
}
module.exports = { main };
