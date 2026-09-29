'use strict';

// Chat data exports, and chat data in general, for every platform:
//
// Claude (claude.ai → Settings → Privacy → Export data)
//  - older: one zip with conversations.json inside
//  - newer: the email gives you a small "manifest" .json listing several zips, each with a
//    one-time download link; your chats are in conversations-000.zip (and -001, -002 … if large)
//  The exact layout inside the newer zips isn't documented, so any .json/.jsonl file is read and
//  anything that looks like a conversation (an id plus a list of messages) is used.
// ChatGPT (chatgpt.com → Settings → Data controls → Export data)
//  - one zip with conversations.json (message trees, see chatgpt.js)

const fsp = require('fs/promises');
const path = require('path');
const { unzipSync, strFromU8 } = require('fflate');
const { truncate, snippet, contentText, toMillis } = require('./text');
const chatgpt = require('./chatgpt');

const MAX_ZIP_BYTES = 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const DATA_FILE = /\.(json|jsonl|ndjson)$/i;

function messageText(message) {
  if (typeof message.text === 'string' && message.text.trim()) return message.text;
  return contentText(message.content);
}

function messageRole(message) {
  const who = message.sender || message.role || (message.author && message.author.role);
  return who === 'human' || who === 'user' ? 'user' : 'assistant';
}

function conversationMessages(conversation) {
  if (Array.isArray(conversation.chat_messages)) return conversation.chat_messages;
  if (Array.isArray(conversation.messages)) return conversation.messages;
  return null;
}

function isConversation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.mapping) return false;
  const id = value.uuid || value.id;
  const messages = conversationMessages(value);
  if (typeof id !== 'string' || !messages) return false;
  // ChatGPT conversations use a "mapping" tree instead; Claude messages have sender human/assistant.
  return messages.length === 0 || messages.some((m) => m && (m.sender || m.role));
}

// A conversation without its messages: id, title and dates only.
function isConversationMeta(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.mapping) return false;
  const id = value.uuid || value.id;
  const name = value.name ?? value.title;
  const dated = value.created_at || value.updated_at || value.createdAt || value.updatedAt;
  return typeof id === 'string' && typeof name === 'string' && Boolean(dated);
}

// Claude shows a blue dot next to chats with a reply you haven't read. If the chat data says so,
// use it. (Field names are guesses; the Testing panel lists the fields actually seen.)
function claudeUnreadState(conversation) {
  let unread = null;
  for (const key of ['is_unread', 'isUnread', 'unread', 'has_unread', 'hasUnread', 'has_unread_messages']) {
    if (typeof conversation[key] === 'boolean') unread = conversation[key];
  }
  for (const key of ['unread_count', 'unreadCount', 'unread_message_count']) {
    if (typeof conversation[key] === 'number') unread = conversation[key] > 0;
  }
  const readAt = toMillis(conversation.last_read_at ?? conversation.lastReadAt ?? conversation.read_at ?? conversation.last_viewed_at);
  return { claudeUnread: unread, claudeReadAt: readAt };
}

function parseConversation(conversation) {
  const uuid = conversation.uuid || conversation.id;
  const messages = (conversationMessages(conversation) || [])
    .filter((m) => m && typeof m === 'object')
    .map((m) => ({
      role: messageRole(m),
      text: snippet(messageText(m)),
      at: toMillis(m.created_at || m.createdAt || m.timestamp),
    }))
    .filter((m) => m.text);
  const rawName = conversation.name ?? conversation.title;
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (!messages.length && !name) return null; // empty "New chat" placeholders

  const questions = messages.filter((m) => m.role === 'user');
  const lastMessageAt = messages.reduce((max, m) => Math.max(max, m.at || 0), 0);
  return {
    id: `chat:${uuid}`,
    uuid,
    platform: 'claude',
    title: name || truncate(questions[0] && questions[0].text, 80) || 'Untitled chat',
    createdAt: toMillis(conversation.created_at || conversation.createdAt),
    updatedAt: Math.max(toMillis(conversation.updated_at || conversation.updatedAt) || 0, lastMessageAt) || null,
    questions,
    firstMessage: messages[0] || null,
    lastMessage: messages[messages.length - 1] || null,
    ...claudeUnreadState(conversation),
    fieldNames: Object.keys(conversation),
  };
}

// Walks parsed JSON and collects conversation objects: a list of them, one per file,
// or a wrapper like { conversations: [...] }. With a `meta` list, title-and-date-only
// conversations are collected there too.
function collectConversations(value, found, meta = null, depth = 0) {
  if (depth > 3 || !value || typeof value !== 'object') return;
  if (chatgpt.isConversation(value) || isConversation(value)) {
    found.push(value);
    return;
  }
  if (meta && (chatgpt.isMeta(value) || isConversationMeta(value))) {
    meta.push(value);
    return;
  }
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    if (child && typeof child === 'object') collectConversations(child, found, meta, depth + 1);
  }
}

function parseDataFile(name, text) {
  const values = [];
  if (/\.(jsonl|ndjson)$/i.test(name)) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        values.push(JSON.parse(line));
      } catch {
        // skip a broken line
      }
    }
  } else {
    values.push(JSON.parse(text));
  }
  return values;
}

function parseAny(conversation) {
  return chatgpt.isConversation(conversation) || chatgpt.isMeta(conversation)
    ? chatgpt.parseConversation(conversation)
    : parseConversation(conversation);
}

// Every Claude or ChatGPT conversation in a piece of JSON; each chat says which platform it's from.
function parseConversations(value) {
  const found = [];
  collectConversations(value, found);
  if (!found.length) collectConversations(value, [], found); // titles and dates only
  const chats = new Map();
  for (const conversation of found) {
    const chat = parseAny(conversation);
    if (chat) chats.set(chat.id, chat);
  }
  return [...chats.values()];
}

