// Bridge for the Elite Internal chat page (chat.html). All calls go through the
// main process, which talks to the server with the logged-in agent's token.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chat', {
  me: () => ipcRenderer.invoke('chat:me'),
  overview: () => ipcRenderer.invoke('chat:overview'),
  send: (to, text) => ipcRenderer.invoke('chat:send', { to, text }),
  list: (to, sinceId) => ipcRenderer.invoke('chat:list', { to, sinceId }),
  markRead: (to) => ipcRenderer.invoke('chat:read', to),
  setUnread: (n) => ipcRenderer.invoke('chat:unread', n), // badge the tab
  getTheme: () => ipcRenderer.invoke('kiosk:getTheme'),
  setTheme: (t) => ipcRenderer.invoke('kiosk:setTheme', t),
  onTheme: (cb) => ipcRenderer.on('theme', (_e, t) => cb(t)),
});
