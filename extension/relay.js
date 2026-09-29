// Passes what page-hook.js sees on to the extension's background script, and notes which chat
// you are looking at (tab visible and focused), so a finished reply you watched isn't "new".
(() => {
  const ext = globalThis.browser || globalThis.chrome;
  const TAG = '__aiChatManager';
  const TYPES = new Set(['data', 'reply-started', 'reply-finished']);

  function send(event) {
    try {
      const sent = ext.runtime.sendMessage({ type: 'ai-chat-manager', event });
      if (sent && typeof sent.catch === 'function') sent.catch(() => {});
    } catch {
      // extension was reloaded; the page will pick it up after a refresh
    }
  }

  function currentChat() {
    const match = /^\/chat\/([0-9a-f-]{36})/i.exec(window.location.pathname);
    return match ? match[1].toLowerCase() : null;
  }

  function looking() {
    return document.visibilityState === 'visible' && document.hasFocus();
  }

  let reported = null;
  function reportViewing(force = false) {
    const uuid = currentChat();
    if (!uuid || !looking()) {
      reported = null;
      return;
    }
    if (uuid === reported && !force) return;
    reported = uuid;
    send({ type: 'viewing', uuid, at: Date.now() });
  }

  window.addEventListener('message', (message) => {
    if (message.source !== window || !message.data || message.data[TAG] !== 1) return;
    const event = message.data.event;
    if (!event || !TYPES.has(event.type)) return;
    send(event);
    if (event.type === 'reply-finished' && event.uuid === currentChat()) reportViewing(true); // you watched it finish
  });

  document.addEventListener('visibilitychange', () => reportViewing());
  window.addEventListener('focus', () => reportViewing());
  window.addEventListener('blur', () => {
    reported = null;
  });
  setInterval(reportViewing, 1500); // claude.ai switches chats without reloading the page
})();
