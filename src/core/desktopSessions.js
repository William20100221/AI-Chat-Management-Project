'use strict';

// Claude Desktop keeps one small record per Cowork task or Code session:
//   <root>/<account>/<org>/local_<id>.json
// with fields like title, createdAt, lastActivityAt, cliSessionId and cwd.
// A Cowork task also has a folder next to its record (local_<id>/) that holds its transcript
// under .claude/projects/. A Code session's transcript is in ~/.claude/projects instead.
// None of this is a documented format, so everything here is read defensively.

const fsp = require('fs/promises');
const path = require('path');
const { toMillis } = require('./text');

const RECORD_FILE = /^local_[0-9a-f][0-9a-f-]{7,}\.json$/i;
// Folders that never contain records but can be large.
const SKIP_DIRS = new Set(['outputs', 'uploads', '.claude', 'memory', 'spaces', 'node_modules', '.git']);

async function findRecordFiles(root, maxDepth = 4) {
  const found = [];
  async function walk(dir, depth) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && RECORD_FILE.test(entry.name)) {
        found.push(full);
      } else if (entry.isDirectory() && depth < maxDepth && !SKIP_DIRS.has(entry.name)) {
        await walk(full, depth + 1);
      }
    }
  }
  await walk(root, 0);
  return found;
}

async function isDir(p) {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

// The task folder is either next to the record (local_<id>/) or the record's own parent folder.
async function sessionDirFor(recordFile) {
  const base = path.basename(recordFile, '.json');
  const sibling = path.join(path.dirname(recordFile), base);
  if (await isDir(sibling)) return sibling;
  const parent = path.dirname(recordFile);
  return path.basename(parent) === base ? parent : null;
}

// Claude shows a blue "unread" dot in its sidebar. If a record carries that state, use it.
// (Field names are guesses; Settings → Sources lists the fields actually found.)
function claudeReadState(raw) {
  const readAt = toMillis(raw.lastReadAt ?? raw.lastViewedAt ?? raw.lastSeenAt ?? raw.readAt ?? raw.viewedAt);
  let unread = null;
  for (const key of ['hasUnread', 'unread', 'isUnread', 'hasUnreadMessages']) {
    if (typeof raw[key] === 'boolean') unread = raw[key];
  }
  return { readAt, unread };
}

function parseRecord(raw, recordFile) {
  return {
    keys: Object.keys(raw),
    ...claudeReadState(raw),
    file: recordFile,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : path.basename(recordFile, '.json'),
    cliSessionId: typeof raw.cliSessionId === 'string' ? raw.cliSessionId : null,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : null,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
    createdAt: toMillis(raw.createdAt),
    updatedAt: toMillis(raw.lastActivityAt) || toMillis(raw.updatedAt),
    archived: raw.isArchived === true,
    initialMessage: typeof raw.initialMessage === 'string' ? raw.initialMessage : null,
    looksLikeCowork: raw.hostLoopMode !== undefined,
  };
}

async function readRecord(recordFile) {
  const raw = JSON.parse(await fsp.readFile(recordFile, 'utf8'));
  const record = parseRecord(raw, recordFile);
  record.sessionDir = await sessionDirFor(recordFile);
  return record;
}

// Finds <name>.jsonl (or, without a name, the newest .jsonl) under <sessionDir>/.claude/projects.
async function findTranscriptInSessionDir(sessionDir, cliSessionId) {
  if (!sessionDir) return null;
  const projects = path.join(sessionDir, '.claude', 'projects');
  let folders;
  try {
    folders = await fsp.readdir(projects, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest = null;
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const dir = path.join(projects, folder.name);
    if (cliSessionId) {
      const candidate = path.join(dir, `${cliSessionId}.jsonl`);
      try {
        await fsp.access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    let files;
    try {
      files = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue;
      const full = path.join(dir, name);
      const { mtimeMs } = await fsp.stat(full);
      if (!newest || mtimeMs > newest.mtimeMs) newest = { full, mtimeMs };
    }
  }
  return newest ? newest.full : null;
}

module.exports = { findRecordFiles, readRecord, parseRecord, findTranscriptInSessionDir };
