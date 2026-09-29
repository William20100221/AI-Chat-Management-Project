'use strict';

// The only bridge between the window and the rest of the app. The window itself has no file access.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSnapshot: () => ipcRenderer.invoke('snapshot:get'),
  search: (query) => ipcRenderer.invoke('items:search', query),
  getDetail: (id) => ipcRenderer.invoke('item:detail', id),
  mark: (id, mark) => ipcRenderer.invoke('item:mark', id, mark),
  markSeen: (ids) => ipcRenderer.invoke('items:seen', ids),
  openChat: (id) => ipcRenderer.invoke('item:open-chat', id),
  openFolder: (id) => ipcRenderer.invoke('item:open-folder', id),
  copyResume: (id) => ipcRenderer.invoke('item:copy-resume', id),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  importExport: () => ipcRenderer.invoke('export:import'),
  downloadExport: () => ipcRenderer.invoke('export:download'),
  dismissExport: () => ipcRenderer.invoke('export:dismiss'),
  refresh: () => ipcRenderer.invoke('scan:refresh'),
  openSource: (index) => ipcRenderer.invoke('source:open', index),
  openExtensionFolder: () => ipcRenderer.invoke('extension:open-folder'),
  openWebsite: (platform) => ipcRenderer.invoke('extension:open-website', platform),
  resyncExtension: () => ipcRenderer.invoke('extension:resync'),
  finishSetup: (choices) => ipcRenderer.invoke('setup:finish', choices),
  runSetupAgain: () => ipcRenderer.invoke('setup:again'),
  openPrivacySettings: () => ipcRenderer.invoke('system:open-privacy'),
  copyText: (text) => ipcRenderer.invoke('clipboard:copy', text),
  unlockTesting: (password) => ipcRenderer.invoke('testing:unlock', password),
  lockTesting: () => ipcRenderer.invoke('testing:lock'),
  resetData: (options) => ipcRenderer.invoke('testing:reset', options),
  setTestingPassword: (password) => ipcRenderer.invoke('testing:set-password', password),
  useDefaultTestingPassword: () => ipcRenderer.invoke('testing:default-password'),
  onSnapshot: (callback) => ipcRenderer.on('snapshot', (_event, value) => callback(value)),
  onNotice: (callback) => ipcRenderer.on('notice', (_event, value) => callback(value)),
});
