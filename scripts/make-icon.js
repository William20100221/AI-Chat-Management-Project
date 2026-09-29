// Draws build/icon.png (1024×1024) from build/icon.svg. The installers make the Windows .ico and
// Mac .icns from it. Run: npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.svg'), 'utf8');
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  win.webContents.setZoomFactor(1);
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block}</style>${svg}`)}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), image.resize({ width: 1024, height: 1024 }).toPNG());
  console.log('build/icon.png', image.getSize());
  app.quit();
});
