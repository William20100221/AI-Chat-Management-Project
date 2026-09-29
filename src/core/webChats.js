'use strict';

// Chats seen live in your browser (claude.ai, chatgpt.com) through the browser extension.
// The extension sends these updates, each tagged with its platform:
//   data            – a chat list or a chat the page loaded (titles, dates, messages)
//   reply-started   – you sent a message and the AI began replying (with your message)
//   reply-finished  – the AI finished (with the start and end of the reply)
//   viewing         – you had that chat open in a visible, focused tab
//   sidebar         – which chats the sidebar marks as unread (Claude's blue dot), when it can tell
// These are merged with chats from your data exports: live data wins where it's newer.
// Chats are stored by item id, e.g. "chat:<uuid>" (Claude) or "chatgpt:chat:<id>".

const { parseConversations } = require('./chatExport');
const { chatItemId, platform: platformInfo } = require('./platforms');
const { snippet } = require('./text');
const { endsWithQuestion } = require('./transcript');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEHOLDER_TITLES = new Set(['Untitled chat', 'New chat']);
const EVENT_TYPES = new Set(['data', 'reply-started', 'reply-finished', 'viewing', 'sidebar']);
const MAX_FIELDS = 80;

function emptyWebState() {
  // fields / sidebarSample are only for the Testing panel: what the websites' data looks like.
  return { chats: {}, lastEventAt: null, fields: {}, sidebarSample: null };
}

// Older versions stored Claude chats by bare uuid and fields as one list; bring them up to date.
function normalizeWebState(state) {
  const fresh = { ...emptyWebState(), ...(state || {}) };
  const chats = {};
  for (const [key, chat] of Object.entries(fresh.chats || {})) {
    if (!chat || typeof chat !== 'object') continue;
    const platform = chat.platform || 'claude';
    const id = chat.id || chatItemId(platform, key);
    chats[id] = { ...chat, id, platform };
  }
  fresh.chats = chats;
  if (Array.isArray(fresh.fields)) fresh.fields = { claude: fresh.fields };
  return fresh;
}

const uuidList = (value) => Array.isArray(value) && value.length <= 1000 && value.every((u) => typeof u === 'string' && UUID.test(u));

function platformOf(event) {
  return platformInfo(event.platform) ? event.platform : 'claude'; // extension 0.5 and older only knew Claude
}

function isValid(event) {
  if (!event || typeof event !== 'object' || !EVENT_TYPES.has(event.type)) return false;
  if (event.type === 'data') return event.body !== undefined;
  if (event.type === 'sidebar') return uuidList(event.visible) && uuidList(event.unread);
  return typeof event.uuid === 'string' && UUID.test(event.uuid);
}

function blankChat(platform, uuid) {
  return {
    id: chatItemId(platform, uuid),
    uuid,
    platform,
    title: 'New chat',
    createdAt: null,
    updatedAt: null,
    questions: [],
    firstMessage: null,
    lastMessage: null,
    activity: null,
  };
}

function mergeLoaded(state, chat) {
  const existing = state.chats[chat.id] || blankChat(chat.platform, chat.uuid);
  const hasMessages = chat.questions.length > 0 || Boolean(chat.firstMessage);
  state.chats[chat.id] = {
    ...existing,
    title: chat.title && !PLACEHOLDER_TITLES.has(chat.title) ? chat.title : existing.title,
    createdAt: chat.createdAt || existing.createdAt,
    updatedAt: Math.max(chat.updatedAt || 0, existing.updatedAt || 0) || null,
    questions: hasMessages ? chat.questions : existing.questions,
    firstMessage: hasMessages ? chat.firstMessage : existing.firstMessage,
    lastMessage: hasMessages ? chat.lastMessage : existing.lastMessage,
    archived: chat.archived === true,
    claudeUnread: typeof chat.claudeUnread === 'boolean' ? chat.claudeUnread : existing.claudeUnread ?? null,
    claudeReadAt: chat.claudeReadAt || existing.claudeReadAt || null,
  };
  if (chat.fieldNames) {
    const known = new Set([...(state.fields[chat.platform] || []), ...chat.fieldNames]);
    state.fields[chat.platform] = [...known].sort().slice(0, MAX_FIELDS);
  }
}