// Returns the parsed chats, or null when the zip holds no Claude or ChatGPT conversations.
function readExportZip(buffer) {
  const files = unzipSync(new Uint8Array(buffer), { filter: (file) => DATA_FILE.test(file.name) });
  const found = [];
  const meta = [];
  for (const [name, bytes] of Object.entries(files)) {
    let values;
    try {
      values = parseDataFile(name, strFromU8(bytes));
    } catch {
      continue;
    }
    const metaList = /conversation/i.test(name) ? meta : null;
    for (const value of values) collectConversations(value, found, metaList);
  }
  // Full conversations when there are any; otherwise at least the titles and dates.
  const chats = parseConversations(found.length ? found : meta);
  return chats.length ? chats : null;
}

// ---- manifest (newer export format) ----

function isClaudeExportUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'claude.ai' && url.pathname.startsWith('/export/');
  } catch {
    return false;
  }
}

// Returns { createdAt, files: [{ category, filename, url }] } or null if it isn't a Claude export manifest.
function parseManifest(value) {
  if (!value || !Array.isArray(value.data_files)) return null;
  const files = value.data_files
    .filter((f) => f && isClaudeExportUrl(f.export_url))
    .map((f) => ({ category: String(f.category || ''), filename: String(f.filename || ''), url: f.export_url }));
  if (!files.length) return null;
  return { createdAt: toMillis(value.created_at) || Date.now(), files };
}

// Accepts an export .zip, a manifest .json, or an already-unzipped conversations .json.
// Returns { kind: 'chats', chats, part } | { kind: 'manifest', manifest } | null.
async function readExportFile(filePath) {
  const { size } = await fsp.stat(filePath);
  const name = path.basename(filePath);
  if (/\.json$/i.test(name)) {
    if (size > MAX_ZIP_BYTES) return null;
    const value = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    const manifest = parseManifest(value);
    if (manifest) return { kind: 'manifest', manifest };
    const chats = parseConversations(value);
    return chats.length ? { kind: 'chats', chats, part: 0, platform: chats[0].platform } : null;
  }
  if (size > MAX_ZIP_BYTES) throw new Error('File is too large to be a chat export');
  const chats = readExportZip(await fsp.readFile(filePath));
  return chats ? { kind: 'chats', chats, part: exportPart(name), platform: chats[0].platform } : null;
}

// conversations-001.zip → 1; anything else → 0.
function exportPart(fileName) {
  const match = /conversations-(\d+)/i.exec(fileName);
  return match ? Number(match[1]) : 0;
}

// ---- spotting exports in Downloads ----

// Lists the file names inside a zip by reading only its table of contents at the end of the file,
// so unrelated big zips in Downloads are never loaded. Returns null if the zip can't be read this way.
async function zipEntryNames(filePath) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, 65557); // end record (22 bytes) + longest possible comment
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    let end = -1;
    for (let i = tailLength - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        end = i;
        break;
      }
    }
    if (end < 0) return null;
    const count = tail.readUInt16LE(end + 10);
    const dirSize = tail.readUInt32LE(end + 12);
    const dirOffset = tail.readUInt32LE(end + 16);
    if (dirOffset === 0xffffffff || dirOffset + dirSize > size) return null; // zip64: not worth handling here
    const dir = Buffer.alloc(dirSize);
    await handle.read(dir, 0, dirSize, dirOffset);
    const names = [];
    let pos = 0;
    for (let i = 0; i < count && pos + 46 <= dir.length; i++) {
      if (dir.readUInt32LE(pos) !== 0x02014b50) return null;
      const nameLength = dir.readUInt16LE(pos + 28);
      const extraLength = dir.readUInt16LE(pos + 30);
      const commentLength = dir.readUInt16LE(pos + 32);
      names.push(dir.toString('utf8', pos + 46, pos + 46 + nameLength));
      pos += 46 + nameLength + extraLength + commentLength;
    }
    return names;
  } finally {
    await handle.close();
  }
}

// Cheap first check for a zip in Downloads: could it hold Claude or ChatGPT conversations?
async function mightBeClaudeExport(filePath) {
  if (/^conversations-\d+/i.test(path.basename(filePath))) return true;
  const names = await zipEntryNames(filePath);
  if (!names) return true; // unusual zip: let the full reader decide
  return names.some((n) => /conversation/i.test(n) && DATA_FILE.test(n));
}

// Zip files, and small .json files that could be a manifest, that are new since we last looked.
async function findCandidateFiles(downloadsDir, seen, maxAgeDays = 30) {
  let names;
  try {
    names = await fsp.readdir(downloadsDir);
  } catch {
    return [];
  }
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const candidates = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    const isZip = lower.endsWith('.zip');
    const isJson = lower.endsWith('.json');
    if (!isZip && !isJson) continue;
    const full = path.join(downloadsDir, name);
    let stat;
    try {
      stat = await fsp.stat(full);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.mtimeMs < cutoff) continue;
    if (stat.size > (isZip ? MAX_ZIP_BYTES : MAX_MANIFEST_BYTES)) continue;
    const key = `${full}|${stat.size}|${Math.round(stat.mtimeMs)}`;
    if (seen[key]) continue;
    candidates.push({ file: full, key, kind: isZip ? 'zip' : 'json', mtimeMs: stat.mtimeMs, size: stat.size });
  }
  return candidates.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first, so part 000 lands before 001
}

module.exports = {
  parseConversations,
  readExportZip,
  readExportFile,
  parseManifest,
  isClaudeExportUrl,
  exportPart,
  findCandidateFiles,
  zipEntryNames,
  mightBeClaudeExport,
};
