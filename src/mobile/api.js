'use strict';

/**
 * iPad 端 window.mushu 的实现。
 *
 * 桌面端由 preload + ipcMain 提供这套接口；iPad 上没有主进程，
 * 这里直接在 WebView 内调用同一批 service 模块（通过虚拟文件系统落盘），
 * 再把结果按 {ok, data} 的形状返回，渲染层代码完全不用改。
 */

const fs = require('./shims/fs');
const path = require('./shims/path');
const storage = require('./storage');
const config = require('./config');
const ui = require('./ui');

const { readText, writeTextAtomic } = require('../main/services/fsutil');
const project = require('../main/services/project');
const chapters = require('../main/services/chapters');
const versions = require('../main/services/versions');
const stats = require('../main/services/stats');
const fm = require('../main/services/frontmatter');
const settings = require('../main/services/settings');
const shortcuts = require('../main/services/shortcuts');
const cast = require('../main/services/cast');
const canvas = require('../main/services/canvas');
const importer = require('../main/services/importer');
const analyze = require('../main/services/analyze');
const profile = require('../main/services/profile');
const ai = require('./ai-client');

const RECENT_LIMIT = 12;
const PROJECTS_ROOT = '/mushu/works';
const BACKUP_ROOT = '/mushu/backups';
const SETTINGS_FILE = '/mushu/settings.json';
const RECENT_FILE = '/mushu/recent.json';
const IMPORT_DIR = '/mushu/imports';

let store = null;
let readyResolve = null;
const ready = new Promise((resolve) => {
  readyResolve = resolve;
});
function markReady() {
  if (readyResolve) readyResolve();
  readyResolve = null;
}

function settingsStore() {
  if (!store) {
    store = settings.createStore(SETTINGS_FILE, () => ({
      projectsRoot: PROJECTS_ROOT,
      editorFont: '',
      editorSize: 18,
      editorLineHeight: 2,
      autoScrollMode: 'off',
      autoScrollPercent: 60,
      wheelChapterSwitch: false,
      highlight: { characters: true, settings: true, scope: 'chapter', style: 'underline' },
      backupRoot: BACKUP_ROOT,
      autoBackupWords: 2000,
      shortcuts: { ...shortcuts.DEFAULT_SHORTCUTS },
      autoLaunch: false,
      hardwareAcceleration: true,
      aiKeyEnc: '',
    }));
    versions.setRootResolver(() => settingsStore().load().backupRoot);
    ai.setKeyProvider(() => '');
  }
  return store;
}

function publicSettings(s) {
  const { aiKeyEnc, ...rest } = s || {};
  return {
    ...rest,
    aiKeySet: ai.keySource() !== '',
    aiKeySource: ai.keySource(),
  };
}

function projectsRoot(createIfMissing) {
  const root = settingsStore().load().projectsRoot;
  if (!root) return undefined;
  if (!fs.existsSync(root)) {
    if (!createIfMissing) return undefined;
    try {
      fs.mkdirSync(root, { recursive: true });
    } catch {
      return undefined;
    }
  }
  return root;
}

function requireProjectsRoot() {
  const root = settingsStore().load().projectsRoot;
  if (!root) throw new Error('还没有设置默认作品目录，请先在「设置」里指定');
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (err) {
    throw new Error(`默认作品目录不可用：${root}（${err.message}）`);
  }
  return root;
}

