'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { findChatGPTApps, readThreads, findStateDb } = require('../src/core/chatgptApp');
const { threadKind, isBackgroundThread, readSessionIndex, parseRollout } = require('../src/core/codex');
const { Scanner } = require('../src/core/scanner');

const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const WORK = '019a0000-0000-7000-8000-00000000000a';
const CODEX = '019a0000-0000-7000-8000-00000000000b';
const HELPER = '019a0000-0000-7000-8000-00000000000c';
const LIST_ONLY = '019a0000-0000-7000-8000-00000000000d';
const OLD = '019a0000-0000-7000-8000-00000000000e';
const T = Date.parse('2026-09-29T10:00:00Z');

// The columns the ChatGPT app's threads table has (codex-rs/state/migrations, up to 0058).
const THREADS_TABLE = `CREATE TABLE threads (
  id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  source TEXT NOT NULL, model_provider TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL,
  sandbox_policy TEXT NOT NULL, approval_mode TEXT NOT NULL, tokens_used INTEGER NOT NULL DEFAULT 0,
  has_user_event INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER,
  cli_version TEXT NOT NULL DEFAULT '', first_user_message TEXT NOT NULL DEFAULT '', model TEXT,
  created_at_ms INTEGER, updated_at_ms INTEGER, thread_source TEXT, preview TEXT NOT NULL DEFAULT '',
  recency_at INTEGER NOT NULL DEFAULT 0, recency_at_ms INTEGER NOT NULL DEFAULT 0, name TEXT,
  is_pinned INTEGER NOT NULL DEFAULT 0, originator TEXT)`;

