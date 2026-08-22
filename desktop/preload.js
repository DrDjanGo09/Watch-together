const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('watchTogether', {
  start: () => ipcRenderer.invoke('start-party'),
  stop: () => ipcRenderer.invoke('stop-party'),
  copyLink: (text) => ipcRenderer.invoke('copy-link', text),
  openLink: (url) => ipcRenderer.invoke('open-link', url),
  onStatus: (cb) => ipcRenderer.on('status', (_evt, payload) => cb(payload)),
  onLog: (cb) => ipcRenderer.on('log', (_evt, line) => cb(line)),
});
