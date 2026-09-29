'use strict';

// Keeps track of the browser extension: when it last checked in, which browser it's in, and
// what the app wants from it next. The extension checks in every minute; each answer can carry
// requests back to it.

const CONNECTED_WINDOW = 3 * 60 * 1000; // missed ~3 check-ins: treat as disconnected

class ExtensionLink {
  constructor(saved = {}) {
    this.info = { ...saved };
    this.resyncWanted = true; // once per app start, ask for everything it has seen
  }

  // Called for each message from the extension. Returns what to ask it for.
  contact(client = {}, now = Date.now()) {
    this.info = {
      ...this.info,
      firstSeenAt: this.info.firstSeenAt || now,
      lastSeenAt: now,
      version: typeof client.version === 'string' ? client.version.slice(0, 20) : this.info.version,
      browser: typeof client.browser === 'string' ? client.browser.slice(0, 40) : this.info.browser,
    };
    const requests = [];
    if (this.clearWanted) {
      requests.push('clear');
      this.clearWanted = false;
    }
    if (this.resyncWanted) {
      requests.push('resync');
      this.resyncWanted = false;
    }
    return { requests };
  }

  requestResync() {
    this.resyncWanted = true;
  }

  // Testing: make the extension forget what it saved (so nothing comes back after a reset).
  requestClear() {
    this.clearWanted = true;
    this.resyncWanted = false;
  }

  status(now = Date.now()) {
    const connected = Boolean(this.info.lastSeenAt) && now - this.info.lastSeenAt < CONNECTED_WINDOW;
    return { connected, everConnected: Boolean(this.info.firstSeenAt), ...this.info };
  }
}

module.exports = { ExtensionLink, CONNECTED_WINDOW };
