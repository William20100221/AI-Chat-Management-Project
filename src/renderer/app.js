'use strict';

// Everything shown here comes from window.api (see preload.js). Text from chats is only ever
// inserted with textContent, never as HTML.

const backend = window.api; // "api" itself is taken: the bridge defines window.api as a global
const icon = window.icon;

const TYPE_ICONS = { chat: 'chat', cowork: 'cowork', code: 'code', work: 'cowork', codex: 'code', cli: 'code' };
const WORKING = new Set(['asking', 'responding', 'new-reply', 'pinned']);
const WORKING_ORDER = { asking: 0, responding: 1, 'new-reply': 2, pinned: 3 };
const WORKING_GROUPS = { asking: 'Asking you', responding: 'Replying now', 'new-reply': 'New replies', pinned: 'Pinned' };
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const compactQuery = window.matchMedia('(max-width: 719px)');

const view = {
  tab: 'working',
  platform: null, // null = all platforms; otherwise you're "inside" that platform
  type: 'any', // inside a platform: one of its types (e.g. Chat, Cowork, Code) or all
  moreOpen: false, // the "More" platform search menu
  searchIds: null,
  selectedId: null, // full view: shown in the side panel; compact view: expanded under its row
  stickyId: null, // stays in the list after you open it, even if it no longer matches the tab
};
let snap = {
  items: [],
  sources: [],
  settings: { recentDays: 7, watchDownloads: true, themeMode: 'system', themeColor: 'indigo', compact: false, keepOnTop: false },
  lastImports: {},
  platforms: [],
  pendingExport: null,
  lastScanAt: null,
  setupDone: true, // until the app says otherwise
  system: { os: '', packaged: false, browsers: [] },
};
let detailKey = null;
let lastDetail = null; // the details currently shown, so the list can redraw without re-asking

