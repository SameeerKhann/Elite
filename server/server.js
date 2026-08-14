require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const store = require('./db');
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

// Ensure the database schema exists before handling any request. On serverless
// (Vercel) there is no long-lived startup, so we run init once, lazily, and
// memoize it. Any failure is retried on the next request.
// Diagnostics — registered BEFORE the DB gate so it works even if the DB fails.
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    node: process.version,
    onVercel: !!process.env.VERCEL,
    dbBackend: store.isPg ? 'postgres' : 'sqlite',
    dbUrlDetected: !!(process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL),
    dbEnvKeys: Object.keys(process.env).filter(k => /postgres|database|neon|pg/i.test(k)),
  });
});

let initPromise = null;
function ensureInit() {
  if (!initPromise) initPromise = store.init().catch(err => { initPromise = null; throw err; });
  return initPromise;
}
app.use(async (req, res, next) => {
  try { await ensureInit(); next(); }
  catch (err) {
    console.error('DB init failed:', err);
    res.status(500).send('Database not ready: ' + (err && err.message ? err.message : String(err)));
  }
});

// ---------------------------------------------------------------------------
// Domain / tab helpers (pure functions)
// ---------------------------------------------------------------------------
function extractDomain(entry) {
  let t = String(entry || '').trim().toLowerCase();
  if (!t) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(t)) t = 'https://' + t;
  let host;
  try { host = new URL(t).hostname; } catch { return null; }
  host = host.replace(/^www\./, '');
  if (!host || (!host.includes('.') && host !== 'localhost')) return null;
  return host;
}

function normalizeDomains(raw, alwaysInclude) {
  const out = [];
  const push = (d) => { if (d && !out.includes(d)) out.push(d); };
  push(extractDomain(alwaysInclude));
  String(raw || '').split(/[\s,;]+/).forEach(tok => push(extractDomain(tok)));
  return out.join(', ');
}

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
    if (!dom) return;
    tabs.push({ label: label || dom, url });
  });
  return tabs;
}

async function getTabs() {
  try {
    const arr = JSON.parse((await store.getSetting('tabs', '[]')) || '[]');
    if (Array.isArray(arr) && arr.length) return arr;
  } catch {}
  const du = await store.getSetting('dialer_url');
  return du ? [{ label: 'Dialer', url: du }] : [];
}

async function allowedDomainList() {
  return (await store.getSetting('allowed_domains')).split(',').map(s => s.trim()).filter(Boolean);
}

// Rate limit login endpoints to slow down password guessing.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true });

// ---------------------------------------------------------------------------
// Kiosk API
// ---------------------------------------------------------------------------
app.post('/api/kiosk/login', loginLimiter, async (req, res) => {
  const { username, password, machineId } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Username and password are required.' });
  }
  const emp = await store.getEmployeeByUsername(String(username).trim().toLowerCase());
  if (!emp || !emp.active || !bcrypt.compareSync(password, emp.password_hash)) {
    return res.status(401).json({ ok: false, error: 'Invalid login or account disabled.' });
  }

  const shiftId = await store.createShift(emp.id, emp.username, String(machineId || ''));
  const token = jwt.sign(
    { sub: emp.id, username: emp.username, shiftId: Number(shiftId) },
    JWT_SECRET, { expiresIn: `${SHIFT_TOKEN_HOURS}h` }
  );

  const tabs = await getTabs();
  res.json({
    ok: true,
    token,
    employee: { username: emp.username, fullName: emp.full_name },
    dialerUrl: tabs[0] ? tabs[0].url : await store.getSetting('dialer_url'),
    tabs,
    notes: emp.notes || '',
    allowedDomains: await allowedDomainList(),
  });
});

app.post('/api/kiosk/logout', async (req, res) => {
  const { token } = req.body || {};
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    await store.closeShift(payload.shiftId);
  } catch {}
  res.json({ ok: true });
});

