'use strict';

/**
 * 可自定义快捷键：action → 加速键字符串（Electron 风格，如 CommandOrControl+N）。
 * 空串表示「未绑定」。
 */
const DEFAULT_SHORTCUTS = {
  newChapter: 'CommandOrControl+N',
  fullscreen: 'CommandOrControl+.',
  formatText: 'CommandOrControl+K',
  insertDivider: 'CommandOrControl+Alt+S',
  gotoChapterStart: 'CommandOrControl+Up',
  gotoChapterEnd: 'CommandOrControl+Down',
  bossKey: 'Alt+`',
  showShortcuts: 'CommandOrControl+0',
  outline: 'CommandOrControl+1',
  settingPanel: 'CommandOrControl+2',
  canvas: 'CommandOrControl+3',
  findReplace: 'CommandOrControl+F',
  saveChapter: 'CommandOrControl+S',
};

/** 白名单 action 的中文名，供设置界面与「查看快捷键」使用 */
const SHORTCUT_LABELS = {
  newChapter: '新建章节',
  fullscreen: '全屏',
  formatText: '一键排版',
  insertDivider: '插入分割线',
  gotoChapterStart: '定位章首',
  gotoChapterEnd: '定位章尾',
  bossKey: '老板键',
  showShortcuts: '查看快捷键',
  outline: '大纲',
  settingPanel: '设定',
  canvas: '无限画布',
  findReplace: '查找替换',
  saveChapter: '保存章节',
};

/** 只接受白名单 action 的字符串值，其余回退默认（空串视为未绑定） */
function normalizeShortcuts(patch) {
  const out = { ...DEFAULT_SHORTCUTS };
  if (patch && typeof patch === 'object') {
    for (const key of Object.keys(DEFAULT_SHORTCUTS)) {
      if (typeof patch[key] === 'string') out[key] = patch[key].trim();
    }
  }
  return out;
}

module.exports = { DEFAULT_SHORTCUTS, SHORTCUT_LABELS, normalizeShortcuts };
