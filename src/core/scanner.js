'use strict';

// Collects everything into one list: Claude chats, Cowork tasks and Code sessions, ChatGPT chats,
// and the ChatGPT app's Work and Codex chats. Each item says which platform it's from and what type it is.
// Files are only re-read when they change (same size and modified time → cached result).

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { locateSources } = require('./paths');
const { findRecordFiles, readRecord, findTranscriptInSessionDir } = require('./desktopSessions');
const { parseTranscript, transcriptTitle } = require('./transcript');
const { codexHome, findRolloutFiles, parseRollout, readSessionIndex, isBackgroundThread, threadKind } = require('./codex');
const { findChatGPTApps, findStateDb, readThreads } = require('./chatgptApp');
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
    this.threadsCache = null; // the ChatGPT app's chat list: { file, stamp, readAt, threads, error }
  }

  // The ChatGPT app's chat list (state_5.sqlite). It's copied before reading, so it's re-read only
  // when it changed, and at most every 20 seconds while the app is busy writing to it.
  async appThreads(home) {
    const found = await findStateDb(home, this.locateOptions);
    if (!found) {
      this.threadsCache = null;
      return { file: null, threads: [], error: null };
    }
    const hit = this.threadsCache;
    const fresh = hit && hit.file === found.file && (hit.stamp === found.stamp || Date.now() - hit.readAt < 20000);
    if (!fresh) {
      try {
        const threads = await readThreads(found.file, this.locateOptions);
        this.threadsCache = { file: found.file, stamp: found.stamp, readAt: Date.now(), threads, error: null };
      } catch (err) {
        // Keep the last good list; try again next time.
        this.threadsCache = { file: found.file, stamp: null, readAt: Date.now(), threads: hit && hit.file === found.file ? hit.threads : [], error: err.message };
      }
    }
    return this.threadsCache;
  }

  async scanCodex(local, items, liveFiles) {
    const home = codexHome(this.locateOptions);
    const apps = local ? findChatGPTApps(this.locateOptions) : [];
    const app = apps.find((a) => a.kind === 'current') || null;
    const classic = apps.find((a) => a.kind === 'classic') || null;
    const off = local ? undefined : 'Turned off in Testing';

    const appSource = {
      label: 'ChatGPT app – Work and Codex chats',
      path: app ? app.path : null,
      found: Boolean(app),
      count: 0,
      errors: 0,
      local: true,
      app: 'ChatGPT app',
      note: off || (app
        ? 'Its Chat-mode chats are kept on OpenAI’s servers, not on this computer; they come from chatgpt.com (browser extension) or your ChatGPT export.'
        : 'The ChatGPT desktop app (the one with Chat, Work and Codex) isn’t installed.'),
    };
    const filesSource = {
      label: 'Codex – sessions (~/.codex/sessions)',
      path: local ? path.join(home, 'sessions') : null,
      found: false,
      count: 0,
      errors: 0,
      local: true,
      app: 'Codex',
      note: off,
    };
    const sources = [appSource, filesSource];
    if (classic) {
      sources.push({
        label: 'ChatGPT Classic app',
        path: classic.path,
        found: true,
        count: 0,
        errors: 0,
        local: true,
        note: 'Found. ChatGPT Classic keeps no chat files that can be read (they stay on OpenAI’s servers; on a Mac its cache is encrypted), so its chats come from chatgpt.com or your ChatGPT export.',
      });
    }
    if (!local) return sources;

    // The app's own list: titles, names, archived. Missing when only the Codex CLI is used.
    const list = await this.appThreads(home);
    // The Codex CLI writes the same list, so without the app its chats count as Codex sessions.
    const listSource = app ? appSource : filesSource;
    if (list.error) {
      listSource.errors++;
      listSource.lastError = `Couldn’t read the chat list ${list.file} (${list.error})`;
    }
    if (list.file && app && local) appSource.note = `Reads its chat list (${list.file}) and ~/.codex/sessions. ${appSource.note}`;
    const threads = new Map(list.threads.map((t) => [t.id, t]));
    const names = await readSessionIndex(path.join(home, 'session_index.jsonl'));

    // Every session file, including archived ones.
    const files = [];
    for (const folder of ['sessions', 'archived_sessions']) {
      const dir = path.join(home, folder);
      if (!isDirSync(dir)) continue;
      if (folder === 'sessions') filesSource.found = true;
      files.push(...(await findRolloutFiles(dir)).map((file) => ({ file, archived: folder === 'archived_sessions' })));
    }
    const seen = new Set();
    for (const { file, archived } of files) {
      try {
        liveFiles.add(file);
        const summary = await this.cached(file, parseRollout);
        if (!summary.sessionId) continue;
        const id = summary.sessionId.toLowerCase();
        const thread = threads.get(id) || null;
        if (summary.background || (thread && isBackgroundThread(thread))) continue;
        if (!summary.questions.length && !(thread && (thread.preview || thread.firstUserMessage))) continue;
        seen.add(id);
        const item = codexItem(summary, thread, names.get(id), { archived, app, lastWriteAt: this.lastWrite(file) });
        items.set(item.id, item);
        if (thread) listSource.count++;
        else filesSource.count++;
      } catch (err) {
        filesSource.errors++;
        filesSource.lastError = err.message;
      }
    }

    // Chats in the app's list whose session file wasn't found: show what the list knows.
    for (const thread of threads.values()) {
      if (seen.has(thread.id) || isBackgroundThread(thread) || !(thread.preview || thread.firstUserMessage)) continue;
      const item = codexItem(null, thread, names.get(thread.id), { archived: false, app, lastWriteAt: null });
      items.set(item.id, item);
      listSource.count++;
    }
    return sources;
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
      const status = { label: DESKTOP_LABELS[name], path: root, found: exists, count: 0, errors: 0, local: true, app: 'Claude Desktop' };
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
      app: 'Claude Code',
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

    // The ChatGPT desktop app (Work and Codex chats) and the Codex CLI share ~/.codex.
    for (const source of await this.scanCodex(local, items, liveFiles)) sources.push(source);

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

// A Work or Codex chat. summary: the session file (may be null); thread: the ChatGPT app's list
// entry (may be null); name: a name you gave it.
function codexItem(summary, thread, name, { archived, app, lastWriteAt }) {
  const id = ((summary && summary.sessionId) || thread.id).toLowerCase();
  const kind = thread && thread.originator ? threadKind(thread.originator) : summary ? summary.kind : 'codex';
  const firstAsk = thread && (thread.firstUserMessage || thread.preview);
  const questions = summary && summary.questions.length
    ? summary.questions
    : firstAsk ? [{ role: 'user', text: truncate(firstAsk), at: thread.createdAt }] : [];
  // The app's title is worth showing only when it isn't just your first message again.
  const appTitle = thread && thread.title && thread.title !== thread.firstUserMessage ? thread.title : null;
  const title = (thread && thread.name) || name || appTitle || (summary && summary.title) || truncate(firstAsk, 80)
    || (kind === 'work' ? 'Untitled Work chat' : 'Untitled Codex session');
  const updatedAt = Math.max((summary && summary.updatedAt) || 0, (thread && thread.updatedAt) || 0) || null;
  return {
    id: `chatgpt:codex:${id}`, // Work chats keep this id too, so pins survive the app changing modes
    platform: 'chatgpt',
    source: kind,
    title,
    createdAt: (summary && summary.createdAt) || (thread && thread.createdAt) || null,
    updatedAt,
    archived: Boolean(archived || (thread && thread.archived)),
    folder: (summary && summary.cwd) || (thread && thread.cwd) || null,
    resumeId: id,
    resumeCommand: `codex resume ${id}`,
    // codex://threads/<id> opens the chat in the ChatGPT app.
    url: app ? `codex://threads/${id}` : null,
    activity: activity(summary, lastWriteAt),
    claudeUnread: null,
    claudeReadAt: null,
    ...detail(questions, summary && summary.firstMessage, summary && summary.lastMessage),
  };
}

function isDirSync(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
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
