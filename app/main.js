// Floating lrc desktop overlay: transparent and always on top. Draggable, resizable, remembers
// its position per display. Two modes: subtitle (single line) / lines (previous-current-next).
// Controls appear only on hover; otherwise mouse clicks pass through to the apps below.
const { app, BrowserWindow, screen, globalShortcut, ipcMain, Tray, Menu, nativeImage } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = 38917;
const HIDE_AFTER_MS = 8000; // clear the overlay if the extension has been silent this long
const MIN_W = 260;
const MIN_H = 56;

let win = null;
let hideTimer = null;
let shown = true;
let pendingDelta = 0; // offset change from the slow/fast buttons, handed back to the extension on its next request
let config = { mode: 'subtitle', fs: 32, color: '#ffffff', bgHex: '#6a85b6', bgHex2: '#f3c6d8', bgA: 0.3, frame: 'none', prevH: 0, bounds: null };
let dragStart = null;
let tray = null;

const cfgFile = function () {
  return path.join(app.getPath('userData'), 'config.json');
};
function loadConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(cfgFile(), 'utf8'));
    if (j && typeof j === 'object') config = Object.assign(config, j);
    config.frame = { wish: 'star-hop', wichu: 'star-hop', city: 'tokyo-neko', cat: 'tokyo-neko', stars: 'none' }[config.frame] || config.frame; // migrate old frame names
  } catch (e) {
    /* first run: no config yet */
  }
}
function saveConfig(patch) {
  if (patch) config = Object.assign(config, patch);
  try {
    fs.writeFileSync(cfgFile(), JSON.stringify(config));
  } catch (e) {
    /* ignore */
  }
}

function defaultBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  const w = Math.round(wa.width * 0.7);
  const h = 90;
  return {
    x: Math.round(wa.x + (wa.width - w) / 2),
    y: Math.round(wa.y + wa.height - h - 6),
    width: w,
    height: h,
  };
}
function boundsVisible(b) {
  if (!b) return false;
  return screen.getAllDisplays().some(function (d) {
    const r = d.bounds;
    return b.x + b.width > r.x + 40 && b.x < r.x + r.width - 40 && b.y + b.height > r.y + 20 && b.y < r.y + r.height - 20;
  });
}

function createWindow() {
  const b = boundsVisible(config.bounds) ? config.bounds : defaultBounds();
  win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: true,
    minWidth: MIN_W,
    minHeight: MIN_H,
    focusable: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Clicks pass through by default; 'forward' still delivers mouse-move events so hover can reveal the controls
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'overlay.html'));
}

function sendState(payload) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('state', payload);
  clearTimeout(hideTimer);
  hideTimer = setTimeout(function () {
    if (win && !win.isDestroyed()) win.webContents.send('state', { mode: 'text', text: '', dim: true });
  }, HIDE_AFTER_MS);
}

