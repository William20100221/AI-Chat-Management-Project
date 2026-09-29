'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeTheme, screen, shell } = require('electron');
const { Scanner } = require('../core/scanner');
const { Store } = require('../core/store');
const { itemState } = require('../core/status');
const { readExportFile, findCandidateFiles, mightBeClaudeExport } = require('../core/chatExport');
const { applyWebEvents, combineChats } = require('../core/webChats');
const { startBridge } = require('../core/webBridge');
const { ExtensionLink } = require('../core/extensionLink');
const { platform: platformInfo, describePlatforms } = require('../core/platforms');

const RESCAN_EVERY_MS = 30 * 1000;
const WINDOW_SIZES = {
  full: { width: 1180, height: 760 },
  compact: { width: 380, height: 680 },
};

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
let bridge = { listening: false, error: null };
let link = null; // the browser extension: connected or not, and what we want from it
let testingUnlocked = false; // Testing panel (temporary, for development); password lives in the store
const TESTING_SETTINGS = ['readLocal', 'readBrowser'];

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function snapshot() {
  const { recentDays } = store.settings;
  const now = Date.now();
  const list = [...items.values()].map((item) => {
    const override = store.override(item.id);
    return {
      id: item.id,
      platform: item.platform || 'claude',
      source: item.source,
      title: item.title,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      state: itemState(item, { override, seenAt: store.seenAt(item.id), openedAt: store.data.seen[item.id] || 0, recentDays, now }),
      question: item.activity && item.activity.asking ? item.activity.asking.text : null,
      asks: Boolean(item.activity && item.activity.asks),
      mark: override.pinned ? 'pinned' : override.done ? 'done' : 'auto',
      questionCount: item.questions.length,
    };
  });
  return {
    items: list,
    sources: [...sources, browserSource()].map(({ label, path: p, found, count, errors, lastError, fields, note }) => ({ label, path: p, found, count, errors, lastError, fields, note })),
    settings: store.settings,
    lastImports: store.data.lastImports,
    platforms: describePlatforms(),
    pendingExport: store.data.pendingExport
      ? { createdAt: store.data.pendingExport.createdAt, opened: Boolean(store.data.pendingExport.openedAt) }
      : null,
    lastScanAt,
    connections: connections(),
    testing: testingSnapshot(),
  };
}

// What the Testing panel shows: its switches, plus what the app sees in Claude's data,
// so field names can be checked against the real thing.
function testingSnapshot() {
  if (!testingUnlocked) return { unlocked: false };
  const web = store.data.web;
  const ext = link.status();
  return {
    unlocked: true,
    customPassword: store.hasCustomTestingPassword(),
    readLocal: store.settings.readLocal,
    readBrowser: store.settings.readBrowser,
    watchDownloads: store.settings.watchDownloads,
    localFields: sources.filter((s) => s.fields && s.fields.length).map((s) => ({ label: s.label, fields: s.fields })),
    webFields: Object.entries(web.fields || {}).map(([platform, fields]) => ({ platform: (platformInfo(platform) || { name: platform }).name, fields })),
    sidebarSamples: Object.entries(web.sidebarSample && typeof web.sidebarSample === 'object' ? web.sidebarSample : {})
      .map(([platform, sample]) => ({ platform: (platformInfo(platform) || { name: platform }).name, sample })),
    extension: ext.everConnected ? `${ext.browser || 'browser'}, extension ${ext.version || '?'}` : 'never connected',
    stored: {
      exportChats: store.data.chats.length,
      browserChats: Object.keys(web.chats).length,
      marks: Object.keys(store.data.overrides).length,
      seen: Object.keys(store.data.seen).length,
    },
  };
}

function pushSnapshot() {
  send('snapshot', snapshot());
}

