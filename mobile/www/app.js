'use strict';

const api = window.mushu;

const DRAFT_THROTTLE = 2000; // 草稿最快写入间隔（保证崩溃最多丢 2 秒）
const COMMIT_DEBOUNCE = 3000; // 停止输入 3 秒后落盘
const COMMIT_INTERVAL = 5000; // 或至少每 5 秒落盘一次

const state = {
  dir: null,
  book: null,
  tree: null,
  id: null,
  savedBody: '',
  savedTitle: '',
  savedStatus: 'draft',
  dirty: false,
  saving: false,
  stats: null,
  nodeMap: new Map(),
  cast: { characters: [], settings: [] },
};

/** 写作 / 备份 / 快捷键等偏好（由设置页写入，随取随用） */
const prefs = {
  shortcuts: {},
  autoScrollMode: 'off',
  autoScrollPercent: 60,
  wheelChapterSwitch: false,
  highlight: { characters: true, settings: true, scope: 'chapter', style: 'underline' },
  bossKeyOk: true,
};

function applyPrefs(s) {
  prefs.shortcuts = { ...((s && s.shortcuts) || {}) };
  prefs.autoScrollMode = (s && s.autoScrollMode) || 'off';
  prefs.autoScrollPercent = Number(s && s.autoScrollPercent) || 60;
  prefs.wheelChapterSwitch = !!(s && s.wheelChapterSwitch);
  prefs.highlight = { characters: true, settings: true, scope: 'chapter', style: 'underline', ...((s && s.highlight) || {}) };
}

const $ = (id) => document.getElementById(id);

const ui = {
  welcome: $('welcome'),
  workspace: $('workspace'),
  recentList: $('recent-list'),
  titlebarBook: $('titlebar-book'),
  bookWrap: $('book-wrap'),
  bookClose: $('btn-book-close'),
  titlebarChapter: $('titlebar-chapter'),
  tbActions: $('tb-actions'),
  menuBtn: $('menu-btn'),
  winMin: $('win-min'),
  winMax: $('win-max'),
  winClose: $('win-close'),
  tree: $('tree'),
  treeStat: $('tree-stat'),
  treeSearch: $('tree-search'),
  treeSearchClear: $('tree-search-clear'),
  treeResult: $('tree-result'),
  cardList: $('card-list'),
  cardCount: $('card-count'),
  beatList: $('beat-list'),
  beatCount: $('beat-count'),
  railRightOpen: $('rail-right-open'),
  editor: $('editor'),
  chapterTitle: $('chapter-title'),
  chapterStatus: $('chapter-status'),
  panel: $('panel'),
  versionList: $('version-list'),
  editorPane: $('editor-pane'),
  outlinePane: $('outline-pane'),
  outlineBody: $('outline-body'),
  outlineStatus: $('outline-status'),
  outlineBlock: $('outline-block'),
  editorHighlight: $('editor-highlight'),
  findBar: $('find-bar'),
  findInput: $('find-input'),
  findReplace: $('find-replace'),
  findCount: $('find-count'),
  castPane: $('cast-pane'),
  castList: $('cast-list'),
  castStatus: $('cast-status'),
  castName: $('cast-name'),
  castAliases: $('cast-aliases'),
  castDesc: $('cast-desc'),
  canvasPane: $('canvas-pane'),
  canvasViewport: $('canvas-viewport'),
  canvasWorld: $('canvas-world'),
  canvasSvgRoot: $('canvas-svg-root'),
  canvasCards: $('canvas-cards'),
  canvasStatus: $('canvas-status'),
  canvasZoomLabel: $('canvas-zoom-label'),
  canvasHint: $('canvas-hint'),
  cvGraphTools: $('cv-graph-tools'),
  cvFocusChip: $('cv-focus-chip'),
  cvDepth1: $('cv-depth-1'),
  cvDepth2: $('cv-depth-2'),
  cvDepth3: $('cv-depth-3'),
  cvDepthAll: $('cv-depth-all'),
  cvRelayout: $('cv-relayout'),
  cvRelPanel: $('cv-rel-panel'),
  canvasDetailHead: $('canvas-detail-head'),
  canvasDetailBody: $('canvas-detail-body'),
  saveStatus: $('save-status'),
  zoomOut: $('zoom-out'),
  zoomIn: $('zoom-in'),
  zoomLabel: $('zoom-label'),
  wordChapter: $('word-chapter'),
  wordToday: $('word-today'),
  wordStreak: $('word-streak'),
  overlay: $('overlay'),
  overlayBox: $('overlay-box'),
};

// ---------- 基础设施 ----------

async function invoke(promise) {
  const res = await promise;
  if (!res || !res.ok) throw new Error((res && res.error) || '调用失败');
  return res.data;
}

const countWords = (text) => (text || '').replace(/\s/g, '').length;

function setStatus(text, cls) {
  ui.saveStatus.textContent = text;
  ui.saveStatus.className = cls || '';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 1800);
}

// ---------- 弹层 ----------

function showModal(build) {
  return new Promise((resolve) => {
    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      ui.overlay.classList.add('hidden');
      ui.overlayBox.innerHTML = '';
      resolve(value);
    };
    ui.overlayBox.innerHTML = '';
    ui.overlayBox.className = ''; // 清掉上一个弹层留下的类（如 settings-modal）
    build(ui.overlayBox, close);
    ui.overlay.classList.remove('hidden');
    const first = ui.overlayBox.querySelector('input[type="text"]');
    if (first) first.focus();
  });
}

function askForm(title, fields) {
  return showModal((box, close) => {
    box.innerHTML = `<h3>${escapeHtml(title)}</h3>`;
    const inputs = {};
    for (const f of fields) {
      const label = document.createElement('label');
      label.textContent = f.label;
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = f.placeholder || '';
      input.value = f.value || '';
      box.append(label, input);
      inputs[f.key] = input;
    }
    const actions = document.createElement('div');
    actions.className = 'overlay-actions';
    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.onclick = () => close(null);
    const ok = document.createElement('button');
    ok.className = 'primary';
    ok.textContent = '确定';
    ok.onclick = () => {
      const out = {};
      for (const f of fields) out[f.key] = inputs[f.key].value.trim();
      close(out);
    };
    actions.append(cancel, ok);
    box.append(actions);
    box.onkeydown = (e) => {
      if (e.key === 'Enter') ok.click();
    };
  });
}

function confirmBox(title, message, confirmText = '确定') {
  return showModal((box, close) => {
    box.innerHTML = `<h3>${escapeHtml(title)}</h3><div class="overlay-msg">${escapeHtml(message)}</div>`;
    const actions = document.createElement('div');
    actions.className = 'overlay-actions';
    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.onclick = () => close(false);
    const ok = document.createElement('button');
    ok.className = 'primary';
    ok.textContent = confirmText;
    ok.onclick = () => close(true);
    actions.append(cancel, ok);
    box.append(actions);
  });
}

function alertBox(title, message) {
  return showModal((box, close) => {
    box.innerHTML = `<h3>${escapeHtml(title)}</h3><div class="overlay-msg">${escapeHtml(message)}</div>`;
    const actions = document.createElement('div');
    actions.className = 'overlay-actions';
    const ok = document.createElement('button');
    ok.className = 'primary';
    ok.textContent = '知道了';
    ok.onclick = () => close(true);
    actions.append(ok);
    box.append(actions);
  });
}

// ---------- 设置 ----------

const FONT_PRESETS = [
  { label: '默认（宋体系）', value: '' },
  { label: '思源宋体', value: '"Source Han Serif SC", "Noto Serif SC", "思源宋体", serif' },
  { label: '宋体', value: 'SimSun, "Songti SC", serif' },
  { label: '霞鹜文楷', value: '"LXGW WenKai", "LXGW WenKai Screen", KaiTi, serif' },
  { label: '楷体', value: 'KaiTi, STKaiti, "Kaiti SC", serif' },
  { label: '仿宋', value: 'FangSong, STFangsong, serif' },
  { label: '微软雅黑', value: '"Microsoft YaHei", "PingFang SC", sans-serif' },
  { label: '等线', value: 'DengXian, "Microsoft YaHei", sans-serif' },
  { label: '自定义…', value: '__custom__' },
];

const clamp = (v, min, max, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const UI_ZOOM_MIN = 0.7;
const UI_ZOOM_MAX = 2;
let uiZoom = 1;

/** 把当前缩放比例同步到状态栏上的可见入口 */
function renderUiZoom() {
  if (!ui.zoomLabel) return;
  ui.zoomLabel.textContent = `${Math.round(uiZoom * 100)}%`;
  ui.zoomLabel.title = '点击恢复 100%（Ctrl/⌘ + 0）';
  ui.zoomOut.disabled = uiZoom <= UI_ZOOM_MIN + 0.001;
  ui.zoomIn.disabled = uiZoom >= UI_ZOOM_MAX - 0.001;
}

/** 界面整体缩放：走主进程的 webContents 缩放，整页一起变大变小 */
function applyUiZoom(z, persist) {
  uiZoom = Math.round(clamp(z, UI_ZOOM_MIN, UI_ZOOM_MAX, 1) * 100) / 100;
  invoke(api.setZoom(uiZoom)).catch(() => {});
  if (persist) invoke(api.setSettings({ uiScale: uiZoom })).catch(() => {});
  renderUiZoom();
  toast(`界面缩放 ${Math.round(uiZoom * 100)}%`);
}

function stepUiZoom(delta) {
  applyUiZoom(uiZoom + delta, true);
}

function applyAppearance(s) {
  const root = document.documentElement;
  const set = (name, value) => (value ? root.style.setProperty(name, value) : root.style.removeProperty(name));
  set('--editor-font', s && s.editorFont);
  set('--editor-size', s && s.editorSize ? `${s.editorSize}px` : '');
  set('--editor-leading', s && s.editorLineHeight ? String(s.editorLineHeight) : '');
  uiZoom = clamp(s && s.uiScale, UI_ZOOM_MIN, UI_ZOOM_MAX, 1);
  invoke(api.setZoom(uiZoom)).catch(() => {});
  renderUiZoom();
}

// ---------- 快捷键 ----------

/** 可自定义的快捷键清单（与主进程 services/shortcuts.js 的白名单保持一致） */
const SHORTCUT_ACTIONS = [
  { id: 'newChapter', label: '新建章节' },
  { id: 'fullscreen', label: '全屏' },
  { id: 'formatText', label: '一键排版' },
  { id: 'insertDivider', label: '插入分割线' },
  { id: 'gotoChapterStart', label: '定位章首' },
  { id: 'gotoChapterEnd', label: '定位章尾' },
  { id: 'bossKey', label: '老板键' },
  { id: 'showShortcuts', label: '查看快捷键' },
  { id: 'outline', label: '大纲' },
  { id: 'settingPanel', label: '设定' },
  { id: 'findReplace', label: '查找替换' },
  { id: 'saveChapter', label: '保存章节' },
  { id: 'canvas', label: '无限画布' },
];

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

const IS_MAC = /mac/i.test(navigator.userAgent);

/** 加速键 → 展示文本（Ctrl + N / Alt + ` / Ctrl + ↑） */
function formatAccel(accel) {
  if (!accel) return '';
  return String(accel)
    .split('+')
    .map((raw) => {
      const key = raw.trim();
      const lower = key.toLowerCase();
      if (lower === 'commandorcontrol' || lower === 'cmdorctrl') return IS_MAC ? 'Cmd' : 'Ctrl';
      if (lower === 'command' || lower === 'cmd' || lower === 'meta' || lower === 'super') return IS_MAC ? 'Cmd' : 'Win';
      if (lower === 'control' || lower === 'ctrl') return 'Ctrl';
      if (lower === 'alt' || lower === 'option') return 'Alt';
      if (lower === 'shift') return 'Shift';
      if (lower === 'up') return '↑';
      if (lower === 'down') return '↓';
      if (lower === 'left') return '←';
      if (lower === 'right') return '→';
      if (lower === 'return' || lower === 'enter') return 'Enter';
      if (lower === 'escape' || lower === 'esc') return 'Esc';
      if (lower === ' ') return 'Space';
      return key;
    })
    .join(' + ');
}

/** 把 KeyboardEvent 的 key 归一化成 Electron 加速键片段 */
function keyFromEvent(e) {
  const k = e.key;
  if (!k) return '';
  if (k.length === 1) return k === ' ' ? 'Space' : k.toUpperCase();
  const map = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Escape: 'Esc',
    Enter: 'Return',
    ' ': 'Space',
  };
  return map[k] || k;
}

/** 录制用：由键盘事件反向拼出加速键字符串（无键位则返回空串） */
function accelFromEvent(e) {
  if (['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Compose'].includes(e.key)) return '';
  const key = keyFromEvent(e);
  if (!key) return '';
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

/** 判断键盘事件是否命中某个加速键 */
function matchAccel(e, accel) {
  if (!accel) return false;
  const parts = String(accel).split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return false;
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map((m) => m.toLowerCase());
  const wantCtrl = mods.some((m) => ['commandorcontrol', 'cmdorctrl', 'control', 'ctrl', 'command', 'cmd', 'meta', 'super'].includes(m));
  const wantAlt = mods.includes('alt') || mods.includes('option');
  const wantShift = mods.includes('shift');
  if (wantCtrl !== (e.ctrlKey || e.metaKey)) return false;
  if (wantAlt !== e.altKey) return false;
  if (wantShift !== e.shiftKey) return false;
  return keyFromEvent(e).toLowerCase() === key.toLowerCase();
}

const SETTINGS_TABS = [
  { id: 'general', label: '常规' },
  { id: 'writing', label: '写作' },
  { id: 'ai', label: 'AI' },
  { id: 'backup', label: '备份缓存' },
  { id: 'shortcut', label: '快捷键' },
  { id: 'other', label: '其它' },
];

async function openSettings(initialTab) {
  let current;
  try {
    current = await invoke(api.getSettings());
  } catch (err) {
    await alertBox('打开设置失败', err.message);
    return;
  }

  const saved = await showModal((box, close) => {
    box.classList.add('settings-modal');

    const shell = document.createElement('div');
    shell.className = 'settings-shell';
    const nav = document.createElement('nav');
    nav.className = 'settings-nav';
    const main = document.createElement('div');
    main.className = 'settings-main';
    const body = document.createElement('div');
    body.className = 'settings-body';
    const foot = document.createElement('div');
    foot.className = 'settings-foot';
    shell.append(nav, main);
    main.append(body, foot);
    box.append(shell);

    const section = (text) => {
      const el = document.createElement('p');
      el.className = 'form-section';
      el.textContent = text;
      return el;
    };
    const label = (text) => {
      const el = document.createElement('label');
      el.textContent = text;
      return el;
    };
    const hint = (text) => {
      const el = document.createElement('p');
      el.className = 'field-hint';
      el.textContent = text;
      return el;
    };
    const checkbox = (text, checked, sub) => {
      const wrap = document.createElement('label');
      wrap.className = 'setting-check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!checked;
      const span = document.createElement('span');
      span.textContent = text;
      if (sub) {
        const s = document.createElement('span');
        s.className = 'sub';
        s.textContent = sub;
        span.append(s);
      }
      wrap.append(input, span);
      return wrap;
    };
    const optInput = (value, min, max, step) => {
      const input = document.createElement('input');
      input.type = 'number';
      if (min != null) input.min = String(min);
      if (max != null) input.max = String(max);
      if (step != null) input.step = String(step);
      input.value = value;
      return input;
    };
    const select = (options, value) => {
      const sel = document.createElement('select');
      for (const o of options) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        sel.append(opt);
      }
      sel.value = value;
      return sel;
    };

    const panels = {};
    const navButtons = {};
    const showTab = (id) => {
      for (const t of SETTINGS_TABS) {
        panels[t.id].classList.toggle('hidden', t.id !== id);
        navButtons[t.id].classList.toggle('active', t.id === id);
      }
      error.textContent = '';
    };
    const error = document.createElement('p');
    error.className = 'field-error';

    for (const t of SETTINGS_TABS) {
      const b = document.createElement('button');
      b.textContent = t.label;
      b.onclick = () => showTab(t.id);
      navButtons[t.id] = b;
      nav.append(b);
      const p = document.createElement('div');
      p.className = 'settings-panel';
      p.classList.add('hidden');
      panels[t.id] = p;
      body.append(p);
    }

    // ---------- 常规 ----------
    {
      const p = panels.general;
      const rootRow = document.createElement('div');
      rootRow.className = 'field-row';
      const rootInput = document.createElement('input');
      rootInput.type = 'text';
      rootInput.value = current.projectsRoot || '';
      rootInput.placeholder = '例如 D:\\小说';
      const rootPick = document.createElement('button');
      rootPick.textContent = '选择…';
      rootPick.onclick = async () => {
        const dir = await invoke(api.pickDir('选择默认作品目录', rootInput.value || undefined));
        if (dir) rootInput.value = dir;
      };
      rootRow.append(rootInput, rootPick);

      const fontSelect = select(FONT_PRESETS, '');
      const known = current.editorFont || '';
      fontSelect.value = FONT_PRESETS.some((o) => o.value === known) ? known : '__custom__';
      const fontCustom = document.createElement('input');
      fontCustom.type = 'text';
      fontCustom.value = current.editorFont || '';
      fontCustom.placeholder = '例如 "LXGW WenKai", SimSun, serif';
      const sizeInput = optInput(current.editorSize || 18, 12, 40, 1);
      const leadInput = optInput(current.editorLineHeight || 2, 1.2, 3.5, 0.1);
      const grid = document.createElement('div');
      grid.className = 'field-grid';
      const cellSize = document.createElement('div');
      cellSize.append(label('字号（px）'), sizeInput);
      const cellLead = document.createElement('div');
      cellLead.append(label('行高（倍）'), leadInput);
      grid.append(cellSize, cellLead);

      const preview = document.createElement('div');
      preview.className = 'font-preview';
      preview.textContent = '她推开那扇门，风雪从身后灌了进来。';
      const chosenFont = () => (fontSelect.value === '__custom__' ? fontCustom.value.trim() : fontSelect.value);
      const refreshPreview = () => {
        fontCustom.classList.toggle('hidden', fontSelect.value !== '__custom__');
        preview.style.fontFamily = chosenFont() || '';
        preview.style.fontSize = clamp(sizeInput.value, 12, 40, 18) + 'px';
        preview.style.lineHeight = String(clamp(leadInput.value, 1.2, 3.5, 2));
      };
      fontSelect.onchange = refreshPreview;
      fontCustom.oninput = refreshPreview;
      sizeInput.oninput = refreshPreview;
      leadInput.oninput = refreshPreview;
      refreshPreview();

      p.append(
        section('存储'),
        label('默认作品目录'),
        rootRow,
        hint('新建作品时不再询问位置，会在这里按书名自动建文件夹；重名自动加 (1) (2)。「打开作品」的选择器也从这里开始。'),
        section('正文外观'),
        label('正文字体'),
        fontSelect,
        fontCustom,
        grid,
        label('效果预览'),
        preview
      );
      p.collect = () => ({
        projectsRoot: rootInput.value.trim(),
        editorFont: chosenFont(),
        editorSize: clamp(sizeInput.value, 12, 40, 18),
        editorLineHeight: clamp(leadInput.value, 1.2, 3.5, 2),
      });
    }

    // ---------- 写作 ----------
    {
      const p = panels.writing;
      const modeSelect = select(
        [
          { value: 'line', label: '换行时滚动（性能要求高）' },
          { value: 'enter', label: '回车时滚动' },
          { value: 'off', label: '不自动滚屏' },
        ],
        current.autoScrollMode || 'off'
      );
      const percentInput = optInput(current.autoScrollPercent != null ? current.autoScrollPercent : 60, 0, 90, 5);
      const percentRow = document.createElement('div');
      percentRow.className = 'setting-row';
      percentRow.append(
        label('内容达到'),
        percentInput,
        (() => {
          const s = document.createElement('span');
          s.className = 'dim';
          s.textContent = '% 高度时自动滚屏';
          return s;
        })()
      );
      const wheelBox = checkbox('滚动可上下切章', current.wheelChapterSwitch, '正文滚到顶部或底部时，继续滚动即切换到上一章 / 下一章');

      const h = current.highlight || {};
      const charBox = checkbox('角色', h.characters !== false);
      const setBox = checkbox('设定', h.settings !== false);
      const hlSwitch = document.createElement('div');
      hlSwitch.className = 'setting-row';
      hlSwitch.append(charBox, setBox);
      const scopeSelect = select(
        [
          { value: 'chapter', label: '单个章节' },
          { value: 'always', label: '每次出现' },
        ],
        h.scope === 'always' ? 'always' : 'chapter'
      );
      const tail = document.createElement('span');
      tail.className = 'dim';
      tail.textContent = '时自动';
      const styleSelect = select(
        [
          { value: 'underline', label: '下划线高亮' },
          { value: 'background', label: '背景高亮' },
          { value: 'bold', label: '加粗高亮' },
        ],
        ['underline', 'background', 'bold'].includes(h.style) ? h.style : 'underline'
      );
      const hlRow = document.createElement('div');
      hlRow.className = 'setting-row';
      hlRow.append(scopeSelect, tail, styleSelect);

      const hlHint = document.createElement('p');
      hlHint.className = 'field-hint';
      hlHint.textContent = '高亮词条来自「设定」面板里的角色 / 设定名称与别名（快捷键 Ctrl+2 打开设定）。';

      p.append(
        section('自动滚屏'),
        modeSelect,
        percentRow,
        wheelBox,
        section('自动高亮'),
        hlSwitch,
        hlRow,
        hlHint
      );
      p.collect = () => ({
        autoScrollMode: modeSelect.value,
        autoScrollPercent: clamp(percentInput.value, 0, 90, 60),
        wheelChapterSwitch: wheelBox.querySelector('input').checked,
        highlight: {
          characters: charBox.querySelector('input').checked,
          settings: setBox.querySelector('input').checked,
          scope: scopeSelect.value,
          style: styleSelect.value,
        },
      });
    }

    // ---------- AI ----------
    {
      const p = panels.ai;
      const keyRow = document.createElement('div');
      keyRow.className = 'field-row';
      const keyInput = document.createElement('input');
      keyInput.type = 'password';
      keyInput.autocomplete = 'off';
      keyInput.spellcheck = false;
      keyInput.placeholder = current.aiKeySet ? '已保存，如需更换请重新填写' : 'sk-...';
      let keyTouched = false;
      keyInput.addEventListener('input', () => {
        keyTouched = true;
      });

      const status = document.createElement('p');
      status.className = 'field-hint key-status';
      const renderKeyStatus = (st) => {
        if (!st || !st.configured) {
          status.textContent = '当前状态：未配置。填好 Key 后即可使用 AI 助手与画布「AI 解析」。';
          status.classList.add('warn');
          return;
        }
        const from = st.source === 'env' ? '环境变量' : st.source === 'file' ? '.env 文件' : '本地设置';
        status.textContent = `当前状态：已配置（来源：${from}）`;
        status.classList.remove('warn');
      };
      invoke(api.aiKeyStatus())
        .then(renderKeyStatus)
        .catch(() => renderKeyStatus(null));

      const saveKey = document.createElement('button');
      saveKey.textContent = '保存密钥';
      saveKey.onclick = async () => {
        const value = keyInput.value.trim();
        if (!value) {
          error.textContent = '请先填写 API Key';
          return;
        }
        try {
          const st = await invoke(api.aiKeySet(value));
          keyInput.value = '';
          keyTouched = false;
          keyInput.placeholder = '已保存，如需更换请重新填写';
          renderKeyStatus(st);
          error.textContent = '';
          toast('密钥已加密保存');
        } catch (err) {
          error.textContent = err.message;
        }
      };

      const clearKey = document.createElement('button');
      clearKey.textContent = '清除';
      clearKey.onclick = async () => {
        try {
          const st = await invoke(api.aiKeySet(''));
          keyInput.value = '';
          keyTouched = false;
          keyInput.placeholder = 'sk-...';
          renderKeyStatus(st);
          error.textContent = '';
          toast('已清除本地密钥');
        } catch (err) {
          error.textContent = err.message;
        }
      };

      keyRow.append(keyInput, saveKey, clearKey);
      p.append(
        section('DeepSeek'),
        label('API Key'),
        keyRow,
        status,
        hint(
          'Key 只留在本机：由系统安全存储（safeStorage）加密后写入 settings.json，界面上不显示明文，也不会写进日志。环境变量 DEEPSEEK_API_KEY 优先级更高，设置了就会覆盖这里。'
        ),
        hint('用途：正文写作助手，以及画布里的「AI 解析」（通读全书识别人物与关系）。全书解析按预算档位与作品长度计费，标准档一般是几百万 tokens 以内。')
      );
      // 只有手动输入过才随「保存」提交，避免误清空已有密钥（保存动作会重新加密一次）
      p.collect = () => (keyTouched && keyInput.value.trim() ? { aiKey: keyInput.value.trim() } : {});
    }

    // ---------- 备份缓存 ----------
    {
      const p = panels.backup;
      const rootRow = document.createElement('div');
      rootRow.className = 'field-row';
      const backupInput = document.createElement('input');
      backupInput.type = 'text';
      backupInput.value = current.backupRoot || '';
      const pick = document.createElement('button');
      pick.textContent = '修改';
      pick.onclick = async () => {
        const dir = await invoke(api.pickDir('选择备份目录', backupInput.value || undefined));
        if (dir) backupInput.value = dir;
      };
      const view = document.createElement('button');
      view.textContent = '查看';
      view.onclick = () => backupInput.value.trim() && api.openFolder(backupInput.value.trim());
      rootRow.append(backupInput, pick, view);

      const wordsRow = document.createElement('div');
      wordsRow.className = 'setting-row';
      const autoBox = checkbox('每', current.autoBackupWords !== 0);
      const wordsInput = optInput(current.autoBackupWords || 2000, 0, 100000, 100);
      const wordsTail = document.createElement('span');
      wordsTail.className = 'dim';
      wordsTail.textContent = '字 保存本地历史版本（0 或不勾选 = 每次保存都存）';
      wordsRow.append(autoBox, wordsInput, wordsTail);

      const cleanBtn = document.createElement('button');
      cleanBtn.textContent = '清理缓存';
      cleanBtn.onclick = async () => {
        if (!state.dir) {
          error.textContent = '请先打开一个作品';
          return;
        }
        const yes = await confirmBox('清理缓存', '将清除未提交草稿与残留临时文件，并重置备份计数。不影响正文与历史版本。', '清理');
        if (!yes) return;
        try {
          const res = await invoke(api.cleanCache(state.dir));
          toast(`已清理缓存（释放约 ${Math.max(1, Math.round(res.bytes / 1024))} KB）`);
        } catch (err) {
          error.textContent = err.message;
        }
      };

      p.append(
        section('备份文件'),
        label('备份目录（历史版本存放位置）'),
        rootRow,
        hint('修改后原有历史版本会迁移到新位置，期间可能稍有卡顿。'),
        wordsRow,
        section('缓存'),
        cleanBtn,
        hint('清理缓存不影响使用。如发现数据未正常刷新，可点击清理数据缓存。')
      );
      p.collect = () => ({
        backupRoot: backupInput.value.trim(),
        autoBackupWords: autoBox.querySelector('input').checked ? Math.round(clamp(wordsInput.value, 0, 100000, 2000)) : 0,
      });
    }

    // ---------- 快捷键 ----------
    {
      const p = panels.shortcut;
      const sc = { ...(current.shortcuts || {}) };
      const rows = [];
      const grid = document.createElement('div');
      grid.className = 'sc-grid';
      for (const a of SHORTCUT_ACTIONS) {
        const row = document.createElement('div');
        row.className = 'setting-row sc-line';
        const name = document.createElement('span');
        name.className = 'sc-name';
        name.textContent = a.label;
        const btn = document.createElement('button');
        btn.className = 'sc-recorder';
        btn.type = 'button';
        const refresh = () => {
          btn.textContent = formatAccel(sc[a.id]) || '未绑定';
        };
        refresh();
        let recording = false;
        const stop = () => {
          recording = false;
          btn.classList.remove('recording');
          refresh();
        };
        btn.onclick = () => {
          recording = true;
          btn.classList.add('recording');
          btn.textContent = '按下新组合键…';
        };
        btn.addEventListener('keydown', (e) => {
          if (!recording) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'Escape') return stop();
          if (e.key === 'Backspace' || e.key === 'Delete') {
            sc[a.id] = '';
            return stop();
          }
          if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return undefined;
          const accel = accelFromEvent(e);
          if (!accel) return undefined;
          sc[a.id] = accel;
          stop();
          return undefined;
        });
        const reset = document.createElement('button');
        reset.className = 'sc-reset';
        reset.type = 'button';
        reset.textContent = '恢复默认';
        reset.onclick = () => {
          sc[a.id] = DEFAULT_SHORTCUTS[a.id] || '';
          refresh();
        };
        row.append(name, btn, reset);
        rows.push(row);
        grid.append(row);
      }
      p.append(grid);
      const scHint = document.createElement('p');
      scHint.className = 'field-hint';
      scHint.textContent = '点击按键框后按下新的组合键即可改绑；老板键会注册为全局快捷键，窗口隐藏时也能唤回。';
      p.insertBefore(scHint, p.firstChild);
      p.collect = () => ({ shortcuts: { ...sc } });
    }

    // ---------- 其它 ----------
    {
      const p = panels.other;
      const launchBox = checkbox('开机自启', current.autoLaunch, '勾选后，设备启动自动打开墨枢');
      const accelBox = checkbox('硬件加速（性能要求高）', current.hardwareAcceleration !== false, '修改后重启生效');
      p.append(section('启动'), launchBox, section('性能'), accelBox);
      p.collect = () => ({
        autoLaunch: launchBox.querySelector('input').checked,
        hardwareAcceleration: accelBox.querySelector('input').checked,
      });
    }

    // ---------- 底部 ----------
    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.onclick = () => close(null);
    const ok = document.createElement('button');
    ok.className = 'primary';
    ok.textContent = '保存';
    ok.onclick = async () => {
      let patch = {};
      for (const t of SETTINGS_TABS) patch = { ...patch, ...(panels[t.id].collect ? panels[t.id].collect() : {}) };
      const conflict = findShortcutConflict(patch.shortcuts);
      if (conflict) {
        error.textContent = `快捷键冲突：${conflict}`;
        showTab('shortcut');
        return;
      }
      try {
        const next = await invoke(api.setSettings(patch));
        close(next);
      } catch (err) {
        error.textContent = err.message;
      }
    };
    foot.append(error, cancel, ok);
    error.style.marginRight = 'auto';

    showTab(initialTab && panels[initialTab] ? initialTab : 'general');
  });

  if (saved) {
    applyAppearance(saved);
    applyPrefs(saved);
    renderHighlight();
    try {
      const r = await api.registerShortcuts();
      prefs.bossKeyOk = !!(r && r.ok && r.data && !r.data.error);
      if (r && r.ok && r.data && r.data.error) toast('老板键注册失败：' + r.data.error);
    } catch {
      /* 忽略 */
    }
    toast('设置已保存');
  }
}

