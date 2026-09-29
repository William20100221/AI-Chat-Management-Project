'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { zipSync, strToU8 } = require('fflate');

const { parseTranscript, transcriptTitle } = require('../src/core/transcript');
const { Scanner } = require('../src/core/scanner');
const { workingState, DAY } = require('../src/core/status');
const { Store } = require('../src/core/store');
const {
  readClaudeExportZip,
  readClaudeExportFile,
  findCandidateZips,
  zipEntryNames,
  mightBeClaudeExport,
} = require('../src/core/chatExport');
const { makeFakeHome, claudeExportConversations, IDS } = require('./fixtures');

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

  const code = byId[`code:${IDS.codeRecord}`];
  assert.ok(code, 'desktop code session found');
  assert.equal(code.title, 'Fix drivetrain encoder');
  assert.equal(code.folder, 'C:\\FTC\\FtcRobotController');
  assert.equal(code.resumeId, IDS.codeCli);
  assert.deepEqual(code.questions.map((q) => q.text), ['Why does the encoder read zero?']);

  const terminal = byId[`code:${IDS.terminalCli}`];
  assert.ok(terminal, 'terminal session found');
  assert.equal(terminal.title, 'Eye tracker v2');

  assert.equal(byId[`code:${IDS.codeCli}`], undefined, 'desktop session is not listed twice');
  assert.equal(byId[`code:${IDS.titleOnlyCli}`], undefined, 'title-only file is skipped');
  assert.equal(items.length, 3);
  assert.ok(sources.every((s) => s.errors === 0));
});

test('scanner: picks up changes to a transcript', async () => {
  const fake = makeFakeHome();
  const scanner = new Scanner(fake.options);
  await scanner.scan([]);
  const file = path.join(fake.projects, 'C--FTC-FtcRobotController', `${IDS.codeCli}.jsonl`);
  fs.appendFileSync(file, JSON.stringify({
    type: 'user',
    timestamp: '2026-09-28T03:00:00Z',
    message: { role: 'user', content: 'And the other wheel?' },
  }) + '\n');
  const { items } = await scanner.scan([]);
  const code = items.find((i) => i.id === `code:${IDS.codeRecord}`);
  assert.equal(code.questions.length, 2);
  assert.equal(code.updatedAt, Date.parse('2026-09-28T03:00:00Z'));
});

test('scanner: reports missing folders instead of failing', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-empty-'));
  const { items, sources } = await new Scanner({ home, platform: 'win32', env: {} }).scan([]);
  assert.equal(items.length, 0);
  assert.ok(sources.some((s) => s.label.startsWith('Claude Code') && s.found === false));
});

function exportZip(conversations, extraFiles = {}) {
  return Buffer.from(zipSync({
    'conversations.json': strToU8(JSON.stringify(conversations)),
    'users.json': strToU8('[]'),
    ...extraFiles,
  }));
}

test('chat export: reads a Claude export zip', () => {
  const chats = readClaudeExportZip(exportZip(claudeExportConversations()));
  assert.equal(chats.length, 1, 'the empty placeholder chat is skipped');
  const [chat] = chats;
  assert.equal(chat.title, 'Becoming a developer career path');
  assert.deepEqual(chat.questions.map((q) => q.text), ['How do I become a developer?', 'What about university?']);
  assert.equal(chat.firstMessage.text, 'How do I become a developer?');
  assert.equal(chat.lastMessage.text, 'What about university?');
  assert.equal(chat.updatedAt, Date.parse('2026-09-27T21:00:00Z'));
});

test('chat export: ignores a ChatGPT export and random zips', () => {
  const chatgpt = Buffer.from(zipSync({ 'conversations.json': strToU8(JSON.stringify([{ title: 'x', mapping: {} }])) }));
  assert.equal(readClaudeExportZip(chatgpt), null);
  const random = Buffer.from(zipSync({ 'photo.txt': strToU8('hi') }));
  assert.equal(readClaudeExportZip(random), null);
});

test('chat export: lists zip contents without unzipping, and finds new zips in Downloads', async () => {
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-dl-'));
  const claudeZip = path.join(downloads, 'data-2026-09-28.zip');
  const otherZip = path.join(downloads, 'holiday-photos.zip');
  fs.writeFileSync(claudeZip, exportZip(claudeExportConversations()));
  fs.writeFileSync(otherZip, Buffer.from(zipSync({ 'a.txt': strToU8('a') })));
  fs.writeFileSync(path.join(downloads, 'notes.txt'), 'not a zip');

  assert.deepEqual((await zipEntryNames(claudeZip)).sort(), ['conversations.json', 'users.json']);
  assert.equal(await mightBeClaudeExport(claudeZip), true);
  assert.equal(await mightBeClaudeExport(otherZip), false);

  const first = await findCandidateZips(downloads, {});
  assert.deepEqual(first.map((z) => path.basename(z.file)).sort(), ['data-2026-09-28.zip', 'holiday-photos.zip']);
  const seen = Object.fromEntries(first.map((z) => [z.key, true]));
  assert.deepEqual(await findCandidateZips(downloads, seen), []);

  const chats = await readClaudeExportFile(claudeZip);
  assert.equal(chats.length, 1);
});

test('working state: automatic, pinned, done and archived', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  const recent = { updatedAt: now - 2 * DAY };
  const old = { updatedAt: now - 30 * DAY };
  assert.equal(workingState(recent, {}, 7, now), 'working');
  assert.equal(workingState(old, {}, 7, now), 'idle');
  assert.equal(workingState(old, {}, 60, now), 'working');
  assert.equal(workingState(old, { pinned: true }, 7, now), 'working');
  assert.equal(workingState(recent, { done: true }, 7, now), 'done');
  assert.equal(workingState({ ...recent, archived: true }, {}, 7, now), 'done');
});

test('store: saves marks and settings, and survives a restart', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acm-store-')), 'state.json');
  const store = new Store(file);
  store.setMark('chat:1', 'pinned');
  store.setMark('chat:2', 'done');
  store.setMark('chat:2', 'auto');
  store.updateSettings({ workingDays: 0 });
  const reopened = new Store(file);
  assert.deepEqual(reopened.override('chat:1'), { pinned: true });
  assert.deepEqual(reopened.override('chat:2'), {});
  assert.equal(reopened.settings.workingDays, 1);
  assert.equal(reopened.settings.watchDownloads, true);
});
