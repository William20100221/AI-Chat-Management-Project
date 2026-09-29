'use strict';

// Collects everything into one list: Claude chats, Cowork tasks and Code sessions, ChatGPT chats
// and Codex sessions. Each item says which platform it's from and what type it is.
// Files are only re-read when they change (same size and modified time → cached result).

const fsp = require('fs/promises');
const path = require('path');
const { locateSources } = require('./paths');
const { findRecordFiles, readRecord, findTranscriptInSessionDir } = require('./desktopSessions');
const { parseTranscript, transcriptTitle } = require('./transcript');
const { codexHome, findRolloutFiles, parseRollout } = require('./codex');
const { chatUrl } = require('./platforms');
const { truncate } = require('./text');

const DESKTOP_LABELS = {
  'local-agent-mode-sessions': 'Claude Desktop – Cowork tasks',
  'claude-code-sessions': 'Claude Desktop – Code sessions',
};

class Scanner {
  constructor(locateOptions = {}) {
    this.locateOptions = locateOptions;
    this.cache = new Map(); // file → { size, mtimeMs, value }
  }

  async cached(file, read) {
    const { size, mtimeMs } = await fsp.stat(file);
    const hit = this.cache.get(file);
    if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.value;
    const value = await read(file);
    this.cache.set(file, { size, mtimeMs, value });
    return value;
  }

  // When the file was last written: a transcript that is still growing means Claude is busy.
  lastWrite(file) {
    const hit = this.cache.get(file);
    return hit ? hit.mtimeMs : null;
  }

  // Every <session-id>.jsonl directly inside ~/.claude/projects/<project>/ (not subagent files).
  async indexProjectTranscripts(projectsDir) {
    const index = new Map();
    let projects;
    try {
      projects = await fsp.readdir(projectsDir, { withFileTypes: true });
    } catch {
      return index;
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const dir = path.join(projectsDir, project.name);
      let files;
      try {
        files = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const name of files) {
        if (name.endsWith('.jsonl')) index.set(path.basename(name, '.jsonl'), path.join(dir, name));
      }
    }
    return index;
  }

  // local: false skips Claude's files on this computer (a Testing panel switch).
  async scan(importedChats = [], { local = true } = {}) {
    const locations = local
      ? locateSources(this.locateOptions)
      : { desktopDirs: [], sessionRoots: [], projectsDir: null, projectsDirExists: false };
    const items = new Map();
    const sources = [];
    const liveFiles = new Set();
    const projectTranscripts = await this.indexProjectTranscripts(locations.projectsDir);
    const claimed = new Set();

    for (const { root, name, exists } of locations.sessionRoots) {
      const status = { label: DESKTOP_LABELS[name], path: root, found: exists, count: 0, errors: 0, local: true };
      const fields = new Set();
      sources.push(status);
      if (!exists) continue;
      for (const file of await findRecordFiles(root)) {
        try {
          liveFiles.add(file);
          const record = await this.cached(file, readRecord);
          record.keys.forEach((key) => fields.add(key));
          let transcriptFile = null;
          let kind;
          if (record.cliSessionId && projectTranscripts.has(record.cliSessionId)) {
            transcriptFile = projectTranscripts.get(record.cliSessionId);
            claimed.add(record.cliSessionId);
            kind = 'code';
          } else {
            transcriptFile = await findTranscriptInSessionDir(record.sessionDir, record.cliSessionId);
            const cowork = transcriptFile || record.looksLikeCowork || name === 'local-agent-mode-sessions';
            kind = cowork ? 'cowork' : 'code';
          }
          let summary = null;
          if (transcriptFile) {
            liveFiles.add(transcriptFile);
            summary = await this.cached(transcriptFile, parseTranscript);
          }
          const item = sessionItem(kind, record, summary, transcriptFile && this.lastWrite(transcriptFile));
          items.set(item.id, item);
          status.count++;
        } catch (err) {
          status.errors++;
          status.lastError = err.message;
        }
      }
      status.fields = [...fields].sort();
    }

    // Sessions started from the terminal have a transcript but no Claude Desktop record.
    const terminal = {
      label: 'Claude Code – transcripts (~/.claude/projects)',
      path: locations.projectsDir,
      found: locations.projectsDirExists,
      count: 0,
      errors: 0,
      local: true,
      note: local ? undefined : 'Turned off in Testing',
    };
    sources.push(terminal);
    for (const [sessionId, file] of projectTranscripts) {
      if (claimed.has(sessionId)) continue;
      try {
        liveFiles.add(file);
        const summary = await this.cached(file, parseTranscript);
        if (!summary.questions.length) continue; // title-only or empty files
        const item = terminalItem(sessionId, summary, this.lastWrite(file));
        items.set(item.id, item);
        terminal.count++;
      } catch (err) {
        terminal.errors++;
        terminal.lastError = err.message;
      }
    }

    // Codex (ChatGPT's coding agent) sessions on this computer.
    const codexSessions = local ? path.join(codexHome(this.locateOptions), 'sessions') : null;
    const codex = {
      label: 'Codex – sessions (~/.codex/sessions)',
      path: codexSessions,
      found: false,
      count: 0,
      errors: 0,
      local: true,
      note: local ? undefined : 'Turned off in Testing',
    };
    sources.push(codex);
    if (codexSessions) {
      try {
        codex.found = (await fsp.stat(codexSessions)).isDirectory();
      } catch {
        codex.found = false;
      }
    }
    if (codex.found) {
      for (const file of await findRolloutFiles(codexSessions)) {
        try {
          liveFiles.add(file);
          const summary = await this.cached(file, parseRollout);
          if (!summary.questions.length || !summary.sessionId) continue;
          const item = codexItem(summary, this.lastWrite(file));
          items.set(item.id, item);
          codex.count++;
        } catch (err) {
          codex.errors++;
          codex.lastError = err.message;
        }
      }
    }

    const chatCounts = {};
    for (const chat of importedChats) chatCounts[chat.platform || 'claude'] = (chatCounts[chat.platform || 'claude'] || 0) + 1;
    for (const [platformId, label] of [['claude', 'Claude chats – export and browser'], ['chatgpt', 'ChatGPT chats – export and browser']]) {
      sources.push({ label, path: null, found: Boolean(chatCounts[platformId]), count: chatCounts[platformId] || 0, errors: 0 });
    }
    for (const chat of importedChats) items.set(chat.id, chatItem(chat));

    for (const file of this.cache.keys()) if (!liveFiles.has(file)) this.cache.delete(file);

    return { items: [...items.values()], sources, locations };
  }
}