const $ = (selector) => document.querySelector(selector);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function button(label, { kind = 'tonal', iconName, small = true, onClick } = {}) {
  const node = el('button', `button ${kind}${small ? ' small' : ''}`);
  node.type = 'button';
  if (iconName) node.append(icon(iconName));
  node.append(label);
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function relative(ms) {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${plural(Math.floor(diff / MINUTE), 'minute')} ago`;
  if (diff < DAY) return `${plural(Math.floor(diff / HOUR), 'hour')} ago`;
  if (diff < 30 * DAY) return `${plural(Math.floor(diff / DAY), 'day')} ago`;
  return dateText(ms);
}

function shortTime(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < MINUTE) return 'now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)}d`;
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function dateText(ms) {
  return ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
}

function dateTimeText(ms) {
  return ms
    ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '—';
}

function timeGroup(ms) {
  if (!ms) return 'No date';
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  if (ms >= startOfToday) return 'Today';
  if (ms >= startOfToday - DAY) return 'Yesterday';
  if (ms >= startOfToday - 6 * DAY) return 'Earlier this week';
  if (ms >= startOfToday - 29 * DAY) return 'Earlier this month';
  return 'Older';
}

function isCompact() {
  return compactQuery.matches;
}

// ---- platforms ----

function platformOf(id) {
  return snap.platforms.find((p) => p.id === id) || { id, name: id, types: [], websiteName: '' };
}

function typeName(item) {
  const type = platformOf(item.platform).types.find((t) => t.id === item.source);
  return type ? type.name : item.source;
}

// Who's doing the work: "Claude", "ChatGPT", or "Codex" for Codex sessions.
function agentName(item) {
  return item.source === 'codex' ? 'Codex' : platformOf(item.platform).name;
}

// The platforms you use (found on this computer, in history, the extension or an export).
function usedPlatforms() {
  return snap.platforms.filter((p) => p.used);
}

function describeItem(item) {
  return `${platformOf(item.platform).name} \u00b7 ${typeName(item)}`;
}

// ---- which items show ----

function matchesFilters(item) {
  if (view.platform && item.platform !== view.platform) return false;
  if (view.platform && view.type !== 'any' && item.source !== view.type) return false;
  if (view.searchIds && !view.searchIds.has(item.id)) return false;
  return true;
}

function inTab(item, tab) {
  if (tab === 'working') return WORKING.has(item.state);
  if (tab === 'done') return item.state === 'done';
  if (tab === 'recent') return item.state !== 'done' && item.updatedAt >= Date.now() - snap.settings.recentDays * DAY;
  return true;
}

function visibleItems() {
  const list = snap.items.filter((item) => matchesFilters(item) && (inTab(item, view.tab) || item.id === view.stickyId));
  if (view.tab === 'working') {
    return list.sort((a, b) => (WORKING_ORDER[a.state] ?? 4) - (WORKING_ORDER[b.state] ?? 4) || (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function groupOf(item) {
  if (view.tab === 'working') return WORKING_GROUPS[item.state] || 'Just opened';
  return timeGroup(item.updatedAt);
}

// ---- rendering: list ----

function renderCounts() {
  const base = snap.items.filter(matchesFilters);
  for (const node of document.querySelectorAll('[data-count]')) {
    const tab = node.dataset.count;
    const count = base.filter((item) => inTab(item, tab)).length;
    node.textContent = isCompact() && tab !== 'working' ? '' : String(count);
  }
}

function renderBanner() {
  const banner = $('#banner');
  const nodes = [];
  if (!snap.setupDone) {
    banner.hidden = true; // the first-run setup comes first
    return;
  }
  const showsChats = view.type === 'any' || view.type === 'chat';
  const pending = snap.pendingExport;

  if (pending && !pending.opened) {
    const text = el('p');
    text.append(el('strong', null, 'Your Claude export is ready. '), 'Download your chats and they’ll be imported automatically.');
    const actions = el('div', 'banner-actions');
    actions.append(
      button('Download chats', { kind: 'filled', iconName: 'download', onClick: () => backend.downloadExport() }),
      button('Dismiss', { kind: 'text', onClick: () => backend.dismissExport() }),
    );
    nodes.push(text, actions);
  } else if (pending && pending.opened) {
    const text = el('p', null, 'Downloading your chats in the browser… they’ll appear here as soon as the zip lands in Downloads.');
    nodes.push(text, button('Dismiss', { kind: 'text', onClick: () => backend.dismissExport() }));
  } else if (needsWebsite()) {
    // Step 1 found nothing on this computer, so the website (through the extension) is the way in.
    const ext = snap.connections.extension;
    const text = el('p');
    const site = platformOf(view.platform || 'claude');
    if (ext.everConnected) {
      text.append(el('strong', null, 'The browser extension isn’t connected. '), 'Open an AI website in your browser and it reconnects within a minute.');
    } else {
      text.append(el('strong', null, 'No AI apps or AI chats in your browser history found. '), 'Connect your browser to see your chats from AI websites here.');
    }
    const actions = el('div', 'banner-actions');
    actions.append(button(ext.everConnected ? `Open ${site.websiteName}` : 'Connect', {
      kind: 'filled',
      iconName: ext.everConnected ? 'openInNew' : undefined,
      onClick: () => (ext.everConnected ? backend.openWebsite(site.id) : openSettings('connections')),
    }));
    nodes.push(text, actions);
  } else if (showsChats && !snap.items.some((i) => i.source === 'chat' && (!view.platform || i.platform === view.platform)) && !hintDismissed()) {
    const text = el('p');
    text.append(
      el('strong', null, 'Want your website chats here too? '),
      snap.settings.readHistory
        ? 'None were found in your browser history yet. Connect the browser extension to see your AI website chats live, or import your data exports.'
        : 'Turn on browser history in Settings, or connect the browser extension, to see your chats from AI websites.',
    );
    const actions = el('div', 'banner-actions');
    actions.append(
      button('Connect', { kind: 'filled', onClick: () => openSettings('connections') }),
      button('Hide', { kind: 'text', onClick: () => { dismissHint(); renderBanner(); } }),
    );
    nodes.push(text, actions);
  }

  banner.replaceChildren(...nodes);
  banner.hidden = nodes.length === 0;
}

function needsWebsite() {
  const c = snap.connections;
  return Boolean(c && c.local.scanned && !c.local.found && !c.extension.connected && !(c.history && c.history.chats));
}

function hintDismissed() {
  try {
    return localStorage.getItem('hideChatHint') === '1';
  } catch {
    return false;
  }
}

function dismissHint() {
  try {
    localStorage.setItem('hideChatHint', '1');
  } catch {
    // storage unavailable: the hint just comes back next time
  }
}

function renderListTools() {
  const tools = $('#list-tools');
  const unread = snap.items.filter((item) => matchesFilters(item) && item.state === 'new-reply');
  if (view.tab === 'working' && unread.length > 1) {
    tools.replaceChildren(button('Mark all as read', { kind: 'text', iconName: 'doneAll', onClick: () => backend.markSeen(unread.map((i) => i.id)) }));
    tools.hidden = false;
  } else {
    tools.hidden = true;
  }
}

function renderEmpty(count) {
  const empty = $('#empty');
  empty.hidden = count > 0;
  if (count > 0) return;
  if (view.searchIds) empty.textContent = 'Nothing matches your search.';
  else if (view.tab === 'working') empty.textContent = 'Nothing needs you right now. Chats appear here when an AI asks you something, while it’s replying, when a reply is waiting for you, or when you pin them.';
  else if (view.tab === 'done') empty.textContent = 'Nothing marked as done.';
  else if (view.tab === 'recent') empty.textContent = `Nothing active in the last ${plural(snap.settings.recentDays, 'day')}.`;
  else empty.textContent = 'No chats or sessions found yet. Check Settings → Sources.';
}

function stateIndicator(item) {
  if (item.state === 'asking') return icon('help', 'asking-icon');
  if (item.state === 'responding') return el('span', 'spinner');
  if (item.state === 'new-reply') return el('span', 'dot');
  if (item.state === 'pinned') return icon('pin');
  if (item.state === 'done') return icon('taskAlt');
  return null;
}

function rowFor(item) {
  const row = el('li', `row state-${item.state}`);
  row.dataset.id = item.id;
  if (item.id === view.selectedId) row.classList.add('selected', isCompact() ? 'expanded' : 'selected');
  row.tabIndex = -1;

  // The avatar's colour is the platform, its icon the type.
  const avatar = el('span', `avatar platform-${item.platform}`);
  avatar.append(icon(TYPE_ICONS[item.source] || 'chat'));
  avatar.title = describeItem(item);

  const main = el('div', 'row-main');
  main.append(el('div', `row-title${item.untitled ? ' untitled' : ''}`, item.title));
  const support = el('div', 'row-support');
  const where = view.platform ? typeName(item) : describeItem(item);
  if (item.state === 'asking') support.append(el('span', 'live', item.question ? `Asks: ${item.question}` : `${agentName(item)} is asking you`));
  else if (item.state === 'responding') support.append(el('span', 'live', `${agentName(item)} is replying…`));
  else if (item.state === 'new-reply') support.append(el('span', 'live', item.asks ? 'New reply · asks you something' : 'New reply'));
  else support.append(el('span', null, where));
  if (item.state === 'asking' || item.state === 'responding' || item.state === 'new-reply') support.append(el('span', null, `· ${where}`));
  if (item.questionCount) support.append(el('span', null, `· ${plural(item.questionCount, 'question')}`));
  main.append(support);

  const trail = el('div', 'row-trail');
  const indicator = stateIndicator(item);
  if (indicator) trail.append(indicator);
  trail.append(el('span', null, isCompact() ? shortTime(item.updatedAt) : relative(item.updatedAt)));

  row.append(avatar, main, trail, icon('expandMore', 'chevron'));
  row.addEventListener('click', () => open(item.id));
  return row;
}

function renderList() {
  const items = visibleItems();
  const nodes = [];
  let lastGroup = null;
  for (const item of items) {
    const group = groupOf(item);
    if (group !== lastGroup) {
      nodes.push(el('li', 'group-label', group));
      lastGroup = group;
    }
    nodes.push(rowFor(item));
    if (isCompact() && item.id === view.selectedId) {
      const holder = el('li', 'inline-detail');
      holder.dataset.detailFor = item.id;
      nodes.push(holder);
    }
  }
  $('#list').replaceChildren(...nodes);
  renderEmpty(items.length);
  if (isCompact()) paintDetail(); // the row's detail holder was just re-created
}

function renderStatus() {
  const replying = snap.items.filter((i) => i.state === 'responding').length;
  const asking = snap.items.filter((i) => i.state === 'asking').length;
  const parts = [];
  if (asking) parts.push(`${asking} asking you`);
  if (replying) parts.push(`${replying} replying now`);
  for (const p of usedPlatforms()) {
    const count = snap.items.filter((i) => i.platform === p.id).length;
    parts.push(`${p.name} ${count}`);
  }
  const ext = snap.connections && snap.connections.extension;
  if (ext && ext.connected) parts.push(`websites linked (${ext.browser || 'browser'})`);
  $('#status-text').textContent = parts.join('  ·  ');
}

// ---- the platform row: All platforms · Claude · ChatGPT · More, or inside one platform ----

// How many items each platform and type has in the current tab (and search).
function platformCounts() {
  const counts = { all: 0 };
  for (const item of snap.items) {
    if (view.searchIds && !view.searchIds.has(item.id)) continue;
    if (!inTab(item, view.tab)) continue;
    counts.all++;
    counts[item.platform] = (counts[item.platform] || 0) + 1;
    counts[`${item.platform}:${item.source}`] = (counts[`${item.platform}:${item.source}`] || 0) + 1;
  }
  return counts;
}

function chip(label, { selected = false, count, className = '', onClick } = {}) {
  const node = el('button', `chip${selected ? ' selected' : ''}${className ? ` ${className}` : ''}`);
  node.type = 'button';
  if (selected) node.append(icon('check', 'chip-check-icon'));
  node.append(label);
  if (count !== undefined) node.append(el('span', 'count', String(count)));
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

function enterPlatform(id) {
  view.platform = id;
  view.type = 'any';
  view.moreOpen = false;
  view.stickyId = null;
  renderPlatformBar();
  render();
}

function leavePlatform() {
  view.platform = null;
  view.type = 'any';
  view.stickyId = null;
  renderPlatformBar();
  render();
}

function setType(type) {
  view.type = type;
  view.stickyId = null;
  renderPlatformBar();
  render();
}

function closeMore() {
  if (!view.moreOpen) return;
  view.moreOpen = false;
  renderPlatformBar();
}

// "More": search for a platform by name (useful once there are many).
function platformMenu(counts) {
  const menu = el('div', 'platform-menu');
  menu.addEventListener('click', (event) => event.stopPropagation());
  const input = el('input');
  input.id = 'platform-search';
  input.type = 'search';
  input.placeholder = 'Find a platform';
  input.autocomplete = 'off';
  const list = el('ul', 'platform-list');
  const fill = () => {
    const query = input.value.trim().toLowerCase();
    // The ones you use first; the rest are there too, marked "not found yet".
    const matches = snap.platforms
      .filter((p) => p.name.toLowerCase().includes(query) || p.id.includes(query) || (p.websiteName || '').includes(query))
      .sort((a, b) => Number(b.used) - Number(a.used));
    list.replaceChildren(...(matches.length
      ? matches.map((p) => {
        const li = el('li');
        const option = el('button', `platform-option platform-${p.id}${p.used ? '' : ' unused'}`);
        option.type = 'button';
        const name = el('span', 'option-name', p.name);
        if (!p.used) name.append(el('span', 'option-note', 'not found yet'));
        option.append(el('span', 'platform-dot'), name, el('span', 'count', String(counts[p.id] || 0)));
        option.addEventListener('click', () => enterPlatform(p.id));
        li.append(option);
        return li;
      })
      : [el('li', 'help small', 'No platform with that name yet.')]));
  };
  input.addEventListener('input', fill);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const first = list.querySelector('button');
      if (first) first.click();
    } else if (event.key === 'Escape') {
      closeMore();
    }
  });
  fill();
  menu.append(input, list);
  return menu;
}

function renderPlatformBar() {
  const bar = $('#platform-bar');
  const counts = platformCounts();
  const nodes = [];
  if (!view.platform) {
    nodes.push(chip('All platforms', { selected: true, count: counts.all }));
    for (const p of usedPlatforms()) {
      const node = chip(p.name, { count: counts[p.id] || 0, className: `platform-chip platform-${p.id}`, onClick: () => enterPlatform(p.id) });
      node.prepend(el('span', 'platform-dot'));
      node.append(icon('chevronRight', 'enter-icon'));
      node.title = `Show only ${p.name}`;
      nodes.push(node);
    }
    const more = el('div', 'more');
    const moreButton = chip('More', { className: 'more-button' });
    moreButton.prepend(icon('search'));
    moreButton.setAttribute('aria-expanded', String(view.moreOpen));
    moreButton.addEventListener('click', (event) => {
      event.stopPropagation();
      view.moreOpen = !view.moreOpen;
      renderPlatformBar();
      if (view.moreOpen) $('#platform-search').focus();
    });
    more.append(moreButton);
    if (view.moreOpen) more.append(platformMenu(counts));
    nodes.push(more);
  } else {
    const p = platformOf(view.platform);
    const back = el('button', 'back-button');
    back.type = 'button';
    back.append(icon('arrowBack'), 'All platforms');
    back.addEventListener('click', leavePlatform);
    const title = el('span', `platform-title platform-${p.id}`);
    title.append(el('span', 'platform-dot'), p.name);
    const types = el('div', 'type-chips');
    types.append(chip('All types', { selected: view.type === 'any', count: counts[p.id] || 0, onClick: () => setType('any') }));
    // Only the types you have (in any tab), so a Gemini user without the CLI sees just "Chat".
    const have = new Set(snap.items.filter((i) => i.platform === p.id).map((i) => i.source));
    for (const t of p.types) {
      if (!have.has(t.id) && view.type !== t.id) continue;
      types.append(chip(t.name, { selected: view.type === t.id, count: counts[`${p.id}:${t.id}`] || 0, onClick: () => setType(t.id) }));
    }
    nodes.push(back, title, types);
  }
  bar.replaceChildren(...nodes);
  bar.dataset.level = view.platform ? 'platform' : 'all';
}

function render() {
  if (!view.moreOpen) renderPlatformBar(); // don't rebuild the menu while you type in it
  renderCounts();
  renderBanner();
  renderListTools();
  renderList();
  renderStatus();
}

// ---- rendering: details ----

function messageBox(label, message, agent) {
  const box = el('div', 'message');
  const who = message.role === 'user' ? 'You' : agent;
  box.append(el('span', 'who', `${who} · ${label}${message.at ? ` · ${dateTimeText(message.at)}` : ''}`));
  box.append(document.createTextNode(message.text));
  return box;
}

function stateCard(item) {
  const card = el('div', 'state-card');
  if (item.state === 'asking') {
    card.classList.add('live');
    card.append(icon('help'), el('span', null, item.question ? `${agentName(item)} is waiting for your answer: ${item.question}` : `${agentName(item)} is waiting for your answer`));
  } else if (item.state === 'responding') {
    card.classList.add('live');
    card.append(el('span', 'spinner'), `${agentName(item)} is replying right now`);
  } else if (item.state === 'new-reply') {
    card.classList.add('live');
    card.append(el('span', 'dot'), item.asks ? 'New reply that asks you something' : 'New reply you haven’t looked at');
  } else if (item.mark === 'pinned') {
    card.append(icon('pin'), 'Pinned: stays in Working until you unpin it');
  } else if (item.mark === 'done') {
    card.append(icon('taskAlt'), 'Marked done: comes back if something new happens');
  } else if (item.state === 'done') {
    card.append(icon('taskAlt'), `Archived in ${platformOf(item.platform).name}`);
  } else {
    return null;
  }
  return card;
}

function buildDetail(detail, item) {
  const nodes = [el('h2', 'detail-title', detail.title)];
  const about = item || { platform: detail.platform, source: detail.source };
  const agent = agentName(about);

  const meta = el('div', 'detail-meta');
  const source = el('span', `label-chip platform-${about.platform}`);
  source.append(icon(TYPE_ICONS[about.source] || 'chat'), describeItem(about));
  const fromHistoryOnly = detail.seenIn && !detail.questions.length && !detail.firstMessage;
  meta.append(
    source,
    el('span', 'label-chip', `${fromHistoryOnly ? 'First opened' : 'Started'} ${dateText(detail.createdAt)}`),
    el('span', 'label-chip', `${fromHistoryOnly ? 'Last opened' : 'Active'} ${relative(detail.updatedAt)}`),
  );
  nodes.push(meta);

  if (item) {
    const card = stateCard(item);
    if (card) nodes.push(card);

    const actions = el('div', 'actions');
    const pinned = item.mark === 'pinned';
    const done = item.mark === 'done';
    actions.append(
      button(pinned ? 'Unpin' : 'Pin', { iconName: 'pin', kind: pinned ? 'active' : 'tonal', onClick: () => backend.mark(item.id, pinned ? 'auto' : 'pinned') }),
      button(done ? 'Not done' : 'Done', { iconName: 'taskAlt', kind: done ? 'active' : 'tonal', onClick: () => backend.mark(item.id, done ? 'auto' : 'done') }),
    );
    if (detail.canOpenChat) {
      // Work and Codex chats open in the ChatGPT app; everything else on the website.
      const where = about.source === 'work' || about.source === 'codex' ? 'ChatGPT app' : platformOf(about.platform).name;
      actions.append(button(`Open in ${where}`, {
        iconName: 'openInNew',
        kind: 'outlined',
        onClick: async () => {
          const result = await backend.openChat(detail.id);
          if (result && result.error) snackbar(result.error, 'error');
        },
      }));
    }
    if (detail.canOpenFolder) actions.append(button('Folder', { iconName: 'folder', kind: 'outlined', onClick: () => backend.openFolder(detail.id) }));
    if (detail.resumeCommand) {
      actions.append(button('Copy resume command', {
        iconName: 'copy',
        kind: 'outlined',
        onClick: async () => {
          await backend.copyResume(detail.id);
          snackbar(`Copied: ${detail.resumeCommand}`);
        },
      }));
    }
    nodes.push(actions);
  }

  if (detail.folder && !isCompact()) nodes.push(el('div', 'section-label', 'Folder'), el('div', 'mono', detail.folder));

  if (detail.firstMessage) nodes.push(el('div', 'section-label', 'First message'), messageBox('first', detail.firstMessage, agent));
  const last = detail.lastMessage;
  const sameAsFirst = last && detail.firstMessage && last.text === detail.firstMessage.text && last.at === detail.firstMessage.at;
  if (last && !sameAsFirst) nodes.push(el('div', 'section-label', 'Last message'), messageBox('latest', last, agent));

  if (detail.questions.length) {
    nodes.push(el('div', 'section-label', `Your questions (${detail.questions.length})`));
    const list = el('ol', 'questions');
    const limit = isCompact() ? 5 : 10;
    const addQuestion = (q) => {
      const li = el('li');
      li.append(document.createTextNode(q.text));
      if (q.at) li.append(el('span', 'when', dateTimeText(q.at)));
      list.append(li);
    };
    detail.questions.slice(0, limit).forEach(addQuestion);
    nodes.push(list);
    if (detail.questions.length > limit) {
      const more = button(`Show all ${detail.questions.length}`, { kind: 'text' });
      more.addEventListener('click', () => {
        detail.questions.slice(limit).forEach(addQuestion);
        more.remove();
      });
      nodes.push(more);
    }
  } else if (fromHistoryOnly) {
    const name = platformOf(about.platform).name;
    const note = el('p', 'help');
    note.append(`Found in your browser history (${detail.seenIn.join(', ')}). ${name} keeps the messages on its servers, so only the title and when you opened it are known here. Open it to see the chat.`);
    if (detail.untitled) note.append(` ${name} doesn’t put chat titles in the browser tab, so it has no title here.`);
    nodes.push(note);
  } else if (!detail.firstMessage) {
    nodes.push(el('p', 'help', 'No messages could be read for this one.'));
  }
  if (detail.seenIn && !fromHistoryOnly && detail.lastOpenedAt) {
    nodes.push(el('p', 'help small', `Last opened in ${detail.seenIn.join(', ')} ${relative(detail.lastOpenedAt)}.`));
  }
  return nodes;
}

function detailTarget() {
  if (isCompact()) return document.querySelector(`[data-detail-for="${CSS.escape(view.selectedId)}"]`);
  return $('#detail');
}

function keyOf(item) {
  return item ? `${item.id}|${item.updatedAt}|${item.mark}|${item.state}|${isCompact()}` : null;
}

// Fetches details when the item changed (new message, new state), then paints them.
async function showDetail(id) {
  const key = keyOf(snap.items.find((i) => i.id === id));
  if (key === detailKey && lastDetail && lastDetail.id === id) return;
  detailKey = key;
  try {
    const detail = await backend.getDetail(id);
    if (view.selectedId !== id) return;
    lastDetail = detail;
    paintDetail();
  } catch {
    clearDetail();
  }
}

function paintDetail() {
  if (!lastDetail || lastDetail.id !== view.selectedId) return;
  const target = detailTarget();
  if (target) target.replaceChildren(...buildDetail(lastDetail, snap.items.find((i) => i.id === lastDetail.id)));
}

function clearDetail() {
  detailKey = null;
  lastDetail = null;
  $('#detail').replaceChildren(el('div', 'detail-placeholder', 'Select a chat to see what it was about.'));
}

// Clicking a row: full view shows it in the side panel; compact view expands it under the row.
function open(id) {
  if (isCompact() && view.selectedId === id) {
    view.selectedId = null;
    view.stickyId = null;
    renderList();
    return;
  }
  view.selectedId = id;
  view.stickyId = id;
  lastDetail = null;
  detailKey = null;
  renderList();
  showDetail(id);
  backend.markSeen([id]); // you've looked at it now
}

// ---- snapshot updates ----

function applySnapshot(next) {
  snap = next;
  applyAppearance();
  renderSetup();
  const selected = view.selectedId && snap.items.find((i) => i.id === view.selectedId);
  if (view.selectedId && !selected) {
    view.selectedId = null;
    view.stickyId = null;
    clearDetail();
  }
  // You're looking at it, so a reply that finishes while it's open counts as seen.
  if (selected && selected.state === 'new-reply' && document.hasFocus()) backend.markSeen([selected.id]);
  if (!view.moreOpen) renderPlatformBar();
  renderCounts();
  renderBanner();
  renderListTools();
  renderList();
  renderStatus();
  if (selected) showDetail(selected.id);
}

function applyAppearance() {
  const root = document.documentElement;
  root.dataset.mode = snap.settings.themeMode;
  root.dataset.color = snap.settings.themeColor;
  const toggle = $('#toggle-compact');
  const compact = snap.settings.compact;
  toggle.title = compact ? 'Full view' : 'Compact view';
  toggle.setAttribute('aria-label', toggle.title);
  toggle.replaceChildren(icon(compact ? 'expand' : 'compact'));
  syncTitleBar();
}

// The system's window buttons (Windows, Linux) are drawn over the title bar: give them the
// theme's text colour, and tell them whether the theme is dark (for their hover shade).
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
let titleBarKey = null;
function syncTitleBar() {
  const mode = document.documentElement.dataset.mode;
  const dark = mode === 'dark' || (mode !== 'light' && darkQuery.matches);
  const symbolColor = hexColor(getComputedStyle(document.body).color);
  const key = `${dark}|${symbolColor}`;
  if (key === titleBarKey) return;
  titleBarKey = key;
  backend.setTitleBar({ dark, symbolColor });
}

// Any CSS colour (the theme uses oklch) as #rrggbb.
let colorCanvas = null;
function hexColor(css) {
  colorCanvas = colorCanvas || document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  colorCanvas.clearRect(0, 0, 1, 1);
  colorCanvas.fillStyle = css;
  colorCanvas.fillRect(0, 0, 1, 1);
  const [r, g, b] = colorCanvas.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// The search box is narrower in compact view.
function fitSearchPlaceholder() {
  $('#search').placeholder = isCompact() ? 'Search' : 'Search titles and questions';
}

// ---- snackbar ----

let snackbarTimer = null;
function snackbar(text, kind = 'ok') {
  const node = $('#snackbar');
  node.textContent = text;
  node.className = `snackbar${kind === 'error' ? ' error' : ''}`;
  node.hidden = false;
  clearTimeout(snackbarTimer);
  snackbarTimer = setTimeout(() => {
    node.hidden = true;
  }, 4000);
}

// ---- first-run setup: what the app may read, before it reads anything ----

const SETUP_PAGES = 4;
let setupPage = 1;
let setupFinishing = false; // finished, but still showing the last page

function renderSetup() {
  const dialog = $('#setup');
  if (!snap.setupDone && !dialog.open) {
    setupPage = 1;
    setupFinishing = false;
    const s = snap.settings;
    $('#setup-local').checked = s.readLocal;
    $('#setup-history').checked = s.readHistory;
    $('#setup-downloads').checked = s.watchDownloads;
    $('#setup-login').checked = true; // suggested: it's a sticky note
    $('#setup-login').closest('label').hidden = snap.system.os === 'linux';
    $('#setup-mac').hidden = snap.system.os !== 'darwin';
    const browsers = snap.system.browsers || [];
    $('#setup-browsers').textContent = browsers.length ? `Browsers found on this computer: ${browsers.join(', ')}.` : '';
    showSetupPage();
    dialog.showModal();
  } else if (snap.setupDone && dialog.open && !setupFinishing) {
    dialog.close();
  }
  if (dialog.open && setupPage === SETUP_PAGES) renderSetupSummary();
}

function showSetupPage() {
  for (const page of document.querySelectorAll('.setup-page')) page.hidden = Number(page.dataset.page) !== setupPage;
  document.querySelectorAll('.setup-steps span').forEach((dot, i) => dot.classList.toggle('on', i < setupPage));
  $('#setup-back').hidden = setupPage === 1 || setupPage === SETUP_PAGES;
  $('#setup-next').textContent = setupPage === SETUP_PAGES ? 'Start' : setupPage === 3 ? 'Finish setup' : 'Next';
  if (setupPage === SETUP_PAGES) renderSetupSummary();
}

function renderSetupSummary() {
  const used = usedPlatforms();
  $('#setup-summary').textContent = !snap.lastScanAt
    ? 'Looking for your AI chats…'
    : used.length
      ? `Found ${plural(snap.items.length, 'chat')} on ${used.map((p) => p.name).join(', ')}. More appear as you use your AI apps and websites.`
      : 'No AI chats found yet. They appear here as soon as you use an AI app or website.';
}

async function setupNext() {
  if (setupPage === 3) {
    setupFinishing = true;
    await backend.finishSetup({
      readLocal: $('#setup-local').checked,
      readHistory: $('#setup-history').checked,
      watchDownloads: $('#setup-downloads').checked,
      openAtLogin: $('#setup-login').checked,
    });
  }
  if (setupPage === SETUP_PAGES) {
    setupFinishing = false;
    $('#setup').close();
    return;
  }
  setupPage++;
  showSetupPage();
}

function wireSetup() {
  $('#setup-next').addEventListener('click', setupNext);
  $('#setup-back').addEventListener('click', () => {
    setupPage = Math.max(1, setupPage - 1);
    showSetupPage();
  });
  // Esc doesn't skip it: the app waits for your answers before reading anything.
  $('#setup').addEventListener('cancel', (event) => {
    if (!snap.setupDone || setupFinishing) event.preventDefault();
  });
  $('#setup-privacy').addEventListener('click', () => backend.openPrivacySettings());
  $('#setup-ext-folder').addEventListener('click', () => backend.openExtensionFolder());
  const copyButton = (id, text) => {
    const node = $(id);
    const label = node.lastChild.textContent;
    node.addEventListener('click', async () => {
      await backend.copyText(text);
      node.lastChild.textContent = `Copied: ${text}`;
      setTimeout(() => {
        node.lastChild.textContent = label;
      }, 2500);
    });
  };
  copyButton('#setup-copy-edge', 'edge://extensions');
  copyButton('#setup-copy-chrome', 'chrome://extensions');
}

// ---- settings ----

function renderSources() {
  $('#sources').replaceChildren(
    ...snap.sources.map((source, index) => {
      const li = el('li');
      li.append(el('span', 'source-label', source.label));
      let stateText;
      if (!source.found) stateText = source.path ? 'Not found on this computer' : 'Nothing yet';
      else stateText = plural(source.count, 'item');
      if (source.errors) stateText += ` · ${plural(source.errors, 'file')} couldn’t be read`;
      li.append(el('span', `source-state${source.errors ? ' bad' : ''}`, stateText));
      if (source.path) li.append(el('span', 'source-path mono', source.path));
      if (source.note) li.append(el('span', 'source-path', source.note));
      if (source.fields && source.fields.length) li.append(el('span', 'source-path', `Fields: ${source.fields.join(', ')}`));
      if (source.lastError && source.lastError !== source.note) li.append(el('span', 'source-path', `Last error: ${source.lastError}`));
      if (source.path && source.found) {
        const openButton = button('Open folder', { kind: 'text', iconName: 'folder', onClick: () => backend.openSource(index) });
        openButton.classList.add('source-open');
        li.append(openButton);
      }
      return li;
    }),
  );
}

function stepMark(li, number, ok) {
  li.classList.toggle('ok', ok);
  li.querySelector('.conn-step').replaceChildren(ok ? icon('check') : document.createTextNode(number));
}

function renderConnections() {
  const c = snap.connections;
  if (!c) return;

  stepMark($('#conn-local'), '1', c.local.found);
  let localText = 'Checking…';
  if (c.local.scanned) {
    localText = c.local.found
      ? `Found ${(c.local.apps || []).join(', ') || 'AI apps'} · ${plural(c.local.items, 'session')}, updating live`
      : 'Not found. That’s fine: connect the AI websites below instead.';
  }
  $('#conn-local-state').textContent = localText;

  const h = c.history || { enabled: false, browsers: [], chats: 0, platforms: [], errors: [] };
  stepMark($('#conn-history'), '2', h.enabled && h.chats > 0);
  $('#read-history').checked = h.enabled;
  let historyText;
  if (!h.enabled) historyText = 'Off.';
  else if (!c.local.scanned) historyText = 'Checking…';
  else if (!h.browsers.length) historyText = 'No browser history found on this computer.';
  else if (!h.chats) historyText = `Read ${h.browsers.join(', ')}: no AI chat pages found yet.`;
  else historyText = `Found ${plural(h.chats, 'chat')} on ${h.platforms.join(', ')} in ${h.browsers.join(', ')}.`;
  if (h.enabled && h.errors.length) historyText += ` Couldn’t read: ${h.errors.join('; ')}`;
  $('#conn-history-state').textContent = historyText;

  const ext = c.extension;
  stepMark($('#conn-web'), '3', ext.connected);
  const state = $('#conn-web-state');
  if (!ext.listening) {
    state.textContent = ext.error ? `Can't wait for the extension: ${ext.error}` : 'Starting…';
  } else if (ext.connected) {
    state.textContent = `Connected in ${ext.browser || 'your browser'} · ${plural(ext.chats, 'chat')} seen`;
  } else if (ext.everConnected) {
    state.textContent = `Not connected right now (last seen ${relative(ext.lastSeenAt)}). Is your browser open?`;
  } else {
    const waiting = el('span', 'waiting');
    waiting.append(el('span', 'spinner'), 'Waiting for the extension…');
    state.replaceChildren(waiting);
  }

  const actions = [];
  if (ext.everConnected) {
    actions.push(
      // The websites of the platforms you use (Claude and ChatGPT if none yet).
      ...(usedPlatforms().length ? usedPlatforms() : snap.platforms.filter((p) => p.extension === 'full'))
        .map((p) => button(`Open ${p.websiteName}`, { iconName: 'openInNew', onClick: () => backend.openWebsite(p.id) })),
      button('Get everything again', {
        kind: 'text',
        iconName: 'refresh',
        onClick: async () => {
          await backend.resyncExtension();
          snackbar('Asked the extension to send everything it has seen (within a minute).');
        },
      }),
    );
  }
  actions.push(button('Open extension folder', { kind: ext.everConnected ? 'text' : 'tonal', iconName: 'folder', onClick: () => backend.openExtensionFolder() }));
  $('#conn-web-actions').replaceChildren(...actions);
  $('#conn-web-setup').hidden = ext.connected;
}

// "Your AI platforms": each platform you use, and how the app knows.
function renderPlatformUsage() {
  const used = usedPlatforms();
  const rows = used.map((p) => {
    const li = el('li', `usage platform-${p.id}`);
    const head = el('div', 'usage-head');
    head.append(el('span', 'platform-dot'), el('strong', null, p.name), el('span', 'usage-count', plural(p.items, 'item')));
    li.append(head);
    for (const sign of p.signs) li.append(el('div', 'usage-sign', sign));
    if (!p.signs.length) li.append(el('div', 'usage-sign', 'Chats found'));
    return li;
  });
  const others = snap.platforms.filter((p) => !p.used).map((p) => p.name);
  if (!used.length) rows.push(el('li', 'help', 'None found yet. Use an AI app or website, turn on browser history below, or connect the extension.'));
  if (others.length) rows.push(el('li', 'help small', `Not found yet: ${others.join(', ')}.`));
  $('#platform-usage').replaceChildren(...rows);
}

function openSettings(section) {
  renderSettings();
  const dialog = $('#settings');
  if (!dialog.open) dialog.showModal();
  if (section === 'connections') $('#connections-heading').scrollIntoView({ block: 'start' });
}

// ---- Testing tools (temporary) ----

function diagnosticLine(label, value) {
  const line = el('div');
  line.append(el('strong', null, `${label}: `), value);
  return line;
}

function renderTesting() {
  const t = snap.testing || { unlocked: false };
  $('#testing-locked').hidden = t.unlocked;
  $('#testing-open').hidden = !t.unlocked;
  if (!t.unlocked) return;

  $('#t-password-state').textContent = t.customPassword
    ? 'Using your own password.'
    : 'Using the default password (it\u2019s in the README, so anyone who reads it knows it).';
  $('#t-password-default').hidden = !t.customPassword;

  $('#t-watch-downloads').checked = t.watchDownloads;
  $('#t-read-browser').checked = t.readBrowser;
  const s = t.stored;
  $('#t-stored').textContent = `Stored now: ${plural(s.exportChats, 'chat')} from the export, ${plural(s.browserChats, 'chat')} from the browser, ${plural(s.marks, 'pin/done mark')}, ${plural(s.seen, 'seen mark')}.`;

  const lines = [diagnosticLine('Browser extension', t.extension)];
  for (const source of t.localFields) lines.push(diagnosticLine(`${source.label} fields`, source.fields.join(', ')));
  if (!t.localFields.length) lines.push(diagnosticLine('AI apps on this computer', 'no session records read'));
  for (const entry of t.unmatchedAddresses || []) lines.push(diagnosticLine(`${entry.platform} pages in history not recognised as chats`, entry.paths.join('  ')));
  for (const p of t.pageProbes || []) {
    const count = (n, one, many) => `${n || 0} ${n === 1 ? one : many}`;
    const found = [
      count(p.userMessages, 'message of yours', 'messages of yours'),
      count(p.aiReplies, 'AI reply', 'AI replies'),
      p.composer ? 'the message box' : 'no message box',
      count(p.sidebarLinks, 'sidebar chat link', 'sidebar chat links'),
    ];
    lines.push(diagnosticLine(`${p.platform} page (read from the page)`, `found ${found.join(', ')}`));
  }
  if (!t.webFields.length) lines.push(diagnosticLine('Website chat fields', 'none seen yet (open claude.ai or chatgpt.com)'));
  for (const entry of t.webFields) lines.push(diagnosticLine(`${entry.platform} website chat fields`, entry.fields.join(', ')));
  if (!t.sidebarSamples.length) lines.push(diagnosticLine('Website sidebar sample', 'none seen yet'));
  for (const entry of t.sidebarSamples) {
    const sample = el('div');
    sample.append(el('strong', null, `${entry.platform} sidebar sample (text removed): `), el('pre', null, entry.sample));
    lines.push(sample);
  }
  $('#t-diagnostics').replaceChildren(...lines);
}

let resetConfirmTimer = null;
function wireTesting() {
  $('#testing-open-button').addEventListener('click', () => {
    $('#testing-password-row').hidden = false;
    $('#testing-password').focus();
  });
  const unlock = async () => {
    const input = $('#testing-password');
    const ok = await backend.unlockTesting(input.value);
    input.value = '';
    $('#testing-error').hidden = ok;
    if (!ok) {
      const row = $('#testing-password-row');
      row.classList.remove('shake');
      void row.offsetWidth; // restart the animation
      row.classList.add('shake');
      input.focus();
    }
  };
  $('#testing-unlock').addEventListener('click', unlock);
  $('#testing-password').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault(); // don't close the dialog
      unlock();
    }
  });
  $('#testing-lock').addEventListener('click', () => {
    $('#testing-password-row').hidden = true;
    $('#t-password-form').hidden = true;
    backend.lockTesting();
  });

  // Change password: type it twice, then Save (or press Enter).
  const passwordError = (text) => {
    $('#t-password-error').textContent = text || '';
    $('#t-password-error').hidden = !text;
  };
  $('#t-password-change').addEventListener('click', () => {
    const form = $('#t-password-form');
    form.hidden = !form.hidden;
    passwordError('');
    if (!form.hidden) $('#t-password-new').focus();
  });
  const savePassword = async () => {
    const first = $('#t-password-new').value;
    const second = $('#t-password-repeat').value;
    if (first !== second) return passwordError('The two passwords don\u2019t match.');
    const result = await backend.setTestingPassword(first);
    if (!result.ok) return passwordError(result.error);
    $('#t-password-new').value = '';
    $('#t-password-repeat').value = '';
    $('#t-password-form').hidden = true;
    passwordError('');
    snackbar('Testing password changed. Use it next time you unlock.');
    return undefined;
  };
  $('#t-password-save').addEventListener('click', savePassword);
  for (const id of ['#t-password-new', '#t-password-repeat']) {
    $(id).addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault(); // don't close the dialog
        savePassword();
      }
    });
  }
  $('#t-password-default').addEventListener('click', async () => {
    await backend.useDefaultTestingPassword();
    snackbar('Testing password is back to the default.');
  });
  $('#t-watch-downloads').addEventListener('change', (event) => backend.updateSettings({ watchDownloads: event.target.checked }));
  $('#t-read-browser').addEventListener('change', (event) => backend.updateSettings({ readBrowser: event.target.checked }));

  // Two clicks to delete: the first arms the button for a few seconds.
  $('#t-reset').addEventListener('click', async () => {
    const buttonEl = $('#t-reset');
    if (!buttonEl.classList.contains('confirm')) {
      buttonEl.classList.add('confirm');
      $('#t-reset-label').textContent = 'Click again to delete';
      clearTimeout(resetConfirmTimer);
      resetConfirmTimer = setTimeout(() => {
        buttonEl.classList.remove('confirm');
        $('#t-reset-label').textContent = 'Delete';
      }, 4000);
      return;
    }
    clearTimeout(resetConfirmTimer);
    buttonEl.classList.remove('confirm');
    $('#t-reset-label').textContent = 'Deleting…';
    buttonEl.disabled = true;
    try {
      await backend.resetData({ alsoExtension: $('#t-clear-extension').checked });
      view.selectedId = null;
      view.stickyId = null;
      clearDetail();
    } finally {
      buttonEl.disabled = false;
      $('#t-reset-label').textContent = 'Delete';
    }
  });
}

