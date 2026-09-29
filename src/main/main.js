'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, shell } = require('electron');
const { Scanner } = require('../core/scanner');
const { Store } = require('../core/store');
const { workingState } = require('../core/status');
const { readClaudeExportFile, findCandidateZips, mightBeClaudeExport } = require('../core/chatExport');

const RESCAN_EVERY_MS = 60 * 1000;

let win = null;
let store = null;
const scanner = new Scanner();
let items = new Map();
let sources = [];
let lastScanAt = null;
let scanning = null;
let scanQueued = false;
const watchers = new Map(); // watched path → fs.FSWatcher
let downloadsWatcher = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function snapshot() {
  const { workingDays } = store.settings;
  const now = Date.now();
  const list = [...items.values()].map((item) => {
    const override = store.override(item.id);
    return {
      id: item.id,
      source: item.source,
      title: item.title,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      state: workingState(item, override, workingDays, now),
      mark: override.pinned ? 'pinned' : override.done ? 'done' : 'auto',
      questionCount: item.questions.length,
    };
  });
  return {
    items: list,
    sources: sources.map(({ label, path: p, found, count, errors, lastError }) => ({ label, path: p, found, count, errors, lastError })),
    settings: store.settings,
    lastImport: store.data.lastImport,
    lastScanAt,
  };
}

// Runs one scan at a time; a request during a scan queues exactly one more.
async function rescan() {
  if (scanning) {
    scanQueued = true;
    return scanning;
  }
  scanning = (async () => {
    try {
      const result = await scanner.scan(store.data.chats);
      items = new Map(result.items.map((item) => [item.id, item]));
      sources = result.sources;
      lastScanAt = Date.now();
      watchFolders(result.locations);
      send('snapshot', snapshot());
    } catch (err) {
      send('notice', { kind: 'error', text: `Scan failed: ${err.message}` });
    } finally {
      scanning = null;
      if (scanQueued) {
        scanQueued = false;
        rescan();
      }
    }
  })();
  return scanning;
}

