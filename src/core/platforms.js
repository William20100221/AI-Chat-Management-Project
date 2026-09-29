'use strict';

// The AI platforms the app knows about. Adding a platform starts here: its name, the kinds of
// items it has, its website, and what its chat pages look like.
//
// extension: how the browser extension reads the site: 'full' (the site's own data: messages,
//   dates, replying) or 'page' (what the open page shows; see extension/relay.js).
// history: how to spot the platform's chats in your browser history.
//   prefixes  where its pages start (only these history entries are ever read)
//   chat      a chat page's address; the first group is the chat's id
//   clean     removes the site's name from a page title ("My chat - Claude" → "My chat")
//   generic   page titles that say nothing about the chat ("Google Gemini"), so they're not used
// The chat-page addresses are the ones each site uses today; sites do change them. Settings →
// Testing lists AI-site addresses that didn't match, so a pattern can be fixed.

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const siteName = (...names) => new RegExp(`^\\s*(?:${names.join('|')})\\s*[-–—|:]\\s*|\\s*[-–—|:]\\s*(?:${names.join('|')})\\s*$`, 'gi');

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
    chatId: new RegExp(`^${UUID}$`, 'i'),
    chatUrl: (id) => `https://claude.ai/chat/${id}`,
    history: {
      prefixes: ['https://claude.ai/'],
      chat: new RegExp(`^https://claude\\.ai/chat/(${UUID})`, 'i'),
      clean: siteName('Claude'),
      generic: /^(claude|new chat|untitled)$/i,
    },
    extension: 'full',
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
    chatId: new RegExp(`^${UUID}$`, 'i'),
    chatUrl: (id) => `https://chatgpt.com/c/${id}`,
    history: {
      prefixes: ['https://chatgpt.com/', 'https://chat.openai.com/'],
      // /c/<id>, or inside a GPT or project: /g/<gpt>/c/<id>
      chat: new RegExp(`^https://(?:chatgpt\\.com|chat\\.openai\\.com)/(?:g/[^/?#]+/)?c/(${UUID})`, 'i'),
      clean: siteName('ChatGPT'),
      generic: /^(chatgpt|new chat|untitled)$/i,
    },
    extension: 'full',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    website: 'https://gemini.google.com/app',
    websiteName: 'gemini.google.com',
    types: [
      { id: 'chat', name: 'Chat' },
      { id: 'cli', name: 'CLI' },
    ],
    chatId: /^[0-9a-f]{8,32}$/i,
    chatUrl: (id) => `https://gemini.google.com/app/${id}`,
    history: {
      prefixes: ['https://gemini.google.com/'],
      // /app/<id>, /u/1/app/<id> (another Google account), /gem/<gem>/<id>
      chat: /^https:\/\/gemini\.google\.com\/(?:u\/\d+\/)?(?:app|gem\/[^/?#]+)\/([0-9a-f]{8,32})(?:[/?#]|$)/i,
      clean: siteName('Google Gemini', 'Gemini'),
      generic: /^(google gemini|gemini|new chat)$/i, // Gemini's tabs are all called "Google Gemini"
    },
  },
  {
    id: 'copilot',
    name: 'Microsoft Copilot',
    website: 'https://copilot.microsoft.com/',
    websiteName: 'copilot.microsoft.com',
    types: [{ id: 'chat', name: 'Chat' }],
    chatId: /^[A-Za-z0-9_-]{6,64}$/,
    chatUrl: (id) => `https://copilot.microsoft.com/chats/${id}`,
    history: {
      prefixes: ['https://copilot.microsoft.com/'],
      chat: /^https:\/\/copilot\.microsoft\.com\/chats\/([A-Za-z0-9_-]{6,64})(?:[/?#]|$)/,
      clean: siteName('Microsoft Copilot', 'Copilot'),
      generic: /^(microsoft copilot.*|copilot|new chat)$/i,
    },
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    website: 'https://www.perplexity.ai/library',
    websiteName: 'perplexity.ai',
    types: [{ id: 'chat', name: 'Thread' }],
    chatId: /^[A-Za-z0-9._~%-]{6,300}$/,
    chatUrl: (id) => `https://www.perplexity.ai/search/${id}`,
    history: {
      prefixes: ['https://www.perplexity.ai/', 'https://perplexity.ai/'],
      // /search/<your-question-as-words-plus-an-id>
      chat: /^https:\/\/(?:www\.)?perplexity\.ai\/search\/([A-Za-z0-9._~%-]{6,300})(?:[/?#]|$)/,
      clean: siteName('Perplexity'),
      generic: /^(perplexity.*|new thread)$/i,
    },
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    website: 'https://chat.deepseek.com/',
    websiteName: 'chat.deepseek.com',
    types: [{ id: 'chat', name: 'Chat' }],
    chatId: new RegExp(`^${UUID}$`, 'i'),
    chatUrl: (id) => `https://chat.deepseek.com/a/chat/s/${id}`,
    history: {
      prefixes: ['https://chat.deepseek.com/'],
      chat: new RegExp(`^https://chat\\.deepseek\\.com/a/chat/s/(${UUID})`, 'i'),
      clean: siteName('DeepSeek'),
      generic: /^(deepseek.*|into the unknown|new chat)$/i,
    },
  },
  {
    id: 'grok',
    name: 'Grok',
    website: 'https://grok.com/',
    websiteName: 'grok.com',
    types: [{ id: 'chat', name: 'Chat' }],
    chatId: /^[0-9a-f-]{36}$|^\d{6,30}$/i,
    chatUrl: (id) => (/^\d+$/.test(id) ? `https://x.com/i/grok?conversation=${id}` : `https://grok.com/c/${id}`),
    history: {
      prefixes: ['https://grok.com/', 'https://x.com/i/grok'],
      // grok.com/c/<id> (older: /chat/<id>), or Grok inside X: x.com/i/grok?conversation=<id>
      chat: new RegExp(`^https://(?:grok\\.com/(?:c|chat)/(${UUID})|x\\.com/i/grok\\?(?:[^#]*&)?conversation=(\\d{6,30}))`, 'i'),
      clean: siteName('Grok', 'X'),
      generic: /^(grok|grok \/ x|x|new chat)$/i,
    },
  },
  {
    id: 'mistral',
    name: 'Le Chat',
    website: 'https://chat.mistral.ai/chat',
    websiteName: 'chat.mistral.ai',
    types: [{ id: 'chat', name: 'Chat' }],
    chatId: new RegExp(`^${UUID}$`, 'i'),
    chatUrl: (id) => `https://chat.mistral.ai/chat/${id}`,
    history: {
      prefixes: ['https://chat.mistral.ai/'],
      chat: new RegExp(`^https://chat\\.mistral\\.ai/chat/(${UUID})`, 'i'),
      clean: siteName('Le Chat', 'Mistral AI', 'Mistral'),
      generic: /^(le chat|mistral ai|le chat - mistral ai|new chat)$/i,
    },
  },
  {
    id: 'poe',
    name: 'Poe',
    website: 'https://poe.com/chats',
    websiteName: 'poe.com',
    types: [{ id: 'chat', name: 'Chat' }],
    chatId: /^[A-Za-z0-9_-]{4,64}$/,
    chatUrl: (id) => `https://poe.com/chat/${id}`,
    history: {
      prefixes: ['https://poe.com/'],
      chat: /^https:\/\/poe\.com\/chat\/([A-Za-z0-9_-]{4,64})(?:[/?#]|$)/,
      clean: siteName('Poe'),
      generic: /^(poe|poe - fast.*|new chat)$/i,
    },
  },
];

const BY_ID = new Map(PLATFORMS.map((p) => [p.id, p]));

function platform(id) {
  return BY_ID.get(id) || null;
}

// Item ids. Claude chats keep their original "chat:<uuid>" form so saved pins and marks still match.
function chatItemId(platformId, chatId) {
  return platformId === 'claude' ? `chat:${chatId}` : `${platformId}:chat:${chatId}`;
}

function chatUrl(platformId, chatId) {
  const p = platform(platformId);
  return p && p.chatId.test(String(chatId)) ? p.chatUrl(chatId) : null;
}

// Which platform a visited address belongs to, and the chat's id if it's a chat page.
// → { platform, chatId } or { platform, chatId: null } for its other pages, or null.
function matchAddress(url) {
  if (typeof url !== 'string') return null;
  for (const p of PLATFORMS) {
    if (!p.history.prefixes.some((prefix) => url.toLowerCase().startsWith(prefix))) continue;
    const match = p.history.chat.exec(url);
    let chatId = match ? match.slice(1).find(Boolean) : null;
    // Ids that are hex (UUIDs, Gemini's) are the same chat in any letter case.
    if (chatId && p.chatId.flags.includes('i')) chatId = chatId.toLowerCase();
    return { platform: p.id, chatId: chatId || null };
  }
  return null;
}

// A page title without the site's name; null when it says nothing about the chat.
function cleanTitle(platformId, title) {
  const p = platform(platformId);
  if (!p || typeof title !== 'string') return null;
  let text = title.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 2; i++) text = text.replace(p.history.clean, '').trim(); // "ChatGPT - x - ChatGPT"
  if (!text || p.history.generic.test(text) || p.history.generic.test(title.trim())) return null;
  return text;
}

// What the window needs to draw chips and labels.
function describePlatforms() {
  return PLATFORMS.map(({ id, name, types, website, websiteName, extension }) => ({ id, name, types, website, websiteName, extension: extension || 'page' }));
}

module.exports = { PLATFORMS, platform, chatItemId, chatUrl, matchAddress, cleanTitle, describePlatforms };
