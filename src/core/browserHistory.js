'use strict';

// Finds your AI chats in your browsers' history on this computer: which AI websites you use, and
// each chat's title, when you first opened it and when you last did. Works for every platform in
// platforms.js, for chats from before the app was installed, and while the app wasn't running.
//
// Only addresses on AI websites are ever read: the database query itself asks for just those
// (platforms.js → history.prefixes). Nothing else from your history is looked at or kept, and
// nothing leaves this computer. Settings → "Read browser history" turns it off.
//
// Browsers keep history in SQLite files, locked while they run; a copy is read (sqliteCopy.js).
//   Chromium family (Edge, Chrome, Brave, Vivaldi, Opera, Arc): <profile>/History
//     urls(url, title, visit_count, last_visit_time)   visits(url → urls.id, visit_time)
//     times are microseconds since 1601
//   Firefox (and Zen): <profile>/places.sqlite
//     moz_places(url, title, visit_count, last_visit_date)   moz_historyvisits(place_id, visit_date)
//     times are microseconds since 1970
//   Safari: ~/Library/Safari/History.db (only if macOS lets the app read it)
//     history_items(url, visit_count)   history_visits(history_item, visit_time, title)
//     times are seconds since 2001

const fs = require('fs');
const os = require('os');
const path = require('path');
const { PLATFORMS, matchAddress, cleanTitle, chatItemId } = require('./platforms');
const { withCopy, columnsOf } = require('./sqliteCopy');

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Where each browser keeps its profiles.
function browserFolders({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const out = [];
  const chromium = (name, dir) => out.push({ name, kind: 'chromium', dir });
  const firefox = (name, dir) => out.push({ name, kind: 'firefox', dir });
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    chromium('Microsoft Edge', path.join(local, 'Microsoft', 'Edge', 'User Data'));
    chromium('Google Chrome', path.join(local, 'Google', 'Chrome', 'User Data'));
    chromium('Brave', path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'));
    chromium('Vivaldi', path.join(local, 'Vivaldi', 'User Data'));
    chromium('Chromium', path.join(local, 'Chromium', 'User Data'));
    chromium('Opera', path.join(roaming, 'Opera Software', 'Opera Stable'));
    chromium('Opera GX', path.join(roaming, 'Opera Software', 'Opera GX Stable'));
    for (const entry of listDir(path.join(local, 'Packages'))) {
      if (/^TheBrowserCompany\.Arc_/i.test(entry.name)) chromium('Arc', path.join(local, 'Packages', entry.name, 'LocalCache', 'Local', 'Arc', 'User Data'));
    }
    firefox('Firefox', path.join(roaming, 'Mozilla', 'Firefox', 'Profiles'));
    firefox('Zen', path.join(roaming, 'zen', 'Profiles'));
  } else if (platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support');
    chromium('Microsoft Edge', path.join(support, 'Microsoft Edge'));
    chromium('Google Chrome', path.join(support, 'Google', 'Chrome'));
    chromium('Brave', path.join(support, 'BraveSoftware', 'Brave-Browser'));
    chromium('Vivaldi', path.join(support, 'Vivaldi'));
    chromium('Chromium', path.join(support, 'Chromium'));
    chromium('Opera', path.join(support, 'com.operasoftware.Opera'));
    chromium('Opera GX', path.join(support, 'com.operasoftware.OperaGX'));
    chromium('Arc', path.join(support, 'Arc', 'User Data'));
    firefox('Firefox', path.join(support, 'Firefox', 'Profiles'));
    firefox('Zen', path.join(support, 'zen', 'Profiles'));
    out.push({ name: 'Safari', kind: 'safari', dir: path.join(home, 'Library', 'Safari') });
  } else {
    const config = env.XDG_CONFIG_HOME || path.join(home, '.config');
    chromium('Microsoft Edge', path.join(config, 'microsoft-edge'));
    chromium('Google Chrome', path.join(config, 'google-chrome'));
    chromium('Brave', path.join(config, 'BraveSoftware', 'Brave-Browser'));
    chromium('Vivaldi', path.join(config, 'vivaldi'));
    chromium('Chromium', path.join(config, 'chromium'));
    chromium('Opera', path.join(config, 'opera'));
    firefox('Firefox', path.join(home, '.mozilla', 'firefox'));
    firefox('Firefox', path.join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox'));
    firefox('Firefox', path.join(home, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox'));
  }
  return out;
}

// Chromium's own names for its profiles ("Work", "Person 1"), from its "Local State" file.
function chromiumProfileNames(userDataDir) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf8'));
    const cache = (state && state.profile && state.profile.info_cache) || {};
    return Object.fromEntries(Object.entries(cache).map(([dir, info]) => [dir, info && info.name]).filter(([, name]) => typeof name === 'string'));
  } catch {
    return {};
  }
}

// Every history file on this computer: { browser, profile, kind, file }.
function findHistoryFiles(options = {}) {
  const found = [];
  const seen = new Set();
  const add = (entry) => {
    if (seen.has(entry.file)) return;
    seen.add(entry.file);
    found.push(entry);
  };
  for (const { name, kind, dir } of browserFolders(options)) {
    if (!isDir(dir)) continue;
    if (kind === 'chromium') {
      const names = chromiumProfileNames(dir);
      if (isFile(path.join(dir, 'History'))) add({ browser: name, profile: null, kind, file: path.join(dir, 'History') }); // Opera
      for (const entry of listDir(dir)) {
        if (!entry.isDirectory() || /^(System Profile|Guest Profile)$/i.test(entry.name)) continue;
        const file = path.join(dir, entry.name, 'History');
        if (isFile(file)) add({ browser: name, profile: names[entry.name] || entry.name, kind, file });
      }
    } else if (kind === 'firefox') {
      for (const entry of listDir(dir)) {
        const file = path.join(dir, entry.name, 'places.sqlite');
        // "abcd1234.default-release" → "default-release"
        if (entry.isDirectory() && isFile(file)) add({ browser: name, profile: entry.name.replace(/^[^.]*\./, ''), kind, file });
      }
    } else if (kind === 'safari') {
      const file = path.join(dir, 'History.db');
      if (isFile(file)) add({ browser: name, profile: null, kind, file });
    }
  }
  return found;
}

const PREFIXES = PLATFORMS.flatMap((p) => p.history.prefixes);

// The query for one kind of history file: only AI-website addresses, with times in milliseconds
// since 1970 (converted inside the query, since browsers' raw times are too big for JavaScript).
function queryFor(kind, db) {
  const where = (column) => PREFIXES.map(() => `${column} LIKE ?`).join(' OR ');
  const params = PREFIXES.map((prefix) => `${prefix}%`);
  if (kind === 'chromium') {
    if (!columnsOf(db, 'urls').has('url')) throw new Error('Not a Chromium history file');
    return {
      sql: `SELECT u.url AS url, u.title AS title, u.visit_count AS visits,
              CASE WHEN u.last_visit_time > 0 THEN u.last_visit_time / 1000 - 11644473600000 END AS lastAt,
              (SELECT MIN(v.visit_time) / 1000 - 11644473600000 FROM visits v WHERE v.url = u.id AND v.visit_time > 0) AS firstAt
            FROM urls u WHERE ${where('u.url')}`,
      params,
    };
  }
  if (kind === 'firefox') {
    if (!columnsOf(db, 'moz_places').has('url')) throw new Error('Not a Firefox history file');
    return {
      sql: `SELECT p.url AS url, p.title AS title, p.visit_count AS visits, p.last_visit_date / 1000 AS lastAt,
              (SELECT MIN(h.visit_date) / 1000 FROM moz_historyvisits h WHERE h.place_id = p.id) AS firstAt
            FROM moz_places p WHERE (${where('p.url')}) AND p.last_visit_date IS NOT NULL`,
      params,
    };
  }
  if (!columnsOf(db, 'history_items').has('url')) throw new Error('Not a Safari history file');
  return {
    sql: `SELECT i.url AS url, i.visit_count AS visits,
            (SELECT v.title FROM history_visits v WHERE v.history_item = i.id AND v.title IS NOT NULL AND v.title <> '' ORDER BY v.visit_time DESC LIMIT 1) AS title,
            (SELECT CAST((MAX(v.visit_time) + 978307200) * 1000 AS INTEGER) FROM history_visits v WHERE v.history_item = i.id) AS lastAt,
            (SELECT CAST((MIN(v.visit_time) + 978307200) * 1000 AS INTEGER) FROM history_visits v WHERE v.history_item = i.id) AS firstAt
          FROM history_items i WHERE ${where('i.url')}`,
    params,
  };
}

// The AI-website entries in one history file: [{ url, title, visits, lastAt, firstAt }].
async function readHistoryFile(entry, { tmpRoot } = {}) {
  return withCopy(entry.file, (db) => {
    const { sql, params } = queryFor(entry.kind, db);
    return db.prepare(sql).all(...params).map((row) => ({
      url: String(row.url),
      title: typeof row.title === 'string' ? row.title : null,
      visits: Number(row.visits) || 0,
      lastAt: Number(row.lastAt) > 0 ? Number(row.lastAt) : null,
      firstAt: Number(row.firstAt) > 0 ? Number(row.firstAt) : null,
    }));
  }, { tmpRoot });
}

// Pages that are a site's menus rather than a chat; they only show that you use the site.
const SITE_PAGES = /^\/?(|app|chat|chats|c|new|recents|library|projects?|search|discover|spaces|home|settings.*|a\/chat\/?|i\/grok)\/?$/i;

// Turns history entries (from any number of browsers) into chats and per-platform usage.
//   rows: [{ url, title, visits, lastAt, firstAt, browser }]
// → { chats: [chat…], sites: { [platform]: { visits, lastAt, chats, browsers: [...] } }, unmatched: { [platform]: [path…] } }
function historyChats(rows) {
  const byId = new Map();
  const sites = {};
  const unmatched = {};
  for (const row of rows) {
    const match = matchAddress(row.url);
    if (!match) continue;
    const site = sites[match.platform] || (sites[match.platform] = { visits: 0, lastAt: null, chats: 0, browsers: [] });
    site.visits += row.visits;
    if (row.lastAt && (!site.lastAt || row.lastAt > site.lastAt)) site.lastAt = row.lastAt;
    if (row.browser && !site.browsers.includes(row.browser)) site.browsers.push(row.browser);
    if (!match.chatId) {
      let pathname = '';
      try {
        pathname = new URL(row.url).pathname;
      } catch {
        // not a real address
      }
      if (pathname && !SITE_PAGES.test(pathname)) {
        const list = unmatched[match.platform] || (unmatched[match.platform] = []);
        if (list.length < 8 && !list.includes(pathname)) list.push(pathname);
      }
      continue;
    }
    const id = chatItemId(match.platform, match.chatId);
    let chat = byId.get(id);
    if (!chat) {
      chat = { id, platform: match.platform, uuid: match.chatId, title: null, titleAt: 0, url: null, createdAt: null, updatedAt: null, visits: 0, browsers: [] };
      byId.set(id, chat);
    }
    chat.visits += row.visits;
    if (row.browser && !chat.browsers.includes(row.browser)) chat.browsers.push(row.browser);
    if (row.firstAt && (!chat.createdAt || row.firstAt < chat.createdAt)) chat.createdAt = row.firstAt;
    if (row.lastAt && (!chat.updatedAt || row.lastAt > chat.updatedAt)) {
      chat.updatedAt = row.lastAt;
      chat.url = cleanAddress(row.url);
    }
    if (!chat.url) chat.url = cleanAddress(row.url);
    // The newest title that says something (a chat's title can change after it's renamed).
    const title = cleanTitle(match.platform, row.title);
    if (title && (row.lastAt || 0) >= chat.titleAt) {
      chat.title = title;
      chat.titleAt = row.lastAt || 0;
    }
  }
  const chats = [...byId.values()].map(({ titleAt, ...chat }) => chat);
  for (const chat of chats) sites[chat.platform].chats++;
  return { chats, sites, unmatched };
}

// The address without #fragments and tracking bits; the chat stays the same.
function cleanAddress(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) if (!/^(conversation|model)$/i.test(key)) u.searchParams.delete(key);
    return u.toString();
  } catch {
    return url;
  }
}

module.exports = { browserFolders, findHistoryFiles, readHistoryFile, historyChats, chromiumProfileNames };