function renderSettings() {
  const s = snap.settings;
  renderPlatformUsage();
  renderConnections();
  renderTesting();
  for (const b of document.querySelectorAll('#mode-buttons button')) b.classList.toggle('selected', b.dataset.mode === s.themeMode);
  for (const b of document.querySelectorAll('#color-swatches button')) b.classList.toggle('selected', b.dataset.color === s.themeColor);
  $('#recent-days').value = s.recentDays;
  $('#keep-on-top').checked = s.keepOnTop;
  $('#open-at-login').checked = s.openAtLogin;
  $('#open-at-login-row').hidden = snap.system && snap.system.os === 'linux';
  $('#read-local').checked = s.readLocal;
  $('#watch-downloads').checked = s.watchDownloads;
  renderSources();
}

// ---- wiring ----

function fillStaticIcons() {
  for (const holder of document.querySelectorAll('[data-icon]')) holder.replaceWith(icon(holder.dataset.icon, holder.className));
}

function wire() {
  fillStaticIcons();
  document.documentElement.dataset.os = backend.platform || '';
  fitSearchPlaceholder();

  // Like other windows, the title dims while another window is in front.
  window.addEventListener('blur', () => document.documentElement.classList.add('inactive'));
  window.addEventListener('focus', () => document.documentElement.classList.remove('inactive'));
  darkQuery.addEventListener('change', syncTitleBar); // "System" mode follows the computer's setting

  for (const tabButton of document.querySelectorAll('#tabs button')) {
    tabButton.addEventListener('click', () => {
      view.tab = tabButton.dataset.tab;
      view.stickyId = null; // "just opened" only keeps an item on the tab you opened it from
      for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('selected', b === tabButton);
      render();
    });
  }

  document.addEventListener('click', closeMore); // clicking anywhere else closes "More"

  let searchTimer = null;
  $('#search').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const ids = await backend.search(event.target.value);
      view.searchIds = ids ? new Set(ids) : null;
      render();
    }, 200);
  });

  $('#refresh').addEventListener('click', async () => {
    const refresh = $('#refresh');
    refresh.classList.add('spinning');
    try {
      await backend.refresh();
    } finally {
      refresh.classList.remove('spinning');
    }
  });

  $('#import').addEventListener('click', async () => {
    const result = await backend.importExport();
    if (!result.ok && !result.canceled) snackbar(result.error, 'error');
  });

  $('#toggle-compact').addEventListener('click', () => backend.updateSettings({ compact: !snap.settings.compact }));

  $('#open-settings').addEventListener('click', () => openSettings());
  wireTesting();

  for (const b of document.querySelectorAll('#mode-buttons button')) {
    b.addEventListener('click', () => backend.updateSettings({ themeMode: b.dataset.mode }));
  }
  for (const b of document.querySelectorAll('#color-swatches button')) {
    b.addEventListener('click', () => backend.updateSettings({ themeColor: b.dataset.color }));
  }
  $('#recent-days').addEventListener('change', (event) => {
    const days = Number(event.target.value);
    if (days >= 1) backend.updateSettings({ recentDays: days });
  });
  $('#keep-on-top').addEventListener('change', (event) => backend.updateSettings({ keepOnTop: event.target.checked }));
  $('#watch-downloads').addEventListener('change', (event) => backend.updateSettings({ watchDownloads: event.target.checked }));
  $('#read-history').addEventListener('change', (event) => backend.updateSettings({ readHistory: event.target.checked }));
  $('#read-local').addEventListener('change', (event) => backend.updateSettings({ readLocal: event.target.checked }));
  $('#open-at-login').addEventListener('change', (event) => backend.updateSettings({ openAtLogin: event.target.checked }));
  $('#run-setup').addEventListener('click', () => {
    $('#settings').close();
    backend.runSetupAgain();
  });
  wireSetup();

  // Switching between full and compact layout re-draws rows (titles only vs. two lines).
  compactQuery.addEventListener('change', () => {
    fitSearchPlaceholder();
    render();
    if (!isCompact()) paintDetail(); // move the open details into the side panel
  });

  document.addEventListener('keydown', (event) => {
    if (event.target.closest('input, dialog')) return;
    if (event.key === 'Escape') {
      if (view.moreOpen) closeMore();
      else if (view.platform) leavePlatform(); // Esc goes back to all platforms
      return;
    }
    if (event.key === '/') {
      event.preventDefault();
      $('#search').focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = visibleItems();
    if (!items.length) return;
    const index = items.findIndex((i) => i.id === view.selectedId);
    const next = event.key === 'ArrowDown' ? Math.min(items.length - 1, index + 1) : Math.max(0, index - 1);
    open(items[next].id);
    const row = document.querySelector(`.row[data-id="${CSS.escape(items[next].id)}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  });

  backend.onSnapshot((next) => {
    applySnapshot(next);
    if ($('#settings').open) renderSettings();
  });
  backend.onNotice((notice) => snackbar(notice.text, notice.kind));

  setInterval(() => {
    renderCounts();
    renderList();
    renderStatus();
  }, MINUTE); // keep "5 minutes ago" labels fresh
}

wire();
backend.getSnapshot().then(applySnapshot);
