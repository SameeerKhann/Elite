// SQLite database layer for DialerKiosk.
// Uses Node's built-in SQLite (node:sqlite) — no native build tools, no external
// database server. One file on disk, good for easy rollout.
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'dialerkiosk.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

// --- Schema -----------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS employees (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    full_name     TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS shifts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id  INTEGER NOT NULL,
    username     TEXT NOT NULL,
    machine_id   TEXT NOT NULL DEFAULT '',
    login_at     TEXT NOT NULL DEFAULT (datetime('now')),
    logout_at    TEXT,
    FOREIGN KEY (employee_id) REFERENCES employees(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Seed default settings if missing (server .env provides initial values).
function seedSetting(key, value) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
}
seedSetting('dialer_url', process.env.DIALER_URL || 'https://example.com');
seedSetting('allowed_domains', process.env.ALLOWED_DOMAINS || 'example.com');
seedSetting('tabs', ''); // JSON array of {label,url}; empty => fall back to dialer_url

// Migration: per-agent sticky notes column (added to existing databases too).
try { db.exec("ALTER TABLE employees ADD COLUMN notes TEXT NOT NULL DEFAULT ''"); } catch {}

module.exports = { db };