/** 返回冲突描述，无冲突返回空串 */
function findShortcutConflict(map) {
  const used = new Map();
  for (const a of SHORTCUT_ACTIONS) {
    const accel = map[a.id];
    if (!accel) continue;
    if (used.has(accel)) return `${a.label} 与 ${used.get(accel)} 都是 ${formatAccel(accel)}`;
    used.set(accel, a.label);
  }
  return '';
}

/** 查看快捷键：只读列表 */
async function showShortcutsDialog() {
  let shortcuts = prefs.shortcuts;
  try {
    shortcuts = (await invoke(api.getSettings())).shortcuts || shortcuts;
  } catch {
    /* 读不到就用缓存 */
  }
  await showModal((box, close) => {
    box.innerHTML = `<h3>快捷键</h3>`;
    const list = document.createElement('div');
    list.className = 'sc-list';
    for (const a of SHORTCUT_ACTIONS) {
      const row = document.createElement('div');
      row.className = 'sc-line';
      const name = document.createElement('span');
      name.className = 'sc-name';
      name.textContent = a.label;
      const key = document.createElement('span');
      key.className = 'sc-key';
      key.textContent = formatAccel(shortcuts[a.id]) || '未绑定';
      row.append(name, key);
      list.append(row);
    }
    box.append(list);
    const actions = document.createElement('div');
    actions.className = 'overlay-actions';
    const ok = document.createElement('button');
    ok.className = 'primary';
    ok.textContent = '知道了';
    ok.onclick = () => close(true);
    actions.append(ok);
    box.append(actions);
  });
}

async function diffModal(version) {
  const data = await invoke(api.diffVersion(state.dir, state.id, version.file));
  return showModal((box, close) => {
    box.innerHTML =
      `<h3>版本对比 · ${escapeHtml(version.at.replace('T', ' '))}（左旧 / 右新）</h3>` +
      '<div class="overlay-body"></div>';
    const body = box.querySelector('.overlay-body');
    const frag = document.createDocumentFragment();
    for (const h of data.hunks) {
      const line = document.createElement('span');
      line.className = h.type;
      line.textContent = (h.type === 'add' ? '+ ' : h.type === 'del' ? '- ' : '  ') + h.text;
      frag.append(line);
    }
    body.append(frag);

    const actions = document.createElement('div');
    actions.className = 'overlay-actions';
    const cancel = document.createElement('button');
    cancel.textContent = '关闭';
    cancel.onclick = () => close(null);
    const rollback = document.createElement('button');
    rollback.className = 'primary';
    rollback.textContent = '回滚到此版本';
    rollback.onclick = () => close(version.file);
    actions.append(cancel, rollback);
    box.append(actions);
  });
}

// ---------- 欢迎页 ----------

async function refreshRecent() {
  let list = [];
  try {
    list = await invoke(api.recentProjects());
  } catch {
    list = [];
  }
  ui.recentList.innerHTML = '';
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '暂无记录';
    ui.recentList.append(li);
    return;
  }
  for (const item of list) {
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.textContent = item.title || '(未命名)';
    const p = document.createElement('span');
    p.className = 'path';
    p.textContent = item.dir;
    li.append(t, p);
    li.onclick = () => enterProject(item.dir);
    ui.recentList.append(li);
  }
}

async function createProject() {
  try {
    const form = await askForm('新建作品', [
      { key: 'title', label: '书名', placeholder: '未命名作品' },
      { key: 'author', label: '作者（可留空）', placeholder: '' },
    ]);
    if (!form) return;
    const title = form.title || '未命名作品';
    const data = await invoke(api.createProject({ title, author: form.author }));
    await enterProject(data.project.dir, data);
    toast('已创建到 ' + data.project.dir);
  } catch (err) {
    await alertBox('新建失败', err.message);
  }
}

/** 导入 TXT：先选文件，再确认书名与作者，最后由主进程按章节标题切分建作品 */
async function importTxt() {
  try {
    const file = String((await invoke(api.pickTxt())) || '');
    if (!file) return;
    const base = file.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    const form = await showModal((box, close) => {
      box.innerHTML = '<h3>导入 TXT 小说</h3>';
      const tip = document.createElement('div');
      tip.className = 'overlay-msg';
      tip.textContent = '按「第X章」这类标题自动切章；识别不到章节标题会中止导入。原文会留存在作品目录的 source/ 下。';
      const src = document.createElement('div');
      src.className = 'overlay-msg';
      src.textContent = '来源文件：' + file;
      box.append(tip, src);
      const mk = (label, value) => {
        const l = document.createElement('label');
        l.textContent = label;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = value;
        box.append(l, input);
        return input;
      };
      const titleInput = mk('书名', base || '未命名作品');
      const authorInput = mk('作者（可留空）', '');
      const actions = document.createElement('div');
      actions.className = 'overlay-actions';
      const cancel = document.createElement('button');
      cancel.textContent = '取消';
      cancel.onclick = () => close(null);
      const ok = document.createElement('button');
      ok.className = 'primary';
      ok.textContent = '开始导入';
      ok.onclick = () => close({ title: titleInput.value.trim() || base || '未命名作品', author: authorInput.value.trim() });
      actions.append(cancel, ok);
      box.append(actions);
    });
    if (!form) return;
    toast('正在导入…');
    const data = await invoke(api.importTxt({ file, title: form.title, author: form.author }));
    await enterProject(data.project.dir, data);
    const n = data.imported;
    toast(`已导入 ${n.chapters} 章 · ${n.words} 字` + (n.skipped ? `（开头 ${n.skipped} 字未归章，已忽略）` : ''));
  } catch (err) {
    await alertBox('导入失败', err.message);
  }
}

async function enterProject(dir, preloaded) {
  try {
    const data = preloaded || (await invoke(api.openProject(dir)));
    state.dir = data.project.dir;
    state.book = data.project.book;
    state.tree = data.tree;
    state.id = null;
    state.dirty = false;

    ui.titlebarBook.textContent = state.book.title || '未命名作品';
    ui.bookWrap.classList.remove('hidden');
    ui.tbActions.classList.remove('hidden');
    ui.welcome.classList.add('hidden');
    ui.workspace.classList.remove('hidden');
    setMiddlePane('editor');
    aiPane = 'chapter';
    cvRoot = null;
    cvData = null;
    cvTrail = [];
    cvMode = 'story';
    hlCastSig = '';
    clearTreeSearch();
    setRightCollapsed(false);
    showRightPane('tree');
    await showLeftPane('ai');
    document.title = `${state.book.title} · 墨枢`;
    renderTree();
    await loadCast();
    await loadCanvasData();
    await reloadStats();

    const last = state.stats && state.stats.lastChapter;
    const target = last && state.nodeMap.has(last.id) ? last.id : firstChapterId();
    if (target) await openChapter(target);
    else setStatus('这本书还没有章节，点左下角「+ 章」开始');
  } catch (err) {
    await alertBox('打开失败', err.message);
  }
}

function closeProject() {
  state.dir = null;
  state.book = null;
  state.tree = null;
  state.id = null;
  state.dirty = false;
  state.nodeMap.clear();
  ui.editor.value = '';
  ui.chapterTitle.value = '';
  ui.tree.innerHTML = '';
  ui.titlebarBook.textContent = '—';
  ui.bookWrap.classList.add('hidden');
  ui.titlebarChapter.textContent = '';
  ui.titlebarChapter.classList.add('hidden');
  ui.tbActions.classList.add('hidden');
  ui.workspace.classList.add('hidden');
  clearTreeSearch();
  setRightCollapsed(false);
  setMiddlePane('editor');
  aiPane = 'chapter';
  ui.editorHighlight.textContent = '';
  state.cast = { characters: [], settings: [] };
  cvRoot = null;
  cvData = null;
  cvTrail = [];
  cvSel = null;
  cvMode = 'story';
  cvRev = 0;
  cvSavedRev = 0;
  cvAppearCache.clear();
  clearTimeout(cvTimer);
  ui.canvasCards.innerHTML = '';
  ui.canvasSvgRoot.innerHTML = '';
  cvDetailEmpty();
  ui.cardList.innerHTML = '';
  ui.beatList.innerHTML = '';
  ui.outlineBody.innerHTML = '';
  outlineDirty = false;
  outlineLoaded = false;
  clearTimeout(outlineTimer);
  document.body.classList.remove('focus');
  document.title = '墨枢';
  ui.welcome.classList.remove('hidden');
  refreshRecent();
}

async function reloadStats() {
  try {
    state.stats = await invoke(api.stats(state.dir));
  } catch {
    state.stats = null;
  }
  renderCounts();
}

/** 关闭作品：先把三处未落盘的内容写过一遍，再退回欢迎页 */
async function closeProjectNow() {
  await commitSave();
  await saveOutline();
  await saveCanvasNow();
  closeProject();
}

// ---------- 侧栏页签 ----------

const RAIL_TABS = ['ai', 'cards', 'beats', 'cast'];
const RAIL_TAB_IDS = { ai: 'tab-ai', cards: 'tab-cards', beats: 'tab-beats', cast: 'tab-cast' };
const RAIL_PANE_IDS = { ai: 'ai-panel', cards: 'card-panel', beats: 'beat-panel', cast: 'cast-pane' };

let leftPane = 'ai';
let rightPane = 'tree';
let rightCollapsed = false;
/** AI 取文的目标：切到「对话」页签后仍记得刚才在看大纲 / 设定 / 正文 */
let aiPane = 'chapter';

async function showLeftPane(name) {
  if (!RAIL_PANE_IDS[name]) return;
  leftPane = name;
  if (name !== 'ai') aiPane = name === 'cast' ? 'cast' : 'chapter';
  for (const key of RAIL_TABS) {
    $(RAIL_TAB_IDS[key]).classList.toggle('active', key === name);
    $(RAIL_PANE_IDS[key]).classList.toggle('hidden', key !== name);
  }
  if (name === 'cards' || name === 'beats') {
    await loadCanvasData();
    if (name === 'cards') renderCardList();
    else renderBeatList();
  }
  if (name === 'ai' && typeof window.mushuRefreshAiContext === 'function') window.mushuRefreshAiContext();
}

// ---------- 中间区：正文 / 无限画布 / 故事大纲 三选一 ----------

/** 中间区当前显示的是哪一屏 */
function middlePane() {
  if (!ui.canvasPane.classList.contains('hidden')) return 'canvas';
  if (!ui.outlinePane.classList.contains('hidden')) return 'outline';
  return 'editor';
}

function setMiddlePane(name) {
  ui.editorPane.classList.toggle('hidden', name !== 'editor');
  ui.canvasPane.classList.toggle('hidden', name !== 'canvas');
  ui.outlinePane.classList.toggle('hidden', name !== 'outline');
  $('btn-outline').classList.toggle('active', name === 'outline');
  $('btn-canvas').classList.toggle('active', name === 'canvas');
}

function showRightPane(name) {
  if (name !== 'tree' && name !== 'versions') return;
  rightPane = name;
  $('tab-tree').classList.toggle('active', name === 'tree');
  $('tab-versions').classList.toggle('active', name === 'versions');
  $('tree-panel').classList.toggle('hidden', name !== 'tree');
  $('version-panel').classList.toggle('hidden', name !== 'versions');
}

/** 右栏收起 / 展开：收起后在窗口右缘留一个细按钮唤回 */
function setRightCollapsed(v) {
  rightCollapsed = !!v;
  ui.panel.classList.toggle('collapsed', rightCollapsed);
  ui.railRightOpen.classList.toggle('hidden', !rightCollapsed);
}

// 供 ai.js 读取当前取文目标（正文 / 设定 / 大纲）
window.mushuGetAiPane = () => aiPane;

// 供 ai.js 取写作依据：大纲已加载就用当前编辑内容，没加载过则从磁盘读一次
window.mushuReadOutlineMd = async () => {
  if (!state.dir) return '';
  if (outlineLoaded) {
    return window.markdownFromDom ? window.markdownFromDom(ui.outlineBody) : ui.outlineBody.innerText;
  }
  try {
    return await invoke(api.readOutline(state.dir));
  } catch {
    return '';
  }
};

// ---------- 目录树 ----------

function firstChapterId() {
  for (const v of state.tree.volumes) {
    if (v.chapters.length) return v.chapters[0].id;
  }
  return null;
}

function findChapter(id) {
  for (const v of state.tree.volumes) {
    const c = v.chapters.find((x) => x.id === id);
    if (c) return c;
  }
  return null;
}

function renderTree() {
  ui.tree.innerHTML = '';
  state.nodeMap.clear();
  cvAppearCache.clear(); // 章节增删改名后出场统计要重算

  if (!state.tree || !state.tree.volumes.length) {
    const empty = document.createElement('div');
    empty.className = 'vol';
    empty.textContent = '还没有分卷';
    ui.tree.append(empty);
  }

  for (const vol of state.tree.volumes) {
    const head = document.createElement('div');
    head.className = 'vol';
    head.dataset.path = vol.path;
    head.title = '双击改卷名';
    head.innerHTML = `<span class="vol-words">${vol.words} 字</span>${escapeHtml(vol.title)}`;
    head.ondblclick = () => {
      const name = vol.path;
      startInlineRename(head, vol.title, (next) => renameVolume(name, next));
    };
    head.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, [
        { label: '重命名', run: () => startInlineRename(head, vol.title, (next) => renameVolume(vol.path, next)) },
      ]);
    };
    ui.tree.append(head);
    for (const ch of vol.chapters) {
      ui.tree.append(buildChapterNode(ch, vol.path));
    }
  }
  updateTreeStat();
}

function buildChapterNode(ch, volumePath) {
  const node = document.createElement('div');
  node.className = 'ch';
  node.dataset.id = ch.id;
  node.innerHTML =
    `<span class="ch-title"><span class="dot ${ch.status}"></span>${escapeHtml(ch.title)}</span>` +
    `<span class="ch-words">${ch.words}</span>`;
  node.onclick = () => openChapter(ch.id);
  node.ondblclick = (e) => {
    e.stopPropagation();
    const id = ch.id;
    startInlineRename(node.querySelector('.ch-title'), ch.title, (next) => renameChapter(id, next));
  };
  node.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      { label: '重命名', run: () => startInlineRename(node.querySelector('.ch-title'), ch.title, (next) => renameChapter(ch.id, next)) },
    ]);
  };
  node.dataset.volume = volumePath;
  state.nodeMap.set(ch.id, node);
  return node;
}

/** 只更新受影响的节点，避免每次保存都重建整棵树 */
function patchTreeNode(chapter) {
  const node = state.nodeMap.get(chapter.id);
  if (!node) return;
  const dot = node.querySelector('.dot');
  dot.className = `dot ${chapter.status}`;
  const titleEl = node.querySelector('.ch-title');
  titleEl.innerHTML = `<span class="dot ${chapter.status}"></span>${escapeHtml(chapter.title)}`;
  node.querySelector('.ch-words').textContent = chapter.words;
  updateTreeStat();
}

function updateTreeStat() {
  if (!state.tree) return;
  let words = 0;
  let count = 0;
  state.tree.volumes.forEach((v) =>
    v.chapters.forEach((c) => {
      words += c.words;
      count += 1;
    })
  );
  state.tree.totalWords = words;
  state.tree.chapterCount = count;
  ui.treeStat.textContent = `${count} 章 · ${words} 字`;
}

function markActive() {
  for (const [id, node] of state.nodeMap) {
    node.classList.toggle('active', id === state.id);
  }
}

// ---------- 目录搜索（章节名 + 正文全文） ----------

const TREE_SEARCH_DEBOUNCE = 220;
let treeSearchTimer = null;
let treeSearchSeq = 0;
let treeQuery = '';

function clearTreeSearch() {
  clearTimeout(treeSearchTimer);
  treeSearchSeq += 1;
  treeQuery = '';
  if (!ui.treeSearch) return;
  ui.treeSearch.value = '';
  ui.treeSearchClear.classList.add('hidden');
  ui.treeResult.classList.add('hidden');
  ui.treeResult.innerHTML = '';
  ui.tree.classList.remove('hidden');
}

function runTreeSearch() {
  const q = ui.treeSearch.value.trim();
  treeQuery = q;
  ui.treeSearchClear.classList.toggle('hidden', !q);
  if (!q) {
    clearTreeSearch();
    return;
  }
  const seq = ++treeSearchSeq;
  api
    .searchChapters(state.dir, q)
    .then((res) => {
      if (seq !== treeSearchSeq || q !== treeQuery) return;
      if (!res || !res.ok) throw new Error((res && res.error) || '搜索失败');
      renderTreeSearch(res.data);
    })
    .catch((err) => {
      console.error('[search] 目录搜索失败：' + (err && err.message ? err.message : err));
    });
}

/** 命中片段里标出关键词，只标第一处，超长文本不反复高亮 */
function markText(text, q) {
  const frag = document.createDocumentFragment();
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i === -1) {
    frag.append(text);
    return frag;
  }
  frag.append(text.slice(0, i));
  const m = document.createElement('mark');
  m.textContent = text.slice(i, i + q.length);
  frag.append(m, text.slice(i + q.length));
  return frag;
}

function renderTreeSearch(data) {
  const q = treeQuery;
  const box = ui.treeResult;
  box.innerHTML = '';
  const chapters = data.chapters || [];
  const hits = data.hits || [];

  if (!chapters.length && !hits.length) {
    const empty = document.createElement('div');
    empty.className = 'rail-empty';
    empty.textContent = `没有找到「${q}」`;
    box.append(empty);
  }

  const group = (text) => {
    const g = document.createElement('div');
    g.className = 'sr-group';
    g.textContent = text;
    box.append(g);
  };

  if (chapters.length) {
    group(`章节名 · ${chapters.length}`);
    for (const ch of chapters) {
      const node = document.createElement('div');
      node.className = 'sr-item';
      const top = document.createElement('div');
      top.className = 'sr-top';
      const name = document.createElement('span');
      name.append(markText(ch.title, q));
      const line = document.createElement('span');
      line.className = 'sr-line';
      line.textContent = ch.volume;
      top.append(name, line);
      node.append(top);
      node.onclick = () => openChapter(ch.id);
      box.append(node);
    }
  }

  if (hits.length) {
    group(`正文 · ${hits.length}${data.truncated ? '（仅显示前若干条）' : ''}`);
    for (const hit of hits) {
      const node = document.createElement('div');
      node.className = 'sr-item';
      const top = document.createElement('div');
      top.className = 'sr-top';
      const name = document.createElement('span');
      name.textContent = hit.title;
      const line = document.createElement('span');
      line.className = 'sr-line';
      line.textContent = '第 ' + hit.line + ' 行';
      top.append(name, line);
      const text = document.createElement('div');
      text.className = 'sr-text';
      text.append(markText(hit.text, q));
      node.append(top, text);
      node.onclick = () => gotoSearchHit(hit);
      box.append(node);
    }
  }

  ui.tree.classList.add('hidden');
  box.classList.remove('hidden');
}

/** 点正文命中：先打开那一章，再把光标落到命中的字符位置 */
async function gotoSearchHit(hit) {
  await openChapter(hit.id);
  if (state.id !== hit.id) return;
  const len = ui.editor.value.length;
  const at = Math.max(0, Math.min(len, hit.at));
  const end = Math.min(len, at + treeQuery.length);
  ui.editor.focus();
  ui.editor.setSelectionRange(at, end);
  scrollCaretIntoView(at, true);
  syncLayerScroll();
}

// ---------- 右键菜单 ----------

let ctxMenu = null;

function closeContextMenu() {
  if (ctxMenu) {
    ctxMenu.remove();
    ctxMenu = null;
  }
}

function showContextMenu(x, y, items) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'ctx-item';
    el.textContent = item.label;
    el.onclick = (e) => {
      e.stopPropagation();
      closeContextMenu();
      item.run();
    };
    menu.append(el);
  }
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - rect.width - 6) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - rect.height - 6) + 'px';
  ctxMenu = menu;
}

document.addEventListener('mousedown', (e) => {
  if (ctxMenu && !ctxMenu.contains(e.target)) closeContextMenu();
});

// ---------- 改名 ----------

/** 把标题换成输入框做行内改名；Enter 或失焦提交，Esc 取消 */
function startInlineRename(host, current, onCommit) {
  if (!host || host.querySelector('.rename-input')) return;
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = current;
  host.textContent = '';
  host.append(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (commit && value && value !== current) {
      try {
        await onCommit(value);
        return;
      } catch (err) {
        await alertBox('改名失败', err.message);
      }
    }
    renderTree(); // 取消或失败都靠重绘还原
  };

  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  };
  input.onblur = () => finish(true);
  input.onclick = (e) => e.stopPropagation();
  input.ondblclick = (e) => e.stopPropagation();
}

/** 分卷改名会连带改动卷内所有章节 id，所以打开中的章节要跟着换 id */
async function renameVolume(volumePath, title) {
  await commitSave();
  const data = await invoke(api.renameVolume(state.dir, volumePath, title));
  if (state.id && state.id.startsWith(volumePath + '/')) {
    state.id = data.volume.path + state.id.slice(volumePath.length);
  }
  state.tree = data.tree;
  renderTree();
  markActive();
  if (rightPane === 'versions' && !rightCollapsed) loadVersions();
  toast('卷名已改为 ' + data.volume.title);
}

