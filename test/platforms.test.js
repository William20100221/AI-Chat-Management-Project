'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { zipSync, strToU8 } = require('fflate');

const chatgpt = require('../src/core/chatgpt');
const { readExportZip, parseConversations } = require('../src/core/chatExport');
const { parseRollout, emptySummary, applyLine } = require('../src/core/codex');
const { Scanner } = require('../src/core/scanner');
const { Store } = require('../src/core/store');
const { emptyWebState, normalizeWebState, applyWebEvents, combineChats } = require('../src/core/webChats');
const { itemState } = require('../src/core/status');
const { chatItemId, chatUrl, describePlatforms } = require('../src/core/platforms');

const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const G1 = '6a1b2c3d-1111-4111-8111-000000000001';
const G2 = '6a1b2c3d-2222-4222-8222-000000000002';
const T = Date.parse('2026-09-29T10:00:00Z');

// A ChatGPT conversation as its export (and chatgpt.com) stores it: a tree of messages,
// here with an edited first question (two branches) — only the visible branch counts.
function chatgptConversation() {
  const node = (id, parent, children, role, text, time) => ({
    id,
    parent,
    children,
    message: role ? { id, author: { role }, create_time: time, content: { content_type: 'text', parts: [text] } } : null,
  });
  return {
    id: G1,
    conversation_id: G1,
    title: 'Essay outline on renewable energy',
    create_time: 1790640000.5,
    update_time: 1790643600.25,
    current_node: 'a2',
    mapping: {
      root: node('root', null, ['sys'], null),
      sys: { id: 'sys', parent: 'root', children: ['u1-old', 'u1'], message: { author: { role: 'system' }, content: { parts: [''] }, metadata: { is_visually_hidden_from_conversation: true } } },
      'u1-old': node('u1-old', 'sys', ['a1-old'], 'user', 'Old wording of the question', 1790640001),
      'a1-old': node('a1-old', 'u1-old', [], 'assistant', 'Old answer', 1790640002),
      u1: node('u1', 'sys', ['a1'], 'user', 'Help me outline an essay on **renewable energy**', 1790640010),
      a1: node('a1', 'u1', ['u2'], 'assistant', '## Outline\n1. Intro 2. Solar 3. Wind', 1790640020),
      u2: node('u2', 'a1', ['a2'], 'user', 'Add a section on costs', 1790643500),
      a2: node('a2', 'u2', [], 'assistant', 'Added a costs section. Want sources too?', 1790643600),
    },
  };
}

test('platforms: ids, links and what the window is told', () => {
  assert.equal(chatItemId('claude', 'x'), 'chat:x', 'Claude ids stay as before');
  assert.equal(chatItemId('chatgpt', 'x'), 'chatgpt:chat:x');
  assert.equal(chatUrl('chatgpt', G1), `https://chatgpt.com/c/${G1}`);
  assert.equal(chatUrl('claude', G1), `https://claude.ai/chat/${G1}`);
  assert.equal(chatUrl('chatgpt', 'not-an-id'), null);
  const described = describePlatforms();
  assert.deepEqual(described.map((p) => p.id), ['claude', 'chatgpt']);
  assert.deepEqual(described[1].types.map((t) => t.id), ['chat', 'work', 'codex']);
});

test('ChatGPT: follows the visible branch of the message tree', () => {
  const chat = chatgpt.parseConversation(chatgptConversation());
  assert.equal(chat.id, `chatgpt:chat:${G1}`);
  assert.equal(chat.platform, 'chatgpt');
  assert.equal(chat.title, 'Essay outline on renewable energy');
  assert.deepEqual(chat.questions.map((q) => q.text), ['Help me outline an essay on renewable energy', 'Add a section on costs']);
  assert.equal(chat.firstMessage.text, 'Help me outline an essay on renewable energy');
  assert.equal(chat.lastMessage.text, 'Added a costs section. Want sources too?');
  assert.equal(chat.createdAt, 1790640000500);
  assert.equal(chat.updatedAt, 1790643600250);
});

