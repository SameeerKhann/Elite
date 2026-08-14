// Data layer for Elite.
//
// Dual-mode:
//   • If a cloud Postgres URL is present (DATABASE_URL / POSTGRES_URL) — used on
//     Vercel with Neon — every query runs against Postgres.
//   • Otherwise it falls back to local SQLite (Node's built-in node:sqlite),
//     which is perfect for offline local development and testing.
//
// The rest of the app only calls the async functions exported at the bottom, so
// it never has to care which backend is active.

const PG_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL || '';
const isPg = !!PG_URL;

let pgPool = null;
let sq = null;

if (isPg) {
  const { Pool } = require('pg');
  const ssl = /localhost|127\.0\.0\.1/.test(PG_URL) ? false : { rejectUnauthorized: false };
  pgPool = new Pool({ connectionString: PG_URL, ssl, max: 3 });
} else {
  const path = require('path');
  const { DatabaseSync } = require('node:sqlite');
  sq = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'dialerkiosk.db'));
  sq.exec('PRAGMA journal_mode = WAL;');
}

// --- tiny query helpers -----------------------------------------------------
// Postgres: async, $1 placeholders. SQLite: sync under the hood, ? placeholders.
async function pgAll(text, params = []) { return (await pgPool.query(text, params)).rows; }
async function pgOne(text, params = []) { return (await pgPool.query(text, params)).rows[0]; }

function sqlAll(text, params = []) { return sq.prepare(text).all(...params); }
function sqlOne(text, params = []) { return sq.prepare(text).get(...params); }
function sqlRun(text, params = []) { return sq.prepare(text).run(...params); }