app.post('/api/kiosk/notes', async (req, res) => {
  const { token, notes } = req.body || {};
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    await store.setNotes(payload.sub, String(notes == null ? '' : notes));
    res.json({ ok: true });
  } catch {
    res.status(401).json({ ok: false, error: 'Session expired.' });
  }
});

app.get('/api/kiosk/config', async (req, res) => {
  res.json({ ok: true, dialerUrl: await store.getSetting('dialer_url'), allowedDomains: await allowedDomainList() });
});

// --- Elite Internal (team chat) --------------------------------------------
// A conversation is either the shared 'group' channel (everyone) or a 1-to-1
// DM. The DM thread key is derived from the two employee ids so both sides
// always resolve to the same thread. `to` is 'group' or the other person's id.
// `to` is 'group', 'room:<id>' (must be a member), or another employee's id.
async function resolveThread(selfId, to) {
  if (to === 'group' || to == null || to === '') return { ok: true, thread: 'group' };
  if (typeof to === 'string' && to.startsWith('room:')) {
    const roomId = Number(to.slice(5));
    if (!Number.isInteger(roomId) || roomId <= 0) return { ok: false };
    if (!(await store.isRoomMember(roomId, selfId))) return { ok: false };
    return { ok: true, thread: 'room:' + roomId };
  }
  const other = Number(to);
  if (!Number.isInteger(other) || other <= 0 || other === selfId) return { ok: false };
  return { ok: true, thread: `dm:${Math.min(selfId, other)}-${Math.max(selfId, other)}` };
}

// Sidebar overview: my conversations with unread counts + presence.
app.post('/api/kiosk/chat/overview', async (req, res) => {
  const { token } = req.body || {};
  try {
    const p = jwt.verify(token, JWT_SECRET);
    const [emps, rooms, reads, online] = await Promise.all([
      store.listEmployees(), store.listRoomsForEmployee(p.sub), store.getReadState(p.sub), store.listOnlineUsernames(),
    ]);
    const onlineSet = new Set(online);
    const group = { unread: await store.unreadCount('group', p.sub, reads['group'] || 0) };
    const roomsOut = [];
    for (const r of rooms) {
      const th = 'room:' + r.id;
      roomsOut.push({ id: r.id, name: r.name, unread: await store.unreadCount(th, p.sub, reads[th] || 0) });
    }
    const contacts = [];
    for (const e of emps) {
      if (!e.active || e.id === p.sub) continue;
      const th = `dm:${Math.min(p.sub, e.id)}-${Math.max(p.sub, e.id)}`;
      contacts.push({ id: e.id, username: e.username, fullName: e.full_name, online: onlineSet.has(e.username), unread: await store.unreadCount(th, p.sub, reads[th] || 0) });
    }
    res.json({ ok: true, self: { id: p.sub, username: p.username }, group, rooms: roomsOut, contacts });
  } catch {
    res.status(401).json({ ok: false });
  }
});

// Mark a conversation read up to its latest message.
app.post('/api/kiosk/chat/read', async (req, res) => {
  const { token, to } = req.body || {};
  try {
    const p = jwt.verify(token, JWT_SECRET);
    const r = await resolveThread(p.sub, to);
    if (!r.ok) return res.status(400).json({ ok: false });
    await store.setReadState(p.sub, r.thread, await store.maxMessageId(r.thread));
    res.json({ ok: true });
  } catch {
    res.status(401).json({ ok: false });
  }
});

// Send a message (text only; append-only — no edit/delete anywhere).
app.post('/api/kiosk/chat/send', async (req, res) => {
  const { token, to, text } = req.body || {};
  const body = String(text == null ? '' : text).trim();
  if (!body) return res.json({ ok: true });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const r = await resolveThread(payload.sub, to);
    if (!r.ok) return res.status(400).json({ ok: false, error: 'Invalid recipient.' });
    await store.addMessage(payload.sub, payload.username, body.slice(0, 2000), r.thread);
    store.purgeOldMessages().catch(() => {}); // 7-day retention, fire-and-forget
    res.json({ ok: true });
  } catch {
    res.status(401).json({ ok: false, error: 'Session expired.' });
  }
});

