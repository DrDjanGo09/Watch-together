const { app, BrowserWindow, ipcMain, shell, clipboard, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { createLauncher } = require('./launcher');

let win = null;
let tray = null;
let launcher = null;
let starting = false;
let quitting = false;

const iconPath = path.join(__dirname, 'renderer', 'icon.png');

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function getLauncher() {
  if (!launcher) {
    launcher = createLauncher({
      resourceRoot: app.isPackaged ? process.resourcesPath : path.join(__dirname, '..'),
      userDataDir: app.getPath('userData'),
      onLog: (line) => send('log', line),
      onRoomStatus: (rooms) => send('room-status', rooms),
    });
  }
  return launcher;
}

async function startParty() {
  const l = getLauncher();
  if (starting || l.isRunning()) return { ok: false, error: 'Already running' };
  starting = true;
  try {
    send('status', { state: 'starting' });
    const { url, qrDataUrl } = await l.start();
    send('status', { state: 'running', url, qrDataUrl });
    updateTrayMenu();
    return { ok: true, url };
  } catch (err) {
    l.stop();
    send('status', { state: 'error', error: err.message });
    updateTrayMenu();
    return { ok: false, error: err.message };
  } finally {
    starting = false;
  }
}

function stopParty() {
  getLauncher().stop();
  send('status', { state: 'stopped' });
  send('room-status', []);
  updateTrayMenu();
}

ipcMain.handle('start-party', startParty);

ipcMain.handle('stop-party', async () => {
  stopParty();
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

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  win.show();
  win.focus();
}

function updateTrayMenu() {
  if (!tray) return;
  const running = Boolean(launcher && launcher.isRunning());
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Watch Together', click: showWindow },
      { label: 'Stop Watch Party', enabled: running, click: stopParty },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.setToolTip(running ? 'Watch Together — party running' : 'Watch Together');
}

function createTray() {
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.on('click', showWindow);
  updateTrayMenu();
}

function createWindow() {
  win = new BrowserWindow({
    width: 460,
    height: 640,
    resizable: false,
    autoHideMenuBar: true,
    title: 'Watch Together',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Closing the window minimizes to the tray instead of quitting — a running
  // party shouldn't die just because the window closed. Fully exiting is a
  // deliberate action via the tray's Quit item.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
}

app.whenReady().then(() => {
  createTray();
  createWindow();
});

app.on('window-all-closed', () => {
  // Don't quit here: a running party keeps the app alive via the tray even
  // with no window open. before-quit still stops everything on real exit.
});

app.on('before-quit', () => {
  quitting = true;
  if (launcher) launcher.stop();
});
