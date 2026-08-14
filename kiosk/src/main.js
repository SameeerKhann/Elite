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

const CONFIG = loadConfig();
const TOP_BAR_HEIGHT = 44;

let mainWindow = null;
let tabViews = [];        // one BrowserView per configured tab (all live at once)
let activeTab = 0;
let allowedDomains = [];
let currentToken = null;
let currentTabs = [];     // [{label, url}]
let currentNotes = '';    // this agent's sticky notes (loaded at login)
let notesOpen = true;     // notes side panel visible?
const NOTES_WIDTH = 340;

// --- Diagnostic logging (writes to kiosk/kiosk.log) -------------------------
const LOG_FILE = path.join(__dirname, '..', 'kiosk.log');
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
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
      timeout: 10000,
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

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Prevent the user from closing the window in kiosk mode.
  mainWindow.on('close', (e) => {
    if (CONFIG.kioskMode && currentToken) { e.preventDefault(); }
  });

  showLogin();
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
  if (mainWindow) destroyTabViews();
  mainWindow.loadFile(path.join(__dirname, 'login.html'))
    .then(() => {
      // Give keyboard focus back to the login page — without this the username
      // and password fields won't accept typing after a BrowserView was removed.
      try { mainWindow.focus(); mainWindow.webContents.focus(); } catch {}
    })
    .catch(err => log('showLogin load error', err.message));
}

// Open the agent workspace: the shell (top bar + notes panel) plus one locked
// BrowserView per configured tab, all loaded at once so switching is instant.
function showWorkspace(tabs, employee, notes) {
  currentTabs = (tabs && tabs.length) ? tabs : [{ label: 'Dialer', url: 'about:blank' }];
  currentNotes = notes || '';
  notesOpen = true;

  mainWindow.loadFile(path.join(__dirname, 'shell.html'), {
    query: { name: employee.fullName || employee.username },
  });

  destroyTabViews();
  currentTabs.forEach((tab, i) => {
    const view = new BrowserView({
      webPreferences: { contextIsolation: true, nodeIntegration: false, partition: 'persist:dialer' },
    });
    mainWindow.addBrowserView(view);
    const wc = view.webContents;

    // Lock every tab to the allowed domains.
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
  log('=== app started ===', 'config:', JSON.stringify(CONFIG));
  // Extra safety: strip permissions the dialer view might request.
  session.fromPartition('persist:dialer').setPermissionRequestHandler((_wc, permission, cb) => {
    const allow = ['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write'];
    cb(allow.includes(permission));
  });

  // Only hijack global escape shortcuts in real kiosk mode — during local
  // testing (kioskMode:false) we leave the machine's keyboard untouched.
  if (CONFIG.kioskMode) registerLockdownShortcuts();
  createWindow();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
