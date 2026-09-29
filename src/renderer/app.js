'use strict';

// Everything shown here comes from window.api (see preload.js). Text from chats is only ever
// inserted with textContent, never as HTML.

const backend = window.api; // "api" itself is taken: the bridge defines window.api as a global
const icon = window.icon;

const SOURCE_NAMES = { chat: 'Chat', cowork: 'Cowork', code: 'Code' };
const WORKING = new Set(['responding', 'new-reply', 'pinned']);
const WORKING_ORDER = { responding: 0, 'new-reply': 1, pinned: 2 };
const WORKING_GROUPS = { responding: 'Claude is replying', 'new-reply': 'New replies', pinned: 'Pinned' };
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const compactQuery = window.matchMedia('(max-width: 719px)');

const view = {
  tab: 'working',
  source: 'any',
  searchIds: null,
  selectedId: null, // full view: shown in the side panel; compact view: expanded under its row
  stickyId: null, // stays in the list after you open it, even if it no longer matches the tab
};
let snap = {
  items: [],
  sources: [],
  settings: { recentDays: 7, watchDownloads: true, themeMode: 'system', themeColor: 'indigo', compact: false, keepOnTop: false },
  lastImport: null,
  pendingExport: null,
  lastScanAt: null,
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

// ---- which items show ----

function matchesFilters(item) {
  if (view.source !== 'any' && item.source !== view.source) return false;
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
    return list.sort((a, b) => (WORKING_ORDER[a.state] ?? 3) - (WORKING_ORDER[b.state] ?? 3) || (b.updatedAt || 0) - (a.updatedAt || 0));
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
  const showsChats = view.source === 'any' || view.source === 'chat';
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
    if (ext.everConnected) {
      text.append(el('strong', null, 'The browser extension isn’t connected. '), 'Open your browser or claude.ai and it reconnects within a minute.');
    } else {
      text.append(el('strong', null, 'No Claude app found on this computer. '), 'Connect your browser to see your claude.ai chats here.');
    }
    const actions = el('div', 'banner-actions');
    actions.append(button(ext.everConnected ? 'Open claude.ai' : 'Connect', {
      kind: 'filled',
      iconName: ext.everConnected ? 'openInNew' : undefined,
      onClick: () => (ext.everConnected ? backend.openClaudeWebsite() : openSettings('connections')),
    }));
    nodes.push(text, actions);
  } else if (showsChats && !snap.items.some((i) => i.source === 'chat') && !hintDismissed()) {
    const text = el('p');
    text.append(
      el('strong', null, 'Want your claude.ai chats here too? '),
      'Connect the browser extension to see them live, or import your data export for older ones.',
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
  return Boolean(c && c.local.scanned && !c.local.found && !c.extension.connected);
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
  else if (view.tab === 'working') empty.textContent = 'Nothing needs you right now. Chats appear here while Claude is replying, when a reply is waiting for you, or when you pin them.';
  else if (view.tab === 'done') empty.textContent = 'Nothing marked as done.';
  else if (view.tab === 'recent') empty.textContent = `Nothing active in the last ${plural(snap.settings.recentDays, 'day')}.`;
  else empty.textContent = 'No chats or sessions found yet. Check Settings → Sources.';
}

function stateIndicator(item) {
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

  const avatar = el('span', `avatar ${item.source}`);
  avatar.append(icon(item.source));
  avatar.title = SOURCE_NAMES[item.source];

  const main = el('div', 'row-main');
  main.append(el('div', 'row-title', item.title));
  const support = el('div', 'row-support');
  if (item.state === 'responding') support.append(el('span', 'live', 'Claude is replying…'));
  else if (item.state === 'new-reply') support.append(el('span', 'live', 'New reply'));
  else support.append(el('span', null, SOURCE_NAMES[item.source]));
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
  const bySource = { chat: 0, cowork: 0, code: 0 };
  for (const item of snap.items) bySource[item.source]++;
  const replying = snap.items.filter((i) => i.state === 'responding').length;
  const parts = [];
  if (replying) parts.push(`${replying} replying now`);
  parts.push(plural(bySource.cowork, 'Cowork task'), plural(bySource.code, 'Code session'));
  if (bySource.chat) {
    const from = snap.lastImport ? `export ${dateText(snap.lastImport.fileMtime || snap.lastImport.importedAt)} + browser` : 'from your browser';
    parts.push(`${plural(bySource.chat, 'chat')} (${from})`);
  } else {
    parts.push('no chats yet');
  }
  const ext = snap.connections && snap.connections.extension;
  if (ext && ext.connected) parts.push(`claude.ai linked (${ext.browser || 'browser'})`);
  $('#status-text').textContent = parts.join('  ·  ');
}

function render() {
  renderCounts();
  renderBanner();
  renderListTools();
  renderList();
  renderStatus();
}

// ---- rendering: details ----

function messageBox(label, message) {
  const box = el('div', 'message');
  const who = message.role === 'user' ? 'You' : 'Claude';
  box.append(el('span', 'who', `${who} · ${label}${message.at ? ` · ${dateTimeText(message.at)}` : ''}`));
  box.append(document.createTextNode(message.text));
  return box;
}

function stateCard(item) {
  const card = el('div', 'state-card');
  if (item.state === 'responding') {
    card.classList.add('live');
    card.append(el('span', 'spinner'), 'Claude is replying right now');
  } else if (item.state === 'new-reply') {
    card.classList.add('live');
    card.append(el('span', 'dot'), 'New reply you haven’t looked at');
  } else if (item.mark === 'pinned') {
    card.append(icon('pin'), 'Pinned: stays in Working until you unpin it');
  } else if (item.mark === 'done') {
    card.append(icon('taskAlt'), 'Marked done: comes back if something new happens');
  } else if (item.state === 'done') {
    card.append(icon('taskAlt'), 'Archived in Claude');
  } else {
    return null;
  }
  return card;
}

function buildDetail(detail, item) {
  const nodes = [el('h2', 'detail-title', detail.title)];

  const meta = el('div', 'detail-meta');
  const source = el('span', `label-chip ${detail.source}`);
  source.append(icon(detail.source), SOURCE_NAMES[detail.source]);
  meta.append(source, el('span', 'label-chip', `Started ${dateText(detail.createdAt)}`), el('span', 'label-chip', `Active ${relative(detail.updatedAt)}`));
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
    if (detail.canOpenChat) actions.append(button('Open in Claude', { iconName: 'openInNew', kind: 'outlined', onClick: () => backend.openChat(detail.id) }));
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

  if (detail.firstMessage) nodes.push(el('div', 'section-label', 'First message'), messageBox('first', detail.firstMessage));
  const last = detail.lastMessage;
  const sameAsFirst = last && detail.firstMessage && last.text === detail.firstMessage.text && last.at === detail.firstMessage.at;
  if (last && !sameAsFirst) nodes.push(el('div', 'section-label', 'Last message'), messageBox('latest', last));

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
  } else if (!detail.firstMessage) {
    nodes.push(el('p', 'help', 'No messages could be read for this one.'));
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
  const selected = view.selectedId && snap.items.find((i) => i.id === view.selectedId);
  if (view.selectedId && !selected) {
    view.selectedId = null;
    view.stickyId = null;
    clearDetail();
  }
  // You're looking at it, so a reply that finishes while it's open counts as seen.
  if (selected && selected.state === 'new-reply' && document.hasFocus()) backend.markSeen([selected.id]);
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
      ? `Found · ${plural(c.local.items, 'Cowork task or Code session')}, updating live`
      : 'Not found. That’s fine: connect claude.ai below instead.';
  }
  $('#conn-local-state').textContent = localText;

  const ext = c.extension;
  stepMark($('#conn-web'), '2', ext.connected);
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
      button('Open claude.ai', { iconName: 'openInNew', onClick: () => backend.openClaudeWebsite() }),
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

function openSettings(section) {
  renderSettings();
  const dialog = $('#settings');
  if (!dialog.open) dialog.showModal();
  if (section === 'connections') $('#connections-heading').scrollIntoView({ block: 'start' });
}

function renderSettings() {
  const s = snap.settings;
  renderConnections();
  for (const b of document.querySelectorAll('#mode-buttons button')) b.classList.toggle('selected', b.dataset.mode === s.themeMode);
  for (const b of document.querySelectorAll('#color-swatches button')) b.classList.toggle('selected', b.dataset.color === s.themeColor);
  $('#recent-days').value = s.recentDays;
  $('#keep-on-top').checked = s.keepOnTop;
  $('#watch-downloads').checked = s.watchDownloads;
  renderSources();
}

// ---- wiring ----

function fillStaticIcons() {
  for (const holder of document.querySelectorAll('[data-icon]')) holder.replaceWith(icon(holder.dataset.icon, holder.className));
}

function wire() {
  fillStaticIcons();

  for (const tabButton of document.querySelectorAll('#tabs button')) {
    tabButton.addEventListener('click', () => {
      view.tab = tabButton.dataset.tab;
      view.stickyId = null; // "just opened" only keeps an item on the tab you opened it from
      for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('selected', b === tabButton);
      render();
    });
  }

  for (const chip of document.querySelectorAll('#source-chips button')) {
    chip.addEventListener('click', () => {
      view.source = chip.dataset.source;
      view.stickyId = null;
      for (const b of document.querySelectorAll('#source-chips button')) b.classList.toggle('selected', b === chip);
      render();
    });
  }

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

  // Switching between full and compact layout re-draws rows (titles only vs. two lines).
  compactQuery.addEventListener('change', () => {
    render();
    if (!isCompact()) paintDetail(); // move the open details into the side panel
  });

  document.addEventListener('keydown', (event) => {
    if (event.target.closest('input, dialog')) return;
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
