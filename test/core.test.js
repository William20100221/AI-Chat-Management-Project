'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { zipSync, strToU8 } = require('fflate');

const { parseTranscript, transcriptTitle, applyEntry, emptySummary } = require('../src/core/transcript');
const { Scanner } = require('../src/core/scanner');
const { itemState, RESPONDING_TIMEOUT, DAY } = require('../src/core/status');
const { Store } = require('../src/core/store');
const { plainText } = require('../src/core/text');
const {
  readExportZip,
  readExportFile,
  parseManifest,
  exportPart,
  findCandidateFiles,
  zipEntryNames,
  mightBeClaudeExport,
} = require('../src/core/chatExport');
const { makeFakeHome, claudeExportConversations, IDS, user, assistant } = require('./fixtures');

const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// ---- transcripts ----

test('transcript: keeps real questions, skips commands, tool results, meta and half-written lines', async () => {
  const fake = makeFakeHome();
  const file = path.join(fake.projects, 'C--Users-me-PycharmProjects-eyeTrack', `${IDS.terminalCli}.jsonl`);
  const summary = await parseTranscript(file);
  assert.deepEqual(summary.questions.map((q) => q.text), ['Track the pupils with mediapipe', 'Now smooth the output']);
  assert.equal(transcriptTitle(summary), 'Eye tracker v2'); // /rename beats the automatic title
  assert.equal(summary.firstMessage.text, 'Track the pupils with mediapipe');
  assert.equal(summary.lastMessage.text, 'Now smooth the output');
  assert.equal(summary.createdAt, Date.parse('2026-09-25T05:00:00Z'));
  assert.equal(summary.updatedAt, Date.parse('2026-09-26T05:03:00Z'));
});

test('transcript: knows whether Claude is still replying', () => {
  const s = emptySummary();
  applyEntry(s, user('Fix the bug', '2026-09-28T10:00:00Z'));
  assert.equal(s.pending, true, 'your message starts a turn');

  applyEntry(s, assistant('Looking at the file', '2026-09-28T10:00:05Z', 'tool_use'));
  assert.equal(s.pending, true, 'a reply that calls a tool is not finished');

  applyEntry(s, { type: 'user', timestamp: '2026-09-28T10:00:06Z', toolUseResult: {}, message: { content: [{ type: 'tool_result', content: 'ok' }] } });
  assert.equal(s.pending, true, 'tool result: Claude carries on');
  assert.equal(s.questions.length, 1, 'tool results are not questions');

  applyEntry(s, assistant('Fixed it.', '2026-09-28T10:00:20Z'));
  assert.equal(s.pending, false);
  assert.equal(s.finishedAt, Date.parse('2026-09-28T10:00:20Z'));

  applyEntry(s, user('One more thing', '2026-09-28T10:05:00Z'));
  applyEntry(s, { type: 'user', timestamp: '2026-09-28T10:05:02Z', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
  assert.equal(s.pending, false, 'interrupting ends the turn');
  assert.equal(s.finishedAt, Date.parse('2026-09-28T10:00:20Z'), 'an interruption is not a new reply');

  applyEntry(s, { type: 'assistant', isSidechain: true, timestamp: '2026-09-28T10:06:00Z', message: { stop_reason: 'tool_use', content: [] } });
  assert.equal(s.pending, false, 'helper-agent lines are ignored');
});

test('transcript: knows when Claude is asking you something', () => {
  const s = emptySummary();
  applyEntry(s, user('Set up the project', '2026-09-28T10:00:00Z'));
  applyEntry(s, {
    type: 'assistant',
    timestamp: '2026-09-28T10:00:10Z',
    message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Which database should I use?' }] } }] },
  });
  assert.deepEqual(s.asking, { text: 'Which database should I use?', at: Date.parse('2026-09-28T10:00:10Z') });

  applyEntry(s, { type: 'user', timestamp: '2026-09-28T10:02:00Z', toolUseResult: {}, message: { content: [{ type: 'tool_result', content: 'Postgres' }] } });
  assert.equal(s.asking, null, 'answered');

  applyEntry(s, { type: 'assistant', timestamp: '2026-09-28T10:03:00Z', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'ExitPlanMode', input: {} }] } });
  assert.equal(s.asking.text, 'Claude has a plan ready for your approval');

  applyEntry(s, assistant('All set up. Want me to add tests too?', '2026-09-28T10:05:00Z'));
  assert.equal(s.asking, null);
  assert.equal(s.asks, true, 'the reply ends with a question');
  applyEntry(s, assistant('Tests added.', '2026-09-28T10:06:00Z'));
  assert.equal(s.asks, false);
});

