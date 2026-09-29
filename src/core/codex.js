'use strict';

// Codex (OpenAI's coding agent) keeps each session on this computer as
//   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl   ($CODEX_HOME defaults to ~/.codex)
// One JSON object per line: { timestamp, type, payload }.
//   session_meta   first line; payload { id, cwd, timestamp, ... }
//   response_item  payload { type: 'message', role, content: [{ type: 'input_text'|'output_text', text }] },
//                  or a tool step: function_call, function_call_output, reasoning, …
//   event_msg      payload { type: 'user_message', message } | 'agent_message' | 'task_started' |
//                  'task_complete' | 'turn_aborted' | '…_approval_request' …
// Older Codex versions wrote the items without the { type, payload } wrapper; both are read.
// Like the Claude readers, this is an undocumented format, read defensively.
//
// Since July 2026 the ChatGPT desktop app *is* the Codex app, so its "Work" and "Codex" chats are
// these same files. session_meta.originator says which: "codex_work_desktop" (and other
// "codex_work_…" names) for Work, anything else for Codex.

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { truncate, snippet, toMillis } = require('./text');
const { endsWithQuestion } = require('./transcript');

function codexHome({ env = process.env, home = os.homedir() } = {}) {
  return env.CODEX_HOME || path.join(home, '.codex');
}

async function findRolloutFiles(sessionsDir, maxDepth = 4) {
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
      if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(full);
      else if (entry.isDirectory() && depth < maxDepth) await walk(full, depth + 1);
    }
  }
  await walk(sessionsDir, 0);
  return found;
}

// Codex adds setup text (environment, AGENTS.md) as "user" messages; those aren't your questions.
const CONTEXT_PREFIXES = ['<environment_context>', '<user_instructions>', '<permissions', '<INSTRUCTIONS>', '# AGENTS.md'];
const TOOL_STEPS = new Set(['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'local_shell_call', 'reasoning', 'web_search_call']);

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (block && typeof block.text === 'string' ? block.text : '')).filter(Boolean).join('\n');
}

