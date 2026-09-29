'use strict';

// The app's own saved data: settings, what you pinned, marked done or already looked at,
// and the chats from your Claude data export.
// Kept in one JSON file in the app's data folder (on Windows: %APPDATA%\AI Chat Manager\state.json).

const fs = require('fs');
const path = require('path');

const THEME_MODES = ['system', 'light', 'dark'];
const THEME_COLORS = ['indigo', 'teal', 'green', 'amber', 'rose', 'violet', 'graphite'];

const DEFAULT_SETTINGS = {
  recentDays: 7,
  watchDownloads: true,
  themeMode: 'system',
  themeColor: 'indigo',
  compact: false,
  keepOnTop: false,
};

function defaults() {
  return {
    settings: { ...DEFAULT_SETTINGS },
    overrides: {}, // item id → { pinned: true } | { done: true, at }
    seen: {}, // item id → when you last looked at it
    installedAt: Date.now(), // replies finished before this count as already seen
    chats: [], // chats from your Claude data export
    lastImport: null, // { file, fileMtime, importedAt, count }
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
      };
      delete this.data.seenZips;
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
    for (const key of ['watchDownloads', 'compact', 'keepOnTop']) {
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

  markSeen(ids) {
    const now = Date.now();
    for (const id of ids) this.data.seen[id] = now;
    this.save();
  }

  // part 0 (or a single-file export) replaces your chats; later parts of the same export add to them.
  setChats(chats, info, { merge = false } = {}) {
    if (merge) {
      const byId = new Map(this.data.chats.map((chat) => [chat.id, chat]));
      for (const chat of chats) byId.set(chat.id, chat);
      this.data.chats = [...byId.values()];
    } else {
      this.data.chats = chats;
    }
    this.data.lastImport = { ...info, count: this.data.chats.length };
    this.save();
  }

  setPendingExport(pending) {
    this.data.pendingExport = pending;
    this.save();
  }

  markFileSeen(key) {
    this.data.seenFiles[key] = true;
    this.save();
  }

  windowBounds(mode) {
    return this.data.windowBounds[mode] || null;
  }

  saveWindowBounds(mode, bounds) {
    this.data.windowBounds[mode] = bounds;
    this.save();
  }
}

module.exports = { Store, THEME_MODES, THEME_COLORS, DEFAULT_SETTINGS };
