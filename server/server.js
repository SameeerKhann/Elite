require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const { renderPage, adminLoginPage } = require('./views/templates');

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-insecure-session-change-me';
const SHIFT_TOKEN_HOURS = Number(process.env.SHIFT_TOKEN_HOURS || 12);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(SESSION_SECRET));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

// Rate limit login endpoints to slow down password guessing.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true });

// Extract a clean domain (hostname) from a single entry. Accepts either a bare
// domain ("elitetrackers.i5.tel") or a full URL with any path/query after it
// ("https://elitetrackers.i5.tel/agc/vicidial.php#foo") and returns just the
// domain. A leading "www." is stripped so every subdomain matches. Returns null
// for anything that isn't a plausible domain (so typos like "Dailer" drop out).
function extractDomain(entry) {
  let t = String(entry || '').trim().toLowerCase();
  if (!t) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(t)) t = 'https://' + t; // add scheme so URL() parses
  let host;
  try { host = new URL(t).hostname; } catch { return null; }
  host = host.replace(/^www\./, '');
  if (!host || (!host.includes('.') && host !== 'localhost')) return null; // needs a dot
  return host;
}

// Turn a free-form list (commas, spaces, semicolons, or newlines; domains or
// full URLs) into a clean, de-duplicated, comma-separated list of domains.
// `alwaysInclude` is a URL/domain that is forced into the list (the Dialer's
// own domain), so it can never be accidentally left out.
function normalizeDomains(raw, alwaysInclude) {
  const out = [];
  const push = (d) => { if (d && !out.includes(d)) out.push(d); };
  push(extractDomain(alwaysInclude));
  String(raw || '')
    .split(/[\s,;]+/)
    .forEach(tok => push(extractDomain(tok)));
  return out.join(', ');
}

// Parse the admin "tabs" textarea into [{label, url}]. Each non-empty line is
// "Label | https://url" or just "https://url" (label defaults to the domain).
function parseTabs(raw) {
  const tabs = [];
  String(raw || '').split(/\r?\n/).forEach(line => {
    line = line.trim();
    if (!line) return;
    let label = '', url = line;
    const bar = line.indexOf('|');
    if (bar > -1) { label = line.slice(0, bar).trim(); url = line.slice(bar + 1).trim(); }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;
    const dom = extractDomain(url);
    if (!dom) return; // skip invalid lines
    tabs.push({ label: label || dom, url });
  });
  return tabs;
}

// Current tabs list. Falls back to a single "Dialer" tab from dialer_url so
// existing setups keep working before any tabs are configured.
function getTabs() {
  try {
    const arr = JSON.parse(getSetting('tabs', '[]') || '[]');
    if (Array.isArray(arr) && arr.length) return arr;
  } catch {}
  const du = getSetting('dialer_url');
  return du ? [{ label: 'Dialer', url: du }] : [];
}

// ---------------------------------------------------------------------------
// Kiosk API (called by the Electron client on each PC)
// ---------------------------------------------------------------------------

// Employee logs in at the start of a shift.
app.post('/api/kiosk/login', loginLimiter, (req, res) => {
  const { username, password, machineId } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Username and password are required.' });
  }
  const emp = db.prepare('SELECT * FROM employees WHERE username = ?').get(String(username).trim().toLowerCase());
  if (!emp || !emp.active) {
    return res.status(401).json({ ok: false, error: 'Invalid login or account disabled.' });
  }
  if (!bcrypt.compareSync(password, emp.password_hash)) {
    return res.status(401).json({ ok: false, error: 'Invalid login or account disabled.' });
  }

  // Record the shift (clock-in).
  const info = db.prepare(
    'INSERT INTO shifts (employee_id, username, machine_id) VALUES (?, ?, ?)'
  ).run(emp.id, emp.username, String(machineId || ''));

  const token = jwt.sign(
    { sub: emp.id, username: emp.username, shiftId: Number(info.lastInsertRowid) },
    JWT_SECRET,
    { expiresIn: `${SHIFT_TOKEN_HOURS}h` }
  );

  const tabs = getTabs();
  res.json({
    ok: true,
    token,
    employee: { username: emp.username, fullName: emp.full_name },
    dialerUrl: tabs[0] ? tabs[0].url : getSetting('dialer_url'), // back-compat
    tabs,                       // [{label, url}] — the sites that open as tabs
    notes: emp.notes || '',     // this agent's saved sticky notes
    allowedDomains: getSetting('allowed_domains').split(',').map(s => s.trim()).filter(Boolean),
  });
});

// Employee logs out / ends the shift.
app.post('/api/kiosk/logout', (req, res) => {
  const { token } = req.body || {};
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    db.prepare("UPDATE shifts SET logout_at = datetime('now') WHERE id = ? AND logout_at IS NULL")
      .run(payload.shiftId);
    res.json({ ok: true });
  } catch {
    res.json({ ok: true }); // token expired/invalid — treat as already logged out
  }
});

// Auto-save the logged-in agent's sticky notes (called on a debounce as they type).
app.post('/api/kiosk/notes', (req, res) => {
  const { token, notes } = req.body || {};
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    db.prepare('UPDATE employees SET notes = ? WHERE id = ?').run(String(notes == null ? '' : notes), payload.sub);
    res.json({ ok: true });
  } catch {
    res.status(401).json({ ok: false, error: 'Session expired.' });
  }
});

// Kiosk fetches current config (dialer URL + allowed domains) without logging in.
app.get('/api/kiosk/config', (req, res) => {
  res.json({
    ok: true,
    dialerUrl: getSetting('dialer_url'),
    allowedDomains: getSetting('allowed_domains').split(',').map(s => s.trim()).filter(Boolean),
  });
});

