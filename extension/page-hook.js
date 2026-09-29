// Runs inside claude.ai's own page so it can see the responses the page already fetches:
// your chat list, the chat you open, and each reply as it streams in.
// It never sends requests of its own and never changes what the page receives.
(() => {
  if (window.__aiChatManagerHooked) return;
  window.__aiChatManagerHooked = true;

  const TAG = '__aiChatManager';
  const DATA_URL = /\/api\/.*conversation/i;
  const COMPLETION_URL = /\/chat_conversations\/([0-9a-f-]{36})\/(?:completion|retry_completion)\b/i;
  const MAX_RESPONSE_CHARS = 3 * 1024 * 1024;
  const SKIP_KEYS = new Set(['files', 'files_v2', 'attachments', 'sync_sources', 'input', 'display_content']);

  function post(event) {
    try {
      window.postMessage({ [TAG]: 1, event }, window.location.origin);
    } catch {
      // never let the helper break the page
    }
  }

  // Keeps only what the app needs: shortened text, no attachments or tool inputs.
  function shrink(value, depth = 0) {
    if (typeof value === 'string') return value.length > 1000 ? value.slice(0, 1000) : value;
    if (value === null || typeof value !== 'object') return value;
    if (depth > 8) return null;
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

  async function readToEnd(response) {
    if (!response.body) return;
    const reader = response.body.getReader();
    while (!(await reader.read()).done) {
      // waiting for the reply to finish streaming
    }
  }

  function watch(args, pending) {
    const { url, method } = describe(args);
    if (!url || url.origin !== window.location.origin) return;

    const completion = COMPLETION_URL.exec(url.pathname);
    if (completion && method === 'POST') {
      const uuid = completion[1].toLowerCase();
      post({ type: 'reply-started', uuid, at: Date.now() });
      pending
        .then((response) => readToEnd(response.clone()))
        .catch(() => {})
        .finally(() => post({ type: 'reply-finished', uuid, at: Date.now() }));
      return;
    }

    if (DATA_URL.test(url.pathname)) {
      pending
        .then(async (response) => {
          const type = response.headers.get('content-type') || '';
          if (!response.ok || !type.includes('json')) return;
          const text = await response.clone().text();
          if (text.length > MAX_RESPONSE_CHARS) return;
          post({ type: 'data', url: url.pathname + url.search, at: Date.now(), body: shrink(JSON.parse(text)) });
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
