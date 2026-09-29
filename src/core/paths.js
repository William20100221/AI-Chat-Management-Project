'use strict';

// Where Claude keeps its files on this computer.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Folders inside a Claude Desktop data folder that hold session records.
// Anthropic is moving Cowork from the first name to the second, so both are read.
const SESSION_ROOTS = ['local-agent-mode-sessions', 'claude-code-sessions'];

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Claude Desktop's data folder. The Microsoft Store version keeps it inside its package
// folder (Packages\Claude_<id>\LocalCache\Roaming\Claude); the regular installer uses %APPDATA%\Claude.
function claudeDesktopDirs({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const candidates = [];
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const packages = path.join(localAppData, 'Packages');
    try {
      for (const name of fs.readdirSync(packages)) {
        if (/^Claude_/i.test(name)) candidates.push(path.join(packages, name, 'LocalCache', 'Roaming', 'Claude'));
      }
    } catch {
      // no Store apps folder
    }
    candidates.push(path.join(appData, 'Claude'));
  } else if (platform === 'darwin') {
    candidates.push(path.join(home, 'Library', 'Application Support', 'Claude'));
  } else {
    candidates.push(path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude'));
  }
  return [...new Set(candidates)].filter(isDir);
}

// Claude Code (terminal and the desktop Code tab) writes transcripts to ~/.claude/projects.
function claudeProjectsDir({ env = process.env, home = os.homedir() } = {}) {
  const base = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  return path.join(base, 'projects');
}

function locateSources(options = {}) {
  const desktopDirs = claudeDesktopDirs(options);
  const sessionRoots = [];
  for (const dir of desktopDirs) {
    for (const name of SESSION_ROOTS) {
      const root = path.join(dir, name);
      sessionRoots.push({ root, name, exists: isDir(root) });
    }
  }
  const projectsDir = claudeProjectsDir(options);
  return { desktopDirs, sessionRoots, projectsDir, projectsDirExists: isDir(projectsDir) };
}

module.exports = { locateSources, claudeDesktopDirs, claudeProjectsDir, SESSION_ROOTS };
