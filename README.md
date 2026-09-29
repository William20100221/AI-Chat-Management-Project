# AI Chat Manager

A sticky note for your AI chats, across AI platforms. It shows which chats and sessions need you right now, so you can pick up where you left off. Supported so far: **Claude** (chats, Cowork, Code) and **ChatGPT** (chats, and the ChatGPT app's Work and Codex chats).

- **Platforms:** the row under the tabs lists them: *All platforms · Claude · ChatGPT · More*.
  - Click a platform to **go into it**: you see only its chats, plus its types (Claude: Chat · Cowork · Code; ChatGPT: Chat · Work · Codex).
  - **← All platforms**, or the **Esc** key, takes you back.
  - **More** has a search box for finding a platform by name, useful as more platforms are added.
- **Working** shows what needs you:
  - **Asking you** (?): the AI stopped to ask a question, wants a plan approved, or (Codex) wants permission to run a command. The question is shown.
  - **Replying** (spinner): the AI is writing a reply right now.
  - **New reply** (dot): the AI finished and you haven't looked at it yet, or claude.ai shows its blue "unread" dot. If the reply ends with a question, it says *asks you something*.
  - **Pinned**: anything you pinned yourself.
- **Recent** shows everything active in the last *X* days (you choose *X*). **Done** holds what you marked done; it comes back if something new happens.
- Click an item to see its first message, last message and all of your questions, so you can tell which chat it is.
- **Compact view** (the arrows button at the top) shrinks the window to a narrow list of titles. Click a title to open its details underneath. You can keep it on top of other windows.
- **Look**: Material Design style, 7 colour themes, and light, dark or system mode (Settings → Appearance). Each platform has its own colour.
- Search covers titles *and* the questions you asked.

Everything stays on your computer. The app only **reads** files; it never changes the AI apps' files and never sends anything anywhere.

## Where the data comes from

The app looks in two places, in this order (see **Settings → Connections**):

1. **AI apps on this computer:** Claude Desktop (Cowork, Code tab), Claude Code in the terminal, the ChatGPT desktop app (Work and Codex), and the Codex CLI. These are read straight from their files.
2. **AI websites:** claude.ai and chatgpt.com. If step 1 finds nothing, the app asks you to connect the browser extension, and uses it to get your chats from those sites. You can connect it alongside step 1 too.

The app and the extension stay linked:
- The extension checks in every minute, so the app shows whether it's connected and in which browser.
- The app can ask the extension to **send everything it has seen** again. It does this once each time it starts, or when you press *Get everything again*.
- **Open claude.ai** and **Open chatgpt.com** open your chat list in the browser, so the extension can pick it up.

The extension never sends requests to those websites by itself. That would be automated access to your account. It only reads what the site loads while it's open.

| Platform | Source | How it gets in | Updates | "Replying" / "New reply" |
|---|---|---|---|---|
| Claude | **Cowork tasks** (Claude Desktop) | Claude Desktop's session files | Live, within about a second | ✅ |
| Claude | **Code sessions** (Code tab and the `claude` terminal) | Claude Code's transcripts in `~/.claude/projects` | Live | ✅ |
| Claude | **Chats on claude.ai** | The browser extension, while claude.ai is open | Live | ✅ |
| Claude | **Older chats** | Your Claude data export | When you export again | — |
| ChatGPT | **Work and Codex chats** (ChatGPT desktop app) | The app's chat list (`~/.codex/state_5.sqlite`) and session files (`~/.codex/sessions`) | Live | ✅ |
| ChatGPT | **Codex CLI sessions** | The same session files in `~/.codex/sessions` (or `$CODEX_HOME`) | Live | ✅ |
| ChatGPT | **Chats on chatgpt.com** | The browser extension, while chatgpt.com is open | Live | ✅ |
| ChatGPT | **Older chats** | Your ChatGPT data export | When you export again | — |

### The ChatGPT desktop app

In July 2026 the Codex app became the new **ChatGPT desktop app**, with three modes: **Chat**, **Work** and **Codex**. The older app is now called **ChatGPT Classic**. What this app can read:

- **Work and Codex chats:** yes, live. They run on your computer, and the ChatGPT app saves them in `~/.codex` (Windows: `%USERPROFILE%\.codex`). The app reads:
  - its **chat list** (`state_5.sqlite`, table `threads`), for the titles and names the ChatGPT app shows, and for archived chats;
  - the **session files** (`sessions\…\rollout-….jsonl`), for your questions, the replies, and whether it's replying or asking to run something.
  - It reads a *copy* of the chat list, so it never locks the file or gets in the ChatGPT app's way.
  - **Open in ChatGPT app** opens the chat there (through the app's `codex://threads/<id>` link).
- **Chat-mode chats:** not from the app. They're ordinary ChatGPT chats, kept on OpenAI's servers; the desktop app downloads them each time and doesn't save them as files. They come from **chatgpt.com** in your browser (the extension), or from your **ChatGPT data export**. Either way they show under ChatGPT → Chat.
- **ChatGPT Classic:** detected (Settings → Sources), but it has no chat files that can be read. On a Mac its cache is encrypted with a key in the Keychain. Its chats come from chatgpt.com or the export too.

**How "replying" works:** Claude Code and Codex write every message to a session file. If the newest entry is your message or a tool step, the AI is still working. Once the turn ends (a normal final reply, or Codex's "task complete"), it's finished. A turn that goes quiet for 10 minutes counts as stopped. On the websites, the extension sees the reply stream start and end.

**How "new reply" works:** a reply counts as seen once you open it in this app, open it on the website from here, send another message, or have that chat open in a visible, focused browser tab.

### The browser extension (live chats from claude.ai and chatgpt.com)

Website chats live on the companies' servers, not on your computer. The `extension/` folder has a small browser extension for **Edge, Chrome and Firefox**. While claude.ai or chatgpt.com is open in your browser, it passes your chats to the app: titles, dates, the messages of chats you open, and whether the AI is replying.

- **What it reads:** it only reads the responses those tabs already load (your chat list, the chat you open, each reply as it streams). It sends no requests of its own and doesn't change the page.
- **Where the data goes:** only to this app, on `127.0.0.1:48653` (your own computer). The app refuses anything that isn't a browser extension, including websites.
- **When the app is closed:** the extension keeps the latest updates and delivers them once the app runs again. It also keeps a copy of the latest data per chat, so a reinstalled app can get everything back.

Install:

- **Edge / Chrome:** open `edge://extensions` (or `chrome://extensions`), turn on *Developer mode*, click *Load unpacked*, and choose the `extension` folder. (Settings → *Open extension folder* shows where it is.) After updating the app, click the extension's reload arrow there.
- **Firefox (128+):** open `about:debugging#/runtime/this-firefox`, click *Load Temporary Add-on*, and choose `extension/manifest.json`. Firefox removes temporary add-ons when it restarts. Keeping it permanently needs the extension to be signed by Mozilla, which is free.
- Then reload any open claude.ai or chatgpt.com tabs. The extension's toolbar button shows whether it's connected.

It relies on how each site loads its data today. If a site changes that, the "replying" state or new chats may stop showing up for that site until the extension is updated.

### Older chats: data exports

For chats from before you installed the extension, download your data export and the app imports it from your Downloads folder by itself:

- **Claude:** Settings → Privacy → Export data. The email gives you a small *manifest* file with one-time links. When it lands in Downloads, the app shows **Download chats**. Click it, and the app imports `conversations-000.zip` when it arrives. Older single-zip exports work too.
- **ChatGPT:** Settings → Data controls → Export data. Download the zip from the email, and the app imports it.

Each platform's newest export replaces that platform's older one; the other platforms' chats stay. The app never logs in to your accounts or uses your cookies.

### Where the apps keep their files

- **Claude Desktop (Windows):** Microsoft Store version at `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\`; regular installer at `%APPDATA%\Claude\`. Inside those, `local-agent-mode-sessions\` (Cowork) and `claude-code-sessions\` (Code tab). On a Mac: `~/Library/Application Support/Claude/`.
- **Claude Code:** `~/.claude/projects/` (Windows: `%USERPROFILE%\.claude\projects`).
- **ChatGPT desktop app (new, with Work and Codex):** installed as the Microsoft Store package `%LOCALAPPDATA%\Packages\OpenAI.Codex_2p2nqsd0c76g0\` (the name stayed "Codex" after the rename). On a Mac: `/Applications/ChatGPT.app` (bundle id `com.openai.codex`). Its chats are in `~/.codex` (below).
- **ChatGPT Classic:** Windows package `%LOCALAPPDATA%\Packages\OpenAI.ChatGPT-Desktop_*`; on a Mac, data in `~/Library/Application Support/com.openai.chat/` (encrypted).
- **Codex (ChatGPT app and CLI):** `~/.codex/` (Windows: `%USERPROFILE%\.codex`), or `$CODEX_HOME` if you set it:
  - `sessions/YYYY/MM/DD/rollout-…-<id>.jsonl` and `archived_sessions/`: every message;
  - `state_5.sqlite` (or `$CODEX_SQLITE_HOME`, or `sqlite/state_5.sqlite`): the chat list;
  - `session_index.jsonl`: names you gave chats.

**Settings → Sources** shows what was found. These are internal files, not documented formats, so an update to those apps can change them.

### Adding another platform

1. **`src/core/platforms.js`:** add its name, types, website and chat link.
2. **A reader for its data:** see `chatgpt.js` (website and export) or `codex.js` (files on your computer). Plug it into `chatExport.js` or `scanner.js`.
3. **For live website chats:** add the site to `SITES` in `extension/page-hook.js` and to the chat-address pattern in `extension/relay.js`, then add its address to `extension/manifest.json`.

## Testing tools (temporary)

Tools for trying the app out while it's being built. They're behind a password so nobody opens them by accident.

### Open them

1. Open **Settings**: the gear button at the top right.
2. Scroll to the bottom, to **Testing**, and click **Testing tools**.
3. Type the password and press **Enter**, or click **Unlock**.
   - The default password is **`TESTING_PASSWORD`**: all capitals, with the underscore.
   - If you've set your own (see below), use that instead.
4. When you're done, click **Lock testing tools**. They also lock by themselves when the app restarts.

### What you can do there

| Tool | What it does |
|---|---|
| **Read AI apps' files on this computer** | On/off. Off hides Cowork, Code, Work and Codex sessions, as if no AI apps were installed, so you can try the "connect the websites instead" flow. |
| **Import the Claude export from Downloads automatically** | On/off. The same setting as in Behaviour. |
| **Receive chats from the browser extension** | On/off. While off, the extension keeps its updates, and its button says *Paused*. They arrive when you switch it back on. |
| **Delete all stored data** | Click **Delete**, then **Click again to delete**. It forgets everything *this app* saved: imported and browser chats, pins, done marks and what you've seen. Leave *Also clear the browser extension's saved copy* ticked, or the extension sends it all back at its next check-in. Claude's own files are never touched. Settings and your password stay. |
| **Password** | See below. |
| **What the app sees in the AI apps' data** | The field names in Claude's session files and in each website's chat data, plus a sample of each website's sidebar with all text removed. Useful for checking how "unread" and other states are detected. |

### Change the password

1. Unlock the Testing tools (see above).
2. In the **Password** box, click **Change password**.
3. Type the new password twice (4 to 200 characters) and click **Save**.

From then on only the new password works. **Use default again** switches back to `TESTING_PASSWORD`.

The password is saved as a salted hash (scrypt) in the app's data file, never as text, and only on your computer.

### Forgot your password?

Close the app and open `%APPDATA%\AI Chat Manager\state.json` in Notepad. Delete the `"testingPassword":{…}` entry, including the comma before or after it, so the JSON stays valid. Save the file and start the app: the password is back to `TESTING_PASSWORD`.

Deleting the whole `state.json` also works, but it resets everything else in the app too.

### Removing the Testing tools later

Delete:
- the block marked `Testing tools` in `src/renderer/index.html`;
- the *Testing tools* section in `src/renderer/app.js`;
- the `testing:` handlers and `testingSnapshot` in `src/main/main.js`;
- the password functions and the `readLocal` / `readBrowser` settings in `src/core/store.js`.

## Run it

Needs [Node.js](https://nodejs.org) 22.5 or newer (22 LTS or later), for its built-in SQLite reader.

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
extension/       browser extension for claude.ai and chatgpt.com (Edge, Chrome, Firefox)
  page-hook.js       runs inside those sites and notices the chat data and replies the page loads
  relay.js           passes that on, and notes which chat you're looking at
  background.js      delivers it to the app on 127.0.0.1, checks in every minute, keeps it while the app is closed
src/core/        reading and combining the sources (no Electron code, fully tested)
  platforms.js       the platforms (Claude, ChatGPT): names, types, links
  chatgpt.js         ChatGPT chats (message trees) from its export or from chatgpt.com
  codex.js           Codex session files on this computer (ChatGPT app Work/Codex chats and the CLI)
  chatgptApp.js      finds the ChatGPT desktop app and reads its chat list (a copy of state_5.sqlite)
  webChats.js        turns what the extension saw into chats, merged with the exports
  webBridge.js       the local-only receiver the extension talks to
  extensionLink.js   whether the extension is connected, and what the app asks it for
  paths.js           where Claude keeps its files
  desktopSessions.js Claude Desktop session records (Cowork and Code tab)
  transcript.js      Claude Code .jsonl transcripts: titles, questions, first/last message, reply in progress
  chatExport.js      Claude and ChatGPT data exports (manifest, zips), and spotting them in Downloads
  scanner.js         combines everything into one list, re-reading only changed files
  status.js          replying / new reply / pinned / recent / done
  store.js           your settings, pins, done marks and what you've seen (state.json in the app data folder)
src/main/main.js the app process: window (full and compact), file watching, Downloads check
src/preload.js   the small bridge the window is allowed to use
src/renderer/    the window: platforms, list, details, settings, themes
test/            unit tests with a fake Windows user folder
```

The app's own data lives in `%APPDATA%\AI Chat Manager\state.json`. Delete that file to reset the app.

Icons are from [Material Icons](https://fonts.google.com/icons) (Apache License 2.0).

## Not done yet

- **More platforms:** Gemini, Microsoft Copilot, Perplexity, DeepSeek and others. See "Adding another platform" above.
- **Plain chats inside the desktop apps' own windows** (Claude Desktop's chats, ChatGPT's Chat mode). The extension only sees the websites in your browser, and the desktop apps keep those chats on the companies' servers, or encrypted. Use the website or the export for them.
- Knowing when you read a Cowork, Code, Work or Codex reply inside that app itself.
- Opening a Cowork task or a Code session directly in Claude Desktop. For now: **Copy resume command** and **Folder**. (Work and Codex chats do open in the ChatGPT app.)
- App icon, installer, start with Windows, desktop notifications, Mac and Linux builds.
