'use strict';

// The app's own saved data: settings, what you pinned, marked done or already looked at,
// and the chats from your Claude data export.
// Kept in one JSON file in the app's data folder (on Windows: %APPDATA%\AI Chat Manager\state.json).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { emptyWebState, normalizeWebState } = require('./webChats');

// Testing tools password until you set your own (Settings → Testing → Change password).
// It's printed in the README, so it only guards against opening the tools by accident.
const DEFAULT_TESTING_PASSWORD = 'TESTING_PASSWORD';

const THEME_MODES = ['system', 'light', 'dark'];
const THEME_COLORS = ['indigo', 'teal', 'green', 'amber', 'rose', 'violet', 'graphite'];

const DEFAULT_SETTINGS = {
  recentDays: 7,
  watchDownloads: true,
  themeMode: 'system',
  themeColor: 'indigo',
  compact: false,
  keepOnTop: false,
  readHistory: true, // find AI chats in the browsers' history (AI chat pages only)
  // Testing panel switches (temporary):
  readLocal: true, // read Claude's files on this computer
  readBrowser: true, // accept chats from the browser extension
};

function defaults() {
  return {
    settings: { ...DEFAULT_SETTINGS },
    overrides: {}, // item id → { pinned: true } | { done: true, at }
    seen: {}, // item id → when you last looked at it
    installedAt: Date.now(), // replies finished before this count as already seen
    chats: [], // chats from your data exports (each says which platform it's from)
    web: emptyWebState(), // chats seen live in your browser (browser extension)
    lastImports: {}, // platform → { file, fileMtime, importedAt, count }
    pendingExport: null, // download links from an export manifest you haven't used yet
    seenFiles: {}, // files in Downloads we already looked at
    windowBounds: {}, // { full, compact } → { x, y, width, height }
  };
}

class Store {
  constructor(file) {
    this.file = file;
    this.data = defaults();
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      const settings = { ...DEFAULT_SETTINGS, ...(saved.settings || {}) };
      if (saved.settings && saved.settings.workingDays && !saved.settings.recentDays) {
        settings.recentDays = saved.settings.workingDays; // renamed in 0.2
      }
      delete settings.workingDays;
      this.data = {
        ...this.data,
        ...saved,
        settings,
        seenFiles: saved.seenFiles || saved.seenZips || {},
        web: normalizeWebState(saved.web),
        lastImports: saved.lastImports || (saved.lastImport ? { claude: saved.lastImport } : {}),
      };
      delete this.data.seenZips;
      delete this.data.lastImport;
    } catch {
      // first run, or an unreadable file: start fresh
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const json = JSON.stringify(this.data);
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, this.file); // write-then-rename so a crash never leaves half a file
    } catch {
      fs.writeFileSync(this.file, json); // e.g. antivirus holding the file on Windows
    }
  }

  get settings() {
    return this.data.settings;
  }

  updateSettings(patch = {}) {
    const next = { ...this.data.settings };
    if (Number.isFinite(patch.recentDays)) next.recentDays = Math.min(365, Math.max(1, Math.round(patch.recentDays)));
    for (const key of ['watchDownloads', 'compact', 'keepOnTop', 'readHistory', 'readLocal', 'readBrowser']) {
      if (typeof patch[key] === 'boolean') next[key] = patch[key];
    }
    if (THEME_MODES.includes(patch.themeMode)) next.themeMode = patch.themeMode;
    if (THEME_COLORS.includes(patch.themeColor)) next.themeColor = patch.themeColor;
    this.data.settings = next;
    this.save();
  }

  override(id) {
    return this.data.overrides[id] || {};
  }

  // mark: 'pinned' | 'done' | 'auto' (back to automatic)
  setMark(id, mark) {
    if (mark === 'auto') delete this.data.overrides[id];
    else if (mark === 'pinned') this.data.overrides[id] = { pinned: true };
    else if (mark === 'done') this.data.overrides[id] = { done: true, at: Date.now() };
    this.save();
  }

  seenAt(id) {
    return Math.max(this.data.seen[id] || 0, this.data.installedAt || 0);
  }

  markSeen(ids, at = Date.now()) {
    for (const id of ids) this.data.seen[id] = Math.max(this.data.seen[id] || 0, at);
    this.save();
  }

  // A platform's export replaces that platform's chats (part 0, or a single-file export);
  // later parts of the same export add to them. Other platforms' chats are kept.
  setChats(chats, info, { merge = false, platform = (chats[0] && chats[0].platform) || 'claude' } = {}) {
    const mine = (chat) => (chat.platform || 'claude') === platform;
    const byId = new Map(this.data.chats.filter((chat) => merge || !mine(chat)).map((chat) => [chat.id, chat]));
    for (const chat of chats) byId.set(chat.id, { ...chat, platform: chat.platform || platform });
    this.data.chats = [...byId.values()];
    this.data.lastImports = { ...this.data.lastImports, [platform]: { ...info, count: this.data.chats.filter(mine).length } };
    this.save();
  }

  lastImport(platform) {
    return this.data.lastImports[platform] || null;
  }

  setPendingExport(pending) {
    this.data.pendingExport = pending;
    this.save();
  }

  markFileSeen(key) {
    this.data.seenFiles[key] = true;
    this.save();
  }

  // Testing: forget everything this app saved (never touches Claude's own files).
  // Settings and window sizes stay.
  resetData() {
    const fresh = defaults();
    this.data = {
      ...fresh,
      settings: this.data.settings,
      windowBounds: this.data.windowBounds,
      testingPassword: this.data.testingPassword, // your own password stays too
    };
    this.save();
  }

  // ---- Testing tools password (stored as a salted scrypt hash, never as text) ----

  checkTestingPassword(password) {
    const saved = this.data.testingPassword;
    if (!saved || !saved.salt || !saved.hash) return String(password) === DEFAULT_TESTING_PASSWORD;
    const hash = crypto.scryptSync(String(password), saved.salt, 32);
    const expected = Buffer.from(saved.hash, 'hex');
    return expected.length === hash.length && crypto.timingSafeEqual(hash, expected);
  }

  setTestingPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
    this.data.testingPassword = { salt, hash };
    this.save();
  }

  useDefaultTestingPassword() {
    delete this.data.testingPassword;
    this.save();
  }

  hasCustomTestingPassword() {
    return Boolean(this.data.testingPassword && this.data.testingPassword.hash);
  }

  windowBounds(mode) {
    return this.data.windowBounds[mode] || null;
  }

  saveWindowBounds(mode, bounds) {
    this.data.windowBounds[mode] = bounds;
    this.save();
  }
}

module.exports = { Store, THEME_MODES, THEME_COLORS, DEFAULT_SETTINGS, DEFAULT_TESTING_PASSWORD };
