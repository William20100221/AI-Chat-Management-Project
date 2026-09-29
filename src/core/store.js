'use strict';

// The app's own saved data: settings, what you pinned or marked done, and the last imported chat export.
// Kept in one JSON file in the app's data folder (on Windows: %APPDATA%\AI Chat Manager\state.json).

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  settings: { workingDays: 7, watchDownloads: true },
  overrides: {}, // item id → { pinned?: true, done?: true }
  chats: [], // chats from the newest Claude data export
  lastImport: null, // { file, fileMtime, importedAt, count }
  seenZips: {}, // zips in Downloads we already looked at
};

class Store {
  constructor(file) {
    this.file = file;
    this.data = structuredClone(DEFAULTS);
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = {
        ...this.data,
        ...saved,
        settings: { ...DEFAULTS.settings, ...(saved.settings || {}) },
      };
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

  updateSettings(patch) {
    const next = { ...this.data.settings };
    if (Number.isFinite(patch.workingDays)) next.workingDays = Math.min(365, Math.max(1, Math.round(patch.workingDays)));
    if (typeof patch.watchDownloads === 'boolean') next.watchDownloads = patch.watchDownloads;
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
    else if (mark === 'done') this.data.overrides[id] = { done: true };
    this.save();
  }

  setChats(chats, info) {
    this.data.chats = chats;
    this.data.lastImport = info;
    this.save();
  }

  markZipSeen(key) {
    this.data.seenZips[key] = true;
    this.save();
  }
}

module.exports = { Store, DEFAULTS };
