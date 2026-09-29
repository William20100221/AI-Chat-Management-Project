// Passes what page-hook.js sees on to the extension's background script, and notes which chat
// you are looking at (tab visible and focused), so a finished reply you watched isn't "new".
// Works on claude.ai (chats at /chat/<id>) and chatgpt.com (chats at /c/<id>).
(() => {
  const ext = globalThis.browser || globalThis.chrome;
  const TAG = '__aiChatManager';
  const TYPES = new Set(['data', 'reply-started', 'reply-finished']);
  const ID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
  const PLATFORM = /(^|\.)claude\.ai$/.test(location.hostname) ? 'claude' : 'chatgpt';
  const CHAT_LINK = PLATFORM === 'claude' ? new RegExp(`/chat/${ID}`, 'i') : new RegExp(`/c/${ID}`, 'i');
  const LINK_SELECTOR = PLATFORM === 'claude' ? 'a[href*="/chat/"]' : 'a[href*="/c/"]';

  function send(event) {
    try {
      const sent = ext.runtime.sendMessage({ type: 'ai-chat-manager', event: { platform: PLATFORM, ...event } });
      if (sent && typeof sent.catch === 'function') sent.catch(() => {});
    } catch {
      // extension was reloaded; the page will pick it up after a refresh
    }
  }

  function currentChat() {
    const match = CHAT_LINK.exec(window.location.pathname);
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

  // claude.ai puts a blue dot next to chats with a reply you haven't read. This looks for signs of
  // that dot on the sidebar links. (Best guess at claude.ai's markup; the app's Testing panel
  // shows a sample of the sidebar so it can be adjusted.)
  function looksUnread(link) {
    const own = [link.getAttribute('aria-label'), link.getAttribute('title'), link.getAttribute('data-state'), link.className].join(' ');
    if (/\bunread\b|new (message|reply|response)/i.test(own)) return true;
    return Boolean(link.querySelector('[aria-label*="unread" i], [title*="unread" i], [data-unread], [class*="unread" i], [data-testid*="unread" i]'));
  }

  // The first chat link's structure with all text removed (no chat titles), for the Testing panel.
  function sampleOf(link) {
    const copy = link.cloneNode(true);
    const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    for (const node of texts) if (node.nodeValue.trim()) node.nodeValue = '…';
    for (const el of copy.querySelectorAll('svg path')) el.removeAttribute('d');
    return copy.outerHTML.slice(0, 2000);
  }

  let lastSidebar = '';
  let sampleSent = false;
  function scanSidebar() {
    const visible = [];
    const unread = [];
    let firstLink = null;
    for (const link of document.querySelectorAll(LINK_SELECTOR)) {
      const match = CHAT_LINK.exec(link.getAttribute('href') || '');
      if (!match) continue;
      const uuid = match[1].toLowerCase();
      if (visible.includes(uuid)) continue;
      if (!firstLink) firstLink = link;
      visible.push(uuid);
      if (looksUnread(link)) unread.push(uuid);
    }
    if (!visible.length) return;
    const summary = `${visible.join(',')}|${unread.join(',')}`;
    if (summary === lastSidebar && sampleSent) return;
    lastSidebar = summary;
    const event = { type: 'sidebar', at: Date.now(), visible: visible.slice(0, 500), unread: unread.slice(0, 500) };
    if (!sampleSent && firstLink) {
      event.sample = sampleOf(firstLink);
      sampleSent = true;
    }
    send(event);
  }
  setInterval(scanSidebar, 3000);

  document.addEventListener('visibilitychange', () => reportViewing());
  window.addEventListener('focus', () => reportViewing());
  window.addEventListener('blur', () => {
    reported = null;
  });
  setInterval(reportViewing, 1500); // claude.ai switches chats without reloading the page
})();