async function renameChapter(id, title) {
  await commitSave();
  const data = await invoke(api.renameChapter(state.dir, id, title));
  if (state.id === id) {
    state.id = data.chapter.id;
    state.savedTitle = data.chapter.title;
    ui.chapterTitle.value = data.chapter.title;
    ui.titlebarChapter.textContent = data.chapter.title;
  }
  state.tree = data.tree;
  renderTree();
  markActive();
  if (rightPane === 'versions' && !rightCollapsed) loadVersions();
  toast('章节已改名为 ' + data.chapter.title);
}

/** 书名只改 book.json，不动目录名（目录名是路径，改了会牵动最近打开记录） */
async function renameBook() {
  const form = await askForm('改书名', [{ key: 'title', label: '书名', value: state.book.title }]);
  if (!form) return;
  const title = form.title || state.book.title;
  if (title === state.book.title) return;
  try {
    const book = await invoke(api.updateBook(state.dir, { title }));
    state.book = { ...state.book, ...book };
    ui.titlebarBook.textContent = book.title;
    toast('书名已改为 ' + book.title);
  } catch (err) {
    await alertBox('改名失败', err.message);
  }
}

// ---------- 章节 ----------

function metaFromForm() {
  return {
    title: ui.chapterTitle.value.trim() || '未命名章节',
    status: ui.chapterStatus.value,
  };
}

async function openChapter(id) {
  if (!id) return;
  const mid = middlePane();
  if (state.id === id) {
    if (mid === 'editor') return;
    // 已经是这一章：只是从画布 / 大纲回到正文
    await saveOutline();
    if (mid === 'canvas') await saveCanvasNow();
    setMiddlePane('editor');
    aiPane = 'chapter';
    if (typeof window.mushuRefreshAiContext === 'function') window.mushuRefreshAiContext();
    renderCounts();
    return;
  }
  await saveOutline();
  if (mid !== 'editor') {
    if (mid === 'canvas') await saveCanvasNow();
    setMiddlePane('editor');
    aiPane = 'chapter';
    if (typeof window.mushuRefreshAiContext === 'function') window.mushuRefreshAiContext();
  }
  await commitSave();
  try {
    const ch = await invoke(api.readChapter(state.dir, id));
    state.id = id;
    state.savedBody = ch.body;
    state.savedTitle = ch.meta.title || '';
    state.savedStatus = ch.meta.status || 'draft';
    state.dirty = false;
    ui.editor.value = ch.body;
    ui.chapterTitle.value = state.savedTitle;
    ui.chapterStatus.value = state.savedStatus;
    ui.titlebarChapter.textContent = state.savedTitle;
    ui.titlebarChapter.classList.remove('hidden');
    if (typeof window.mushuRefreshAiContext === 'function') window.mushuRefreshAiContext();
    markActive();
    renderCounts();
    renderHighlight();
    setStatus('就绪');
    if (ch.recoverableDraft) await offerRecovery(ch);
    if (rightPane === 'versions' && !rightCollapsed) await loadVersions();
  } catch (err) {
    await alertBox('打开章节失败', err.message);
  }
}

async function offerRecovery(ch) {
  const yes = await confirmBox(
    '发现未提交的草稿',
    `章节「${ch.meta.title || ch.id}」存在上次异常退出时未写入文件的草稿（${countWords(
      ch.recoverableDraft.body
    )} 字）。是否恢复？`,
    '恢复草稿'
  );
  if (yes) {
    ui.editor.value = ch.recoverableDraft.body;
    state.dirty = true;
    renderCounts();
    renderHighlight();
    setStatus('已恢复草稿，未保存', 'saving');
    scheduleCommit();
  } else {
    try {
      await invoke(api.discardDraft(state.dir, ch.id));
    } catch {
      /* 忽略 */
    }
  }
}

async function newChapter() {
  if (!state.tree.volumes.length) {
    await newVolume();
    if (!state.tree.volumes.length) return;
  }
  const form = await askForm('新建章节', [{ key: 'title', label: '章节标题', placeholder: '新章节' }]);
  if (!form) return;
  const volumePath =
    (state.nodeMap.get(state.id) && state.nodeMap.get(state.id).dataset.volume) || state.tree.volumes[state.tree.volumes.length - 1].path;
  try {
    const data = await invoke(api.createChapter(state.dir, volumePath, form.title || '新章节'));
    state.tree = data.tree;
    renderTree();
    await openChapter(data.chapter.id);
  } catch (err) {
    await alertBox('新建章节失败', err.message);
  }
}

async function newVolume() {
  const form = await askForm('新建分卷', [{ key: 'title', label: '卷名', placeholder: '新卷' }]);
  if (!form) return;
  try {
    const data = await invoke(api.createVolume(state.dir, form.title || '新卷'));
    state.tree = data.tree;
    renderTree();
  } catch (err) {
    await alertBox('新建分卷失败', err.message);
  }
}

// ---------- 自动保存 ----------

let draftTimer = null;
let lastDraftAt = 0;
let commitTimer = null;

function onInput() {
  if (!state.id) return;
  state.dirty = true;
  ui.titlebarChapter.textContent = ui.chapterTitle.value;
  renderCounts();
  setStatus('未保存', 'saving');
  scheduleHighlight();
  maybeAutoScroll();
  scheduleDraft();
  scheduleCommit();
}

function scheduleDraft() {
  const now = Date.now();
  const wait = Math.max(0, DRAFT_THROTTLE - (now - lastDraftAt));
  clearTimeout(draftTimer);
  draftTimer = setTimeout(writeDraft, wait);
}

async function writeDraft() {
  if (!state.dirty || !state.id) return;
  lastDraftAt = Date.now();
  try {
    await invoke(api.saveDraft(state.dir, state.id, metaFromForm(), ui.editor.value));
  } catch {
    /* 草稿失败不打扰写作，落盘仍会继续重试 */
  }
}

function scheduleCommit() {
  clearTimeout(commitTimer);
  commitTimer = setTimeout(commitSave, COMMIT_DEBOUNCE);
}

async function commitSave() {
  clearTimeout(commitTimer);
  if (!state.dirty || !state.id || state.saving) return;
  const id = state.id;
  const body = ui.editor.value;
  const meta = metaFromForm();
  state.saving = true;
  setStatus('保存中…', 'saving');
  try {
    const res = await invoke(api.saveChapter(state.dir, id, meta, body));
    if (id === state.id) {
      state.dirty = false;
      state.savedBody = body;
      state.savedTitle = meta.title;
      state.savedStatus = meta.status;
      setStatus('已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }), 'saved');
    }
    if (res.stats) {
      state.stats = res.stats;
    }
    const node = findChapterInTree(id);
    if (node) {
      node.words = res.words;
      node.status = meta.status;
      node.title = meta.title;
      patchTreeNode(node);
    }
    renderCounts();
  } catch (err) {
    setStatus('保存失败：' + err.message, 'error');
  } finally {
    state.saving = false;
  }
}

function findChapterInTree(id) {
  if (!state.tree) return null;
  for (const v of state.tree.volumes) {
    for (const c of v.chapters) if (c.id === id) return c;
  }
  return null;
}

function renderCounts() {
  // 画布页与章节无关，先于「没打开章节」的兜底分支统计
  if (!ui.canvasPane.classList.contains('hidden')) {
    const ids = new Set(cvPlacedCards().map((c) => c.id));
    if (cvMode === 'graph') {
      const links = cvData ? cvData.links.filter((l) => ids.has(l.from) && ids.has(l.to)).length : 0;
      ui.wordChapter.textContent = `卡片 ${ids.size} · 关系 ${links} 条`;
    } else {
      const points = cvData ? cvData.points.length : 0;
      ui.wordChapter.textContent = `情节 ${points}`;
    }
    ui.wordToday.textContent = '';
    ui.wordStreak.textContent = '';
    return;
  }
  // 大纲是左栏页签，聚焦在大纲时只统计大纲字数
  if (!ui.outlinePane.classList.contains('hidden')) {
    ui.wordChapter.textContent = `大纲 ${countWords(ui.outlineBody.textContent)} 字`;
    ui.wordToday.textContent = '';
    ui.wordStreak.textContent = '';
    return;
  }
  if (!state.id) {
    ui.wordChapter.textContent = '';
    ui.wordToday.textContent = '';
    ui.wordStreak.textContent = '';
    return;
  }
  const cur = countWords(ui.editor.value);
  const saved = countWords(state.savedBody);
  const today = (state.stats ? state.stats.today : 0) + Math.max(0, cur - saved);
  ui.wordChapter.textContent = `本章 ${cur} 字`;
  ui.wordToday.textContent = `今日 ${today} 字`;
  ui.wordStreak.textContent = `连续 ${state.stats ? state.stats.streak : 0} 天`;
}

// ---------- 版本历史 ----------

async function toggleVersions() {
  setRightCollapsed(false);
  showRightPane('versions');
  await loadVersions();
}

async function loadVersions() {
  if (!state.id) {
    ui.versionList.innerHTML = '<div class="vol">先在目录里选一个章节</div>';
    return;
  }
  await commitSave();
  try {
    const list = await invoke(api.listVersions(state.dir, state.id));
    ui.versionList.innerHTML = '';
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'vol';
      empty.textContent = '还没有版本';
      ui.versionList.append(empty);
      return;
    }
    for (const v of list) {
      const node = document.createElement('div');
      node.className = 'ver';
      node.innerHTML = `<span class="t">${escapeHtml(v.at.replace('T', ' '))}</span><span class="w">${v.words} 字</span>`;
      node.onclick = async () => {
        const file = await diffModal(v);
        if (file) await rollbackTo(file);
      };
      ui.versionList.append(node);
    }
  } catch (err) {
    await alertBox('读取版本失败', err.message);
  }
}

async function rollbackTo(file) {
  const yes = await confirmBox(
    '回滚确认',
    '当前内容会先被存为一个新版本，然后正文替换为该历史版本。回滚后仍可通过版本历史再切回来。',
    '确认回滚'
  );
  if (!yes) return;
  try {
    await commitSave();
    const data = await invoke(api.rollbackVersion(state.dir, state.id, file));
    state.savedBody = data.chapter.body;
    state.dirty = false;
    ui.editor.value = data.chapter.body;
    if (data.tree) state.tree = data.tree;
    renderTree();
    markActive();
    renderCounts();
    setStatus('已回滚', 'saved');
    await loadVersions();
  } catch (err) {
    await alertBox('回滚失败', err.message);
  }
}

// ---------- 故事大纲 ----------

const OUTLINE_DEBOUNCE = 1500; // 停止输入 1.5 秒后落盘
let outlineDirty = false;
let outlineLoaded = false;
let outlineTimer = null;

function setOutlineStatus(text, cls) {
  ui.outlineStatus.textContent = text;
  ui.outlineStatus.className = 'dim' + (cls ? ' ' + cls : '');
}

/** 工具条：改掉选区所在的块级/行内样式，然后按「有输入」处理 */
function outlineCommand(cmd, value) {
  ui.outlineBody.focus();
  document.execCommand(cmd, false, value);
  onOutlineInput();
}

function insertOutlineTable() {
  const html =
    '<table><thead><tr><th>列 1</th><th>列 2</th></tr></thead>' +
    '<tbody><tr><td></td><td></td></tr></tbody></table><p><br></p>';
  ui.outlineBody.focus();
  document.execCommand('insertHTML', false, html);
  onOutlineInput();
}

/** 光标停在哪个段落，工具条就回显对应的段落格式 */
function syncOutlineBlock() {
  const sel = document.getSelection();
  if (!sel || !sel.anchorNode || !ui.outlineBody.contains(sel.anchorNode)) return;
  let tag = '';
  try {
    tag = String(document.queryCommandValue('formatBlock') || '').toLowerCase();
  } catch {
    tag = '';
  }
  ui.outlineBlock.value = ['h1', 'h2', 'h3', 'h4'].includes(tag) ? tag : 'p';
}

/** 打开：「排版后的样子」直接可编辑，全程不出现 # ** | 这些原始符号 */
async function openOutline() {
  if (!state.dir) {
    toast('请先打开一个作品');
    return;
  }
  if (!outlineLoaded) {
    await commitSave();
    let md = '';
    try {
      md = await invoke(api.readOutline(state.dir));
    } catch (err) {
      await alertBox('读取大纲失败', err.message);
      return;
    }
    ui.outlineBody.innerHTML = renderMarkdown(md);
    outlineDirty = false;
    outlineLoaded = true;
    setOutlineStatus('就绪');
  }
  // 大纲现在占中间区，与正文 / 画布互斥
  if (middlePane() === 'canvas') await saveCanvasNow();
  setMiddlePane('outline');
  aiPane = 'outline';
  if (typeof window.mushuRefreshAiContext === 'function') window.mushuRefreshAiContext();
  renderCounts();
}

/** 落盘时再还原成 Markdown，bible/outline.md 仍是可移植的纯文本 */
async function saveOutline() {
  clearTimeout(outlineTimer);
  if (!outlineDirty || !state.dir) return;
  const body = window.markdownFromDom(ui.outlineBody);
  setOutlineStatus('保存中…', 'saving');
  try {
    await invoke(api.saveOutline(state.dir, body));
    outlineDirty = false;
    setOutlineStatus('已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }), 'saved');
  } catch (err) {
    setOutlineStatus('保存失败：' + err.message, 'error');
  }
}

function onOutlineInput() {
  if (!state.dir) return;
  outlineDirty = true;
  setOutlineStatus('未保存', 'saving');
  renderCounts();
  clearTimeout(outlineTimer);
  outlineTimer = setTimeout(saveOutline, OUTLINE_DEBOUNCE);
}

/** 退出大纲前先落盘，避免刚敲的字丢掉 */
async function closeOutline() {
  await saveOutline();
  setMiddlePane('editor');
  aiPane = 'chapter';
  if (typeof window.mushuRefreshAiContext === 'function') window.mushuRefreshAiContext();
  renderCounts();
}

async function toggleOutline() {
  if (middlePane() === 'outline') await closeOutline();
  else await openOutline();
}

// ---------- 正文高亮（textarea + 镜像层）----------

let highlightTimer = null;
let hlCastSig = '';
let composing = false;
let pendingEnter = false;
let measureLayer = null;

const HL_MAX = 300000; // 超过这个长度不做高亮，避免打字卡顿

function scheduleHighlight() {
  clearTimeout(highlightTimer);
  highlightTimer = setTimeout(renderHighlight, 80);
}

/** 取出高亮词条：人物来自画布「角色卡片」，设定来自设定库（长词优先，避免短词抢先匹配） */
function castTerms() {
  const h = prefs.highlight || {};
  const terms = [];
  const add = (list, cls) => {
    for (const item of list || []) {
      for (const word of [item.name, ...(item.aliases || [])]) {
        const w = String(word || '').trim();
        if (w) terms.push({ word: w, cls });
      }
    }
  };
  // 人名词条始终取根画布的角色库：下钻到子画布后回到正文，不应丢掉全书人物高亮
  const rootCards = cvRoot && Array.isArray(cvRoot.cards) ? cvRoot.cards : cvData && cvData.cards ? cvData.cards : [];
  if (h.characters) add(rootCards, 'hl-char');
  if (h.settings) add(state.cast.settings, 'hl-settings');
  terms.sort((a, b) => b.word.length - a.word.length);
  return terms;
}

/** 计算不重叠的高亮区间；scope 为 chapter 时每个词只高亮首次出现 */
function computeHighlights(text, terms, scope) {
  const lower = text.toLowerCase();
  const ranges = [];
  for (const t of terms) {
    const needle = t.word.toLowerCase();
    if (!needle) continue;
    let from = 0;
    while (from <= lower.length) {
      const idx = lower.indexOf(needle, from);
      if (idx === -1) break;
      ranges.push({ start: idx, end: idx + needle.length, cls: t.cls });
      if (scope !== 'always') break;
      from = idx + needle.length;
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let last = 0;
  for (const r of ranges) {
    if (r.start < last) continue;
    out.push(r);
    last = r.end;
  }
  return out;
}

function syncLayerScroll() {
  if (!ui.editorHighlight) return;
  ui.editorHighlight.scrollTop = ui.editor.scrollTop;
  ui.editorHighlight.scrollLeft = ui.editor.scrollLeft;
}

function renderHighlight() {
  if (!ui.editorHighlight) return;
  const text = ui.editor.value;
  if (!text || text.length > HL_MAX) {
    ui.editorHighlight.textContent = '';
    return;
  }
  const h = prefs.highlight || {};
  const terms = h.characters || h.settings ? castTerms() : [];
  const ranges = terms.length ? computeHighlights(text, terms, h.scope === 'always' ? 'always' : 'chapter') : [];
  if (!ranges.length) {
    ui.editorHighlight.textContent = text;
    syncLayerScroll();
    return;
  }
  const style = ['underline', 'background', 'bold'].includes(h.style) ? h.style : 'underline';
  let html = '';
  let pos = 0;
  for (const r of ranges) {
    html += escapeHtml(text.slice(pos, r.start));
    html += `<mark class="hl-${style} ${r.cls}">${escapeHtml(text.slice(r.start, r.end))}</mark>`;
    pos = r.end;
  }
  html += escapeHtml(text.slice(pos));
  ui.editorHighlight.innerHTML = html;
  syncLayerScroll();
}

// ---------- 光标定位与自动滚屏 ----------

/** 离屏量一次光标所在行的纵向偏移（与 textarea 同盒模型，像素级对齐） */
function caretLineTop(pos) {
  const el = ui.editor;
  if (!measureLayer) {
    measureLayer = document.createElement('div');
    measureLayer.className = 'measure-layer';
    document.body.append(measureLayer);
  }
  const cs = getComputedStyle(el);
  const st = measureLayer.style;
  st.width = el.clientWidth + 'px';
  st.fontFamily = cs.fontFamily;
  st.fontSize = cs.fontSize;
  st.lineHeight = cs.lineHeight;
  st.letterSpacing = cs.letterSpacing;
  st.padding = cs.padding;
  st.whiteSpace = 'pre-wrap';
  st.wordBreak = 'break-word';
  st.overflowWrap = 'anywhere';
  st.tabSize = cs.tabSize;
  measureLayer.innerHTML = escapeHtml(el.value.slice(0, pos)) + '<span>\u200b</span>';
  return measureLayer.lastElementChild.offsetTop;
}

function scrollCaretIntoView(pos, center) {
  const el = ui.editor;
  const top = caretLineTop(pos);
  const lh = parseFloat(getComputedStyle(el).lineHeight) || 30;
  const viewH = el.clientHeight;
  if (center) {
    el.scrollTop = Math.max(0, top - viewH / 2);
  } else if (top < el.scrollTop + lh) {
    el.scrollTop = Math.max(0, top - lh * 2);
  } else if (top > el.scrollTop + viewH - lh * 2) {
    el.scrollTop = top - viewH + lh * 3;
  }
  syncLayerScroll();
}

/** 内容滚过设定比例高度时把当前行拉回视野（换行时滚动 / 回车时滚动） */
function maybeAutoScroll() {
  const mode = prefs.autoScrollMode;
  const entered = pendingEnter;
  pendingEnter = false;
  if (mode === 'off' || !state.id) return;
  if (mode === 'enter' && !entered) return;
  const el = ui.editor;
  if (!el.selectionEnd) return;
  const pct = Math.min(90, Math.max(10, Number(prefs.autoScrollPercent) || 60));
  const top = caretLineTop(el.selectionEnd);
  const trigger = (el.clientHeight * pct) / 100;
  if (top - el.scrollTop > trigger) {
    el.scrollTop = Math.max(0, top - trigger);
    syncLayerScroll();
  }
}

/** 定位章首 / 章尾 */
function gotoChapterEdge(where) {
  if (!state.id) return;
  const el = ui.editor;
  const len = el.value.length;
  const pos = where === 'end' ? len : 0;
  el.focus();
  el.setSelectionRange(pos, pos);
  el.scrollTop = where === 'end' ? el.scrollHeight : 0;
  syncLayerScroll();
}

// ---------- 一键排版 / 插入分割线 ----------

const INDENT = '\u3000\u3000';

function formatChunk(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      const trimmed = line.replace(/^[ \t\u3000]+/, '').replace(/[ \t\u3000]+$/, '');
      if (!trimmed) return '';
      if (/^[※＊*—\-=~#]+\s*$/.test(trimmed)) return trimmed; // 分割线一类不缩进
      return INDENT + trimmed;
    })
    .join('\n');
}

function formatText() {
  if (!state.id) return;
  const el = ui.editor;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  if (start === end) {
    el.value = formatChunk(el.value);
    onInput();
    toast('已一键排版');
    return;
  }
  const before = el.value.slice(0, start);
  const after = el.value.slice(end);
  const formatted = formatChunk(el.value.slice(start, end));
  el.value = before + formatted + after;
  el.setSelectionRange(start, start + formatted.length);
  onInput();
  toast('已排版选中段落');
}

function insertIntoEditor(text) {
  const el = ui.editor;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  const caret = start + text.length;
  el.focus();
  el.setSelectionRange(caret, caret);
  onInput();
}

function insertDivider() {
  if (!state.id) return;
  const before = ui.editor.value.slice(0, ui.editor.selectionStart);
  const lead = !before || /\n\s*$/.test(before) ? '' : '\n\n';
  insertIntoEditor(lead + '※ ※ ※\n\n');
}

// ---------- 查找替换 ----------

const findState = { matches: [], index: -1 };

/**
 * 用原生编辑命令写回正文，保留浏览器撤销栈。
 * 直接给 textarea.value 赋值会清空撤销记录，导致替换后 Ctrl+Z 退不回去。
 */
function replaceEditorText(text, start, end) {
  const el = ui.editor;
  el.focus();
  if (start == null) el.select();
  else el.setSelectionRange(start, end);
  let ok = false;
  try {
    ok = document.execCommand('insertText', false, text);
  } catch {
    ok = false;
  }
  if (ok) return;
  // 兜底：环境不支持 execCommand 时退回直接赋值（这条路无法撤销）
  if (start == null) el.value = text;
  else el.setRangeText(text, start, end, 'end');
  onInput();
}

function findMatches() {
  const q = ui.findInput.value;
  const out = [];
  if (!q) return out;
  const text = ui.editor.value;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let from = 0;
  while (from <= lower.length) {
    const idx = lower.indexOf(needle, from);
    if (idx === -1) break;
    out.push(idx);
    from = idx + needle.length;
  }
  return out;
}

function updateFindCount() {
  if (!ui.findInput.value) {
    ui.findCount.textContent = '';
    return;
  }
  const total = findState.matches.length;
  ui.findCount.textContent = `${findState.index >= 0 ? findState.index + 1 : 0}/${total}`;
}

function toggleFind(force) {
  const show = force != null ? force : ui.findBar.classList.contains('hidden');
  ui.findBar.classList.toggle('hidden', !show);
  if (!show) {
    ui.editor.focus();
    return;
  }
  const sel = ui.editor.value.slice(ui.editor.selectionStart, ui.editor.selectionEnd);
  if (sel && !sel.includes('\n') && sel.length < 60) ui.findInput.value = sel;
  findState.matches = findMatches();
  findState.index = -1;
  updateFindCount();
  ui.findInput.focus();
  ui.findInput.select();
}

function findStep(step) {
  const q = ui.findInput.value;
  if (!q) return;
  findState.matches = findMatches();
  const list = findState.matches;
  if (!list.length) {
    findState.index = -1;
    updateFindCount();
    toast('未找到「' + q + '」');
    return;
  }
  const n = list.length;
  const caret = ui.editor.selectionStart;
  if (step > 0) {
    const at = list.findIndex((p) => p >= caret);
    findState.index = at >= 0 ? at : 0;
  } else {
    let at = -1;
    list.forEach((p, i) => {
      if (p < caret) at = i;
    });
    findState.index = at >= 0 ? at : n - 1;
  }
  const pos = list[findState.index];
  const el = ui.editor;
  el.focus();
  el.setSelectionRange(pos, pos + q.length);
  scrollCaretIntoView(pos, true);
  updateFindCount();
  ui.findInput.focus();
}

function replaceOne() {
  const q = ui.findInput.value;
  if (!q) return;
  findState.matches = findMatches();
  if (findState.index < 0 || !findState.matches.length) {
    findStep(1);
    return;
  }
  const pos = findState.matches[findState.index];
  const el = ui.editor;
  if (el.value.slice(pos, pos + q.length).toLowerCase() !== q.toLowerCase()) {
    findStep(1);
    return;
  }
  const rep = ui.findReplace.value;
  replaceEditorText(rep, pos, pos + q.length);
  findState.index = -1;
  el.setSelectionRange(pos + rep.length, pos + rep.length);
  findStep(1);
}

function replaceAll() {
  const q = ui.findInput.value;
  if (!q) return;
  const rep = ui.findReplace.value;
  const text = ui.editor.value;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let out = '';
  let from = 0;
  let count = 0;
  while (from <= lower.length) {
    const idx = lower.indexOf(needle, from);
    if (idx === -1) break;
    out += text.slice(from, idx) + rep;
    from = idx + needle.length;
    count += 1;
  }
  if (!count) {
    toast('未找到「' + q + '」');
    return;
  }
  out += text.slice(from);
  replaceEditorText(out);
  findState.index = -1;
  findState.matches = findMatches();
  updateFindCount();
  toast(`已替换 ${count} 处`);
}

// ---------- 滚轮切章 ----------

let wheelLock = 0;

function switchChapter(step) {
  if (!state.tree || !state.id) return;
  const ids = [];
  for (const v of state.tree.volumes) for (const c of v.chapters) ids.push(c.id);
  const i = ids.indexOf(state.id);
  if (i === -1) return;
  const j = i + step;
  if (j < 0 || j >= ids.length) return;
  openChapter(ids[j]).then(() => {
    ui.editor.scrollTop = step > 0 ? 0 : ui.editor.scrollHeight;
    syncLayerScroll();
  });
}

function onEditorWheel(e) {
  if (!prefs.wheelChapterSwitch || !state.id) return;
  if (!ui.findBar.classList.contains('hidden')) return;
  const el = ui.editor;
  if (el.scrollHeight <= el.clientHeight) return;
  const atTop = el.scrollTop <= 0;
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
  if ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom)) {
    const now = Date.now();
    if (now - wheelLock < 700) return;
    wheelLock = now;
    switchChapter(e.deltaY > 0 ? 1 : -1);
  }
}

// ---------- 设定面板 ----------

// 人物统一由画布「角色卡片」管理，设定库只存设定专名
let castTab = 'settings';
let castIndex = -1;
let castTimer = null;

function castListOf(tab) {
  return tab === 'settings' ? state.cast.settings : state.cast.characters;
}

async function loadCast() {
  if (!state.dir) return;
  try {
    state.cast = await invoke(api.readCast(state.dir));
  } catch {
    state.cast = { characters: [], settings: [] };
  }
  renderHighlight();
}

function renderCastList() {
  const list = castListOf(castTab);
  ui.castList.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'cast-empty';
    empty.textContent = '还没有词条，点「+ 新增」';
    ui.castList.append(empty);
  }
  list.forEach((item, i) => {
    const node = document.createElement('div');
    node.className = 'cast-item' + (i === castIndex ? ' active' : '');
    node.textContent = item.name || '(未命名)';
    node.onclick = () => {
      castIndex = i;
      renderCastList();
      renderCastForm();
    };
    ui.castList.append(node);
  });
  $('cast-tab-settings').classList.toggle('active', castTab === 'settings');
}

