'use strict';

// Gemini CLI (Google's coding agent in the terminal) saves each session on this computer:
//   ~/.gemini/tmp/<project>/chats/session-<time>-<id>.jsonl      (~ is $GEMINI_CLI_HOME if set)
//   ~/.gemini/tmp/<project>/.project_root                         the project's folder
// Helper sessions (sub-agents) sit one folder deeper and are skipped.
// Each line is one record (packages/core/src/services/chatRecordingService.ts):
//   { sessionId, projectHash, startTime, lastUpdated, kind? }    the first line: about the session
//   { id, timestamp, type: 'user'|'gemini'|'info'|'error'|'warning', content, toolCalls? }
//                                                                 a message; the same id again replaces it
//   { $set: { summary?, lastUpdated?, messages? } }              an update (summary = the title)
//   { $rewindTo: <message id> }                                  that message and later ones were undone
// Older versions wrote the whole session as one JSON object in session-….json; both are read.

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { truncate, snippet, toMillis } = require('./text');
const { endsWithQuestion } = require('./transcript');

function geminiHome({ env = process.env, home = os.homedir() } = {}) {
  return path.join(env.GEMINI_CLI_HOME || home, '.gemini');
}

// Every main session file: [{ file, project }] (project = the folder it ran in, when known).
async function findSessionFiles(geminiDir) {
  const tmp = path.join(geminiDir, 'tmp');
  const found = [];
  let projects;
  try {
    projects = await fsp.readdir(tmp, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(tmp, project.name);
    let root = null;
    try {
      root = (await fsp.readFile(path.join(dir, '.project_root'), 'utf8')).trim() || null;
    } catch {
      // older versions named the folder by a hash and left no marker
    }
    let files;
    try {
      files = await fsp.readdir(path.join(dir, 'chats'), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of files) {
      if (entry.isFile() && /^session-.*\.jsonl?$/.test(entry.name)) found.push({ file: path.join(dir, 'chats', entry.name), project: root });
    }
  }
  return found;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (part && typeof part.text === 'string' ? part.text : typeof part === 'string' ? part : '')).join('');
  if (content && typeof content.text === 'string') return content.text;
  return '';
}

// Commands and added context aren't questions (same rule as Gemini CLI's own session list).
function isRealPrompt(text) {
  const t = text.trim();
  return Boolean(t) && !t.startsWith('/') && !t.startsWith('?') && !t.startsWith('<session_context>') && !t.startsWith('<hook_context>');
}

const OPEN_TOOL_STATES = new Set(['validating', 'scheduled', 'executing', 'awaiting_approval']);

// Replays the records into the session as Gemini CLI would show it.
function replay(records) {
  let meta = {};
  let messages = new Map(); // id → message, in order
  const setMessages = (list) => {
    messages = new Map();
    for (const m of list) if (m && typeof m.id === 'string') messages.set(m.id, m);
  };
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    if (typeof record.$rewindTo === 'string') {
      const ids = [...messages.keys()];
      const at = ids.indexOf(record.$rewindTo);
      if (at === -1) messages.clear();
      else for (const id of ids.slice(at)) messages.delete(id);
    } else if (typeof record.id === 'string') {
      messages.set(record.id, record); // a message written again (while streaming) keeps its place
    } else if (record.$set && typeof record.$set === 'object') {
      if (Array.isArray(record.$set.messages)) setMessages(record.$set.messages);
      meta = { ...meta, ...record.$set };
    } else if (typeof record.sessionId === 'string') {
      meta = { ...meta, ...record };
      if (Array.isArray(record.messages)) setMessages(record.messages);
    }
  }
  delete meta.messages;
  return { meta, messages: [...messages.values()] };
}

async function readRecords(file) {
  const raw = await fsp.readFile(file, 'utf8');
  if (file.endsWith('.json')) {
    try {
      return [JSON.parse(raw)];
    } catch {
      return [];
    }
  }
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // half-written last line
    }
  }
  return records;
}

// → { sessionId, title, createdAt, updatedAt, questions, firstMessage, lastMessage, pending,
//     finishedAt, asking, asks, subagent }
async function parseSession(file) {
  const { meta, messages } = replay(await readRecords(file));
  const conversation = [];
  let lastAi = null;
  let asking = null;
  let pending = false;
  for (const m of messages) {
    const at = toMillis(m.timestamp);
    const text = textOf(m.displayContent || m.content);
    if (m.type === 'user') {
      if (!isRealPrompt(text)) continue;
      conversation.push({ role: 'user', text: snippet(text), at });
      pending = true;
      asking = null;
      lastAi = null;
    } else if (m.type === 'gemini') {
      const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
      const waiting = calls.find((c) => c && c.status === 'awaiting_approval');
      const open = calls.some((c) => c && OPEN_TOOL_STATES.has(c.status));
      if (text.trim()) {
        conversation.push({ role: 'assistant', text: snippet(text), at });
        lastAi = { text, at };
      }
      asking = waiting ? { text: `Gemini wants to run: ${truncate(waiting.displayName || waiting.name || 'a tool', 100)}`, at } : null;
      // A reply with text and no tool still running ends the turn; tool steps mean it's still working.
      pending = open || !text.trim();
    }
  }
  const questions = conversation.filter((m) => m.role === 'user');
  const summary = typeof meta.summary === 'string' && meta.summary.trim() ? meta.summary.trim() : null;
  return {
    sessionId: typeof meta.sessionId === 'string' ? meta.sessionId : null,
    subagent: meta.kind === 'subagent',
    title: summary ? truncate(summary, 80) : questions[0] ? truncate(questions[0].text, 80) : null,
    createdAt: toMillis(meta.startTime) || (conversation[0] && conversation[0].at) || null,
    updatedAt: toMillis(meta.lastUpdated) || (conversation.length ? conversation[conversation.length - 1].at : null),
    questions,
    firstMessage: conversation[0] || null,
    lastMessage: conversation[conversation.length - 1] || null,
    pending,
    finishedAt: !pending && lastAi ? lastAi.at : null,
    asking,
    asks: !pending && lastAi ? endsWithQuestion(lastAi.text) : false,
  };
}

function isInstalled(options) {
  try {
    return fs.statSync(geminiHome(options)).isDirectory();
  } catch {
    return false;
  }
}

module.exports = { geminiHome, findSessionFiles, parseSession, replay, isInstalled };
