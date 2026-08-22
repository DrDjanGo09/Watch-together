const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron');
const path = require('path');
const { createLauncher } = require('./launcher');

let win = null;
let launcher = null;
let starting = false;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function getLauncher() {
  if (!launcher) {
    launcher = createLauncher({
      resourceRoot: app.isPackaged ? process.resourcesPath : path.join(__dirname, '..'),
      userDataDir: app.getPath('userData'),
      onLog: (line) => send('log', line),
    });
  }
  return launcher;
}

ipcMain.handle('start-party', async () => {
  const l = getLauncher();
  if (starting || l.isRunning()) return { ok: false, error: 'Already running' };
  starting = true;
  try {
    send('status', { state: 'starting' });
    const { url, qrDataUrl } = await l.start();
    send('status', { state: 'running', url, qrDataUrl });
    return { ok: true, url };
  } catch (err) {
    l.stop();
    send('status', { state: 'error', error: err.message });
    return { ok: false, error: err.message };
  } finally {
    starting = false;
  }
});

ipcMain.handle('stop-party', async () => {
  getLauncher().stop();
  send('status', { state: 'stopped' });
  return { ok: true };
});

ipcMain.handle('copy-link', (_evt, text) => {
  clipboard.writeText(text);
  return { ok: true };
});

ipcMain.handle('open-link', (_evt, url) => {
  shell.openExternal(url);
  return { ok: true };
});

function createWindow() {
  win = new BrowserWindow({
    width: 460,
    height: 640,
    resizable: false,
    autoHideMenuBar: true,
    title: 'Watch Together',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (launcher) launcher.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (launcher) launcher.stop();
});
