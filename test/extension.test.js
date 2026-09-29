'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const sites = require('../extension/sites');
const manifest = require('../extension/manifest.json');
const pkg = require('../package.json');
const { PLATFORMS, matchAddress } = require('../src/core/platforms');
const { emptyWebState, applyWebEvents, combineChats } = require('../src/core/webChats');

const T = Date.parse('2026-09-29T10:00:00Z');
const SAMPLES = {
  claude: 'https://claude.ai/chat/6A1B2C3D-1111-4111-8111-000000000001',
  chatgpt: 'https://chatgpt.com/g/g-p-67abc-school/c/6a1b2c3d-1111-4111-8111-000000000001',
  gemini: 'https://gemini.google.com/u/1/app/3F1A2B4C5D6E7F80',
  copilot: 'https://copilot.microsoft.com/chats/Xy7_aBcD9eFg',
  perplexity: 'https://www.perplexity.ai/search/why-is-the-sky-blue-AbC.dEf_12',
  deepseek: 'https://chat.deepseek.com/a/chat/s/0d5e1a2b-3333-4333-8333-000000000003',
  grok: 'https://x.com/i/grok?conversation=1834567890123456789',
  mistral: 'https://chat.mistral.ai/chat/6a1b2c3d-1111-4111-8111-000000000001',
  poe: 'https://poe.com/chat/2abc3def',
};

test('extension: knows every platform, with exactly the app’s chat-page addresses', () => {
  assert.deepEqual(sites.SITES.map((s) => s.platform), PLATFORMS.map((p) => p.id));
  for (const p of PLATFORMS) {
    const site = sites.SITES.find((s) => s.platform === p.id);
    assert.equal(site.chat.source, p.history.chat.source, `${p.id}: same pattern in extension/sites.js and platforms.js`);
    assert.equal(site.chat.flags, p.history.chat.flags, `${p.id}: same flags`);
    assert.equal(Boolean(site.full), p.extension === 'full', `${p.id}: read the same way`);
    const url = SAMPLES[p.id];
    assert.equal(sites.siteFor(url), site, `${p.id}: its website is recognised`);
    assert.equal(sites.chatIdOf(site, url), matchAddress(url).chatId, `${p.id}: same chat id as the app`);
  }
  assert.equal(sites.siteFor('https://example.com/chat/x'), null);
  assert.equal(sites.chatIdOf(sites.siteFor('https://gemini.google.com/app'), 'https://gemini.google.com/app'), null, 'a new chat has no id yet');
  assert.ok(sites.STOP_LABEL.test('Stop generating') && sites.STOP_LABEL.test('Stop response') && sites.STOP_LABEL.test('Stop'));
  assert.ok(!sites.STOP_LABEL.test('Stopwatch app') && !sites.STOP_LABEL.test('Send message'));
});

test('extension: its manifest covers every AI website, and matches the app’s version', () => {
  const [hook, relay] = manifest.content_scripts;
  assert.deepEqual(relay.js, ['sites.js', 'relay.js'], 'the site list loads first');
  for (const p of PLATFORMS) {
    for (const prefix of p.history.prefixes) {
      const covered = relay.matches.some((m) => prefix.startsWith(m.replace(/\*$/, '')) || m.replace(/\*$/, '').startsWith(prefix));
      assert.ok(covered, `${prefix} is in the manifest`);
    }
  }
  assert.equal(hook.world, 'MAIN');
  assert.ok(hook.matches.every((m) => /claude\.ai|chatgpt\.com|chat\.openai\.com/.test(m)), 'the data hook only runs on Claude and ChatGPT');
  assert.ok(manifest.description.length <= 132, 'Chrome refuses longer descriptions');
  assert.equal(manifest.version, pkg.version);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*'], 'it only talks to the app on this computer');
});