function loadRecent() {
  try {
    const list = JSON.parse(readText(RECENT_FILE, '[]'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function pushRecent(dir, book) {
  const list = loadRecent().filter((r) => r.dir !== dir);
  list.unshift({ dir, title: book.title, at: new Date().toISOString() });
  writeTextAtomic(RECENT_FILE, JSON.stringify(list.slice(0, RECENT_LIMIT), null, 2));
  return list.slice(0, RECENT_LIMIT);
}

// ---------------- 事件广播（对应 ipcRenderer.on） ----------------

const listeners = {
  aiDelta: new Set(),
  analyzeProgress: new Set(),
  menu: new Set(),
  windowState: new Set(),
};

function emit(set, payload) {
  for (const cb of set) {
    try {
      cb(payload);
    } catch {
      /* 单个监听器异常不影响其它 */
    }
  }
}

function ok(data) {
  return { ok: true, data };
}

function fail(err) {
  return { ok: false, error: err && err.message ? err.message : String(err) };
}

function handle(fn) {
  return async (payload) => {
    await ready;
    try {
      const data = await fn(payload || {});
      return ok(data);
    } catch (err) {
      return fail(err);
    }
  };
}

// ---------------- AI / 解析任务 ----------------

const aiJobs = new Map();
const analyzeJobs = new Map();

// ---------------- 文件选择 ----------------

function decodeFileText(buffer) {
  const bytes = new Uint8Array(buffer);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('gbk').decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
}

function pickTxtFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,text/plain';
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.appendChild(input);
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return done(null);
      try {
        const buf = await file.arrayBuffer();
        const text = decodeFileText(buf);
        const safeName = file.name.replace(/[\\/:*?"<>|]/g, '_');
        const dest = path.join(IMPORT_DIR, `${Date.now()}-${safeName}`);
        fs.mkdirSync(IMPORT_DIR, { recursive: true });
        fs.writeFileSync(dest, text, 'utf8');
        done(dest);
      } catch (err) {
        ui.toast('读取 TXT 失败：' + (err.message || err));
        done(null);
      }
    };
    input.click();
  });
}

async function pickDir(title) {
  if (title === '选择作品目录') return ui.pickWorkDir(requireProjectsRoot());
  ui.toast('iPad 版的作品统一存放在应用内，不支持选择外部目录');
  return null;
}

// ---------------- 接口表 ----------------

const impl = {
  // 文件选择
  pickDir: handle(async ({ title }) => pickDir(title)),
  pickTxt: handle(async () => pickTxtFile()),

  // 设置
  getSettings: handle(async () => publicSettings(settingsStore().load())),
  loginState: handle(async () => ({ openAtLogin: false })),
  setSettings: handle(async ({ patch }) => {
    const prev = settingsStore().load();
    let next = { ...(patch || {}) };
    let keyTouched = false;
    if ('aiKey' in next) {
      keyTouched = true;
      const value = String(next.aiKey == null ? '' : next.aiKey).trim();
      await ai.setKey(value);
      delete next.aiKey;
    }
    if ('aiKeyEnc' in next) {
      next.aiKeyEnc = prev.aiKeyEnc;
    }

    const requireDir = (value, label, emptyMsg) => {
      const root = String(value).trim();
      if (!root) throw new Error(emptyMsg);
      if (fs.existsSync(root) && !fs.statSync(root).isDirectory()) throw new Error(`${label}已存在但不是目录`);
      fs.mkdirSync(root, { recursive: true });
      return root;
    };
    if (next.projectsRoot != null) next = { ...next, projectsRoot: requireDir(next.projectsRoot, '默认作品目录', '默认作品目录不能为空') };
    if (next.backupRoot != null) next = { ...next, backupRoot: requireDir(next.backupRoot, '备份目录', '备份目录不能为空') };

    const clampNum = (v, min, max, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    };
    if (next.editorSize != null) next = { ...next, editorSize: clampNum(next.editorSize, 12, 40, 18) };
    if (next.editorLineHeight != null) next = { ...next, editorLineHeight: clampNum(next.editorLineHeight, 1.2, 3.5, 2) };
    if (next.editorFont != null) next = { ...next, editorFont: String(next.editorFont).trim() };
    if (next.uiScale != null) next = { ...next, uiScale: clampNum(next.uiScale, 0.7, 2, 1) };
    if (next.autoScrollPercent != null) next = { ...next, autoScrollPercent: clampNum(next.autoScrollPercent, 0, 90, 60) };
    if (next.autoBackupWords != null) next = { ...next, autoBackupWords: Math.round(clampNum(next.autoBackupWords, 0, 100000, 2000)) };
    if (next.autoScrollMode != null) next = { ...next, autoScrollMode: ['off', 'line', 'enter'].includes(next.autoScrollMode) ? next.autoScrollMode : 'off' };
    if (next.wheelChapterSwitch != null) next = { ...next, wheelChapterSwitch: Boolean(next.wheelChapterSwitch) };
    if (next.autoLaunch != null) next = { ...next, autoLaunch: Boolean(next.autoLaunch) };
    if (next.hardwareAcceleration != null) next = { ...next, hardwareAcceleration: Boolean(next.hardwareAcceleration) };
    if (next.highlight != null) {
      const h = next.highlight || {};
      next = {
        ...next,
        highlight: {
          characters: h.characters !== false,
          settings: h.settings !== false,
          scope: h.scope === 'always' ? 'always' : 'chapter',
          style: ['underline', 'background', 'bold'].includes(h.style) ? h.style : 'underline',
        },
      };
    }
    if (next.shortcuts != null) next = { ...next, shortcuts: shortcuts.normalizeShortcuts(next.shortcuts) };

    const saved = settingsStore().save(next);
    if (keyTouched) ai.setKeyProvider(() => '');
    if (next.backupRoot != null && prev.backupRoot && prev.backupRoot !== saved.backupRoot) {
      try {
        versions.migrateBackupRoot(prev.backupRoot, saved.backupRoot);
      } catch (err) {
        throw new Error('备份目录已修改，但旧数据迁移失败：' + err.message);
      }
    }
    return publicSettings(saved);
  }),

  // 作品
  createProject: handle(async ({ title, author }) => {
    const dir = project.resolveProjectDir(requireProjectsRoot(), title);
    const { book } = project.createProject(dir, { title, author });
    pushRecent(dir, book);
    return { project: project.openProject(dir), tree: chapters.tree(dir), recent: loadRecent() };
  }),

  openProject: handle(async ({ dir }) => {
    const proj = project.openProject(dir);
    pushRecent(dir, proj.book);
    versions.ensureLegacyMigrated(dir);
    return { project: proj, tree: chapters.tree(dir), recent: loadRecent() };
  }),

  importTxt: handle(async ({ file, title, author }) => {
    if (!file) throw new Error('没有选择 TXT 文件');
    const result = importer.importTxt({ file, title, author, root: requireProjectsRoot() });
    pushRecent(result.project.dir, result.project.book);
    return { ...result, recent: loadRecent() };
  }),

  recentProjects: handle(async () => loadRecent().filter((r) => fs.existsSync(r.dir))),
  updateBook: handle(async ({ dir, patch }) => project.updateBook(dir, patch)),

  // 大纲
  readOutline: handle(async ({ dir }) => readText(path.join(dir, 'bible', 'outline.md'), '')),
  saveOutline: handle(async ({ dir, body }) => {
    writeTextAtomic(path.join(dir, 'bible', 'outline.md'), String(body == null ? '' : body));
    return true;
  }),

  // 目录 / 章节
  tree: handle(async ({ dir }) => chapters.tree(dir)),
  searchChapters: handle(async ({ dir, query }) => chapters.search(dir, query)),
  chapterAppearances: handle(async ({ dir, terms }) => chapters.appearances(dir, terms)),
  readChapter: handle(async ({ dir, id }) => chapters.readChapter(dir, id)),
  saveChapter: handle(async ({ dir, id, meta, body }) => {
    const result = chapters.saveChapter(dir, id, { meta, body });
    const threshold = settingsStore().load().autoBackupWords;
    if (versions.noteSave(dir, result.delta, threshold)) {
      versions.snapshot(dir, id, readText(chapters.fromId(dir, id), ''));
    }
    stats.addWords(dir, id, result.delta);
    return { ...result, tree: chapters.tree(dir), stats: stats.summary(dir) };
  }),
  createChapter: handle(async ({ dir, volumePath, title }) => {
    const chapter = chapters.createChapter(dir, volumePath, title);
    return { chapter, tree: chapters.tree(dir) };
  }),
  createVolume: handle(async ({ dir, title }) => {
    const volume = chapters.createVolume(dir, title);
    return { volume, tree: chapters.tree(dir) };
  }),
  renameChapter: handle(async ({ dir, id, title }) => {
    const chapter = chapters.renameChapter(dir, id, title);
    return { chapter, tree: chapters.tree(dir) };
  }),
  renameVolume: handle(async ({ dir, path: volumePath, title }) => {
    const volume = chapters.renameVolume(dir, volumePath, title);
    return { volume, tree: chapters.tree(dir) };
  }),

  // 草稿
  saveDraft: handle(async ({ dir, id, meta, body }) => {
    chapters.saveDraft(dir, id, { meta, body });
    return true;
  }),
  discardDraft: handle(async ({ dir, id }) => {
    chapters.clearDraft(dir, id);
    return true;
  }),

  // 历史版本
  listVersions: handle(async ({ dir, id }) => versions.list(dir, id)),
  diffVersion: handle(async ({ dir, id, file }) => {
    const ver = versions.read(dir, id, file);
    const before = fm.split(ver.text).body;
    const after = chapters.readChapter(dir, id).body;
    return { before, after, hunks: versions.diffLines(before, after) };
  }),
  rollbackVersion: handle(async ({ dir, id, file }) => {
    const ver = versions.read(dir, id, file);
    const parsed = fm.split(ver.text);
    const abs = chapters.fromId(dir, id);
    versions.snapshot(dir, id, readText(abs, ''));
    chapters.saveChapter(dir, id, { meta: parsed.meta, body: parsed.body });
    return { chapter: chapters.readChapter(dir, id), tree: chapters.tree(dir) };
  }),
  stats: handle(async ({ dir }) => stats.summary(dir)),
  openFolder: handle(async () => true),

  snapshotNow: handle(async ({ dir, id }) => {
    const file = versions.snapshot(dir, id, readText(chapters.fromId(dir, id), ''));
    versions.resetPending(dir);
    return { file, list: versions.list(dir, id) };
  }),
  backupRootPath: handle(async ({ dir }) => ({
    backupRoot: settingsStore().load().backupRoot,
    projectDir: dir ? versions.versionBase(dir) : null,
  })),
  cleanCache: handle(async ({ dir }) => {
    let bytes = 0;
    const removeFile = (p, size) => {
      try {
        fs.unlinkSync(p);
        bytes += Number(size) || 0;
      } catch {
        /* 忽略单个文件失败 */
      }
    };
    const draftsDir = path.join(dir, '.mushu', 'drafts');
    for (const e of fs.existsSync(draftsDir) ? fs.readdirSync(draftsDir, { withFileTypes: true }) : []) {
      if (!e.isFile()) continue;
      const p = path.join(draftsDir, e.name);
      removeFile(p, fs.existsSync(p) ? fs.statSync(p).size : 0);
    }
    const mushuDir = path.join(dir, '.mushu');
    for (const e of fs.existsSync(mushuDir) ? fs.readdirSync(mushuDir, { withFileTypes: true }) : []) {
      if (e.isFile() && /\.tmp-\d+-\d+$/.test(e.name)) {
        const p = path.join(mushuDir, e.name);
        removeFile(p, fs.existsSync(p) ? fs.statSync(p).size : 0);
      }
    }
    versions.resetPending(dir);
    return { bytes };
  }),

  // 设定库 / 画布
  readCast: handle(async ({ dir }) => cast.read(dir)),
  saveCast: handle(async ({ dir, data }) => cast.save(dir, data)),
  readCanvas: handle(async ({ dir }) => canvas.read(dir)),
  saveCanvas: handle(async ({ dir, data }) => canvas.save(dir, data)),
  analyzeProfile: handle(async ({ dir, ...payload }) => profile.analyze({ dir, ...payload })),

  registerShortcuts: handle(async () => ({})),

  // AI 助手
  aiChat: handle(async ({ id, messages }) => {
    const jobId = String(id || '');
    const controller = new AbortController();
    if (jobId) aiJobs.set(jobId, controller);
    try {
      const text = await ai.chat({
        messages: Array.isArray(messages) ? messages : [],
        signal: controller.signal,
        onDelta: (piece) => emit(listeners.aiDelta, { id: jobId, text: piece }),
      });
      return { text };
    } catch (err) {
      if (controller.signal.aborted) return { text: '', cancelled: true };
      throw err;
    } finally {
      if (jobId && aiJobs.get(jobId) === controller) aiJobs.delete(jobId);
    }
  }),
  aiCancel: handle(async ({ id }) => {
    const controller = aiJobs.get(String(id || ''));
    if (controller) controller.abort();
    return true;
  }),
  onAiDelta: (cb) => {
    listeners.aiDelta.add(cb);
  },
  aiKeyStatus: handle(async () => ({ configured: ai.apiKey() !== '', source: ai.keySource() })),
  aiKeySet: handle(async ({ key }) => {
    const value = String(key == null ? '' : key).trim();
    return ai.setKey(value);
  }),

  // 智能解析
  analyzeRun: handle(async ({ id, dir, budget, force }) => {
    if (!dir) throw new Error('请先打开一个作品');
    const jobId = String(id || '');
    const controller = new AbortController();
    if (jobId) analyzeJobs.set(jobId, controller);
    try {
      return await analyze.run({
        dir,
        budget,
        force: !!force,
        signal: controller.signal,
        onProgress: (p) => emit(listeners.analyzeProgress, { id: jobId, ...p }),
      });
    } catch (err) {
      if (controller.signal.aborted) throw new Error('已取消分析');
      throw err;
    } finally {
      if (jobId && analyzeJobs.get(jobId) === controller) analyzeJobs.delete(jobId);
    }
  }),
  analyzeCancel: handle(async ({ id }) => {
    const controller = analyzeJobs.get(String(id || ''));
    if (controller) controller.abort();
    return true;
  }),
  analyzeApply: handle(async ({ dir, result, selectedKeys, writePoints }) => {
    if (!dir) throw new Error('请先打开一个作品');
    return analyze.apply({ dir, result, selectedKeys, writePoints: !!writePoints });
  }),
  onAnalyzeProgress: (cb) => {
    listeners.analyzeProgress.add(cb);
  },

  // 无边框窗口控制：iPad 没有窗口概念，全部安全降级
  minimize: handle(async () => true),
  toggleMaximize: handle(async () => false),
  toggleFullScreen: handle(async () => false),
  closeWindow: handle(async () => true),
  windowState: handle(async () => ({ maximized: false, fullScreen: false })),
  setZoom: handle(async ({ factor }) => {
    const value = Math.min(2, Math.max(0.7, Number(factor) || 1));
    document.documentElement.style.zoom = String(value);
    return true;
  }),
  popupMenu: async () => {
    const actions = [
      { key: 'newProject', label: '新建作品…' },
      { key: 'openProject', label: '打开作品…' },
      { key: 'closeProject', label: '关闭作品' },
      { sep: true },
      { key: 'settings', label: '设置…' },
      { key: 'server', label: '服务器连接…' },
      { sep: true },
      { key: 'save', label: '立即保存' },
      { key: 'focusMode', label: '专注模式' },
      { key: 'versions', label: '版本历史' },
      { key: 'outline', label: '故事大纲' },
      { key: 'canvas', label: '无限画布' },
      { sep: true },
      { key: 'zoomReset', label: '重置缩放' },
      { key: 'zoomIn', label: '放大' },
      { key: 'zoomOut', label: '缩小' },
      { key: 'openFolder', label: '作品目录' },
      { key: 'about', label: '关于墨枢' },
    ];
    ui.showMenu(actions, (action) => {
      // 服务器地址/密码随时可改：这条在 iPad 上没有对应的桌面菜单项，直接开连接向导
      if (action === 'server') {
        if (typeof window.__mushuOpenSetup === 'function') window.__mushuOpenSetup();
        return;
      }
      emit(listeners.menu, action);
    });
  },
  onWindowState: (cb) => {
    listeners.windowState.add(cb);
  },
  onMenu: (cb) => {
    listeners.menu.add(cb);
  },
};

/**
 * 对外接口：签名必须与 preload.js 完全一致（渲染层是按位置参数调用的）。
 */
const api = {
  pickDir: (title) => impl.pickDir({ title }),
  pickTxt: () => impl.pickTxt(),

  getSettings: () => impl.getSettings(),
  setSettings: (patch) => impl.setSettings({ patch }),
  loginState: () => impl.loginState(),

  createProject: (payload) => impl.createProject(payload),
  importTxt: (payload) => impl.importTxt(payload),
  openProject: (dir) => impl.openProject({ dir }),
  recentProjects: () => impl.recentProjects(),
  updateBook: (dir, patch) => impl.updateBook({ dir, patch }),

  readOutline: (dir) => impl.readOutline({ dir }),
  saveOutline: (dir, body) => impl.saveOutline({ dir, body }),

  tree: (dir) => impl.tree({ dir }),
  searchChapters: (dir, query) => impl.searchChapters({ dir, query }),
  chapterAppearances: (dir, terms) => impl.chapterAppearances({ dir, terms }),
  readChapter: (dir, id) => impl.readChapter({ dir, id }),
  saveChapter: (dir, id, meta, body) => impl.saveChapter({ dir, id, meta, body }),
  createChapter: (dir, volumePath, title) => impl.createChapter({ dir, volumePath, title }),
  createVolume: (dir, title) => impl.createVolume({ dir, title }),
  renameChapter: (dir, id, title) => impl.renameChapter({ dir, id, title }),
  renameVolume: (dir, volumePath, title) => impl.renameVolume({ dir, path: volumePath, title }),

  saveDraft: (dir, id, meta, body) => impl.saveDraft({ dir, id, meta, body }),
  discardDraft: (dir, id) => impl.discardDraft({ dir, id }),

  listVersions: (dir, id) => impl.listVersions({ dir, id }),
  diffVersion: (dir, id, file) => impl.diffVersion({ dir, id, file }),
  rollbackVersion: (dir, id, file) => impl.rollbackVersion({ dir, id, file }),

  stats: (dir) => impl.stats({ dir }),
  openFolder: (dir) => impl.openFolder({ dir }),

  snapshotNow: (dir, id) => impl.snapshotNow({ dir, id }),
  backupRootPath: (dir) => impl.backupRootPath({ dir }),
  cleanCache: (dir) => impl.cleanCache({ dir }),

  readCast: (dir) => impl.readCast({ dir }),
  saveCast: (dir, data) => impl.saveCast({ dir, data }),
  readCanvas: (dir) => impl.readCanvas({ dir }),
  saveCanvas: (dir, data) => impl.saveCanvas({ dir, data }),
  analyzeProfile: (dir, payload) => impl.analyzeProfile({ dir, ...(payload || {}) }),

  registerShortcuts: () => impl.registerShortcuts(),

  aiChat: (id, messages) => impl.aiChat({ id, messages }),
  aiCancel: (id) => impl.aiCancel({ id }),
  onAiDelta: (cb) => impl.onAiDelta(cb),
  aiKeyStatus: () => impl.aiKeyStatus(),
  aiKeySet: (key) => impl.aiKeySet({ key }),

  analyzeRun: (id, dir, budget, force) => impl.analyzeRun({ id, dir, budget, force }),
  analyzeCancel: (id) => impl.analyzeCancel({ id }),
  analyzeApply: (dir, result, selectedKeys, writePoints) => impl.analyzeApply({ dir, result, selectedKeys, writePoints }),
  onAnalyzeProgress: (cb) => impl.onAnalyzeProgress(cb),

  minimize: () => impl.minimize(),
  toggleMaximize: () => impl.toggleMaximize(),
  toggleFullScreen: () => impl.toggleFullScreen(),
  closeWindow: () => impl.closeWindow(),
  windowState: () => impl.windowState(),
  setZoom: (factor) => impl.setZoom({ factor }),
  popupMenu: () => impl.popupMenu(),
  onWindowState: (cb) => impl.onWindowState(cb),
  onMenu: (cb) => impl.onMenu(cb),
};

function expose() {
  window.mushu = api;
}

module.exports = { expose, markReady, ready, settingsStore, PROJECTS_ROOT, BACKUP_ROOT };
