// Create (or reset) an admin account — for LOCAL use.
// On Vercel, set ADMIN_USER / ADMIN_PASS env vars instead (auto-created on boot).
//
// Usage:  node scripts/create-admin.js  [username]  [password]
require('dotenv').config();
const readline = require('readline');
const bcrypt = require('bcryptjs');
const store = require('../db');

function ask(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    if (hidden) {
      const onData = () => rl.output.write('\x1B[2K\x1B[200D' + question);
      rl.input.on('data', onData);
      rl.question(question, ans => { rl.input.off('data', onData); rl.close(); resolve(ans.trim()); });
    } else {
      rl.question(question, ans => { rl.close(); resolve(ans.trim()); });
    }
  });
}

(async () => {
  await store.init();
  let username = process.argv[2];
  let password = process.argv[3];
  if (!username) username = await ask('Admin username: ');
  if (!password) password = await ask('Admin password: ', { hidden: true });
  username = String(username).trim().toLowerCase();

  if (!username || !password) { console.error('Username and password are required.'); process.exit(1); }

  const hash = bcrypt.hashSync(password, 10);
  const existing = await store.getAdminByUsername(username);
  if (existing) { await store.setAdminPassword(username, hash); console.log(`\n✓ Updated password for admin "${username}".`); }
  else { await store.createAdmin(username, hash); console.log(`\n✓ Created admin "${username}".`); }
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
