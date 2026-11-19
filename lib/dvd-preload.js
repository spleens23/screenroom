'use strict';
// The DVD controls window (renderer/dvd-overlay.html): what it may ask of Screenroom.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('dvd', {
  cmd: (c) => ipcRenderer.invoke('dvd-cmd', c),
  onState: (cb) => ipcRenderer.on('dvd-overlay-state', (_e, s) => cb(s)),
  onKey: (cb) => ipcRenderer.on('dvd-overlay-key', (_e, k) => cb(k)),
  onOpen: (cb) => ipcRenderer.on('dvd-overlay-open', (_e, s) => cb(s)),
});
