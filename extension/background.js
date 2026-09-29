// Links your claude.ai and chatgpt.com tabs to the AI Chat Manager app on this computer (http://127.0.0.1:48653).
//
// - Everything those tabs saw is delivered to the app. While the app is closed, updates
//   wait here and are sent once it's running again.
// - A copy of the latest data per chat is kept, so the app can ask for everything again
//   (for example after it was reinstalled) without you reopening claude.ai.
// - Every minute the extension checks in with the app, so the app knows it's connected and can
//   pass back requests.

const ext = globalThis.browser || globalThis.chrome;
const APP = 'http://127.0.0.1:48653';
const VERSION = ext.runtime.getManifest().version;
const MAX_ITEMS = 400;
const MAX_CHARS = 6 * 1024 * 1024;

function browserName() {
  const brands = ((navigator.userAgentData && navigator.userAgentData.brands) || []).map((b) => b.brand);
  const known = ['Microsoft Edge', 'Google Chrome', 'Opera', 'Brave', 'Vivaldi'].find((b) => brands.includes(b));
  if (known) return known;
  if (/Firefox\//.test(navigator.userAgent)) return 'Firefox';
  if (/Edg\//.test(navigator.userAgent)) return 'Microsoft Edge';
  return brands.includes('Chromium') ? 'Chromium' : 'Browser';
}

function keyOf(event) {
  const site = event.platform || 'claude';
  if (event.type === 'data') return `data:${site}:${event.url}`;
  if (event.type === 'viewing') return `viewing:${site}:${event.uuid}`;
  if (event.type === 'sidebar') return `sidebar:${site}`;
  // "started" carries your message, so it keeps its own slot even if "finished" follows at once
  return `${event.type}:${site}:${event.uuid}`;
}

// Storage reads and writes happen one at a time so updates never overwrite each other.
let chain = Promise.resolve();
function serial(task) {
  chain = chain.then(task, task);
  return chain;
}

// Keeps a map under MAX_ITEMS entries and MAX_CHARS of JSON by dropping the oldest.
function trim(map) {
  const keys = Object.keys(map).sort((a, b) => (map[a].at || 0) - (map[b].at || 0));
  let chars = keys.reduce((sum, key) => sum + JSON.stringify(map[key]).length, 0);
  while (keys.length && (keys.length > MAX_ITEMS || chars > MAX_CHARS)) {
    const oldest = keys.shift();
    chars -= JSON.stringify(map[oldest]).length;
    delete map[oldest];
  }
}

function queue(event) {
  serial(async () => {
    const { waiting = {}, known = {} } = await ext.storage.local.get(['waiting', 'known']);
    const key = keyOf(event);
    waiting[key] = event;
    known[key] = event;
    trim(waiting);
    trim(known);
    await ext.storage.local.set({ waiting, known });
  });
  sendSoon();
}

// The app asked for everything again: queue every known update.
function resync() {
  return serial(async () => {
    const { waiting = {}, known = {} } = await ext.storage.local.get(['waiting', 'known']);
    const merged = { ...known, ...waiting };
    trim(merged);
    await ext.storage.local.set({ waiting: merged });
  });
}

let timer = null;
function sendSoon() {
  clearTimeout(timer);
  timer = setTimeout(send, 400);
}

// Sends waiting updates (or just checks in when there are none) and carries out the app's requests.
async function send() {
  await chain;
  const { waiting = {} } = await ext.storage.local.get('waiting');
  const entries = Object.entries(waiting);
  const events = entries.map(([, event]) => event).sort((a, b) => (a.at || 0) - (b.at || 0));

  let ok = false;
  let error = null;
  let requests = [];
  try {
    const response = await fetch(`${APP}/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AI-Chat-Manager': '1' },
      body: JSON.stringify({ client: { version: VERSION, browser: browserName() }, events }),
    });
    ok = response.ok;
    const answer = await response.json().catch(() => ({}));
    requests = Array.isArray(answer.requests) ? answer.requests : [];
    if (response.status === 423) error = 'Paused in AI Chat Manager (Testing)';
    else if (!ok) error = `The app answered ${response.status}`;
  } catch {
    error = 'AI Chat Manager is not running';
  }

  const status = await serial(async () => {
    const { waiting: now = {} } = await ext.storage.local.get('waiting');
    if (ok) {
      for (const [key, event] of entries) if (now[key] && now[key].at === event.at) delete now[key];
    }
    const next = { ok, error, at: Date.now(), waiting: Object.keys(now).length };
    await ext.storage.local.set({ waiting: now, status: next });
    return next;
  });

  if (requests.includes('clear')) {
    // The app deleted its data (Testing) and asked us to forget ours too.
    await serial(() => ext.storage.local.set({ waiting: {}, known: {} }));
  }
  if (requests.includes('resync')) {
    await resync();
    sendSoon();
  }
  return status;
}

ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'ai-chat-manager' && message.event) queue(message.event);
  if (message && message.type === 'ai-chat-manager-send-now') {
    // The popup waits for the result, so its button can show what happened.
    send()
      .then((status) => sendResponse(status || { ok: true, waiting: 0 }))
      .catch(() => sendResponse({ ok: false, error: 'Something went wrong' }));
    return true;
  }
  return false;
});

ext.alarms.create('ai-chat-manager-check-in', { periodInMinutes: 1 });
ext.alarms.onAlarm.addListener(() => send());
ext.runtime.onStartup.addListener(() => send());
ext.runtime.onInstalled.addListener(() => send());
