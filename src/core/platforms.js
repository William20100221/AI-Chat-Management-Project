'use strict';

// The AI platforms the app knows about. Adding a platform starts here: its name, the kinds of
// items it has, and how to open one of its chats. (Readers for its data live in their own files.)

const PLATFORMS = [
  {
    id: 'claude',
    name: 'Claude',
    website: 'https://claude.ai/recents',
    websiteName: 'claude.ai',
    types: [
      { id: 'chat', name: 'Chat' },
      { id: 'cowork', name: 'Cowork' },
      { id: 'code', name: 'Code' },
    ],
    chatUrl: (id) => `https://claude.ai/chat/${id}`,
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    website: 'https://chatgpt.com/',
    websiteName: 'chatgpt.com',
    // Chat: chatgpt.com and Chat mode in the app. Work and Codex: the ChatGPT app's other two modes
    // (and the Codex CLI), which run on this computer.
    types: [
      { id: 'chat', name: 'Chat' },
      { id: 'work', name: 'Work' },
      { id: 'codex', name: 'Codex' },
    ],
    chatUrl: (id) => `https://chatgpt.com/c/${id}`,
  },
];

const BY_ID = new Map(PLATFORMS.map((p) => [p.id, p]));
const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function platform(id) {
  return BY_ID.get(id) || null;
}

// Item ids. Claude chats keep their original "chat:<uuid>" form so saved pins and marks still match.
function chatItemId(platformId, chatId) {
  return platformId === 'claude' ? `chat:${chatId}` : `${platformId}:chat:${chatId}`;
}

function chatUrl(platformId, chatId) {
  const p = platform(platformId);
  return p && CHAT_ID.test(String(chatId)) ? p.chatUrl(chatId) : null;
}

// What the window needs to draw chips and labels.
function describePlatforms() {
  return PLATFORMS.map(({ id, name, types, websiteName }) => ({ id, name, types, websiteName }));
}

module.exports = { PLATFORMS, platform, chatItemId, chatUrl, describePlatforms };