function renderCastForm() {
  const list = castListOf(castTab);
  const item = list[castIndex];
  ui.castStatus.textContent = item ? `${castIndex + 1}/${list.length}` : `${list.length} 项`;
  ui.castName.value = item ? item.name : '';
  ui.castAliases.value = item ? (item.aliases || []).join('、') : '';
  ui.castDesc.value = item ? item.desc || '' : '';
  const disabled = !item;
  ui.castName.disabled = disabled;
  ui.castAliases.disabled = disabled;
  ui.castDesc.disabled = disabled;
}

function onCastInput() {
  const item = castListOf(castTab)[castIndex];
  if (!item) return;
  item.name = ui.castName.value.trim();
  item.aliases = ui.castAliases.value.split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean);
  item.desc = ui.castDesc.value;
  ui.castStatus.textContent = '未保存';
  clearTimeout(castTimer);
  castTimer = setTimeout(saveCast, 800);
}

async function saveCast() {
  clearTimeout(castTimer);
  if (!state.dir) return;
  const tab = castTab;
  const i = castIndex;
  try {
    state.cast = await invoke(api.saveCast(state.dir, state.cast));
  } catch (err) {
    ui.castStatus.textContent = '保存失败：' + err.message;
    return;
  }
  const list = castListOf(tab);
  if (tab === castTab) {
    if (i >= list.length) {
      castIndex = list.length - 1;
      renderCastForm();
    } else {
      castIndex = Math.max(0, i);
    }
    ui.castStatus.textContent = '已保存';
    renderCastList();
  }
  renderHighlight();
}

function castAdd() {
  const list = castListOf(castTab);
  list.push({ name: castTab === 'characters' ? '新角色' : '新设定', aliases: [], desc: '' });
  castIndex = list.length - 1;
  renderCastList();
  renderCastForm();
  ui.castName.focus();
  ui.castName.select();
  saveCast();
}

async function castDel() {
  const list = castListOf(castTab);
  const item = list[castIndex];
  if (!item) return;
  const yes = await confirmBox('删除词条', `确定删除「${item.name}」吗？删除后正文里将不再高亮它。`, '删除');
  if (!yes) return;
  list.splice(castIndex, 1);
  castIndex = Math.min(castIndex, list.length - 1);
  renderCastList();
  renderCastForm();
  saveCast();
}

async function openCast() {
  if (!state.dir) {
    toast('请先打开一个作品');
    return;
  }
  await commitSave();
  await loadCast();
  const len = castListOf(castTab).length;
  if (castIndex < 0 || castIndex >= len) castIndex = len ? 0 : -1;
  await showLeftPane('cast');
  renderCastList();
  renderCastForm();
}

async function closeCast() {
  saveCast();
  await showLeftPane('ai');
  ui.editor.focus();
}

async function toggleCast() {
  if (leftPane === 'cast') await closeCast();
  else await openCast();
}

// ---------- 无限画布（角色卡片 + 故事线）----------

/** 画布世界坐标约定：故事线沿水平基准轴从左到右，节点上下起伏即情绪高低 */
const CV = {
  left: 200, // 故事线起点 x
  width: 2400, // 故事线跨度
  baseline: 420, // 基准轴 y
  levelAmp: 200, // 情绪 ±100% 对应的世界高度
  cardW: 88, // 卡片即人物头像：外框宽度
  cardH: 104, // 头像 72 + 名字一行
  avatarR: 36, // 头像半径（连线锚点、命中判定都按它算）
  ringStep: 320, // 图谱径向布局每一层的半径增量
  minZoom: 0.2,
  maxZoom: 3,
  rippleAmp: 10, // 节点之间的装饰性涟漪，保证线条不会呆板成直线
  rippleWave: 240,
  rippleFade: 180,
  linkBow: 54, // 关系连线的最大弓高
};

let cvRoot = null; // 落盘的根画布；情节点下钻出来的子画布挂在 point.sub 上
let cvData = null; // 当前层级的画布（根画布或某个节点的子画布）
let cvTrail = []; // 下钻栈：{ pointId, parentData, parentSel }，最后一项是当前层的上一层
let cvSel = null; // { kind: 'card' | 'point' | 'link', id }
let cvMode = 'story'; // 画布视图：'story' 故事线 / 'graph' 知识图谱
let cvTimer = null;
let cvRev = 0; // 改动版本号：每次变动 +1
let cvSavedRev = 0; // 已落盘的版本号，用来避免「保存途中又有改动→改动被吞」

const cvNewId = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/**
 * 已摆到画布上的卡片。canvas.json 的 cards 是「角色库」，
 * 只有 placed===true 的才出现在故事线 / 知识图谱里。
 */
function cvPlacedCards() {
  return cvData ? cvData.cards.filter((c) => c.placed) : [];
}

/**
 * 当前层级下应该出现在画布上的卡片 id。
 * 图谱模式只留「圆心 + 关系跳数 ≤ 当前层数」的人，层级外的人直接隐藏。
 * 唯一的例外：还没跟任何人连过线的孤立角色始终可见 —— 否则新建/拖上画布的卡片会立刻消失，
 * 也就永远没法给它建立第一条关系。画布上一条关系都没有时，所有人都是孤立角色，自然全部可见。
 */
function cvGraphVisibleIds() {
  const ids = new Set();
  if (!cvData) return ids;
  const cards = cvPlacedCards();
  for (const c of cards) ids.add(c.id);
  if (cvMode !== 'graph') return ids;
  const info = cvGraphInfo();
  const maxLv = cvData.depth === 0 ? Infinity : cvData.depth;
  const keep = new Set();
  if (info.focusId) keep.add(info.focusId);
  for (const c of cards) {
    const lv = info.level.get(c.id);
    if (lv != null && lv <= maxLv) keep.add(c.id);
    else if (!info.adj.get(c.id).length) keep.add(c.id); // 孤立角色：没有关系可依，先留着
  }
  return keep;
}

// ---------- 知识图谱：径向关系布局（以某人为圆心，按关系跳数分层）----------

/** 最近一次布局结果，供 renderGraph 画参考环与层标 */
let cvGraphMeta = null;

/** 头像圆心（连线锚点用它，卡片外框中心会带上名字那一行，偏下） */
function cvAvatarCenter(c) {
  return { x: c.x + CV.cardW / 2, y: c.y + CV.avatarR };
}

/**
 * 图谱拓扑：无向邻接表 + 以圆心为起点的 BFS 层号。
 * focusId 优先取已保存的圆心，否则自动选「关系最多」的那张卡（平局取角色库靠前的）。
 */
function cvGraphInfo() {
  const cards = cvPlacedCards();
  const ids = new Set(cards.map((c) => c.id));
  const adj = new Map(cards.map((c) => [c.id, []]));
  for (const l of cvData.links || []) {
    if (!ids.has(l.from) || !ids.has(l.to)) continue;
    adj.get(l.from).push(l.to);
    adj.get(l.to).push(l.from);
  }
  let focusId = '';
  if (cards.length) {
    const saved = cards.find((c) => c.id === cvData.focus);
    if (saved) focusId = saved.id;
    else {
      let best = cards[0];
      for (const c of cards) if (adj.get(c.id).length > adj.get(best.id).length) best = c;
      focusId = best.id;
    }
  }
  const level = new Map();
  const parent = new Map();
  if (focusId) {
    level.set(focusId, 0);
    parent.set(focusId, null);
    const queue = [focusId];
    while (queue.length) {
      const cur = queue.shift();
      for (const nb of adj.get(cur)) {
        if (level.has(nb)) continue;
        level.set(nb, level.get(cur) + 1);
        parent.set(nb, cur);
        queue.push(nb);
      }
    }
  }
  return { cards, adj, focusId, level, parent };
}

/** 把卡片按「圆心在原点」的径向布局摆好：第 N 层落在半径 N×ringStep 的环上 */
function cvGraphLayout() {
  const info = cvGraphInfo();
  const { cards, focusId, level, parent } = info;
  const focusCard = cards.find((c) => c.id === focusId);
  if (!focusCard) {
    cvGraphMeta = null;
    return;
  }
  if (cvData.focus !== focusId) cvData.focus = focusId; // 自动选出的圆心落盘，保证下次一致
  const maxLv = cvData.depth === 0 ? Infinity : cvData.depth;
  const cx = focusCard.x + CV.cardW / 2;
  const cy = focusCard.y + CV.avatarR;

  const byLevel = new Map();
  const angles = new Map([[focusId, -Math.PI / 2]]);
  let hidden = 0; // 与圆心不连通、或超出当前层级的卡片
  for (const c of cards) {
    if (c.id === focusId) continue;
    const lv = level.get(c.id);
    // 层级外的人不参与径向排布，保持原位；是否显示由 cvGraphVisibleIds 决定
    if (lv == null || lv > maxLv) {
      hidden += 1;
      continue;
    }
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv).push(c);
  }

  const levels = [...byLevel.keys()].sort((a, b) => a - b);
  // 每层环半径：至少 lv×ringStep；同层人一多就按弧长把环撑开，
  // 否则几十张卡片和关系词会全挤在一圈里互相压住
  const minArc = CV.cardW + 44;
  const ringR = new Map();
  let prevR = 0;
  for (const lv of levels) {
    const n = byLevel.get(lv).length;
    const need = (n * minArc) / (2 * Math.PI);
    const r = Math.ceil(Math.max(lv * CV.ringStep, need, prevR + CV.ringStep / 2));
    ringR.set(lv, r);
    prevR = r;
  }
  for (const lv of levels) {
    const nodes = byLevel.get(lv);
    // 同一父节点的兄弟排在一起，减少连线交叉
    nodes.sort((a, b) => (angles.get(parent.get(a.id)) ?? 0) - (angles.get(parent.get(b.id)) ?? 0));
    const r = ringR.get(lv);
    nodes.forEach((c, i) => {
      const ang = -Math.PI / 2 + ((i + 0.5) / nodes.length) * Math.PI * 2;
      angles.set(c.id, ang);
      c.x = Math.round(cx + Math.cos(ang) * r - CV.cardW / 2);
      c.y = Math.round(cy + Math.sin(ang) * r - CV.avatarR);
    });
  }

  cvGraphMeta = {
    cx,
    cy,
    rings: levels.map((lv) => ({ r: ringR.get(lv), label: lv <= 3 ? '一二三'[lv - 1] + '层' : lv + ' 层' })),
  };
  cvLog('径向布局', {
    focus: { id: focusId, name: focusCard.name },
    depth: cvData.depth,
    levels,
    hidden,
  });
}

/** 图谱重排：布局 → 重绘 →（可选）适应视图 → 落盘 */
function cvRelayoutGraph(fit) {
  if (!cvData || cvMode !== 'graph') return;
  cvGraphLayout();
  renderCanvas();
  if (fit) cvFit();
  cvMarkDirty();
}

function cvSetFocus(id) {
  if (!cvData) return;
  const card = cvData.cards.find((c) => c.id === id);
  if (!card || !card.placed) return;
  cvData.focus = id;
  cvSyncGraphTools();
  cvRelayoutGraph(true);
  cvLog('切换圆心', { id, name: card.name });
}

function cvSetDepth(d) {
  if (!cvData) return;
  cvData.depth = [0, 1, 2, 3].includes(d) ? d : 2;
  cvSyncGraphTools();
  cvRelayoutGraph(true);
  cvLog('切换展开层级', { depth: cvData.depth });
}

/** 顶栏图谱工具区：圆心名、层级高亮、按模式显隐 */
function cvSyncGraphTools() {
  if (ui.cvGraphTools) ui.cvGraphTools.classList.toggle('hidden', cvMode !== 'graph');
  if (!cvData) return;
  const card = cvPlacedCards().find((c) => c.id === cvData.focus);
  if (ui.cvFocusChip) ui.cvFocusChip.textContent = '圆心：' + (card ? card.name : '自动');
  const pairs = [
    [1, ui.cvDepth1],
    [2, ui.cvDepth2],
    [3, ui.cvDepth3],
    [0, ui.cvDepthAll],
  ];
  for (const [d, btn] of pairs) if (btn) btn.classList.toggle('active', cvData.depth === d);
}

/** 点「圆心」按钮：弹出角色列表（按关系多少排序）换圆心 */
function cvPickFocus(x, y) {
  const info = cvGraphInfo();
  const items = [...info.cards]
    .sort((a, b) => info.adj.get(b.id).length - info.adj.get(a.id).length)
    .map((c) => ({
      label: `${c.name}（${info.adj.get(c.id).length} 条关系）${c.id === info.focusId ? ' · 当前' : ''}`,
      run: () => cvSetFocus(c.id),
    }));
  if (!items.length) {
    toast('画布上还没有角色');
    return;
  }
  showContextMenu(x, y, items);
}

// ---------- 知识图谱：关系一览浮动面板 ----------

const CV_AVATAR_SVG =
  '<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
  '<circle cx="32" cy="20" r="11" />' +
  '<path d="M32 34c-11 0-19 7-19 17v5h38v-5c0-10-8-17-19-17z" />' +
  '</svg>';

/** 悬停面板里的某一行时，把对应卡片与关系线点亮 */
function cvSetHighlight(cardId, linkId, on) {
  const el = cvCardEl(cardId);
  if (el) el.classList.toggle('hl', on);
  if (!linkId) return;
  for (const p of ui.canvasSvgRoot.querySelectorAll('.cv-link, .cv-link-label')) {
    if (p.dataset.id === linkId) p.classList.toggle('hl', on);
  }
}

// ---------- 知识图谱：关系分类（按本书关系词现算，不预置任何关系体系）----------

/** 至少共用一个汉字才算同一类：既合得上「师徒 / 师父」，也不会把「盟友」并进「敌对」 */
const CV_CAT_MIN_SIM = 0.5;
let cvCatCache = null;

/** 汉字集合（只拿汉字参与相似度，避免书名号、括号之类的符号干扰） */
function cvCatChars(s) {
  const set = new Set();
  for (const ch of String(s || '')) if (/[\u4e00-\u9fff]/.test(ch)) set.add(ch);
  return set;
}

/**
 * 把这本书实际用过的关系词聚成若干类。
 * 纯本地计算：按关系词出现次数从多到少，谁跟已有类的代表词「共用汉字」够多就并进去，
 * 否则自立一类。类的名字就是该类里出现最多的那个词。
 * 这样每本书的分类都是它自己关系词聚出来的总和，不存在通用框架。
 */
function cvRelCategories() {
  const links = (cvData && cvData.links) || [];
  const freq = new Map();
  const order = [];
  for (const l of links) {
    const t = String((l && l.label) || '').trim();
    if (!t) continue;
    if (!freq.has(t)) {
      freq.set(t, 0);
      order.push(t);
    }
    freq.set(t, freq.get(t) + 1);
  }
  const sig = order.map((t) => t + ':' + freq.get(t)).join('\u0001');
  if (cvCatCache && cvCatCache.sig === sig) return cvCatCache;

  order.sort((a, b) => freq.get(b) - freq.get(a) || (a < b ? -1 : a > b ? 1 : 0));
  const list = [];
  const byLabel = new Map();
  for (const label of order) {
    const A = cvCatChars(label);
    let best = null;
    let bestSim = 0;
    for (const cat of list) {
      const B = cvCatChars(cat.name);
      if (!A.size || !B.size) continue;
      let hit = 0;
      for (const ch of A) if (B.has(ch)) hit += 1;
      const s = hit / Math.min(A.size, B.size);
      if (s > bestSim) {
        bestSim = s;
        best = cat;
      }
    }
    if (best && bestSim >= CV_CAT_MIN_SIM) {
      best.labels.push(label);
      best.count += freq.get(label);
    } else {
      best = { name: label, labels: [label], count: freq.get(label) };
      list.push(best);
    }
    byLabel.set(label, best.name);
  }
  list.sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
  cvCatCache = { sig, list, byLabel };
  return cvCatCache;
}

/** 这条关系是否被所属分类关掉了（关掉的只影响画什么，不动卡片位置与层级） */
function cvLinkIsHidden(link) {
  const hidden = cvData && cvData.hiddenCats;
  if (!hidden || !hidden.length) return false;
  const cat = cvRelCategories().byLabel.get(String((link && link.label) || '').trim());
  return !!cat && hidden.includes(cat);
}

/** 整类显隐：切换某个关系分类的开关 */
function cvToggleCat(name) {
  if (!cvData) return;
  const set = new Set(cvData.hiddenCats || []);
  if (set.has(name)) set.delete(name);
  else set.add(name);
  cvData.hiddenCats = [...set];
  cvMarkDirty();
  cvLog('切换关系分类', { cat: name, hidden: cvData.hiddenCats });
  renderCanvas();
}

function cvRelPanelRender() {
  const panel = ui.cvRelPanel;
  if (!panel) return;
  if (!cvData || cvMode !== 'graph' || !cvPlacedCards().length) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }
  const info = cvGraphInfo();
  const visible = cvGraphVisibleIds();
  const focusCard = cvData.cards.find((c) => c.id === info.focusId);
  const links = cvData.links || [];
  const cats = cvRelCategories();
  const hiddenCats = cvData.hiddenCats || [];
  const nameOf = (id) => {
    const c = cvData.cards.find((x) => x.id === id);
    return c ? c.name : '（已删除）';
  };
  /** 找它与参照节点之间的那条关系 */
  const relOf = (a, b) => links.find((l) => (l.from === a && l.to === b) || (l.to === a && l.from === b));

  const groups = new Map();
  const aside = []; // 还没跟任何人连过线的孤立角色
  for (const c of info.cards) {
    if (c.id === info.focusId || !visible.has(c.id)) continue; // 层级外的人已从画布隐藏，不再列入
    const lv = info.level.get(c.id);
    if (lv == null) {
      aside.push(c);
      continue;
    }
    if (!groups.has(lv)) groups.set(lv, []);
    groups.get(lv).push(c);
  }

  const rowHtml = (c, lv) => {
    const ref = lv === 1 ? info.focusId : info.parent.get(c.id);
    const rel = ref ? relOf(ref, c.id) : null;
    const dir = rel && rel.from === ref ? '→' : '←';
    const via = lv >= 2 ? nameOf(ref) : '';
    const off = rel ? hiddenCats.includes(cats.byLabel.get(String(rel.label || '').trim())) : false;
    return (
      `<div class="rel-row" data-id="${escapeHtml(c.id)}"${rel ? ` data-link="${escapeHtml(rel.id)}"` : ''}>` +
      `<span class="rel-name">${escapeHtml(c.name)}</span>` +
      (rel && rel.label ? `<span class="rel-word${off ? ' off' : ''}">${escapeHtml(rel.label)}${dir}</span>` : '') +
      (via ? `<span class="rel-via">经 ${escapeHtml(via)}</span>` : '') +
      '</div>'
    );
  };

  const blocks = [];
  for (const lv of [...groups.keys()].sort((a, b) => a - b)) {
    const list = groups.get(lv);
    blocks.push(
      `<div class="rel-group"><h4>${lv === 1 ? '直接关系' : lv === 2 ? '二度关系' : lv + ' 度关系'} · ${list.length}</h4>` +
        list.map((c) => rowHtml(c, lv)).join('') +
        '</div>'
    );
  }

  const total = visible.size - 1;
  if (aside.length) {
    blocks.push(
      `<div class="rel-group muted"><h4>未关联 · ${aside.length}</h4>` +
        aside
          .map((c) => `<div class="rel-row" data-id="${escapeHtml(c.id)}"><span class="rel-name">${escapeHtml(c.name)}</span></div>`)
          .join('') +
        '</div>'
    );
  }
  // 关系分类条：分类来自本书关系词的聚类，点一下整类显隐
  let catsHtml = '';
  if (cats.list.length) {
    const offCount = cats.list.filter((cat) => hiddenCats.includes(cat.name)).length;
    const shown = links.filter((l) => !cvLinkIsHidden(l)).length;
    catsHtml =
      '<div class="rel-cats"><div class="rel-cats-head"><span>关系分类</span>' +
      `<span class="rel-cats-count">${shown}/${links.length}</span>` +
      (offCount ? '<button class="rel-cats-reset">全部显示</button>' : '') +
      '</div><div class="rel-cats-list">' +
      cats.list
        .map((cat) => {
          const off = hiddenCats.includes(cat.name);
          return (
            `<button class="rel-cat${off ? ' off' : ''}" data-cat="${escapeHtml(cat.name)}"` +
            ` title="${escapeHtml(cat.labels.join('、'))}">${escapeHtml(cat.name)} · ${cat.count}</button>`
          );
        })
        .join('') +
      '</div></div>';
  }

  panel.classList.remove('hidden');
  panel.innerHTML =
    `<div class="rel-head" title="点击收起 / 展开"><span class="rel-title">关系一览</span>` +
    `<span class="rel-focus">圆心 · ${escapeHtml(focusCard ? focusCard.name : '—')}</span>` +
    `<span class="rel-total">${total} 人</span></div>` +
    catsHtml +
    `<div class="rel-body">${blocks.join('') || '<div class="rel-empty">这个圆心还没有任何关系。</div>'}</div>`;

  panel.querySelector('.rel-head').onclick = () => panel.classList.toggle('collapsed');
  for (const btn of panel.querySelectorAll('.rel-cat')) {
    btn.onclick = () => cvToggleCat(btn.dataset.cat);
  }
  const resetCats = panel.querySelector('.rel-cats-reset');
  if (resetCats) {
    resetCats.onclick = () => {
      cvData.hiddenCats = [];
      cvMarkDirty();
      renderCanvas();
    };
  }
  for (const row of panel.querySelectorAll('.rel-row')) {
    const { id, link } = row.dataset;
    row.onmouseenter = () => cvSetHighlight(id, link, true);
    row.onmouseleave = () => cvSetHighlight(id, link, false);
    row.onclick = () => {
      const card = cvData.cards.find((c) => c.id === id);
      if (!card) return;
      cvSelect('card', id);
      cvCenterOn(card.x + CV.cardW / 2, card.y + CV.avatarR);
      renderCounts();
    };
  }
}

/** 画布日志：统一前缀，方便在开发者工具里过滤（控制台搜 [canvas]） */
function cvLog(...args) {
  console.log('[canvas]', ...args);
}

/** 视口快照，日志里统一用它，避免各处拼字符串 */
function cvViewportSnapshot() {
  const vp = cvData.viewport;
  return { x: Math.round(vp.x), y: Math.round(vp.y), zoom: Number(vp.zoom.toFixed(3)) };
}

/** 情绪值（-100 ~ 100）：以基准轴为零点，越往上越激昂 */
function yToLevel(y) {
  return Math.max(-100, Math.min(100, Math.round(((CV.baseline - y) / CV.levelAmp) * 100)));
}

function levelToY(level) {
  const v = Math.max(-100, Math.min(100, Number(level) || 0));
  return Math.round(CV.baseline - (v / 100) * CV.levelAmp);
}

function setCanvasStatus(text, cls) {
  ui.canvasStatus.textContent = text;
  ui.canvasStatus.className = 'dim' + (cls ? ' ' + cls : '');
}

/** 把视口变换写到 DOM：世界层平移缩放，背景点阵跟着走，形成无限延伸感 */
function cvLayout() {
  if (!cvData) return;
  const vp = cvData.viewport;
  ui.canvasWorld.style.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
  ui.canvasViewport.style.backgroundSize = `${26 * vp.zoom}px ${26 * vp.zoom}px`;
  ui.canvasViewport.style.backgroundPosition = `${vp.x}px ${vp.y}px`;
  ui.canvasZoomLabel.textContent = Math.round(vp.zoom * 100) + '%';
}

/** 屏幕坐标 → 世界坐标 */
function cvWorldPoint(e) {
  const rect = ui.canvasViewport.getBoundingClientRect();
  const vp = cvData.viewport;
  return { x: (e.clientX - rect.left - vp.x) / vp.zoom, y: (e.clientY - rect.top - vp.y) / vp.zoom };
}

function cvViewportCenter() {
  const rect = ui.canvasViewport.getBoundingClientRect();
  const vp = cvData.viewport;
  return { x: (rect.width / 2 - vp.x) / vp.zoom, y: (rect.height / 2 - vp.y) / vp.zoom };
}

// ---------- 关系连线的几何计算 ----------

function cvCardCenter(c) {
  return { x: c.x + CV.cardW / 2, y: c.y + CV.cardH / 2 };
}

/** 从卡片头像圆心朝 toward 方向，取头像圆周上的出线点（留 4px 间隙） */
function cvEdgePoint(c, toward) {
  const ctr = cvAvatarCenter(c);
  const dx = toward.x - ctr.x;
  const dy = toward.y - ctr.y;
  const len = Math.hypot(dx, dy);
  if (!len) return { x: ctr.x, y: ctr.y };
  const r = CV.avatarR + 4;
  return { x: ctr.x + (dx / len) * r, y: ctr.y + (dy / len) * r };
}

