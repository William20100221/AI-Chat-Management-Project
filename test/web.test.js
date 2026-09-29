'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { emptyWebState, applyWebEvents, combineChats } = require('../src/core/webChats');
const { startBridge } = require('../src/core/webBridge');
const { itemState } = require('../src/core/status');
const { ExtensionLink, CONNECTED_WINDOW } = require('../src/core/extensionLink');

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const T = Date.parse('2026-09-29T10:00:00Z');

// What claude.ai's chat list and a single chat look like (only the fields that matter).
const listBody = [
  { uuid: A, name: 'Robot arm kinematics', created_at: '2026-09-28T08:00:00Z', updated_at: '2026-09-29T09:00:00Z' },
  { uuid: B, name: '', created_at: '2026-09-29T09:59:00Z', updated_at: '2026-09-29T09:59:00Z' },
];
const chatBody = {
  uuid: A,
  name: 'Robot arm kinematics',
  created_at: '2026-09-28T08:00:00Z',
  updated_at: '2026-09-29T09:00:00Z',
  chat_messages: [
    { sender: 'human', text: 'How do I solve **inverse** kinematics?', created_at: '2026-09-28T08:00:00Z' },
    { sender: 'assistant', text: '## Short answer\nUse the Jacobian.', created_at: '2026-09-28T08:00:20Z' },
  ],
};

test('web chats: list and chat data give titles, dates and messages', () => {
  const state = emptyWebState();
  applyWebEvents(state, [
    { type: 'data', url: '/api/organizations/o/chat_conversations?limit=30', at: T, body: listBody },
    { type: 'data', url: `/api/organizations/o/chat_conversations/${A}?tree=True`, at: T + 1, body: chatBody },
  ], T + 5);

  const chat = state.chats[A];
  assert.equal(chat.title, 'Robot arm kinematics');
  assert.equal(chat.createdAt, Date.parse('2026-09-28T08:00:00Z'));
  assert.equal(chat.updatedAt, Date.parse('2026-09-29T09:00:00Z'));
  assert.deepEqual(chat.questions.map((q) => q.text), ['How do I solve inverse kinematics?']);
  assert.equal(chat.lastMessage.text, 'Short answer\nUse the Jacobian.'.replace(/\s+/g, ' '));
  assert.equal(state.chats[B], undefined, 'an untitled chat with no messages waits until it has a title');

  // a later list refresh (no messages) keeps the messages we already have
  applyWebEvents(state, [{ type: 'data', url: '/api/x/chat_conversations', at: T + 10, body: listBody }], T + 10);
  assert.equal(state.chats[A].questions.length, 1);
});

test('web chats: replying, new reply, and seen while watching', () => {
  const state = emptyWebState();
  applyWebEvents(state, [{ type: 'reply-started', uuid: B, at: T }], T + 1);
  assert.equal(state.chats[B].title, 'New chat');
  assert.equal(state.chats[B].activity.pending, true);

  let [chat] = combineChats([], state);
  assert.equal(itemState(chat, { now: T + 2000 }), 'responding');

  applyWebEvents(state, [{ type: 'reply-finished', uuid: B, at: T + 30000 }], T + 30001);
  [chat] = combineChats([], state);
  assert.equal(itemState(chat, { now: T + 31000, seenAt: 0 }), 'new-reply');

  const { seen } = applyWebEvents(state, [{ type: 'viewing', uuid: B, at: T + 40000 }], T + 40001);
  assert.deepEqual(seen, [{ id: `chat:${B}`, at: T + 40000 }]);
  assert.equal(itemState(chat, { now: T + 41000, seenAt: seen[0].at }), 'recent');
});

test('web chats: events are applied in time order and bad ones are ignored', () => {
  const state = emptyWebState();
  const { applied } = applyWebEvents(state, [
    { type: 'reply-finished', uuid: A, at: T + 5 },
    { type: 'reply-started', uuid: A, at: T },
    { type: 'reply-started', uuid: 'not-a-uuid', at: T },
    { type: 'delete-everything', uuid: A, at: T },
    { type: 'data', url: '/x', at: T, body: { nothing: 'here' } },
    null,
  ], T + 10);
  assert.equal(applied, 3);
  assert.equal(state.chats[A].activity.pending, false, 'finished comes after started, whatever order they arrived in');
  assert.equal(Object.keys(state.chats).length, 1);

  applyWebEvents(state, [{ type: 'reply-started', uuid: A, at: T + 10 ** 9 }], T + 20);
  assert.equal(state.chats[A].activity.lastWriteAt, T + 20, 'times in the future are clamped to now');
});