function isRealPrompt(text) {
  const trimmed = text.trim();
  return Boolean(trimmed) && !CONTEXT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function approvalText(payload) {
  const command = Array.isArray(payload.command) ? payload.command.join(' ') : payload.command;
  if (command) return `Codex wants to run: ${truncate(String(command), 120)}`;
  if (/patch/i.test(payload.type)) return 'Codex wants to change files';
  return 'Codex is waiting for your approval';
}

// Work chats vs Codex sessions, from session_meta.originator (or the threads table's column).
function threadKind(originator) {
  return /^(codex_work|chatgpt_cca)/i.test(String(originator || '')) ? 'work' : 'codex';
}

// Helper threads Codex starts by itself (sub-agents, approval reviews, memory, title writing).
// The ChatGPT app doesn't list them, so neither do we.
const BACKGROUND_THREAD_SOURCES = new Set(['subagent', 'guardian_review', 'memory_consolidation', 'system', 'thread_title']);
function isBackgroundThread({ source, threadSource } = {}) {
  if (threadSource && BACKGROUND_THREAD_SOURCES.has(String(threadSource))) return true;
  const text = typeof source === 'string' ? source : source ? JSON.stringify(source) : '';
  return /^\s*\{\s*"(subagent|sub_agent|internal)"/i.test(text);
}

// $CODEX_HOME/session_index.jsonl: one { id, thread_name, updated_at } per line, appended each time
// a chat is named or renamed. The newest line for an id wins.
async function readSessionIndex(file) {
  const names = new Map();
  let input;
  try {
    await fsp.access(file);
    input = fs.createReadStream(file, { encoding: 'utf8' });
  } catch {
    return names;
  }
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const raw of lines) {
    try {
      const entry = JSON.parse(raw);
      if (entry && typeof entry.id === 'string' && typeof entry.thread_name === 'string') {
        if (entry.thread_name.trim()) names.set(entry.id.toLowerCase(), entry.thread_name.trim());
        else names.delete(entry.id.toLowerCase());
      }
    } catch {
      // half-written line
    }
  }
  return names;
}

function emptySummary() {
  return {
    sessionId: null,
    cwd: null,
    originator: null,
    source: null,
    threadSource: null,
    createdAt: null,
    updatedAt: null,
    fromEvents: [], // messages from event_msg (preferred: exactly what you typed and saw)
    fromItems: [], // the same conversation from response_item, for older files
    lastAssistantText: '',
    sawTaskEvents: false,
    pending: false,
    finishedAt: null,
    asking: null,
    asks: false,
  };
}

// Turns one line into { kind, payload } whether or not it has the newer wrapper.
function unwrap(line) {
  if (line && typeof line.type === 'string' && line.payload && typeof line.payload === 'object') return { kind: line.type, payload: line.payload };
  if (line && line.id && line.timestamp && !line.type) return { kind: 'session_meta', payload: line };
  if (line && line.type === 'message') return { kind: 'response_item', payload: line };
  return { kind: null, payload: line || {} };
}

function finish(s, at) {
  s.pending = false;
  s.asking = null;
  s.finishedAt = at || s.finishedAt;
  s.asks = endsWithQuestion(s.lastAssistantText);
}

function applyLine(s, line) {
  const at = toMillis(line && line.timestamp);
  if (at) {
    if (!s.createdAt || at < s.createdAt) s.createdAt = at;
    if (!s.updatedAt || at > s.updatedAt) s.updatedAt = at;
  }
  const { kind, payload } = unwrap(line);
  if (kind === 'session_meta') {
    // A resumed or forked session can repeat session_meta; the first one describes this file.
    if (s.sessionId && payload.id && String(payload.id) !== s.sessionId) return;
    if (payload.id) s.sessionId = String(payload.id);
    if (payload.cwd) s.cwd = payload.cwd;
    if (typeof payload.originator === 'string') s.originator = payload.originator;
    if (payload.source !== undefined) s.source = payload.source;
    if (typeof payload.thread_source === 'string') s.threadSource = payload.thread_source;
    const started = toMillis(payload.timestamp);
    if (started && (!s.createdAt || started < s.createdAt)) s.createdAt = started;
    return;
  }
  if (kind === 'turn_context') {
    if (!s.cwd && payload.cwd) s.cwd = payload.cwd;
    return;
  }
  if (kind === 'event_msg') {
    const type = payload.type || '';
    if (type === 'user_message' && typeof payload.message === 'string' && isRealPrompt(payload.message)) {
      s.fromEvents.push({ role: 'user', text: snippet(payload.message), at });
      s.pending = true;
      s.asking = null;
      s.asks = false;
    } else if (type === 'agent_message' && typeof payload.message === 'string') {
      s.fromEvents.push({ role: 'assistant', text: snippet(payload.message), at });
      s.lastAssistantText = payload.message;
    } else if (type === 'task_started') {
      s.sawTaskEvents = true;
      s.pending = true;
    } else if (type === 'task_complete') {
      s.sawTaskEvents = true;
      if (typeof payload.last_agent_message === 'string' && payload.last_agent_message) {
        s.lastAssistantText = payload.last_agent_message;
        // The final answer, when no agent_message carried it.
        const last = s.fromEvents[s.fromEvents.length - 1];
        if (last && last.role === 'user') s.fromEvents.push({ role: 'assistant', text: snippet(payload.last_agent_message), at });
      }
      finish(s, at);
    } else if (type === 'turn_aborted') {
      s.pending = false;
      s.asking = null;
    } else if (/approval_request$/.test(type) || type === 'request_user_input') {
      s.asking = { text: approvalText(payload), at };
    } else if (type !== 'token_count') {
      s.asking = null; // anything else happening means the approval was answered
    }
    return;
  }
  if (kind === 'response_item') {
    const type = payload.type || '';
    if (type === 'message') {
      const text = textOf(payload.content);
      if (payload.role === 'user' && isRealPrompt(text)) {
        s.fromItems.push({ role: 'user', text: snippet(text), at });
        s.pending = true;
        s.asks = false;
      } else if (payload.role === 'assistant' && text.trim()) {
        s.fromItems.push({ role: 'assistant', text: snippet(text), at });
        s.lastAssistantText = text;
        // Without task events (older Codex), a final answer ends the turn.
        if (!s.sawTaskEvents && payload.phase !== 'commentary') finish(s, at);
      }
    } else if (TOOL_STEPS.has(type)) {
      s.pending = true;
      if (type.endsWith('_output')) s.asking = null;
    }
  }
}

async function parseRollout(filePath) {
  const s = emptySummary();
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const raw of lines) {
    if (!raw.trim()) continue;
    try {
      applyLine(s, JSON.parse(raw));
    } catch {
      // half-written last line
    }
  }
  const messages = s.fromEvents.some((m) => m.role === 'user') ? s.fromEvents : s.fromItems;
  const questions = messages.filter((m) => m.role === 'user');
  if (!s.sessionId) {
    const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(filePath);
    if (match) s.sessionId = match[1];
  }
  return {
    sessionId: s.sessionId,
    cwd: s.cwd,
    kind: threadKind(s.originator),
    background: isBackgroundThread(s),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    title: questions[0] ? truncate(questions[0].text, 80) : null,
    questions,
    firstMessage: messages[0] || null,
    lastMessage: messages[messages.length - 1] || null,
    pending: s.pending,
    finishedAt: s.finishedAt,
    asking: s.asking,
    asks: s.asks,
  };
}

module.exports = { codexHome, findRolloutFiles, parseRollout, applyLine, emptySummary, threadKind, isBackgroundThread, readSessionIndex };
