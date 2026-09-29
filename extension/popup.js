const ext = globalThis.browser || globalThis.chrome;

async function show() {
  const { status, waiting = {} } = await ext.storage.local.get(['status', 'waiting']);
  const count = Object.keys(waiting).length;
  const state = document.getElementById('state');
  const text = document.getElementById('state-text');
  const detail = document.getElementById('detail');
  if (!status) {
    text.textContent = 'No claude.ai activity seen yet';
    detail.textContent = '';
    return;
  }
  state.classList.toggle('ok', Boolean(status.ok));
  text.textContent = status.ok ? 'Connected to AI Chat Manager' : status.error || 'Not connected';
  detail.textContent = count
    ? `${count} update${count === 1 ? '' : 's'} waiting; they'll be sent when the app is running.`
    : `Last update ${new Date(status.at).toLocaleTimeString()}.`;
}

document.getElementById('send').addEventListener('click', async () => {
  await Promise.resolve(ext.runtime.sendMessage({ type: 'ai-chat-manager-send-now' })).catch(() => {});
  setTimeout(show, 800);
});

show();
