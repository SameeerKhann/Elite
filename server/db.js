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

// Postgres pool is created lazily (no connection until first query).
function pg() {
  if (!pgPool) {
    const { Pool } = require('pg');
    const ssl = /localhost|127\.0\.0\.1/.test(PG_URL) ? false : { rejectUnauthorized: false };
    pgPool = new Pool({ connectionString: PG_URL, ssl, max: 3 });
  }
  return pgPool;
}

// SQLite is created lazily too — it touches the filesystem, which is read-only
// on serverless hosts, so we must not create it at module load (that would
// crash the whole app before it can report a useful error).
function sqlite() {
  if (!sq) {
    const path = require('path');
    const { DatabaseSync } = require('node:sqlite');
    sq = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'dialerkiosk.db'));
    sq.exec('PRAGMA journal_mode = WAL;');
  }
  return sq;
}

// --- tiny query helpers -----------------------------------------------------
// Postgres: async, $1 placeholders. SQLite: sync under the hood, ? placeholders.
async function pgAll(text, params = []) { return (await pg().query(text, params)).rows; }
async function pgOne(text, params = []) { return (await pg().query(text, params)).rows[0]; }

function sqlAll(text, params = []) { return sqlite().prepare(text).all(...params); }
function sqlOne(text, params = []) { return sqlite().prepare(text).get(...params); }
function sqlRun(text, params = []) { return sqlite().prepare(text).run(...params); }

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
    await pgAll(`CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      thread TEXT NOT NULL DEFAULT 'group',
      employee_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    // Defensive migrations for databases created before these columns existed.
    await pgAll(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT ''`);
    await pgAll(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread TEXT NOT NULL DEFAULT 'group'`);
    await pgAll(`CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread, id)`);
    await pgAll(`CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pgAll(`CREATE TABLE IF NOT EXISTS room_members (
      room_id INTEGER NOT NULL, employee_id INTEGER NOT NULL, PRIMARY KEY (room_id, employee_id))`);
    await pgAll(`CREATE TABLE IF NOT EXISTS read_state (
      employee_id INTEGER NOT NULL, thread TEXT NOT NULL, last_read_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (employee_id, thread))`);
  } else {
    sqlite().exec(`
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
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, thread TEXT NOT NULL DEFAULT 'group',
        employee_id INTEGER NOT NULL, username TEXT NOT NULL, body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS rooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS room_members (
        room_id INTEGER NOT NULL, employee_id INTEGER NOT NULL, PRIMARY KEY (room_id, employee_id));
      CREATE TABLE IF NOT EXISTS read_state (
        employee_id INTEGER NOT NULL, thread TEXT NOT NULL, last_read_id INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (employee_id, thread));
    `);
    try { sqlite().exec("ALTER TABLE employees ADD COLUMN notes TEXT NOT NULL DEFAULT ''"); } catch {}
    try { sqlite().exec("ALTER TABLE messages ADD COLUMN thread TEXT NOT NULL DEFAULT 'group'"); } catch {}
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

  // Bootstrap admin — created only if NO admin exists yet (so it never
  // overwrites a real one). Username "sam". Change this password soon.
  if ((await countAdmins()) === 0) {
    await createAdmin('sam', '$2a$10$UrIOaIO9ULb/lTS0C7FOCu.g8WyU99KsUSbxLLEqUG4r10qHyXIya'); // pw: Sam123
    console.log('Seeded bootstrap admin "sam".');
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

// ---------------------------------------------------------------------------
// Elite Internal — team chat (append-only; auto-purged after 7 days)
// ---------------------------------------------------------------------------
async function addMessage(employeeId, username, body, thread = 'group') {
  if (isPg) {
    const row = await pgOne('INSERT INTO messages (thread, employee_id, username, body) VALUES ($1, $2, $3, $4) RETURNING id', [thread, employeeId, username, body]);
    return row.id;
  }
  return Number(sqlRun('INSERT INTO messages (thread, employee_id, username, body) VALUES (?, ?, ?, ?)', [thread, employeeId, username, body]).lastInsertRowid);
}
async function listMessages(thread = 'group', sinceId = 0, limit = 100) {
  sinceId = Number(sinceId) || 0;
  if (isPg) {
    const ts = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
    if (sinceId > 0) return await pgAll(`SELECT id, username, body, ${ts} AS created_at FROM messages WHERE thread = $1 AND id > $2 ORDER BY id ASC LIMIT $3`, [thread, sinceId, limit]);
    return (await pgAll(`SELECT id, username, body, ${ts} AS created_at FROM messages WHERE thread = $1 ORDER BY id DESC LIMIT $2`, [thread, limit])).reverse();
  }
  if (sinceId > 0) return sqlAll('SELECT id, username, body, created_at FROM messages WHERE thread = ? AND id > ? ORDER BY id ASC LIMIT ?', [thread, sinceId, limit]);
  return sqlAll('SELECT id, username, body, created_at FROM messages WHERE thread = ? ORDER BY id DESC LIMIT ?', [thread, limit]).reverse();
}
// 7-day retention: called opportunistically whenever a message is sent.
async function purgeOldMessages() {
  if (isPg) await pgAll("DELETE FROM messages WHERE created_at < NOW() - INTERVAL '7 days'");
  else sqlRun("DELETE FROM messages WHERE created_at < datetime('now', '-7 days')");
}

// --- Rooms (admin-managed team channels) -----------------------------------
async function createRoom(name) {
  if (isPg) return (await pgOne('INSERT INTO rooms (name) VALUES ($1) RETURNING id', [name])).id;
  return Number(sqlRun('INSERT INTO rooms (name) VALUES (?)', [name]).lastInsertRowid);
}
async function deleteRoom(id) {
  if (isPg) { await pgAll('DELETE FROM room_members WHERE room_id = $1', [id]); await pgAll('DELETE FROM rooms WHERE id = $1', [id]); }
  else { sqlRun('DELETE FROM room_members WHERE room_id = ?', [id]); sqlRun('DELETE FROM rooms WHERE id = ?', [id]); }
}
async function listRooms() {
  const sql = 'SELECT id, name FROM rooms ORDER BY name';
  return isPg ? await pgAll(sql) : sqlAll(sql);
}
async function addRoomMember(roomId, empId) {
  if (isPg) await pgAll('INSERT INTO room_members (room_id, employee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [roomId, empId]);
  else sqlRun('INSERT OR IGNORE INTO room_members (room_id, employee_id) VALUES (?, ?)', [roomId, empId]);
}
async function setRoomMembers(roomId, empIds) {
  if (isPg) await pgAll('DELETE FROM room_members WHERE room_id = $1', [roomId]);
  else sqlRun('DELETE FROM room_members WHERE room_id = ?', [roomId]);
  for (const id of empIds) await addRoomMember(roomId, Number(id));
}
async function listRoomMemberIds(roomId) {
  const rows = isPg ? await pgAll('SELECT employee_id FROM room_members WHERE room_id = $1', [roomId])
                    : sqlAll('SELECT employee_id FROM room_members WHERE room_id = ?', [roomId]);
  return rows.map(r => r.employee_id);
}
async function listRoomsForEmployee(empId) {
  const sql = isPg
    ? 'SELECT r.id, r.name FROM rooms r JOIN room_members m ON m.room_id = r.id WHERE m.employee_id = $1 ORDER BY r.name'
    : 'SELECT r.id, r.name FROM rooms r JOIN room_members m ON m.room_id = r.id WHERE m.employee_id = ? ORDER BY r.name';
  return isPg ? await pgAll(sql, [empId]) : sqlAll(sql, [empId]);
}
async function isRoomMember(roomId, empId) {
  const row = isPg ? await pgOne('SELECT 1 AS x FROM room_members WHERE room_id = $1 AND employee_id = $2', [roomId, empId])
                   : sqlOne('SELECT 1 AS x FROM room_members WHERE room_id = ? AND employee_id = ?', [roomId, empId]);
  return !!row;
}

// --- Unread / read-state / presence ----------------------------------------
async function getReadState(empId) {
  const rows = isPg ? await pgAll('SELECT thread, last_read_id FROM read_state WHERE employee_id = $1', [empId])
                    : sqlAll('SELECT thread, last_read_id FROM read_state WHERE employee_id = ?', [empId]);
  const map = {};
  for (const r of rows) map[r.thread] = r.last_read_id;
  return map;
}
async function setReadState(empId, thread, lastId) {
  if (isPg) await pgAll(`INSERT INTO read_state (employee_id, thread, last_read_id) VALUES ($1, $2, $3)
    ON CONFLICT (employee_id, thread) DO UPDATE SET last_read_id = GREATEST(read_state.last_read_id, EXCLUDED.last_read_id)`, [empId, thread, lastId]);
  else sqlRun(`INSERT INTO read_state (employee_id, thread, last_read_id) VALUES (?, ?, ?)
    ON CONFLICT (employee_id, thread) DO UPDATE SET last_read_id = MAX(read_state.last_read_id, excluded.last_read_id)`, [empId, thread, lastId]);
}
async function maxMessageId(thread) {
  const row = isPg ? await pgOne('SELECT COALESCE(MAX(id),0)::int AS m FROM messages WHERE thread = $1', [thread])
                   : sqlOne('SELECT COALESCE(MAX(id),0) AS m FROM messages WHERE thread = ?', [thread]);
  return row ? row.m : 0;
}
async function unreadCount(thread, empId, lastReadId) {
  if (isPg) return (await pgOne('SELECT COUNT(*)::int AS c FROM messages WHERE thread = $1 AND id > $2 AND employee_id <> $3', [thread, lastReadId, empId])).c;
  return sqlOne('SELECT COUNT(*) AS c FROM messages WHERE thread = ? AND id > ? AND employee_id <> ?', [thread, lastReadId, empId]).c;
}
// Unread counts for MANY threads in ONE query (replaces N per-thread queries).
// Returns { thread: count } only for threads that have unread messages.
async function unreadByThreads(empId, threads) {
  if (!threads || !threads.length) return {};
  let rows;
  if (isPg) {
    rows = await pgAll(
      `SELECT m.thread AS thread, COUNT(*)::int AS unread
       FROM messages m
       LEFT JOIN read_state r ON r.employee_id = $1 AND r.thread = m.thread
       WHERE m.employee_id <> $1 AND m.id > COALESCE(r.last_read_id, 0) AND m.thread = ANY($2::text[])
       GROUP BY m.thread`, [empId, threads]);
  } else {
    const ph = threads.map(() => '?').join(',');
    rows = sqlAll(
      `SELECT m.thread AS thread, COUNT(*) AS unread
       FROM messages m
       LEFT JOIN read_state r ON r.employee_id = ? AND r.thread = m.thread
       WHERE m.employee_id <> ? AND m.id > COALESCE(r.last_read_id, 0) AND m.thread IN (${ph})
       GROUP BY m.thread`, [empId, empId, ...threads]);
  }
  const map = {};
  for (const r of rows) map[r.thread] = r.unread;
  return map;
}
async function listOnlineUsernames() {
  const rows = isPg ? await pgAll('SELECT DISTINCT username FROM shifts WHERE logout_at IS NULL')
                    : sqlAll('SELECT DISTINCT username FROM shifts WHERE logout_at IS NULL');
  return rows.map(r => r.username);
}

// --- Admin conversation viewer ---------------------------------------------
async function listThreadsWithMeta() {
  const sql = isPg
    ? `SELECT thread, COUNT(*)::int AS count, MAX(id) AS last_id FROM messages GROUP BY thread ORDER BY MAX(id) DESC`
    : `SELECT thread, COUNT(*) AS count, MAX(id) AS last_id FROM messages GROUP BY thread ORDER BY MAX(id) DESC`;
  return isPg ? await pgAll(sql) : sqlAll(sql);
}
async function listMessagesByThread(thread, limit = 500) {
  return listMessages(thread, 0, limit);
}

module.exports = {
  isPg, init,
  getSetting, setSetting,
  getAdminByUsername, countAdmins, createAdmin, setAdminPassword,
  getEmployeeByUsername, listEmployees, employeeExists, createEmployee,
  setEmployeePassword, toggleEmployee, setNotes,
  createShift, closeShift,
  countEmployees, countOpenShifts, listOpenShifts, listShifts,
  addMessage, listMessages, purgeOldMessages,
  createRoom, deleteRoom, listRooms, addRoomMember, setRoomMembers,
  listRoomMemberIds, listRoomsForEmployee, isRoomMember,
  getReadState, setReadState, maxMessageId, unreadCount, unreadByThreads, listOnlineUsernames,
  listThreadsWithMeta, listMessagesByThread,
};
