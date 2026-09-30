# AI Chat Manager

A sticky note for your AI chats, across AI platforms. It shows which chats and sessions need you right now, so you can pick up where you left off.

It **finds the AI platforms you use by itself**, then gets each one's chats: types, titles, dates and more. Platforms it knows: **Claude**, **ChatGPT**, **Gemini**, **Microsoft Copilot**, **Perplexity**, **DeepSeek**, **Grok**, **Le Chat** (Mistral) and **Poe**.

- **Platforms:** the row under the tabs shows *the platforms you use*, for example *All platforms · Claude · ChatGPT · Gemini · More*.
  - A platform counts as used when the app finds it on this computer (an AI app or its files), finds its chats in your browser history (just visiting the site doesn't count), through the browser extension, or in a data export. **Settings → Your AI platforms** lists them, and how each was found.
  - Click a platform to **go into it**: you see only its chats, plus the types you have there (Claude: Chat · Cowork · Code; ChatGPT: Chat · Work · Codex; Gemini: Chat · CLI). Types you don't use are hidden.
  - **← All platforms**, or the **Esc** key, takes you back.
  - **More** lists every platform, the ones you don't use marked *not found yet*, with a search box.
- **Working** shows what needs you:
  - **Asking you** (?): the AI stopped to ask a question, wants a plan approved, or (Codex) wants permission to run a command. The question is shown.
  - **Replying** (spinner): the AI is writing a reply right now.
  - **New reply** (dot): the AI finished and you haven't looked at it yet, or claude.ai shows its blue "unread" dot. If the reply ends with a question, it says *asks you something*.
  - **Pinned**: anything you pinned yourself.
- **Recent** shows everything active in the last *X* days (you choose *X*). **Done** holds what you marked done; it comes back if something new happens.
- Click an item to see its first message, last message and all of your questions, so you can tell which chat it is.
- **Compact view** (the arrows button at the top) shrinks the window to a narrow list of titles. Click a title to open its details underneath. You can keep it on top of other windows.
- **Look**: Material Design style, with the app drawing its own title bar (name, search and buttons in one strip; the window buttons take the theme’s colours). 7 colour themes, and light, dark or system mode (Settings → Appearance). Each platform has its own colour. Scrollbars are a thin line that only shows while you scroll (its length shows how much there is), and can be dragged.
- Search covers titles *and* the questions you asked.

Everything stays on your computer. The app only **reads** files; it never changes the AI apps' files and never sends anything anywhere.

## Install

No typing, no `npm`: download the installer for your computer and double-click it.
https://github.com/William20100221/AI-Chat-Management-Project/releases

| Computer | File | What happens |
|---|---|---|
| **Windows 10/11** | `AI-Chat-Manager-Setup-<version>.exe` | Installs for you only (no admin password), adds Start menu and desktop shortcuts, and opens the app. |
| **Mac, Apple Silicon** (M1 and later) | `AI-Chat-Manager-<version>-mac-arm64.dmg` (or `.zip`) | Open it and drag **AI Chat Manager** into **Applications**. |
| **Mac, Intel** | `AI-Chat-Manager-<version>-mac-x64.dmg` (or `.zip`) | The same. |

The installers aren't signed with a paid certificate yet, so the first time, your computer warns you:

- **Windows** shows *"Windows protected your PC"*. Click **More info**, then **Run anyway**.
- **Mac** says it *"can't verify"* the app. Open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to AI Chat Manager. (On macOS 14 and older you can also right-click the app → **Open**.)

This happens once. Signing certificates (about US$99 a year from Apple, and from a Windows certificate seller) would remove the warnings.

### The first time it opens

A short setup asks what the app may read, before it reads anything:

1. **AI apps on this computer**, **browser history (AI chat pages only)** and **data exports in Downloads**: each on/off.
2. **Start when I log in**, so it's always up to date.
3. On a Mac: macOS itself asks once whether the app may open **Downloads** (click *Allow*). For Safari's history, the setup has a button to the *Full Disk Access* settings.
4. **The browser extension** (optional): *Open extension folder* and *Copy address* buttons, and three steps. Browsers don't let apps install extensions by themselves.

Everything can be changed later in Settings, which also has *Run the first-run setup again*.

### Uninstall

- **Windows:** Settings → Apps → AI Chat Manager → Uninstall. This also deletes the app's data (`%APPDATA%\AI Chat Manager`: settings, pins, imported exports), so installing it again starts with the first-run setup. Installing a newer version over the old one keeps everything.
- **Mac:** drag AI Chat Manager from Applications to the Bin. Your data is in `~/Library/Application Support/AI Chat Manager`.

## Where the data comes from

The app looks in these places, in this order (see **Settings → Connections**):

1. **AI apps on this computer:** Claude Desktop (Cowork, Code tab), Claude Code in the terminal, the ChatGPT desktop app (Work and Codex), the Codex CLI and the Gemini CLI. These are read straight from their files. Other AI apps (Microsoft Copilot, Perplexity, Grok) are detected but keep their chats on the companies' servers.
2. **Browser history:** chat pages you opened on any AI website, in any browser on this computer. This gives each chat's title and when you first and last opened it, for every platform, even from before the app was installed. See *Browser history* below.
3. **Live from AI websites:** every AI website above, through one browser extension, which adds your questions, the replies and live "replying" and "new reply" states. If steps 1 and 2 find nothing, the app asks you to connect it.

The app and the extension stay linked:
- The extension checks in every minute, so the app shows whether it's connected and in which browser.
- The app can ask the extension to **send everything it has seen** again. It does this once each time it starts, or when you press *Get everything again*.
- **Open claude.ai**, **Open gemini.google.com** and so on (one for each platform you use) open your chat list in the browser, so the extension can pick it up.

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
| Gemini, Copilot, Perplexity, DeepSeek, Grok, Le Chat, Poe | **Chats on the website** | The browser extension, while the site is open | Live | ✅ |
| Gemini | **CLI sessions** (Gemini CLI in the terminal) | Its session files in `~/.gemini/tmp/<project>/chats` | Live | ✅ |
| Any of them | **Chats you opened on the website** | Your browser history (title, first and last opened) | Every 2 minutes, or when you press Refresh | — |

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

### Browser history (chats on any AI website)

Browsers keep a list of the pages you open, in a file on your computer. The app finds the **AI chat pages** in it, like `chatgpt.com/c/…`, `gemini.google.com/app/…` or `perplexity.ai/search/…`, and turns each one into a chat with its title, when you first opened it and when you last did. A chat opened in several browsers shows once.

- **Browsers:** Microsoft Edge, Google Chrome, Brave, Vivaldi, Opera, Opera GX, Arc, Chromium, Firefox and Zen, with all their profiles. On a Mac, also Safari, if macOS lets the app read it (System Settings → Privacy & Security → Full Disk Access).
- **Only AI pages are read.** The app asks the history file for addresses on AI websites and nothing else. The rest of your history isn't read or kept, and nothing leaves your computer.
- **The browser is never disturbed.** Browsers lock their history file while they run, so the app reads a copy and deletes it straight after.
- **How often:** every 2 minutes while you browse, or at once when you press **Refresh**.
- **Turn it off:** Settings → Connections → *Read browser history (AI chat pages only)*.

What it can't know:
- **The messages.** They stay on the website's servers. Click **Open in …** to see the chat, or use the extension or a data export.
- **Some titles.** Gemini, Microsoft Copilot and DeepSeek don't put the chat's title in the browser tab, so their chats show as *Untitled Gemini chat* and so on, with their dates.
- **Private/incognito windows, and old history.** Browsers don't save those pages, and they delete history after a while (Chrome: about 90 days).
- **Live states.** "Replying" and "new reply" need the extension, or an app on this computer.

If a website changes its chat-page addresses, its chats stop appearing. **Settings → Testing** lists AI-site pages that didn't look like chats, so the pattern in `src/core/platforms.js` can be fixed.

### The browser extension (live chats from every AI website)

Website chats live on the companies' servers, not on your computer. The `extension/` folder has **one** small browser extension, for **Edge, Chrome, Brave, Opera, Vivaldi and Firefox**, that works on **all** the AI websites: Claude, ChatGPT, Gemini, Microsoft Copilot, Perplexity, DeepSeek, Grok (grok.com and on X), Le Chat and Poe. While one of them is open in your browser, it passes your chats to the app.

It reads them in one of two ways:

- **Claude and ChatGPT: the site's own data.** Your whole chat list with dates, all the messages of a chat you open, and each reply as it streams in (so "replying" starts and ends exactly).
- **The other sites: what the page shows.**
  - **Chat list:** the chats linked in the site's sidebar, with their titles. They have no dates until you open them.
  - **The chat you open:** its title, your questions and the last reply that are on the screen. Long chats may only show their latest messages.
  - **Your message:** caught as you send it.
  - **Replying:** while the site shows its **Stop** button. On a site without one it can see, the reply counts as finished once its text stops changing for a few seconds.
  - This depends on how each page is built, and these are best guesses at each site's markup. **Settings → Testing** shows, for each site, what the extension found (your messages, the AI's replies, the message box, sidebar links), so a site that doesn't work can be fixed in `extension/sites.js`.

