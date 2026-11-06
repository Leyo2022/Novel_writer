'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** 渲染进程唯一入口：只暴露白名单方法，不暴露 ipcRenderer 本体 */
const api = {
  pickDir: (title, defaultPath) => ipcRenderer.invoke('dialog:pickDir', { title, defaultPath }),
  pickTxt: () => ipcRenderer.invoke('dialog:pickTxt'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', { patch }),
  loginState: () => ipcRenderer.invoke('settings:loginState'),

  createProject: (payload) => ipcRenderer.invoke('project:create', payload),
  importTxt: (payload) => ipcRenderer.invoke('project:importTxt', payload),
  openProject: (dir) => ipcRenderer.invoke('project:open', { dir }),
  recentProjects: () => ipcRenderer.invoke('project:recent'),
  updateBook: (dir, patch) => ipcRenderer.invoke('project:updateBook', { dir, patch }),

  readOutline: (dir) => ipcRenderer.invoke('outline:read', { dir }),
  saveOutline: (dir, body) => ipcRenderer.invoke('outline:save', { dir, body }),

  tree: (dir) => ipcRenderer.invoke('chapters:tree', { dir }),
  searchChapters: (dir, query) => ipcRenderer.invoke('chapters:search', { dir, query }),
  chapterAppearances: (dir, terms) => ipcRenderer.invoke('chapters:appearances', { dir, terms }),
  readChapter: (dir, id) => ipcRenderer.invoke('chapters:read', { dir, id }),
  saveChapter: (dir, id, meta, body) => ipcRenderer.invoke('chapters:save', { dir, id, meta, body }),
  createChapter: (dir, volumePath, title) => ipcRenderer.invoke('chapters:create', { dir, volumePath, title }),
  createVolume: (dir, title) => ipcRenderer.invoke('volume:create', { dir, title }),
  renameChapter: (dir, id, title) => ipcRenderer.invoke('chapters:rename', { dir, id, title }),
  renameVolume: (dir, volumePath, title) => ipcRenderer.invoke('volume:rename', { dir, path: volumePath, title }),

  saveDraft: (dir, id, meta, body) => ipcRenderer.invoke('draft:save', { dir, id, meta, body }),
  discardDraft: (dir, id) => ipcRenderer.invoke('draft:discard', { dir, id }),

  listVersions: (dir, id) => ipcRenderer.invoke('versions:list', { dir, id }),
  diffVersion: (dir, id, file) => ipcRenderer.invoke('versions:diff', { dir, id, file }),
  rollbackVersion: (dir, id, file) => ipcRenderer.invoke('versions:rollback', { dir, id, file }),

  stats: (dir) => ipcRenderer.invoke('stats:summary', { dir }),
  openFolder: (dir) => ipcRenderer.invoke('shell:openPath', { dir }),

  // 备份缓存 / 历史版本
  snapshotNow: (dir, id) => ipcRenderer.invoke('versions:snapshotNow', { dir, id }),
  backupRootPath: (dir) => ipcRenderer.invoke('versions:root', { dir }),
  cleanCache: (dir) => ipcRenderer.invoke('backup:cleanCache', { dir }),

  // 设定库（角色 / 设定词条）
  readCast: (dir) => ipcRenderer.invoke('cast:read', { dir }),
  saveCast: (dir, data) => ipcRenderer.invoke('cast:save', { dir, data }),

  // 无限画布（角色卡片 + 故事线）
  readCanvas: (dir) => ipcRenderer.invoke('canvas:read', { dir }),
  saveCanvas: (dir, data) => ipcRenderer.invoke('canvas:save', { dir, data }),
  analyzeProfile: (dir, payload) => ipcRenderer.invoke('profile:analyze', { dir, ...(payload || {}) }),

  // 快捷键（老板键需在主进程注册为全局快捷键）
  registerShortcuts: () => ipcRenderer.invoke('shortcut:register'),

  // AI 助手（DeepSeek）：请求期间用 onAiDelta 流式推送增量文本
  aiChat: (id, messages) => ipcRenderer.invoke('ai:chat', { id, messages }),
  aiCancel: (id) => ipcRenderer.invoke('ai:cancel', { id }),
  onAiDelta: (cb) => {
    ipcRenderer.on('ai:delta', (_e, payload) => cb(payload));
  },

  // 密钥：只回传状态，密文留在主进程；写入走 safeStorage 加密
  aiKeyStatus: () => ipcRenderer.invoke('ai:keyStatus'),
  aiKeySet: (key) => ipcRenderer.invoke('ai:keySet', { key }),

  // 智能解析：长任务，进度通过 onAnalyzeProgress 推送；结果先预览，确认后再写入画布
  analyzeRun: (id, dir, budget, force) => ipcRenderer.invoke('analyze:run', { id, dir, budget, force }),
  analyzeCancel: (id) => ipcRenderer.invoke('analyze:cancel', { id }),
  analyzeApply: (dir, result, selectedKeys, writePoints) =>
    ipcRenderer.invoke('analyze:apply', { dir, result, selectedKeys, writePoints }),
  onAnalyzeProgress: (cb) => {
    ipcRenderer.on('analyze:progress', (_e, payload) => cb(payload));
  },

  // 无边框窗口的自绘控制
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
  toggleFullScreen: () => ipcRenderer.invoke('window:toggleFullScreen'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  windowState: () => ipcRenderer.invoke('window:state'),
  setZoom: (factor) => ipcRenderer.invoke('window:setZoom', { factor }),
  popupMenu: () => ipcRenderer.invoke('menu:popup'),
  onWindowState: (cb) => {
    ipcRenderer.on('window:state', (_e, st) => cb(st));
  },

  onMenu: (cb) => {
    ipcRenderer.on('menu:action', (_e, action) => cb(action));
  },
};

contextBridge.exposeInMainWorld('mushu', api);