/** 一条关系的几何：a/b 为两端锚点，ctrl 为弓形控制点，label 为标签落点（沿法线外推，避免压线） */
function cvLinkGeometry(link, byId) {
  const ca = byId.get(link.from);
  const cb = byId.get(link.to);
  if (!ca || !cb) return null;
  const a = cvEdgePoint(ca, cvCardCenter(cb));
  const b = cvEdgePoint(cb, cvCardCenter(ca));
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const bow = Math.min(CV.linkBow, len * 0.14);
  // 法线方向：A→B 与 B→A 的法线相反，两条弧自动分列线两侧，不会重叠
  const nx = -dy / len;
  const ny = dx / len;
  const ctrl = { x: (a.x + b.x) / 2 + nx * bow, y: (a.y + b.y) / 2 + ny * bow };
  const mid = { x: a.x * 0.25 + ctrl.x * 0.5 + b.x * 0.25, y: a.y * 0.25 + ctrl.y * 0.5 + b.y * 0.25 };
  const label = { x: mid.x + nx * 16, y: mid.y + ny * 16 };
  return { a, b, ctrl, mid, label };
}

function cvCardEl(id) {
  return ui.canvasCards.querySelector(`.cv-card[data-id="${id}"]`);
}

/** 拖拽连线时的落点判定：优先真实布局命中，兜底用世界坐标矩形 */
function cvCardHitAt(e, excludeId) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const cardEl = el && el.closest ? el.closest('.cv-card') : null;
  if (cardEl && cardEl.dataset.id !== excludeId) {
    return cvData.cards.find((c) => c.id === cardEl.dataset.id) || null;
  }
  const w = cvWorldPoint(e);
  return (
    cvPlacedCards().find(
      (c) => c.id !== excludeId && w.x >= c.x && w.x <= c.x + CV.cardW && w.y >= c.y && w.y <= c.y + CV.cardH
    ) || null
  );
}

function cvSelect(kind, id) {
  cvSel = kind ? { kind, id } : null;
  for (const el of ui.canvasCards.children) {
    el.classList.toggle('selected', !!(cvSel && cvSel.kind === 'card' && el.dataset.id === cvSel.id));
  }
  for (const halo of ui.canvasSvgRoot.querySelectorAll('.cv-node-halo')) {
    halo.classList.toggle('sel', !!(cvSel && cvSel.kind === 'point' && halo.dataset.id === cvSel.id));
  }
  const onLink = (el) => !!(cvSel && cvSel.kind === 'link' && el.dataset.id === cvSel.id);
  for (const path of ui.canvasSvgRoot.querySelectorAll('.cv-link')) path.classList.toggle('sel', onLink(path));
  for (const label of ui.canvasSvgRoot.querySelectorAll('.cv-link-label')) label.classList.toggle('sel', onLink(label));
  cvDetailRender();
}

// ---------- 画布右侧：卡片详情面板 ----------

/** 出场章节结果按角色卡片 id 缓存；目录树变化、换作品时清空 */
const cvAppearCache = new Map();
let cvDetailSeq = 0;

function cvDetailEmpty() {
  ui.canvasDetailHead.innerHTML = '';
  ui.canvasDetailBody.innerHTML =
    '<div class="cv-detail-empty">点击画布中的卡片、情节点或连线，查看它们的详细信息。</div>';
}

/** 刷新详情面板：选择变化、卡片内容改动、打开画布时调用 */
function cvDetailRender() {
  if (!cvData || !cvSel) return cvDetailEmpty();
  if (cvSel.kind === 'card') {
    const card = cvData.cards.find((c) => c.id === cvSel.id);
    return card ? cvDetailCard(card) : cvDetailEmpty();
  }
  if (cvSel.kind === 'point') {
    const point = cvData.points.find((p) => p.id === cvSel.id);
    return point ? cvDetailPoint(point) : cvDetailEmpty();
  }
  if (cvSel.kind === 'link') {
    const link = cvData.links.find((l) => l.id === cvSel.id);
    return link ? cvDetailLink(link) : cvDetailEmpty();
  }
  cvDetailEmpty();
}

function cvDetailHead(kindText, name) {
  ui.canvasDetailHead.innerHTML =
    '<span class="kind">' + escapeHtml(kindText) + '</span><div class="name">' + escapeHtml(name) + '</div>';
}

/** 正在跑档案分析的卡片；避免同一张卡重复请求 */
const cvProfileBusy = new Set();
/** 本次会话已经自动分析过的卡片；失败也不再反复自动触发 */
const cvProfileTried = new Set();
/** 自动分析队列：一次只跑一个，避免连点角色时同时读整本书 */
let cvProfileQueue = Promise.resolve();
/** 本次会话自动分析失败的卡片，用来在面板里提示可以手动重试 */
const cvProfileFailed = new Set();

/** 卡片 id 在不同作品里可能重复，缓存键要带上作品目录 */
function cvProfileKey(card) {
  return (state.dir || '') + '|' + card.id;
}

function cvProfileHasAny(card) {
  return !!(card.background || card.personality || card.appearance);
}

function cvStagesOf(card) {
  return Array.isArray(card.stages) ? card.stages : [];
}

/** 档案三栏：背景 / 性格 / 外貌，没有内容时给出占位提示 */
function cvProfileSections(card) {
  const busy = cvProfileBusy.has(cvProfileKey(card));
  const fields = [
    ['背景', card.background],
    ['性格', card.personality],
    ['外貌', card.appearance],
  ];
  return fields
    .map(([label, value]) => {
      let body;
      if (value) body = escapeHtml(value);
      else if (busy) body = '<span class="dim">AI 正在读原文分析…</span>';
      else if (cvProfileFailed.has(cvProfileKey(card) + ':full'))
        body = '<span class="dim">自动分析未完成，可点下方「AI 分析档案」重试。</span>';
      else body = '<span class="dim">暂无，点下方「AI 分析档案」从正文提炼。</span>';
      return '<div class="cv-detail-section"><h4>' + label + '</h4><div class="cv-detail-text">' + body + '</div></div>';
    })
    .join('');
}

/** 阶段形象：同一个人在不同人生阶段的样貌变体，点击查看详情 */
function cvStageSection(card) {
  const stages = cvStagesOf(card);
  const busy = cvProfileBusy.has(cvProfileKey(card));
  const hint = '<span class="cv-detail-hint">同一人物的不同阶段</span>';
  if (!stages.length) {
    const placeholder = busy
      ? '<span class="dim">AI 正在按原文整理不同阶段的样貌…</span>'
      : cvProfileFailed.has(cvProfileKey(card) + ':stages')
        ? '<span class="dim">自动生成未完成，可点下方按钮重试。</span>'
        : '<span class="dim">暂无阶段变体，点下方按钮按原文提炼。</span>';
    return (
      '<div class="cv-detail-section"><h4>阶段形象 ' +
      hint +
      '</h4><div class="cv-detail-text">' +
      placeholder +
      '</div>' +
      (busy ? '' : '<div class="cv-detail-inline-actions"><button id="cv-stage-gen">生成阶段形象</button></div>') +
      '</div>'
    );
  }
  return (
    '<div class="cv-detail-section"><h4>阶段形象 ' +
    hint +
    '</h4><div class="cv-stage-list">' +
    stages
      .map((s, i) => {
        const name = s.stage || '阶段 ' + (i + 1);
        const age = s.age ? '<span class="cv-stage-age">' + escapeHtml(s.age) + '</span>' : '';
        return (
          '<button class="cv-stage-item" data-stage="' +
          i +
          '"><span class="cv-stage-top"><span class="cv-stage-name">' +
          escapeHtml(name) +
          '</span>' +
          age +
          '</span><span class="cv-stage-brief">' +
          escapeHtml(s.appearance || s.summary || '暂无描述') +
          '</span></button>'
        );
      })
      .join('') +
    '</div></div>'
  );
}

/** 供档案分析使用的「人物关系」文本 */
function cvCardRelationText(card) {
  return (cvData.links || [])
    .filter((l) => l.from === card.id || l.to === card.id)
    .map((l) => {
      const otherId = l.from === card.id ? l.to : l.from;
      const other = cvData.cards.find((c) => c.id === otherId);
      if (!other) return '';
      return card.name + (l.from === card.id ? '→' : '←') + other.name + '（' + (l.label || '相关') + '）';
    })
    .filter(Boolean)
    .join('；');
}

/** 自动分析串行执行：连点多个角色时排队，避免同时读整本书 */
function cvQueueProfile(card, dir, mode) {
  cvProfileQueue = cvProfileQueue
    .then(() => {
      if (state.dir !== dir) return null;
      return cvAnalyzeProfile(card, { auto: true, mode, dir });
    })
    .catch(() => null);
}

/**
 * 让 AI 从正文提炼角色档案。
 * mode = full：背景 / 性格 / 外貌 + 阶段形象；mode = stages：只补阶段样貌。
 * 自动分析只跑一次，并把 profileAt / stagesAt 落盘，之后点开不再重复生成。
 */
async function cvAnalyzeProfile(card, { auto = false, mode = 'full', dir = state.dir } = {}) {
  if (!dir || !card) return null;
  const key = (dir || '') + '|' + card.id;
  if (cvProfileBusy.has(key)) return null;
  cvProfileBusy.add(key);
  const isSelected = () => !!(cvSel && cvSel.kind === 'card' && cvSel.id === card.id);
  const now = new Date().toISOString();
  if (auto) {
    // 先落标记再请求：即使失败或中途退出，下次点开也不会反复自动生成
    if (mode === 'stages') card.stagesAt = now;
    else card.profileAt = now;
    cvMarkDirty();
    saveCanvasNow();
  }
  if (isSelected() && state.dir === dir) cvDetailRender();
  try {
    const res = await invoke(
      api.analyzeProfile(dir, {
        mode,
        name: card.name,
        aliases: card.aliases || [],
        desc: card.desc || '',
        relations: cvCardRelationText(card),
      })
    );
    if (state.dir !== dir) return res;
    cvProfileFailed.delete(key + ':' + mode);
    if (mode === 'stages') {
      card.stages = res.stages || [];
      card.stagesAt = new Date().toISOString();
    } else {
      card.background = res.background || '';
      card.personality = res.personality || '';
      card.appearance = res.appearance || '';
      card.profileAt = new Date().toISOString();
      if ((res.stages || []).length) {
        card.stages = res.stages;
        card.stagesAt = card.profileAt;
      }
    }
    renderCards();
    renderCardList();
    cvMarkDirty();
    if (!auto) toast(mode === 'stages' ? '已生成「' + card.name + '」的阶段形象' : '已补全「' + card.name + '」的角色档案');
    saveCanvasNow();
    return res;
  } catch (err) {
    // 自动分析失败就安静退回占位提示，用户仍可点按钮重试
    cvProfileFailed.add(key + ':' + mode);
    if (!auto) toast('分析失败：' + err.message);
    return null;
  } finally {
    cvProfileBusy.delete(key);
    if (isSelected() && state.dir === dir) cvDetailRender();
  }
}

/** 阶段变体详情：查看并修改某个阶段的样貌 */
function showStageModal(card, index) {
  const stage = cvStagesOf(card)[index];
  if (!stage) return;
  showModal((box, close) => {
    box.classList.add('profile-modal');
    const title = document.createElement('h3');
    title.textContent = (card.name || '角色') + ' · ' + (stage.stage || '阶段形象');
    box.append(title);

    const sub = document.createElement('div');
    sub.className = 'profile-sub';
    sub.textContent = '同一个人在不同人生阶段的样貌变体，不是新角色';
    box.append(sub);

    const mkInput = (labelText, value, placeholder) => {
      const l = document.createElement('label');
      l.textContent = labelText;
      const i = document.createElement('input');
      i.type = 'text';
      i.placeholder = placeholder || '';
      i.value = value || '';
      box.append(l, i);
      return i;
    };
    const mkArea = (labelText, value, placeholder) => {
      const l = document.createElement('label');
      l.textContent = labelText;
      const t = document.createElement('textarea');
      t.placeholder = placeholder || '';
      t.value = value || '';
      box.append(l, t);
      return t;
    };

    const stageInput = mkInput('阶段', stage.stage, '如：幼年 / 少年 / 青年 / 中年 / 老年');
    const ageInput = mkInput('年龄', stage.age, '如：约 8 岁 / 二十出头');
    const appearanceArea = mkArea('样貌', stage.appearance, '该阶段的外貌、服饰、气质…');
    const summaryArea = mkArea('阶段说明', stage.summary, '该阶段的身份、处境或关键变化…');

    const actions = document.createElement('div');
    actions.className = 'overlay-actions';
    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.onclick = () => close(false);
    const ok = document.createElement('button');
    ok.className = 'primary';
    ok.textContent = '保存';
    ok.onclick = () => {
      stage.stage = stageInput.value.trim();
      stage.age = ageInput.value.trim();
      stage.appearance = appearanceArea.value.trim();
      stage.summary = summaryArea.value.trim();
      close(true);
    };
    actions.append(cancel, ok);
    box.append(actions);
    stageInput.focus();
  }).then((saved) => {
    if (!saved) return;
    renderCards();
    cvDetailRender();
    cvMarkDirty();
    saveCanvasNow();
  });
}

function cvDetailCard(card) {
  cvDetailHead('角色卡片', card.name || '未命名');
  const aliases = (card.aliases || []).filter(Boolean);
  const rels = (cvData.links || []).filter((l) => l.from === card.id || l.to === card.id);
  const busy = cvProfileBusy.has(cvProfileKey(card));
  const parts = [];
  if (aliases.length) {
    parts.push(
      '<div class="cv-detail-section"><h4>别名</h4><div class="cv-detail-chips">' +
        aliases.map((a) => '<span class="cv-detail-chip">' + escapeHtml(a) + '</span>').join('') +
        '</div></div>'
    );
  }
  parts.push(
    '<div class="cv-detail-section"><h4>角色介绍</h4><div class="cv-detail-text">' +
      (card.desc ? escapeHtml(card.desc) : '<span class="dim">暂无介绍，双击卡片可补充。</span>') +
      '</div></div>'
  );
  parts.push(cvProfileSections(card));
  parts.push(cvStageSection(card));
  parts.push(
    '<div class="cv-detail-section"><h4>人物关系</h4>' +
      (rels.length
        ? rels.map((l) => cvDetailRelRow(l, card.id)).join('')
        : '<div class="cv-detail-empty">尚未建立关系，可从卡片右侧手柄拖拽连线。</div>') +
      '</div>'
  );
  parts.push(
    '<div class="cv-detail-section"><h4>出场章节</h4><div id="cv-detail-appear"><div class="cv-detail-empty">正在扫描正文…</div></div></div>'
  );
  parts.push(
    '<div class="cv-detail-actions"><button id="cv-card-edit">编辑档案</button>' +
      '<button id="cv-card-profile"' +
      (busy ? ' disabled' : '') +
      '>' +
      (busy ? '正在分析…' : cvProfileHasAny(card) ? '重新分析档案' : 'AI 分析档案') +
      '</button></div>'
  );
  ui.canvasDetailBody.innerHTML = parts.join('');
  const edit = document.getElementById('cv-card-edit');
  if (edit) edit.onclick = () => editCard(card);
  const ai = document.getElementById('cv-card-profile');
  if (ai) ai.onclick = () => cvAnalyzeProfile(card);
  const stageGen = document.getElementById('cv-stage-gen');
  if (stageGen) stageGen.onclick = () => cvAnalyzeProfile(card, { mode: 'stages' });
  document.querySelectorAll('.cv-stage-item').forEach((btn) => {
    btn.onclick = () => showStageModal(card, Number(btn.dataset.stage));
  });
  cvDetailLoadAppearances(card);

  // 自动生成只跑一次：没有档案就全量分析；已有档案但没有阶段变体就只补阶段
  if (!busy) {
    const key = cvProfileKey(card);
    const stages = cvStagesOf(card);
    if (!cvProfileHasAny(card) && !card.profileAt) {
      if (!cvProfileTried.has(key + ':full')) {
        cvProfileTried.add(key + ':full');
        const dir = state.dir;
        setTimeout(() => {
          if (state.dir === dir && cvSel && cvSel.kind === 'card' && cvSel.id === card.id) cvQueueProfile(card, dir, 'full');
        }, 300);
      }
    } else if (cvProfileHasAny(card) && !stages.length && !card.stagesAt) {
      if (!cvProfileTried.has(key + ':stages')) {
        cvProfileTried.add(key + ':stages');
        const dir = state.dir;
        setTimeout(() => {
          if (state.dir === dir && cvSel && cvSel.kind === 'card' && cvSel.id === card.id) cvQueueProfile(card, dir, 'stages');
        }, 300);
      }
    }
  }
}

function cvDetailRelRow(link, selfId) {
  const otherId = link.from === selfId ? link.to : link.from;
  const other = cvData.cards.find((c) => c.id === otherId);
  const arrow = link.from === selfId ? '&rarr;' : '&larr;';
  return (
    '<div class="cv-detail-item static"><span class="t">' +
    escapeHtml(other ? other.name : '（已删除）') +
    '</span><span class="rel">' +
    arrow +
    ' ' +
    escapeHtml(link.label || '相关') +
    '</span></div>'
  );
}

/** 这个情节点除了标题之外还写了东西没有（含下钻出来的子画布） */
function cvPointHasDetail(point) {
  if (!point) return false;
  if (point.detail || point.who || point.place || point.chapter) return true;
  const sub = point.sub;
  return !!(sub && (sub.points.length || sub.cards.length || sub.links.length));
}

/** 章节 id → 「卷 / 章」的可读名字；章节被删掉时退回 id */
function cvChapterLabel(id) {
  if (!id) return '';
  for (const vol of (state.tree && state.tree.volumes) || []) {
    for (const c of vol.chapters) if (c.id === id) return vol.title + ' / ' + c.title;
  }
  return id;
}

function cvDetailPoint(point) {
  cvDetailHead('情节点', point.title || '未命名');
  const level = yToLevel(point.y);
  const parts = [];
  parts.push(
    '<div class="cv-detail-section"><h4>情绪强度</h4><div class="cv-detail-text">' +
      (level > 0 ? '+' : '') +
      level +
      '<span class="dim"> / ' +
      (level >= 60 ? '高潮' : level >= 20 ? '上扬' : level <= -60 ? '谷底' : level <= -20 ? '低沉' : '平稳') +
      '</span></div></div>'
  );
  parts.push(
    '<div class="cv-detail-section"><h4>一句话</h4><div class="cv-detail-text">' +
      (point.desc ? escapeHtml(point.desc) : '<span class="dim">还没写，点「编辑节点信息」补一句。</span>') +
      '</div></div>'
  );
  if (point.who) {
    parts.push(
      '<div class="cv-detail-section"><h4>涉及人物</h4><div class="cv-detail-chips">' +
        point.who
          .split(/[、,，\/]+/)
          .filter(Boolean)
          .map((n) => '<span class="cv-detail-chip">' + escapeHtml(n.trim()) + '</span>')
          .join('') +
        '</div></div>'
    );
  }
  if (point.place) {
    parts.push('<div class="cv-detail-section"><h4>地点</h4><div class="cv-detail-text">' + escapeHtml(point.place) + '</div></div>');
  }
  if (point.chapter) {
    parts.push(
      '<div class="cv-detail-section"><h4>关联章节</h4><div class="cv-detail-text"><span class="dim">' +
        escapeHtml(cvChapterLabel(point.chapter)) +
        '</span></div></div>'
    );
  }
  parts.push(
    '<div class="cv-detail-section"><h4>详细经过</h4><div class="cv-detail-text">' +
      (point.detail
        ? escapeHtml(point.detail)
        : '<span class="dim">还没写。点「编辑节点信息」把起因、经过、结果写清楚。</span>') +
      '</div></div>'
  );
  if (point.sub && (point.sub.points.length || point.sub.cards.length || point.sub.links.length)) {
    parts.push(
      '<div class="cv-detail-section"><h4>子画布</h4><div class="cv-detail-text"><span class="dim">' +
        '已拆出 ' +
        point.sub.points.length +
        ' 个情节点、' +
        point.sub.cards.length +
        ' 张角色卡片。双击节点即可进入。' +
        '</span></div></div>'
    );
  }
  parts.push(
    '<div class="cv-detail-actions"><button id="cv-point-enter">进入子画布</button>' +
      '<button id="cv-point-open">编辑节点信息</button></div>'
  );
  ui.canvasDetailBody.innerHTML = parts.join('');
  const enter = document.getElementById('cv-point-enter');
  if (enter) enter.onclick = () => cvEnterPoint(point.id);
  const open = document.getElementById('cv-point-open');
  if (open) open.onclick = () => openPointPage(point.id);
}

function cvDetailLink(link) {
  const from = cvData.cards.find((c) => c.id === link.from);
  const to = cvData.cards.find((c) => c.id === link.to);
  const fn = from ? from.name : '（已删除）';
  const tn = to ? to.name : '（已删除）';
  cvDetailHead('人物关系', fn + ' → ' + tn);
  ui.canvasDetailBody.innerHTML =
    '<div class="cv-detail-section"><h4>关系</h4><div class="cv-detail-text">' +
    escapeHtml(fn) +
    ' <span class="rel">→ ' +
    escapeHtml(link.label || '相关') +
    '</span> ' +
    escapeHtml(tn) +
    '</div></div>' +
    '<div class="cv-detail-section"><h4>操作</h4><div class="cv-detail-empty">双击连线可改关系词，右键或按 Delete 可删除。</div></div>';
}

/** 异步拉取该角色的出场章节，写入面板；快速切换选中时丢弃过期结果 */
async function cvDetailLoadAppearances(card) {
  const seq = ++cvDetailSeq;
  const terms = [card.name, ...(card.aliases || [])].filter(Boolean);
  if (!terms.length) {
    const box = document.getElementById('cv-detail-appear');
    if (box) box.innerHTML = '<div class="cv-detail-empty">卡片没有名称，无法统计出场章节。</div>';
    return;
  }
  let rows = cvAppearCache.get(card.id);
  if (!rows) {
    try {
      rows = await api.chapterAppearances(state.dir, terms);
    } catch (err) {
      if (seq === cvDetailSeq) {
        const box = document.getElementById('cv-detail-appear');
        if (box) box.innerHTML = '<div class="cv-detail-empty">扫描失败：' + escapeHtml(err && err.message ? err.message : String(err)) + '</div>';
      }
      return;
    }
    rows = Array.isArray(rows) ? rows : [];
    cvAppearCache.set(card.id, rows);
  }
  if (seq !== cvDetailSeq) return; // 选中已切走
  const box = document.getElementById('cv-detail-appear');
  if (!box) return;
  if (!rows.length) {
    box.innerHTML = '<div class="cv-detail-empty">正文中暂未出现该角色。</div>';
    return;
  }
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  box.innerHTML =
    '<div class="cv-detail-empty" style="margin-bottom:6px">共 ' + rows.length + ' 章 · ' + total + ' 次</div>' +
    rows
      .map((r) => {
        const label = r.volume ? r.volume + ' · ' + r.title : r.title;
        return (
          '<div class="cv-detail-item" data-ch="' + escapeHtml(r.id) + '" data-at="' + r.at + '" data-len="' + terms[0].length + '">' +
          '<span class="t">' + escapeHtml(label) + '</span><span class="n">' + r.count + ' 次</span></div>'
        );
      })
      .join('');
  for (const el of box.querySelectorAll('.cv-detail-item')) {
    el.onclick = () => cvOpenAppearance(el.dataset.ch, Number(el.dataset.at), Number(el.dataset.len));
  }
}

/** 点出场章节：打开该章并把光标落到角色首次出现的位置 */
async function cvOpenAppearance(chId, at, len) {
  await openChapter(chId);
  if (state.id !== chId) return;
  const total = ui.editor.value.length;
  const start = Math.max(0, Math.min(total, at));
  const end = Math.min(total, start + Math.max(1, len || 1));
  ui.editor.focus();
  ui.editor.setSelectionRange(start, end);
  scrollCaretIntoView(start, true);
  syncLayerScroll();
}

/** 情节点之间叠一层微弱涟漪，靠近节点处淡出，节点仍精确落在曲线上 */
function cvRipple(x, nodes) {
  let near = Infinity;
  for (const nd of nodes) near = Math.min(near, Math.abs(x - nd.x));
  const w = Math.min(1, Math.max(0, (near - 24) / CV.rippleFade));
  if (w <= 0) return 0;
  return CV.rippleAmp * w * Math.sin((x / CV.rippleWave) * Math.PI * 2);
}

/** Catmull-Rom 样条（按 x 排序）→ 平滑折线路径，保证线条随情绪起伏而非直线 */
function cvCurvePath(pts) {
  const n = pts.length;
  const at = (i) => pts[Math.max(0, Math.min(n - 1, i))];
  const cat = (a, b, c, d, t) => {
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  };
  const nodes = pts.map((q) => ({ x: q.x, y: q.y }));
  const out = [];
  for (let i = 0; i < n - 1; i += 1) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const steps = Math.max(6, Math.min(120, Math.round(Math.abs(p2.x - p1.x) / 7)));
    for (let s = 0; s <= steps; s += 1) {
      if (i > 0 && s === 0) continue; // 段与段之间不重复起点
      const t = s / steps;
      const x = Math.min(p2.x, Math.max(p1.x, cat(p0.x, p1.x, p2.x, p3.x, t)));
      const y = cat(p0.y, p1.y, p2.y, p3.y, t) + cvRipple(x, nodes);
      out.push(`${out.length ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`);
    }
  }
  return out.join(' ');
}

function cvLabelSide(pts, i) {
  const p = pts[i];
  const prev = pts[i - 1] || p;
  const next = pts[i + 1] || p;
  // 峰顶把标签放下方、谷底放上方，避免压在曲线上
  if (p.y <= Math.min(prev.y, next.y)) return 'below';
  if (p.y >= Math.max(prev.y, next.y)) return 'above';
  return 'below';
}

