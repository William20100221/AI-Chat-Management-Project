const ext = globalThis.browser || globalThis.chrome;
const MIN_SPIN_MS = 600; // long enough to see that something happened

const $ = (id) => document.getElementById(id);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function showStatus(status, waiting) {
  const state = $('state');
  state.classList.remove('checking', 'ok', 'paused');
  if (!status) {
    $('state-text').textContent = 'No AI website activity seen yet';
    $('detail').textContent = '';
    return;
  }
  const paused = /paused/i.test(status.error || '');
  state.classList.add(status.ok ? 'ok' : paused ? 'paused' : 'bad');
  $('state-text').textContent = status.ok ? 'Connected to AI Chat Manager' : status.error || 'Not connected';
  $('detail').textContent = waiting
    ? `${waiting} update${waiting === 1 ? '' : 's'} waiting; they'll be sent when the app is running.`
    : `Last check ${new Date(status.at).toLocaleTimeString()}.`;
}

function askBackgroundToSend() {
  const message = { type: 'ai-chat-manager-send-now' };
  return new Promise((resolve) => {
    try {
      if (globalThis.browser) {
        // Firefox: promise style
        globalThis.browser.runtime.sendMessage(message).then((status) => resolve(status || null), () => resolve(null));
      } else {
        // Chrome / Edge: callback style
        chrome.runtime.sendMessage(message, (status) => {
          void chrome.runtime.lastError; // no answer is fine
          resolve(status || null);
        });
      }
    } catch {
      resolve(null);
    }
  });
}

// Checks in with the app, with a spinner on the button while it works and a result after.
async function checkNow({ fromButton = false } = {}) {
  const button = $('send');
  const result = $('result');
  if (fromButton) {
    button.disabled = true;
    button.prepend(Object.assign(document.createElement('span'), { className: 'spinner' }));
    $('send-label').textContent = 'Sending…';
    result.className = 'result';
  }
  $('state').className = 'state checking';
  $('state-text').textContent = 'Checking…';

  const [status] = await Promise.all([askBackgroundToSend(), wait(MIN_SPIN_MS)]);
  const { waiting = {} } = await ext.storage.local.get('waiting');
  showStatus(status, Object.keys(waiting).length);

  if (fromButton) {
    const spinner = button.querySelector('.spinner');
    if (spinner) spinner.remove();
    $('send-label').textContent = 'Send now';
    button.disabled = false;
    result.textContent = status && status.ok ? '✓ Sent' : '✗ Not sent';
    result.className = `result show ${status && status.ok ? 'good' : 'bad'}`;
    setTimeout(() => result.classList.remove('show'), 2500);
  }
}

$('send').addEventListener('click', () => checkNow({ fromButton: true }));
checkNow();
