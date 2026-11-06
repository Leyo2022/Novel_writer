'use strict';

/**
 * iPad 端启动流程：
 *   1. 先把 window.mushu 挂上（桌面渲染层是同步启动的，必须提前就绪）；
 *   2. 从本地存储把作品树载入内存文件系统；
 *   3. 打开界面，再补做服务器连接向导 / AI 状态探测 / 定时同步。
 */

const fs = require('./shims/fs');
const storage = require('./storage');
const config = require('./config');
const ui = require('./ui');
const api = require('./api');
const sync = require('./sync');
const touch = require('./touch');
const ai = require('./ai-client');
const native = require('./native');

// 服务层里用到的全局（node 环境下天然存在）
if (!globalThis.process) globalThis.process = { pid: 1, env: {}, cwd: () => '/' };
fs.installBuffer();
api.expose();

async function flushOnHide() {
  try {
    await storage.flushNow();
    await sync.runSync('auto');
  } catch {
    /* 后台失败不打扰用户 */
  }
}

function setupPlugin(name) {
  if (!native.isNative()) return null;
  const getter = native[name];
  return typeof getter === 'function' ? getter() : null;
}

async function openSetup() {
  const cfg = config.get();
  return ui.showSetup({
    baseUrl: cfg.baseUrl,
    password: cfg.password,
    autoSync: cfg.autoSync,
    onSave: async (next) => {
      await ai.verify(next);
      await config.save({ ...next, baseUrl: next.baseUrl || cfg.baseUrl, setupDone: true });
      await ai.refreshStatus();
      sync.start();
      sync.runSync('manual');
    },
    onSkip: async () => {
      await config.save({ autoSync: false, setupDone: true });
      ui.setSyncStatus('仅本地', 'idle');
    },
  });
}

async function start() {
  ui.markIos();
  ui.setLoading('正在载入本地作品…');

  try {
    await config.load();
    const entries = await storage.loadAll();
    fs.loadEntries(entries);
    fs.setChangeHook(storage.mark);

    fs.mkdirSync('/mushu/works', { recursive: true });
    fs.mkdirSync('/mushu/backups', { recursive: true });

    api.markReady();
    ui.hideLoading();
    ui.ensureSyncIndicator();
    ui.setSyncStatus(config.get().password ? '等待同步' : '仅本地', 'idle');

    storage.setFlushListener(() => sync.schedule(8000));
    touch.install();
    touch.adaptLayout();

    // 原生细节：状态栏、软键盘、切后台立即落盘
    const statusBar = setupPlugin('statusBar');
    if (statusBar) {
      try {
        statusBar.setStyle({ style: 'DARK' });
        statusBar.setOverlay({ overlay: false });
      } catch {
        /* 老版本插件可能没有 setOverlay */
      }
    }
    const keyboard = setupPlugin('keyboard');
    if (keyboard && typeof keyboard.setResizeMode === 'function') {
      try {
        keyboard.setResizeMode({ mode: 'native' });
      } catch {
        /* 忽略：软键盘模式失败不影响使用 */
      }
    }

    // 切后台/锁屏：原生事件优先，另外兜一层 visibilitychange（WebView 里一定可用）
    const appPlugin = setupPlugin('app');
    if (appPlugin && typeof appPlugin.addListener === 'function') {
      appPlugin.addListener('appStateChange', ({ isActive }) => {
        if (!isActive) flushOnHide();
      });
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushOnHide();
    });
    window.addEventListener('pagehide', () => {
      flushOnHide();
    });

    if (!config.get().password) {
      window.__mushuOpenSetup = () => openSetup();
      if (!config.get().setupDone) setTimeout(() => openSetup(), 400);
      return;
    }
    await config.save({ setupDone: true });
    window.__mushuOpenSetup = () => openSetup();

    await ai.refreshStatus();
    sync.start();
  } catch (err) {
    console.error('[mushu] 启动失败', err);
    ui.setLoading('启动失败：' + (err && err.message ? err.message : String(err)));
    api.markReady(); // 即使失败也放行，至少能进到界面看错误
  }
}

window.__mushuIpad = { api, sync, storage, config, openSetup };
start();
