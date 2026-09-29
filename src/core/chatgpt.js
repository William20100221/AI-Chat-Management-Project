'use strict';

// ChatGPT chats, from its data export (conversations.json) or from what chatgpt.com loads.
// A conversation stores its messages as a tree: "mapping" is id → { message, parent, children },
// because editing or regenerating starts a new branch. "current_node" is the end of the branch
// you see, so walking parents from there gives the visible conversation.

const { truncate, snippet, toMillis } = require('./text');
const { chatItemId } = require('./platforms');

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function conversationId(value) {
  const id = value.conversation_id || value.id;
  return typeof id === 'string' && ID.test(id) ? id.toLowerCase() : null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isConversation(value) {
  return isPlainObject(value) && isPlainObject(value.mapping) && Boolean(conversationId(value));
}

// An entry of chatgpt.com's chat list: id, title and dates, no messages.
function isMeta(value) {
  return isPlainObject(value)
    && !value.uuid
    && !value.mapping
    && Boolean(conversationId(value))
    && typeof value.title === 'string'
    && Boolean(value.create_time || value.update_time);
}

function partsText(content) {
  if (!content) return '';
  if (typeof content.text === 'string') return content.text;
  if (!Array.isArray(content.parts)) return '';
  return content.parts
    .map((part) => (typeof part === 'string' ? part : part && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

// The visible branch, oldest message first.
function visibleMessages(conversation) {
  const { mapping } = conversation;
  let nodeId = conversation.current_node;
  if (!nodeId || !mapping[nodeId]) {
    let newest = null;
    for (const [id, node] of Object.entries(mapping)) {
      const at = (node && node.message && node.message.create_time) || 0;
      if (!newest || at > newest.at) newest = { id, at };
    }
    nodeId = newest && newest.id;
  }
  const chain = [];
  const visited = new Set();
  while (nodeId && mapping[nodeId] && !visited.has(nodeId)) {
    visited.add(nodeId);
    chain.push(mapping[nodeId]);
    nodeId = mapping[nodeId].parent;
  }
  return chain.reverse().map((node) => node.message).filter(Boolean);
}

function parseConversation(conversation) {
  const id = conversationId(conversation);
  if (!id) return null;
  const messages = isConversation(conversation)
    ? visibleMessages(conversation)
      .filter((m) => m.author && (m.author.role === 'user' || m.author.role === 'assistant'))
      .filter((m) => !(m.metadata && m.metadata.is_visually_hidden_from_conversation))
      .map((m) => ({
        role: m.author.role === 'user' ? 'user' : 'assistant',
        text: snippet(partsText(m.content)),
        at: toMillis(m.create_time),
      }))
      .filter((m) => m.text)
    : [];
  const title = typeof conversation.title === 'string' ? conversation.title.trim() : '';
  if (!messages.length && !title) return null;

  const questions = messages.filter((m) => m.role === 'user');
  const lastMessageAt = messages.reduce((max, m) => Math.max(max, m.at || 0), 0);
  return {
    id: chatItemId('chatgpt', id),
    uuid: id,
    platform: 'chatgpt',
    title: title || truncate(questions[0] && questions[0].text, 80) || 'Untitled chat',
    createdAt: toMillis(conversation.create_time),
    updatedAt: Math.max(toMillis(conversation.update_time) || 0, lastMessageAt) || null,
    questions,
    firstMessage: messages[0] || null,
    lastMessage: messages[messages.length - 1] || null,
    archived: conversation.is_archived === true,
    claudeUnread: null,
    claudeReadAt: null,
    fieldNames: Object.keys(conversation),
  };
}

module.exports = { isConversation, isMeta, parseConversation, partsText };
