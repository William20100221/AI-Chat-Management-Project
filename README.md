# AI Chat Manager

A sticky note for your AI chats. It shows which Claude chats, Cowork tasks and Code sessions need you right now, so you can pick up where you left off.

- **Working** shows what needs you:
  - **Claude is replying**: Claude is writing a reply right now (spinner).
  - **New reply**: Claude finished and you haven't looked at it yet (dot).
  - **Pinned**: anything you pinned yourself.
- **Recent** shows everything active in the last *X* days (you choose *X*). **Done** holds what you marked done; it comes back if something new happens.
- Click an item to see its first message, last message and all of your questions, so you can tell which chat it is.
- **Compact view** (the arrows button at the top) shrinks the window to a narrow list of titles. Click a title to open its details underneath. You can keep it on top of other windows.
- **Look**: Material Design style, 7 colour themes, and light, dark or system mode (Settings → Appearance).
- Search covers titles *and* the questions you asked.

Everything stays on your computer. The app only **reads** files; it never changes Claude's files and never sends anything anywhere.

## Where the data comes from

| Source | How it gets in | Updates | "Replying" / "New reply" |
|---|---|---|---|
| **Cowork tasks** (Claude Desktop) | Read from Claude Desktop's session files | Automatically, within about a second | ✅ |
| **Code sessions** (Claude Desktop Code tab and the `claude` terminal) | Read from Claude Code's transcripts in `%USERPROFILE%\.claude\projects` | Automatically, within about a second | ✅ |
| **Normal chats on claude.ai** | From the browser extension (see below) while claude.ai is open | Live | ✅ |
| **Older chats** | From your Claude data export (see below) | When you export again | — |

**How "replying" works:** Claude writes every message to the session's transcript. If the newest entry is your message, a tool result, or a reply that stopped to run a tool, Claude is still working. Once a reply ends normally, the turn is finished. A turn that goes quiet for 10 minutes counts as stopped.

**How "new reply" works:** a reply counts as seen once you open it in this app, open it in Claude from here, or send another message. The app can't yet tell when you read a reply inside Claude itself. If Claude's session files turn out to store that, **Settings → Sources** lists the field names it found, and the app already uses a few likely ones.

### Normal chats: the browser extension (live)

Normal chats live on Anthropic's servers, not on your computer. The `extension/` folder has a small browser extension for **Edge, Chrome and Firefox**. While claude.ai is open in your browser, it passes your chats to the app: titles, dates, the messages of chats you open, and whether Claude is replying.

- **What it reads:** it only reads the responses your claude.ai tab already loads (your chat list, the chat you open, each reply as it streams). It sends no requests of its own and doesn't change the page.
- **Where the data goes:** only to this app, on `127.0.0.1:48653` (your own computer). The app refuses anything that isn't a browser extension, including websites.
- **When the app is closed:** the extension keeps the latest updates and delivers them once the app runs again.
- **Seen:** a reply counts as seen once you've had that chat open in a visible, focused tab, or opened it in this app.

Install:

- **Edge / Chrome:** open `edge://extensions` (or `chrome://extensions`), turn on *Developer mode*, click *Load unpacked*, and choose the `extension` folder. (Settings → *Open extension folder* shows where it is.)
- **Firefox (128+):** open `about:debugging#/runtime/this-firefox`, click *Load Temporary Add-on*, and choose `extension/manifest.json`. Firefox removes temporary add-ons when it restarts. Keeping it permanently needs the extension to be signed by Mozilla, which is free.
- Then reload any open claude.ai tabs. The extension's toolbar button shows whether it's connected.

It relies on how claude.ai loads its data today. If Claude changes that, the "replying" state or new chats may stop showing up until the extension is updated.

### Older chats: the Claude data export

For chats from before you installed the extension:

1. In Claude, go to **Settings → Privacy → Export data**.
2. Download the file from the email. Claude now sends a small *manifest* file with one-time download links.
3. When the manifest lands in Downloads, the app shows **Download chats**. Click it and your browser downloads `conversations-000.zip`, which the app then imports by itself. Older single-zip exports work too.

The app does not log in to your account or use your cookies. That would break Claude's terms of use and put your account at risk.

### Claude Desktop folders (Windows)

- Microsoft Store version: `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\`
- Regular installer: `%APPDATA%\Claude\`

Inside those, `local-agent-mode-sessions\` (Cowork) and `claude-code-sessions\` (Code tab). **Settings → Sources** shows what was found. These are Claude's internal files, not a documented format, so a Claude update can change them.

## Run it

Needs [Node.js](https://nodejs.org) 20 or newer.

```
npm install
npm start
```

- `npm test` runs the tests.
- `npm run dist:win` builds a Windows app into `dist\`.
- If `npm start` says Electron failed to install, run `node node_modules/electron/install.js` once.

## How it's built

Electron, plain HTML/CSS/JavaScript, no framework and no build step.

```
extension/       browser extension for claude.ai (Edge, Chrome, Firefox)
  page-hook.js       runs inside claude.ai and notices the chat data and replies the page loads
  relay.js           passes that on, and notes which chat you're looking at
  background.js      delivers it to the app on 127.0.0.1, keeping it while the app is closed
src/core/        reading and combining the sources (no Electron code, fully tested)
  webChats.js        turns what the extension saw into chats, merged with the export
  webBridge.js       the local-only receiver the extension talks to
  paths.js           where Claude keeps its files
  desktopSessions.js Claude Desktop session records (Cowork and Code tab)
  transcript.js      Claude Code .jsonl transcripts: titles, questions, first/last message, reply in progress
  chatExport.js      the claude.ai data export (manifest, zips, older single zip), and spotting it in Downloads
  scanner.js         combines everything into one list, re-reading only changed files
  status.js          replying / new reply / pinned / recent / done
  store.js           your settings, pins, done marks and what you've seen (state.json in the app data folder)
src/main/main.js the app process: window (full and compact), file watching, Downloads check
src/preload.js   the small bridge the window is allowed to use
src/renderer/    the window: list, details, settings, themes
test/            unit tests with a fake Windows user folder
```

The app's own data lives in `%APPDATA%\AI Chat Manager\state.json`. Delete that file to reset the app.

Icons are from [Material Icons](https://fonts.google.com/icons) (Apache License 2.0).

## Not done yet

- Live state for chats you have inside the **Claude Desktop app's** chat view. The extension only sees claude.ai in your browser; the desktop app would need another route, such as reading its local cache.
- Knowing when you read a Cowork or Code reply inside Claude Desktop itself.
- ChatGPT, Gemini and other platforms.
- Opening a Cowork task or Code session directly inside Claude Desktop. For now, Code sessions have **Copy resume command** and **Folder**; chats open on claude.ai in your browser.
- App icon, installer, start with Windows, desktop notifications.
