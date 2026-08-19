'use strict';
/*
 * DialerKiosk client — Electron main process.
 *
 * Flow:
 *   1. Launch fullscreen, kiosk mode, no menu, escape shortcuts swallowed.
 *   2. Show login.html. Employee enters username + password.
 *   3. Credentials are checked against the central server (/api/kiosk/login).
 *   4. On success, load the app shell (top bar) + a locked BrowserView showing
 *      ONLY the Dialer. Navigation to any other domain is blocked.
 *   5. Logout ends the shift on the server and returns to the login screen.
 *
 * NOTE: This app blocks in-app escapes. Blocking OS-level escapes (Alt+Tab,
 * Windows key, Ctrl+Alt+Del, Task Manager) is done by the PowerShell lockdown
 * scripts in ../deploy. Both layers together = true kiosk.
 */
const { app, BrowserWindow, BrowserView, ipcMain, globalShortcut, Menu, session } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { execFileSync, spawn } = require('child_process');

const CONFIG = loadConfig();
const TOP_BAR_HEIGHT = 44;
// The exit code is not stored here — see verifyExitCode() below.

let mainWindow = null;
let tabViews = [];        // one BrowserView per configured tab (all live at once)
let activeTab = 0;
let allowedDomains = [];
let currentToken = null;
let currentTabs = [];     // [{label, url}] (+ a synthetic {label,chat:true} tab)
let currentEmployee = null; // {username, fullName}
let currentNotes = '';    // this agent's sticky notes (loaded at login)
let notesOpen = true;     // notes side panel visible?
let allowExit = false;    // set true only after the secret exit code is entered
let currentTheme = 'dark'; // 'dark' | 'light' — persisted, synced to all views
const NOTES_WIDTH = 340;

// --- Diagnostic logging (writes to kiosk/kiosk.log) -------------------------
const LOG_FILE = path.join(__dirname, '..', 'kiosk.log');
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}

// --- Exit code (releases the kiosk back to a normal desktop) ----------------
// The code itself is never stored. config.json holds only a random salt and a
// scrypt hash of it, so the source and the shipped config reveal nothing that
// unlocks a machine. Generate a pair with:
//
//     cd kiosk && npm run set-exit-code
//
// Verification belongs in the main process — renderers only forward input.
const SCRYPT_KEYLEN = 32;
let exitAttempts = 0;      // consecutive wrong codes
let exitLockedUntil = 0;   // epoch ms; guessing is locked out until then

function exitCodeConfigured() {
  return !!(CONFIG.exitCodeSalt && CONFIG.exitCodeHash);
}

function verifyExitCode(input) {
  if (!exitCodeConfigured()) return false;
  const candidate = String(input == null ? '' : input);
  if (!candidate) return false;
  try {
    const expected = Buffer.from(String(CONFIG.exitCodeHash), 'hex');
    if (expected.length !== SCRYPT_KEYLEN) { log('exit code hash in config.json is malformed'); return false; }
    const actual = crypto.scryptSync(candidate, String(CONFIG.exitCodeSalt), SCRYPT_KEYLEN);
    return crypto.timingSafeEqual(expected, actual); // constant-time compare
  } catch (e) {
    log('exit code verification error', e.message);
    return false;
  }
}

// Escalating lockout so the code can't be guessed by someone standing at the PC.
function exitLockRemainingMs() { return Math.max(0, exitLockedUntil - Date.now()); }
function noteBadExitAttempt() {
  exitAttempts += 1;
  if (exitAttempts >= 5) {
    const steps = Math.min(exitAttempts - 5, 4);           // cap the backoff
    exitLockedUntil = Date.now() + 60000 * Math.pow(2, steps); // 1, 2, 4, 8, 16 min
  }
}

