'use strict';

// Reads a Claude Code transcript (.jsonl, one JSON object per line). Code sessions and
// Cowork tasks both use this format; only the folder they live in differs.

const fs = require('fs');
const readline = require('readline');
const { truncate, contentText, toMillis } = require('./text');

// User lines that are not questions: slash commands, command output, interruptions.
const NOISE_PREFIXES = [
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<local-command-caveat>',
  'Caveat: The messages below',
  '[Request interrupted',
];

function cleanUserText(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g, '')
    .trim();
}

function isQuestion(entry, text) {
  if (entry.isMeta || entry.isSidechain || entry.toolUseResult !== undefined) return false;
  if (!text) return false;
  return !NOISE_PREFIXES.some((prefix) => text.startsWith(prefix));
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
      const text = cleanUserText(contentText(entry.message && entry.message.content));
      if (!isQuestion(entry, text)) break;
      const message = { role: 'user', text: truncate(text), at };
      summary.questions.push(message);
      if (!summary.firstMessage) summary.firstMessage = message;
      summary.lastMessage = message;
      break;
    }
    case 'assistant': {
      if (entry.isSidechain) break;
      const text = contentText(entry.message && entry.message.content, { images: false }).trim();
      if (!text) break; // tool-only turns have no text
      const message = { role: 'assistant', text: truncate(text), at };
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
