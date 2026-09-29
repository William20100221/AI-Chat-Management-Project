# AI Chat Manager

A sticky note for your AI chats. It shows which Claude chats, Cowork tasks and Code sessions you've been working on lately, so you can pick up where you left off.

- **Working** list: everything active in the last *X* days (you choose *X*), newest first.
- **Pin** something to keep it in Working, or **mark it done** to take it out.
- Click any item to see its first message, last message and all of your questions, so you can tell which chat it is.
- Search titles *and* the questions you asked.

Everything stays on your computer. The app only **reads** files; it never changes Claude's files and never sends anything anywhere.

## Where the data comes from

| Source | How it gets in | Updates |
|---|---|---|
| **Cowork tasks** (Claude Desktop) | Read from Claude Desktop's session files | Automatically, within seconds |
| **Code sessions** (Claude Desktop Code tab and the `claude` terminal) | Read from Claude Code's transcripts in `%USERPROFILE%\.claude\projects` | Automatically, within seconds |
| **Normal chats** | From your Claude data export: in Claude go to **Settings → Privacy → Export data** and download the zip from the email | Automatically when the zip lands in your Downloads folder |

Normal chats are stored on Anthropic's servers, not on your computer, which is why they come from the export. The app does not log in to your account or use your cookies. That would break Claude's terms of use and put your account at risk.

Claude Desktop folders the app looks in (Windows):

- Microsoft Store version: `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\`
- Regular installer: `%APPDATA%\Claude\`

Inside those, `local-agent-mode-sessions\` (Cowork) and `claude-code-sessions\` (Code tab). **Settings → Sources** in the app shows what was found and how many items each source has.

These are Claude's internal files, not a documented format, so a Claude update can change them. If a source suddenly shows 0 items or errors, that is the first thing to check.

## Run it

**Windows, ready-made:** unzip `AI-Chat-Manager-win32-x64.zip` anywhere and double-click `AI Chat Manager.exe`. Windows SmartScreen may warn because the app isn't signed yet: choose *More info → Run anyway*.

**From source** (needs [Node.js](https://nodejs.org) 20 or newer):

```
npm install
npm start
```

Run the tests with `npm test`. Build the Windows app with `npm run dist:win` (output in `dist\`).

## How it's built

Electron, plain HTML/CSS/JavaScript, no framework and no build step.

```
src/core/        reading and combining the sources (no Electron code, fully tested)
  paths.js           where Claude keeps its files
  desktopSessions.js Claude Desktop session records (Cowork and Code tab)
  transcript.js      Claude Code .jsonl transcripts: titles, questions, first/last message
  chatExport.js      the claude.ai data export zip, and spotting it in Downloads
  scanner.js         combines everything into one list, re-reading only changed files
  status.js          working / done / not recently active
  store.js           your settings, pins and done marks (state.json in the app data folder)
src/main/main.js the app process: window, file watching, Downloads check
src/preload.js   the small bridge the window is allowed to use
src/renderer/    the window: list, details, settings
test/            unit tests with a fake Windows user folder
```

The app's own data lives in `%APPDATA%\AI Chat Manager\state.json`. Delete that file to reset the app.

## Not done yet

- Live updates for normal chats without re-exporting (reading Claude Desktop's local cache, or reading the Claude window like a screen reader does).
- ChatGPT, Gemini and other platforms. The export importer is written so another format can be added next to Claude's.
- Opening a Cowork task or Code session directly inside Claude Desktop. For now, Code sessions have **Copy resume command** and **Open folder**; chats open on claude.ai in your browser.
- App icon, installer, start with Windows.
