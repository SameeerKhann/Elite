// Bridge for the Elite Internal chat page (chat.html). All calls go through the
// main process, which talks to the server with the logged-in agent's token.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chat', {
  me: () => ipcRenderer.invoke('chat:me'),
  send: (text) => ipcRenderer.invoke('chat:send', text),
  list: (sinceId) => ipcRenderer.invoke('chat:list', sinceId),
});