- **What it reads:** it only reads the responses those tabs already load (your chat list, the chat you open, each reply as it streams). It sends no requests of its own and doesn't change the page.
- **Where the data goes:** only to this app, on `127.0.0.1:48653` (your own computer). The app refuses anything that isn't a browser extension, including websites.
- **When the app is closed:** the extension keeps the latest updates and delivers them once the app runs again. It also keeps a copy of the latest data per chat, so a reinstalled app can get everything back.

Install:

- **Edge / Chrome:** open `edge://extensions` (or `chrome://extensions`), turn on *Developer mode*, click *Load unpacked*, and choose the `extension` folder. (Settings → *Open extension folder* shows where it is.) After updating the app, click the extension's reload arrow there.
- **Firefox (128+):** open `about:debugging#/runtime/this-firefox`, click *Load Temporary Add-on*, and choose `extension/manifest.json`. Firefox removes temporary add-ons when it restarts. Keeping it permanently needs the extension to be signed by Mozilla, which is free.
- Then reload any open AI website tabs. The extension's toolbar button shows whether it's connected.
- **Updating from an older version:** click the extension's reload arrow in `edge://extensions` (or `chrome://extensions`), then reload the AI website tabs. It asks for the new websites when it updates.
- **Safari:** not yet. Safari extensions have to be converted and signed with Xcode on a Mac.

