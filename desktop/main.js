// Application Windows du photobooth : la même interface que la version iPad,
// dans une fenêtre plein écran, avec en plus un vrai appareil photo (pilote
// intégré pour Nikon et Canon, ou digiCamControl).
'use strict';

const {
  app, BrowserWindow, Menu, clipboard, dialog, ipcMain, powerSaveBlocker, protocol, session, shell,
} = require('electron');
const fs = require('fs');
const path = require('path');
const dcc = require('./camera');
const builtin = require('./camera-builtin');

const fsp = fs.promises;
const ROOT = path.join(__dirname, '..');
const SCHEME = 'app';
const HOST = 'photobooth';
const START_URL = `${SCHEME}://${HOST}/index.html`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

// Pour les tests automatiques : profil séparé et fenêtre normale.
if (process.env.PHOTOBOOTH_USER_DATA) app.setPath('userData', process.env.PHOTOBOOTH_USER_DATA);

// Origine sécurisée et stable : caméra autorisée et stockage (photos, réglages) conservé.
protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

const config = { dccUrl: 'http://127.0.0.1:5513', photoFolder: '', cameraDriver: 'builtin' };
let prefs = { kiosk: true };
let win = null;

function prefsFile() {
  return path.join(app.getPath('userData'), 'desktop.json');
}

function loadPrefs() {
  try {
    prefs = { ...prefs, ...JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) };
  } catch {
    // premier lancement
  }
  if (process.env.PHOTOBOOTH_NO_KIOSK) prefs.kiosk = false;
}

function savePrefs() {
  fsp.writeFile(prefsFile(), JSON.stringify(prefs)).catch(() => {});
}

function photoFolder() {
  return config.photoFolder || path.join(app.getPath('pictures'), 'Photobooth');
}

function capturesFolder() {
  return path.join(photoFolder(), 'originaux');
}

// Pilote de l'appareil choisi dans les réglages : intégré (par défaut) ou digiCamControl.
const dccDriver = {
  test: () => dcc.test(config.dccUrl),
  startLiveView: () => dcc.startLiveView(config.dccUrl),
  stopLiveView: () => dcc.stopLiveView(config.dccUrl),
  proxy: (file) => dcc.proxy(config.dccUrl, file),
  trigger: (folder) => dcc.trigger(config.dccUrl, folder),
  fetchCapture: (id) => dcc.fetchCapture(id),
  testShot: (folder) => dcc.testShot(config.dccUrl, folder),
  getSettings: (launch) => dcc.getSettings(config.dccUrl, { launch }),
  setSetting: (name, value) => dcc.setSetting(config.dccUrl, name, value),
};

function camera() {
  return config.cameraDriver === 'dcc' ? dccDriver : builtin;
}

// Erreur du pilote intégré : on signale un logiciel ouvert qui peut bloquer l'appareil.
async function explained(fn) {
  try {
    return await fn();
  } catch (err) {
    if (camera() !== builtin) throw err;
    const apps = await builtin.cameraApps();
    if (apps.length) {
      const many = apps.length > 1;
      err.message += ` ${apps.join(' et ')} ${many ? 'sont ouverts' : 'est ouvert'} : ${many ? 'fermez-les' : 'fermez-le'}, il peut bloquer l'appareil.`;
    }
    throw err;
  }
}

function setCameraDriver(driver) {
  if (!['builtin', 'dcc'].includes(driver) || driver === config.cameraDriver) return;
  // Libère l'appareil pour l'autre pilote.
  if (config.cameraDriver === 'builtin') builtin.shutdown().catch(() => {});
  else dcc.stopLiveView(config.dccUrl).catch(() => {});
  config.cameraDriver = driver;
}

// Remet la fenêtre du photobooth devant (digiCamControl peut passer au premier plan).
function bringToFront() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.moveTop();
  win.focus();
}

async function serve(request) {
  const url = new URL(request.url);
  if (url.host !== HOST) return new Response('Not found', { status: 404 });
  if (url.pathname.startsWith('/__camera/')) {
    return camera().proxy(url.pathname.slice('/__camera/'.length));
  }
  const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep)) return new Response('Forbidden', { status: 403 });
  try {
    const data = await fsp.readFile(file);
    return new Response(data, {
      headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    fullscreen: prefs.kiosk,
    kiosk: prefs.kiosk,
    autoHideMenuBar: true,
    backgroundColor: '#0e0e10',
    title: 'Photobooth',
    icon: path.join(ROOT, 'icons', 'icon-512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${SCHEME}://${HOST}/`)) e.preventDefault();
  });
  // Ctrl+Maj+I : outils de développement, pour diagnostiquer un souci.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') {
      win.webContents.toggleDevTools();
    }
  });
  win.loadURL(START_URL);
}