test('ChatGPT: reads its data export zip, and the chat list chatgpt.com loads', () => {
  const buffer = Buffer.from(zipSync({
    'conversations.json': strToU8(JSON.stringify([chatgptConversation()])),
    'user.json': strToU8('{}'),
    'chat.html': strToU8('<html></html>'),
  }));
  const chats = readExportZip(buffer);
  assert.equal(chats.length, 1);
  assert.equal(chats[0].platform, 'chatgpt');

  // chatgpt.com's list: { items: [{ id, title, create_time, update_time }] } (no messages)
  const list = parseConversations({ items: [
    { id: G1, title: 'Essay outline on renewable energy', create_time: '2026-09-29T08:00:00.000Z', update_time: '2026-09-29T09:00:00.000Z' },
    { id: G2, title: 'Python homework help', create_time: '2026-09-28T08:00:00.000Z', update_time: '2026-09-28T08:30:00.000Z', is_archived: true },
  ], total: 2 });
  assert.deepEqual(list.map((c) => c.title), ['Essay outline on renewable energy', 'Python homework help']);
  assert.equal(list[1].archived, true);
  assert.ok(list.every((c) => c.platform === 'chatgpt' && c.questions.length === 0));
});

test('Codex: reads a session, and knows when it is working, done, or waiting for approval', async () => {
  const dir = tmpDir('acm-codex-');
  const file = path.join(dir, `rollout-2026-09-29T10-00-00-${G2}.jsonl`);
  const lines = [
    { timestamp: '2026-09-29T10:00:00Z', type: 'session_meta', payload: { id: G2, cwd: 'C:\\\\code\\\\robot', timestamp: '2026-09-29T10:00:00Z' } },
    { timestamp: '2026-09-29T10:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd…</environment_context>' }] } },
    { timestamp: '2026-09-29T10:00:02Z', type: 'event_msg', payload: { type: 'user_message', message: 'Add unit tests for the arm controller' } },
    { timestamp: '2026-09-29T10:00:02Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add unit tests for the arm controller' }] } },
    { timestamp: '2026-09-29T10:00:03Z', type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: '2026-09-29T10:00:10Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } },
    { timestamp: '2026-09-29T10:00:40Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Added 6 tests. Should I also run them in CI?' } },
    { timestamp: '2026-09-29T10:00:41Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Added 6 tests. Should I also run them in CI?' } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const s = await parseRollout(file);
  assert.equal(s.sessionId, G2);
  assert.equal(s.cwd, 'C:\\\\code\\\\robot');
  assert.equal(s.title, 'Add unit tests for the arm controller');
  assert.deepEqual(s.questions.map((q) => q.text), ['Add unit tests for the arm controller'], 'setup text and duplicates are skipped');
  assert.equal(s.lastMessage.text, 'Added 6 tests. Should I also run them in CI?');
  assert.equal(s.pending, false);
  assert.equal(s.finishedAt, Date.parse('2026-09-29T10:00:41Z'));
  assert.equal(s.asks, true);

  // mid-task, then an approval request
  const live = emptySummary();
  for (const line of lines.slice(0, 6)) applyLine(live, line);
  assert.equal(live.pending, true, 'working');
  applyLine(live, { timestamp: '2026-09-29T10:00:12Z', type: 'event_msg', payload: { type: 'exec_approval_request', command: ['npm', 'test'] } });
  assert.equal(live.asking.text, 'Codex wants to run: npm test');
  applyLine(live, { timestamp: '2026-09-29T10:00:20Z', type: 'response_item', payload: { type: 'function_call_output', output: 'ok' } });
  assert.equal(live.asking, null, 'approved');

  // older Codex files: no wrapper, no task events
  const old = emptySummary();
  applyLine(old, { id: G2, timestamp: '2026-09-01T10:00:00Z', instructions: '' });
  applyLine(old, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the build' }] });
  applyLine(old, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed.' }] });
  assert.equal(old.sessionId, G2);
  assert.equal(old.pending, false);
});