// Fetch a conversation's messages (newer than sinceId, or the latest 100).
app.post('/api/kiosk/chat/list', async (req, res) => {
  const { token, to, sinceId } = req.body || {};
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const r = await resolveThread(payload.sub, to);
    if (!r.ok) return res.status(400).json({ ok: false, messages: [] });
    const messages = await store.listMessages(r.thread, sinceId, 100);
    res.json({ ok: true, messages });
  } catch {
    res.status(401).json({ ok: false, error: 'Session expired.' });
  }
});

// ---------------------------------------------------------------------------
// Admin authentication (cookie session)
// ---------------------------------------------------------------------------
function issueAdminCookie(res, admin) {
  const token = jwt.sign({ adminId: admin.id, username: admin.username }, SESSION_SECRET, { expiresIn: '8h' });
  res.cookie('admin_session', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 3600 * 1000 });
}
function requireAdmin(req, res, next) {
  const token = req.cookies.admin_session;
  if (!token) return res.redirect('/admin/login');
  try { req.admin = jwt.verify(token, SESSION_SECRET); next(); }
  catch { res.clearCookie('admin_session'); res.redirect('/admin/login'); }
}

app.get('/admin/login', (req, res) => res.send(adminLoginPage()));

app.post('/admin/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const admin = await store.getAdminByUsername(String(username || '').trim().toLowerCase());
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

app.get('/admin', requireAdmin, async (req, res) => {
  const [totalEmployees, activeShifts, onlineNow, tabs, allowedDomains, agentDownloadUrl] = await Promise.all([
    store.countEmployees(), store.countOpenShifts(), store.listOpenShifts(), getTabs(),
    store.getSetting('allowed_domains'), store.getSetting('agent_download_url'),
  ]);
  res.send(renderPage('dashboard', req.admin, {
    totalEmployees, activeShifts, onlineNow,
    tabsText: tabs.map(t => `${t.label} | ${t.url}`).join('\n'),
    allowedDomains, agentDownloadUrl,
  }));
});

app.get('/admin/employees', requireAdmin, async (req, res) => {
  const employees = await store.listEmployees();
  res.send(renderPage('employees', req.admin, { employees, flash: req.query.msg || '' }));
});

app.post('/admin/employees/create', requireAdmin, async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const fullName = String(req.body.full_name || '').trim();
  const password = String(req.body.password || '');
  if (!username || !password) return res.redirect('/admin/employees?msg=' + encodeURIComponent('Username and password required.'));
  if (await store.employeeExists(username)) return res.redirect('/admin/employees?msg=' + encodeURIComponent('That username already exists.'));
  await store.createEmployee(username, fullName, bcrypt.hashSync(password, 10));
  res.redirect('/admin/employees?msg=' + encodeURIComponent(`Employee "${username}" created.`));
});

app.post('/admin/employees/:id/reset', requireAdmin, async (req, res) => {
  const password = String(req.body.password || '');
  if (!password) return res.redirect('/admin/employees?msg=' + encodeURIComponent('New password required.'));
  await store.setEmployeePassword(req.params.id, bcrypt.hashSync(password, 10));
  res.redirect('/admin/employees?msg=' + encodeURIComponent('Password reset.'));
});

app.post('/admin/employees/:id/toggle', requireAdmin, async (req, res) => {
  await store.toggleEmployee(req.params.id);
  res.redirect('/admin/employees?msg=' + encodeURIComponent('Employee updated.'));
});