function debounce(fn, ms) {
  let timer = null;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

const rescanSoon = debounce(rescan, 800);

function watch(dir, onChange, recursive) {
  if (watchers.has(dir)) return;
  try {
    const watcher = fs.watch(dir, { recursive }, onChange);
    watcher.on('error', () => {
      watcher.close();
      watchers.delete(dir); // the periodic scan will try again
    });
    watchers.set(dir, watcher);
  } catch {
    // folder missing or not watchable: the periodic scan still picks up changes
  }
}

function watchFolders(locations) {
  for (const { root, exists } of locations.sessionRoots) if (exists) watch(root, rescanSoon, true);
  if (locations.projectsDirExists) watch(locations.projectsDir, rescanSoon, true);
}

// ---- Claude data export (for normal chats) ----

async function importChats(chats, file, fileMtime) {
  store.setChats(chats, { file: path.basename(file), fileMtime, importedAt: Date.now(), count: chats.length });
  await rescan();
  send('notice', { kind: 'ok', text: `Imported ${chats.length} chats from ${path.basename(file)}` });
}

async function waitUntilStable(file) {
  const before = fs.statSync(file).size;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return fs.statSync(file).size === before;
}

let checkingDownloads = false;
async function checkDownloads() {
  if (!store.settings.watchDownloads || checkingDownloads) return;
  checkingDownloads = true;
  try {
    const candidates = await findCandidateZips(app.getPath('downloads'), store.data.seenZips);
    for (const zip of candidates) {
      let chats = null;
      try {
        if (await mightBeClaudeExport(zip.file)) {
          if (!(await waitUntilStable(zip.file))) continue; // still being written; try again later
          chats = await readClaudeExportFile(zip.file);
        }
      } catch {
        chats = null;
      }
      store.markZipSeen(zip.key);
      const newer = !store.data.lastImport || zip.mtimeMs > (store.data.lastImport.fileMtime || 0);
      if (chats && newer) {
        await importChats(chats, zip.file, zip.mtimeMs);
        break; // candidates are newest first
      }
    }
  } finally {
    checkingDownloads = false;
  }
}

const checkDownloadsSoon = debounce(checkDownloads, 3000);

function watchDownloads() {
  if (downloadsWatcher) {
    downloadsWatcher.close();
    downloadsWatcher = null;
  }
  if (!store.settings.watchDownloads) return;
  try {
    downloadsWatcher = fs.watch(app.getPath('downloads'), checkDownloadsSoon);
    downloadsWatcher.on('error', () => {
      downloadsWatcher.close();
      downloadsWatcher = null;
    });
  } catch {
    // the periodic check still runs
  }
}

// ---- Window and IPC ----

function requireItem(id) {
  const item = items.get(id);
  if (!item) throw new Error('This item is no longer available.');
  return item;
}

function registerIpc() {
  ipcMain.handle('snapshot:get', () => snapshot());

  // Matches titles and your questions; returns the ids that match (null means "no filter").
  ipcMain.handle('items:search', (_e, query) => {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return null;
    const ids = [];
    for (const item of items.values()) {
      const hit = item.title.toLowerCase().includes(q) || item.questions.some((m) => m.text.toLowerCase().includes(q));
      if (hit) ids.push(item.id);
    }
    return ids;
  });

  ipcMain.handle('item:detail', (_e, id) => {
    const item = requireItem(id);
    return {
      id: item.id,
      source: item.source,
      title: item.title,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      questions: item.questions,
      firstMessage: item.firstMessage,
      lastMessage: item.lastMessage,
      folder: item.folder || null,
      canOpenChat: Boolean(item.url),
      canOpenFolder: Boolean(item.folder && fs.existsSync(item.folder)),
      resumeCommand: item.resumeId ? `claude --resume ${item.resumeId}` : null,
    };
  });

  ipcMain.handle('item:mark', (_e, id, mark) => {
    requireItem(id);
    if (!['pinned', 'done', 'auto'].includes(mark)) throw new Error('Unknown mark');
    store.setMark(id, mark);
    send('snapshot', snapshot());
  });

  ipcMain.handle('item:open-chat', async (_e, id) => {
    const item = requireItem(id);
    if (item.url) await shell.openExternal(item.url);
  });

  ipcMain.handle('item:open-folder', async (_e, id) => {
    const item = requireItem(id);
    if (item.folder && fs.existsSync(item.folder)) await shell.openPath(item.folder);
  });

  ipcMain.handle('item:copy-resume', (_e, id) => {
    const item = requireItem(id);
    if (item.resumeId) clipboard.writeText(`claude --resume ${item.resumeId}`);
  });

  ipcMain.handle('settings:update', async (_e, patch) => {
    store.updateSettings(patch || {});
    watchDownloads();
    send('snapshot', snapshot());
    if (store.settings.watchDownloads) checkDownloads();
  });

  ipcMain.handle('export:import', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose your Claude data export',
      defaultPath: app.getPath('downloads'),
      filters: [{ name: 'Claude data export', extensions: ['zip', 'json'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    const file = result.filePaths[0];
    try {
      const chats = await readClaudeExportFile(file);
      if (!chats) return { ok: false, error: 'That file is not a Claude data export (no Claude conversations.json inside).' };
      await importChats(chats, file, fs.statSync(file).mtimeMs);
      return { ok: true, count: chats.length };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('scan:refresh', async () => {
    await rescan();
    checkDownloads();
  });

  ipcMain.handle('source:open', async (_e, index) => {
    const source = sources[index];
    if (source && source.path && fs.existsSync(source.path)) await shell.openPath(source.path);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 480,
    title: 'AI Chat Manager',
    backgroundColor: '#f7f6f3',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    store = new Store(path.join(app.getPath('userData'), 'state.json'));
    Menu.setApplicationMenu(null);
    registerIpc();
    createWindow();
    rescan().then(checkDownloads);
    watchDownloads();
    setInterval(() => {
      rescan();
      checkDownloads();
    }, RESCAN_EVERY_MS);
  });

  app.on('window-all-closed', () => app.quit());
}