test('web chats: sites read from the page (chat list, open chat, replies), for any platform', () => {
  const state = emptyWebState();
  const COPILOT = 'Xy7_aBcD9eFg';
  const GEMINI = '3f1a2b4c5d6e7f80';
  applyWebEvents(state, [
    { platform: 'gemini', type: 'chat-list', at: T, chats: [{ uuid: GEMINI, title: 'Trip ideas for Kyoto' }, { uuid: '9a8b7c6d5e4f3a21', title: null }], sample: '<a>…</a>' },
    { platform: 'copilot', type: 'chat-list', at: T, chats: [{ uuid: COPILOT, title: 'Microsoft Copilot: Your AI companion' }] },
  ], T + 1);
  assert.equal(state.chats[`gemini:chat:${GEMINI}`].title, 'Trip ideas for Kyoto');
  assert.equal(state.chats['gemini:chat:9a8b7c6d5e4f3a21'].title, null);
  assert.equal(state.chats['gemini:chat:9a8b7c6d5e4f3a21'].updatedAt, null, 'a sidebar has no dates');
  assert.equal(state.chats[`copilot:chat:${COPILOT}`].title, null, 'the site’s name isn’t a title');
  assert.ok(state.chats[`copilot:chat:${COPILOT}`], 'Copilot’s ids keep their letter case');
  assert.equal(state.sidebarSample.gemini, '<a>…</a>');

  // You open the Gemini chat: its title stays (the tab only says "Google Gemini"), questions come in.
  applyWebEvents(state, [{
    platform: 'gemini', type: 'page', uuid: GEMINI, at: T + 60000, title: 'Google Gemini',
    questions: ['Plan 3 days in Kyoto', 'Add a day trip to Nara'], reply: 'Day 4: Nara. Want restaurant ideas?',
    probe: { userMessages: 2, aiReplies: 2, composer: true, sidebarLinks: 2, extra: 'dropped' },
  }], T + 60001);
  let chat = state.chats[`gemini:chat:${GEMINI}`];
  assert.equal(chat.title, 'Trip ideas for Kyoto');
  assert.deepEqual(chat.questions.map((q) => q.text), ['Plan 3 days in Kyoto', 'Add a day trip to Nara']);
  assert.equal(chat.firstMessage.text, 'Plan 3 days in Kyoto');
  assert.equal(chat.lastMessage.text, 'Day 4: Nara. Want restaurant ideas?');
  assert.equal(chat.updatedAt, T + 60000);
  assert.deepEqual(state.probes.gemini, { userMessages: 2, aiReplies: 2, composer: true, sidebarLinks: 2, at: T + 60000 });

  // You send another message and Gemini replies; the page then shows only the latest messages.
  const { seen } = applyWebEvents(state, [
    { platform: 'gemini', type: 'reply-started', uuid: GEMINI, at: T + 120000, prompt: 'What about rain?' },
    { platform: 'gemini', type: 'reply-finished', uuid: GEMINI, at: T + 130000, text: 'Kyoto has great museums for rainy days.', tail: 'Kyoto has great museums for rainy days.' },
    { platform: 'gemini', type: 'page', uuid: GEMINI, at: T + 131000, title: 'Google Gemini', questions: ['What about rain?'], reply: 'Kyoto has great museums for rainy days.' },
    { platform: 'gemini', type: 'viewing', uuid: GEMINI.toUpperCase(), at: T + 131000 },
  ], T + 140000);
  chat = state.chats[`gemini:chat:${GEMINI}`];
  assert.deepEqual(chat.questions.map((q) => q.text), ['Plan 3 days in Kyoto', 'Add a day trip to Nara', 'What about rain?'], 'nothing known is dropped, nothing doubled');
  assert.equal(chat.activity.pending, false);
  assert.equal(chat.activity.finishedAt, T + 130000);
  assert.deepEqual(seen, [{ id: `gemini:chat:${GEMINI}`, at: T + 131000 }]);

  // Things that don't fit a platform's ids are ignored.
  const { applied } = applyWebEvents(state, [
    { platform: 'gemini', type: 'page', uuid: 'not-a-gemini-id', at: T },
    { platform: 'copilot', type: 'reply-started', uuid: '../../etc', at: T },
    { platform: 'poe', type: 'chat-list', at: T, chats: [{ uuid: 'ok123', title: 5 }] },
  ], T + 150000);
  assert.equal(applied, 0);

  const combined = combineChats([], state);
  assert.ok(combined.some((c) => c.id === `copilot:chat:${COPILOT}` && c.platform === 'copilot'));
});

test('extension: sites.js also loads as a plain browser script', () => {
  // In the browser it has no "module": it puts itself on globalThis for relay.js.
  const vm = require('vm');
  const fs = require('fs');
  const context = { URL };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'sites.js'), 'utf8'), context);
  assert.equal(context.AI_CHAT_SITES.siteFor('https://poe.com/chat/2abc3def').platform, 'poe');
});