function addThread(db, t) {
  db.prepare(`INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
      sandbox_policy, approval_mode, first_user_message, created_at_ms, updated_at_ms, recency_at_ms, thread_source,
      preview, name, archived, is_pinned, originator)
    VALUES (?, ?, ?, ?, ?, 'openai', ?, ?, 'workspace-write', 'on-request', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    t.id, t.rollout || '', Math.floor(t.at / 1000), Math.floor(t.at / 1000), t.source || 'vscode', t.cwd || '/work',
    t.title || '', t.first || '', t.at, t.at, t.at, t.threadSource || null, t.preview === undefined ? t.first || '' : t.preview,
    t.name || null, t.archived ? 1 : 0, t.pinned ? 1 : 0, t.originator || null,
  );
}

function writeRollout(codexHome, id, lines, folder = path.join('sessions', '2026', '09', '29')) {
  const dir = path.join(codexHome, folder);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-29T10-00-00-${id}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

const meta = (id, extra = {}) => ({ timestamp: '2026-09-29T10:00:00Z', type: 'session_meta', payload: { id, cwd: '/work', ...extra } });
const ask = (text, at = '2026-09-29T10:00:02Z') => ({ timestamp: at, type: 'event_msg', payload: { type: 'user_message', message: text } });
const done = (text, at = '2026-09-29T10:01:00Z') => ({ timestamp: at, type: 'event_msg', payload: { type: 'task_complete', last_agent_message: text } });

test('ChatGPT app: found on Windows (Store packages) and on a Mac', () => {
  const local = tmpDir('acm-lad-');
  fs.mkdirSync(path.join(local, 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0'), { recursive: true });
  fs.mkdirSync(path.join(local, 'Packages', 'OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0'), { recursive: true });
  fs.mkdirSync(path.join(local, 'Packages', 'Claude_pzs8sxrjxfjjc'), { recursive: true });
  const win = findChatGPTApps({ platform: 'win32', env: { LOCALAPPDATA: local }, home: local });
  assert.deepEqual(win.map((a) => [a.kind, path.basename(a.path)]), [
    ['current', 'OpenAI.Codex_2p2nqsd0c76g0'],
    ['classic', 'OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0'],
  ]);
  assert.deepEqual(findChatGPTApps({ platform: 'win32', env: { LOCALAPPDATA: tmpDir('acm-empty-') }, home: '/nowhere' }), []);

  const home = tmpDir('acm-mac-');
  const plist = (id) => `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>`;
  fs.mkdirSync(path.join(home, 'Applications', 'ChatGPT.app', 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(home, 'Applications', 'ChatGPT.app', 'Contents', 'Info.plist'), plist('com.openai.codex'));
  let mac = findChatGPTApps({ platform: 'darwin', env: {}, home });
  assert.equal(mac.find((a) => a.kind === 'current').path, path.join(home, 'Applications', 'ChatGPT.app'));
  fs.writeFileSync(path.join(home, 'Applications', 'ChatGPT.app', 'Contents', 'Info.plist'), plist('com.openai.chat'));
  mac = findChatGPTApps({ platform: 'darwin', env: {}, home });
  assert.equal(mac.find((a) => a.kind === 'classic').path, path.join(home, 'Applications', 'ChatGPT.app'), 'the old app is Classic');
});

test('ChatGPT app: Work vs Codex, and helper threads it hides', () => {
  assert.equal(threadKind('codex_work_desktop'), 'work');
  assert.equal(threadKind('codex_work_web'), 'work');
  assert.equal(threadKind('Codex Desktop'), 'codex');
  assert.equal(threadKind('codex_cli_rs'), 'codex');
  assert.equal(threadKind(null), 'codex');
  assert.equal(isBackgroundThread({ source: '{"subagent":{"other":"guardian"}}' }), true);
  assert.equal(isBackgroundThread({ source: { subagent: { thread_spawn: {} } } }), true);
  assert.equal(isBackgroundThread({ source: 'vscode', threadSource: 'memory_consolidation' }), true);
  assert.equal(isBackgroundThread({ source: 'vscode', threadSource: 'user' }), false);
  assert.equal(isBackgroundThread({ source: 'cli' }), false);
});

test('ChatGPT app: reads its chat list while the app has it open', async () => {
  const dir = tmpDir('acm-state-');
  const file = path.join(dir, 'state_5.sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(THREADS_TABLE);
  addThread(db, { id: WORK.toUpperCase(), at: T, title: 'Trip plan', first: 'Plan a 3-day trip to Kyoto', originator: 'codex_work_desktop', pinned: true });
  addThread(db, { id: CODEX, at: Math.floor(T / 1000), title: 'x', first: 'x', archived: true }); // seconds, archived
  // The connection stays open, like the running app: the rows are still only in the -wal file.
  assert.ok(fs.existsSync(`${file}-wal`));

  const found = await findStateDb(dir, { env: {} });
  assert.equal(found.file, file);
  const threads = await readThreads(file);
  const work = threads.find((t) => t.id === WORK);
  assert.ok(work, 'ids are lower-cased; rows in the -wal file are read');
  assert.equal(work.originator, 'codex_work_desktop');
  assert.equal(work.firstUserMessage, 'Plan a 3-day trip to Kyoto');
  assert.equal(work.pinned, true);
  assert.equal(work.createdAt, T);
  const codex = threads.find((t) => t.id === CODEX);
  assert.equal(codex.archived, true);
  assert.equal(codex.createdAt, Math.floor(T / 1000) * 1000, 'seconds become milliseconds');
  assert.ok(fs.existsSync(file), 'the original is left alone');
  db.close();

  // an older table without the newer columns still works
  const oldFile = path.join(tmpDir('acm-state-old-'), 'state_5.sqlite');
  const old = new DatabaseSync(oldFile);
  old.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, cwd TEXT, title TEXT, archived INTEGER)");
  old.prepare("INSERT INTO threads VALUES (?, '', ?, ?, 'cli', '/x', 'Old title', 0)").run(OLD, 1790000000, 1790000100);
  old.close();
  const [row] = await readThreads(oldFile);
  assert.equal(row.title, 'Old title');
  assert.equal(row.updatedAt, 1790000100000);

  await assert.rejects(readThreads(path.join(tmpDir('acm-state-none-'), 'nothing.sqlite')));
});

test('ChatGPT app: names you gave chats (session_index.jsonl), newest wins', async () => {
  const file = path.join(tmpDir('acm-index-'), 'session_index.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ id: CODEX, thread_name: 'First name', updated_at: '2026-09-29T10:00:00Z' }),
    JSON.stringify({ id: CODEX, thread_name: 'Login fix', updated_at: '2026-09-29T11:00:00Z' }),
    '{"id": "half-writ',
  ].join('\n'));
  const names = await readSessionIndex(file);
  assert.equal(names.get(CODEX), 'Login fix');
  assert.equal((await readSessionIndex(path.join(os.tmpdir(), 'missing-index.jsonl'))).size, 0);
});

test('ChatGPT app: Work and Codex chats appear under ChatGPT with the app’s titles', async () => {
  const home = tmpDir('acm-gpt-home-');
  const local = path.join(home, 'AppData', 'Local');
  fs.mkdirSync(path.join(local, 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0'), { recursive: true });
  const codexHome = path.join(home, '.codex');

  writeRollout(codexHome, WORK, [meta(WORK, { originator: 'codex_work_desktop' }), ask('Plan a 3-day trip to Kyoto'), done('Here is a plan. Want hotels too?')]);
  writeRollout(codexHome, CODEX, [meta(CODEX, { originator: 'Codex Desktop' }), ask('The login button does nothing'), { timestamp: '2026-09-29T10:00:03Z', type: 'event_msg', payload: { type: 'task_started' } }]);
  writeRollout(codexHome, HELPER, [meta(HELPER, { source: { subagent: { other: 'guardian' } } }), ask('Review this command')]);
  writeRollout(codexHome, OLD, [meta(OLD, { originator: 'codex_cli_rs' }), ask('Old archived task'), done('Done.')], 'archived_sessions');

  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  db.exec(THREADS_TABLE);
  addThread(db, { id: WORK, at: T, title: 'Plan a 3-day trip to Kyoto', first: 'Plan a 3-day trip to Kyoto', name: 'Kyoto trip', originator: 'codex_work_desktop' });
  addThread(db, { id: CODEX, at: T, title: 'Fix login button', first: 'The login button does nothing', originator: 'Codex Desktop' });
  addThread(db, { id: HELPER, at: T, title: 'Guardian review', first: '', preview: 'Approval review', source: '{"subagent":{"other":"guardian"}}' });
  addThread(db, { id: LIST_ONLY, at: T + 5000, title: 'Draft the newsletter', first: 'Draft the October newsletter', originator: 'codex_work_desktop' });
  db.close();

  const env = { LOCALAPPDATA: local };
  const scanner = new Scanner({ home, platform: 'win32', env });
  const { items, sources } = await scanner.scan([]);
  const byId = new Map(items.map((i) => [i.id, i]));

  const work = byId.get(`chatgpt:codex:${WORK}`);
  assert.equal(work.platform, 'chatgpt');
  assert.equal(work.source, 'work');
  assert.equal(work.title, 'Kyoto trip', 'a name you gave it wins');
  assert.equal(work.url, `codex://threads/${WORK}`, 'opens in the ChatGPT app');
  assert.equal(work.lastMessage.text, 'Here is a plan. Want hotels too?');
  assert.equal(work.activity.asks, true);

  const codex = byId.get(`chatgpt:codex:${CODEX}`);
  assert.equal(codex.source, 'codex');
  assert.equal(codex.title, 'Fix login button', 'the app’s own title');
  assert.equal(codex.activity.pending, true, 'working right now');

  assert.equal(byId.has(`chatgpt:codex:${HELPER}`), false, 'helper threads are hidden');

  const listOnly = byId.get(`chatgpt:codex:${LIST_ONLY}`);
  assert.equal(listOnly.source, 'work');
  assert.equal(listOnly.title, 'Draft the newsletter');
  assert.deepEqual(listOnly.questions.map((q) => q.text), ['Draft the October newsletter'], 'the list’s first message stands in');

  const old = byId.get(`chatgpt:codex:${OLD}`);
  assert.equal(old.archived, true, 'archived_sessions');
  assert.equal(old.title, 'Old archived task');

  const appSource = sources.find((s) => s.label.startsWith('ChatGPT app'));
  assert.equal(appSource.found, true);
  assert.equal(appSource.count, 3, 'Work, Codex and the list-only chat');
  assert.match(appSource.note, /Chat-mode chats are kept on OpenAI/);
  const filesSource = sources.find((s) => s.label.startsWith('Codex'));
  assert.equal(filesSource.count, 1, 'the archived CLI session isn’t in the app’s list');

  // Reading the list again without changes uses the saved copy.
  const firstRead = scanner.threadsCache.readAt;
  await scanner.scan([]);
  assert.equal(scanner.threadsCache.readAt, firstRead);

  // Turned off in Settings: nothing from this computer.
  const off = await new Scanner({ home, platform: 'win32', env }).scan([], { local: false });
  assert.equal(off.items.length, 0);
});

test('ChatGPT app: without the app, the Codex CLI’s chats still show, with no app link', async () => {
  const home = tmpDir('acm-cli-home-');
  const codexHome = path.join(home, '.codex');
  writeRollout(codexHome, CODEX, [meta(CODEX, { originator: 'codex_cli_rs' }), ask('Speed up the test suite'), done('Done.')]);
  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  db.exec(THREADS_TABLE);
  addThread(db, { id: CODEX, at: T, title: 'Faster tests', first: 'Speed up the test suite', source: 'cli', originator: 'codex_cli_rs' });
  db.close();

  const { items, sources } = await new Scanner({ home, platform: 'linux', env: {} }).scan([]);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Faster tests');
  assert.equal(items[0].url, null);
  assert.equal(sources.find((s) => s.label.startsWith('ChatGPT app')).found, false);
  assert.equal(sources.find((s) => s.label.startsWith('Codex')).count, 1);
  assert.equal((await parseRollout(path.join(codexHome, 'sessions', '2026', '09', '29', `rollout-2026-09-29T10-00-00-${CODEX}.jsonl`))).kind, 'codex');
});
