// Secure bridge between the renderer (login/shell pages) and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kiosk', {
  login: (username, password) => ipcRenderer.invoke('kiosk:login', { username, password }),
  logout: () => ipcRenderer.invoke('kiosk:logout'),
  info: () => ipcRenderer.invoke('kiosk:info'),
  exit: () => ipcRenderer.invoke('kiosk:exit'),
  // Workspace (tabs + sticky notes)
  workspace: () => ipcRenderer.invoke('kiosk:workspace'),
  switchTab: (index) => ipcRenderer.invoke('kiosk:switchTab', index),
  setNotesPanel: (open) => ipcRenderer.invoke('kiosk:setNotesPanel', open),
  saveNotes: (notes) => ipcRenderer.invoke('kiosk:saveNotes', notes),
});