function detail(questions, firstMessage, lastMessage) {
  return {
    questions,
    firstMessage: firstMessage || questions[0] || null,
    lastMessage: lastMessage || questions[questions.length - 1] || null,
  };
}

function activity(summary, lastWriteAt) {
  if (!summary) return null;
  return {
    pending: summary.pending,
    finishedAt: summary.finishedAt,
    lastWriteAt: lastWriteAt || summary.updatedAt,
    asking: summary.asking,
    asks: summary.asks,
  };
}

function sessionItem(kind, record, summary, lastWriteAt) {
  const questions = summary && summary.questions.length
    ? summary.questions
    : record.initialMessage
      ? [{ role: 'user', text: truncate(record.initialMessage), at: record.createdAt }]
      : [];
  const title = (summary && summary.customTitle)
    || record.title
    || transcriptTitle(summary)
    || truncate(record.initialMessage, 80)
    || 'Untitled session';
  const updatedAt = Math.max(record.updatedAt || 0, (summary && summary.updatedAt) || 0) || null;
  return {
    id: `${kind}:${record.sessionId}`,
    platform: 'claude',
    source: kind,
    title,
    createdAt: record.createdAt || (summary && summary.createdAt) || null,
    updatedAt,
    archived: record.archived,
    folder: kind === 'code' ? record.cwd || (summary && summary.cwd) : record.sessionDir || record.cwd,
    resumeId: kind === 'code' ? record.cliSessionId || (summary && summary.sessionId) : null,
    resumeCommand: kind === 'code' && (record.cliSessionId || (summary && summary.sessionId)) ? `claude --resume ${record.cliSessionId || summary.sessionId}` : null,
    url: null,
    activity: activity(summary, lastWriteAt),
    claudeUnread: record.unread,
    claudeReadAt: record.readAt,
    ...detail(questions, summary && summary.firstMessage, summary && summary.lastMessage),
  };
}

function terminalItem(sessionId, summary, lastWriteAt) {
  return {
    id: `code:${sessionId}`,
    platform: 'claude',
    source: 'code',
    title: transcriptTitle(summary) || 'Untitled session',
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    archived: false,
    folder: summary.cwd,
    resumeId: sessionId,
    resumeCommand: `claude --resume ${sessionId}`,
    url: null,
    activity: activity(summary, lastWriteAt),
    claudeUnread: null,
    claudeReadAt: null,
    ...detail(summary.questions, summary.firstMessage, summary.lastMessage),
  };
}

function codexItem(summary, lastWriteAt) {
  return {
    id: `chatgpt:codex:${summary.sessionId}`,
    platform: 'chatgpt',
    source: 'codex',
    title: summary.title || 'Untitled Codex session',
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    archived: false,
    folder: summary.cwd,
    resumeId: summary.sessionId,
    resumeCommand: `codex resume ${summary.sessionId}`,
    url: null,
    activity: activity(summary, lastWriteAt),
    claudeUnread: null,
    claudeReadAt: null,
    ...detail(summary.questions, summary.firstMessage, summary.lastMessage),
  };
}

function chatItem(chat) {
  const platform = chat.platform || 'claude';
  return {
    id: chat.id,
    platform,
    source: 'chat',
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    archived: chat.archived === true,
    folder: null,
    resumeId: null,
    resumeCommand: null,
    url: chatUrl(platform, chat.uuid),
    activity: chat.activity || null, // live only when the browser extension saw it
    claudeUnread: typeof chat.claudeUnread === 'boolean' ? chat.claudeUnread : null,
    claudeReadAt: chat.claudeReadAt || null,
    ...detail(chat.questions, chat.firstMessage, chat.lastMessage),
  };
}

module.exports = { Scanner };
