// Bridge for the Elite Internal chat page (chat.html). All calls go through the
// main process, which talks to the server with the logged-in agent's token.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chat', {
  me: () => ipcRenderer.invoke('chat:me'),
  contacts: () => ipcRenderer.invoke('chat:contacts'),
  send: (to, text) => ipcRenderer.invoke('chat:send', { to, text }),
  list: (to, sinceId) => ipcRenderer.invoke('chat:list', { to, sinceId }),
});