test('text: previews drop Markdown symbols', () => {
  assert.equal(plainText('## What you need\n- **For writing:** use `pip`'), 'What you need\n• For writing: use pip');
  assert.equal(plainText('See [the docs](https://x.y) and *this*'), 'See the docs and this');
  assert.equal(plainText('2 * 3 * 4'), '2 * 3 * 4');
});

// ---- scanning ----

test('scanner: finds Cowork tasks, desktop Code sessions and terminal sessions', async () => {
  const fake = makeFakeHome();
  const { items, sources } = await new Scanner(fake.options).scan([]);
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));

  const cowork = byId[`cowork:${IDS.coworkRecord}`];
  assert.ok(cowork, 'cowork task found');
  assert.equal(cowork.title, 'Plan the robotics outreach day');
  assert.equal(cowork.questions.length, 2);
  assert.equal(cowork.lastMessage.text, 'Added lunch at 12:30.');
  assert.equal(cowork.resumeId, null);
  assert.equal(cowork.activity.pending, false);
  assert.equal(cowork.activity.finishedAt, Date.parse('2026-09-27T09:00:00Z'));

  const code = byId[`code:${IDS.codeRecord}`];
  assert.ok(code, 'desktop code session found');
  assert.equal(code.title, 'Fix drivetrain encoder');
  assert.equal(code.folder, 'C:\\FTC\\FtcRobotController');
  assert.equal(code.resumeId, IDS.codeCli);
  assert.deepEqual(code.questions.map((q) => q.text), ['Why does the encoder read zero?']);

  const terminal = byId[`code:${IDS.terminalCli}`];
  assert.ok(terminal, 'terminal session found');
  assert.equal(terminal.title, 'Eye tracker v2');
  assert.equal(terminal.activity.pending, true, 'last line is your question, so Claude is on it');

  assert.equal(byId[`code:${IDS.codeCli}`], undefined, 'desktop session is not listed twice');
  assert.equal(byId[`code:${IDS.titleOnlyCli}`], undefined, 'title-only file is skipped');
  assert.equal(items.length, 3);
  assert.ok(sources.every((s) => s.errors === 0));
  const coworkSource = sources.find((s) => s.label.includes('Cowork'));
  assert.ok(coworkSource.fields.includes('lastActivityAt'), 'record field names are reported for diagnostics');
});

