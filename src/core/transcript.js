'use strict';

// Reads a Claude Code transcript (.jsonl, one JSON object per line). Code sessions and
// Cowork tasks both use this format; only the folder they live in differs.
//
// Besides titles and questions it tracks whether Claude is still in the middle of a reply:
// a turn is finished once an assistant message ends with stop_reason "end_turn" (or the user
// interrupts); your message, a tool result, or a reply that stopped to call a tool means
// Claude is still going.

const fs = require('fs');
const readline = require('readline');
const { truncate, snippet, contentText, toMillis } = require('./text');

// User lines that are not questions: slash commands, command output, interruptions.
const NOISE_PREFIXES = [
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<local-command-caveat>',
  'Caveat: The messages below',
];
const INTERRUPTED = '[Request interrupted';
const FINISHED_STOP_REASONS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);

// Tools that stop Claude until you answer: a multiple-choice question, or a plan to approve.
const QUESTION_TOOLS = {
  AskUserQuestion: (input) => {
    const first = input && Array.isArray(input.questions) && input.questions[0];
    return (first && first.question) || 'Claude has a question for you';
  },
  ExitPlanMode: () => 'Claude has a plan ready for your approval',
};

// A finished reply that ends with a question ("Want me to…?") is waiting for you too.
function endsWithQuestion(text) {
  return /\?["'”’)\]]*\s*$/.test(String(text || '').trim());
}

function questionFrom(content) {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block && block.type === 'tool_use' && QUESTION_TOOLS[block.name]) return QUESTION_TOOLS[block.name](block.input);
  }
  return null;
}

function cleanUserText(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g, '')
    .trim();
}

function isToolResult(entry) {
  if (entry.toolUseResult !== undefined) return true;
  const content = entry.message && entry.message.content;
  return Array.isArray(content) && content.some((block) => block && block.type === 'tool_result');
}

function emptySummary() {
  return {
    sessionId: null,
    cwd: null,
    createdAt: null,
    updatedAt: null,
    customTitle: null,
    aiTitle: null,
    summaryTitle: null,
    questions: [],
    firstMessage: null,
    lastMessage: null,
    pending: false, // Claude has not finished the latest turn
    finishedAt: null, // when Claude last finished a reply
    asking: null, // { text, at } while Claude waits for your answer
    asks: false, // the last finished reply ends with a question
  };
}

function applyEntry(summary, entry) {
  if (!entry || typeof entry !== 'object') return;
  if (!summary.sessionId && entry.sessionId) summary.sessionId = entry.sessionId;
  if (!summary.cwd && entry.cwd) summary.cwd = entry.cwd;

  const at = toMillis(entry.timestamp);
  if (at) {
    if (!summary.createdAt || at < summary.createdAt) summary.createdAt = at;
    if (!summary.updatedAt || at > summary.updatedAt) summary.updatedAt = at;
  }

  switch (entry.type) {
    case 'custom-title': // written by /rename; the last one wins
      if (entry.customTitle) summary.customTitle = entry.customTitle;
      break;
    case 'ai-title':
      if (entry.aiTitle) summary.aiTitle = entry.aiTitle;
      break;
    case 'summary':
      if (entry.summary) summary.summaryTitle = entry.summary;
      break;
    case 'user': {
      if (entry.isSidechain) break; // a helper agent's turn, not yours
      if (isToolResult(entry)) {
        summary.pending = true; // Claude will carry on after the tool
        summary.asking = null; // a question tool gets its answer as a tool result
        break;
      }
      if (entry.isMeta) break;
      const text = cleanUserText(contentText(entry.message && entry.message.content));
      if (!text) break;
      if (text.startsWith(INTERRUPTED)) {
        summary.pending = false;
        summary.asking = null;
        break;
      }
      if (NOISE_PREFIXES.some((prefix) => text.startsWith(prefix))) break;
      const message = { role: 'user', text: snippet(text), at };
      summary.questions.push(message);
      if (!summary.firstMessage) summary.firstMessage = message;
      summary.lastMessage = message;
      summary.pending = true;
      summary.asking = null;
      summary.asks = false;
      break;
    }
    case 'assistant': {
      if (entry.isSidechain) break;
      const stop = entry.message && entry.message.stop_reason;
      const content = entry.message && entry.message.content;
      const question = questionFrom(content);
      if (question) summary.asking = { text: snippet(question, 200), at };
      const text = contentText(content, { images: false }).trim();
      if (FINISHED_STOP_REASONS.has(stop)) {
        summary.pending = false;
        summary.asking = null;
        summary.finishedAt = at || summary.finishedAt;
        if (text) summary.asks = endsWithQuestion(text);
      } else {
        summary.pending = true; // calling a tool, or still streaming
      }
      if (!text) break; // tool-only turns have no text
      const message = { role: 'assistant', text: snippet(text), at };
      if (!summary.firstMessage) summary.firstMessage = message;
      summary.lastMessage = message;
      break;
    }
    default:
      break;
  }
}

async function parseTranscript(filePath) {
  const summary = emptySummary();
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // the last line can be half-written while Claude is still typing
    }
    applyEntry(summary, entry);
  }
  return summary;
}

// Claude Code's own note of each running session: ~/.claude/sessions/<pid>.json, with its state:
// busy or shell (working), waiting (needs you: a question, a permission prompt) or idle. Only the
// .json files are read; the .key files next to them hold connection tokens. Notes left behind by
// a session whose process has ended are skipped. Returns sessionId → state.
async function readLiveSessions(dir, isAlive = processAlive) {
  const live = new Map();
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return live;
  }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const note = JSON.parse(await fs.promises.readFile(`${dir}/${name}`, 'utf8'));
      if (note.sessionId && isAlive(note.pid)) live.set(note.sessionId, note.status);
    } catch {
      // being rewritten: the next scan reads it
    }
  }
  return live;
}

// ponytail: a crashed session's pid reused by another process looks alive until Claude Code
// rewrites the note; compare the note's procStart with the process start time if that shows up.
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, just not ours to signal
  }
}

// What Claude Code says about a running session beats guessing from its transcript: a long tool
// run can go quiet for minutes, and a permission prompt looks like a turn still in progress.
function withLiveState(activity, state, now = Date.now()) {
  if (!activity || !state) return activity;
  if (state === 'busy' || state === 'shell') return { ...activity, pending: true, asking: null, lastWriteAt: now };
  if (state === 'waiting') {
    const asking = activity.asking || { text: 'Claude is waiting for your answer or approval', at: now };
    return { ...activity, pending: false, asking, lastWriteAt: now };
  }
  if (state === 'idle') return { ...activity, pending: false };
  return activity;
}

function transcriptTitle(summary) {
  if (!summary) return null;
  if (summary.customTitle) return summary.customTitle;
  if (summary.aiTitle) return summary.aiTitle;
  if (summary.summaryTitle) return summary.summaryTitle;
  const first = summary.questions[0];
  return first ? truncate(first.text, 80) : null;
}

module.exports = { parseTranscript, transcriptTitle, applyEntry, emptySummary, endsWithQuestion, readLiveSessions, withLiveState };