app.post('/admin/settings', requireAdmin, async (req, res) => {
  const tabs = parseTabs(req.body.tabs);
  const tabUrls = tabs.map(t => t.url).join('\n');
  const domains = normalizeDomains(req.body.allowed_domains + '\n' + tabUrls, tabs[0] ? tabs[0].url : '');
  await store.setSetting('tabs', JSON.stringify(tabs));
  await store.setSetting('dialer_url', tabs[0] ? tabs[0].url : '');
  await store.setSetting('allowed_domains', domains);
  res.redirect('/admin');
});

// Save just the agent-installer download link (its own form, never touches tabs).
app.post('/admin/agent-download', requireAdmin, async (req, res) => {
  await store.setSetting('agent_download_url', String(req.body.agent_download_url || '').trim());
  res.redirect('/admin');
});

// --- Admin: chat rooms (team channels) -------------------------------------
app.get('/admin/rooms', requireAdmin, async (req, res) => {
  const [rooms, employees] = await Promise.all([store.listRooms(), store.listEmployees()]);
  const roomData = [];
  for (const r of rooms) roomData.push({ id: r.id, name: r.name, memberIds: await store.listRoomMemberIds(r.id) });
  res.send(renderPage('rooms', req.admin, { rooms: roomData, employees: employees.filter(e => e.active), flash: req.query.msg || '' }));
});
app.post('/admin/rooms/create', requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (name) await store.createRoom(name);
  res.redirect('/admin/rooms?msg=' + encodeURIComponent(name ? `Room "${name}" created.` : 'Room name required.'));
});
app.post('/admin/rooms/:id/members', requireAdmin, async (req, res) => {
  let ids = req.body.member_ids || [];
  if (!Array.isArray(ids)) ids = [ids];
  await store.setRoomMembers(Number(req.params.id), ids.map(Number).filter(Boolean));
  res.redirect('/admin/rooms?msg=' + encodeURIComponent('Members updated.'));
});
app.post('/admin/rooms/:id/delete', requireAdmin, async (req, res) => {
  await store.deleteRoom(Number(req.params.id));
  res.redirect('/admin/rooms?msg=' + encodeURIComponent('Room deleted.'));
});

// --- Admin: conversation viewer (read-only) --------------------------------
app.get('/admin/messages', requireAdmin, async (req, res) => {
  const [threads, employees, rooms] = await Promise.all([store.listThreadsWithMeta(), store.listEmployees(), store.listRooms()]);
  const empById = {}; for (const e of employees) empById[e.id] = e.full_name || e.username;
  const roomById = {}; for (const r of rooms) roomById[r.id] = r.name;
  const label = (thread) => {
    if (!thread) return '';
    if (thread === 'group') return '# General';
    if (thread.startsWith('room:')) return '🛡 ' + (roomById[thread.slice(5)] || ('Room ' + thread.slice(5)));
    if (thread.startsWith('dm:')) { const [a, b] = thread.slice(3).split('-'); return (empById[a] || ('#' + a)) + ' ↔ ' + (empById[b] || ('#' + b)); }
    return thread;
  };
  const convos = threads.map(t => ({ thread: t.thread, label: label(t.thread), count: t.count }));
  const selected = req.query.thread || (convos[0] && convos[0].thread) || '';
  const messages = selected ? await store.listMessagesByThread(selected, 500) : [];
  res.send(renderPage('messages', req.admin, { convos, selected, selectedLabel: label(selected), messages }));
});

// ---------------------------------------------------------------------------
// Start locally; on Vercel the app is imported as a serverless handler.
if (require.main === module) {
  ensureInit()
    .then(() => app.listen(PORT, () => {
      console.log(`Elite server running on http://localhost:${PORT}`);
      console.log(`Admin panel:  http://localhost:${PORT}/admin`);
      console.log(`Database backend: ${store.isPg ? 'Postgres (cloud)' : 'SQLite (local file)'}`);
    }))
    .catch(err => { console.error('Failed to start:', err); process.exit(1); });
}

module.exports = app;
