// Sets the kiosk exit code for THIS build.
//
// The code you type is never written anywhere. We store a random salt and a
// scrypt hash of the code in kiosk/config.json, and the app verifies against
// those. Anyone reading the source (or the shipped config.json) learns nothing
// that releases a machine.
//
// Usage:
//   cd kiosk && npm run set-exit-code
//   cd kiosk && npm run set-exit-code -- 'the-code'      (non-interactive)
//
// Run this BEFORE `npm run build`, so the hash is baked into the installer.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const KEYLEN = 32;
const MIN_LENGTH = 10;
// SHA-256 of codes that must never be set again.
const RETIRED = ['11e9f36d474170e5f280579b9d2ed2314e54e31536889922c732447e5f85065c'];

function askHidden(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const mute = () => rl.output.write('\x1B[2K\x1B[200D' + question);
    rl.input.on('data', mute);
    rl.question(question, (answer) => {
      rl.input.off('data', mute);
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

(async () => {
  let code = process.argv[2];
  if (!code) {
    code = await askHidden('New exit code: ');
    const again = await askHidden('Confirm exit code: ');
    if (code !== again) {
      console.error('\nThose did not match. Nothing was changed.');
      process.exit(1);
    }
  }

  if (!code || code.length < MIN_LENGTH) {
    console.error(`\nExit code must be at least ${MIN_LENGTH} characters. Nothing was changed.`);
    process.exit(1);
  }
  if (RETIRED.includes(crypto.createHash('sha256').update(code).digest('hex'))) {
    console.error('\nThat code has been retired and cannot be reused. Pick a different one.');
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const salt = crypto.randomBytes(16).toString('hex');
  config.exitCodeSalt = salt;
  config.exitCodeHash = crypto.scryptSync(code, salt, KEYLEN).toString('hex');
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');

  console.log('\n✓ Exit code set in kiosk/config.json (stored as a salted hash).');
  console.log('  Record the code somewhere safe — it cannot be recovered from the file.');
  console.log('  Rebuild the app (npm run build) so installed PCs pick it up.');
})().catch((err) => { console.error(err); process.exit(1); });