function renderStoryline() {
  const pts = [...cvData.points].sort((a, b) => a.x - b.x);
  const parts = [];
  parts.push(
    `<line class="cv-guide" x1="${CV.left - 140}" y1="${CV.baseline}" x2="${CV.left + CV.width + 140}" y2="${CV.baseline}" />`
  );
  parts.push(`<text class="cv-axis-label" x="${CV.left - 140}" y="${CV.baseline + 34}" text-anchor="middle">开端</text>`);
  parts.push(
    `<text class="cv-axis-label" x="${CV.left + CV.width + 140}" y="${CV.baseline + 34}" text-anchor="middle">结局</text>`
  );

  if (pts.length >= 2) {
    const d = cvCurvePath(pts);
    parts.push(`<path class="cv-glow" d="${d}" />`);
    parts.push(`<path class="cv-glow-2" d="${d}" />`);
    parts.push(`<path class="cv-line" d="${d}" />`);
  }

  pts.forEach((p, i) => {
    const above = cvLabelSide(pts, i) === 'above';
    const selectable = !!(cvSel && cvSel.kind === 'point' && cvSel.id === p.id);
    parts.push(`<circle class="cv-node-halo${selectable ? ' sel' : ''}" data-id="${escapeHtml(p.id)}" cx="${p.x}" cy="${p.y}" r="16" />`);
    parts.push(`<circle class="cv-node" cx="${p.x}" cy="${p.y}" r="6" />`);
    const ty = above ? p.y - 42 : p.y + 34;
    const dy = above ? p.y - 24 : p.y + 52;
    parts.push(`<text class="cv-node-title cv-node-text" x="${p.x}" y="${ty}" text-anchor="middle">${escapeHtml(p.title)}</text>`);
    if (p.desc) parts.push(`<text class="cv-node-desc cv-node-text" x="${p.x}" y="${dy}" text-anchor="middle">${escapeHtml(p.desc)}</text>`);
    // 有详细内容的情节点标一个小点：提示「双击进去还有东西看」
    if (cvPointHasDetail(p)) parts.push(`<circle class="cv-node-more" cx="${p.x + 11}" cy="${p.y - 11}" r="4" />`);
    parts.push(`<circle class="cv-node-hit" data-id="${escapeHtml(p.id)}" cx="${p.x}" cy="${p.y}" r="18" />`);
  });

  ui.canvasSvgRoot.innerHTML = parts.join('');

  for (const hit of ui.canvasSvgRoot.querySelectorAll('.cv-node-hit')) {
    const p = cvData.points.find((x) => x.id === hit.dataset.id);
    if (!p) continue;
    hit.addEventListener('mousedown', (e) => startPointDrag(e, p));
    hit.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      cvEnterPoint(p.id);
    });
    hit.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      cvSelect('point', p.id);
      showContextMenu(e.clientX, e.clientY, [
        { label: '进入子画布', run: () => cvEnterPoint(p.id) },
        { label: '编辑节点信息', run: () => openPointPage(p.id) },
        { label: '删除情节点', run: () => removePoint(p.id) },
      ]);
    });
  }
}

/** 知识图谱层：把角色卡片之间的有向关系画成带箭头与标签的弧线 */
function renderGraph() {
  const visible = cvGraphVisibleIds();
  const byId = new Map(
    cvPlacedCards()
      .filter((c) => visible.has(c.id))
      .map((c) => [c.id, c])
  );
  const parts = [];
  parts.push(
    '<defs>' +
      '<marker id="cv-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">' +
      '<path d="M0,0 L10,5 L0,10 z" fill="#8fa2c0" /></marker>' +
      '<marker id="cv-arrow-sel" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">' +
      '<path d="M0,0 L10,5 L0,10 z" fill="#e6bd70" /></marker>' +
      '</defs>'
  );

  const hits = [];
  // 径向布局留下的参考环与层标：让「几度关系」一眼可读
  if (cvGraphMeta) {
    const m = cvGraphMeta;
    parts.push(`<circle class="cv-focus-halo" cx="${m.cx}" cy="${m.cy}" r="54" />`);
    for (const ring of m.rings) {
      parts.push(`<circle class="cv-ring" cx="${m.cx}" cy="${m.cy}" r="${ring.r}" />`);
      // 层标落在环的左上方斜角：顶部被关系面板挡住，左侧又撞素材栏，斜角是唯一稳定空位
      const lx = (m.cx - ring.r * 0.72).toFixed(1);
      const ly = (m.cy - ring.r * 0.72).toFixed(1);
      parts.push(
        `<text class="cv-ring-label" x="${lx}" y="${ly}" text-anchor="middle">${escapeHtml(ring.label)}</text>`
      );
    }
  }
  for (const link of cvData.links) {
    if (cvLinkIsHidden(link)) continue; // 归到被关掉的分类里，整条关系（线 + 关系词 + 命中层）都不画
    const g = cvLinkGeometry(link, byId);
    if (!g) continue;
    const id = escapeHtml(link.id);
    const sel = !!(cvSel && cvSel.kind === 'link' && cvSel.id === link.id);
    const d = `M ${g.a.x.toFixed(1)} ${g.a.y.toFixed(1)} Q ${g.ctrl.x.toFixed(1)} ${g.ctrl.y.toFixed(1)} ${g.b.x.toFixed(
      1
    )} ${g.b.y.toFixed(1)}`;
    parts.push(
      `<path class="cv-link${sel ? ' sel' : ''}" data-id="${id}" d="${d}" marker-end="url(#${
        sel ? 'cv-arrow-sel' : 'cv-arrow'
      })" />`
    );
    if (link.label) {
      parts.push(
        `<text class="cv-link-label${sel ? ' sel' : ''}" data-id="${id}" x="${g.label.x.toFixed(1)}" y="${g.label.y.toFixed(
          1
        )}" text-anchor="middle" dominant-baseline="middle">${escapeHtml(link.label)}</text>`
      );
    }
    // 命中层最后入：细线也能点中
    hits.push(`<path class="cv-link-hit" data-id="${id}" d="${d}" />`);
  }
  parts.push(...hits);

  ui.canvasSvgRoot.innerHTML = parts.join('');

  for (const hit of ui.canvasSvgRoot.querySelectorAll('.cv-link-hit')) {
    const link = cvData.links.find((l) => l.id === hit.dataset.id);
    if (!link) continue;
    hit.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      cvSelect('link', link.id);
    });
    hit.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      editLink(link);
    });
    hit.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      cvSelect('link', link.id);
      showContextMenu(e.clientX, e.clientY, [
        { label: '编辑关系', run: () => editLink(link) },
        { label: '删除关系', run: () => removeLink(link.id) },
      ]);
    });
  }
}

/** 中间层按当前视图模式二选一：故事线 / 知识图谱 */
function cvRenderLayer() {
  if (!cvData) return;
  if (cvMode === 'graph') renderGraph();
  else renderStoryline();
}

/** 把模式相关的 UI（按钮、素材栏）同步到当前 cvMode */
function cvSyncModeUi() {
  const graph = cvMode === 'graph';
  const story = $('cv-mode-story');
  const graphBtn = $('cv-mode-graph');
  if (story) story.classList.toggle('active', !graph);
  if (graphBtn) graphBtn.classList.toggle('active', graph);
  const palPoint = $('pal-point');
  if (palPoint) palPoint.classList.toggle('hidden', graph);
  // 角色卡片只在图谱里画，故事线下把「+ 角色卡片」素材也收起来
  const palCard = $('pal-card');
  if (palCard) palCard.classList.toggle('hidden', !graph);
  cvSyncGraphTools();
}

function setCanvasMode(mode) {
  mode = mode === 'graph' ? 'graph' : 'story';
  if (cvMode === mode) return;
  cvMode = mode;
  if (cvData) cvData.mode = mode;
  if (mode === 'graph' && cvSel && cvSel.kind === 'point') cvSel = null;
  if (mode === 'story' && cvSel && cvSel.kind === 'link') cvSel = null;
  cvLog('切换画布视图', { mode });
  cvSyncModeUi();
  renderCanvas();
  // 进图谱就把关系按「以圆心为中心」重排一次，省得用户每次手动整理
  if (mode === 'graph') cvRelayoutGraph(true);
  else cvMarkDirty();
}

function renderCards() {
  ui.canvasCards.innerHTML = '';
  // 角色卡片只属于知识图谱；故事线里只画情节点和情绪起伏曲线
  if (cvMode !== 'graph') return;
  const visible = cvGraphVisibleIds(); // 当前层级外的人不渲染，真正做到「层级过滤」
  for (const card of cvPlacedCards()) {
    if (!visible.has(card.id)) continue;
    const el = document.createElement('div');
    el.className = 'cv-card';
    el.dataset.id = card.id;
    el.style.left = card.x + 'px';
    el.style.top = card.y + 'px';
    el.title = [card.name + (card.aliases.length ? '（' + card.aliases.join('、') + '）' : ''), card.desc]
      .filter(Boolean)
      .join('\n');
    if (cvSel && cvSel.kind === 'card' && cvSel.id === card.id) el.classList.add('selected');
    if (cvMode === 'graph' && cvData.focus === card.id) el.classList.add('focus');

    const av = document.createElement('div');
    av.className = 'cv-avatar';
    av.innerHTML = CV_AVATAR_SVG;
    const name = document.createElement('div');
    name.className = 'cv-card-name';
    name.textContent = card.name;
    el.append(av, name);

    // 知识图谱模式才挂连线手柄
    if (cvMode === 'graph') {
      const handle = document.createElement('div');
      handle.className = 'cv-connect-handle';
      handle.title = '拖拽到另一张卡片建立关系';
      handle.addEventListener('mousedown', (e) => startLinkDrag(e, card));
      el.append(handle);
    }

    el.addEventListener('mousedown', (e) => startCardDrag(e, card, el));
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      editCard(card);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      cvSelect('card', card.id);
      const items = [];
      if (cvMode === 'graph' && cvData.focus !== card.id) {
        items.push({ label: '设为圆心', run: () => cvSetFocus(card.id) });
      }
      items.push({ label: '编辑卡片', run: () => editCard(card) });
      items.push({ label: '从画布移除', run: () => removeCard(card.id) });
      showContextMenu(e.clientX, e.clientY, items);
    });
    ui.canvasCards.append(el);
  }
}

/** 空画布引导：故事线模式看卡片+情节点，图谱模式只看卡片（只统计已上画布的） */
function cvUpdateHint() {
  if (!cvData) return;
  const graph = cvMode === 'graph';
  const placed = cvPlacedCards().length;
  const empty = graph ? !placed : !cvData.points.length;
  ui.canvasHint.classList.toggle('hidden', !empty);
  if (empty) {
    const nested = cvTrail.length > 0;
    ui.canvasHint.textContent = graph
      ? '空白画布\n先从左侧「角色卡片」把人物拖进来，再从卡片右侧圆点拖到另一张卡片建立关系'
      : nested
        ? '空白子画布\n从下方素材栏添加情节点，把这一节拆成更细的几拍\n双击情节点还能继续往下钻 · 点顶部路径返回上一级'
        : '空白画布\n从下方素材栏添加情节点，上下拖动节点调整情绪高低\n双击节点进入它自己的子画布，继续往下拆\n滚轮缩放 · 拖拽空白处平移';
  } else {
    ui.canvasHint.textContent = '';
  }
}

function renderCanvas() {
  if (!cvData) return;
  cvLayout();
  cvRenderLayer();
  renderCards();
  cvUpdateHint();
  renderCounts();
  cvSyncGraphTools();
  cvRelPanelRender();
  cvDetailRender();
}

// ---------- 左栏「角色卡片 / 剧情卡片」列表（与画布共用一份数据） ----------

/** 把某个世界坐标点摆到视口正中 */
function cvCenterOn(wx, wy) {
  if (!cvData) return;
  const rect = ui.canvasViewport.getBoundingClientRect();
  const vp = cvData.viewport;
  vp.x = rect.width / 2 - wx * vp.zoom;
  vp.y = rect.height / 2 - wy * vp.zoom;
  cvLayout();
}

function renderCardList() {
  if (!ui.cardList) return;
  const cards = cvData ? cvData.cards : [];
  const placed = cards.filter((c) => c.placed).length;
  ui.cardCount.textContent = cards.length ? `${cards.length} 个 · 画布 ${placed}` : '';
  ui.cardList.innerHTML = '';
  if (!cards.length) {
    const empty = document.createElement('div');
    empty.className = 'rail-empty';
    empty.textContent = '还没有角色卡片。\n点下面「+ 角色卡片」新建一个，再拖到画布上摆放。';
    ui.cardList.append(empty);
    return;
  }
  for (const card of cards) {
    const node = document.createElement('div');
    node.className = 'rail-item';
    if (!card.placed) node.classList.add('unplaced');
    node.dataset.id = card.id;
    const monogram = document.createElement('div');
    monogram.className = 'cv-mono';
    monogram.textContent = card.name.trim().slice(0, 1) || '·';
    const meta = document.createElement('div');
    meta.className = 'cv-meta';
    const t = document.createElement('div');
    t.className = 't';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = card.name;
    t.append(nm);
    if (!card.placed) {
      const tag = document.createElement('span');
      tag.className = 'rail-tag';
      tag.textContent = '未上画布';
      t.append(tag);
    }
    const s = document.createElement('div');
    s.className = 's';
    s.textContent = card.desc || (card.aliases.length ? '又名 ' + card.aliases.join('、') : '还没有简介');
    meta.append(t, s);
    node.append(monogram, meta);
    cvCardRailGesture(node, card);
    node.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, [
        { label: '编辑卡片', run: () => editCard(card) },
        card.placed
          ? { label: '从画布移除', run: () => removeCard(card.id) }
          : { label: '放到画布', run: () => putCardOnCanvas(card) },
        { label: '删除角色', run: () => deleteCard(card.id) },
      ]);
    };
    ui.cardList.append(node);
  }
}

/** 左栏角色项：点一下定位（未上画布的会先摆到视口中央），按住拖到画布即落到该处 */
function cvCardRailGesture(node, card) {
  node.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    let ghost = null;
    const onMove = (ev) => {
      if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 4) {
        moved = true;
        node.classList.add('dragging');
        ghost = document.createElement('div');
        ghost.className = 'cv-ghost';
        ghost.textContent = card.name;
        document.body.append(ghost);
      }
      if (ghost) {
        ghost.style.left = ev.clientX + 14 + 'px';
        ghost.style.top = ev.clientY + 14 + 'px';
      }
    };
    const onUp = async (ev) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      node.classList.remove('dragging');
      if (ghost) ghost.remove();
      if (!moved) {
        focusCanvasItem('card', card.id);
        return;
      }
      const rect = ui.canvasViewport.getBoundingClientRect();
      const inside =
        ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom;
      if (!inside || ui.canvasPane.classList.contains('hidden')) {
        cvLog('取消放置：落点不在画布上', { id: card.id });
        return;
      }
      await loadCanvasData();
      if (!cvData) return;
      cvPlaceCardAt(card, cvWorldPoint(ev));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

/** 把角色摆到画布上指定世界坐标（坐标是卡片中心） */
function cvPlaceCardAt(card, world) {
  if (cvMode !== 'graph') setCanvasMode('graph'); // 角色卡片只存在于图谱视图
  card.x = Math.round(world.x - CV.cardW / 2);
  card.y = Math.round(world.y - CV.cardH / 3);
  card.placed = true;
  renderCanvas();
  renderCardList();
  cvSelect('card', card.id);
  cvMarkDirty();
  cvLog('角色上画布', { id: card.id, name: card.name, at: { x: card.x, y: card.y } });
}

/** 右键「放到画布」：摆到当前视口中央 */
async function putCardOnCanvas(card) {
  const fresh = await loadCanvasData();
  if (!cvData) return;
  if (ui.canvasPane.classList.contains('hidden')) {
    ui.editorPane.classList.add('hidden');
    ui.canvasPane.classList.remove('hidden');
    setCanvasStatus('就绪');
    cvSyncModeUi();
    renderCanvas();
    if (fresh) cvFit();
  }
  const c = cvViewportCenter();
  cvPlaceCardAt(card, { x: c.x, y: c.y });
}

function renderBeatList() {
  if (!ui.beatList) return;
  const points = cvData ? [...cvData.points].sort((a, b) => a.x - b.x) : [];
  ui.beatCount.textContent = points.length ? `${points.length} 个` : '';
  ui.beatList.innerHTML = '';
  if (!points.length) {
    const empty = document.createElement('div');
    empty.className = 'rail-empty';
    empty.textContent = '还没有剧情卡片。\n点下面「+ 剧情卡片」，或去画布的素材栏拖一个情节点。';
    ui.beatList.append(empty);
    return;
  }
  for (const p of points) {
    const level = yToLevel(p.y);
    const node = document.createElement('div');
    node.className = 'rail-item';
    node.dataset.id = p.id;
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = p.title;
    const s = document.createElement('div');
    s.className = 's';
    s.textContent = `${level > 0 ? '情绪 +' : '情绪 '}${level}${p.desc ? ' · ' + p.desc : ''}`;
    node.append(t, s);
    node.onclick = () => focusCanvasItem('point', p.id);
    // 左栏可能停在正文页：先打开画布再下钻，避免子画布在后台打开而看不到
    const enterSub = async () => {
      await openCanvas();
      cvEnterPoint(p.id);
    };
    node.ondblclick = () => enterSub();
    node.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, [
        { label: '进入子画布', run: enterSub },
        { label: '编辑节点信息', run: () => openPointPage(p.id) },
        { label: '删除情节点', run: () => removePoint(p.id) },
      ]);
    };
    ui.beatList.append(node);
  }
}

/** 点击左栏列表项 → 打开画布并把目标摆到视口正中 */
async function focusCanvasItem(kind, id) {
  const fresh = await loadCanvasData();
  if (!cvData) return;
  if (ui.canvasPane.classList.contains('hidden')) {
    ui.editorPane.classList.add('hidden');
    ui.canvasPane.classList.remove('hidden');
    setCanvasStatus('就绪');
    cvSyncModeUi();
    renderCanvas();
    if (fresh) cvFit();
  }
  // 角色卡片只在图谱视图里画，情节点只在故事线视图里画，点侧栏时自动切到对应视图
  if (kind === 'card' && cvMode !== 'graph') setCanvasMode('graph');
  if (kind === 'point' && cvMode === 'graph') setCanvasMode('story');
  const item =
    kind === 'card' ? cvData.cards.find((c) => c.id === id) : cvData.points.find((p) => p.id === id);
  if (!item) return;
  // 角色还没上画布：先摆到视口中央，再定位过去
  if (kind === 'card' && !item.placed) {
    const c = cvViewportCenter();
    item.x = Math.round(c.x - CV.cardW / 2);
    item.y = Math.round(c.y - CV.cardH / 3);
    item.placed = true;
    renderCanvas();
    renderCardList();
    cvMarkDirty();
  }
  cvSelect(kind, id);
  const cx = kind === 'card' ? item.x + CV.cardW / 2 : item.x;
  const cy = kind === 'card' ? item.y + CV.cardH / 2 : item.y;
  cvCenterOn(cx, cy);
  renderCounts();
  cvLog('从侧栏定位到画布', { kind, id, at: { x: Math.round(cx), y: Math.round(cy) } });
}

/** 左栏底部按钮：角色只新建进角色库（不上画布、不跳画布）；情节点仍直接落到画布上 */
async function addFromRail(kind) {
  const fresh = await loadCanvasData();
  if (!cvData) return;
  if (kind === 'card') {
    const card = {
      id: cvNewId('card'),
      name: cvUniqueName('新角色', cvData.cards.map((c) => c.name)),
      aliases: [],
      desc: '',
      x: 0,
      y: 0,
      placed: false,
    };
    cvData.cards.push(card);
    renderCardList();
    renderCounts();
    cvMarkDirty();
    cvLog('新建角色入库', { id: card.id, name: card.name, total: cvData.cards.length });
    toast('已新建角色，拖到画布上即可摆放');
    return;
  }
  // 情节点只存在于故事线视图，图谱模式自动切回去
  if (cvMode === 'graph') setCanvasMode('story');
  if (ui.canvasPane.classList.contains('hidden')) {
    ui.editorPane.classList.add('hidden');
    ui.canvasPane.classList.remove('hidden');
    setCanvasStatus('就绪');
    cvSyncModeUi();
    renderCanvas();
    if (fresh) cvFit();
  }
  cvAddPointAt(cvViewportCenter(), false);
}

// ---------- 画布交互 ----------

