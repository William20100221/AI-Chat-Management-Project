'use strict';

// Chats seen live in your claude.ai browser tab (via the browser extension).
// The extension sends three kinds of updates:
//   data            – a chat list or a chat the page loaded (titles, dates, messages)
//   reply-started / reply-finished – Claude began / finished writing a reply
//   viewing         – you had that chat open in a visible, focused tab
// These are merged with chats from your data export: live data wins where it's newer.

const { parseClaudeConversations } = require('./chatExport');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNTITLED = 'Untitled chat';
const EVENT_TYPES = new Set(['data', 'reply-started', 'reply-finished', 'viewing']);

function emptyWebState() {
  return { chats: {}, lastEventAt: null };
}

function isValid(event) {
  if (!event || typeof event !== 'object' || !EVENT_TYPES.has(event.type)) return false;
  if (event.type === 'data') return event.body !== undefined;
  return typeof event.uuid === 'string' && UUID.test(event.uuid);
}

function blankChat(uuid) {
  return {
    id: `chat:${uuid}`,
    uuid,
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
  const existing = state.chats[chat.uuid] || blankChat(chat.uuid);
  const hasMessages = chat.questions.length > 0 || Boolean(chat.firstMessage);
  state.chats[chat.uuid] = {
    ...existing,
    title: chat.title && chat.title !== UNTITLED ? chat.title : existing.title,
    createdAt: chat.createdAt || existing.createdAt,
    updatedAt: Math.max(chat.updatedAt || 0, existing.updatedAt || 0) || null,
    questions: hasMessages ? chat.questions : existing.questions,
    firstMessage: hasMessages ? chat.firstMessage : existing.firstMessage,
    lastMessage: hasMessages ? chat.lastMessage : existing.lastMessage,
  };
}

function markReply(state, event, at) {
  const chat = state.chats[event.uuid] || blankChat(event.uuid);
  const previous = chat.activity || { pending: false, finishedAt: null, lastWriteAt: null };
  chat.activity = event.type === 'reply-started'
    ? { pending: true, finishedAt: previous.finishedAt, lastWriteAt: at }
    : { pending: false, finishedAt: at, lastWriteAt: at };
  chat.updatedAt = Math.max(chat.updatedAt || 0, at);
  state.chats[event.uuid] = chat;
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
        chats = parseClaudeConversations(event.body);
      } catch {
        chats = [];
      }
      for (const chat of chats) if (UUID.test(chat.uuid)) mergeLoaded(state, chat);
    } else if (event.type === 'viewing') {
      seen.push({ id: `chat:${event.uuid.toLowerCase()}`, at });
    } else {
      markReply(state, { ...event, uuid: event.uuid.toLowerCase() }, at);
    }
  }
  if (valid.length) state.lastEventAt = now;
  return { seen, applied: valid.length };
}

// One list of normal chats: the export for history, the browser for anything newer.
function combineChats(exportChats, state) {
  const byId = new Map(exportChats.map((chat) => [chat.id, { ...chat, activity: null }]));
  for (const web of Object.values(state.chats)) {
    const base = byId.get(web.id);
    if (!base) {
      byId.set(web.id, web);
      continue;
    }
    const webHasMessages = web.questions.length > 0 || Boolean(web.firstMessage);
    byId.set(web.id, {
      ...base,
      title: web.title && web.title !== 'New chat' && web.title !== UNTITLED ? web.title : base.title,
      createdAt: base.createdAt || web.createdAt,
      updatedAt: Math.max(base.updatedAt || 0, web.updatedAt || 0) || null,
      questions: webHasMessages ? web.questions : base.questions,
      firstMessage: webHasMessages ? web.firstMessage : base.firstMessage,
      lastMessage: webHasMessages ? web.lastMessage : base.lastMessage,
      activity: web.activity,
    });
  }
  return [...byId.values()];
}

module.exports = { emptyWebState, applyWebEvents, combineChats };