function startServer() {
  const server = http.createServer(function (req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }
    if (req.method === 'POST' && req.url === '/line') {
      let body = '';
      req.on('data', function (c) {
        body += c;
        if (body.length > 2000000) req.destroy();
      });
      req.on('end', function () {
        try {
          sendState(JSON.parse(body));
        } catch (e) {
          /* ignore malformed data */
        }
        const d = pendingDelta;
        pendingDelta = 0;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ offsetDelta: d }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.on('error', function (e) {
    if (e && e.code === 'EADDRINUSE') app.quit(); // another instance is already running
  });
  server.listen(PORT, '127.0.0.1');
}

// ---------- commands from the UI ----------
ipcMain.handle('get-config', function () {
  return config;
});
ipcMain.on('config', function (_e, patch) {
  saveConfig(patch);
});
ipcMain.on('interactive', function (_e, on) {
  if (win) win.setIgnoreMouseEvents(!on, { forward: true });
});
ipcMain.on('delta', function (_e, d) {
  if (Number.isFinite(d)) pendingDelta += d;
});
ipcMain.on('quit', function () {
  app.quit();
});
ipcMain.on('drag', function (_e, m) {
  if (!win || !m) return;
  if (m.phase === 'start') {
    dragStart = win.getBounds();
  } else if (m.phase === 'move' && dragStart) {
    if (m.kind === 'move') {
      win.setBounds({ x: dragStart.x + m.dx, y: dragStart.y + m.dy, width: dragStart.width, height: dragStart.height });
    } else {
      win.setBounds({
        x: dragStart.x,
        y: dragStart.y,
        width: Math.max(MIN_W, dragStart.width + m.dx),
        height: Math.max(MIN_H, dragStart.height + m.dy),
      });
    }
  } else if (m.phase === 'end') {
    dragStart = null;
    saveConfig({ bounds: win.getBounds() });
  }
});
// Temporarily grow the window upward so a popup menu fits (and shrink back afterwards).
let growState = null;
ipcMain.on('grow', function (_e, h) {
  if (!win) return;
  const b = win.getBounds(), need = Math.round(h);
  if (b.height >= need) return;
  if (!growState) growState = { y: b.y, height: b.height };
  const wa = screen.getDisplayMatching(b).workArea, bottom = b.y + b.height;
  const y = Math.max(wa.y, bottom - need);
  win.setBounds({ x: b.x, y: y, width: b.width, height: bottom - y });
});
ipcMain.on('ungrow', function () {
  if (!win || !growState) return;
  const b = win.getBounds();
  win.setBounds({ x: b.x, y: growState.y, width: b.width, height: growState.height });
  growState = null;
});
ipcMain.on('set-height', function (_e, h) {
  if (!win || !Number.isFinite(h)) return;
  const b = win.getBounds(), nh = Math.max(MIN_H, Math.round(h));
  const wa = screen.getDisplayMatching(b).workArea;
  const y = Math.max(wa.y, b.y + b.height - nh); // keep the bottom edge in place; grow/shrink upward
  win.setBounds({ x: b.x, y: y, width: b.width, height: b.y + b.height - y });
  saveConfig({ bounds: win.getBounds() });
});


function toggleShown() {
  if (!win) return;
  shown = !shown;
  if (shown) win.showInactive();
  else win.hide();
}
function cmd(c) {
  if (win && !win.isDestroyed()) win.webContents.send('cmd', c);
}
function buildTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayWhite.png')));
    tray.setToolTip('Floating lrc');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show / Hide', accelerator: 'Cmd+Alt+L', click: toggleShown },
        { type: 'separator' },
        { label: 'Subtitle mode', click: function () { cmd({ mode: 'subtitle' }); } },
        { label: 'Lines mode', click: function () { cmd({ mode: 'lines' }); } },
        { type: 'separator' },
        { label: 'Frame: Star Hop', click: function () { cmd({ frame: 'star-hop' }); } },
        { label: 'Frame: Tokyo Neko', click: function () { cmd({ frame: 'tokyo-neko' }); } },
        { label: 'Frame: None', click: function () { cmd({ frame: 'none' }); } },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'Cmd+Alt+Q', click: function () { app.quit(); } },
      ])
    );
  } catch (e) {
    /* the tray is optional */
  }
}

app.whenReady().then(function () {
  loadConfig();
  startServer();
  createWindow();
  buildTray();
  try {
    if (app.dock) app.dock.setIcon(nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')));
  } catch (e) {
    /* ignore */
  }
  // shortcuts: Cmd+Opt+Q quit, Cmd+Opt+L show/hide
  globalShortcut.register('CommandOrControl+Alt+Q', function () {
    app.quit();
  });
  globalShortcut.register('CommandOrControl+Alt+L', toggleShown);
});

app.on('window-all-closed', function () {
  app.quit();
});
app.on('will-quit', function () {
  globalShortcut.unregisterAll();
});
