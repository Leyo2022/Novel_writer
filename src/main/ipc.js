'use strict';

const path = require('path');
const fs = require('fs');
const { ipcMain, dialog, app, BrowserWindow, safeStorage } = require('electron');
const { readText, writeTextAtomic } = require('./services/fsutil');
const project = require('./services/project');
const chapters = require('./services/chapters');
const versions = require('./services/versions');
const stats = require('./services/stats');
const fm = require('./services/frontmatter');
const settings = require('./services/settings');
const shortcuts = require('./services/shortcuts');
const cast = require('./services/cast');
const canvas = require('./services/canvas');
const importer = require('./services/importer');
const ai = require('./services/ai');
const analyze = require('./services/analyze');
const profile = require('./services/profile');

const RECENT_LIMIT = 12;

function defaultBackupRoot() {
  return path.join(app.getPath('documents'), '墨枢备份');
}

/** 安装向导中选定的作品目录：安装器把它写在 $INSTDIR\data-dir.txt（UTF-16LE 带 BOM） */
function installedProjectsRoot() {
  if (!app.isPackaged) return '';
  try {
    const file = path.join(path.dirname(process.execPath), 'data-dir.txt');
    if (!fs.existsSync(file)) return '';
    return fs.readFileSync(file, 'utf16le').replace(/^\uFEFF+/, '').trim();
  } catch {
    return '';
  }
}

/** 设置存储：作品目录等偏好，落在 userData/settings.json */
let store = null;
function settingsStore() {
  if (!store) {
    store = settings.createStore(path.join(app.getPath('userData'), 'settings.json'), () => ({
      projectsRoot: installedProjectsRoot() || path.join(app.getPath('documents'), '墨枢作品'),
      editorFont: '', // 空串 = 用样式表里的内置字体栈
      editorSize: 18,
      editorLineHeight: 2,
      // 写作
      autoScrollMode: 'off', // off | line | enter
      autoScrollPercent: 60,
      wheelChapterSwitch: false,
      highlight: { characters: true, settings: true, scope: 'chapter', style: 'underline' },
      // 备份缓存
      backupRoot: defaultBackupRoot(),
      autoBackupWords: 2000, // 0 = 每次保存都存快照
      // 快捷键与其它
      shortcuts: { ...shortcuts.DEFAULT_SHORTCUTS },
      autoLaunch: false,
      hardwareAcceleration: true,
      // AI：密钥用系统 safeStorage 加密后存这里（base64），永不落明文
      aiKeyEnc: '',
    }));
    // 版本快照的存放根跟随设置
    versions.setRootResolver(() => settingsStore().load().backupRoot);
    // 让 AI 服务能从设置里取到解密后的密钥（环境变量 / .env 仍然优先）
    ai.setKeyProvider(() => decryptKey(settingsStore().load().aiKeyEnc));
  }
  return store;
}

/** 系统级加密；不可用时返回空串，由调用方给出明确提示 */
function encryptKey(key) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统不支持安全存储，无法保存 API Key');
  return safeStorage.encryptString(String(key)).toString('base64');
}

function decryptKey(enc) {
  const raw = String(enc || '').trim();
  if (!raw) return '';
  try {
    return safeStorage.decryptString(Buffer.from(raw, 'base64'));
  } catch {
    return '';
  }
}

/** 发给渲染层的设置：剥掉密钥密文，只告诉它有没有配置、来源是什么 */
function publicSettings(s) {
  const { aiKeyEnc, ...rest } = s || {};
  let source = '';
  try {
    source = ai.keySource();
  } catch {
    source = '';
  }
  return { ...rest, aiKeySet: !!aiKeyEnc, aiKeySource: source };
}

/** 新建/打开作品的默认落地目录；不存在就建出来，避免选择器回落到奇怪的位置 */
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

/** 新建作品必须能落到默认目录，拿不到就直接报错，不静默换地方 */
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

function recentFile() {
  return path.join(app.getPath('userData'), 'recent.json');
}