It relies on how each site works today. If a site changes that, the "replying" state or new chats may stop showing up for that site until the extension is updated.

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
- **Gemini CLI:** `~/.gemini/tmp/<project>/chats/session-….jsonl` (Windows: `%USERPROFILE%\.gemini\…`, or under `$GEMINI_CLI_HOME`). The project's folder is in `~/.gemini/tmp/<project>/.project_root`. Resume a session from that folder with `gemini --resume <id>`.
- **Other AI apps (detected only):** Microsoft Copilot (Windows package `Microsoft.Copilot_*`; Mac `Copilot.app`), Perplexity (`Perplexity.app`, or `%LOCALAPPDATA%\Programs\Perplexity`), Grok (`Grok.app`).
- **Browser history:** Chromium-based browsers keep it in `<profile>\History` (Edge: `%LOCALAPPDATA%\Microsoft\Edge\User Data\Default\History`; Chrome: `%LOCALAPPDATA%\Google\Chrome\User Data\…`), Firefox in `%APPDATA%\Mozilla\Firefox\Profiles\<profile>\places.sqlite`, Safari in `~/Library/Safari/History.db`.

**Settings → Sources** shows what was found. These are internal files, not documented formats, so an update to those apps can change them.

### Adding another platform

1. **`src/core/platforms.js`:** add its name, types, website, chat link, and `history`: what its chat pages' addresses look like and how its page titles end. That alone makes its chats appear from browser history, and the platform appear when you use it.
2. **A reader for its data on this computer**, if it has an app or a CLI: see `codex.js` or `geminiCli.js`, and plug it into `scanner.js` with a source that says which platform it's a sign of (`platform`, `kind`).
3. **For live website chats:** add the site to `extension/sites.js` (the same chat-page pattern as in `platforms.js`, which a test checks, plus where its messages are on the page) and its address to `extension/manifest.json`. To also read the site's own data, like Claude and ChatGPT, add it to `SITES` in `extension/page-hook.js`.

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
| **Import the Claude export from Downloads automatically** | On/off. The same setting as in Behaviour. |
| **Receive chats from the browser extension** | On/off. While off, the extension keeps its updates, and its button says *Paused*. They arrive when you switch it back on. |
| **Delete all stored data** | Click **Delete**, then **Click again to delete**. It forgets everything *this app* saved: imported and browser chats, pins, done marks and what you've seen. Leave *Also clear the browser extension's saved copy* ticked, or the extension sends it all back at its next check-in. Claude's own files are never touched. Settings and your password stay. |
| **Password** | See below. |
| **What the app sees in the AI apps' data** | The field names in Claude's session files and in each website's chat data, a sample of each website's sidebar with all text removed, what the extension found on each site it reads from the page (your messages, the AI's replies, the message box, sidebar links), and AI-site pages in your browser history that didn't look like chats. Useful for checking how "unread" and other states are detected, and chat-page addresses. |

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
- the password functions and the `readBrowser` setting in `src/core/store.js`.

## Build the installers

Three ways, none needing more than a double-click or two:

- **GitHub Actions (both at once):** `.github/workflows/installers.yml` builds the Windows installer and the Mac apps on GitHub's own Windows and Mac computers every time you push. The files are under the run's **Artifacts** (Actions tab). Push a tag like `v0.9.1` and they're also attached to a **Release**, a download page you can link people to.
- **On Windows:** double-click **`Build Windows installer.bat`**. The installer lands in `dist\`.
- **On a Mac:** double-click **`Build Mac app.command`** (the first time: right-click → Open). The `.dmg` and `.zip` land in `dist/`.

The double-click builds need [Node.js](https://nodejs.org) 22.5 or newer; if it's missing, they open its download page. In a terminal it's `npm run dist:win`, `npm run dist:mac`, or `npm run dist` for both. `scripts/build.js` explains how it also builds both from Linux (no Wine needed; the Mac app is signed "ad hoc" with rcodesign, and zipped, since a `.dmg` needs a Mac).

The app's icon is `build/icon.svg`; `npm run icon` redraws `build/icon.png` from it, and the installers make the Windows and Mac icons from that.

## Run it from the source (for development)

```
npm install
npm start
```

- `npm test` runs the tests.
- If `npm start` says Electron failed to install, run `node node_modules/electron/install.js` once.

## How it's built

Electron, plain HTML/CSS/JavaScript, no framework and no build step.

```
extension/       one browser extension for every AI website (Edge, Chrome, Firefox and other Chromium browsers)
  sites.js           the AI websites: chat-page addresses (the same as the app's) and where messages are
  page-hook.js       Claude and ChatGPT: notices the chat data and replies the page loads
  relay.js           every site: passes that on, or reads the page (chat list, open chat, replying), and notes which chat you're looking at
  background.js      delivers it to the app on 127.0.0.1, checks in every minute, keeps it while the app is closed
src/core/        reading and combining the sources (no Electron code, fully tested)
  platforms.js       the platforms: names, types, links, and what their chat pages look like
  detect.js          which platforms you use and how the app knows; other AI apps installed
  browserHistory.js  finds browsers and their profiles, reads AI chat pages from their history
  sqliteCopy.js      reads a copy of another program's SQLite file (browser history, the ChatGPT app)
  geminiCli.js       Gemini CLI session files
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
src/main/main.js the app process: window (full and compact), first-run setup, file watching, Downloads check
build/           the app icon (icon.svg → icon.png) for the installers
scripts/         build.js (the installers), make-icon.js
src/preload.js   the small bridge the window is allowed to use
src/renderer/    the window: its own title bar, platforms, list, details, settings, themes, thin scrollbars (scrollbars.js)
test/            unit tests with fake user folders (Windows, Mac, Linux) and fake browser histories
```

The app's own data lives in `%APPDATA%\AI Chat Manager\state.json`. Delete that file to reset the app.

Icons are from [Material Icons](https://fonts.google.com/icons) (Apache License 2.0).

## Not done yet

- **More platforms:** Meta AI, Qwen, Kimi, Character.AI and others. See "Adding another platform" above.
- **Full message history for websites other than Claude and ChatGPT.** The extension only sees the messages on the screen; for older ones, open the chat.
- **Checking the other sites' page reading on the real websites.** It was built and tested on pages shaped like them; Settings → Testing shows what it finds on the real ones.
- **A Safari version of the extension** (needs Xcode on a Mac).
- **Plain chats inside the desktop apps' own windows** (Claude Desktop's chats, ChatGPT's Chat mode, the Microsoft Copilot app). Desktop apps don't write a browser history, and they keep those chats on the companies' servers, or encrypted. Use the website or the export for them.
- Knowing when you read a Cowork, Code, Work or Codex reply inside that app itself.
- Opening a Cowork task or a Code session directly in Claude Desktop. For now: **Copy resume command** and **Folder**. (Work and Codex chats do open in the ChatGPT app.)
- Signed installers (no first-run warning), automatic updates, desktop notifications, a Linux package.
