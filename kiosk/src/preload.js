// Secure bridge between the renderer (login/shell pages) and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kiosk', {
  login: (username, password) => ipcRenderer.invoke('kiosk:login', { username, password }),
  logout: () => ipcRenderer.invoke('kiosk:logout'),
  info: () => ipcRenderer.invoke('kiosk:info'),
  exit: () => ipcRenderer.invoke('kiosk:exit'),
  onTabUnread: (cb) => ipcRenderer.on('tab-unread', (_e, n) => cb(n)),
  getTheme: () => ipcRenderer.invoke('kiosk:getTheme'),
  setTheme: (t) => ipcRenderer.invoke('kiosk:setTheme', t),
  onTheme: (cb) => ipcRenderer.on('theme', (_e, t) => cb(t)),
  // Workspace (tabs + sticky notes)
  workspace: () => ipcRenderer.invoke('kiosk:workspace'),
  switchTab: (index) => ipcRenderer.invoke('kiosk:switchTab', index),
  setNotesPanel: (open) => ipcRenderer.invoke('kiosk:setNotesPanel', open),
  saveNotes: (notes) => ipcRenderer.invoke('kiosk:saveNotes', notes),
});
