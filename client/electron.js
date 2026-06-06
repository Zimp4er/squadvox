'use strict';

const { app, BrowserWindow, ipcMain, desktopCapturer,
        protocol, net, shell, globalShortcut } = require('electron');
const path              = require('path');
const { pathToFileURL } = require('url');

process.on('uncaughtException',  err => console.error('[main] uncaughtException:', err));
process.on('unhandledRejection', err => console.error('[main] unhandledRejection:', err));

const isDev = process.argv.includes('--dev');
const DIST  = path.join(__dirname, 'dist');

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

let mainWindow  = null;
let _pttKey     = null;
let _pttEnabled = false;

function registerPTT(key) {
  if (_pttKey) { try { globalShortcut.unregister(_pttKey); } catch {} }
  _pttKey = key;
  try {
    globalShortcut.register(key, () => {
      if (_pttEnabled) mainWindow?.webContents.send('ptt-toggle');
    });
    return true;
  } catch(e) {
    console.error('[PTT] register failed:', e.message);
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width:           980,
    height:          680,
    minWidth:        700,
    minHeight:       500,
    backgroundColor: '#1e1f22',
    show:            false,
    autoHideMenuBar: true,
    title:           'SquadVox',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
      webSecurity:      true,
    },
  });

  mainWindow.loadURL('app://localhost/index.html')
    .catch(err => console.error('[main] loadURL failed:', err));

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.on('did-fail-load', (e, code, desc) =>
    console.error('[main] did-fail-load:', code, desc)
  );

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  protocol.handle('app', async request => {
    try {
      const url      = new URL(request.url);
      const relative = decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html';
      const fullPath = path.join(DIST, relative);
      return await net.fetch(pathToFileURL(fullPath).toString());
    } catch(err) {
      console.error('[protocol] error:', err);
      return new Response('Not found', { status: 404 });
    }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(err => console.error('[main] app.whenReady failed:', err));

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => globalShortcut.unregisterAll());

// ── IPC ───────────────────────────────────────────────────────────────────────

ipcMain.handle('get-sources', async (_e, types) => {
  const sources = await desktopCapturer.getSources({
    types:            types ?? ['screen', 'window'],
    thumbnailSize:    { width: 280, height: 158 },
    fetchWindowIcons: true,
  });
  return sources.map(s => ({
    id:        s.id,
    name:      s.name,
    thumbnail: s.thumbnail.toDataURL(),
    appIcon:   s.appIcon?.toDataURL() ?? null,
  }));
});

ipcMain.on('ptt-register', (_e, key) => {
  const ok = registerPTT(key);
  mainWindow?.webContents.send('ptt-register-result', ok);
});

ipcMain.on('ptt-unregister', () => {
  if (_pttKey) { try { globalShortcut.unregister(_pttKey); } catch {} _pttKey = null; }
});

ipcMain.on('ptt-set-enabled', (_e, enabled) => { _pttEnabled = enabled; });

ipcMain.on('win-minimize', () => mainWindow?.minimize());
ipcMain.on('win-hide',     () => mainWindow?.hide());
ipcMain.on('win-restore',  () => { mainWindow?.show(); mainWindow?.focus(); });
