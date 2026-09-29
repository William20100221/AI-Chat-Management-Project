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
        break;
      }
      if (entry.isMeta) break;
      const text = cleanUserText(contentText(entry.message && entry.message.content));
      if (!text) break;
      if (text.startsWith(INTERRUPTED)) {
        summary.pending = false;
        break;
      }
      if (NOISE_PREFIXES.some((prefix) => text.startsWith(prefix))) break;
      const message = { role: 'user', text: snippet(text), at };
      summary.questions.push(message);
      if (!summary.firstMessage) summary.firstMessage = message;
      summary.lastMessage = message;
      summary.pending = true;
      break;
    }
    case 'assistant': {
      if (entry.isSidechain) break;
      const stop = entry.message && entry.message.stop_reason;
      if (FINISHED_STOP_REASONS.has(stop)) {
        summary.pending = false;
        summary.finishedAt = at || summary.finishedAt;
      } else {
        summary.pending = true; // calling a tool, or still streaming
      }
      const text = contentText(entry.message && entry.message.content, { images: false }).trim();
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

function transcriptTitle(summary) {
  if (!summary) return null;
  if (summary.customTitle) return summary.customTitle;
  if (summary.aiTitle) return summary.aiTitle;
  if (summary.summaryTitle) return summary.summaryTitle;
  const first = summary.questions[0];
  return first ? truncate(first.text, 80) : null;
}

module.exports = { parseTranscript, transcriptTitle, applyEntry, emptySummary };