test('scanner: picks up a reply as it is being written', async () => {
  const fake = makeFakeHome();
  const scanner = new Scanner(fake.options);
  await scanner.scan([]);
  const file = path.join(fake.projects, 'C--FTC-FtcRobotController', `${IDS.codeCli}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(user('And the other wheel?', '2026-09-28T03:00:00Z')) + '\n');
  let code = (await scanner.scan([])).items.find((i) => i.id === `code:${IDS.codeRecord}`);
  assert.equal(code.questions.length, 2);
  assert.equal(code.updatedAt, Date.parse('2026-09-28T03:00:00Z'));
  assert.equal(code.activity.pending, true);

  fs.appendFileSync(file, JSON.stringify(assistant('Same fix on port 1.', '2026-09-28T03:00:30Z')) + '\n');
  code = (await scanner.scan([])).items.find((i) => i.id === `code:${IDS.codeRecord}`);
  assert.equal(code.activity.pending, false);
  assert.equal(code.activity.finishedAt, Date.parse('2026-09-28T03:00:30Z'));
});

test('scanner: reports missing folders instead of failing', async () => {
  const home = tmpDir('acm-empty-');
  const { items, sources } = await new Scanner({ home, platform: 'win32', env: {} }).scan([]);
  assert.equal(items.length, 0);
  assert.ok(sources.some((s) => s.label.startsWith('Claude Code') && s.found === false));
});

// ---- states ----

test('state: replying, new reply, seen, pinned, recent, done', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  const base = { updatedAt: now - 60 * 1000 };
  const replying = { ...base, activity: { pending: true, finishedAt: now - DAY, lastWriteAt: now - 30 * 1000 } };
  const stale = { ...base, activity: { pending: true, finishedAt: null, lastWriteAt: now - RESPONDING_TIMEOUT - 1 } };
  const finished = { ...base, activity: { pending: false, finishedAt: now - 60 * 1000, lastWriteAt: now - 60 * 1000 } };
  const old = { updatedAt: now - 30 * DAY, activity: null };
  const asking = { ...base, activity: { pending: true, asking: { text: 'Which one?' }, lastWriteAt: now - 5 * 60 * 60 * 1000 } };
  assert.equal(itemState(asking, { now }), 'asking', 'waits for you with no 10-minute limit');
  assert.equal(itemState({ ...asking, activity: { ...asking.activity, lastWriteAt: now - 2 * DAY } }, { now }), 'recent', 'a day-old unanswered question is dropped');

  assert.equal(itemState(replying, { now }), 'responding');
  assert.equal(itemState(stale, { now }), 'recent', 'a turn that went quiet for 10 minutes is not "replying"');
  assert.equal(itemState(finished, { now, seenAt: 0 }), 'new-reply');
  assert.equal(itemState(finished, { now, seenAt: now - 10 * 1000 }), 'recent', 'looked at after it finished');
  assert.equal(itemState({ ...finished, claudeReadAt: now - 1000 }, { now }), 'recent', "Claude's own read time counts");
  assert.equal(itemState({ ...finished, claudeUnread: false }, { now }), 'recent');
  assert.equal(itemState({ ...base, activity: null, claudeUnread: true }, { now }), 'new-reply', "Claude's blue dot counts on its own");
  assert.equal(itemState({ ...base, activity: null, claudeUnread: true }, { now, openedAt: now }), 'recent', 'unless you opened it here since');
  assert.equal(itemState(old, { now, override: { pinned: true } }), 'pinned');
  assert.equal(itemState(old, { now }), 'older');
  assert.equal(itemState(old, { now, recentDays: 60 }), 'recent');
  assert.equal(itemState({ ...old, archived: true }, { now }), 'done');

  const doneAt = now - 10 * 60 * 1000;
  assert.equal(itemState({ updatedAt: doneAt - 1000 }, { now, override: { done: true, at: doneAt } }), 'done');
  assert.equal(itemState({ updatedAt: doneAt + 1000 }, { now, override: { done: true, at: doneAt } }), 'recent', 'something new after "done" brings it back');
});

// ---- chat export ----

function zip(files) {
  const entries = {};
  for (const [name, value] of Object.entries(files)) entries[name] = strToU8(typeof value === 'string' ? value : JSON.stringify(value));
  return Buffer.from(zipSync(entries));
}

test('chat export: reads the older single-zip export', () => {
  const chats = readExportZip(zip({ 'conversations.json': claudeExportConversations(), 'users.json': [] }));
  assert.equal(chats.length, 1, 'the empty placeholder chat is skipped');
  const [chat] = chats;
  assert.equal(chat.title, 'Becoming a developer career path');
  assert.deepEqual(chat.questions.map((q) => q.text), ['How do I become a developer?', 'What about university?']);
  assert.equal(chat.firstMessage.text, 'How do I become a developer?');
  assert.equal(chat.lastMessage.text, 'What about university?');
  assert.equal(chat.updatedAt, Date.parse('2026-09-27T21:00:00Z'));
});

test('chat export: reads newer layouts (one file per chat, JSONL, wrapped, titles only)', () => {
  const [first] = claudeExportConversations();
  const perFile = readExportZip(zip({ 'conversations/a.json': first, 'conversations/b.json': { ...first, uuid: 'b', name: 'Second' } }));
  assert.deepEqual(perFile.map((c) => c.title).sort(), ['Becoming a developer career path', 'Second']);

  const jsonl = readExportZip(zip({ 'conversations.jsonl': `${JSON.stringify(first)}\n${JSON.stringify({ ...first, uuid: 'c' })}\n` }));
  assert.equal(jsonl.length, 2);

  const wrapped = readExportZip(zip({ 'data.json': { conversations: [first] } }));
  assert.equal(wrapped.length, 1);

  const messagesKey = readExportZip(zip({ 'conversations.json': [{ id: 'd', title: 'Uses messages', created_at: '2026-09-01T00:00:00Z', messages: [{ role: 'user', content: 'hi' }] }] }));
  assert.equal(messagesKey[0].title, 'Uses messages');
  assert.equal(messagesKey[0].questions[0].text, 'hi');

  const titlesOnly = readExportZip(zip({ 'conversations_metadata.json': [{ uuid: 'e', name: 'Only a title', updated_at: '2026-09-02T00:00:00Z' }] }));
  assert.equal(titlesOnly[0].title, 'Only a title');
  assert.equal(titlesOnly[0].questions.length, 0);
});

test('chat export: ignores ChatGPT exports and unrelated zips', () => {
  assert.equal(readExportZip(zip({ 'conversations.json': [{ title: 'x', mapping: {} }] })), null);
  assert.equal(readExportZip(zip({ 'projects.json': [{ uuid: 'p', name: 'A project', created_at: '2026-01-01' }] })), null);
  assert.equal(readExportZip(zip({ 'photo.txt': 'hi' })), null);
});

test('chat export: reads the manifest from the export email', async () => {
  const manifest = {
    created_at: '2026-09-29T00:11:05.384154+00:00',
    data_files: [
      { category: 'conversations', filename: 'conversations-000.zip', export_url: 'https://claude.ai/export/org/download/abc' },
      { category: 'projects', filename: 'projects-000.zip', export_url: 'https://claude.ai/export/org/download/def' },
      { category: 'evil', filename: 'x.zip', export_url: 'https://example.com/export/steal' },
    ],
  };
  const parsed = parseManifest(manifest);
  assert.equal(parsed.files.length, 2, 'only claude.ai export links are kept');
  assert.equal(parsed.createdAt, Date.parse('2026-09-29T00:11:05.384Z'));

  const file = path.join(tmpDir('acm-manifest-'), 'manifest-123.json');
  fs.writeFileSync(file, JSON.stringify(manifest));
  const result = await readExportFile(file);
  assert.equal(result.kind, 'manifest');

  assert.equal(parseManifest({ data_files: [{ export_url: 'http://claude.ai/export/x' }] }), null, 'http links are rejected');
  assert.equal(exportPart('conversations-002.zip'), 2);
  assert.equal(exportPart('data-2026.zip'), 0);
});

test('chat export: finds new files in Downloads and peeks inside zips cheaply', async () => {
  const downloads = tmpDir('acm-dl-');
  const claudeZip = path.join(downloads, 'conversations-000.zip');
  const oldStyleZip = path.join(downloads, 'data-2026-09-28.zip');
  const otherZip = path.join(downloads, 'holiday-photos.zip');
  fs.writeFileSync(claudeZip, zip({ 'conversations.json': claudeExportConversations() }));
  fs.writeFileSync(oldStyleZip, zip({ 'conversations.json': claudeExportConversations(), 'users.json': [] }));
  fs.writeFileSync(otherZip, zip({ 'a.txt': 'a' }));
  fs.writeFileSync(path.join(downloads, 'manifest.json'), '{}');
  fs.writeFileSync(path.join(downloads, 'notes.txt'), 'not a zip');

  assert.deepEqual((await zipEntryNames(oldStyleZip)).sort(), ['conversations.json', 'users.json']);
  assert.equal(await mightBeClaudeExport(claudeZip), true);
  assert.equal(await mightBeClaudeExport(oldStyleZip), true);
  assert.equal(await mightBeClaudeExport(otherZip), false);

  const first = await findCandidateFiles(downloads, {});
  assert.deepEqual(first.map((c) => path.basename(c.file)).sort(), ['conversations-000.zip', 'data-2026-09-28.zip', 'holiday-photos.zip', 'manifest.json']);
  const seen = Object.fromEntries(first.map((c) => [c.key, true]));
  assert.deepEqual(await findCandidateFiles(downloads, seen), []);

  const result = await readExportFile(claudeZip);
  assert.equal(result.kind, 'chats');
  assert.equal(result.part, 0);
  assert.equal(result.chats.length, 1);
});

// ---- store ----

test('store: marks, seen times, settings and chat merging survive a restart', () => {
  const file = path.join(tmpDir('acm-store-'), 'state.json');
  const store = new Store(file);
  store.setMark('chat:1', 'pinned');
  store.setMark('chat:2', 'done');
  store.setMark('chat:2', 'auto');
  store.updateSettings({ recentDays: 0, themeMode: 'dark', themeColor: 'teal', compact: true });
  store.updateSettings({ themeMode: 'neon', themeColor: 'plaid' }); // ignored
  store.markSeen(['code:1']);
  store.setChats([{ id: 'chat:a' }, { id: 'chat:b' }], { file: 'conversations-000.zip' });
  store.setChats([{ id: 'chat:c' }], { file: 'conversations-001.zip' }, { merge: true });

  const reopened = new Store(file);
  assert.deepEqual(reopened.override('chat:1'), { pinned: true });
  assert.deepEqual(reopened.override('chat:2'), {});
  assert.equal(reopened.settings.recentDays, 1);
  assert.equal(reopened.settings.themeMode, 'dark');
  assert.equal(reopened.settings.themeColor, 'teal');
  assert.equal(reopened.settings.compact, true);
  assert.ok(reopened.seenAt('code:1') >= reopened.data.installedAt);
  assert.deepEqual(reopened.data.chats.map((c) => c.id), ['chat:a', 'chat:b', 'chat:c']);
  assert.equal(reopened.lastImport('claude').count, 3);
});

test('store: testing switches and "delete all stored data"', () => {
  const file = path.join(tmpDir('acm-reset-'), 'state.json');
  const store = new Store(file);
  assert.equal(store.settings.readLocal, true);
  assert.equal(store.settings.readBrowser, true);
  store.updateSettings({ readLocal: false, readBrowser: false, themeColor: 'rose' });
  store.setMark('chat:1', 'pinned');
  store.markSeen(['chat:1']);
  store.setChats([{ id: 'chat:a' }], { file: 'x.zip' });
  store.saveWindowBounds('full', { x: 1, y: 2, width: 900, height: 600 });
  store.data.web.chats.z = { id: 'chat:z' };

  store.resetData();
  const reopened = new Store(file);
  assert.deepEqual(reopened.data.overrides, {});
  assert.deepEqual(reopened.data.seen, {});
  assert.deepEqual(reopened.data.chats, []);
  assert.deepEqual(reopened.data.web.chats, {});
  assert.deepEqual(reopened.data.lastImports, {});
  assert.equal(reopened.settings.readLocal, false, 'settings stay');
  assert.equal(reopened.settings.themeColor, 'rose');
  assert.deepEqual(reopened.windowBounds('full'), { x: 1, y: 2, width: 900, height: 600 });
});

test('store: the Testing password can be changed, is hashed, and survives "delete all"', () => {
  const file = path.join(tmpDir('acm-password-'), 'state.json');
  const store = new Store(file);
  assert.equal(store.checkTestingPassword('TESTING_PASSWORD'), true, 'default password');
  assert.equal(store.checkTestingPassword('wrong'), false);
  assert.equal(store.hasCustomTestingPassword(), false);

  store.setTestingPassword('my new secret');
  const saved = fs.readFileSync(file, 'utf8');
  assert.ok(!saved.includes('my new secret'), 'never stored as text');
  let reopened = new Store(file);
  assert.equal(reopened.checkTestingPassword('my new secret'), true);
  assert.equal(reopened.checkTestingPassword('TESTING_PASSWORD'), false, 'the default stops working');
  assert.equal(reopened.hasCustomTestingPassword(), true);

  reopened.resetData();
  assert.equal(new Store(file).checkTestingPassword('my new secret'), true, 'deleting data keeps your password');

  reopened.useDefaultTestingPassword();
  reopened = new Store(file);
  assert.equal(reopened.checkTestingPassword('TESTING_PASSWORD'), true);
  assert.equal(reopened.hasCustomTestingPassword(), false);
});

test('scanner: skips Claude files on this computer when that switch is off', async () => {
  const fake = makeFakeHome();
  const { items, sources } = await new Scanner(fake.options).scan([], { local: false });
  assert.equal(items.length, 0);
  assert.ok(sources.every((s) => !s.found || !s.path));
});

test('store: upgrades settings saved by version 0.1', () => {
  const file = path.join(tmpDir('acm-old-'), 'state.json');
  fs.writeFileSync(file, JSON.stringify({ settings: { workingDays: 14, watchDownloads: false }, seenZips: { a: true }, overrides: {} }));
  const store = new Store(file);
  assert.equal(store.settings.recentDays, 14);
  assert.equal(store.settings.watchDownloads, false);
  assert.equal(store.settings.workingDays, undefined);
  assert.deepEqual(store.data.seenFiles, { a: true });
  assert.ok(store.data.installedAt > 0, 'replies from before the upgrade are not flagged as new');
});
