'use strict';

// Which AI platforms you use, and how the app knows. Everything the scan found counts as a sign:
// an app installed on this computer, its files, chat pages in your browser history, the browser
// extension, or a data export. The window shows only the platforms with a sign; the rest wait
// under "More".

const fs = require('fs');
const os = require('os');
const path = require('path');
const { PLATFORMS } = require('./platforms');

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

// AI apps whose chats aren't kept in files we can read (they stay on the company's servers),
// but whose presence shows you use that platform. Their chats come from browser history.
function findOtherApps({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const found = [];
  const add = (platformId, name, p) => {
    if (exists(p) && !found.some((f) => f.platform === platformId)) found.push({ platform: platformId, name, path: p });
  };
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    let packages = [];
    try {
      packages = fs.readdirSync(path.join(local, 'Packages'));
    } catch {
      // no Store apps folder
    }
    for (const name of packages) {
      if (/^Microsoft\.Copilot_/i.test(name)) add('copilot', 'Microsoft Copilot app', path.join(local, 'Packages', name));
      if (/Perplexity/i.test(name)) add('perplexity', 'Perplexity app', path.join(local, 'Packages', name));
    }
    add('perplexity', 'Perplexity app', path.join(local, 'Programs', 'Perplexity'));
  } else if (platform === 'darwin') {
    for (const dir of ['/Applications', path.join(home, 'Applications')]) {
      add('copilot', 'Microsoft Copilot app', path.join(dir, 'Copilot.app'));
      add('copilot', 'Microsoft Copilot app', path.join(dir, 'Microsoft Copilot.app'));
      add('perplexity', 'Perplexity app', path.join(dir, 'Perplexity.app'));
      add('grok', 'Grok app', path.join(dir, 'Grok.app'));
    }
  }
  return found;
}

// Per platform: { used, items, lastAt, signs: [text…] }.
//   items    everything the scan listed (each has platform, updatedAt)
//   sources  the scan's sources; a source with `platform` and `kind` is a sign for that platform:
//            kind 'app' (installed), 'files' (its sessions), 'chats' (export and extension),
//            'history' (a browser profile; `sites` says which platforms it saw)
function platformUsage(items, sources) {
  const usage = {};
  for (const p of PLATFORMS) usage[p.id] = { used: false, items: 0, lastAt: null, signs: [] };
  for (const item of items) {
    const u = usage[item.platform];
    if (!u) continue;
    u.items++;
    if (item.updatedAt && (!u.lastAt || item.updatedAt > u.lastAt)) u.lastAt = item.updatedAt;
  }

  const history = {}; // platform → { browsers, chats, visits }
  for (const source of sources) {
    if (source.kind === 'history' && source.sites) {
      for (const [platformId, site] of Object.entries(source.sites)) {
        const h = history[platformId] || (history[platformId] = { browsers: [], chats: 0, visits: 0 });
        if (!h.browsers.includes(source.browser)) h.browsers.push(source.browser);
        h.chats += site.chats;
        h.visits += site.visits;
      }
      continue;
    }
    const u = source.platform && usage[source.platform];
    if (!u || !source.found) continue;
    let sign = null;
    const name = source.app || source.label;
    if (source.kind === 'app' || source.kind === 'files') {
      // Found on this computer: with what it holds, or just that it's there.
      sign = source.count ? `${name}: ${countText(source.count, source.unit || 'session')}` : `${name} is installed`;
    } else if (source.kind === 'chats' && source.count) {
      sign = `${source.label}: ${countText(source.count, 'chat')}`;
    }
    if (sign && !u.signs.includes(sign)) u.signs.push(sign);
  }
  for (const [platformId, h] of Object.entries(history)) {
    const u = usage[platformId];
    // Only chats count: visiting a site (its home page, a link someone sent) doesn't mean you use it.
    if (!u || !h.chats) continue;
    u.signs.push(`Browser history (${h.browsers.join(', ')}): ${countText(h.chats, 'chat')}`);
  }
  for (const u of Object.values(usage)) u.used = u.items > 0 || u.signs.length > 0;
  return usage;
}

function countText(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

module.exports = { findOtherApps, platformUsage };