function startCardDrag(e, card, el) {
  if (e.button !== 0) return;
  e.stopPropagation();
  cvSelect('card', card.id);
  const start = cvWorldPoint(e);
  const ox = card.x;
  const oy = card.y;
  let moved = false;
  el.classList.add('dragging');
  cvLog('拖拽卡片开始', { id: card.id, name: card.name, from: { x: ox, y: oy }, zoom: cvViewportSnapshot().zoom });
  const onMove = (ev) => {
    const p = cvWorldPoint(ev);
    const dx = p.x - start.x;
    const dy = p.y - start.y;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) moved = true;
    card.x = Math.round(ox + dx);
    card.y = Math.round(oy + dy);
    el.style.left = card.x + 'px';
    el.style.top = card.y + 'px';
    if (cvMode === 'graph') cvRenderLayer(); // 挪卡片时关系线跟着走
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    el.classList.remove('dragging');
    cvLog('拖拽卡片结束', { id: card.id, name: card.name, to: { x: card.x, y: card.y }, moved });
    if (moved) cvMarkDirty();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function startPointDrag(e, p) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  cvSelect('point', p.id);
  const start = cvWorldPoint(e);
  const ox = p.x;
  const oy = p.y;
  let moved = false;
  cvLog('拖拽情节点开始', { id: p.id, title: p.title, from: { x: ox, y: oy }, level: yToLevel(oy) });
  const onMove = (ev) => {
    const q = cvWorldPoint(ev);
    const dx = q.x - start.x;
    const dy = q.y - start.y;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) moved = true;
    p.x = Math.round(ox + dx);
    p.y = Math.round(oy + dy);
    cvRenderLayer();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    cvLog('拖拽情节点结束', { id: p.id, title: p.title, to: { x: p.x, y: p.y }, level: yToLevel(p.y), moved });
    if (moved) {
      renderBeatList();
      cvMarkDirty();
    }
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ---------- 知识图谱：建立 / 编辑 / 删除关系 ----------

/** 从卡片右侧手柄拖出一条线，松在另一张卡片上即建立关系 */
function startLinkDrag(e, card) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  cvLog('拖拽连线开始', { from: card.id, name: card.name });
  const temp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  temp.setAttribute('class', 'cv-link-temp');
  temp.setAttribute('marker-end', 'url(#cv-arrow)');
  ui.canvasSvgRoot.append(temp);
  let target = null;

  const onMove = (ev) => {
    const w = cvWorldPoint(ev);
    const a = cvEdgePoint(card, w);
    temp.setAttribute('d', `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} L ${w.x.toFixed(1)} ${w.y.toFixed(1)}`);
    const t = cvCardHitAt(ev, card.id);
    if (t !== target) {
      if (target) {
        const prev = cvCardEl(target.id);
        if (prev) prev.classList.remove('link-target');
      }
      target = t;
      if (target) {
        const next = cvCardEl(target.id);
        if (next) next.classList.add('link-target');
      }
    }
  };
  const onUp = (ev) => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    temp.remove();
    if (target) {
      const last = cvCardEl(target.id);
      if (last) last.classList.remove('link-target');
    }
    cvLog('拖拽连线结束', { from: card.id, to: target ? target.id : null });
    if (!target) return; // 松在空白：静默取消
    createLink(card, target);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

/** 关系词输入弹窗：空串也要能提交，所以走 close({ label }) 而不是 close(null) */
function linkLabelModal(fromCard, toCard, current) {
  return showModal((box, close) => {
    box.innerHTML = `<h3>${current ? '编辑关系' : '建立关系'}</h3><div class="overlay-msg">${escapeHtml(
      fromCard.name
    )} → ${escapeHtml(toCard.name)}</div>`;
    const label = document.createElement('label');
    label.textContent = '关系词（可留空）';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = '如：祖孙、师徒、敌对';
    input.value = current || '';
    box.append(label, input);
    const actions = document.createElement('div');
    actions.className = 'overlay-actions';
    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.onclick = () => close(null);
    const ok = document.createElement('button');
    ok.className = 'primary';
    ok.textContent = '确定';
    ok.onclick = () => close({ label: input.value.trim() });
    actions.append(cancel, ok);
    box.append(actions);
    box.onkeydown = (e) => {
      if (e.key === 'Enter') ok.click();
    };
  });
}

async function createLink(fromCard, toCard) {
  const dup = cvData.links.find((l) => l.from === fromCard.id && l.to === toCard.id);
  if (dup) {
    toast('这两张卡片已有关联，可直接修改关系');
    await editLink(dup);
    return;
  }
  const form = await linkLabelModal(fromCard, toCard, '');
  if (!form) return; // 取消
  const link = { id: cvNewId('link'), from: fromCard.id, to: toCard.id, label: form.label };
  cvData.links.push(link);
  cvSelect('link', link.id);
  // 图谱视图里新关系立刻并入径向布局，省得再手动整理一次
  if (cvMode === 'graph') {
    cvRelayoutGraph(false);
  } else {
    cvRenderLayer();
  }
  cvUpdateHint();
  renderCounts();
  cvMarkDirty();
  cvLog('建立关系', { id: link.id, from: fromCard.name, to: toCard.name, label: link.label });
}

async function editLink(link) {
  const byId = new Map(cvData.cards.map((c) => [c.id, c]));
  const fromCard = byId.get(link.from);
  const toCard = byId.get(link.to);
  if (!fromCard || !toCard) return;
  const form = await linkLabelModal(fromCard, toCard, link.label);
  if (!form) return;
  link.label = form.label;
  cvRenderLayer();
  renderCounts();
  cvMarkDirty();
  cvLog('编辑关系', { id: link.id, label: link.label });
}

async function removeLink(id) {
  const link = cvData.links.find((l) => l.id === id);
  if (!link) return;
  const byId = new Map(cvData.cards.map((c) => [c.id, c]));
  const a = byId.get(link.from);
  const b = byId.get(link.to);
  const ok = await confirmBox('删除关系', `确定删除「${a ? a.name : '?'} → ${b ? b.name : '?'}」的关系吗？`, '删除');
  if (!ok) return;
  cvData.links = cvData.links.filter((l) => l.id !== id);
  if (cvSel && cvSel.kind === 'link' && cvSel.id === id) cvSel = null;
  cvRenderLayer();
  renderCounts();
  cvDetailRender();
  cvMarkDirty();
  cvLog('删除关系', { id });
}

ui.canvasViewport.addEventListener('mousedown', (e) => {
  if (!cvData || e.button !== 0) return;
  if (
    e.target.closest('.cv-card') ||
    e.target.closest('.cv-node-hit') ||
    e.target.closest('.cv-link-hit') ||
    e.target.closest('#canvas-palette') ||
    e.target.closest('#cv-rel-panel') ||
    e.target.closest('#cv-graph-tools')
  )
    return;
  cvSelect(null); // 点空白：取消选中并开始平移
  const sx = e.clientX;
  const sy = e.clientY;
  const ox = cvData.viewport.x;
  const oy = cvData.viewport.y;
  ui.canvasViewport.classList.add('panning');
  cvLog('平移开始', { from: { x: Math.round(ox), y: Math.round(oy) } });
  const onMove = (ev) => {
    cvData.viewport.x = ox + (ev.clientX - sx);
    cvData.viewport.y = oy + (ev.clientY - sy);
    cvLayout();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    ui.canvasViewport.classList.remove('panning');
    cvLog('平移结束', cvViewportSnapshot());
    cvMarkDirty();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

ui.canvasViewport.addEventListener(
  'wheel',
  (e) => {
    if (!cvData) return;
    e.preventDefault();
    const rect = ui.canvasViewport.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const vp = cvData.viewport;
    const wx = (mx - vp.x) / vp.zoom;
    const wy = (my - vp.y) / vp.zoom;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const before = vp.zoom;
    vp.zoom = Math.min(CV.maxZoom, Math.max(CV.minZoom, vp.zoom * factor));
    vp.x = mx - wx * vp.zoom;
    vp.y = my - wy * vp.zoom;
    cvLayout();
    cvMarkDirty();
    cvLog('滚轮缩放', { from: Number(before.toFixed(3)), to: Number(vp.zoom.toFixed(3)), anchor: { x: Math.round(mx), y: Math.round(my) } });
  },
  { passive: false }
);

function cvZoomBy(factor) {
  if (!cvData) return;
  const rect = ui.canvasViewport.getBoundingClientRect();
  const mx = rect.width / 2;
  const my = rect.height / 2;
  const vp = cvData.viewport;
  const wx = (mx - vp.x) / vp.zoom;
  const wy = (my - vp.y) / vp.zoom;
  const before = vp.zoom;
  vp.zoom = Math.min(CV.maxZoom, Math.max(CV.minZoom, vp.zoom * factor));
  vp.x = mx - wx * vp.zoom;
  vp.y = my - wy * vp.zoom;
  cvLayout();
  cvMarkDirty();
  const clamped = vp.zoom === CV.maxZoom || vp.zoom === CV.minZoom;
  cvLog('按钮缩放', { from: Number(before.toFixed(3)), to: Number(vp.zoom.toFixed(3)), clamped });
}

/** 缩放到刚好容纳全部卡片与情节点 */
function cvFit() {
  if (!cvData) return;
  const corners = [];
  const placedCards = cvPlacedCards();
  // 角色卡片只在知识图谱里画，故事线里只有情节点，两者不要互相撑大包围盒
  // 图谱只纳入「当前层级内」的卡片，否则被隐藏的人会把视图撑小
  const graphCards = cvMode === 'graph' ? placedCards.filter((c) => cvGraphVisibleIds().has(c.id)) : [];
  if (cvMode === 'graph') for (const c of graphCards) corners.push([c.x, c.y], [c.x + CV.cardW, c.y + CV.cardH]);
  if (cvMode !== 'graph') for (const p of cvData.points) corners.push([p.x - 110, p.y - 80], [p.x + 110, p.y + 80]);
  // 图谱模式的弧线与标签会外扩，把标签落点也纳入包围盒
  if (cvMode === 'graph') {
    const byId = new Map(graphCards.map((c) => [c.id, c]));
    for (const link of cvData.links) {
      if (cvLinkIsHidden(link)) continue; // 看不见的关系不该把视图撑大
      const g = cvLinkGeometry(link, byId);
      if (!g) continue;
      corners.push([g.a.x, g.a.y], [g.b.x, g.b.y], [g.ctrl.x, g.ctrl.y], [g.label.x - 40, g.label.y - 14], [g.label.x + 40, g.label.y + 14]);
    }
    // 参考环也要装得下，否则「适应」会把环裁掉
    if (cvGraphMeta && cvGraphMeta.rings.length) {
      const r = cvGraphMeta.rings[cvGraphMeta.rings.length - 1].r;
      corners.push(
        [cvGraphMeta.cx - r, cvGraphMeta.cy - r - 24],
        [cvGraphMeta.cx + r, cvGraphMeta.cy + r + 24]
      );
    }
  }
  if (!corners.length) corners.push([CV.left, CV.baseline - 140], [CV.left + CV.width, CV.baseline + 140]);
  const pad = cvMode === 'graph' ? 120 : 80;
  const minX = Math.min(...corners.map((q) => q[0])) - pad;
  const maxX = Math.max(...corners.map((q) => q[0])) + pad;
  const minY = Math.min(...corners.map((q) => q[1])) - pad;
  const maxY = Math.max(...corners.map((q) => q[1])) + pad;
  const rect = ui.canvasViewport.getBoundingClientRect();
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const zoom = Math.min(1.2, Math.max(CV.minZoom, Math.min(rect.width / bw, rect.height / bh)));
  cvData.viewport.zoom = zoom;
  cvData.viewport.x = rect.width / 2 - ((minX + maxX) / 2) * zoom;
  cvData.viewport.y = rect.height / 2 - ((minY + maxY) / 2) * zoom;
  cvLayout();
  cvMarkDirty();
  cvLog('适应全图', { items: placedCards.length + cvData.points.length, viewport: cvViewportSnapshot() });
}

// ---------- 情节点下钻：进入节点自己的新画布 ----------

/** 一张空白的子画布：结构跟根画布一致，可以继续放情节点、角色卡片与关系 */
function cvEmptyCanvas() {
  return {
    schema: 1,
    mode: 'story',
    hiddenCats: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    focus: '',
    depth: 2,
    cards: [],
    points: [],
    links: [],
  };
}

/** 当前层是从哪个情节点钻下来的（用于空画布提示与路径） */
function cvTrailPoint(frame) {
  return frame && frame.parentData ? frame.parentData.points.find((p) => p.id === frame.pointId) : null;
}

/** 顶部路径：无限画布 / 第一层节点 / 第二层节点… */
function cvCrumbRender() {
  const box = $('cv-crumbs');
  if (!box) return;
  box.innerHTML = '';
  const items = [{ label: '无限画布', depth: 0 }];
  cvTrail.forEach((frame, i) => {
    const p = cvTrailPoint(frame);
    items.push({ label: p && p.title ? p.title : '子画布', depth: i + 1 });
  });
  items.forEach((item, i) => {
    if (i) {
      const sep = document.createElement('span');
      sep.className = 'cv-crumb-sep';
      sep.textContent = '\u203a';
      box.append(sep);
    }
    const btn = document.createElement('button');
    btn.className = 'cv-crumb' + (i === items.length - 1 ? ' current' : '');
    btn.textContent = item.label;
    btn.title = i === items.length - 1 ? '当前画布' : '回到这一层';
    if (i < items.length - 1) btn.onclick = () => cvGoToDepth(item.depth);
    box.append(btn);
  });
}

/** 双击情节点：进入它自己的那张新画布（没有就现建一张） */
function cvEnterPoint(pointId) {
  if (!cvData) return;
  const point = cvData.points.find((p) => p.id === pointId);
  if (!point) return;
  const created = !point.sub;
  if (created) point.sub = cvEmptyCanvas();
  cvTrail.push({ pointId: point.id, parentData: cvData, parentSel: cvSel });
  cvData = point.sub;
  cvSel = null;
  cvCrumbRender();
  cvSyncModeUi();
  renderCanvas();
  renderCardList();
  renderBeatList();
  renderCounts();
  if (created) cvFit();
  cvMarkDirty();
  cvLog('下钻进入子画布', { pointId, title: point.title, depth: cvTrail.length });
}

/** 点顶部路径回到某一层：depth 0 = 根画布 */
function cvGoToDepth(depth) {
  if (depth < 0 || depth >= cvTrail.length) return;
  while (cvTrail.length > depth) {
    const frame = cvTrail.pop();
    cvData = frame.parentData;
    cvSel = frame.parentSel || null;
  }
  cvCrumbRender();
  cvSyncModeUi();
  renderCanvas();
  renderCardList();
  renderBeatList();
  renderCounts();
  cvMarkDirty();
  cvLog('返回上层画布', { depth });
}

// ---------- 画布增删改 ----------

/** 角色档案弹层：名称/别名/介绍 + 背景/性格/外貌，可一键让 AI 从正文补全 */
function editCardModal(card) {
  return showModal((box, close) => {
    box.classList.add('profile-modal');
    const title = document.createElement('h3');
    title.textContent = '角色档案';
    box.append(title);

    const rels = (cvData.links || [])
      .filter((l) => l.from === card.id || l.to === card.id)
      .map((l) => {
        const otherId = l.from === card.id ? l.to : l.from;
        const other = cvData.cards.find((c) => c.id === otherId);
        if (!other) return '';
        return card.name + (l.from === card.id ? ' → ' : ' ← ') + other.name + '（' + (l.label || '相关') + '）';
      })
      .filter(Boolean);

    const sub = document.createElement('div');
    sub.className = 'profile-sub';
    sub.textContent =
      [(card.aliases || []).length ? '别名：' + card.aliases.join('、') : '', rels.length ? '人物关系 ' + rels.length + ' 条' : '']
        .filter(Boolean)
        .join(' · ') || '档案会随作品一起保存';
    box.append(sub);

    const mkInput = (labelText, value, placeholder) => {
      const l = document.createElement('label');
      l.textContent = labelText;
      const i = document.createElement('input');
      i.type = 'text';
      i.placeholder = placeholder || '';
      i.value = value || '';
      box.append(l, i);
      return i;
    };
    const mkArea = (labelText, value, placeholder) => {
      const l = document.createElement('label');
      l.textContent = labelText;
      const t = document.createElement('textarea');
      t.placeholder = placeholder || '';
      t.value = value || '';
      box.append(l, t);
      return t;
    };

    const nameInput = mkInput('名称', card.name, '如：江晚棠');
    const aliasInput = mkInput('别名（逗号分隔）', (card.aliases || []).join('、'), '如：晚棠, 江小姐');
    const descArea = mkArea('角色介绍', card.desc, '身份、立场、关键作为…');
    const bgArea = mkArea('背景', card.background, '出身、经历、立场，也可点下方「AI 分析补全」');
    const personalityArea = mkArea('性格', card.personality, '性格特征、行事风格…');
    const appearanceArea = mkArea('外貌', card.appearance, '外貌、服饰、气质…');

    let relBlock = null;
    if (rels.length) {
      relBlock = document.createElement('div');
      relBlock.className = 'profile-relations';
      const h = document.createElement('h4');
      h.textContent = '人物关系';
      relBlock.append(h);
      for (const r of rels) {
        const row = document.createElement('div');
        row.className = 'cv-detail-item static';
        row.textContent = r;
        relBlock.append(row);
      }
      box.append(relBlock);
    }

    const status = document.createElement('div');
    status.className = 'profile-status';
    box.append(status);

    const actions = document.createElement('div');
    actions.className = 'overlay-actions';
    const aiBtn = document.createElement('button');
    aiBtn.className = 'left';
    aiBtn.textContent = 'AI 分析补全';
    aiBtn.onclick = async () => {
      if (!state.dir) {
        status.textContent = '请先打开一个作品';
        return;
      }
      aiBtn.disabled = true;
      aiBtn.textContent = '分析中…';
      status.textContent = '正在读这个角色出场的正文片段…';
      try {
        const res = await invoke(
          api.analyzeProfile(state.dir, {
            name: nameInput.value.trim() || card.name,
            aliases: aliasInput.value
              .split(/[,，、;；\s]+/)
              .map((s) => s.trim())
              .filter(Boolean),
            desc: descArea.value,
            relations: rels.join('；'),
          })
        );
        bgArea.value = res.background || '';
        personalityArea.value = res.personality || '';
        appearanceArea.value = res.appearance || '';
        status.textContent = '已根据正文生成，可直接修改后保存。';
      } catch (err) {
        status.textContent = '分析失败：' + err.message;
      } finally {
        aiBtn.disabled = false;
        aiBtn.textContent = 'AI 分析补全';
      }
    };

    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.onclick = () => close(null);
    const ok = document.createElement('button');
    ok.className = 'primary';
    ok.textContent = '确定';
    ok.onclick = () => {
      const name = nameInput.value.trim();
      if (!name) {
        nameInput.focus();
        return;
      }
      close({
        name,
        aliases: aliasInput.value.split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean),
        desc: descArea.value,
        background: bgArea.value,
        personality: personalityArea.value,
        appearance: appearanceArea.value,
      });
    };
    actions.append(aiBtn, cancel, ok);
    box.append(actions);
    nameInput.focus();
  });
}

/**
 * 情节点信息弹层：右键节点 / 详情面板「编辑节点信息」进来，负责改标题、情绪、详细经过等字段。
 * 双击节点本身是下钻进子画布（cvEnterPoint），不再打开这个弹层。
 */
function openPointPage(startId) {
  if (!cvData || !cvData.points.length) return Promise.resolve();
  const list = [...cvData.points].sort((a, b) => a.x - b.x);

  return showModal((box, close) => {
    box.className = 'point-modal';

    /** 改一处即生效：只重画连线层、左栏与详情面板，不重建视口 */
    const patch = (point, data) => {
      Object.assign(point, data);
      cvRenderLayer();
      renderBeatList();
      cvDetailRender();
      cvMarkDirty();
    };

    const render = (id) => {
      const idx = list.findIndex((p) => p.id === id);
      if (idx < 0) return close(null);
      const point = list[idx];
      box.innerHTML = '';

      const head = document.createElement('div');
      head.className = 'pt-head';
      const name = document.createElement('div');
      name.className = 'pt-title';
      name.textContent = '编辑节点信息';
      const nav = document.createElement('div');
      nav.className = 'pt-nav';
      const prev = document.createElement('button');
      prev.textContent = '← 上一个';
      prev.disabled = idx === 0;
      prev.onclick = () => render(list[idx - 1].id);
      const pos = document.createElement('span');
      pos.className = 'pt-pos';
      pos.textContent = `${idx + 1} / ${list.length}`;
      const next = document.createElement('button');
      next.textContent = '下一个 →';
      next.disabled = idx === list.length - 1;
      next.onclick = () => render(list[idx + 1].id);
      nav.append(prev, pos, next);
      head.append(name, nav);
      box.append(head);

      const body = document.createElement('div');
      body.className = 'pt-body';
      box.append(body);

      const row = (labelText, input) => {
        const label = document.createElement('label');
        label.textContent = labelText;
        body.append(label, input);
        return input;
      };
      const textInput = (value, placeholder) => {
        const el = document.createElement('input');
        el.type = 'text';
        el.value = value || '';
        el.placeholder = placeholder || '';
        return el;
      };

      const titleEl = row('标题（画布上显示）', textInput(point.title, '这一节叫什么'));
      titleEl.oninput = () => {
        const v = titleEl.value.trim();
        titleEl.classList.toggle('bad', !v);
        if (v) patch(point, { title: v }); // 标题是必填项，清空时先不落盘
      };

      const levelEl = document.createElement('input');
      levelEl.type = 'number';
      levelEl.min = '-100';
      levelEl.max = '100';
      levelEl.step = '5';
      levelEl.value = String(yToLevel(point.y));
      levelEl.oninput = () => patch(point, { y: levelToY(clamp(Number(levelEl.value) || 0, -100, 100, 0)) });
      row('情绪强度（-100 低沉 ~ 100 激昂）', levelEl);

      const descEl = row('一句话（画布上显示在标题下方）', textInput(point.desc, '一句话说清这一节'));
      descEl.oninput = () => patch(point, { desc: descEl.value });

      const detailEl = document.createElement('textarea');
      detailEl.rows = 8;
      detailEl.value = point.detail || '';
      detailEl.placeholder = '详细经过：谁、在哪、做了什么、结果如何、留下了什么钩子…';
      detailEl.oninput = () => patch(point, { detail: detailEl.value });
      row('详细经过', detailEl);

      const whoEl = row('涉及人物（用「、」分隔）', textInput(point.who, '如：宁毅、苏檀儿'));
      whoEl.oninput = () => patch(point, { who: whoEl.value });

      const placeEl = row('地点', textInput(point.place, '如：江宁·苏府'));
      placeEl.oninput = () => patch(point, { place: placeEl.value });

      const chapterEl = document.createElement('select');
      let hasChapter = false;
      for (const vol of (state.tree && state.tree.volumes) || []) {
        for (const c of vol.chapters) {
          const opt = document.createElement('option');
          opt.value = c.id;
          opt.textContent = vol.title + ' / ' + c.title;
          chapterEl.append(opt);
          if (c.id === point.chapter) hasChapter = true;
        }
      }
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '（不关联章节）';
      chapterEl.prepend(none);
      if (point.chapter && !hasChapter) {
        // 关联的章节可能已经被删了，保留原值免得静默丢掉
        const opt = document.createElement('option');
        opt.value = point.chapter;
        opt.textContent = point.chapter + '（章节已丢失）';
        chapterEl.append(opt);
      }
      chapterEl.value = point.chapter || '';
      chapterEl.onchange = () => {
        patch(point, { chapter: chapterEl.value });
        render(point.id); // 「去正文」按钮要跟着出现/消失
      };
      row('关联章节', chapterEl);

      if (point.chapter) {
        const openBtn = document.createElement('button');
        openBtn.className = 'pt-open';
        openBtn.textContent = '去正文读这一章';
        openBtn.onclick = async () => {
          const id = point.chapter;
          close(null);
          await closeCanvas();
          await openChapter(id);
        };
        body.append(openBtn);
      }

      const actions = document.createElement('div');
      actions.className = 'overlay-actions';
      const del = document.createElement('button');
      del.className = 'danger';
      del.textContent = '删除此情节点';
      // 这里不能再弹确认框（会把二级页面顶掉），改成点两次确认
      del.onclick = () => {
        if (del.dataset.armed !== 'yes') {
          del.dataset.armed = 'yes';
          del.textContent = '再点一次确认删除';
          return;
        }
        cvData.points = cvData.points.filter((x) => x.id !== point.id);
        if (cvSel && cvSel.kind === 'point' && cvSel.id === point.id) cvSel = null;
        list.splice(idx, 1);
        cvMarkDirty();
        cvLog('删除情节点', { id: point.id, title: point.title, total: cvData.points.length });
        if (!list.length) {
          close(true);
          return;
        }
        render(list[Math.min(idx, list.length - 1)].id);
      };
      const done = document.createElement('button');
      done.className = 'primary';
      done.textContent = '完成';
      done.onclick = () => close(true);
      actions.append(del, done);
      box.append(actions);

      cvSelect('point', point.id);
      cvRenderLayer();
      cvDetailRender();
    };

    render(list.some((p) => p.id === startId) ? startId : list[0].id);
  });
}

/** 默认名重名时自动加序号，先落地再右键编辑，不打断操作 */
function cvUniqueName(base, taken) {
  let name = base;
  let n = 1;
  while (taken.includes(name)) name = `${base} ${++n}`;
  return name;
}

/** 新增项落在视口之外时把视口平移过去，避免「点了没反应」 */
function cvEnsureVisible(wx, wy) {
  const rect = ui.canvasViewport.getBoundingClientRect();
  const vp = cvData.viewport;
  const sx = wx * vp.zoom + vp.x;
  const sy = wy * vp.zoom + vp.y;
  const pad = 100;
  if (sx >= pad && sx <= rect.width - pad && sy >= pad && sy <= rect.height - pad) return;
  vp.x += rect.width / 2 - sx;
  vp.y += rect.height / 2 - sy;
  cvLayout();
}

/** 在指定世界坐标放一张角色卡片（坐标是卡片中心）；stagger 用于连续点击时错开，避免完全重叠 */
function cvAddCardAt(world, stagger) {
  const placedCount = cvPlacedCards().length;
  const n = placedCount % 5;
  const cx = world.x + (stagger ? n * 28 : 0);
  const cy = world.y + (stagger ? n * 28 : 0);
  const card = {
    id: cvNewId('card'),
    name: cvUniqueName('新角色', cvData.cards.map((c) => c.name)),
    aliases: [],
    desc: '',
    x: Math.round(cx - CV.cardW / 2),
    y: Math.round(cy - CV.cardH / 3),
    placed: true,
  };
  cvData.cards.push(card);
  renderCards();
  renderCardList();
  cvSelect('card', card.id);
  cvUpdateHint();
  renderCounts();
  cvMarkDirty();
  cvLog('添加角色卡片', { id: card.id, name: card.name, at: { x: card.x, y: card.y }, total: cvData.cards.length });
  return card;
}

/**
 * 放一个情节点。click 模式接到故事线末尾并与上一点反向起伏；
 * drop 模式用落点坐标，纵向位置直接决定情绪高低。
 */
function cvAddPointAt(world, dropped) {
  const xs = cvData.points.map((p) => p.x);
  const last = cvData.points.reduce((a, b) => (a && a.x > b.x ? a : b), null);
  let x;
  let y;
  if (dropped) {
    x = world.x;
    y = world.y;
  } else {
    x = xs.length ? Math.max(...xs) + 320 : CV.left;
    const level = last && yToLevel(last.y) > 0 ? -60 : 60;
    y = levelToY(level);
  }
  const point = {
    id: cvNewId('beat'),
    title: cvUniqueName('新情节点', cvData.points.map((p) => p.title)),
    desc: '',
    detail: '',
    who: '',
    place: '',
    chapter: '',
    x: Math.round(x),
    y: Math.round(y),
  };
  cvData.points.push(point);
  cvRenderLayer();
  renderBeatList();
  cvSelect('point', point.id);
  cvUpdateHint();
  renderCounts();
  cvMarkDirty();
  cvLog('添加情节点', { id: point.id, title: point.title, by: dropped ? 'drop' : 'click', at: { x: point.x, y: point.y }, level: yToLevel(point.y), total: cvData.points.length });
  return point;
}

/** 素材栏：单击直接添加，拖拽落点添加 */
function cvPaletteGesture(e, kind) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const item = e.currentTarget;
  const sx = e.clientX;
  const sy = e.clientY;
  let moved = false;
  let ghost = null;
  const onMove = (ev) => {
    if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 4) {
      moved = true;
      item.classList.add('dragging');
      ghost = document.createElement('div');
      ghost.className = 'cv-ghost';
      ghost.textContent = kind === 'card' ? '角色卡片' : '情节点';
      document.body.append(ghost);
      cvLog('从素材栏拖出', { kind });
    }
    if (ghost) {
      ghost.style.left = ev.clientX + 14 + 'px';
      ghost.style.top = ev.clientY + 14 + 'px';
    }
  };
  const onUp = (ev) => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    item.classList.remove('dragging');
    if (ghost) ghost.remove();
    const rect = ui.canvasViewport.getBoundingClientRect();
    const inside = ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom;
    if (moved && !inside) {
      cvLog('取消添加：落点在画布之外', { kind });
      return;
    }
    const world = moved ? cvWorldPoint(ev) : cvViewportCenter();
    const added = kind === 'card' ? cvAddCardAt(world, !moved) : cvAddPointAt(world, moved);
    // 拖拽落点必定在视口内，只有点击添加才需要把视口带过去
    if (!moved) cvEnsureVisible(added.x + (kind === 'card' ? CV.cardW / 2 : 0), added.y);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

async function editCard(card) {
  const form = await editCardModal(card);
  if (!form) return;
  card.name = form.name;
  card.aliases = form.aliases;
  card.desc = form.desc;
  card.background = form.background;
  card.personality = form.personality;
  card.appearance = form.appearance;
  renderCards();
  renderCardList();
  cvDetailRender();
  cvMarkDirty();
}

/** 从画布上移除卡片：只把 placed 置回 false，角色本身仍留在左栏「角色卡片」里 */
async function removeCard(id) {
  const card = cvData.cards.find((c) => c.id === id);
  if (!card) return;
  const yes = await confirmBox('从画布移除', `把「${card.name}」从画布上移走吗？\n角色仍会保留在左侧「角色卡片」里。`, '移除');
  if (!yes) return;
  card.placed = false;
  if (cvSel && cvSel.kind === 'card' && cvSel.id === id) cvSel = null;
  renderCanvas();
  renderCardList();
  cvMarkDirty();
  cvLog('从画布移除卡片', { id, name: card.name, remain: cvPlacedCards().length });
}

/** 彻底删除角色：从角色库里删掉，并清掉挂在它身上的关系 */
async function deleteCard(id) {
  const card = cvData.cards.find((c) => c.id === id);
  if (!card) return;
  const yes = await confirmBox(
    '删除角色',
    `确定把角色「${card.name}」从角色库里彻底删除吗？\n这会连同它与别人的关系一起删掉，无法恢复。`,
    '删除'
  );
  if (!yes) return;
  cvData.cards = cvData.cards.filter((c) => c.id !== id);
  cvData.links = (cvData.links || []).filter((l) => l.from !== id && l.to !== id);
  if (cvSel && cvSel.kind === 'card' && cvSel.id === id) cvSel = null;
  renderCanvas();
  renderCardList();
  cvMarkDirty();
  cvLog('删除角色', { id, name: card.name, total: cvData.cards.length });
}

async function removePoint(id) {
  const p = cvData.points.find((x) => x.id === id);
  if (!p) return;
  const hasSub = !!(p.sub && (p.sub.points.length || p.sub.cards.length || p.sub.links.length));
  const yes = await confirmBox(
    '删除情节点',
    `确定删除情节点「${p.title}」吗？` + (hasSub ? '\n它下钻出来的子画布也会一起删除。' : ''),
    '删除'
  );
  if (!yes) return;
  cvData.points = cvData.points.filter((x) => x.id !== id);
  if (cvSel && cvSel.kind === 'point' && cvSel.id === id) cvSel = null;
  renderCanvas();
  renderBeatList();
  cvMarkDirty();
}

// ---------- 画布持久化 ----------

function cvMarkDirty() {
  if (!cvData) return;
  cvRev += 1;
  setCanvasStatus('未保存', 'saving');
  clearTimeout(cvTimer);
  cvTimer = setTimeout(saveCanvasNow, 900);
}

async function saveCanvasNow() {
  clearTimeout(cvTimer);
  if (!state.dir || !cvData || cvRev === cvSavedRev) return;
  const rev = cvRev;
  // 落盘永远写根画布：子画布嵌在 points[].sub 里，跟着根一起存
  const root = cvRoot || cvData;
  const vp = root.viewport;
  setCanvasStatus('保存中…', 'saving');
  try {
    await invoke(
      api.saveCanvas(state.dir, {
        schema: 1,
        mode: cvMode,
        viewport: { x: Math.round(vp.x), y: Math.round(vp.y), zoom: Number(vp.zoom.toFixed(3)) },
        focus: root.focus || '',
        depth: root.depth,
        hiddenCats: root.hiddenCats || [],
        cards: root.cards,
        points: root.points,
        links: root.links,
      })
    );
    cvSavedRev = rev;
    // 画布卡片就是人物名录：名字/别名变了就刷新正文人物高亮
    const castSig = root.cards.map((c) => c.name + '|' + (c.aliases || []).join(',')).join(';');
    if (castSig !== hlCastSig) {
      hlCastSig = castSig;
      scheduleHighlight();
    }
    // 保存期间若有新改动，保留「未保存」提示并等下一轮
    if (cvRev === cvSavedRev) setCanvasStatus('已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }), 'saved');
  } catch (err) {
    setCanvasStatus('保存失败：' + err.message, 'error');
  }
}

/** 懒加载画布数据：已加载过就直接复用内存里的，避免把未保存的改动覆盖掉 */
async function loadCanvasData() {
  if (cvData || !state.dir) return false;
  await commitSave();
  try {
    cvRoot = await invoke(api.readCanvas(state.dir));
    cvData = cvRoot;
    cvTrail = [];
  } catch (err) {
    await alertBox('读取画布失败', err.message);
    return null;
  }
  const fresh = !!cvData.fresh;
  delete cvData.fresh;
  if (!Array.isArray(cvData.links)) cvData.links = [];
  if (!Array.isArray(cvData.hiddenCats)) cvData.hiddenCats = [];
  if (typeof cvData.focus !== 'string') cvData.focus = '';
  if (![0, 1, 2, 3].includes(cvData.depth)) cvData.depth = 2;
  cvMode = cvData.mode || 'story';
  cvSel = null;
  cvRev = 0;
  cvSavedRev = 0;
  return fresh;
}

async function openCanvas() {
  if (!state.dir) {
    toast('请先打开一个作品');
    return;
  }
  const fresh = await loadCanvasData();
  if (!cvData) return;
  if (middlePane() === 'outline') await saveOutline();
  setMiddlePane('canvas');
  setCanvasStatus('就绪');
  cvSyncModeUi();
  cvCrumbRender();
  // 图谱视图重算一次布局：位置是幂等的，但参考环（cvGraphMeta）需要重建
  if (cvMode === 'graph') cvGraphLayout();
  renderCanvas();
  renderCardList();
  renderBeatList();
  if (fresh) cvFit();
}

async function closeCanvas() {
  await saveCanvasNow();
  // 关闭画布时退回根层：左栏角色 / 剧情列表恢复全书视角，下次打开也从根画布开始
  if (cvTrail.length) {
    while (cvTrail.length) {
      const frame = cvTrail.pop();
      cvData = frame.parentData;
    }
    cvSel = null;
    cvCrumbRender();
    renderCardList();
    renderBeatList();
  }
  setMiddlePane('editor');
  aiPane = 'chapter';
  if (typeof window.mushuRefreshAiContext === 'function') window.mushuRefreshAiContext();
  renderCounts();
}

async function toggleCanvas() {
  if (middlePane() === 'canvas') await closeCanvas();
  else await openCanvas();
}

// ---------- AI 解析：全书识别人物 → 预览勾选 → 写入画布 ----------

const ANALYZE_BUDGETS = [
  { value: 8000, label: '快速 · 每卷约 8 千字（省 token，配角容易漏）' },
  { value: 30000, label: '标准 · 每卷约 3 万字（推荐）' },
  { value: 80000, label: '精细 · 每卷约 8 万字（最全，耗时与花费最高）' },
];

let analyzeJob = null;

api.onAnalyzeProgress((p) => {
  if (analyzeJob && p && p.id === analyzeJob.id && analyzeJob.onProgress) analyzeJob.onProgress(p);
});

async function openAnalyzeDialog() {
  if (!state.dir) {
    toast('请先打开一个作品');
    return;
  }
  let status = null;
  try {
    status = await invoke(api.aiKeyStatus());
  } catch {
    status = null;
  }
  if (!status || !status.configured) {
    const go = await confirmBox(
      '还没有配置 API Key',
      '「AI 解析」需要 DeepSeek API Key 才能通读全书。现在去设置里填写吗？',
      '去设置'
    );
    if (go) openSettings('ai');
    return;
  }

  const applied = await showModal((box, close) => buildAnalyzeModal(box, close));
  if (!applied) return;

  // 主进程已经改写 canvas.json：丢掉内存里的旧数据重新读，确保看到的是落盘结果
  cvRoot = null;
  cvData = null;
  cvTrail = [];
  await loadCanvasData();
  if (!cvData) return;
  cvSyncModeUi();
  cvCrumbRender();
  if (cvMode === 'graph') cvGraphLayout();
  renderCanvas();
  renderCardList();
  renderBeatList();
  cvFit();
  setCanvasStatus('AI 解析已写入', 'saved');
  toast(`已写入画布：新增 ${applied.stats.added} 人，关系 ${applied.stats.links} 条`);
}

function buildAnalyzeModal(box, close) {
  box.classList.add('analyze-modal');
  const title = document.createElement('h3');
  title.textContent = 'AI 解析全书';

  const config = document.createElement('div');
  config.className = 'analyze-stage';
  const running = document.createElement('div');
  running.className = 'analyze-stage hidden';
  const preview = document.createElement('div');
  preview.className = 'analyze-stage hidden';

  const setStage = (stage) => {
    config.classList.toggle('hidden', stage !== 'config');
    running.classList.toggle('hidden', stage !== 'running');
    preview.classList.toggle('hidden', stage !== 'preview');
  };

  // ---------- 第一步：选择预算 ----------
  const intro = document.createElement('p');
  intro.className = 'overlay-msg';
  intro.textContent =
    '本地先扫全书、按说话句式和自我介绍挖出高频人物（不花 token），再按卷让 AI 精读逐人确认。模型漏掉的配角会以「频率补漏」留在这里，勾选后才写进画布。';

  const budgetRow = document.createElement('div');
  budgetRow.className = 'setting-row';
  const budgetLabel = document.createElement('span');
  budgetLabel.className = 'dim';
  budgetLabel.textContent = '精读预算';
  const budgetSelect = document.createElement('select');
  for (const b of ANALYZE_BUDGETS) {
    const opt = document.createElement('option');
    opt.value = String(b.value);
    opt.textContent = b.label;
    budgetSelect.append(opt);
  }
  budgetSelect.value = '30000';
  budgetRow.append(budgetLabel, budgetSelect);

  const cfgHint = document.createElement('p');
  cfgHint.className = 'field-hint';
  cfgHint.textContent = '已解析过的卷会命中本地缓存，不重复消耗 token；换预算档位或点「忽略缓存重跑」才会重新精读。';

  const cfgError = document.createElement('p');
  cfgError.className = 'field-error';

  const cfgActs = document.createElement('div');
  cfgActs.className = 'overlay-actions';
  const cfgCancel = document.createElement('button');
  cfgCancel.textContent = '取消';
  cfgCancel.onclick = () => close(null);
  const cfgStart = document.createElement('button');
  cfgStart.className = 'primary';
  cfgStart.textContent = '开始分析';
  cfgStart.onclick = () => runAnalysis(false);
  cfgActs.append(cfgCancel, cfgStart);
  config.append(intro, budgetRow, cfgHint, cfgError, cfgActs);

  // ---------- 第二步：进度 ----------
  const runMsg = document.createElement('p');
  runMsg.className = 'overlay-msg';
  runMsg.textContent = '正在准备…';
  const bar = document.createElement('div');
  bar.className = 'analyze-bar';
  const fill = document.createElement('i');
  bar.append(fill);
  const log = document.createElement('div');
  log.className = 'analyze-log';
  const runActs = document.createElement('div');
  runActs.className = 'overlay-actions';
  const runStop = document.createElement('button');
  runStop.textContent = '取消分析';
  runStop.onclick = async () => {
    if (!analyzeJob) return;
    runStop.disabled = true;
    runStop.textContent = '正在取消…';
    try {
      await invoke(api.analyzeCancel(analyzeJob.id));
    } catch {
      /* 取消失败等任务自己结束 */
    }
  };
  runActs.append(runStop);
  running.append(runMsg, bar, log, runActs);

  // ---------- 第三步：预览 ----------
  let result = null;
  let selected = new Set();
  const previewHead = document.createElement('p');
  previewHead.className = 'overlay-msg';
  const previewTools = document.createElement('div');
  previewTools.className = 'analyze-tools';
  const selectedCount = document.createElement('span');
  selectedCount.className = 'dim';
  const pickAll = document.createElement('button');
  pickAll.textContent = '全选';
  const pickNone = document.createElement('button');
  pickNone.textContent = '全不选';
  const pickLikely = document.createElement('button');
  pickLikely.textContent = '仅选可信';
  previewTools.append(selectedCount, pickAll, pickNone, pickLikely);

  // 预选/重选后刷新列表勾选状态：重建比逐项同步更简单
  const list = document.createElement('div');
  list.className = 'analyze-list';

  const pointsBox = document.createElement('label');
  pointsBox.className = 'setting-check';
  const pointsInput = document.createElement('input');
  pointsInput.type = 'checkbox';
  pointsInput.checked = true;
  const pointsText = document.createElement('span');
  pointsText.textContent = '同时写入分卷情节点';
  pointsBox.append(pointsInput, pointsText);

  const applyError = document.createElement('p');
  applyError.className = 'field-error';

  const prevActs = document.createElement('div');
  prevActs.className = 'overlay-actions';
  const prevBack = document.createElement('button');
  prevBack.textContent = '返回';
  prevBack.onclick = () => {
    applyError.textContent = '';
    setStage('config');
  };
  const prevRetry = document.createElement('button');
  prevRetry.textContent = '忽略缓存重跑';
  prevRetry.onclick = () => runAnalysis(true);
  const prevApply = document.createElement('button');
  prevApply.className = 'primary';
  prevApply.textContent = '写入画布';
  prevApply.onclick = async () => {
    if (!selected.size) {
      applyError.textContent = '至少勾选一个人物';
      return;
    }
    applyError.textContent = '';
    prevApply.disabled = true;
    try {
      await saveCanvasNow(); // 先把画布上的手改落盘，避免被写回覆盖
      const res = await invoke(api.analyzeApply(state.dir, result, [...selected], pointsInput.checked));
      close(res);
    } catch (err) {
      applyError.textContent = err.message;
      prevApply.disabled = false;
    }
  };
  prevActs.append(prevBack, prevRetry, prevApply);
  preview.append(previewHead, previewTools, list, pointsBox, applyError, prevActs);

  function refreshCount() {
    selectedCount.textContent = `已选 ${selected.size} / ${result ? result.cards.length : 0} 人`;
  }

  function renderList() {
    list.innerHTML = '';
    if (!result) return;
    for (const c of result.cards) {
      const row = document.createElement('label');
      row.className = 'analyze-item' + (selected.has(c.key) ? ' picked' : '');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selected.has(c.key);
      cb.onchange = () => {
        if (cb.checked) selected.add(c.key);
        else selected.delete(c.key);
        row.classList.toggle('picked', cb.checked);
        refreshCount();
      };
      const main = document.createElement('div');
      main.className = 'analyze-item-main';
      const nameLine = document.createElement('div');
      nameLine.className = 'analyze-item-name';
      const nameEl = document.createElement('strong');
      nameEl.textContent = c.name;
      nameLine.append(nameEl);
      if (c.role) {
        const roleEl = document.createElement('span');
        roleEl.className = 'dim';
        roleEl.textContent = c.role;
        nameLine.append(roleEl);
      }
      if (c.stub) {
        const tag = document.createElement('span');
        tag.className = 'analyze-tag';
        tag.textContent = '频率补漏';
        tag.title = '本地扫描到的高频名字，AI 未确认；勾选后会以待补充简介的形式写入';
        nameLine.append(tag);
      }
      const meta = document.createElement('div');
      meta.className = 'analyze-item-meta';
      const bits = [`★${c.importance || 1}`, `出现 ${c.mentions || 0} 次`, `${c.chapters || 0} 章`];
      if (c.aliases && c.aliases.length) bits.push(`别名：${c.aliases.join('、')}`);
      meta.textContent = bits.join(' · ');
      main.append(nameLine, meta);
      if (c.desc) {
        const desc = document.createElement('div');
        desc.className = 'analyze-item-desc';
        desc.textContent = c.desc;
        main.append(desc);
      }
      row.append(cb, main);
      list.append(row);
    }
    refreshCount();
  }

  function renderPreview() {
    const s = result.stats || {};
    previewHead.textContent = `${s.volumes || 0} 卷 / ${s.chapters || 0} 章：识别 ${s.cards || 0} 人（AI 确认 ${s.llmCards || 0}，频率补漏 ${s.stubCards || 0}），关系 ${s.links || 0} 条，情节点 ${s.points || 0} 条。`;
    // 默认全选有姓氏依据 / AI 确认的人物；纯噪声默认不勾，但保留在列表里可见
    selected = new Set(result.cards.filter((c) => c.likely !== false).map((c) => c.key));
    renderList();
  }

  pickAll.onclick = () => {
    selected = new Set(result.cards.map((c) => c.key));
    renderList();
  };
  pickNone.onclick = () => {
    selected = new Set();
    renderList();
  };
  pickLikely.onclick = () => {
    selected = new Set(result.cards.filter((c) => c.likely !== false).map((c) => c.key));
    renderList();
  };

  async function runAnalysis(force) {
    setStage('running');
    log.innerHTML = '';
    fill.style.width = '0%';
    runMsg.classList.remove('warn');
    runMsg.textContent = '正在扫描全书…';
    runStop.disabled = false;
    runStop.textContent = '取消分析';
    const jobId = 'an-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    analyzeJob = {
      id: jobId,
      onProgress: (p) => {
        if (p.message) {
          runMsg.textContent = p.message;
          const line = document.createElement('div');
          line.textContent = p.message;
          log.append(line);
          while (log.childNodes.length > 80) log.removeChild(log.firstChild);
          log.scrollTop = log.scrollHeight;
        }
        if (p.total) fill.style.width = Math.round((Math.min(p.current || 0, p.total) / p.total) * 100) + '%';
      },
    };
    try {
      result = await invoke(api.analyzeRun(jobId, state.dir, Number(budgetSelect.value) || 30000, !!force));
      renderPreview();
      setStage('preview');
    } catch (err) {
      cfgError.textContent = /已取消/.test(err.message) ? '已取消本次分析' : '分析失败：' + err.message;
      setStage('config');
    } finally {
      analyzeJob = null;
    }
  }

  box.append(title, config, running, preview);
  setStage('config');
}

// ---------- 快捷键派发 ----------

function toggleBossKey() {
  if (!prefs.bossKeyOk) api.minimize();
}

function runShortcut(id) {
  switch (id) {
    case 'newChapter':
      if (state.dir) newChapter();
      break;
    case 'fullscreen':
      api.toggleFullScreen();
      break;
    case 'formatText':
      formatText();
      break;
    case 'insertDivider':
      insertDivider();
      break;
    case 'gotoChapterStart':
      gotoChapterEdge('start');
      break;
    case 'gotoChapterEnd':
      gotoChapterEdge('end');
      break;
    case 'bossKey':
      toggleBossKey();
      break;
    case 'showShortcuts':
      showShortcutsDialog();
      break;
    case 'outline':
      if (state.dir) toggleOutline();
      break;
    case 'settingPanel':
      toggleCast();
      break;
    case 'canvas':
      if (state.dir) toggleCanvas();
      break;
    case 'findReplace':
      toggleFind();
      break;
    case 'saveChapter':
      commitSave();
      break;
    default:
      break;
  }
}

// ---------- 事件绑定 ----------

ui.editor.addEventListener('input', onInput);
ui.chapterTitle.addEventListener('input', onInput);
ui.chapterStatus.addEventListener('change', onInput);
ui.editor.addEventListener('scroll', syncLayerScroll);
ui.editor.addEventListener('wheel', onEditorWheel, { passive: true });
ui.editor.addEventListener('compositionstart', () => {
  composing = true;
});
ui.editor.addEventListener('compositionend', () => {
  composing = false;
  scheduleHighlight();
});
ui.editor.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') pendingEnter = true;
});