test('scanner: Codex sessions appear under ChatGPT', async () => {
  const home = tmpDir('acm-codex-home-');
  const day = path.join(home, '.codex', 'sessions', '2026', '09', '29');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, `rollout-2026-09-29T10-00-00-${G2}.jsonl`), [
    { timestamp: '2026-09-29T10:00:00Z', type: 'session_meta', payload: { id: G2, cwd: '/code/robot' } },
    { timestamp: '2026-09-29T10:00:02Z', type: 'event_msg', payload: { type: 'user_message', message: 'Refactor the gripper code' } },
    { timestamp: '2026-09-29T10:01:00Z', type: 'event_msg', payload: { type: 'task_complete' } },
  ].map((l) => JSON.stringify(l)).join('\n'));
  const { items, sources } = await new Scanner({ home, platform: 'linux', env: {} }).scan([]);
  const codex = items.find((i) => i.source === 'codex');
  assert.equal(codex.id, `chatgpt:codex:${G2}`);
  assert.equal(codex.platform, 'chatgpt');
  assert.equal(codex.title, 'Refactor the gripper code');
  assert.equal(codex.resumeCommand, `codex resume ${G2}`);
  assert.equal(codex.folder, '/code/robot');
  assert.ok(sources.find((s) => s.label.startsWith('Codex')).found);
});

test('browser: chatgpt.com updates become ChatGPT chats, separate from Claude', () => {
  const state = emptyWebState();
  applyWebEvents(state, [
    { platform: 'chatgpt', type: 'data', url: '/backend-api/conversations?offset=0', at: T, body: { items: [{ id: G1, title: 'Essay outline on renewable energy', create_time: '2026-09-29T08:00:00Z', update_time: '2026-09-29T09:00:00Z' }] } },
    { platform: 'chatgpt', type: 'reply-started', uuid: G1, at: T + 1000, prompt: 'Make it shorter' },
    { platform: 'chatgpt', type: 'reply-finished', uuid: G1, at: T + 5000, text: 'Here is a shorter outline.', tail: 'Here is a shorter outline.' },
    { platform: 'claude', type: 'reply-started', uuid: G2, at: T + 6000 },
  ], T + 7000);
  const gpt = state.chats[`chatgpt:chat:${G1}`];
  assert.equal(gpt.platform, 'chatgpt');
  assert.equal(gpt.title, 'Essay outline on renewable energy');
  assert.equal(gpt.lastMessage.text, 'Here is a shorter outline.');
  assert.ok(state.chats[`chat:${G2}`], 'Claude chat kept under its own id');

  const [a] = combineChats([], state).filter((c) => c.platform === 'chatgpt');
  assert.equal(itemState(a, { now: T + 8000 }), 'new-reply');

  // a chatgpt.com list never turns into Claude chats, even though both are "conversations"
  applyWebEvents(state, [{ platform: 'claude', type: 'data', url: '/x', at: T, body: { items: [{ id: G2, title: 'x', create_time: '2026-09-29T08:00:00Z' }] } }], T + 9000);
  assert.equal(state.chats[`chat:${G2}`].title, 'New chat');
});

test('store: each platform keeps its own export; old saved browser chats are upgraded', () => {
  const file = path.join(tmpDir('acm-multi-'), 'state.json');
  fs.writeFileSync(file, JSON.stringify({
    lastImport: { file: 'old-claude.zip', count: 1 },
    chats: [{ id: 'chat:c1', uuid: 'c1', title: 'Claude chat' }],
    web: { chats: { [G2]: { id: `chat:${G2}`, uuid: G2, title: 'Seen on claude.ai', questions: [] } }, fields: ['uuid', 'name'] },
  }));
  const store = new Store(file);
  assert.equal(store.lastImport('claude').file, 'old-claude.zip', 'old single import becomes Claude\u2019s');
  assert.ok(store.data.web.chats[`chat:${G2}`]);
  assert.equal(store.data.web.chats[`chat:${G2}`].platform, 'claude');
  assert.deepEqual(store.data.web.fields, { claude: ['uuid', 'name'] });

  const gptChats = [chatgpt.parseConversation(chatgptConversation())];
  store.setChats(gptChats, { file: 'chatgpt-export.zip' }, { platform: 'chatgpt' });
  assert.deepEqual(store.data.chats.map((c) => c.id).sort(), ['chat:c1', `chatgpt:chat:${G1}`], 'importing ChatGPT keeps Claude chats');
  assert.equal(store.lastImport('chatgpt').count, 1);

  store.setChats([{ id: 'chat:c2', uuid: 'c2', title: 'New Claude export' }], { file: 'new-claude.zip' }, { platform: 'claude' });
  assert.deepEqual(store.data.chats.map((c) => c.id).sort(), ['chat:c2', `chatgpt:chat:${G1}`], 'a new Claude export replaces only Claude chats');
  assert.equal(normalizeWebState(undefined).chats && typeof normalizeWebState(undefined).chats, 'object');
});
