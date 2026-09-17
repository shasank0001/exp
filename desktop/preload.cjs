const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', Object.freeze({
  runtimeInfo: () => ipcRenderer.invoke('runtime:info')
}));