function loadRecent() {
  try {
    const list = JSON.parse(readText(recentFile(), '[]'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function pushRecent(dir, book) {
  const list = loadRecent().filter((r) => r.dir !== dir);
  list.unshift({ dir, title: book.title, at: new Date().toISOString() });
  writeTextAtomic(recentFile(), JSON.stringify(list.slice(0, RECENT_LIMIT), null, 2));
  return list.slice(0, RECENT_LIMIT);
}

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

function ok(data) {
  return { ok: true, data };
}

function fail(err) {
  return { ok: false, error: err && err.message ? err.message : String(err) };
}

/** 统一包装 handler：任何异常都以 {ok:false,error} 返回，避免渲染进程拿到未捕获的 rejection */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      return ok(await fn(payload || {}));
    } catch (err) {
      return fail(err);
    }
  });
}

function register() {
  // AI 助手：请求期间用 ai:delta 把增量文本推回渲染层，取消通过 ai:cancel 触发
  const aiJobs = new Map();

  handle('ai:chat', async ({ id, messages }) => {
    const jobId = String(id || '');
    const controller = new AbortController();
    if (jobId) aiJobs.set(jobId, controller);
    try {
      const text = await ai.chat({
        messages: Array.isArray(messages) ? messages : [],
        signal: controller.signal,
        onDelta: (text2) => broadcast('ai:delta', { id: jobId, text: text2 }),
      });
      return { text };
    } catch (err) {
      if (controller.signal.aborted) return { text: '', cancelled: true };
      throw err;
    } finally {
      if (jobId && aiJobs.get(jobId) === controller) aiJobs.delete(jobId);
    }
  });

  handle('ai:cancel', async ({ id }) => {
    const controller = aiJobs.get(String(id || ''));
    if (controller) controller.abort();
    return true;
  });

  handle('dialog:pickDir', async ({ title, defaultPath, useProjectsRoot }) => {
    const fallback = useProjectsRoot === false ? undefined : projectsRoot(true);
    const res = await dialog.showOpenDialog({
      title: title || '选择目录',
      defaultPath: defaultPath || fallback,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  handle('settings:get', async () => publicSettings(settingsStore().load()));

  // AI 助手密钥：单独读写，方便设置页即时显示「已配置 / 未配置」
  handle('ai:keyStatus', async () => ({ configured: !!ai.apiKey(), source: ai.keySource() }));

  handle('ai:keySet', async ({ key }) => {
    const value = String(key == null ? '' : key).trim();
    const aiKeyEnc = value ? encryptKey(value) : '';
    settingsStore().save({ aiKeyEnc });
    settingsStore(); // 确保 provider 已注入
    ai.setKeyProvider(() => decryptKey(settingsStore().load().aiKeyEnc));
    return { configured: !!ai.apiKey(), source: ai.keySource() };
  });

  // 全书分析：长任务，进度通过 analyze:progress 广播；取消通过 analyze:cancel
  const analyzeJobs = new Map();

  handle('analyze:run', async ({ id, dir, budget, force }) => {
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
        onProgress: (p) => broadcast('analyze:progress', { id: jobId, ...p }),
      });
    } catch (err) {
      if (controller.signal.aborted) throw new Error('已取消分析');
      throw err;
    } finally {
      if (jobId && analyzeJobs.get(jobId) === controller) analyzeJobs.delete(jobId);
    }
  });

  handle('analyze:cancel', async ({ id }) => {
    const controller = analyzeJobs.get(String(id || ''));
    if (controller) controller.abort();
    return true;
  });

  handle('analyze:apply', async ({ dir, result, selectedKeys, writePoints }) => {
    if (!dir) throw new Error('请先打开一个作品');
    return analyze.apply({ dir, result, selectedKeys, writePoints: !!writePoints });
  });

  handle('settings:set', async ({ patch }) => {
    const prev = settingsStore().load();
    let next = { ...(patch || {}) };
    let keyTouched = false;
    // 密钥只允许通过 ai:keySet 写入；渲染层即使带上密文也一律忽略
    if ('aiKey' in next) {
      keyTouched = true;
      const value = String(next.aiKey == null ? '' : next.aiKey).trim();
      if (value) next.aiKeyEnc = encryptKey(value);
      delete next.aiKey;
    } else if ('aiKeyEnc' in next) {
      next.aiKeyEnc = prev.aiKeyEnc; // 渲染层不允许直接改密文
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
    if (keyTouched) ai.setKeyProvider(() => decryptKey(settingsStore().load().aiKeyEnc));

    // 备份根变更后把旧的历史版本迁移到新位置
    if (next.backupRoot != null && prev.backupRoot && prev.backupRoot !== saved.backupRoot) {
      try {
        versions.migrateBackupRoot(prev.backupRoot, saved.backupRoot);
      } catch (err) {
        throw new Error('备份目录已修改，但旧数据迁移失败：' + err.message);
      }
    }
    // 开机自启立即生效
    if (next.autoLaunch != null) {
      try {
        app.setLoginItemSettings({ openAtLogin: saved.autoLaunch });
      } catch {
        /* 平台不支持则忽略 */
      }
    }
    return publicSettings(saved);
  });

  handle('settings:loginState', async () => {
    try {
      return { openAtLogin: !!app.getLoginItemSettings().openAtLogin };
    } catch {
      return { openAtLogin: false };
    }
  });

  handle('project:create', async ({ title, author }) => {
    // 不弹目录选择器：按书名在默认作品目录下自动建文件夹，重名自动加 (1) (2) …
    const dir = project.resolveProjectDir(requireProjectsRoot(), title);
    const { book } = project.createProject(dir, { title, author });
    pushRecent(dir, book);
    return { project: project.openProject(dir), tree: chapters.tree(dir), recent: loadRecent() };
  });

  handle('project:open', async ({ dir }) => {
    const proj = project.openProject(dir);
    pushRecent(dir, proj.book);
    versions.ensureLegacyMigrated(dir); // 老作品的历史版本首次打开时迁到备份根
    return { project: proj, tree: chapters.tree(dir), recent: loadRecent() };
  });

  // TXT 小说导入：选文件 → 按章节标题切分 → 建作品
  handle('dialog:pickTxt', async () => {
    const res = await dialog.showOpenDialog({
      title: '选择 TXT 小说',
      filters: [{ name: '文本文件', extensions: ['txt'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  handle('project:importTxt', async ({ file, title, author }) => {
    const result = importer.importTxt({ file, title, author, root: requireProjectsRoot() });
    pushRecent(result.project.dir, result.project.book);
    return { ...result, recent: loadRecent() };
  });

  handle('project:recent', async () => loadRecent().filter((r) => fs.existsSync(r.dir)));

  handle('project:updateBook', async ({ dir, patch }) => project.updateBook(dir, patch));

  // 故事大纲：一个作品一份，落在 bible/outline.md（纯 Markdown，可直接手改）
  handle('outline:read', async ({ dir }) => readText(path.join(dir, 'bible', 'outline.md'), ''));

  handle('outline:save', async ({ dir, body }) => {
    writeTextAtomic(path.join(dir, 'bible', 'outline.md'), String(body == null ? '' : body));
    return true;
  });

  handle('chapters:tree', async ({ dir }) => chapters.tree(dir));

  handle('chapters:search', async ({ dir, query }) => chapters.search(dir, query));

  handle('chapters:appearances', async ({ dir, terms }) => chapters.appearances(dir, terms));

  handle('chapters:read', async ({ dir, id }) => chapters.readChapter(dir, id));

  handle('chapters:save', async ({ dir, id, meta, body }) => {
    const result = chapters.saveChapter(dir, id, { meta, body });
    // 按「每 N 字」策略决定是否生成历史版本，避免频繁写入
    const threshold = settingsStore().load().autoBackupWords;
    if (versions.noteSave(dir, result.delta, threshold)) {
      versions.snapshot(dir, id, readText(chapters.fromId(dir, id), ''));
    }
    stats.addWords(dir, id, result.delta);
    return { ...result, tree: chapters.tree(dir), stats: stats.summary(dir) };
  });

  handle('chapters:create', async ({ dir, volumePath, title }) => {
    const chapter = chapters.createChapter(dir, volumePath, title);
    return { chapter, tree: chapters.tree(dir) };
  });

  handle('volume:create', async ({ dir, title }) => {
    const volume = chapters.createVolume(dir, title);
    return { volume, tree: chapters.tree(dir) };
  });

  handle('chapters:rename', async ({ dir, id, title }) => {
    const chapter = chapters.renameChapter(dir, id, title);
    return { chapter, tree: chapters.tree(dir) };
  });

  handle('volume:rename', async ({ dir, path: volumePath, title }) => {
    const volume = chapters.renameVolume(dir, volumePath, title);
    return { volume, tree: chapters.tree(dir) };
  });

  handle('draft:save', async ({ dir, id, meta, body }) => {
    chapters.saveDraft(dir, id, { meta, body });
    return true;
  });

  handle('draft:discard', async ({ dir, id }) => {
    chapters.clearDraft(dir, id);
    return true;
  });

  handle('versions:list', async ({ dir, id }) => versions.list(dir, id));

  // 快照存的是整份文件（含 front matter），对比与回滚都只取正文部分，
  // 否则会把旧文件的 front matter 当成正文插进来。
  handle('versions:diff', async ({ dir, id, file }) => {
    const ver = versions.read(dir, id, file);
    const before = fm.split(ver.text).body;
    const after = chapters.readChapter(dir, id).body;
    return { before, after, hunks: versions.diffLines(before, after) };
  });

  handle('versions:rollback', async ({ dir, id, file }) => {
    const ver = versions.read(dir, id, file);
    const parsed = fm.split(ver.text);
    const abs = chapters.fromId(dir, id);
    // 回滚前先给当前内容留一份快照，保证回滚本身也可撤销
    versions.snapshot(dir, id, readText(abs, ''));
    chapters.saveChapter(dir, id, { meta: parsed.meta, body: parsed.body });
    return { chapter: chapters.readChapter(dir, id), tree: chapters.tree(dir) };
  });

  handle('stats:summary', async ({ dir }) => stats.summary(dir));

  // 立即为当前章节生成一份历史版本（不受「每 N 字」阈值限制）
  handle('versions:snapshotNow', async ({ dir, id }) => {
    const file = versions.snapshot(dir, id, readText(chapters.fromId(dir, id), ''));
    versions.resetPending(dir);
    return { file, list: versions.list(dir, id) };
  });

  // 当前作品的备份落地目录（供设置页「查看」使用）
  handle('versions:root', async ({ dir }) => ({ backupRoot: settingsStore().load().backupRoot, projectDir: dir ? versions.versionBase(dir) : null }));

  // 清理缓存：草稿、残留临时文件、备份计数（不动正文与历史版本）
  handle('backup:cleanCache', async ({ dir }) => {
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
  });

  // 设定库（角色 / 设定词条），供正文自动高亮使用
  handle('cast:read', async ({ dir }) => cast.read(dir));
  handle('cast:save', async ({ dir, data }) => cast.save(dir, data));

  // 无限画布：角色卡片 + 故事线，落在 bible/canvas.json
  handle('canvas:read', async ({ dir }) => canvas.read(dir));
  handle('canvas:save', async ({ dir, data }) => canvas.save(dir, data));

  // 单个角色的档案分析：只返回背景 / 性格 / 外貌 / 阶段样貌，由渲染层回填到卡片
  handle('profile:analyze', async ({ dir, name, aliases, desc, relations, mode }) =>
    profile.analyze({ dir, name, aliases, desc, relations, mode })
  );

  handle('shell:openPath', async ({ dir }) => {
    require('electron').shell.openPath(dir);
    return true;
  });
}

/** 供主进程其他模块（老板键注册）读取当前快捷键设置 */
function currentShortcuts() {
  try {
    return settingsStore().load().shortcuts || {};
  } catch {
    return {};
  }
}

module.exports = { register, handle, broadcast, loadRecent, currentShortcuts };
