'use strict';

// Reads the zip you get from claude.ai → Settings → Privacy → Export data.
// Inside is conversations.json: [{ uuid, name, created_at, updated_at, chat_messages: [...] }].

const fsp = require('fs/promises');
const path = require('path');
const { unzipSync, strFromU8 } = require('fflate');
const { truncate, contentText, toMillis } = require('./text');

const MAX_ZIP_BYTES = 1024 * 1024 * 1024;

function messageText(message) {
  if (typeof message.text === 'string' && message.text.trim()) return message.text;
  return contentText(message.content);
}

function parseClaudeConversations(conversations) {
  const chats = [];
  for (const conversation of conversations) {
    if (!conversation || typeof conversation.uuid !== 'string') continue;
    const messages = (Array.isArray(conversation.chat_messages) ? conversation.chat_messages : [])
      .map((m) => ({
        role: m.sender === 'human' ? 'user' : 'assistant',
        text: truncate(messageText(m)),
        at: toMillis(m.created_at),
      }))
      .filter((m) => m.text);
    const name = typeof conversation.name === 'string' ? conversation.name.trim() : '';
    if (!messages.length && !name) continue; // empty "New chat" placeholders

    const questions = messages.filter((m) => m.role === 'user');
    const lastMessageAt = messages.reduce((max, m) => Math.max(max, m.at || 0), 0);
    chats.push({
      id: `chat:${conversation.uuid}`,
      uuid: conversation.uuid,
      title: name || truncate(questions[0] && questions[0].text, 80) || 'Untitled chat',
      createdAt: toMillis(conversation.created_at),
      updatedAt: Math.max(toMillis(conversation.updated_at) || 0, lastMessageAt) || null,
      questions,
      firstMessage: messages[0] || null,
      lastMessage: messages[messages.length - 1] || null,
    });
  }
  return chats;
}

// ChatGPT's export also has a conversations.json, but its items use "mapping" instead of "chat_messages".
function isClaudeConversations(value, fileNames) {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return fileNames.some((n) => /(^|\/)users\.json$/i.test(n));
  return value.some((c) => c && typeof c.uuid === 'string' && Array.isArray(c.chat_messages));
}

// Returns the parsed chats, or null when the zip is not a Claude export.
function readClaudeExportZip(buffer) {
  const wanted = /(^|\/)(conversations|users)\.json$/i;
  const files = unzipSync(new Uint8Array(buffer), { filter: (file) => wanted.test(file.name) });
  const names = Object.keys(files);
  const conversationsName = names.find((n) => /(^|\/)conversations\.json$/i.test(n));
  if (!conversationsName) return null;
  const conversations = JSON.parse(strFromU8(files[conversationsName]));
  if (!isClaudeConversations(conversations, names)) return null;
  return parseClaudeConversations(conversations);
}

// Accepts the export .zip or an already-unzipped conversations.json.
async function readClaudeExportFile(filePath) {
  const { size } = await fsp.stat(filePath);
  if (size > MAX_ZIP_BYTES) throw new Error('File is too large to be a Claude export');
  const buffer = await fsp.readFile(filePath);
  if (path.extname(filePath).toLowerCase() === '.json') {
    const conversations = JSON.parse(buffer.toString('utf8'));
    return isClaudeConversations(conversations, []) ? parseClaudeConversations(conversations) : null;
  }
  return readClaudeExportZip(buffer);
}

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

// True when the zip contains conversations.json (checked cheaply, without unzipping).
async function mightBeClaudeExport(filePath) {
  const names = await zipEntryNames(filePath);
  if (!names) return true; // unusual zip: let the full reader decide
  return names.some((n) => /(^|\/)conversations\.json$/i.test(n));
}

// Zip files in the Downloads folder that are new since we last looked.
async function findCandidateZips(downloadsDir, seen, maxAgeDays = 30) {
  let names;
  try {
    names = await fsp.readdir(downloadsDir);
  } catch {
    return [];
  }
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const candidates = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.zip')) continue;
    const full = path.join(downloadsDir, name);
    let stat;
    try {
      stat = await fsp.stat(full);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.mtimeMs < cutoff || stat.size > MAX_ZIP_BYTES) continue;
    const key = `${full}|${stat.size}|${Math.round(stat.mtimeMs)}`;
    if (seen[key]) continue;
    candidates.push({ file: full, key, mtimeMs: stat.mtimeMs, size: stat.size });
  }
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

module.exports = {
  parseClaudeConversations,
  readClaudeExportZip,
  readClaudeExportFile,
  findCandidateZips,
  zipEntryNames,
  mightBeClaudeExport,
};
