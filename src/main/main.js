'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Menu, shell, globalShortcut } = require('electron');
const ipc = require('./ipc');

const isDev = !app.isPackaged;
let mainWindow = null;

// 硬件加速必须在 ready 之前决定：这里直接读一遍 settings.json
try {
  const settingsFile = path.join(app.getPath('userData'), 'settings.json');
  const raw = fs.readFileSync(settingsFile, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed && parsed.hardwareAcceleration === false) app.disableHardwareAcceleration();
} catch {
  /* 首次启动还没有设置文件，用默认值 */
}

function send(action) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu:action', action);
}

function buildMenu() {
  const template = [
    {
      label: '作品',
      submenu: [
        // 加速键交给渲染进程统一管理（Ctrl+N 已被「新建章节」占用）
        { label: '新建作品…', click: () => send('newProject') },
        { label: '打开作品…', accelerator: 'CmdOrCtrl+O', click: () => send('openProject') },
        { label: '关闭作品', click: () => send('closeProject') },
        { type: 'separator' },
        { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => send('settings') },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        { label: '立即保存', click: () => send('save') },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '专注模式', accelerator: 'CmdOrCtrl+Shift+F', click: () => send('focusMode') },
        { label: '版本历史', accelerator: 'CmdOrCtrl+H', click: () => send('versions') },
        { label: '故事大纲', accelerator: 'CmdOrCtrl+U', click: () => send('outline') },
        // 无限画布加速键交给渲染进程（Ctrl+3），避免与菜单加速键重复触发
        { label: '无限画布', click: () => send('canvas') },
        { type: 'separator' },
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        // 缩放统一由渲染进程处理（Ctrl/⌘ + = / - / 0），菜单只转发动作，避免加速键重复触发
        { label: '重置缩放', click: () => send('zoomReset') },
        { label: '放大', click: () => send('zoomIn') },
        { label: '缩小', click: () => send('zoomOut') },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '打开作品目录', click: () => send('openFolder') },
        { label: '关于墨枢', click: () => send('about') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** 无边框窗口需要自己实现最小化/最大化/关闭，以及把原生菜单弹在按钮下方 */
function registerWindowControls() {
  ipc.handle('window:minimize', () => {
    if (mainWindow) mainWindow.minimize();
    return true;
  });

  ipc.handle('window:toggleMaximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });

  ipc.handle('window:close', () => {
    if (mainWindow) mainWindow.close();
    return true;
  });

  ipc.handle('window:state', () => ({ maximized: !!(mainWindow && mainWindow.isMaximized()), fullScreen: !!(mainWindow && mainWindow.isFullScreen()) }));

  // 界面整体缩放：整页一起放大缩小，正文、大纲、画布都跟着变
  ipc.handle('window:setZoom', ({ factor } = {}) => {
    if (!mainWindow || mainWindow.isDestroyed()) return 1;
    const n = Number(factor);
    const f = Number.isFinite(n) ? Math.min(2, Math.max(0.7, n)) : 1;
    mainWindow.webContents.setZoomFactor(f);
    return f;
  });

  ipc.handle('window:toggleFullScreen', () => {
    if (!mainWindow) return false;
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
    return mainWindow.isFullScreen();
  });

  // 渲染层保存设置后调用，重新注册「老板键」全局快捷键
  ipc.handle('shortcut:register', () => registerBossKey());

  ipc.handle('menu:popup', () => {
    const menu = Menu.getApplicationMenu();
    if (menu && mainWindow) menu.popup({ window: mainWindow, x: 8, y: 46 });
    return true;
  });
}

/**
 * 老板键：注册为全局快捷键，窗口隐藏时也能收起 / 唤回。
 * 注册失败（被输入法或系统占用）时把原因回传给渲染层提示。
 */
function registerBossKey() {
  try {
    globalShortcut.unregisterAll();
  } catch {
    /* 忽略 */
  }
  if (!mainWindow || mainWindow.isDestroyed()) return { bossKey: '', error: null };
  const accel = (ipc.currentShortcuts && ipc.currentShortcuts().bossKey) || '';
  if (!accel) return { bossKey: '', error: null };
  let error = null;
  try {
    const ok = globalShortcut.register(accel, () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
        mainWindow.hide();
      } else {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
    if (!ok) error = '该快捷键已被系统或其它程序占用';
  } catch (err) {
    error = err.message;
  }
  return { bossKey: accel, error };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#14161a',
    title: '墨枢',
    show: false,
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  const notifyState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:state', {
        maximized: mainWindow.isMaximized(),
        fullScreen: mainWindow.isFullScreen(),
      });
    }
  };
  mainWindow.on('maximize', notifyState);
  mainWindow.on('unmaximize', notifyState);
  mainWindow.on('enter-full-screen', notifyState);
  mainWindow.on('leave-full-screen', notifyState);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 外链一律交给系统浏览器，不在应用内打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12') {
        mainWindow.webContents.toggleDevTools();
        event.preventDefault();
      }
    });
  }
}

app.whenReady().then(() => {
  ipc.register();
  registerWindowControls();
  buildMenu();
  createWindow();
  registerBossKey();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  try {
    globalShortcut.unregisterAll();
  } catch {
    /* 忽略 */
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
