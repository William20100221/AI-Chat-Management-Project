// Delivers what the claude.ai tab saw to the AI Chat Manager app on this computer
// (http://127.0.0.1:48653). While the app is closed, updates wait in the extension's storage
// and are sent as soon as it's running again. Only the latest update per chat is kept.

const ext = globalThis.browser || globalThis.chrome;
const APP = 'http://127.0.0.1:48653';
const MAX_WAITING = 400;
const MAX_WAITING_CHARS = 6 * 1024 * 1024;

function keyOf(event) {
  if (event.type === 'data') return `data:${event.url}`;
  if (event.type === 'viewing') return `viewing:${event.uuid}`;
  return `reply:${event.uuid}`; // a finished reply replaces its "started"
}

// Storage reads and writes happen one at a time so updates never overwrite each other.
let chain = Promise.resolve();
function serial(task) {
  chain = chain.then(task, task);
  return chain;
}

function trim(waiting) {
  const keys = Object.keys(waiting).sort((a, b) => (waiting[a].at || 0) - (waiting[b].at || 0));
  let chars = keys.reduce((sum, key) => sum + JSON.stringify(waiting[key]).length, 0);
  while (keys.length && (keys.length > MAX_WAITING || chars > MAX_WAITING_CHARS)) {
    const oldest = keys.shift();
    chars -= JSON.stringify(waiting[oldest]).length;
    delete waiting[oldest];
  }
}

function queue(event) {
  serial(async () => {
    const { waiting = {} } = await ext.storage.local.get('waiting');
    waiting[keyOf(event)] = event;
    trim(waiting);
    await ext.storage.local.set({ waiting });
  });
  sendSoon();
}

let timer = null;
function sendSoon() {
  clearTimeout(timer);
  timer = setTimeout(send, 400);
}

async function send() {
  await chain;
  const { waiting = {} } = await ext.storage.local.get('waiting');
  const entries = Object.entries(waiting);
  if (!entries.length) return;
  const events = entries.map(([, event]) => event).sort((a, b) => (a.at || 0) - (b.at || 0));

  let ok = false;
  let error = null;
  try {
    const response = await fetch(`${APP}/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AI-Chat-Manager': '1' },
      body: JSON.stringify({ events }),
    });
    ok = response.ok;
    if (!ok) error = `The app answered ${response.status}`;
  } catch {
    error = 'AI Chat Manager is not running';
  }

  await serial(async () => {
    const { waiting: now = {} } = await ext.storage.local.get('waiting');
    if (ok) {
      for (const [key, event] of entries) if (now[key] && now[key].at === event.at) delete now[key];
    }
    await ext.storage.local.set({ waiting: now, status: { ok, error, at: Date.now(), waiting: Object.keys(now).length } });
  });
}

ext.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'ai-chat-manager' && message.event) queue(message.event);
  if (message && message.type === 'ai-chat-manager-send-now') send();
});

// Retry every minute, so updates saved while the app was closed arrive once it starts.
ext.alarms.create('ai-chat-manager-retry', { periodInMinutes: 1 });
ext.alarms.onAlarm.addListener(() => send());
ext.runtime.onStartup.addListener(() => send());
