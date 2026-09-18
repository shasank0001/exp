const { app, BrowserWindow, ipcMain, session, protocol, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { ROOT_URL, CSP, resolveAsset } = require('./policy.cjs');
const { createEngineHost } = require('./engine-host.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'mlcopilot', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const root = path.resolve(__dirname, '..');
const DEV_URL = process.env.MLCOPILOT_DEV === '1' ? 'http://localhost:5173/index.html' : null;
const entry = DEV_URL || `${ROOT_URL}/desktop/renderer-dist/index.html`;
const prototype = `${ROOT_URL}/variants/01-thread.html`;
let mainWindow;
let host;

if (!app.requestSingleInstanceLock()) {
  console.error('Another ML Copilot instance is already running.');
  app.quit();
} else {
function senderIsEntry(event) {
  return event.sender === mainWindow.webContents
    && event.senderFrame === mainWindow.webContents.mainFrame
    && event.senderFrame.url === entry;
}

app.whenReady().then(async () => {
  const userDataDir = app.getPath('userData');
  const piPath = path.join(root, 'node_modules', '.bin', 'pi');
  host = createEngineHost({
    userDataDir,
    piPath,
    emit: (payload) => mainWindow && mainWindow.webContents.send('mlcopilot:engine-event', payload),
  });

  const isolated = session.fromPartition('ml-copilot-app');
  isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.on('will-download', (event) => event.preventDefault());
  if (!DEV_URL) {
    isolated.protocol.handle('mlcopilot', async (request) => {
      const file = resolveAsset(request.url, root);
      if (!file) return new Response('Not found', { status: 404 });
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
      try {
        return new Response(await fs.readFile(file), { headers: {
          'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
          'Content-Security-Policy': CSP,
          'X-Content-Type-Options': 'nosniff',
        } });
      } catch { return new Response('Unavailable', { status: 404 }); }
    });
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !resolveAsset(details.url, root) }));
  }

  mainWindow = new BrowserWindow({
    width: 1440, height: 980, minWidth: 760, minHeight: 620,
    backgroundColor: '#fbfaf8', title: 'ML Copilot',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      webviewTag: false, session: isolated,
    },
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('will-frame-navigate', (event, details) => {
    const target = details?.url || event.url;
    if (target !== entry && target !== prototype) event.preventDefault();
  });

  ipcMain.handle('runtime:info', (event) => {
    if (!senderIsEntry(event)) throw new Error('Untrusted renderer');
    return { electron: process.versions.electron, platform: process.platform, mode: 'workspace' };
  });
  ipcMain.handle('threads:pick-project', async (event) => {
    if (!senderIsEntry(event)) throw new Error('Untrusted renderer');
    const picked = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (picked.canceled || !picked.filePaths[0]) return { cancelled: true };
    return { path: picked.filePaths[0] };
  });
  ipcMain.handle('threads:list', (event) => {
    if (!senderIsEntry(event)) throw new Error('Untrusted renderer');
    return host.listThreads();
  });
  ipcMain.handle('threads:create', (event, input) => {
    if (!senderIsEntry(event)) throw new Error('Untrusted renderer');
    return host.createThread(input || {});
  });
  ipcMain.handle('threads:messages', (event, threadId) => {
    if (!senderIsEntry(event)) throw new Error('Untrusted renderer');
    return host.getMessages(threadId);
  });
  ipcMain.handle('threads:send', (event, threadId, text) => {
    if (!senderIsEntry(event)) throw new Error('Untrusted renderer');
    return host.sendPrompt(threadId, text);
  });
  ipcMain.handle('threads:abort', (event, threadId) => {
    if (!senderIsEntry(event)) throw new Error('Untrusted renderer');
    return host.abortThread(threadId);
  });
  ipcMain.handle('engine:state', (event) => {
    if (!senderIsEntry(event)) throw new Error('Untrusted renderer');
    return host.getEngineState();
  });
  ipcMain.handle('threads:trust-get', (event, projectPath) => {
    if (!senderIsEntry(event)) throw new Error('Untrusted renderer');
    return host.getTrust(projectPath);
  });
  ipcMain.handle('threads:trust-set', (event, projectPath, trusted) => {
    if (!senderIsEntry(event)) throw new Error('Untrusted renderer');
    return host.setTrust(projectPath, trusted);
  });
  ipcMain.handle('threads:tools', (event, threadId) => {
    if (!senderIsEntry(event)) throw new Error('Untrusted renderer');
    return host.getToolActivity(threadId);
  });
  ipcMain.handle('threads:changes', (event, threadId) => {
    if (!senderIsEntry(event)) throw new Error('Untrusted renderer');
    return host.getChanges(threadId);
  });

  await mainWindow.loadURL(entry);
}).catch((error) => { console.error('Desktop startup failed:', error); app.exit(1); });
} // end single-instance primary branch

app.on('before-quit', async (event) => {
  if (!host) return;
  event.preventDefault();
  try {
    await host.shutdown();
  } finally {
    app.exit(0);
  }
});
app.on('window-all-closed', () => app.quit());