function registerIpc() {
  ipcMain.handle('desktop:configure', (e, cfg = {}) => {
    if (typeof cfg.dccUrl === 'string' && cfg.dccUrl.trim()) config.dccUrl = cfg.dccUrl.trim().replace(/\/+$/, '');
    if (typeof cfg.photoFolder === 'string') config.photoFolder = cfg.photoFolder;
    if (typeof cfg.cameraDriver === 'string') setCameraDriver(cfg.cameraDriver);
    return { photoFolder: photoFolder(), kiosk: prefs.kiosk, version: app.getVersion() };
  });

  ipcMain.handle('camera:test', async () => {
    const result = await explained(() => camera().test());
    if (result.launched) bringToFront();
    return result;
  });
  ipcMain.handle('camera:liveview', async (e, on) => {
    const cam = camera();
    if (!on) return cam.stopLiveView();
    try {
      await explained(() => cam.startLiveView());
    } finally {
      if (cam === dccDriver) bringToFront();
    }
    return null;
  });
  ipcMain.handle('camera:trigger', () => camera().trigger(capturesFolder()));
  ipcMain.handle('camera:fetch', (e, id) => camera().fetchCapture(id));
  ipcMain.handle('camera:test-shot', async () => {
    const cam = camera();
    try {
      return await explained(() => cam.testShot(capturesFolder()));
    } finally {
      if (cam === dccDriver) bringToFront();
    }
  });
  ipcMain.handle('camera:get-settings', async (e, launch) => {
    const result = await explained(() => camera().getSettings(Boolean(launch)));
    if (result.launched) bringToFront();
    return result.settings;
  });
  ipcMain.handle('camera:set-setting', (e, name, value) => camera().setSetting(String(name), String(value)));
  // Journal du pilote intégré, à envoyer en cas de souci avec l'appareil.
  ipcMain.handle('camera:open-log', async () => {
    const err = await shell.openPath(builtin.openLogPath());
    if (err) throw new Error(err);
  });
  // Rapport copié dans le presse-papiers, à coller dans un message d'assistance.
  ipcMain.handle('camera:report', async (e, info = {}) => {
    const webcams = Array.isArray(info.webcams) ? info.webcams.map(String).slice(0, 10) : [];
    const text = builtin.report({ driver: config.cameraDriver, apps: await builtin.cameraApps(), webcams });
    clipboard.writeText(text);
    return text;
  });

  ipcMain.handle('photos:save', async (e, bytes, name) => {
    const dir = photoFolder();
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, path.basename(String(name)).replace(/[^\w.-]/g, '_'));
    await fsp.writeFile(file, Buffer.from(bytes));
    return file;
  });
  ipcMain.handle('photos:choose-folder', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Dossier des photos',
      defaultPath: photoFolder(),
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  });
  ipcMain.handle('photos:open-folder', async () => {
    await fsp.mkdir(photoFolder(), { recursive: true });
    const err = await shell.openPath(photoFolder());
    if (err) throw new Error(err);
  });
  ipcMain.handle('photos:show', (e, file) => shell.showItemInFolder(String(file)));

  ipcMain.handle('window:kiosk', (e, on) => {
    prefs.kiosk = Boolean(on);
    savePrefs();
    win.setKiosk(prefs.kiosk);
    win.setFullScreen(prefs.kiosk);
  });
  ipcMain.handle('app:quit', () => app.quit());
}

// Auto-test du pilote d'appareil photo dans l'application installée (lancé
// par la construction de l'installateur) : résultat écrit dans un fichier.
async function selfTest(file) {
  const result = {
    ok: false,
    versions: { app: app.getVersion(), electron: process.versions.electron, node: process.versions.node },
  };
  const step = async (name, fn) => {
    try {
      result[name] = await fn();
      return true;
    } catch (err) {
      result[name] = { error: err.message || String(err) };
      return false;
    }
  };
  // Lancement normal (processus utilitaire, avec repli en mode Node), puis mode Node seul.
  result.ok = await step('driver', () => builtin.probe('utility'));
  await step('nodeMode', () => builtin.probe('node'));
  if (!result.ok || result.driver.mode !== 'utility') {
    await new Promise((r) => setTimeout(r, 500)); // dernières lignes du pilote
    result.log = builtin.recentLog();
  }
  await fsp.writeFile(file, JSON.stringify(result, null, 2));
  await builtin.shutdown().catch(() => {});
  app.exit(0);
}

if (process.env.PHOTOBOOTH_SELFTEST) {
  app.whenReady().then(() => selfTest(process.env.PHOTOBOOTH_SELFTEST));
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', bringToFront);

  app.whenReady().then(() => {
    loadPrefs();
    Menu.setApplicationMenu(null);
    protocol.handle(SCHEME, serve);
    const allowed = ['media', 'fullscreen'];
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(allowed.includes(permission)));
    session.defaultSession.setPermissionCheckHandler((wc, permission) => allowed.includes(permission));
    registerIpc();
    // L'écran ne se met pas en veille pendant l'événement.
    powerSaveBlocker.start('prevent-display-sleep');
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    builtin.shutdown().catch(() => {});
    if (config.cameraDriver === 'dcc') dcc.stopLiveView(config.dccUrl).catch(() => {});
  });
}
