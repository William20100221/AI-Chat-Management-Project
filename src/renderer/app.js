'use strict';

// Everything shown here comes from window.api (see preload.js). Text from chats is only ever
// inserted with textContent, never as HTML.

const backend = window.api; // "api" itself is taken: the bridge defines window.api as a global

const SOURCE_NAMES = { chat: 'Chat', cowork: 'Cowork', code: 'Code' };
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const view = { state: 'working', source: 'any', searchIds: null, selectedId: null };
let snap = { items: [], sources: [], settings: { workingDays: 7, watchDownloads: true }, lastImport: null, lastScanAt: null };
let detailKey = null;

const $ = (selector) => document.querySelector(selector);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function svg(pathData, className) {
  const ns = 'http://www.w3.org/2000/svg';
  const node = document.createElementNS(ns, 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('aria-hidden', 'true');
  if (className) node.setAttribute('class', className);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', pathData);
  node.appendChild(path);
  return node;
}

const PIN_PATH = 'M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6zM12 15v5';

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

function dateText(ms) {
  return ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
}

function dateTimeText(ms) {
  return ms
    ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '—';
}

function groupLabel(ms) {
  if (!ms) return 'No date';
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  if (ms >= startOfToday) return 'Today';
  if (ms >= startOfToday - DAY) return 'Yesterday';
  if (ms >= startOfToday - 6 * DAY) return 'Earlier this week';
  if (ms >= startOfToday - 29 * DAY) return 'Earlier this month';
  return 'Older';
}

// ---- list ----

function matchesFilters(item) {
  if (view.source !== 'any' && item.source !== view.source) return false;
  if (view.searchIds && !view.searchIds.has(item.id)) return false;
  return true;
}

function visibleItems() {
  return snap.items
    .filter(matchesFilters)
    .filter((item) => view.state === 'all' || item.state === view.state)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function renderCounts() {
  const base = snap.items.filter(matchesFilters);
  const counts = {
    working: base.filter((i) => i.state === 'working').length,
    all: base.length,
    done: base.filter((i) => i.state === 'done').length,
  };
  for (const node of document.querySelectorAll('[data-count]')) node.textContent = counts[node.dataset.count];
}

function renderBanner() {
  const banner = $('#banner');
  banner.replaceChildren();
  const showsChats = view.source === 'any' || view.source === 'chat';
  if (!showsChats) {
    banner.hidden = true;
    return;
  }
  if (!snap.lastImport) {
    banner.append(
      el('strong', null, 'Your normal chats aren’t here yet. '),
      'In Claude, go to Settings → Privacy → Export data, then download the zip from the email. ',
      snap.settings.watchDownloads
        ? 'This app will pick it up from Downloads by itself.'
        : 'Then use “Import chat export”.',
    );
    banner.hidden = false;
    return;
  }
  const age = Date.now() - snap.lastImport.importedAt;
  if (age > 7 * DAY) {
    banner.append(
      el('strong', null, `Chats were last imported ${relative(snap.lastImport.importedAt)}. `),
      'New chats show up after your next export (Settings → Privacy → Export data).',
    );
    banner.hidden = false;
    return;
  }
  banner.hidden = true;
}

function renderEmpty(count) {
  const empty = $('#empty');
  empty.hidden = count > 0;
  if (count > 0) return;
  if (view.searchIds) empty.textContent = 'Nothing matches your search.';
  else if (view.state === 'working') empty.textContent = `Nothing active in the last ${plural(snap.settings.workingDays, 'day')}. Pin something to keep it here.`;
  else if (view.state === 'done') empty.textContent = 'Nothing marked as done yet.';
  else empty.textContent = 'No chats or sessions found yet. Check Settings → Sources.';
}

function rowFor(item) {
  const row = el('li', `row state-${item.state}`);
  row.dataset.id = item.id;
  if (item.id === view.selectedId) row.classList.add('selected');
  row.setAttribute('role', 'button');
  row.tabIndex = -1;

  const main = el('div', 'row-main');
  main.append(el('div', 'row-title', item.title));
  const meta = el('div', 'row-meta');
  meta.append(el('span', `badge ${item.source}`, SOURCE_NAMES[item.source]));
  if (item.mark === 'pinned') meta.append(svg(PIN_PATH, 'pin'));
  if (item.questionCount) meta.append(el('span', null, plural(item.questionCount, 'question')));
  main.append(meta);

  row.append(el('span', 'state-dot'), main, el('span', 'row-time', relative(item.updatedAt)));
  row.addEventListener('click', () => select(item.id));
  return row;
}

function renderList() {
  const list = $('#list');
  const items = visibleItems();
  const nodes = [];
  let lastGroup = null;
  for (const item of items) {
    const group = groupLabel(item.updatedAt);
    if (group !== lastGroup) {
      nodes.push(el('li', 'group-label', group));
      lastGroup = group;
    }
    nodes.push(rowFor(item));
  }
  list.replaceChildren(...nodes);
  renderEmpty(items.length);
}

function renderStatus() {
  const bySource = { chat: 0, cowork: 0, code: 0 };
  for (const item of snap.items) bySource[item.source]++;
  const parts = [
    `${plural(bySource.cowork, 'Cowork task')}`,
    `${plural(bySource.code, 'Code session')}`,
    snap.lastImport
      ? `${plural(bySource.chat, 'chat')} (export from ${dateText(snap.lastImport.fileMtime || snap.lastImport.importedAt)})`
      : 'chats: no export imported yet',
  ];
  if (snap.lastScanAt) parts.push(`checked ${relative(snap.lastScanAt)}`);
  $('#status-text').textContent = parts.join('  ·  ');
}

function render() {
  renderCounts();
  renderBanner();
  renderList();
  renderStatus();
}

// ---- detail ----

function messageBox(label, message) {
  const box = el('div', 'message');
  const who = message.role === 'user' ? 'You' : 'Claude';
  box.append(el('span', 'who', `${who} · ${label}${message.at ? ` · ${dateTimeText(message.at)}` : ''}`));
  box.append(document.createTextNode(message.text));
  return box;
}

function stateLine(item) {
  if (item.mark === 'pinned') return 'Pinned as working (stays until you change it).';
  if (item.mark === 'done') return 'Marked as done.';
  if (item.state === 'done') return 'Archived in Claude.';
  if (item.state === 'working') return `Working: active in the last ${plural(snap.settings.workingDays, 'day')}.`;
  return `Not active in the last ${plural(snap.settings.workingDays, 'day')}.`;
}

function actionButton(label, onClick, active) {
  const button = el('button', `button small${active ? ' active' : ''}`, label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function renderDetail(detail) {
  const item = snap.items.find((i) => i.id === detail.id);
  const pane = $('#detail');
  const nodes = [];

  nodes.push(el('h2', 'detail-title', detail.title));
  const meta = el('div', 'detail-meta');
  meta.append(
    el('span', `badge ${detail.source}`, SOURCE_NAMES[detail.source]),
    el('span', null, `Started ${dateText(detail.createdAt)}`),
    el('span', null, `Last active ${relative(detail.updatedAt)}`),
  );
  nodes.push(meta);

  if (item) {
    const actions = el('div', 'actions');
    actions.append(
      actionButton(item.mark === 'pinned' ? 'Pinned as working' : 'Pin as working', () => mark(item.id, item.mark === 'pinned' ? 'auto' : 'pinned'), item.mark === 'pinned'),
      actionButton(item.mark === 'done' ? 'Marked done' : 'Mark done', () => mark(item.id, item.mark === 'done' ? 'auto' : 'done'), item.mark === 'done'),
    );
    if (detail.canOpenChat) actions.append(actionButton('Open in Claude', () => backend.openChat(detail.id)));
    if (detail.canOpenFolder) actions.append(actionButton('Open folder', () => backend.openFolder(detail.id)));
    if (detail.resumeCommand) {
      actions.append(actionButton('Copy resume command', async () => {
        await backend.copyResume(detail.id);
        toast(`Copied: ${detail.resumeCommand}`);
      }));
    }
    nodes.push(actions, el('p', 'state-line', stateLine(item)));
  }

  if (detail.folder) {
    nodes.push(el('div', 'section-label', 'Folder'), el('div', 'mono', detail.folder));
  }

  if (detail.firstMessage) {
    nodes.push(el('div', 'section-label', 'First message'), messageBox('first', detail.firstMessage));
  }
  const last = detail.lastMessage;
  const sameAsFirst = last && detail.firstMessage && last.text === detail.firstMessage.text && last.at === detail.firstMessage.at;
  if (last && !sameAsFirst) {
    nodes.push(el('div', 'section-label', 'Last message'), messageBox('latest', last));
  }

  if (detail.questions.length) {
    nodes.push(el('div', 'section-label', `Your questions (${detail.questions.length})`));
    const list = el('ol', 'questions');
    const LIMIT = 10;
    const addQuestion = (q) => {
      const li = el('li');
      li.append(document.createTextNode(q.text));
      if (q.at) li.append(el('span', 'when', dateTimeText(q.at)));
      list.append(li);
    };
    detail.questions.slice(0, LIMIT).forEach(addQuestion);
    nodes.push(list);
    if (detail.questions.length > LIMIT) {
      const more = el('button', 'link-button', `Show all ${detail.questions.length}`);
      more.type = 'button';
      more.addEventListener('click', () => {
        detail.questions.slice(LIMIT).forEach(addQuestion);
        more.remove();
      });
      nodes.push(more);
    }
  } else if (!detail.firstMessage) {
    nodes.push(el('p', 'state-line', 'No messages could be read for this one.'));
  }

  pane.replaceChildren(...nodes);
}

async function showDetail(id) {
  try {
    const detail = await backend.getDetail(id);
    if (view.selectedId === id) renderDetail(detail);
  } catch {
    clearDetail();
  }
}

function clearDetail() {
  detailKey = null;
  const placeholder = el('div', 'detail-placeholder');
  placeholder.append(el('p', null, 'Select a chat to see what it was about.'));
  $('#detail').replaceChildren(placeholder);
}

function select(id) {
  view.selectedId = id;
  for (const row of document.querySelectorAll('.row')) row.classList.toggle('selected', row.dataset.id === id);
  const item = snap.items.find((i) => i.id === id);
  detailKey = item ? `${item.id}|${item.updatedAt}|${item.mark}|${item.state}` : null;
  showDetail(id);
}

async function mark(id, value) {
  await backend.mark(id, value);
}

// ---- snapshot updates ----

function applySnapshot(next) {
  snap = next;
  render();
  if (!view.selectedId) return;
  const item = snap.items.find((i) => i.id === view.selectedId);
  if (!item) {
    view.selectedId = null;
    clearDetail();
    return;
  }
  const key = `${item.id}|${item.updatedAt}|${item.mark}|${item.state}`;
  if (key !== detailKey) {
    detailKey = key;
    showDetail(item.id);
  }
}

// ---- toast ----

let toastTimer = null;
function toast(text, kind = 'ok') {
  const node = $('#toast');
  node.textContent = text;
  node.className = `toast${kind === 'error' ? ' error' : ''}`;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 4000);
}

// ---- settings ----

function renderSources() {
  const list = $('#sources');
  list.replaceChildren(
    ...snap.sources.map((source, index) => {
      const li = el('li');
      li.append(el('span', 'source-label', source.label));
      let stateText;
      if (!source.found) stateText = source.path ? 'Not found on this computer' : 'Nothing imported yet';
      else stateText = plural(source.count, 'item');
      if (source.errors) stateText += ` · ${plural(source.errors, 'file')} couldn’t be read`;
      li.append(el('span', `source-state${source.errors ? ' bad' : ''}`, stateText));
      if (source.path) {
        li.append(el('span', 'source-path mono', source.path));
        if (source.found) {
          const open = el('button', 'link-button source-open', 'Open folder');
          open.type = 'button';
          open.addEventListener('click', () => backend.openSource(index));
          li.append(open);
        }
      }
      if (source.lastError) li.append(el('span', 'source-path', `Last error: ${source.lastError}`));
      return li;
    }),
  );
}

function openSettings() {
  $('#working-days').value = snap.settings.workingDays;
  $('#watch-downloads').checked = snap.settings.watchDownloads;
  renderSources();
  $('#settings').showModal();
}

// ---- wiring ----

function wire() {
  for (const button of document.querySelectorAll('#state-tabs button')) {
    button.addEventListener('click', () => {
      view.state = button.dataset.state;
      for (const b of document.querySelectorAll('#state-tabs button')) b.classList.toggle('active', b === button);
      render();
    });
  }

  for (const button of document.querySelectorAll('#source-chips button')) {
    button.addEventListener('click', () => {
      view.source = button.dataset.source;
      for (const b of document.querySelectorAll('#source-chips button')) b.classList.toggle('active', b === button);
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
    const button = $('#refresh');
    button.classList.add('spinning');
    try {
      await backend.refresh();
    } finally {
      button.classList.remove('spinning');
    }
  });

  $('#import').addEventListener('click', async () => {
    const result = await backend.importExport();
    if (!result.ok && !result.canceled) toast(result.error, 'error');
  });

  $('#open-settings').addEventListener('click', openSettings);

  $('#working-days').addEventListener('change', (event) => {
    const days = Number(event.target.value);
    if (days >= 1) backend.updateSettings({ workingDays: days });
  });
  $('#watch-downloads').addEventListener('change', (event) => {
    backend.updateSettings({ watchDownloads: event.target.checked });
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
    select(items[next].id);
    const row = document.querySelector(`.row[data-id="${CSS.escape(items[next].id)}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  });

  backend.onSnapshot((next) => {
    applySnapshot(next);
    if ($('#settings').open) renderSources();
  });
  backend.onNotice((notice) => toast(notice.text, notice.kind));

  setInterval(render, MINUTE); // keep "5 minutes ago" labels fresh
}

wire();
backend.getSnapshot().then(applySnapshot);
