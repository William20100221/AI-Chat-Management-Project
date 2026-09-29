'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { matchAddress, cleanTitle, chatUrl } = require('../src/core/platforms');
const { findHistoryFiles, readHistoryFile, historyChats } = require('../src/core/browserHistory');
const geminiCli = require('../src/core/geminiCli');
const { findOtherApps, platformUsage } = require('../src/core/detect');
const { Scanner } = require('../src/core/scanner');

const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const T = Date.parse('2026-09-28T10:00:00Z');
const G1 = '6a1b2c3d-1111-4111-8111-000000000001';
const C1 = '7c1a0de0-1111-4111-8111-000000000001';

// Browsers' own table layouts (only the columns that matter here, plus a few real ones).
function chromeHistory(file, rows, { keepOpen = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`CREATE TABLE urls(id INTEGER PRIMARY KEY AUTOINCREMENT, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER DEFAULT 0 NOT NULL,
    typed_count INTEGER DEFAULT 0 NOT NULL, last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0 NOT NULL)`);
  db.exec('CREATE TABLE visits(id INTEGER PRIMARY KEY, url INTEGER NOT NULL, visit_time INTEGER NOT NULL, from_visit INTEGER, transition INTEGER DEFAULT 0 NOT NULL)');
  const chromeTime = (ms) => BigInt(ms + 11644473600000) * 1000n; // microseconds since 1601
  for (const r of rows) {
    const { lastInsertRowid } = db.prepare('INSERT INTO urls(url, title, visit_count, last_visit_time) VALUES (?, ?, ?, ?)').run(r.url, r.title, r.visits || 1, chromeTime(r.last));
    for (const at of [r.first || r.last, r.last]) db.prepare('INSERT INTO visits(url, visit_time) VALUES (?, ?)').run(lastInsertRowid, chromeTime(at));
  }
  if (!keepOpen) db.close();
  return db;
}

function firefoxHistory(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, rev_host LONGVARCHAR, visit_count INTEGER DEFAULT 0,
    hidden INTEGER DEFAULT 0 NOT NULL, typed INTEGER DEFAULT 0 NOT NULL, frecency INTEGER DEFAULT -1 NOT NULL, last_visit_date INTEGER)`);
  db.exec('CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, from_visit INTEGER, place_id INTEGER, visit_date INTEGER, visit_type INTEGER, session INTEGER)');
  for (const r of rows) {
    const { lastInsertRowid } = db.prepare('INSERT INTO moz_places(url, title, visit_count, last_visit_date) VALUES (?, ?, ?, ?)').run(r.url, r.title, r.visits || 1, r.last * 1000);
    db.prepare('INSERT INTO moz_historyvisits(place_id, visit_date) VALUES (?, ?)').run(lastInsertRowid, (r.first || r.last) * 1000);
  }
  db.close();
}

function safariHistory(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE history_items (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE, domain_expansion TEXT NULL, visit_count INTEGER NOT NULL)');
  db.exec('CREATE TABLE history_visits (id INTEGER PRIMARY KEY AUTOINCREMENT, history_item INTEGER NOT NULL, visit_time REAL NOT NULL, title TEXT NULL)');
  for (const r of rows) {
    const { lastInsertRowid } = db.prepare('INSERT INTO history_items(url, visit_count) VALUES (?, ?)').run(r.url, r.visits || 1);
    db.prepare('INSERT INTO history_visits(history_item, visit_time, title) VALUES (?, ?, ?)').run(lastInsertRowid, r.last / 1000 - 978307200, r.title);
  }
  db.close();
}

test('platforms: chat pages on AI websites, and their titles', () => {
  assert.deepEqual(matchAddress(`https://claude.ai/chat/${G1.toUpperCase()}`), { platform: 'claude', chatId: G1 });
  assert.deepEqual(matchAddress('https://claude.ai/recents'), { platform: 'claude', chatId: null });
  assert.deepEqual(matchAddress(`https://chatgpt.com/g/g-p-67abc-school/c/${G1}?model=gpt-5`), { platform: 'chatgpt', chatId: G1 });
  assert.deepEqual(matchAddress('https://gemini.google.com/u/1/app/3f1a2b4c5d6e7f80'), { platform: 'gemini', chatId: '3f1a2b4c5d6e7f80' });
  assert.deepEqual(matchAddress('https://copilot.microsoft.com/chats/Xy7_aBcD9eFg'), { platform: 'copilot', chatId: 'Xy7_aBcD9eFg' });
  assert.deepEqual(matchAddress('https://www.perplexity.ai/search/why-is-the-sky-blue-AbC.dEf_12'), { platform: 'perplexity', chatId: 'why-is-the-sky-blue-AbC.dEf_12' });
  assert.deepEqual(matchAddress(`https://chat.deepseek.com/a/chat/s/${G1}`), { platform: 'deepseek', chatId: G1 });
  assert.deepEqual(matchAddress(`https://grok.com/c/${G1}`), { platform: 'grok', chatId: G1 });
  assert.deepEqual(matchAddress('https://x.com/i/grok?conversation=1834567890123456789'), { platform: 'grok', chatId: '1834567890123456789' });
  assert.deepEqual(matchAddress(`https://chat.mistral.ai/chat/${G1}`), { platform: 'mistral', chatId: G1 });
  assert.equal(matchAddress('https://www.youtube.com/watch?v=x'), null);
  assert.equal(matchAddress('https://claude.ai.evil.com/chat/x'), null);

  assert.equal(cleanTitle('claude', 'Physics homework - Claude'), 'Physics homework');
  assert.equal(cleanTitle('chatgpt', 'ChatGPT - Essay outline'), 'Essay outline');
  assert.equal(cleanTitle('chatgpt', 'ChatGPT'), null);
  assert.equal(cleanTitle('gemini', 'Google Gemini'), null, 'Gemini’s tabs don’t name the chat');
  assert.equal(cleanTitle('perplexity', 'why is the sky blue | Perplexity'), 'why is the sky blue');
  assert.equal(cleanTitle('deepseek', 'DeepSeek - Into the Unknown'), null);
  assert.equal(chatUrl('gemini', '3f1a2b4c5d6e7f80'), 'https://gemini.google.com/app/3f1a2b4c5d6e7f80');
});