// ---------------------------------------------------------------------------
function loadConfig() {
  const defaults = { serverUrl: 'http://localhost:4000', kioskMode: true, allowDevTools: false };
  let cfg = { ...defaults };
  try {
    cfg = { ...cfg, ...JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')) };
  } catch {}
  // Optional per-machine overrides (e.g. kioskMode:false for testing). Gitignored.
  try {
    cfg = { ...cfg, ...JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.local.json'), 'utf8')) };
  } catch {}
  return cfg;
}

// A stable per-machine id: hostname + a random id persisted next to the app.
function getMachineId() {
  const idFile = path.join(app.getPath('userData'), 'machine-id.txt');
  try {
    return fs.readFileSync(idFile, 'utf8').trim();
  } catch {
    const id = `${os.hostname()}-${crypto.randomBytes(3).toString('hex')}`;
    try { fs.writeFileSync(idFile, id); } catch {}
    return id;
  }
}
const MACHINE_ID = getMachineId();

// Minimal JSON POST/GET without extra dependencies.
function apiRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    let base;
    try { base = new URL(CONFIG.serverUrl); } catch (e) { return reject(new Error('Bad serverUrl in config.json')); }
    const isHttps = base.protocol === 'https:';
    const lib = isHttps ? https : http;
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = lib.request({
      hostname: base.hostname,
      port: base.port || (isHttps ? 443 : 80),
      path: urlPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': data.length } : {}),
      },
      timeout: 30000,
    }, res => {
      let chunks = '';
      res.on('data', c => (chunks += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(chunks || '{}') }); }
        catch { resolve({ status: res.statusCode, json: {} }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Server timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function domainAllowed(urlStr) {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    return allowedDomains.some(d => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
function createWindow() {
  Menu.setApplicationMenu(null); // no menu bar

  mainWindow = new BrowserWindow({
    fullscreen: !!CONFIG.kioskMode,
    kiosk: !!CONFIG.kioskMode,
    frame: !CONFIG.kioskMode,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !!CONFIG.allowDevTools,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    try { mainWindow.focus(); mainWindow.webContents.focus(); } catch {}
  });

  // In kiosk mode the window can NEVER be closed except via the secret exit
  // code (which sets allowExit). Blocks Alt+F4, the X, everything.
  mainWindow.on('close', (e) => {
    if (CONFIG.kioskMode && !allowExit) { e.preventDefault(); }
  });

  loadLoginPage();
}

// Load the login page into the current (fresh) window.
function loadLoginPage() {
  mainWindow.loadFile(path.join(__dirname, 'login.html'))
    .then(() => { try { mainWindow.focus(); mainWindow.webContents.focus(); } catch {} })
    .catch(err => log('login load error', err.message));
}

// --- Kiosk hardening (Windows, per-user, no admin needed, all reversible) ---
function regSet(keyPath, name, value) {
  try {
    execFileSync('reg', ['add', keyPath, '/v', name, '/t', 'REG_DWORD', '/d', String(value), '/f'], { windowsHide: true });
  } catch (e) { log('regSet failed', name, e.message); }
}
function applyKioskHardening() {
  // Disable Task Manager for this user, and auto-launch on every login.
  regSet('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System', 'DisableTaskMgr', 1);
  try { app.setLoginItemSettings({ openAtLogin: true, path: process.execPath }); } catch (e) { log('autostart-on failed', e.message); }
  log('kiosk hardening applied');
}
function revertKioskHardening() {
  regSet('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System', 'DisableTaskMgr', 0);
  try { app.setLoginItemSettings({ openAtLogin: false }); } catch {}
  log('kiosk hardening reverted');
}

function destroyTabViews() {
  if (!mainWindow) { tabViews = []; activeTab = 0; return; }
  // Remove EVERY attached view (not just tracked ones) so nothing is left
  // floating on top of the login page after logout.
  let attached = [];
  try { attached = mainWindow.getBrowserViews(); } catch {}
  for (const v of attached) {
    try { mainWindow.removeBrowserView(v); } catch {}
    try { if (v.webContents && !v.webContents.isDestroyed()) v.webContents.destroy(); } catch {}
  }
  tabViews = [];
  activeTab = 0;
}

function showLogin() {
  currentToken = null;
  currentNotes = '';
  currentTabs = [];
  currentEmployee = null;
  activeTab = 0;

  // Return to login by REPLACING the window with a fresh one. Reloading login
  // in place leaves keyboard focus orphaned after the tab BrowserViews are
  // removed (caret blinks but typing does nothing until you alt-tab). A brand
  // new window always receives focus cleanly.
  const old = mainWindow;
  if (old && !old.isDestroyed()) {
    try {
      for (const v of old.getBrowserViews()) {
        try { old.removeBrowserView(v); } catch {}
        try { if (v.webContents && !v.webContents.isDestroyed()) v.webContents.destroy(); } catch {}
      }
    } catch {}
  }
  tabViews = [];

  createWindow(); // sets mainWindow to a fresh window on the login page
  const fresh = mainWindow;

  // Destroy the old window only once the new one is visible — this avoids a
  // black flash and ensures window-all-closed never fires (which would quit).
  const killOld = () => {
    if (old && !old.isDestroyed()) { try { old.removeAllListeners('close'); old.destroy(); } catch {} }
  };
  if (fresh && !fresh.isDestroyed()) { fresh.once('ready-to-show', killOld); setTimeout(killOld, 1500); }
  else { killOld(); }
}

// Open the agent workspace: the shell (top bar + notes panel) plus one locked
// BrowserView per configured tab, all loaded at once so switching is instant.
function showWorkspace(tabs, employee, notes) {
  const websiteTabs = (tabs && tabs.length) ? tabs : [{ label: 'Dialer', url: 'about:blank' }];
  // Elite Internal is a permanent tab on every kiosk (local chat page).
  currentTabs = [...websiteTabs, { label: 'Elite Internal', chat: true }];
  currentEmployee = employee || null;
  currentNotes = notes || '';
  notesOpen = true;

  mainWindow.loadFile(path.join(__dirname, 'shell.html'), {
    query: { name: employee.fullName || employee.username },
  });

  destroyTabViews();
  currentTabs.forEach((tab, i) => {
    // Elite Internal: a local chat page (no domain lock; talks to the server
    // through its own preload bridge).
    if (tab.chat) {
      const view = new BrowserView({
        webPreferences: { preload: path.join(__dirname, 'chat-preload.js'), contextIsolation: true, nodeIntegration: false },
      });
      mainWindow.addBrowserView(view);
      view.webContents.on('did-fail-load', (_e, code, desc) => { if (code !== -3) log('chat tab FAILED', code, desc); });
      tabViews[i] = view;
      view.webContents.loadFile(path.join(__dirname, 'chat.html')).catch(err => log('chat load threw', err.message));
      return;
    }

    const view = new BrowserView({
      webPreferences: { contextIsolation: true, nodeIntegration: false, partition: 'persist:dialer' },
    });
    mainWindow.addBrowserView(view);
    const wc = view.webContents;

    // Lock every website tab to the allowed domains.
    wc.on('will-navigate', (e, url) => { if (!domainAllowed(url)) e.preventDefault(); });
    wc.on('will-redirect', (e, url) => { if (!domainAllowed(url)) e.preventDefault(); });
    wc.setWindowOpenHandler(({ url }) => {
      if (domainAllowed(url)) wc.loadURL(url);
      return { action: 'deny' };
    });
    wc.on('did-finish-load', () => log('tab', i, 'loaded', wc.getURL()));
    wc.on('did-fail-load', (_e, code, desc, url) => { if (code !== -3) log('tab', i, 'FAILED', code, desc, url); });

    tabViews[i] = view;
    wc.loadURL(tab.url).catch(err => log('tab', i, 'loadURL threw', err.message));
  });

  activeTab = 0;
  mainWindow.removeListener('resize', layout);
  mainWindow.on('resize', layout);
  layout();
}

function switchTab(index) {
  if (index < 0 || index >= tabViews.length) return;
  activeTab = index;
  layout();
  try { mainWindow.setTopBrowserView(tabViews[index]); } catch {}
  notifyChatActive();
}

// Tell the chat page whether it's the visible tab so it can poll fast only when
// actually being viewed (otherwise it just does a light unread check).
function notifyChatActive() {
  const chatIdx = currentTabs.findIndex(t => t && t.chat);
  if (chatIdx >= 0 && tabViews[chatIdx] && !tabViews[chatIdx].webContents.isDestroyed()) {
    try { tabViews[chatIdx].webContents.send('chat-active', activeTab === chatIdx); } catch {}
  }
}

// Position the active tab's view in the area left of the notes panel; park the
// inactive views at zero size so only one is visible at a time.
function layout() {
  if (!mainWindow || tabViews.length === 0) return;
  const { width: W, height: H } = mainWindow.getContentBounds();
  const notesW = notesOpen ? NOTES_WIDTH : 0;
  const visible = { x: 0, y: TOP_BAR_HEIGHT, width: Math.max(0, W - notesW), height: Math.max(0, H - TOP_BAR_HEIGHT) };
  const hidden = { x: 0, y: 0, width: 0, height: 0 };
  tabViews.forEach((v, i) => { try { v.setBounds(i === activeTab ? visible : hidden); } catch {} });
}

// ---------------------------------------------------------------------------
// Lock down keyboard escapes that a browser app can catch.
// (OS-level combos like Alt+Tab / Win / Ctrl+Alt+Del need the deploy scripts.)
function registerLockdownShortcuts() {
  const swallow = [
    'CommandOrControl+R', 'CommandOrControl+Shift+R', 'F5',      // reload
    'CommandOrControl+W', 'CommandOrControl+Shift+W',            // close
    'CommandOrControl+N', 'CommandOrControl+Shift+N',            // new window
    'CommandOrControl+T',                                        // new tab
    'CommandOrControl+Shift+I', 'F12', 'CommandOrControl+Shift+J', // devtools
    'CommandOrControl+P',                                        // print
    'Alt+F4',                                                    // close (best-effort)
    'CommandOrControl+Minus', 'CommandOrControl+Plus',           // zoom
  ];
  for (const combo of swallow) {
    try { globalShortcut.register(combo, () => {}); } catch {}
  }
}

// ---------------------------------------------------------------------------
// IPC from the login screen / shell (via preload).
ipcMain.handle('kiosk:login', async (_e, { username, password }) => {
  log('login attempt for', JSON.stringify(username), '->', CONFIG.serverUrl);
  try {
    const { status, json } = await apiRequest('POST', '/api/kiosk/login', {
      username, password, machineId: MACHINE_ID,
    });
    log('login response status', status, 'ok', json.ok, json.error ? 'error=' + json.error : '');
    if (status === 200 && json.ok) {
      currentToken = json.token;
      allowedDomains = json.allowedDomains || [];
      const tabs = (json.tabs && json.tabs.length) ? json.tabs
                 : (json.dialerUrl ? [{ label: 'Dialer', url: json.dialerUrl }] : []);
      log('opening workspace tabs', JSON.stringify(tabs.map(t => t.label)), 'allowed', JSON.stringify(allowedDomains));
      showWorkspace(tabs, json.employee, json.notes);
      return { ok: true };
    }
    return { ok: false, error: json.error || 'Login failed.' };
  } catch (err) {
    log('login ERROR', err.message);
    return { ok: false, error: 'Cannot reach server. ' + err.message };
  }
});

ipcMain.handle('kiosk:logout', async () => {
  // Flush any pending notes before ending the shift.
  try { await apiRequest('POST', '/api/kiosk/notes', { token: currentToken, notes: currentNotes }); } catch {}
  try { await apiRequest('POST', '/api/kiosk/logout', { token: currentToken }); } catch {}
  showLogin();
  return { ok: true };
});

ipcMain.handle('kiosk:info', () => ({ machineId: MACHINE_ID, serverUrl: CONFIG.serverUrl }));

// --- Elite Internal chat (used by chat.html via chat-preload.js) ------------
ipcMain.handle('chat:me', () => ({
  username: currentEmployee ? currentEmployee.username : '',
  name: currentEmployee ? (currentEmployee.fullName || currentEmployee.username) : '',
}));

ipcMain.handle('chat:overview', async () => {
  try {
    const { json } = await apiRequest('POST', '/api/kiosk/chat/overview', { token: currentToken });
    return json && json.ok ? json : { ok: false, group: { unread: 0 }, rooms: [], contacts: [] };
  } catch (err) { log('chat overview error', err.message); return { ok: false, group: { unread: 0 }, rooms: [], contacts: [] }; }
});

ipcMain.handle('chat:read', async (_e, to) => {
  try { await apiRequest('POST', '/api/kiosk/chat/read', { token: currentToken, to }); return { ok: true }; }
  catch { return { ok: false }; }
});

// Chat reports total unread; badge the "Elite Internal" tab in the shell.
ipcMain.handle('chat:unread', (_e, n) => {
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tab-unread', Number(n) || 0); } catch {}
  return { ok: true };
});

ipcMain.handle('chat:send', async (_e, { to, text }) => {
  try { await apiRequest('POST', '/api/kiosk/chat/send', { token: currentToken, to, text }); return { ok: true }; }
  catch (err) { log('chat send error', err.message); return { ok: false }; }
});

ipcMain.handle('chat:list', async (_e, { to, sinceId }) => {
  try {
    const { json } = await apiRequest('POST', '/api/kiosk/chat/list', { token: currentToken, to, sinceId: Number(sinceId) || 0 });
    return json && json.ok ? json : { ok: false, messages: [] };
  } catch (err) { log('chat list error', err.message); return { ok: false, messages: [] }; }
});

// --- Theme (dark/light), persisted and broadcast to every view -------------
function themeFile() { return path.join(app.getPath('userData'), 'theme.txt'); }
function loadTheme() { try { const t = fs.readFileSync(themeFile(), 'utf8').trim(); if (t === 'light' || t === 'dark') currentTheme = t; } catch {} }
function broadcastTheme() {
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('theme', currentTheme); } catch {}
  for (const v of tabViews) { try { v.webContents.send('theme', currentTheme); } catch {} }
}
ipcMain.handle('kiosk:getTheme', () => currentTheme);
ipcMain.handle('kiosk:setTheme', (_e, t) => {
  currentTheme = (t === 'light') ? 'light' : 'dark';
  try { fs.writeFileSync(themeFile(), currentTheme); } catch {}
  broadcastTheme();
  return { ok: true };
});

// Lets the login screen know whether releasing is even possible on this PC,
// and how long any guessing lockout still has to run.
ipcMain.handle('kiosk:exitInfo', () => ({
  configured: exitCodeConfigured(),
  lockedMs: exitLockRemainingMs(),
}));

// Exit code entered on the login screen: releases the machine.
ipcMain.handle('kiosk:exit', async (_e, code) => {
  if (!exitCodeConfigured()) {
    log('exit refused — no exit code is configured on this PC');
    return { ok: false, error: 'No exit code is set on this PC. Use the Windows administrator account to service it.' };
  }

  const waitMs = exitLockRemainingMs();
  if (waitMs > 0) {
    log('exit refused — locked out for', Math.ceil(waitMs / 1000), 'more seconds');
    return { ok: false, error: `Too many incorrect attempts. Try again in ${Math.ceil(waitMs / 60000)} min.` };
  }

  if (!verifyExitCode(code)) {
    noteBadExitAttempt();
    log('exit code rejected (consecutive failures:', exitAttempts + ')');
    return { ok: false, error: 'Incorrect code.' };
  }

  exitAttempts = 0;
  exitLockedUntil = 0;
  log('exit code accepted — releasing the machine');
  try { if (currentToken) await apiRequest('POST', '/api/kiosk/logout', { token: currentToken }); } catch {}
  allowExit = true;

  // The Windows release path only makes sense on Windows, where this app is the
  // login shell. Everywhere else (a Mac used for testing) just quit normally.
  if (CONFIG.kioskMode && process.platform === 'win32') {
    // This app is the Windows shell. Quitting would end the session (black
    // screen), so instead: undo the lockdown, launch the normal Windows
    // desktop (Explorer), and step our window aside while STAYING ALIVE so the
    // session keeps running. Reboot returns to the locked kiosk.
    revertKioskHardening();
    try { globalShortcut.unregisterAll(); } catch {}
    try { spawn('explorer.exe', { detached: true, stdio: 'ignore' }).unref(); } catch (e) { log('explorer launch failed', e.message); }
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setKiosk(false);
        mainWindow.setAlwaysOnTop(false);
        mainWindow.setClosable(true);
        mainWindow.setFullScreen(false);
        mainWindow.hide();
      }
    } catch (e) { log('release window failed', e.message); }
    return { ok: true };
  }

  // Non-kiosk (local testing) mode: just quit.
  app.exit(0);
  return { ok: true };
});

// --- Workspace: tabs + notes -----------------------------------------------
// The shell asks for its data once loaded.
ipcMain.handle('kiosk:workspace', () => ({
  tabs: currentTabs.map(t => ({ label: t.label })),
  activeTab,
  notes: currentNotes,
  notesOpen,
  employee: null,
}));

ipcMain.handle('kiosk:switchTab', (_e, index) => { switchTab(Number(index) || 0); return { ok: true }; });

ipcMain.handle('kiosk:setNotesPanel', (_e, open) => {
  notesOpen = !!open;
  layout();
  return { ok: true };
});

// Auto-save notes (debounced on the renderer side). Kept in memory too so a
// logout flush and tab switches never lose the latest text.
ipcMain.handle('kiosk:saveNotes', async (_e, notes) => {
  currentNotes = String(notes == null ? '' : notes);
  try {
    const { status } = await apiRequest('POST', '/api/kiosk/notes', { token: currentToken, notes: currentNotes });
    return { ok: status === 200 };
  } catch (err) {
    log('saveNotes error', err.message);
    return { ok: false };
  }
});

// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  loadTheme();
  log('=== app started ===', 'config:', JSON.stringify(CONFIG), 'theme:', currentTheme);
  // Extra safety: strip permissions the dialer view might request.
  session.fromPartition('persist:dialer').setPermissionRequestHandler((_wc, permission, cb) => {
    const allow = ['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write'];
    cb(allow.includes(permission));
  });

  // Only hijack global escape shortcuts + harden the machine in real kiosk
  // mode — during local testing (kioskMode:false) we leave the machine alone.
  if (CONFIG.kioskMode) { registerLockdownShortcuts(); applyKioskHardening(); }
  createWindow();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