function markReply(state, event, at) {
  const platform = platformOf(event);
  const uuid = event.uuid.toLowerCase();
  const id = chatItemId(platform, uuid);
  const chat = state.chats[id] || blankChat(platform, uuid);
  const previous = chat.activity || { pending: false, finishedAt: null, lastWriteAt: null };
  if (event.type === 'reply-started') {
    chat.activity = { pending: true, finishedAt: previous.finishedAt, lastWriteAt: at, asks: false };
    if (typeof event.prompt === 'string' && event.prompt.trim()) {
      const message = { role: 'user', text: snippet(event.prompt), at };
      const last = chat.questions[chat.questions.length - 1];
      if (!last || last.text !== message.text) chat.questions = [...chat.questions, message];
      if (!chat.firstMessage) chat.firstMessage = message;
      chat.lastMessage = message;
    }
  } else {
    const head = typeof event.text === 'string' ? event.text : '';
    const tail = typeof event.tail === 'string' ? event.tail : head;
    chat.activity = { pending: false, finishedAt: at, lastWriteAt: at, asks: endsWithQuestion(tail) };
    if (head.trim()) chat.lastMessage = { role: 'assistant', text: snippet(head), at };
    chat.claudeUnread = null; // an older "read" flag no longer applies to this new reply
  }
  chat.updatedAt = Math.max(chat.updatedAt || 0, at);
  state.chats[id] = chat;
}

// The sidebar can only prove a chat IS unread; a missing dot may just mean we can't see it.
function markSidebar(state, event) {
  const platform = platformOf(event);
  const unread = new Set(event.unread.map((u) => u.toLowerCase()));
  for (const uuid of event.visible.map((u) => u.toLowerCase())) {
    const chat = state.chats[chatItemId(platform, uuid)];
    if (!chat) continue;
    if (unread.has(uuid)) {
      chat.claudeUnread = true;
      chat.unreadFromSidebar = true;
    } else if (chat.unreadFromSidebar) {
      chat.claudeUnread = null; // the dot went away: you read it
      chat.unreadFromSidebar = false;
      chat.claudeReadAt = Date.now();
    }
  }
  if (typeof event.sample === 'string') {
    state.sidebarSample = { ...(state.sidebarSample && typeof state.sidebarSample === 'object' ? state.sidebarSample : {}), [platform]: event.sample.slice(0, 2000) };
  }
}

// Applies updates in time order. Returns the chats you looked at: [{ id, at }].
function applyWebEvents(state, events, now = Date.now()) {
  const seen = [];
  const valid = events.filter(isValid).sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
  for (const event of valid) {
    const at = Math.min(Number(event.at) || now, now); // never trust a time in the future
    if (event.type === 'data') {
      let chats = [];
      try {
        chats = parseConversations(event.body);
      } catch {
        chats = [];
      }
      for (const chat of chats) if (UUID.test(chat.uuid) && chat.platform === platformOf(event)) mergeLoaded(state, chat);
    } else if (event.type === 'viewing') {
      seen.push({ id: chatItemId(platformOf(event), event.uuid.toLowerCase()), at });
    } else if (event.type === 'sidebar') {
      markSidebar(state, event);
    } else {
      markReply(state, event, at);
    }
  }
  if (valid.length) state.lastEventAt = now;
  return { seen, applied: valid.length };
}

// One list of chats: exports for history, the browser for anything newer.
function combineChats(exportChats, state) {
  const byId = new Map(exportChats.map((chat) => [chat.id, { ...chat, platform: chat.platform || 'claude', activity: null }]));
  for (const web of Object.values(state.chats)) {
    const base = byId.get(web.id);
    if (!base) {
      byId.set(web.id, web);
      continue;
    }
    const webHasMessages = web.questions.length > 0 || Boolean(web.firstMessage);
    byId.set(web.id, {
      ...base,
      title: web.title && !PLACEHOLDER_TITLES.has(web.title) ? web.title : base.title,
      createdAt: base.createdAt || web.createdAt,
      updatedAt: Math.max(base.updatedAt || 0, web.updatedAt || 0) || null,
      questions: webHasMessages ? web.questions : base.questions,
      firstMessage: webHasMessages ? web.firstMessage : base.firstMessage,
      lastMessage: webHasMessages ? web.lastMessage : base.lastMessage,
      archived: web.archived === true || base.archived === true,
      activity: web.activity,
      claudeUnread: web.claudeUnread ?? base.claudeUnread ?? null,
      claudeReadAt: web.claudeReadAt || base.claudeReadAt || null,
    });
  }
  return [...byId.values()];
}

module.exports = { emptyWebState, normalizeWebState, applyWebEvents, combineChats };