// ---------------------------------------------------------------------------
// Schema + seed
// ---------------------------------------------------------------------------
async function init() {
  if (isPg) {
    await pgAll(`CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pgAll(`CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pgAll(`CREATE TABLE IF NOT EXISTS shifts (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      machine_id TEXT NOT NULL DEFAULT '',
      login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      logout_at TIMESTAMPTZ)`);
    await pgAll(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL)`);
    // Defensive: add notes column if this DB predates it.
    await pgAll(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT ''`);
  } else {
    sq.exec(`
      CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
        full_name TEXT NOT NULL DEFAULT '', password_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1, notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS shifts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL,
        username TEXT NOT NULL, machine_id TEXT NOT NULL DEFAULT '',
        login_at TEXT NOT NULL DEFAULT (datetime('now')), logout_at TEXT);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    try { sq.exec("ALTER TABLE employees ADD COLUMN notes TEXT NOT NULL DEFAULT ''"); } catch {}
  }

  // Seed default settings (only if missing).
  await setSettingIfMissing('dialer_url', process.env.DIALER_URL || 'https://example.com');
  await setSettingIfMissing('allowed_domains', process.env.ALLOWED_DOMAINS || 'example.com');
  await setSettingIfMissing('tabs', '');

  // Auto-create the first admin from env vars (needed on Vercel where you can't
  // run an interactive script). Only fires when there are zero admins.
  if (process.env.ADMIN_USER && process.env.ADMIN_PASS && (await countAdmins()) === 0) {
    const bcrypt = require('bcryptjs');
    await createAdmin(String(process.env.ADMIN_USER).trim().toLowerCase(), bcrypt.hashSync(String(process.env.ADMIN_PASS), 10));
    console.log(`Seeded admin "${process.env.ADMIN_USER}" from ADMIN_USER/ADMIN_PASS.`);
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
async function getSetting(key, fallback = '') {
  const row = isPg ? await pgOne('SELECT value FROM settings WHERE key = $1', [key])
                   : sqlOne('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : fallback;
}
async function setSetting(key, value) {
  if (isPg) await pgAll('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
  else sqlRun('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
}
async function setSettingIfMissing(key, value) {
  if (isPg) await pgAll('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, value]);
  else if (!sqlOne('SELECT 1 FROM settings WHERE key = ?', [key])) sqlRun('INSERT INTO settings (key, value) VALUES (?, ?)', [key, value]);
}

// ---------------------------------------------------------------------------
// Admins
// ---------------------------------------------------------------------------
async function getAdminByUsername(u) {
  return isPg ? await pgOne('SELECT * FROM admins WHERE username = $1', [u])
              : sqlOne('SELECT * FROM admins WHERE username = ?', [u]);
}
async function countAdmins() {
  if (isPg) return (await pgOne('SELECT COUNT(*)::int AS c FROM admins')).c;
  return sqlOne('SELECT COUNT(*) AS c FROM admins').c;
}
async function createAdmin(username, hash) {
  if (isPg) await pgAll('INSERT INTO admins (username, password_hash) VALUES ($1, $2) ON CONFLICT (username) DO NOTHING', [username, hash]);
  else sqlRun('INSERT INTO admins (username, password_hash) VALUES (?, ?)', [username, hash]);
}
async function setAdminPassword(username, hash) {
  if (isPg) await pgAll('UPDATE admins SET password_hash = $1 WHERE username = $2', [hash, username]);
  else sqlRun('UPDATE admins SET password_hash = ? WHERE username = ?', [hash, username]);
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------
async function getEmployeeByUsername(u) {
  return isPg ? await pgOne('SELECT * FROM employees WHERE username = $1', [u])
              : sqlOne('SELECT * FROM employees WHERE username = ?', [u]);
}
async function listEmployees() {
  const sql = 'SELECT id, username, full_name, active, created_at FROM employees ORDER BY username';
  return isPg ? await pgAll(sql) : sqlAll(sql);
}
async function employeeExists(u) {
  return !!(isPg ? await pgOne('SELECT id FROM employees WHERE username = $1', [u])
                 : sqlOne('SELECT id FROM employees WHERE username = ?', [u]));
}
async function createEmployee(username, fullName, hash) {
  if (isPg) await pgAll('INSERT INTO employees (username, full_name, password_hash) VALUES ($1, $2, $3)', [username, fullName, hash]);
  else sqlRun('INSERT INTO employees (username, full_name, password_hash) VALUES (?, ?, ?)', [username, fullName, hash]);
}
async function setEmployeePassword(id, hash) {
  if (isPg) await pgAll('UPDATE employees SET password_hash = $1 WHERE id = $2', [hash, id]);
  else sqlRun('UPDATE employees SET password_hash = ? WHERE id = ?', [hash, id]);
}
async function toggleEmployee(id) {
  const sql = 'UPDATE employees SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END WHERE id = ' + (isPg ? '$1' : '?');
  if (isPg) await pgAll(sql, [id]); else sqlRun(sql, [id]);
}
async function setNotes(employeeId, notes) {
  if (isPg) await pgAll('UPDATE employees SET notes = $1 WHERE id = $2', [notes, employeeId]);
  else sqlRun('UPDATE employees SET notes = ? WHERE id = ?', [notes, employeeId]);
}

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------
async function createShift(employeeId, username, machineId) {
  if (isPg) {
    const row = await pgOne('INSERT INTO shifts (employee_id, username, machine_id) VALUES ($1, $2, $3) RETURNING id', [employeeId, username, machineId]);
    return row.id;
  }
  return Number(sqlRun('INSERT INTO shifts (employee_id, username, machine_id) VALUES (?, ?, ?)', [employeeId, username, machineId]).lastInsertRowid);
}
async function closeShift(shiftId) {
  if (isPg) await pgAll('UPDATE shifts SET logout_at = NOW() WHERE id = $1 AND logout_at IS NULL', [shiftId]);
  else sqlRun("UPDATE shifts SET logout_at = datetime('now') WHERE id = ? AND logout_at IS NULL", [shiftId]);
}
async function countEmployees() {
  if (isPg) return (await pgOne('SELECT COUNT(*)::int AS c FROM employees')).c;
  return sqlOne('SELECT COUNT(*) AS c FROM employees').c;
}
async function countOpenShifts() {
  if (isPg) return (await pgOne('SELECT COUNT(*)::int AS c FROM shifts WHERE logout_at IS NULL')).c;
  return sqlOne('SELECT COUNT(*) AS c FROM shifts WHERE logout_at IS NULL').c;
}
async function listOpenShifts() {
  if (isPg) return await pgAll(`SELECT username, machine_id,
      to_char(login_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS login_at
      FROM shifts WHERE logout_at IS NULL ORDER BY login_at DESC`);
  return sqlAll('SELECT username, machine_id, login_at FROM shifts WHERE logout_at IS NULL ORDER BY login_at DESC');
}
async function listShifts(limit = 500) {
  if (isPg) return await pgAll(`SELECT username, machine_id,
      to_char(login_at  AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS login_at,
      to_char(logout_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS logout_at,
      CASE WHEN logout_at IS NULL THEN NULL
           ELSE ROUND(EXTRACT(EPOCH FROM (logout_at - login_at)) / 60)::int END AS minutes
      FROM shifts ORDER BY login_at DESC LIMIT $1`, [limit]);
  return sqlAll(`SELECT username, machine_id, login_at, logout_at,
      CASE WHEN logout_at IS NULL THEN NULL
           ELSE CAST((julianday(logout_at) - julianday(login_at)) * 24 * 60 AS INTEGER) END AS minutes
      FROM shifts ORDER BY login_at DESC LIMIT ?`, [limit]);
}

module.exports = {
  isPg, init,
  getSetting, setSetting,
  getAdminByUsername, countAdmins, createAdmin, setAdminPassword,
  getEmployeeByUsername, listEmployees, employeeExists, createEmployee,
  setEmployeePassword, toggleEmployee, setNotes,
  createShift, closeShift,
  countEmployees, countOpenShifts, listOpenShifts, listShifts,
};
