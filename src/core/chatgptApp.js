'use strict';

// The ChatGPT desktop app on this computer.
//
// Since July 2026 the ChatGPT desktop app is the former Codex app, with three modes: Chat, Work and
// Codex. Work and Codex chats run on this computer and are saved here, in the same place the
// Codex CLI uses ($CODEX_HOME, normally ~/.codex):
//   sessions/YYYY/MM/DD/rollout-…-<id>.jsonl   every message (read by codex.js)
//   state_5.sqlite, table "threads"            the chat list the app shows: title, preview,
//                                              dates, archived, pinned, Work or Codex
//   session_index.jsonl                         names you gave chats
// Chat-mode conversations are ordinary ChatGPT chats: they're kept on OpenAI's servers and the app
// downloads them each time, so they come from chatgpt.com (the browser extension) or your export.
//
// The older app, now called "ChatGPT Classic", keeps no chat files we can read (on a Mac its cache
// is encrypted with a key in the Keychain), so it's only detected.
//
// Where the apps are installed:
//   Windows  Microsoft Store packages  %LOCALAPPDATA%\Packages\OpenAI.Codex_<id>           (ChatGPT)
//                                      %LOCALAPPDATA%\Packages\OpenAI.ChatGPT-Desktop_<id> (Classic)
//   Mac      /Applications/ChatGPT.app or Codex.app (bundle com.openai.codex), data in
//            ~/Library/Application Support/Codex; Classic keeps ~/Library/Application Support/com.openai.chat

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { toMillis } = require('./text');
const { withCopy, columnsOf } = require('./sqliteCopy');

const STATE_DB = 'state_5.sqlite';

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Finds installed ChatGPT desktop apps. Each result: { kind: 'current' | 'classic', name, path }.
function findChatGPTApps({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const found = [];
  const add = (kind, p) => {
    if (isDir(p) && !found.some((f) => f.path === p)) found.push({ kind, name: kind === 'classic' ? 'ChatGPT Classic' : 'ChatGPT', path: p });
  };
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const packages = path.join(localAppData, 'Packages');
    let names = [];
    try {
      names = fs.readdirSync(packages);
    } catch {
      // no Store apps folder
    }
    // "OpenAI.Codex" stays the package name for both Codex- and ChatGPT-branded builds.
    for (const name of names) if (/^OpenAI\.Codex_/i.test(name)) add('current', path.join(packages, name));
    for (const name of names) if (/^OpenAI\.ChatGPT(-Desktop)?_/i.test(name)) add('classic', path.join(packages, name));
  } else if (platform === 'darwin') {
    for (const dir of ['/Applications', path.join(home, 'Applications')]) {
      add('current', path.join(dir, 'Codex.app'));
      // ChatGPT.app is the new app when its bundle is com.openai.codex, otherwise Classic.
      const chatgpt = path.join(dir, 'ChatGPT.app');
      if (isDir(chatgpt)) add(macBundleId(chatgpt) === 'com.openai.chat' ? 'classic' : 'current', chatgpt);
      add('classic', path.join(dir, 'ChatGPT Classic.app'));
    }
    if (!found.some((f) => f.kind === 'current')) add('current', path.join(home, 'Library', 'Application Support', 'Codex'));
    if (!found.some((f) => f.kind === 'classic')) add('classic', path.join(home, 'Library', 'Application Support', 'com.openai.chat'));
  }
  return found;
}

// Reads CFBundleIdentifier from an app's Info.plist (XML plists only; binary ones return null).
function macBundleId(appPath) {
  try {
    const plist = fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf8');
    const match = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

// Where state_5.sqlite may be: $CODEX_SQLITE_HOME, then $CODEX_HOME, then the newer sqlite/ folder.
function stateDbCandidates(codexHomeDir, { env = process.env } = {}) {
  const dirs = [env.CODEX_SQLITE_HOME, codexHomeDir, codexHomeDir && path.join(codexHomeDir, 'sqlite')].filter(Boolean);
  return [...new Set(dirs)].map((dir) => path.join(dir, STATE_DB));
}

// The newest state_5.sqlite that exists, with the size and time of it and its -wal file
// (so callers can tell when it changed).
async function findStateDb(codexHomeDir, options = {}) {
  let best = null;
  for (const file of stateDbCandidates(codexHomeDir, options)) {
    const db = await statOrNull(file);
    if (!db || !db.isFile()) continue;
    const wal = await statOrNull(`${file}-wal`);
    const changedAt = Math.max(db.mtimeMs, wal ? wal.mtimeMs : 0);
    if (!best || changedAt > best.changedAt) {
      best = { file, changedAt, stamp: `${db.size}:${db.mtimeMs}:${wal ? `${wal.size}:${wal.mtimeMs}` : '-'}` };
    }
  }
  return best;
}

async function statOrNull(file) {
  try {
    return await fsp.stat(file);
  } catch {
    return null;
  }
}

const WANTED_COLUMNS = [
  'id', 'rollout_path', 'created_at', 'updated_at', 'created_at_ms', 'updated_at_ms', 'recency_at_ms',
  'source', 'thread_source', 'originator', 'cwd', 'title', 'name', 'preview', 'first_user_message',
  'archived', 'is_pinned', 'model', 'has_user_event',
];

// Reads the "threads" table: the list of Work and Codex chats the ChatGPT app shows.
// The app keeps this database open while it runs, so a copy is read (see sqliteCopy.js).
async function readThreads(dbFile, { tmpRoot } = {}) {
  return withCopy(dbFile, (db) => {
    const columns = columnsOf(db, 'threads');
    if (!columns.has('id')) throw new Error('No "threads" table in this file');
    const select = WANTED_COLUMNS.filter((c) => columns.has(c)).map((c) => `"${c}"`).join(', ');
    return db.prepare(`SELECT ${select} FROM threads`).all().map(threadFromRow).filter(Boolean);
  }, { tmpRoot });
}

// Older rows keep seconds, newer ones milliseconds.
function millis(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  return toMillis(value);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function threadFromRow(row) {
  if (!row || !row.id) return null;
  return {
    id: String(row.id).toLowerCase(),
    rolloutPath: text(row.rollout_path) || null,
    createdAt: millis(row.created_at_ms) || millis(row.created_at),
    updatedAt: Math.max(millis(row.recency_at_ms) || 0, millis(row.updated_at_ms) || millis(row.updated_at) || 0) || null,
    source: text(row.source) || null,
    threadSource: text(row.thread_source) || null,
    originator: text(row.originator) || null,
    cwd: text(row.cwd) || null,
    name: text(row.name) || null, // a name you gave it
    title: text(row.title) || null, // the app's title
    preview: text(row.preview) || null,
    firstUserMessage: text(row.first_user_message) || null,
    archived: Number(row.archived) === 1,
    pinned: Number(row.is_pinned) === 1,
    model: text(row.model) || null,
  };
}

module.exports = { findChatGPTApps, stateDbCandidates, findStateDb, readThreads, macBundleId, STATE_DB };