// Runs one scan at a time; a request during a scan queues exactly one more.
async function rescan() {
  if (scanning) {
    scanQueued = true;
    return scanning;
  }
  scanning = (async () => {
    try {
      const result = await scanner.scan(combineChats(store.data.chats, store.data.web), { local: store.settings.readLocal });
      items = new Map(result.items.map((item) => [item.id, item]));
      sources = result.sources;
      lastScanAt = Date.now();
      watchFolders(result.locations);
      pushSnapshot();
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

const rescanSoon = debounce(rescan, 700);

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

// ---- data exports (Claude and ChatGPT chat history) ----

async function importChats(result, file, fileMtime) {
  const merge = result.part > 0;
  const platform = result.platform || 'claude';
  store.setChats(result.chats, { file: path.basename(file), fileMtime, importedAt: Date.now() }, { merge, platform });
  if (platform === 'claude' && store.data.pendingExport) store.setPendingExport(null);
  await rescan();
  const name = (platformInfo(platform) || { name: platform }).name;
  send('notice', { kind: 'ok', text: `Imported ${result.chats.length} ${name} chats from ${path.basename(file)}` });
}

function rememberManifest(manifest) {
  store.setPendingExport({ ...manifest, foundAt: Date.now(), openedAt: null });
  pushSnapshot();
  send('notice', { kind: 'ok', text: 'Your Claude export is ready. Click "Download chats" to get it.' });
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
    const candidates = await findCandidateFiles(app.getPath('downloads'), store.data.seenFiles);
    for (const candidate of candidates) {
      try {
        if (candidate.kind === 'zip') {
          if (!(await mightBeClaudeExport(candidate.file))) {
            store.markFileSeen(candidate.key);
            continue;
          }
          if (!(await waitUntilStable(candidate.file))) continue; // still downloading; try again later
        }
        const result = await readExportFile(candidate.file);
        store.markFileSeen(candidate.key);
        if (!result) continue;
        if (result.kind === 'manifest') {
          rememberManifest(result.manifest);
        } else {
          const last = store.lastImport(result.platform || 'claude');
          const newer = !last || candidate.mtimeMs > (last.fileMtime || 0);
          if (result.part > 0 || newer) await importChats(result, candidate.file, candidate.mtimeMs);
        }
      } catch {
        store.markFileSeen(candidate.key); // unreadable: don't retry until the file changes
      }
    }
  } finally {
    checkingDownloads = false;
  }
}

const checkDownloadsSoon = debounce(checkDownloads, 2500);

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

// ---- claude.ai in the browser (via the browser extension) ----

function extensionFolder() {
  return app.isPackaged ? path.join(process.resourcesPath, 'extension') : path.join(app.getAppPath(), 'extension');
}

function browserSource() {
  const web = store.data.web;
  const count = Object.keys(web.chats).length;
  const ext = link.status();
  let note;
  if (!bridge.listening) note = bridge.error ? `Can't listen for the extension: ${bridge.error}` : 'Starting…';
  else if (ext.connected) note = `Connected (${ext.browser || 'browser'}) · ${count} chat${count === 1 ? '' : 's'} seen`;
  else if (ext.everConnected) note = `Not connected right now · last seen ${new Date(ext.lastSeenAt).toLocaleString()}`;
  else note = 'Not connected yet';
  return {
    label: 'Websites (claude.ai, chatgpt.com) – browser extension',
    path: null,
    found: ext.everConnected,
    count,
    errors: bridge.error ? 1 : 0,
    lastError: bridge.error,
    note,
  };
}

// Where AI chats were found: apps on this computer first, then websites through the extension.
function connections() {
  const local = sources.filter((s) => s.local && s.path);
  const foundLocal = local.filter((s) => s.found);
  const ext = link.status();
  return {
    local: {
      found: foundLocal.length > 0,
      items: foundLocal.reduce((sum, s) => sum + s.count, 0),
      apps: [...new Set(foundLocal.map((s) => s.app).filter(Boolean))],
      scanned: lastScanAt !== null,
    },
    extension: {
      listening: bridge.listening,
      error: bridge.error,
      connected: ext.connected,
      everConnected: ext.everConnected,
      browser: ext.browser || null,
      lastSeenAt: ext.lastSeenAt || null,
      chats: Object.keys(store.data.web.chats).length,
    },
  };
}

function onBrowserEvents(events, { client }) {
  const wasConnected = link.status().connected;
  const answer = link.contact(client);
  store.data.web.extension = link.info;
  if (!store.settings.readBrowser) {
    // Testing switch is off: note the check-in, but leave the updates waiting in the extension.
    if (!wasConnected) pushSnapshot();
    return { ...answer, paused: true };
  }
  const { seen } = applyWebEvents(store.data.web, events);
  for (const { id, at } of seen) store.data.seen[id] = Math.max(store.data.seen[id] || 0, at);
  store.save();
  if (!wasConnected) send('notice', { kind: 'ok', text: `Connected to the extension in ${link.info.browser || 'your browser'}` });
  if (events.length || !wasConnected) rescanSoon();
  return answer;
}

function startBrowserBridge() {
  startBridge({
    onEvents: onBrowserEvents,
    onStatus: (status) => {
      bridge = status;
      pushSnapshot();
    },
  });
}

// ---- window: full / compact, theme ----

function applyTheme() {
  nativeTheme.themeSource = store.settings.themeMode;
}

function onScreen(bounds) {
  return screen.getAllDisplays().some(({ workArea: a }) => (
    bounds.x < a.x + a.width - 40 && bounds.x + bounds.width > a.x + 40
    && bounds.y >= a.y - 10 && bounds.y < a.y + a.height - 40
  ));
}

function windowMode() {
  return store.settings.compact ? 'compact' : 'full';
}

function applyWindowMode({ switching = false } = {}) {
  const mode = windowMode();
  const saved = store.windowBounds(mode);
  if (saved && onScreen(saved)) {
    win.setBounds(saved);
  } else if (switching) {
    // keep the top-right corner where it was, like a note sliding in from the side
    const current = win.getBounds();
    const size = WINDOW_SIZES[mode];
    win.setBounds({ x: current.x + current.width - size.width, y: current.y, ...size });
  } else {
    win.setSize(WINDOW_SIZES[mode].width, WINDOW_SIZES[mode].height);
    win.center();
  }
  win.setAlwaysOnTop(mode === 'compact' && store.settings.keepOnTop);
}

// Remembers the window's size and place separately for full and compact view.
let boundsTimer = null;
function saveBoundsSoon() {
  const mode = windowMode();
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (mode !== windowMode() || !win || win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
    store.saveWindowBounds(mode, win.getBounds());
  }, 600);
}

// ---- IPC ----

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
      platform: item.platform || 'claude',
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
      resumeCommand: item.resumeCommand || null,
    };
  });

  ipcMain.handle('item:mark', (_e, id, mark) => {
    requireItem(id);
    if (!['pinned', 'done', 'auto'].includes(mark)) throw new Error('Unknown mark');
    store.setMark(id, mark);
    pushSnapshot();
  });

  ipcMain.handle('items:seen', (_e, ids) => {
    const known = (Array.isArray(ids) ? ids : [ids]).filter((id) => items.has(id));
    if (!known.length) return;
    store.markSeen(known);
    pushSnapshot();
  });

  ipcMain.handle('item:open-chat', async (_e, id) => {
    const item = requireItem(id);
    if (!item.url) return { ok: false };
    try {
      // https:// links open in the browser; codex://threads/<id> opens the ChatGPT app.
      await shell.openExternal(item.url);
    } catch {
      return { ok: false, error: item.url.startsWith('codex:') ? 'Couldn’t open the ChatGPT app. Is it still installed?' : 'Couldn’t open the link' };
    }
    store.markSeen([id]);
    pushSnapshot();
    return { ok: true };
  });

  ipcMain.handle('item:open-folder', async (_e, id) => {
    const item = requireItem(id);
    if (item.folder && fs.existsSync(item.folder)) await shell.openPath(item.folder);
  });

  ipcMain.handle('item:copy-resume', (_e, id) => {
    const item = requireItem(id);
    if (item.resumeCommand) clipboard.writeText(item.resumeCommand);
  });

  ipcMain.handle('settings:update', async (_e, patch) => {
    const before = { ...store.settings };
    const allowed = { ...(patch || {}) };
    if (!testingUnlocked) for (const key of TESTING_SETTINGS) delete allowed[key];
    store.updateSettings(allowed);
    const after = store.settings;
    if (after.readLocal !== before.readLocal || after.readBrowser !== before.readBrowser) {
      scanner.cache.clear();
      rescanSoon();
    }
    if (after.readBrowser && !before.readBrowser) link.requestResync(); // collect what waited meanwhile
    if (after.themeMode !== before.themeMode) applyTheme();
    if (after.watchDownloads !== before.watchDownloads) {
      watchDownloads();
      if (after.watchDownloads) checkDownloads();
    }
    if (after.compact !== before.compact) {
      if (!win.isMaximized()) store.saveWindowBounds(before.compact ? 'compact' : 'full', win.getBounds());
      if (win.isMaximized()) win.unmaximize();
      applyWindowMode({ switching: true });
    } else if (after.keepOnTop !== before.keepOnTop) {
      win.setAlwaysOnTop(after.compact && after.keepOnTop);
    }
    pushSnapshot();
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
      const parsed = await readExportFile(file);
      if (!parsed) return { ok: false, error: 'That file is not a Claude data export.' };
      if (parsed.kind === 'manifest') {
        rememberManifest(parsed.manifest);
        return { ok: true };
      }
      await importChats(parsed, file, fs.statSync(file).mtimeMs);
      return { ok: true, count: parsed.chats.length };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Opens the one-time conversation download links from the export email in your browser.
  ipcMain.handle('export:download', async () => {
    const pending = store.data.pendingExport;
    if (!pending) return;
    let links = pending.files.filter((f) => f.category === 'conversations' || /^conversations/i.test(f.filename));
    if (!links.length) links = pending.files;
    for (const link of links) await shell.openExternal(link.url);
    store.setPendingExport({ ...pending, openedAt: Date.now() });
    pushSnapshot();
  });

  ipcMain.handle('export:dismiss', () => {
    store.setPendingExport(null);
    pushSnapshot();
  });

  // ---- Testing panel (temporary) ----

  ipcMain.handle('testing:unlock', (_e, password) => {
    testingUnlocked = store.checkTestingPassword(password || '');
    pushSnapshot();
    return testingUnlocked;
  });

  // Change the Testing tools password (only while unlocked).
  ipcMain.handle('testing:set-password', (_e, password) => {
    if (!testingUnlocked) throw new Error('Testing tools are locked');
    const value = String(password || '');
    if (value.length < 4 || value.length > 200) return { ok: false, error: 'Use 4 to 200 characters' };
    store.setTestingPassword(value);
    pushSnapshot();
    return { ok: true };
  });

  ipcMain.handle('testing:default-password', () => {
    if (!testingUnlocked) throw new Error('Testing tools are locked');
    store.useDefaultTestingPassword();
    pushSnapshot();
  });

  ipcMain.handle('testing:lock', () => {
    testingUnlocked = false;
    pushSnapshot();
  });

  // Deletes what this app saved. Claude's own files are never touched.
  ipcMain.handle('testing:reset', async (_e, { alsoExtension = true } = {}) => {
    if (!testingUnlocked) throw new Error('Testing tools are locked');
    store.resetData();
    const extensionInfo = link.info;
    store.data.web.extension = extensionInfo; // keep knowing the extension is installed
    if (alsoExtension) link.requestClear();
    else link.requestResync(); // the extension will send back what it has seen
    scanner.cache.clear();
    items = new Map();
    await rescan();
    send('notice', {
      kind: 'ok',
      text: alsoExtension ? 'All stored data deleted (the extension clears its copy at its next check-in)' : 'App data deleted; the extension will send back what it has seen',
    });
  });

  ipcMain.handle('scan:refresh', async () => {
    await rescan();
    checkDownloads();
  });

  // Opens a platform's website (your chat list) in the browser; the extension picks it up from there.
  ipcMain.handle('extension:open-website', async (_e, platformId) => {
    const target = platformInfo(platformId) || platformInfo('claude');
    await shell.openExternal(target.website);
  });

  ipcMain.handle('extension:resync', () => {
    link.requestResync();
  });

  ipcMain.handle('extension:open-folder', async () => {
    const folder = extensionFolder();
    if (fs.existsSync(folder)) await shell.openPath(folder);
  });

  ipcMain.handle('source:open', async (_e, index) => {
    const source = sources[index];
    if (source && source.path && fs.existsSync(source.path)) await shell.openPath(source.path);
  });
}

function createWindow() {
  win = new BrowserWindow({
    ...WINDOW_SIZES[windowMode()],
    minWidth: 320,
    minHeight: 420,
    title: 'AI Chat Manager',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#131318' : '#fbf8ff',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  applyWindowMode();
  win.on('resize', saveBoundsSoon);
  win.on('move', saveBoundsSoon);
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
    link = new ExtensionLink(store.data.web.extension);
    applyTheme();
    Menu.setApplicationMenu(null);
    registerIpc();
    startBrowserBridge();
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
