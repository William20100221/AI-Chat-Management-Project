// The AI websites the extension works on, and how to read each one.
// Loaded before relay.js on those sites, and by the app's tests (which check that the chat-page
// patterns here are exactly the app's, in src/core/platforms.js).
//
//   chat      a chat page's address; the first matching group is the chat's id
//   full      the site's own data is read too (page-hook.js): Claude and ChatGPT
//   user, ai  where your messages and the AI's replies are on the page (best guesses at each
//             site's markup, with general fallbacks; Settings → Testing in the app shows what was found)
//   composer  the box you type into
(function (root) {
  const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

  const SITES = [
    {
      platform: 'claude',
      hosts: /^claude\.ai$/,
      chat: new RegExp(`^https://claude\\.ai/chat/(${UUID})`, 'i'),
      full: true,
    },
    {
      platform: 'chatgpt',
      hosts: /^(chatgpt\.com|chat\.openai\.com)$/,
      chat: new RegExp(`^https://(?:chatgpt\\.com|chat\\.openai\\.com)/(?:g/[^/?#]+/)?c/(${UUID})`, 'i'),
      full: true,
    },
    {
      platform: 'gemini',
      hosts: /^gemini\.google\.com$/,
      chat: /^https:\/\/gemini\.google\.com\/(?:u\/\d+\/)?(?:app|gem\/[^/?#]+)\/([0-9a-f]{8,32})(?:[/?#]|$)/i,
      user: 'user-query, .user-query-bubble-with-background',
      ai: 'model-response, message-content',
      composer: 'rich-textarea [contenteditable="true"], .ql-editor[contenteditable="true"]',
    },
    {
      platform: 'copilot',
      hosts: /^copilot\.microsoft\.com$/,
      chat: /^https:\/\/copilot\.microsoft\.com\/chats\/([A-Za-z0-9_-]{6,64})(?:[/?#]|$)/,
      user: '[data-content="user-message"]',
      ai: '[data-content="ai-message"]',
      composer: 'textarea#userInput, textarea',
    },
    {
      platform: 'perplexity',
      hosts: /^(www\.)?perplexity\.ai$/,
      chat: /^https:\/\/(?:www\.)?perplexity\.ai\/search\/([A-Za-z0-9._~%-]{6,300})(?:[/?#]|$)/,
      user: '[class*="group/query"], h1',
      ai: '[id^="markdown-content"], .prose',
      composer: '#ask-input, textarea',
    },
    {
      platform: 'deepseek',
      hosts: /^chat\.deepseek\.com$/,
      chat: new RegExp(`^https://chat\\.deepseek\\.com/a/chat/s/(${UUID})`, 'i'),
      user: '[class*="user-message"], [class*="fbb737a4"]',
      ai: '.ds-markdown',
      composer: 'textarea#chat-input, textarea',
    },
    {
      platform: 'grok',
      hosts: /^(grok\.com|x\.com)$/,
      chat: new RegExp(`^https://(?:grok\\.com/(?:c|chat)/(${UUID})|x\\.com/i/grok\\?(?:[^#]*&)?conversation=(\\d{6,30}))`, 'i'),
      user: '[class*="items-end"] .message-bubble',
      ai: '[class*="items-start"] .message-bubble',
      composer: 'textarea, [contenteditable="true"]',
    },
    {
      platform: 'mistral',
      hosts: /^chat\.mistral\.ai$/,
      chat: new RegExp(`^https://chat\\.mistral\\.ai/chat/(${UUID})`, 'i'),
      composer: 'textarea, [contenteditable="true"]',
    },
    {
      platform: 'poe',
      hosts: /^poe\.com$/,
      chat: /^https:\/\/poe\.com\/chat\/([A-Za-z0-9_-]{4,64})(?:[/?#]|$)/,
      user: '[class*="Message_rightSideMessageBubble"], [class*="Message_humanMessageBubble"]',
      ai: '[class*="Message_leftSideMessageBubble"], [class*="Message_botMessageBubble"]',
      composer: 'textarea[class*="GrowingTextArea"], textarea',
    },
  ];

  // Fallbacks for any site: common ways chat pages mark who said what.
  const USER_FALLBACK = '[data-message-author-role="user"], [data-role="user"], [data-author="user"], [data-testid*="user-message" i]';
  const AI_FALLBACK = '[data-message-author-role="assistant"], [data-role="assistant"], [data-author="assistant"], [data-testid*="bot-message" i], [data-testid*="assistant" i]';
  // The button a site shows while the AI is writing ("Stop generating", "Stop response", …).
  const STOP_LABEL = /^(stop|stop (generating|response|responding|streaming|answer|answering|reply|replying|generation)|cancel (response|generation|generating))\b/i;

  function siteFor(href) {
    let host = '';
    try {
      host = new URL(href).hostname;
    } catch {
      return null;
    }
    return SITES.find((site) => site.hosts.test(host)) || null;
  }

  // The chat id in an address, or null (hex ids in lower case, like the app).
  function chatIdOf(site, href) {
    const match = site && site.chat.exec(href);
    if (!match) return null;
    const id = match.slice(1).find(Boolean);
    return site.chat.flags.includes('i') ? id.toLowerCase() : id;
  }

  const api = { SITES, USER_FALLBACK, AI_FALLBACK, STOP_LABEL, siteFor, chatIdOf };
  root.AI_CHAT_SITES = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
