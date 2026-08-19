// Inspect and clean up admin accounts.
//
// Point this at the same database the server uses — locally there is nothing to
// do; for the cloud, pass DATABASE_URL=... in front of the command.
//
// Usage:
//   node scripts/admins.js list
//   node scripts/admins.js delete <username>
//   node scripts/admins.js reset  <username> <new-password>
require('dotenv').config();
const bcrypt = require('bcryptjs');
const store = require('../db');

const [, , command, username, password] = process.argv;

(async () => {
  await store.init();
  const backend = store.isPg ? 'Postgres (cloud)' : 'SQLite (local file)';

  if (command === 'list' || !command) {
    const admins = await store.listAdmins();
    console.log(`\nAdmin accounts in ${backend}:`);
    if (!admins.length) console.log('  (none)');
    for (const a of admins) console.log(`  - ${a.username}   created ${a.created_at}`);
    console.log('');
    process.exit(0);
  }

  if (command === 'delete') {
    if (!username) { console.error('Usage: node scripts/admins.js delete <username>'); process.exit(1); }
    const name = String(username).trim().toLowerCase();
    const admins = await store.listAdmins();
    if (!admins.some(a => a.username === name)) {
      console.log(`\nNo admin named "${name}" in ${backend}. Nothing to do.\n`);
      process.exit(0);
    }
    // Refuse to leave the panel with no way in.
    if (admins.length === 1) {
      console.error('\nThat is the only admin account. Create another one first (npm run init-admin),');
      console.error('otherwise nobody can sign in to the panel.\n');
      process.exit(1);
    }
    await store.deleteAdmin(name);
    console.log(`\n✓ Deleted admin "${name}" from ${backend}.\n`);
    process.exit(0);
  }

  if (command === 'reset') {
    if (!username || !password) { console.error('Usage: node scripts/admins.js reset <username> <new-password>'); process.exit(1); }
    if (password.length < 12) { console.error('Choose a password of at least 12 characters.'); process.exit(1); }
    const name = String(username).trim().toLowerCase();
    if (!(await store.getAdminByUsername(name))) { console.error(`No admin named "${name}".`); process.exit(1); }
    await store.setAdminPassword(name, bcrypt.hashSync(password, 10));
    console.log(`\n✓ Password reset for admin "${name}" in ${backend}.\n`);
    process.exit(0);
  }

  console.error('Usage: node scripts/admins.js [list | delete <username> | reset <username> <new-password>]');
  process.exit(1);
})().catch(err => { console.error(err); process.exit(1); });