// 查找栏
ui.findInput.addEventListener('input', () => {
  findState.matches = findMatches();
  findState.index = -1;
  updateFindCount();
});
ui.findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    findStep(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    toggleFind(false);
  }
});
$('find-next').onclick = () => findStep(1);
$('find-prev').onclick = () => findStep(-1);
$('find-do').onclick = () => replaceOne();
$('find-all').onclick = () => replaceAll();
$('find-close').onclick = () => toggleFind(false);

// 设定面板
$('cast-tab-settings').onclick = () => {
  if (castTab === 'settings') return;
  castTab = 'settings';
  castIndex = 0;
  renderCastList();
  renderCastForm();
};
$('cast-add').onclick = () => castAdd();
$('cast-del').onclick = () => castDel();
ui.castName.addEventListener('input', onCastInput);
ui.castAliases.addEventListener('input', onCastInput);
ui.castDesc.addEventListener('input', onCastInput);
ui.castName.addEventListener('blur', () => saveCast());
window.addEventListener('blur', () => {
  commitSave();
  saveOutline();
  saveCanvasNow();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    commitSave();
    saveOutline();
    saveCanvasNow();
  }
});
setInterval(() => {
  commitSave();
  saveOutline();
  saveCanvasNow();
}, COMMIT_INTERVAL);

$('btn-new').onclick = createProject;
$('btn-import').onclick = importTxt;
$('btn-open').onclick = async () => {
  const dir = await invoke(api.pickDir('选择作品目录'));
  if (dir) enterProject(dir);
};
$('btn-focus').onclick = () => document.body.classList.toggle('focus');
$('btn-versions').onclick = () => toggleVersions();
$('btn-new-chapter').onclick = newChapter;
$('btn-new-volume').onclick = newVolume;
$('btn-folder').onclick = () => api.openFolder(state.dir);
$('btn-outline').onclick = () => toggleOutline();
$('btn-canvas').onclick = () => toggleCanvas();
$('outline-close').onclick = () => closeOutline();
ui.bookClose.onclick = () => closeProjectNow();
$('canvas-close').onclick = () => closeCanvas();
$('pal-card').addEventListener('mousedown', (e) => cvPaletteGesture(e, 'card'));
$('pal-point').addEventListener('mousedown', (e) => cvPaletteGesture(e, 'point'));
$('canvas-analyze').onclick = () => openAnalyzeDialog();
$('canvas-fit').onclick = () => cvFit();
$('canvas-zoom-in').onclick = () => cvZoomBy(1.2);
$('canvas-zoom-out').onclick = () => cvZoomBy(1 / 1.2);
$('cv-mode-story').onclick = () => setCanvasMode('story');
$('cv-mode-graph').onclick = () => setCanvasMode('graph');
$('cv-relayout').onclick = () => {
  if (cvMode !== 'graph') return;
  cvRelayoutGraph(true);
  toast('已按当前圆心重新排布');
};
$('cv-focus-chip').onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  cvPickFocus(r.left, r.bottom + 6);
};
$('cv-depth-1').onclick = () => cvSetDepth(1);
$('cv-depth-2').onclick = () => cvSetDepth(2);
$('cv-depth-3').onclick = () => cvSetDepth(3);
$('cv-depth-all').onclick = () => cvSetDepth(0);

// 左栏页签
$('tab-ai').onclick = () => showLeftPane('ai');
$('tab-cards').onclick = () => showLeftPane('cards');
$('tab-beats').onclick = () => showLeftPane('beats');
$('tab-cast').onclick = () => openCast();
$('card-add').onclick = () => addFromRail('card');
$('beat-add').onclick = () => addFromRail('point');
$('card-open-canvas').onclick = () => openCanvas();
$('beat-open-canvas').onclick = () => openCanvas();

// 右栏页签与折叠
$('tab-tree').onclick = () => showRightPane('tree');
$('tab-versions').onclick = () => toggleVersions();
$('rail-right-close').onclick = () => setRightCollapsed(true);
ui.railRightOpen.onclick = () => setRightCollapsed(false);

// 目录搜索
ui.treeSearch.addEventListener('input', () => {
  clearTimeout(treeSearchTimer);
  treeSearchTimer = setTimeout(runTreeSearch, TREE_SEARCH_DEBOUNCE);
});
ui.treeSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(treeSearchTimer);
    runTreeSearch();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    clearTreeSearch();
    ui.treeSearch.blur();
  }
});
ui.treeSearchClear.onclick = () => {
  clearTreeSearch();
  ui.treeSearch.focus();
};

ui.outlineBody.addEventListener('input', onOutlineInput);
ui.outlineBody.addEventListener('keyup', syncOutlineBlock);
ui.outlineBody.addEventListener('mouseup', syncOutlineBlock);
ui.outlineBlock.onchange = () => outlineCommand('formatBlock', ui.outlineBlock.value);
$('outline-bold').onclick = () => outlineCommand('bold');
$('outline-ul').onclick = () => outlineCommand('insertUnorderedList');
$('outline-ol').onclick = () => outlineCommand('insertOrderedList');
$('outline-quote').onclick = () => outlineCommand('formatBlock', 'blockquote');
$('outline-hr').onclick = () => outlineCommand('insertHTML', '<hr><p><br></p>');
$('outline-table').onclick = insertOutlineTable;
$('btn-settings').onclick = () => openSettings();
ui.titlebarBook.onclick = () => {
  if (state.dir) renameBook();
};

// 自绘标题栏：窗口控制 + 菜单弹出
ui.winMin.onclick = () => api.minimize();
ui.winMax.onclick = () => api.toggleMaximize();
ui.winClose.onclick = () => api.closeWindow();
ui.menuBtn.onclick = () => api.popupMenu();
ui.zoomOut.onclick = () => stepUiZoom(-0.1);
ui.zoomIn.onclick = () => stepUiZoom(0.1);
ui.zoomLabel.onclick = () => applyUiZoom(1, true);

function renderWindowState(st) {
  const glyph = ui.winMax.querySelector('.glyph');
  if (glyph) glyph.textContent = st && st.maximized ? '\u2750' : '\u25A1';
  ui.winMax.title = st && st.maximized ? '还原' : '最大化';
}

api.windowState().then((res) => renderWindowState(res && res.data));
api.onWindowState(renderWindowState);

document.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  // 界面缩放：Ctrl/⌘ + = / - / 0，弹层打开时也生效，方便边调边看
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const k = e.key;
    if (k === '=' || k === '+' || k === 'Add') {
      e.preventDefault();
      stepUiZoom(0.1);
      return;
    }
    if (k === '-' || k === '_' || k === 'Subtract') {
      e.preventDefault();
      stepUiZoom(-0.1);
      return;
    }
    if (k === '0' || k === ')') {
      e.preventDefault();
      applyUiZoom(1, true);
      return;
    }
  }
  const overlayOpen = !ui.overlay.classList.contains('hidden');
  if (e.key === 'Escape' && overlayOpen) {
    ui.overlay.classList.add('hidden');
    ui.overlayBox.innerHTML = '';
    ui.overlayBox.className = '';
    return;
  }
  if (overlayOpen) return; // 弹层（含快捷键录制）打开时不派发业务快捷键
  // 画布页：Delete / Backspace 删除选中的卡片或情节点
  if (cvSel && !ui.canvasPane.classList.contains('hidden') && (e.key === 'Delete' || e.key === 'Backspace')) {
    const el = document.activeElement;
    const editing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    if (!editing) {
      e.preventDefault();
      if (cvSel.kind === 'card') removeCard(cvSel.id);
      else if (cvSel.kind === 'link') removeLink(cvSel.id);
      else removePoint(cvSel.id);
      return;
    }
  }
  for (const a of SHORTCUT_ACTIONS) {
    if (a.id === 'bossKey') continue; // 老板键走主进程全局快捷键
    const accel = prefs.shortcuts[a.id];
    if (accel && matchAccel(e, accel)) {
      e.preventDefault();
      runShortcut(a.id);
      return;
    }
  }
});

api.onMenu((action) => {
  if (action === 'newProject') createProject();
  else if (action === 'openProject') $('btn-open').click();
  else if (action === 'closeProject') closeProjectNow();
  else if (action === 'focusMode') document.body.classList.toggle('focus');
  else if (action === 'versions') toggleVersions();
  else if (action === 'save') commitSave();
  else if (action === 'settings') openSettings();
  else if (action === 'openFolder') state.dir && api.openFolder(state.dir);
  else if (action === 'outline') toggleOutline();
  else if (action === 'canvas') toggleCanvas();
  else if (action === 'zoomIn') stepUiZoom(0.1);
  else if (action === 'zoomOut') stepUiZoom(-0.1);
  else if (action === 'zoomReset') applyUiZoom(1, true);
  else if (action === 'about')
    alertBox('墨枢', '个人创作工作台 · 阶段 1：本地项目结构 / 编辑器 / 自动保存 / 版本快照与回滚。\n\n数据全部保存在你自己选择的目录里，随时可用记事本打开。');
});

// ---------- 启动 ----------

async function initApp() {
  // 先把「最近打开」渲染出来，不跟读设置串行，避免欢迎页空一拍
  refreshRecent();
  renderHighlight();
  try {
    const settings = await invoke(api.getSettings());
    applyAppearance(settings);
    applyPrefs(settings);
  } catch {
    /* 读不到设置就用默认值 */
  }
  renderHighlight();
  try {
    const r = await api.registerShortcuts();
    prefs.bossKeyOk = !!(r && r.ok && r.data && !r.data.error);
  } catch {
    prefs.bossKeyOk = false;
  }
}

initApp();
