'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  getSources:       (types) => ipcRenderer.invoke('get-sources', types),
  minimize:         () => ipcRenderer.send('win-minimize'),
  hide:             () => ipcRenderer.send('win-hide'),
  restore:          () => ipcRenderer.send('win-restore'),
  pttRegister:      (key) => ipcRenderer.send('ptt-register', key),
  pttUnregister:    () => ipcRenderer.send('ptt-unregister'),
  pttSetEnabled:    (enabled) => ipcRenderer.send('ptt-set-enabled', enabled),
  onPTTToggle:      (cb) => { ipcRenderer.on('ptt-toggle', () => cb()); },
  onPTTRegResult:   (cb) => { ipcRenderer.on('ptt-register-result', (_e, ok) => cb(ok)); },
});
