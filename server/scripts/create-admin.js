// Interactive script to create (or reset) an admin account.
// Usage:  node scripts/create-admin.js  [username]  [password]
// If username/password are omitted it will prompt for them.
require('dotenv').config();
const readline = require('readline');
const bcrypt = require('bcryptjs');
const { db } = require('../db');

function ask(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    if (hidden) {
      // Mask typed characters for the password.
      const onData = () => (rl.output.write('\x1B[2K\x1B[200D' + question));
      rl.input.on('data', onData);
      rl.question(question, ans => { rl.input.off('data', onData); rl.close(); resolve(ans.trim()); });
    } else {
      rl.question(question, ans => { rl.close(); resolve(ans.trim()); });
    }
  });
}

(async () => {
  let username = process.argv[2];
  let password = process.argv[3];
  if (!username) username = await ask('Admin username: ');
  if (!password) password = await ask('Admin password: ', { hidden: true });
  username = String(username).trim().toLowerCase();

  if (!username || !password) {
    console.error('Username and password are required.');
    process.exit(1);
  }

  const hash = bcrypt.hashSync(password, 10);
  const existing = db.prepare('SELECT id FROM admins WHERE username = ?').get(username);
  if (existing) {
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hash, existing.id);
    console.log(`\n✓ Updated password for admin "${username}".`);
  } else {
    db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(username, hash);
    console.log(`\n✓ Created admin "${username}".`);
  }
  process.exit(0);
})();
