'use strict';

// Chats seen live in your browser through the browser extension, on any AI website it knows.
// The extension sends these updates, each tagged with its platform:
//   data            – a chat list or a chat the page loaded (Claude and ChatGPT: titles, dates, messages)
//   chat-list       – the chats linked in a site's sidebar: ids and titles (the other sites)
//   page            – the chat open in a tab: its title, your questions and the last reply shown
//   reply-started   – you sent a message and the AI began replying (with your message)
//   reply-finished  – the AI finished (with the start and end of the reply)
//   viewing         – you had that chat open in a visible, focused tab
//   sidebar         – which chats the sidebar marks as unread (Claude's blue dot), when it can tell
// These are merged with chats from your data exports: live data wins where it's newer.
// Chats are stored by item id, e.g. "chat:<uuid>" (Claude) or "chatgpt:chat:<id>".

const { parseConversations } = require('./chatExport');
const { chatItemId, cleanTitle, platform: platformInfo } = require('./platforms');
const { snippet } = require('./text');
const { endsWithQuestion } = require('./transcript');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEHOLDER_TITLES = new Set(['Untitled chat', 'New chat']);
const EVENT_TYPES = new Set(['data', 'chat-list', 'page', 'reply-started', 'reply-finished', 'viewing', 'sidebar']);
const MAX_FIELDS = 80;

function emptyWebState() {
  // fields / sidebarSample / probes are only for the Testing panel: what the websites look like.
  return { chats: {}, lastEventAt: null, fields: {}, sidebarSample: null, probes: {} };
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

function platformOf(event) {
  return platformInfo(event.platform) ? event.platform : 'claude'; // extension 0.5 and older only knew Claude
}

// Each platform's chat ids look different (UUIDs, Gemini's hex, Copilot's letters and digits).
const validId = (platform, id) => typeof id === 'string' && platformInfo(platform).chatId.test(id);
// Hex ids are the same chat in any letter case; others keep theirs.
const normId = (platform, id) => (platformInfo(platform).chatId.flags.includes('i') ? id.toLowerCase() : id);
const idList = (platform, value) => Array.isArray(value) && value.length <= 1000 && value.every((id) => validId(platform, id));
const optionalText = (value) => value === null || value === undefined || typeof value === 'string';

function isValid(event) {
  if (!event || typeof event !== 'object' || !EVENT_TYPES.has(event.type)) return false;
  const platform = platformOf(event);
  if (event.type === 'data') return event.body !== undefined;
  if (event.type === 'sidebar') return idList(platform, event.visible) && idList(platform, event.unread);
  if (event.type === 'chat-list') {
    return Array.isArray(event.chats) && event.chats.length <= 1000
      && event.chats.every((c) => c && validId(platform, c.uuid) && optionalText(c.title));
  }
  if (!validId(platform, event.uuid)) return false;
  if (event.type === 'page') {
    return optionalText(event.title) && optionalText(event.reply)
      && (event.questions === undefined || (Array.isArray(event.questions) && event.questions.length <= 500 && event.questions.every((q) => typeof q === 'string')));
  }
  return true;
}

function blankChat(platform, uuid) {
  return {
    id: chatItemId(platform, uuid),
    uuid,
    platform,
    title: null,
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
  const uuid = normId(platform, event.uuid);
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

// Your questions from the page, added to the ones already known (a long chat may show only its
// latest messages, so nothing known is dropped).
function mergeQuestions(known, onPage) {
  const texts = new Set(known.map((q) => q.text));
  const added = onPage.map((text) => snippet(text)).filter((text) => text && !texts.has(text)).map((text) => ({ role: 'user', text, at: null }));
  return added.length ? [...known, ...added] : known;
}

// The chat open in a tab (sites read from the page): its title, questions and the last reply.
function markPage(state, event, at) {
  const platform = platformOf(event);
  const uuid = normId(platform, event.uuid);
  const id = chatItemId(platform, uuid);
  const chat = state.chats[id] || blankChat(platform, uuid);
  const title = cleanTitle(platform, event.title);
  if (title) chat.title = title;
  if (Array.isArray(event.questions) && event.questions.length) {
    chat.questions = mergeQuestions(chat.questions, event.questions);
    if (!chat.firstMessage) chat.firstMessage = chat.questions[0];
  }
  if (event.reply && event.reply.trim()) chat.lastMessage = { role: 'assistant', text: snippet(event.reply), at };
  else if (!chat.lastMessage && chat.questions.length) chat.lastMessage = chat.questions[chat.questions.length - 1];
  chat.updatedAt = Math.max(chat.updatedAt || 0, at); // you had it open (or it changed): like "last opened"
  state.chats[id] = chat;
  if (event.probe && typeof event.probe === 'object') {
    const probe = {};
    for (const key of ['userMessages', 'aiReplies', 'composer', 'sidebarLinks']) if (key in event.probe) probe[key] = event.probe[key];
    state.probes = { ...(state.probes || {}), [platform]: { ...probe, at } };
  }
}

// The chats linked in a site's sidebar: new ones are added (no dates yet), titles updated.
function markList(state, event) {
  const platform = platformOf(event);
  for (const entry of event.chats) {
    const uuid = normId(platform, entry.uuid);
    const id = chatItemId(platform, uuid);
    const chat = state.chats[id] || blankChat(platform, uuid);
    const title = cleanTitle(platform, entry.title);
    if (title) chat.title = title;
    state.chats[id] = chat;
  }
  keepSample(state, platform, event.sample);
}

function keepSample(state, platform, sample) {
  if (typeof sample !== 'string') return;
  state.sidebarSample = { ...(state.sidebarSample && typeof state.sidebarSample === 'object' ? state.sidebarSample : {}), [platform]: sample.slice(0, 2000) };
}

// The sidebar can only prove a chat IS unread; a missing dot may just mean we can't see it.
function markSidebar(state, event) {
  const platform = platformOf(event);
  const unread = new Set(event.unread.map((u) => normId(platform, u)));
  for (const uuid of event.visible.map((u) => normId(platform, u))) {
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
  keepSample(state, platform, event.sample);
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
      seen.push({ id: chatItemId(platformOf(event), normId(platformOf(event), event.uuid)), at });
    } else if (event.type === 'sidebar') {
      markSidebar(state, event);
    } else if (event.type === 'chat-list') {
      markList(state, event);
    } else if (event.type === 'page') {
      markPage(state, event, at);
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
