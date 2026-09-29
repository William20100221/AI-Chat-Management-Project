// Runs inside the AI website's own page (claude.ai, chatgpt.com) so it can see the responses the
// page already fetches: your chat list, the chat you open, and each reply as it streams in.
// It never sends requests of its own and never changes what the page receives.
(() => {
  if (window.__aiChatManagerHooked) return;
  window.__aiChatManagerHooked = true;

  const TAG = '__aiChatManager';
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const MAX_RESPONSE_CHARS = 3 * 1024 * 1024;
  const SKIP_KEYS = new Set(['files', 'files_v2', 'attachments', 'sync_sources', 'input', 'display_content']);

  // How each website loads chats and streams replies.
  const SITES = {
    claude: {
      data: (path, method) => method === 'GET' && /\/api\/.*conversation/i.test(path),
      reply: (path, method) => (method === 'POST' ? /\/chat_conversations\/([0-9a-f-]{36})\/(?:completion|retry_completion)\b/i.exec(path) : null),
      prompt: (body) => (typeof body.prompt === 'string' ? body.prompt : null),
    },
    chatgpt: {
      data: (path, method) => method === 'GET' && /^\/backend-api\/(conversations|conversation\/[0-9a-f-]{36})\/?$/i.test(path),
      // Sending a message: POST /backend-api/conversation (or /backend-api/f/conversation).
      // The chat id is in the request for existing chats, and in the stream for new ones.
      reply: (path, method) => (method === 'POST' && /^\/backend-api\/(f\/)?conversation\/?$/i.test(path) ? [path, null] : null),
      prompt: (body) => {
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const mine = messages.find((m) => m && m.author && m.author.role === 'user');
        const parts = mine && mine.content && Array.isArray(mine.content.parts) ? mine.content.parts : [];
        const text = parts.filter((p) => typeof p === 'string').join('\n');
        return text || null;
      },
      chatIdInRequest: (body) => (typeof body.conversation_id === 'string' ? body.conversation_id : null),
    },
  };
  const PLATFORM = /(^|\.)claude\.ai$/.test(location.hostname) ? 'claude' : 'chatgpt';
  const SITE = SITES[PLATFORM];

  function post(event) {
    try {
      window.postMessage({ [TAG]: 1, event: { platform: PLATFORM, ...event } }, window.location.origin);
    } catch {
      // never let the helper break the page
    }
  }

  // Keeps only what the app needs: shortened text, no attachments or tool inputs.
  function shrink(value, depth = 0) {
    if (typeof value === 'string') return value.length > 1000 ? value.slice(0, 1000) : value;
    if (value === null || typeof value !== 'object') return value;
    if (depth > 12) return null;
    if (Array.isArray(value)) return value.slice(0, 2000).map((item) => shrink(item, depth + 1));
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (!SKIP_KEYS.has(key)) out[key] = shrink(item, depth + 1);
    }
    return out;
  }

  function describe(args) {
    const input = args[0];
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
    const method = (args[1] && args[1].method) || (input && typeof input === 'object' && input.method) || 'GET';
    try {
      return { url: raw ? new URL(raw, window.location.href) : null, method: String(method).toUpperCase() };
    } catch {
      return { url: null, method };
    }
  }

  function requestBody(args) {
    try {
      const body = args[1] && args[1].body;
      return typeof body === 'string' ? JSON.parse(body) : {};
    } catch {
      return {};
    }
  }

  // Reads a streamed reply to the end, keeping its start (for the preview), its last words (to see
  // whether it ends with a question) and, for ChatGPT, the chat id of a brand-new chat.
  async function readReply(response, onChatId) {
    const reply = { head: '', tail: '' };
    if (!response.body) return reply;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = null; // ChatGPT's older format sends the whole text so far each time
    let inAssistant = false; // ChatGPT: the message being streamed is the AI's reply
    let appendTarget = false; // ChatGPT's newer format: do pieces without a path belong to the reply text?
    const take = (text) => {
      if (reply.head.length < 1000) reply.head += text.slice(0, 1000 - reply.head.length);
      reply.tail = (reply.tail + text).slice(-300);
    };
    const handle = (data) => {
      if (!data || typeof data !== 'object') return;
      const chatId = data.conversation_id || (data.v && typeof data.v === 'object' && data.v.conversation_id);
      if (typeof chatId === 'string' && UUID.test(chatId)) onChatId(chatId);
      // Claude: Messages-style deltas, or the older { completion } pieces.
      if (data.delta && data.delta.type === 'text_delta' && typeof data.delta.text === 'string') return take(data.delta.text);
      if (typeof data.completion === 'string') return take(data.completion);
      // ChatGPT, older: { message: { author: { role }, content: { parts: [whole text so far] } } }
      const message = data.message || (data.v && typeof data.v === 'object' && data.v.message);
      if (message && message.author) {
        inAssistant = message.author.role === 'assistant';
        appendTarget = inAssistant;
        const parts = message.content && Array.isArray(message.content.parts) ? message.content.parts : [];
        const text = parts.filter((p) => typeof p === 'string').join('');
        if (inAssistant && data.message) full = text;
        else if (inAssistant && text) take(text);
        return undefined;
      }
      // ChatGPT, newer: { p: '/message/content/parts/0', o: 'append', v: 'text' }, then bare { v: 'text' },
      // or { o: 'patch', v: [ …several of those… ] }.
      const ops = data.o === 'patch' && Array.isArray(data.v) ? data.v : [data];
      for (const op of ops) {
        if (!op || typeof op.v !== 'string') continue;
        if (op.p) appendTarget = inAssistant && /^\/message\/content\/parts/.test(op.p);
        if (appendTarget && (!op.o || op.o === 'append')) take(op.v);
      }
      return undefined;
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          handle(JSON.parse(payload));
        } catch {
          // not JSON: skip
        }
      }
    }
    if (full !== null && !reply.head) take(full);
    return reply;
  }

  function watch(args, pending) {
    const { url, method } = describe(args);
    if (!url || url.origin !== window.location.origin) return;
    const path = url.pathname;

    const reply = SITE.reply(path, method);
    if (reply) {
      const body = requestBody(args);
      const prompt = SITE.prompt(body);
      let chatId = reply[1] || (SITE.chatIdInRequest && SITE.chatIdInRequest(body)) || null;
      let started = false;
      const start = (id) => {
        if (started || !id) return;
        started = true;
        chatId = id.toLowerCase();
        post({ type: 'reply-started', uuid: chatId, at: Date.now(), prompt: prompt ? prompt.slice(0, 1000) : null });
      };
      start(chatId);
      pending
        .then((response) => readReply(response.clone(), start))
        .catch(() => ({ head: '', tail: '' }))
        .then((text) => {
          if (chatId) post({ type: 'reply-finished', uuid: chatId, at: Date.now(), text: text.head, tail: text.tail });
        });
      return;
    }

    if (SITE.data(path, method)) {
      pending
        .then(async (response) => {
          const type = response.headers.get('content-type') || '';
          if (!response.ok || !type.includes('json')) return;
          const text = await response.clone().text();
          if (text.length > MAX_RESPONSE_CHARS) return;
          post({ type: 'data', url: path + url.search, at: Date.now(), body: shrink(JSON.parse(text)) });
        })
        .catch(() => {});
    }
  }

  const originalFetch = window.fetch;
  window.fetch = function fetch(...args) {
    const pending = originalFetch.apply(this, args);
    try {
      watch(args, pending);
    } catch {
      // never let the helper break the page
    }
    return pending;
  };
})();
