const { contextBridge, ipcRenderer } = require('electron');

// Narrow bridge per docs/ENGINE_BRIDGE.md. No Node access, no generic invoke channel.
contextBridge.exposeInMainWorld('mlcopilot', Object.freeze({
  runtimeInfo: () => ipcRenderer.invoke('runtime:info'),
  pickProject: () => ipcRenderer.invoke('threads:pick-project'),
  listThreads: () => ipcRenderer.invoke('threads:list'),
  createThread: (input) => ipcRenderer.invoke('threads:create', input),
  getMessages: (threadId) => ipcRenderer.invoke('threads:messages', threadId),
  sendPrompt: (threadId, text) => ipcRenderer.invoke('threads:send', threadId, text),
  abortThread: (threadId) => ipcRenderer.invoke('threads:abort', threadId),
  getEngineState: () => ipcRenderer.invoke('engine:state'),
  getTrust: (projectPath) => ipcRenderer.invoke('threads:trust-get', projectPath),
  setTrust: (projectPath, trusted) => ipcRenderer.invoke('threads:trust-set', projectPath, trusted),
  getToolActivity: (threadId) => ipcRenderer.invoke('threads:tools', threadId),
  getChanges: (threadId) => ipcRenderer.invoke('threads:changes', threadId),
  onEngineEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('mlcopilot:engine-event', listener);
    return () => ipcRenderer.removeListener('mlcopilot:engine-event', listener);
  },
}));