test('web chats: combined with the export, live data wins where newer', () => {
  const state = emptyWebState();
  applyWebEvents(state, [
    { type: 'data', url: '/list', at: T, body: [{ uuid: A, name: 'Renamed in the browser', created_at: '2026-09-28T08:00:00Z', updated_at: '2026-09-29T09:30:00Z' }] },
    { type: 'reply-finished', uuid: A, at: T },
  ], T);
  const exported = [{
    id: `chat:${A}`, uuid: A, title: 'Old title', createdAt: Date.parse('2026-09-28T08:00:00Z'), updatedAt: Date.parse('2026-09-28T09:00:00Z'),
    questions: [{ role: 'user', text: 'From the export', at: 1 }], firstMessage: { role: 'user', text: 'From the export', at: 1 }, lastMessage: null,
  }];
  const [chat] = combineChats(exported, state);
  assert.equal(chat.title, 'Renamed in the browser');
  assert.equal(chat.updatedAt, T);
  assert.equal(chat.questions[0].text, 'From the export', 'export messages are kept when the browser only saw the list');
  assert.equal(chat.activity.finishedAt, T);
});

// ---- the local bridge the extension talks to ----

function request(port, { method = 'POST', path = '/v1/events', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('bridge: accepts the extension, rejects websites', async () => {
  const received = [];
  let server;
  let lastClient = null;
  const port = await new Promise((resolve) => {
    server = startBridge({
      port: 0,
      onEvents: (events, { client }) => {
        received.push(...events);
        lastClient = client;
        return { requests: ['resync'] };
      },
      onStatus: (s) => s.listening && resolve(s.port),
    });
  });
  const host = `127.0.0.1:${port}`;
  const payload = JSON.stringify({ client: { version: '0.3.0', browser: 'Microsoft Edge' }, events: [{ type: 'viewing', uuid: A, at: T }] });
  const good = { Host: host, 'Content-Type': 'application/json', 'X-AI-Chat-Manager': '1' };

  try {
    const fromExtension = await request(port, { headers: { ...good, Origin: 'chrome-extension://abcdefghijklmnop' }, body: payload });
    assert.equal(fromExtension.status, 200);
    assert.equal(fromExtension.headers['access-control-allow-origin'], 'chrome-extension://abcdefghijklmnop');
    assert.deepEqual(fromExtension.body.requests, ['resync'], "the app's requests travel back in the answer");
    assert.equal(lastClient.browser, 'Microsoft Edge');

    assert.equal((await request(port, { headers: { ...good, Origin: 'moz-extension://1234-abcd' }, body: payload })).status, 200);
    assert.equal(received.length, 2);

    assert.equal((await request(port, { headers: { ...good, Origin: 'https://evil.example' }, body: payload })).status, 403, 'websites are refused');
    assert.equal((await request(port, { headers: { ...good, Host: 'evil.example:80' }, body: payload })).status, 403, 'DNS rebinding is refused');
    assert.equal((await request(port, { headers: { Host: host, 'Content-Type': 'text/plain' }, body: payload })).status, 403, 'the extension header is required');
    assert.equal((await request(port, { method: 'OPTIONS', headers: { Host: host, Origin: 'https://evil.example' } })).status, 403, 'no CORS permission for websites');
    assert.equal((await request(port, { headers: good, body: '{not json' })).status, 400);
    assert.equal((await request(port, { method: 'GET', path: '/v1/ping', headers: { Host: host } })).body.app, 'ai-chat-manager');
    assert.equal(received.length, 2);
  } finally {
    server.close();
  }
});

test('extension link: connected status, and one "send everything" request per app start', () => {
  const link = new ExtensionLink();
  assert.equal(link.status(T).connected, false);
  assert.equal(link.status(T).everConnected, false);

  assert.deepEqual(link.contact({ version: '0.3.0', browser: 'Microsoft Edge' }, T), { requests: ['resync'] });
  assert.deepEqual(link.contact({}, T + 60000), { requests: [] }, 'only asked once');
  const status = link.status(T + 60000);
  assert.equal(status.connected, true);
  assert.equal(status.browser, 'Microsoft Edge', 'kept from the earlier check-in');

  assert.equal(link.status(T + 60000 + CONNECTED_WINDOW + 1).connected, false, 'no check-ins for 3 minutes: disconnected');

  link.requestResync(); // the "Get everything again" button
  assert.deepEqual(link.contact({}, T + 120000).requests, ['resync']);

  const restarted = new ExtensionLink(link.info); // saved info survives an app restart
  assert.equal(restarted.status(T + 120000).everConnected, true);
  assert.deepEqual(restarted.contact({}, T + 130000).requests, ['resync'], 'a new app start asks again');
});