test('browser history: finds Edge, Chrome, Firefox (Windows) and Safari (Mac), and reads only AI chat pages', async () => {
  const home = tmpDir('acm-hist-');
  const local = path.join(home, 'AppData', 'Local');
  const roaming = path.join(home, 'AppData', 'Roaming');
  const edge = path.join(local, 'Microsoft', 'Edge', 'User Data');
  fs.mkdirSync(edge, { recursive: true });
  fs.writeFileSync(path.join(edge, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Personal' }, 'Profile 1': { name: 'School' } } } }));
  // Edge is running: its newest rows are still only in the -wal file.
  const open = chromeHistory(path.join(edge, 'Default', 'History'), [
    { url: 'https://gemini.google.com/app/3f1a2b4c5d6e7f80', title: 'Google Gemini', first: T - 86400e3, last: T },
    { url: `https://chatgpt.com/c/${G1}`, title: 'Essay outline', first: T - 3 * 86400e3, last: T - 3600e3 },
    { url: 'https://gemini.google.com/app', title: 'Google Gemini', last: T - 5e6, visits: 9 },
    { url: 'https://www.youtube.com/watch?v=private', title: 'Something private', last: T },
  ], { keepOpen: true });
  chromeHistory(path.join(edge, 'Profile 1', 'History'), [{ url: 'https://www.perplexity.ai/search/photosynthesis-steps-Qw3.rT', title: 'photosynthesis steps | Perplexity', last: T - 7200e3 }]);
  firefoxHistory(path.join(roaming, 'Mozilla', 'Firefox', 'Profiles', 'x1y2z3.default-release', 'places.sqlite'), [
    { url: 'https://gemini.google.com/app/3F1A2B4C5D6E7F80', title: 'Trip ideas - Gemini', first: T - 2 * 86400e3, last: T + 60e3 },
  ]);

  const files = findHistoryFiles({ platform: 'win32', env: { LOCALAPPDATA: local, APPDATA: roaming }, home });
  assert.deepEqual(files.map((f) => `${f.browser} (${f.profile})`).sort(), ['Firefox (default-release)', 'Microsoft Edge (Personal)', 'Microsoft Edge (School)']);

  const rows = [];
  for (const f of files) for (const row of await readHistoryFile(f)) rows.push({ ...row, browser: f.browser });
  open.close();
  assert.ok(!rows.some((r) => r.url.includes('youtube')), 'other sites are never read');
  const { chats, sites, unmatched } = historyChats(rows);
  const gemini = chats.find((c) => c.platform === 'gemini');
  assert.equal(gemini.id, 'gemini:chat:3f1a2b4c5d6e7f80');
  assert.equal(gemini.title, 'Trip ideas', 'the title from Firefox, since Edge only said "Google Gemini"');
  assert.equal(gemini.createdAt, T - 2 * 86400e3, 'first opened');
  assert.equal(gemini.updatedAt, T + 60e3, 'last opened');
  assert.deepEqual(gemini.browsers.sort(), ['Firefox', 'Microsoft Edge']);
  const gpt = chats.find((c) => c.platform === 'chatgpt');
  assert.equal(gpt.id, `chatgpt:chat:${G1}`);
  assert.equal(gpt.title, 'Essay outline');
  assert.equal(chats.find((c) => c.platform === 'perplexity').title, 'photosynthesis steps');
  assert.equal(sites.gemini.chats, 1);
  assert.equal(sites.gemini.visits, 11);
  assert.deepEqual(unmatched, {}, '/app is Gemini’s start page, not an unknown chat address');

  // Safari on a Mac
  const mac = tmpDir('acm-safari-');
  safariHistory(path.join(mac, 'Library', 'Safari', 'History.db'), [{ url: `https://chat.deepseek.com/a/chat/s/${G1}`, title: 'Proof by induction - DeepSeek', last: T }]);
  const [safari] = findHistoryFiles({ platform: 'darwin', env: {}, home: mac });
  assert.equal(safari.browser, 'Safari');
  const safariRows = await readHistoryFile(safari);
  assert.equal(safariRows[0].lastAt, T);
  assert.equal(historyChats(safariRows).chats[0].title, 'Proof by induction');
});

test('Gemini CLI: reads its sessions, with rewinds, updates and a summary as the title', async () => {
  const home = tmpDir('acm-gemini-');
  const dir = path.join(home, '.gemini', 'tmp', 'robot-arm');
  fs.mkdirSync(path.join(dir, 'chats', 'parent-session'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.project_root'), '/home/me/robot-arm\n');
  const lines = [
    { sessionId: 'sess-1', projectHash: 'abc', startTime: '2026-09-28T10:00:00Z', lastUpdated: '2026-09-28T10:00:00Z', kind: 'main' },
    { id: 'm1', timestamp: '2026-09-28T10:00:01Z', type: 'user', content: [{ text: '/model' }] },
    { id: 'm2', timestamp: '2026-09-28T10:00:02Z', type: 'user', content: [{ text: 'Wrong question' }] },
    { $rewindTo: 'm2' },
    { id: 'm3', timestamp: '2026-09-28T10:00:05Z', type: 'user', content: [{ text: 'Why does the gripper overshoot?' }] },
    { id: 'm4', timestamp: '2026-09-28T10:00:09Z', type: 'gemini', content: '', toolCalls: [{ id: 't1', name: 'read_file', status: 'executing' }] },
    { id: 'm4', timestamp: '2026-09-28T10:00:20Z', type: 'gemini', content: 'The PID gain is too high. Want me to lower it?', toolCalls: [{ id: 't1', name: 'read_file', status: 'success' }] },
    { $set: { summary: 'Gripper overshoot fix', lastUpdated: '2026-09-28T10:00:20Z' } },
  ];
  const file = path.join(dir, 'chats', 'session-2026-09-28T10-00-sess1.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  // A sub-agent's session one folder down, which isn't listed.
  fs.writeFileSync(path.join(dir, 'chats', 'parent-session', 'session-x.jsonl'), JSON.stringify({ sessionId: 'sub', projectHash: 'abc', kind: 'subagent' }));

  const found = await geminiCli.findSessionFiles(path.join(home, '.gemini'));
  assert.deepEqual(found.map((f) => [path.basename(f.file), f.project]), [['session-2026-09-28T10-00-sess1.jsonl', '/home/me/robot-arm']]);
  const s = await geminiCli.parseSession(file);
  assert.equal(s.sessionId, 'sess-1');
  assert.equal(s.title, 'Gripper overshoot fix');
  assert.deepEqual(s.questions.map((q) => q.text), ['Why does the gripper overshoot?'], 'commands and undone messages are skipped');
  assert.equal(s.lastMessage.text, 'The PID gain is too high. Want me to lower it?');
  assert.equal(s.pending, false);
  assert.equal(s.asks, true);
  assert.equal(s.updatedAt, Date.parse('2026-09-28T10:00:20Z'));

  // Mid-turn, waiting for approval to run a command
  fs.appendFileSync(file, [
    { id: 'm5', timestamp: '2026-09-28T10:01:00Z', type: 'user', content: [{ text: 'Yes, and run the tests' }] },
    { id: 'm6', timestamp: '2026-09-28T10:01:03Z', type: 'gemini', content: '', toolCalls: [{ id: 't2', name: 'run_shell_command', displayName: 'Shell: npm test', status: 'awaiting_approval' }] },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const live = await geminiCli.parseSession(file);
  assert.equal(live.pending, true);
  assert.equal(live.asking.text, 'Gemini wants to run: Shell: npm test');

  // The older one-object .json files
  const old = path.join(dir, 'chats', 'session-old.json');
  fs.writeFileSync(old, JSON.stringify({ sessionId: 'sess-0', projectHash: 'abc', startTime: '2026-09-01T10:00:00Z', lastUpdated: '2026-09-01T10:05:00Z',
    messages: [{ id: 'a', timestamp: '2026-09-01T10:00:00Z', type: 'user', content: 'Explain this repo' }, { id: 'b', timestamp: '2026-09-01T10:05:00Z', type: 'gemini', content: 'It is a robot arm controller.' }] }));
  const o = await geminiCli.parseSession(old);
  assert.equal(o.title, 'Explain this repo');
  assert.equal(o.pending, false);
});

test('detection: other AI apps, and which platforms you use and how the app knows', () => {
  const local = tmpDir('acm-apps-');
  fs.mkdirSync(path.join(local, 'Packages', 'Microsoft.Copilot_8wekyb3d8bbwe'), { recursive: true });
  assert.deepEqual(findOtherApps({ platform: 'win32', env: { LOCALAPPDATA: local }, home: local }).map((a) => a.platform), ['copilot']);

  const usage = platformUsage(
    [{ platform: 'gemini', updatedAt: T }, { platform: 'gemini', updatedAt: T - 5 }, { platform: 'claude', updatedAt: T - 9 }],
    [
      { label: 'Gemini CLI – sessions', found: true, count: 1, platform: 'gemini', kind: 'files', app: 'Gemini CLI' },
      { label: 'Microsoft Copilot app', found: true, count: 0, platform: 'copilot', kind: 'app', app: 'Microsoft Copilot app' },
      { label: 'Codex – sessions', found: false, count: 0, platform: 'chatgpt', kind: 'files', app: 'Codex' },
      { label: 'Claude Desktop app', found: true, count: 0, platform: 'claude', kind: 'app', app: 'Claude Desktop' },
      { label: 'Claude Desktop – Cowork tasks', found: true, count: 0, platform: 'claude', kind: 'files', app: 'Claude Desktop' },
      { label: 'ChatGPT app – Work and Codex chats', found: true, count: 5, platform: 'poe', kind: 'app', app: 'Some app', unit: 'chat' },
      { label: 'Browser history – Edge', kind: 'history', browser: 'Microsoft Edge', sites: { gemini: { chats: 1, visits: 4 }, deepseek: { chats: 0, visits: 2 } } },
      { label: 'Browser history – Firefox', kind: 'history', browser: 'Firefox', sites: { gemini: { chats: 2, visits: 3 } } },
    ],
  );
  assert.equal(usage.gemini.used, true);
  assert.equal(usage.gemini.items, 2);
  assert.equal(usage.gemini.lastAt, T);
  assert.deepEqual(usage.gemini.signs, ['Gemini CLI: 1 session', 'Browser history (Microsoft Edge, Firefox): 3 chats']);
  assert.deepEqual(usage.copilot.signs, ['Microsoft Copilot app is installed']);
  assert.equal(usage.copilot.used, true, 'installed counts, even with no chats yet');
  assert.equal(usage.deepseek.used, true, 'visited counts too');
  assert.equal(usage.chatgpt.used, false, 'nothing found');
  assert.equal(usage.claude.used, true, 'it has items');
  assert.deepEqual(usage.claude.signs, ['Claude Desktop is installed'], 'said once');
  assert.deepEqual(usage.poe.signs, ['Some app: 5 chats'], 'an installed app with chats says how many');
  assert.equal(usage.grok.used, false);
});

test('scanner: chats from browser history join the export and extension ones, for any platform', async () => {
  const home = tmpDir('acm-scan-hist-');
  const config = path.join(home, '.config');
  chromeHistory(path.join(config, 'google-chrome', 'Default', 'History'), [
    { url: 'https://gemini.google.com/app/3f1a2b4c5d6e7f80', title: 'Google Gemini', first: T - 86400e3, last: T },
    { url: `https://claude.ai/chat/${C1}`, title: 'Renamed in claude.ai - Claude', first: T - 9e6, last: T - 1000 },
    { url: `https://chatgpt.com/c/${G1}`, title: 'Essay outline', first: T - 3e6, last: T - 2e6 },
  ]);
  const gem = path.join(home, '.gemini', 'tmp', 'site');
  fs.mkdirSync(path.join(gem, 'chats'), { recursive: true });
  fs.writeFileSync(path.join(gem, 'chats', 'session-1.jsonl'), [
    { sessionId: 'g-1', projectHash: 'h', startTime: '2026-09-28T09:00:00Z', lastUpdated: '2026-09-28T09:01:00Z' },
    { id: 'u', timestamp: '2026-09-28T09:00:00Z', type: 'user', content: [{ text: 'Add a dark mode' }] },
    { id: 'a', timestamp: '2026-09-28T09:01:00Z', type: 'gemini', content: 'Done.' },
  ].map((l) => JSON.stringify(l)).join('\n'));

  // A Claude chat already known from the export: history adds when you last opened it.
  const exported = [{ id: `chat:${C1}`, platform: 'claude', uuid: C1, title: 'Physics homework', createdAt: T - 9e6, updatedAt: T - 8e6, questions: [{ role: 'user', text: 'What is torque?' }], firstMessage: null, lastMessage: null }];
  const scanner = new Scanner({ home, platform: 'linux', env: {} });
  const { items, sources } = await scanner.scan(exported);
  const byId = new Map(items.map((i) => [i.id, i]));

  const gemini = byId.get('gemini:chat:3f1a2b4c5d6e7f80');
  assert.equal(gemini.platform, 'gemini');
  assert.equal(gemini.source, 'chat');
  assert.equal(gemini.title, 'Untitled Gemini chat');
  assert.equal(gemini.untitled, true);
  assert.equal(gemini.url, 'https://gemini.google.com/app/3f1a2b4c5d6e7f80');
  assert.deepEqual(gemini.seenIn, ['Google Chrome']);
  assert.equal(gemini.updatedAt, T);

  const claude = byId.get(`chat:${C1}`);
  assert.equal(claude.title, 'Physics homework', 'the export’s title stays');
  assert.equal(claude.questions.length, 1, 'and its messages');
  assert.equal(claude.updatedAt, T - 1000, 'opened more recently than the export says');
  assert.equal(claude.lastOpenedAt, T - 1000);

  assert.equal(byId.get(`chatgpt:chat:${G1}`).title, 'Essay outline');
  const cli = byId.get('gemini:cli:g-1');
  assert.equal(cli.source, 'cli');
  assert.equal(cli.title, 'Add a dark mode');
  assert.equal(cli.resumeCommand, 'gemini --resume g-1');

  const chrome = sources.find((s) => s.kind === 'history');
  assert.equal(chrome.label, 'Browser history – Google Chrome (Default)');
  assert.equal(chrome.count, 3);
  assert.deepEqual(Object.keys(chrome.sites).sort(), ['chatgpt', 'claude', 'gemini']);
  const usage = platformUsage(items, sources);
  assert.deepEqual(Object.keys(usage).filter((id) => usage[id].used).sort(), ['chatgpt', 'claude', 'gemini']);

  // History read again within two minutes: the saved copy is used, unless forced (Refresh).
  const before = scanner.historyCache.get(chrome.path).readAt;
  await scanner.scan(exported);
  assert.equal(scanner.historyCache.get(chrome.path).readAt, before);

  // Turned off in Settings: no history chats.
  const off = await new Scanner({ home, platform: 'linux', env: {} }).scan([], { history: false });
  assert.ok(!off.items.some((i) => i.source === 'chat'));
  assert.ok(off.sources.some((s) => s.label === 'Browser history' && s.note === 'Turned off in Settings'));
});
