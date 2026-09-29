// Runs on every AI website in sites.js and tells the extension's background script (and so the app)
// about your chats there. Nothing is sent anywhere else, and nothing on the page is changed.
//
// Claude and ChatGPT ("full" sites): page-hook.js reads the data those sites load (chat list,
// messages, each reply as it streams); this script passes it on, notes which chat you're looking
// at, and watches claude.ai's sidebar for its blue "unread" dot.
//
// Every other site is read from the page itself:
//   chat-list       chats linked in the sidebar: their ids and titles
//   page            the chat you have open: its title, your questions and the last reply shown
//   reply-started   you sent a message (with its text) and the AI began writing
//   reply-finished  the AI finished (with the start and end of its reply)
//   viewing         you had that chat open in a visible, focused tab
// "Writing" is spotted by the Stop button sites show meanwhile; when a site has none we can see,
// by the reply's text still changing.
(() => {
  const ext = globalThis.browser || globalThis.chrome;
  const S = globalThis.AI_CHAT_SITES;
  const site = S && S.siteFor(location.href);
  if (!site) return;
  const PLATFORM = site.platform;
  const TAG = '__aiChatManager';
  const HOOK_TYPES = new Set(['data', 'reply-started', 'reply-finished']);

  function send(event) {
    try {
      const sent = ext.runtime.sendMessage({ type: 'ai-chat-manager', event: { platform: PLATFORM, ...event } });
      if (sent && typeof sent.catch === 'function') sent.catch(() => {});
    } catch {
      // the extension was reloaded; the page picks it up after a refresh
    }
  }

  const currentChat = () => S.chatIdOf(site, location.href);
  const looking = () => document.visibilityState === 'visible' && document.hasFocus();
  const clip = (text, n = 1000) => (text || '').replace(/\s+\n/g, '\n').trim().slice(0, n);
  const visible = (el) => Boolean(el && (el.offsetParent !== null || el.getClientRects().length));

  // ---- you're looking at a chat ----

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
  document.addEventListener('visibilitychange', () => reportViewing());
  window.addEventListener('focus', () => reportViewing());
  window.addEventListener('blur', () => {
    reported = null;
  });
  setInterval(reportViewing, 1500); // these sites switch chats without reloading the page

  // ---- the sidebar's chat links ----

  function chatLinks() {
    const links = [];
    const seen = new Set();
    for (const link of document.querySelectorAll('a[href]')) {
      const uuid = S.chatIdOf(site, link.href);
      if (!uuid || seen.has(uuid)) continue;
      seen.add(uuid);
      links.push({ link, uuid });
    }
    return links;
  }

  // The first line of a link's text: its title, without dates or menu labels under it.
  function linkTitle(link) {
    const text = (link.getAttribute('aria-label') || link.innerText || link.textContent || '').trim();
    return clip(text.split('\n')[0], 200) || null;
  }

  // claude.ai puts a blue dot next to chats with a reply you haven't read. Best guess at its
  // markup; the app's Testing panel shows a sample of the sidebar so this can be adjusted.
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
    const links = chatLinks();
    if (!links.length) return;
    let event;
    if (site.full) {
      // Claude and ChatGPT: titles come with their data; only the unread markers are new here.
      const ids = links.map((l) => l.uuid);
      const unread = links.filter((l) => looksUnread(l.link)).map((l) => l.uuid);
      event = { type: 'sidebar', visible: ids.slice(0, 500), unread: unread.slice(0, 500) };
    } else {
      event = { type: 'chat-list', chats: links.slice(0, 500).map(({ link, uuid }) => ({ uuid, title: linkTitle(link) })) };
    }
    const summary = JSON.stringify(event);
    if (summary === lastSidebar && sampleSent) return;
    lastSidebar = summary;
    if (!sampleSent) {
      event.sample = sampleOf(links[0].link);
      sampleSent = true;
    }
    send({ ...event, at: Date.now() });
  }
  setInterval(scanSidebar, 3000);

  // ---- Claude and ChatGPT: pass on what page-hook.js saw ----

  if (site.full) {
    window.addEventListener('message', (message) => {
      if (message.source !== window || !message.data || message.data[TAG] !== 1) return;
      const event = message.data.event;
      if (!event || !HOOK_TYPES.has(event.type)) return;
      send(event);
      if (event.type === 'reply-finished' && event.uuid === currentChat()) reportViewing(true); // you watched it finish
    });
    return;
  }

  // ---- every other site: read the open chat from the page ----

  const all = (selector) => {
    try {
      return selector ? [...document.querySelectorAll(selector)] : [];
    } catch {
      return []; // a selector this browser doesn't understand
    }
  };
  // The outermost matches only, so a reply isn't counted once per nested part.
  const outermost = (els) => els.filter((el) => !els.some((other) => other !== el && other.contains(el)));
  const messages = (own, fallback) => outermost(all(own).length ? all(own) : all(fallback)).filter(visible);
  const textOf = (el) => clip(el ? el.innerText || el.textContent : '', 4000);

  function lastReply() {
    const replies = messages(site.ai, S.AI_FALLBACK);
    return textOf(replies[replies.length - 1]);
  }

  function stopButtonShown() {
    for (const button of document.querySelectorAll('button, [role="button"]')) {
      const label = (button.getAttribute('aria-label') || button.getAttribute('title') || '').trim();
      const testId = button.getAttribute('data-testid') || '';
      const text = label || (button.textContent || '').trim().slice(0, 40);
      if ((S.STOP_LABEL.test(text) || /(^|[-_])stop([-_]|$)/i.test(testId)) && visible(button) && !button.disabled) return true;
    }
    return false;
  }

  // What the open chat shows. Sent when it changes, so it also marks when you worked on it.
  let lastPage = '';
  function reportPage() {
    const uuid = currentChat();
    if (!uuid) return;
    const questions = messages(site.user, S.USER_FALLBACK).map((el) => clip(el.innerText || el.textContent, 1000)).filter(Boolean).slice(-100);
    const reply = lastReply();
    const event = { type: 'page', uuid, title: clip(document.title, 300) || null, questions, reply: reply ? reply.slice(0, 1000) : null };
    const summary = JSON.stringify(event);
    if (summary === lastPage) return;
    lastPage = summary;
    // What the extension could find on this site, for the app's Testing panel.
    event.probe = {
      userMessages: questions.length,
      aiReplies: messages(site.ai, S.AI_FALLBACK).length,
      composer: Boolean(composer()),
      sidebarLinks: chatLinks().length,
    };
    send({ ...event, at: Date.now() });
  }

  // ---- your message, and the reply ----

  function composer() {
    const active = document.activeElement;
    if (active && (active.tagName === 'TEXTAREA' || active.isContentEditable)) return active;
    return all(site.composer).find(visible) || null;
  }
  const composerText = (box) => clip(box ? (box.tagName === 'TEXTAREA' ? box.value : box.innerText) : '', 1000);

  let draft = ''; // what's in the box, kept as you type (sites clear it the moment you send)
  let sentPrompt = null; // { text, at } for the reply that should follow
  document.addEventListener('input', () => {
    const text = composerText(composer());
    if (text) draft = text;
  }, true);
  const markSent = () => {
    const text = composerText(composer()) || draft;
    if (!text) return;
    sentPrompt = { text, at: Date.now() };
    draft = '';
    setTimeout(tick, 300);
  };
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    const box = composer();
    if (box && (event.target === box || box.contains(event.target))) markSent();
  }, true);
  document.addEventListener('click', (event) => {
    const button = event.target.closest && event.target.closest('button, [role="button"]');
    if (!button) return;
    const label = `${button.getAttribute('aria-label') || ''} ${button.getAttribute('data-testid') || ''} ${button.type === 'submit' ? 'submit' : ''}`;
    if (/\b(send|submit)\b/i.test(label)) markSent();
  }, true);
  document.addEventListener('submit', markSent, true);

  // One reply at a time: started → (writing) → finished.
  let reply = null; // { uuid, started, prompt, baseline, text, changedAt, sawStop }
  function start(uuid, prompt, baseline) {
    reply = { uuid, started: false, prompt, baseline, text: baseline, changedAt: Date.now(), sawStop: false };
    if (uuid) announceStart();
  }
  function announceStart() {
    if (reply.started || !reply.uuid) return;
    reply.started = true;
    send({ type: 'reply-started', uuid: reply.uuid, at: Date.now(), prompt: reply.prompt || null });
  }
  function finish({ left = false } = {}) {
    // left: you switched to another chat, so the page shows that one's messages, not this reply.
    const text = left ? '' : reply.text && reply.text !== reply.baseline ? reply.text : lastReply();
    if (reply.uuid) {
      announceStart();
      send({ type: 'reply-finished', uuid: reply.uuid, at: Date.now(), text: text.slice(0, 1000), tail: text.slice(-300) });
      if (reply.uuid === currentChat()) reportViewing(true); // you watched it finish
    }
    reply = null;
    setTimeout(reportPage, 500);
  }

  let stopWasShown = false;
  function tick() {
    const uuid = currentChat();
    const stop = stopButtonShown();
    const appeared = stop && !stopWasShown; // only a Stop button that just appeared means a new reply
    stopWasShown = stop;
    const now = Date.now();
    if (!reply && sentPrompt && now - sentPrompt.at < 60000) {
      start(uuid, sentPrompt.text, lastReply());
      sentPrompt = null;
    } else if (!reply && appeared) {
      start(uuid, null, lastReply()); // writing, though we didn't see you send (e.g. "Regenerate")
    }
    if (!reply) return;
    if (!reply.uuid && uuid) {
      reply.uuid = uuid; // a new chat gets its address once the site saved it
      announceStart();
    } else if (reply.uuid && uuid && uuid !== reply.uuid) {
      finish({ left: true }); // the AI carries on without us watching; its reply waits for you there
      return;
    }
    const text = lastReply();
    if (text !== reply.text) {
      reply.text = text;
      reply.changedAt = now;
    }
    if (stop) reply.sawStop = true;
    const settled = now - reply.changedAt > 4000;
    const changed = reply.text && reply.text !== reply.baseline;
    if (reply.sawStop ? !stop && settled : changed && settled) finish();
    else if (now - reply.changedAt > 10 * 60000) reply = null; // nothing happened: give up quietly
  }
  setInterval(tick, 700);
  setInterval(reportPage, 2000);
})();
