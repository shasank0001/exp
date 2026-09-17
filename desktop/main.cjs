const { app, BrowserWindow, ipcMain, session, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { ROOT_URL, CSP, resolveAsset } = require('./policy.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'mlcopilot', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const root = path.resolve(__dirname, '..');
const entry = `${ROOT_URL}/desktop/index.html`;
const prototype = `${ROOT_URL}/variants/01-thread.html`;
let mainWindow;

app.whenReady().then(async () => {
  const isolated = session.fromPartition('ml-copilot-prototype');
  isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.on('will-download', event => event.preventDefault());
  isolated.protocol.handle('mlcopilot', async request => {
    const file = resolveAsset(request.url, root);
    if (!file) return new Response('Not found', { status: 404 });
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
    try {
      return new Response(await fs.readFile(file), { headers: {
        'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff'
      } });
    } catch { return new Response('Unavailable', { status: 404 }); }
  });
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !resolveAsset(details.url, root) }));
  mainWindow = new BrowserWindow({
    width: 1440, height: 980, minWidth: 760, minHeight: 620,
    backgroundColor: '#fbfaf8', title: 'ML Copilot — Desktop prototype',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      webviewTag: false, session: isolated
    }
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.webContents.on('will-frame-navigate', (event, details) => {
    const target = details?.url || event.url;
    if (target !== prototype) event.preventDefault();
  });
  ipcMain.handle('runtime:info', event => {
    if (event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || event.senderFrame.url !== entry) throw new Error('Untrusted renderer');
    return { electron: process.versions.electron, platform: process.platform, mode: 'prototype' };
  });
  await mainWindow.loadURL(entry);
}).catch(error => { console.error('Desktop startup failed:', error); app.exit(1); });
app.on('window-all-closed', () => app.quit());