// ---------------------------------------------------------------------------
// Admin authentication (cookie session)
// ---------------------------------------------------------------------------
function issueAdminCookie(res, admin) {
  const token = jwt.sign({ adminId: admin.id, username: admin.username }, SESSION_SECRET, { expiresIn: '8h' });
  res.cookie('admin_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 8 * 3600 * 1000 });
}
function requireAdmin(req, res, next) {
  const token = req.cookies.admin_session;
  if (!token) return res.redirect('/admin/login');
  try {
    req.admin = jwt.verify(token, SESSION_SECRET);
    next();
  } catch {
    res.clearCookie('admin_session');
    res.redirect('/admin/login');
  }
}

app.get('/admin/login', (req, res) => res.send(adminLoginPage()));

app.post('/admin/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(String(username || '').trim().toLowerCase());
  if (!admin || !bcrypt.compareSync(password || '', admin.password_hash)) {
    return res.send(adminLoginPage('Invalid username or password.'));
  }
  issueAdminCookie(res, admin);
  res.redirect('/admin');
});

app.post('/admin/logout', requireAdmin, (req, res) => {
  res.clearCookie('admin_session');
  res.redirect('/admin/login');
});

// ---------------------------------------------------------------------------
// Admin panel pages
// ---------------------------------------------------------------------------
app.get('/', (req, res) => res.redirect('/admin'));

app.get('/admin', requireAdmin, (req, res) => {
  const totalEmployees = db.prepare('SELECT COUNT(*) c FROM employees').get().c;
  const activeShifts = db.prepare('SELECT COUNT(*) c FROM shifts WHERE logout_at IS NULL').get().c;
  const onlineNow = db.prepare(
    `SELECT username, machine_id, login_at FROM shifts WHERE logout_at IS NULL ORDER BY login_at DESC`
  ).all();
  const tabsText = getTabs().map(t => `${t.label} | ${t.url}`).join('\n');
  res.send(renderPage('dashboard', req.admin, {
    totalEmployees, activeShifts, onlineNow,
    tabsText,
    allowedDomains: getSetting('allowed_domains'),
  }));
});

app.get('/admin/employees', requireAdmin, (req, res) => {
  const employees = db.prepare('SELECT id, username, full_name, active, created_at FROM employees ORDER BY username').all();
  res.send(renderPage('employees', req.admin, { employees, flash: req.query.msg || '' }));
});

app.post('/admin/employees/create', requireAdmin, (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const fullName = String(req.body.full_name || '').trim();
  const password = String(req.body.password || '');
  if (!username || !password) return res.redirect('/admin/employees?msg=' + encodeURIComponent('Username and password required.'));
  const exists = db.prepare('SELECT id FROM employees WHERE username = ?').get(username);
  if (exists) return res.redirect('/admin/employees?msg=' + encodeURIComponent('That username already exists.'));
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO employees (username, full_name, password_hash) VALUES (?, ?, ?)').run(username, fullName, hash);
  res.redirect('/admin/employees?msg=' + encodeURIComponent(`Employee "${username}" created.`));
});

app.post('/admin/employees/:id/reset', requireAdmin, (req, res) => {
  const password = String(req.body.password || '');
  if (!password) return res.redirect('/admin/employees?msg=' + encodeURIComponent('New password required.'));
  db.prepare('UPDATE employees SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), req.params.id);
  res.redirect('/admin/employees?msg=' + encodeURIComponent('Password reset.'));
});

app.post('/admin/employees/:id/toggle', requireAdmin, (req, res) => {
  const emp = db.prepare('SELECT active FROM employees WHERE id = ?').get(req.params.id);
  if (emp) db.prepare('UPDATE employees SET active = ? WHERE id = ?').run(emp.active ? 0 : 1, req.params.id);
  res.redirect('/admin/employees?msg=' + encodeURIComponent('Employee updated.'));
});

app.get('/admin/shifts', requireAdmin, (req, res) => {
  const shifts = db.prepare(
    `SELECT username, machine_id, login_at, logout_at,
            CASE WHEN logout_at IS NULL THEN NULL
                 ELSE CAST((julianday(logout_at) - julianday(login_at)) * 24 * 60 AS INTEGER)
            END AS minutes
     FROM shifts ORDER BY login_at DESC LIMIT 500`
  ).all();
  res.send(renderPage('shifts', req.admin, { shifts }));
});

app.post('/admin/settings', requireAdmin, (req, res) => {
  const tabs = parseTabs(req.body.tabs);
  // Auto-include every tab's own domain in the whitelist so tabs always load,
  // then add whatever extra domains the admin listed.
  const tabUrls = tabs.map(t => t.url).join('\n');
  const domains = normalizeDomains(req.body.allowed_domains + '\n' + tabUrls, tabs[0] ? tabs[0].url : '');
  setSetting('tabs', JSON.stringify(tabs));
  setSetting('dialer_url', tabs[0] ? tabs[0].url : ''); // back-compat: first tab
  setSetting('allowed_domains', domains);
  res.redirect('/admin');
});

// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`DialerKiosk server running on http://localhost:${PORT}`);
  console.log(`Admin panel:  http://localhost:${PORT}/admin`);
  const adminCount = db.prepare('SELECT COUNT(*) c FROM admins').get().c;
  if (adminCount === 0) {
    console.log('\n⚠  No admin account yet. Create one with:  npm run init-admin\n');
  }
});
