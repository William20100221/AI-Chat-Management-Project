'use strict';

// Reads another program's SQLite database (a browser's history, the ChatGPT app's chat list)
// without getting in its way: the file is copied, with its -wal / -journal file holding the
// latest changes, to a temporary folder, and the copy is read and then deleted. The original is
// never opened, so the other program never sees a lock or a "database is busy".

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const SIDE_FILES = ['-wal', '-journal'];

function loadSqlite() {
  try {
    // Built into Node 22.5+ and Electron 33+; no extra package.
    return require('node:sqlite');
  } catch {
    return null;
  }
}

// The file's size and time plus its side files', to tell when anything changed.
async function stampOf(file) {
  const parts = [];
  for (const name of [file, ...SIDE_FILES.map((s) => file + s)]) {
    try {
      const { size, mtimeMs } = await fsp.stat(name);
      parts.push(`${size}:${mtimeMs}`);
    } catch {
      parts.push('-');
    }
  }
  return parts.join('/');
}

// Calls read(db) with the copy open, and returns what it returns.
async function withCopy(file, read, { tmpRoot = os.tmpdir(), maxBytes = 1024 * 1024 * 1024 } = {}) {
  const sqlite = loadSqlite();
  if (!sqlite) throw new Error('This version of the app can’t read SQLite files (needs Node 22.5 or newer)');
  const { size } = await fsp.stat(file);
  if (size > maxBytes) throw new Error(`Too big to read (${Math.round(size / 1048576)} MB)`);
  const dir = await fsp.mkdtemp(path.join(tmpRoot, 'ai-chat-manager-'));
  const copy = path.join(dir, 'copy.sqlite');
  let db = null;
  try {
    await fsp.copyFile(file, copy);
    for (const suffix of SIDE_FILES) {
      try {
        await fsp.copyFile(file + suffix, copy + suffix);
      } catch {
        // no recent changes waiting in that file
      }
    }
    db = new sqlite.DatabaseSync(copy);
    return read(db);
  } finally {
    if (db) db.close();
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// The table's column names (empty when the table doesn't exist).
function columnsOf(db, table) {
  return new Set(db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((row) => row.name));
}

module.exports = { withCopy, stampOf, columnsOf, loadSqlite };
