'use strict';

/**
 * 启动自检：加载真实主进程，验证窗口能起来、preload 桥接可用、IPC 能往返，
 * 并截图欢迎页与工作区，用于人工确认顶栏外观。
 * 用法：npm run check
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const project = require('../src/main/services/project');
const chapters = require('../src/main/services/chapters');
const canvasService = require('../src/main/services/canvas');
const versions = require('../src/main/services/versions');
const stats = require('../src/main/services/stats');
const { readText } = require('../src/main/services/fsutil');

const problems = [];
const shots = [];
let recentPath = null;
let recentBackup = null;
let settingsPath = null;
let settingsBackup = null;
let seedDir = null;
let importTxtPath = null;
let importBadPath = null;

/** 造一本样例书，并通过「最近打开」走真实入口进入工作区 */
function seedProject() {
  // 每次用独立目录：备份根按「目录路径」做键，复用同一路径会读到上次运行残留的旧版本
  const dir = path.join(os.tmpdir(), 'mushu-ui-check-' + Date.now().toString(36));
  fs.rmSync(dir, { recursive: true, force: true });
  project.createProject(dir, { title: '长夜行', author: '我' });

  const vol = 'chapters/v001-第一卷';
  const a = chapters.createChapter(dir, vol, '楔子');
  chapters.saveChapter(dir, a.id, {
    meta: { status: 'published' },
    body: '风起于青萍之末。\n\n他握紧了拳头，指节泛白。\n\n远处传来更鼓声，一声，两声。\n',
  });
  const b = chapters.createChapter(dir, vol, '第一章 入城');
  chapters.saveChapter(dir, b.id, {
    meta: { status: 'draft' },
    body: '城门在他身后合拢，像一声很轻的叹息。\n\n他抬头看向城楼上的灯笼。\n',
  });
  // 版本快照平时由 IPC 保存流程产生，这里手动补两次，便于截图时看到版本面板
  versions.snapshot(dir, b.id, readText(chapters.fromId(dir, b.id), ''));
  chapters.saveChapter(dir, b.id, {
    meta: { status: 'draft' },
    body: '城门在他身后合拢，像一声很轻的叹息。\n\n他抬头看向城楼上的灯笼，风一吹就晃。\n',
  });
  versions.snapshot(dir, b.id, readText(chapters.fromId(dir, b.id), ''));
  const c = chapters.createChapter(dir, vol, '第二章 旧识');
  chapters.saveChapter(dir, c.id, { meta: { status: 'checking' }, body: '三月的雨落在瓦上，一直没有停。\n\n' });
  stats.addWords(dir, b.id, 1832);
  return dir;
}

function useRecent(dir) {
  recentPath = path.join(app.getPath('userData'), 'recent.json');
  recentBackup = fs.existsSync(recentPath) ? fs.readFileSync(recentPath, 'utf8') : null;
  fs.mkdirSync(path.dirname(recentPath), { recursive: true });
  fs.writeFileSync(recentPath, JSON.stringify([{ dir, title: '长夜行', at: new Date().toISOString() }], null, 2));
}

/** 把默认作品目录临时指到沙箱，避免自检往真实文档目录里拉屎 */
function useTempRoot() {
  // 每次用独立目录：固定路径在上次运行崩溃时会残留「长夜行」，导致重名断言从 (2) 开始
  const root = path.join(os.tmpdir(), 'mushu-check-root-' + Date.now().toString(36));
  fs.rmSync(root, { recursive: true, force: true });
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  settingsBackup = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : null;
  fs.writeFileSync(settingsPath, JSON.stringify({ projectsRoot: root }, null, 2));
  return root;
}

function restoreUserData() {
  const put = (file, backup) => {
    try {
      if (backup === null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, backup);
    } catch {
      /* 恢复失败不影响自检结论 */
    }
  };
  if (recentPath) put(recentPath, recentBackup);
  if (settingsPath) put(settingsPath, settingsBackup);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(wc, name) {
  const img = await wc.capturePage();
  const file = path.join(os.tmpdir(), `mushu-${name}.png`);
  fs.writeFileSync(file, img.toPNG());
  shots.push(file);
}

// 先注册：保证样例数据在 createWindow 之前落盘
app.whenReady().then(() => {
  seedDir = seedProject();
  useTempRoot();
  useRecent(seedDir);
  // 给「导入 TXT」探针准备一份带章节标题的样稿
  importTxtPath = path.join(os.tmpdir(), 'mushu-import-sample.txt');
  fs.writeFileSync(importTxtPath, '导入样书\n\n第一章 起风\n风起于青萍之末。\n\n第二章 入夜\n更鼓响了两声。\n', 'utf8');
  importBadPath = path.join(os.tmpdir(), 'mushu-import-nohead.txt');
  fs.writeFileSync(importBadPath, '通篇没有章节标题的正文。\n第二行。\n', 'utf8');
});

app.on('browser-window-created', (_e, win) => {
  const wc = win.webContents;

  wc.on('console-message', (ev) => {
    const lv = ev.level != null ? String(ev.level) : 'info';
    const msg = ev.message != null ? ev.message : '';
    console.log(`[renderer:${lv}] ${msg}`);
    if (lv === 'error' || lv === '2') problems.push('console-error: ' + msg);
  });

  wc.on('render-process-gone', (_e2, details) => problems.push('render-process-gone: ' + JSON.stringify(details)));
  wc.on('did-fail-load', (_e2, code, desc) => problems.push(`did-fail-load ${code} ${desc}`));
  wc.on('preload-error', (_e2, file, err) => problems.push(`preload-error ${file}: ${err.message}`));

  wc.on('did-finish-load', async () => {
    try {
      await wait(600); // 「最近打开」是异步 IPC 拉回来的，等它渲染完再断言
      const boot = await wc.executeJavaScript(`(async () => ({
        hasBridge: typeof window.mushu === 'object',
        titlebar: !!document.getElementById('titlebar'),
        winControls: ['win-min','win-max','win-close'].every(id => !!document.getElementById(id)),
        welcomeVisible: !document.getElementById('welcome').classList.contains('hidden'),
        importBtn: !!document.getElementById('btn-import'),
        recentCount: document.querySelectorAll('#recent-list li').length
      }))()`);
      console.log('[check] boot probe ' + JSON.stringify(boot));
      if (!boot.hasBridge) problems.push('preload 桥接未注入');
      if (!boot.titlebar) problems.push('自绘标题栏缺失');
      if (!boot.winControls) problems.push('窗口控制按钮缺失');
      if (!boot.welcomeVisible) problems.push('欢迎页未显示');
      if (!boot.importBtn) problems.push('欢迎页缺少「导入 TXT」按钮');
      if (boot.recentCount < 1) problems.push('最近打开列表为空（样例作品未注入）');

      await wait(400);
      await shot(wc, 'welcome');

      // 走真实入口：点击「最近打开」里的样例作品
      await wc.executeJavaScript("document.querySelector('#recent-list li').click(); true");
      await wait(1600);

      const ws = await wc.executeJavaScript(`(async () => ({
        workspaceVisible: !document.getElementById('workspace').classList.contains('hidden'),
        book: document.getElementById('titlebar-book').textContent,
        chapter: document.getElementById('titlebar-chapter').textContent,
        actionsVisible: !document.getElementById('tb-actions').classList.contains('hidden'),
        chapters: document.querySelectorAll('.ch').length,
        status: document.getElementById('save-status').textContent,
        today: document.getElementById('word-today').textContent,
        leftTabs: document.querySelectorAll('#sidebar .rail-tab').length,
        rightTabs: document.querySelectorAll('#panel .rail-tabs .rail-tab').length,
        treeSearch: !!document.getElementById('tree-search'),
        aiVisible: !document.getElementById('ai-panel').classList.contains('hidden'),
        panelVisible: !document.getElementById('panel').classList.contains('hidden'),
        editorVisible: !document.getElementById('editor-pane').classList.contains('hidden'),
        outlineInEditor: !!document.querySelector('#body #outline-pane') && !document.querySelector('#sidebar #outline-pane'),
        bookClose: !!document.getElementById('btn-book-close'),
        noDupEntries: !document.getElementById('btn-ai') && !document.getElementById('btn-cast') && !document.getElementById('btn-close')
      }))()`);
      console.log('[check] workspace probe ' + JSON.stringify(ws));
      if (!ws.workspaceVisible) problems.push('进入作品后工作区未显示');
      if (ws.chapters < 3) problems.push('章节目录树渲染不完整，实际 ' + ws.chapters + ' 章');
      if (!ws.actionsVisible) problems.push('工作区顶栏操作按钮未显示');
      if (ws.book !== '长夜行') problems.push('顶栏书名不正确：' + ws.book);
      if (ws.leftTabs !== 4) problems.push('左栏页签数应为 4，实际 ' + ws.leftTabs);
      if (ws.rightTabs < 3) problems.push('右栏页签数异常，实际 ' + ws.rightTabs);
      if (!ws.treeSearch) problems.push('右栏缺少目录搜索框');
      if (!ws.aiVisible) problems.push('默认应停在左栏「对话」页签');
      if (!ws.panelVisible) problems.push('右栏目录面板默认应显示');
      if (!ws.editorVisible) problems.push('正文编辑器默认应显示');
      if (!ws.outlineInEditor) problems.push('故事大纲应挂在中间区，而不是左栏');
      if (!ws.bookClose) problems.push('书名旁缺少关闭作品按钮');
      if (!ws.noDupEntries) problems.push('顶栏仍保留与左栏重复的入口（AI / 设定 / 关闭作品）');

      await shot(wc, 'workspace');

      // 右栏搜索：章节名与正文全文都要能命中，点正文命中要把光标落过去
      const search = await wc.executeJavaScript(`(async () => {
        const input = document.getElementById('tree-search');
        input.value = '灯笼';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        // 防抖 220ms + IPC 往返，固定等待容易抖；轮询到结果区出现为止（最多 3s）
        for (let i = 0; i < 30; i += 1) {
          await new Promise((r) => setTimeout(r, 100));
          if (!document.getElementById('tree-result').classList.contains('hidden')) break;
        }
        const items = [...document.querySelectorAll('#tree-result .sr-item')];
        const groups = [...document.querySelectorAll('#tree-result .sr-group')].map((g) => g.textContent);
        const treeHidden = document.getElementById('tree').classList.contains('hidden');
        const resultShown = !document.getElementById('tree-result').classList.contains('hidden');
        if (items.length) items[0].click();
        // openChapter 要读盘，轮询到光标真的落到关键词上（最多 3s）
        const sel = document.getElementById('editor');
        for (let i = 0; i < 30; i += 1) {
          await new Promise((r) => setTimeout(r, 100));
          if (sel.selectionEnd > sel.selectionStart) break;
        }
        const picked = sel.value.slice(sel.selectionStart, sel.selectionEnd);
        document.getElementById('tree-search-clear').click();
        await new Promise((r) => setTimeout(r, 120));
        return {
          groups,
          hits: items.length,
          treeHidden,
          resultShown,
          picked,
          cleared: document.getElementById('tree-search').value === '' && !document.getElementById('tree').classList.contains('hidden')
        };
      })()`);
      console.log('[check] tree-search probe ' + JSON.stringify(search));
      if (!search.resultShown) problems.push('搜索后未显示结果区');
      if (!search.treeHidden) problems.push('搜索时目录树未让位');
      if (search.hits < 1) problems.push('正文全文搜索未命中「灯笼」');
      if (search.picked !== '灯笼') problems.push('点正文命中未把光标定位到关键片段，实际选中「' + search.picked + '」');
      if (!search.cleared) problems.push('清空搜索未恢复目录树');

      // 右栏折叠 / 展开
      const collapse = await wc.executeJavaScript(`(async () => {
        document.getElementById('rail-right-close').click();
        await new Promise((r) => setTimeout(r, 120));
        const collapsed = document.getElementById('panel').classList.contains('collapsed');
        const openerShown = !document.getElementById('rail-right-open').classList.contains('hidden');
        document.getElementById('rail-right-open').click();
        await new Promise((r) => setTimeout(r, 120));
        const reopened = !document.getElementById('panel').classList.contains('collapsed');
        return { collapsed, openerShown, reopened };
      })()`);
      console.log('[check] right-rail-collapse probe ' + JSON.stringify(collapse));
      if (!collapse.collapsed) problems.push('右栏收起按钮无效');
      if (!collapse.openerShown) problems.push('右栏收起后未出现唤回按钮');
      if (!collapse.reopened) problems.push('右栏无法展开');

      // 版本面板：确认版本快照 + diff 面板可用
      await wc.executeJavaScript("document.getElementById('btn-versions').click(); true");
      await wait(1800);
      const ver = await wc.executeJavaScript(`(async () => ({
        panelVisible: !document.getElementById('panel').classList.contains('collapsed'),
        paneVisible: !document.getElementById('version-panel').classList.contains('hidden'),
        tabActive: document.getElementById('tab-versions').classList.contains('active'),
        versions: document.querySelectorAll('.ver').length
      }))()`);
      console.log('[check] versions probe ' + JSON.stringify(ver));
      if (!ver.panelVisible) problems.push('版本面板未打开');
      if (!ver.paneVisible || !ver.tabActive) problems.push('版本页签未激活');
      if (ver.versions < 1) problems.push('版本列表为空');
      await shot(wc, 'versions');

      // 切回目录页签，别把后面的探针带到版本页
      await wc.executeJavaScript("document.getElementById('tab-tree').click(); true");
      await wait(200);

      // 设置面板：默认作品目录必须已回填
      await wc.executeJavaScript("document.getElementById('overlay').classList.add('hidden'); document.getElementById('btn-settings').click(); true");
      await wait(700);
      const st = await wc.executeJavaScript(`(async () => {
        const s = await window.mushu.getSettings();
        const input = document.querySelector('#overlay-box .field-row input');
        return {
          modalVisible: !document.getElementById('overlay').classList.contains('hidden'),
          input: input ? input.value : null,
          projectsRoot: s && s.ok ? s.data.projectsRoot : null,
          hasPickBtn: !!document.querySelector('#overlay-box .field-row button')
        };
      })()`);
      console.log('[check] settings probe ' + JSON.stringify(st));
      if (!st.modalVisible) problems.push('设置面板未打开');
      if (!st.projectsRoot) problems.push('默认作品目录未配置');
      if (st.input !== st.projectsRoot) problems.push('设置面板未回填当前默认目录：' + st.input);
      if (!st.hasPickBtn) problems.push('设置面板缺少「选择…」按钮');
      await shot(wc, 'settings');

      // 新建作品：只能填书名/作者，不再出现目录选择
      await wc.executeJavaScript("document.getElementById('overlay').classList.add('hidden'); document.getElementById('btn-new').click(); true");
      await wait(600);
      const np = await wc.executeJavaScript(`({
        modalVisible: !document.getElementById('overlay').classList.contains('hidden'),
        fields: document.querySelectorAll('#overlay-box input').length,
        labels: [...document.querySelectorAll('#overlay-box label')].map((l) => l.textContent).join(' / ')
      })`);
      console.log('[check] new-project probe ' + JSON.stringify(np));
      if (!np.modalVisible) problems.push('「新建作品」弹窗未打开');
      if (np.fields !== 2) problems.push('新建作品弹窗字段数应为 2（书名/作者），实际 ' + np.fields);

      // 自动建目录 + 重名加序号
      const mk = await wc.executeJavaScript(`(async () => {
        const a = await window.mushu.createProject({ title: '长夜行' });
        const b = await window.mushu.createProject({ title: '长夜行' });
        const c = await window.mushu.createProject({ title: '长夜行/另一本. ' });
        return { a: a.ok ? a.data.project.dir : a.error, b: b.ok ? b.data.project.dir : b.error, c: c.ok ? c.data.project.dir : c.error };
      })()`);
      const base = (p) => String(p).split(/[\\\\/]/).pop();
      console.log('[check] auto-dir probe ' + JSON.stringify({ a: base(mk.a), b: base(mk.b), c: base(mk.c) }));
      if (base(mk.a) !== '长夜行') problems.push('首个同名作品目录应为「长夜行」，实际 ' + base(mk.a));
      if (base(mk.b) !== '长夜行 (1)') problems.push('重名应加序号为「长夜行 (1)」，实际 ' + base(mk.b));
      if (base(mk.c) !== '长夜行另一本') problems.push('非法字符未清理，实际 ' + base(mk.c));

      // 正文外观：默认字号生效 + 越界收敛 + 字体可存
      const font = await wc.executeJavaScript(`(async () => {
        const initial = getComputedStyle(document.getElementById('editor')).fontSize;
        const bad = await window.mushu.setSettings({ editorSize: 999, editorLineHeight: 9 });
        const good = await window.mushu.setSettings({ editorSize: 21, editorLineHeight: 2.4, editorFont: 'KaiTi, STKaiti, serif' });
        return {
          initial,
          clampedSize: bad.ok ? bad.data.editorSize : bad.error,
          clampedLeading: bad.ok ? bad.data.editorLineHeight : bad.error,
          savedFont: good.ok ? good.data.editorFont : good.error
        };
      })()`);
      console.log('[check] appearance probe ' + JSON.stringify(font));
      if (font.initial !== '18px') problems.push('正文默认字号应为 18px，实际 ' + font.initial);
      if (font.clampedSize !== 40) problems.push('字号越界未收敛到 40，实际 ' + font.clampedSize);
      if (font.clampedLeading !== 3.5) problems.push('行高越界未收敛到 3.5，实际 ' + font.clampedLeading);
      if (font.savedFont !== 'KaiTi, STKaiti, serif') problems.push('字体设置未存住，实际 ' + font.savedFont);

      // 改名：双击节点呼出行内输入框
      await wc.executeJavaScript(`(() => {
        document.querySelector('.ch').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return true;
      })()`);
      await wait(400);
      const editing = await wc.executeJavaScript(`({
        inputShown: !!document.querySelector('.ch .rename-input'),
        value: document.querySelector('.ch .rename-input') ? document.querySelector('.ch .rename-input').value : null
      })`);
      console.log('[check] rename-input probe ' + JSON.stringify(editing));
      if (!editing.inputShown) problems.push('双击章节未出现行内改名输入框');
      if (editing.value !== '楔子') problems.push('改名输入框未带出原章名，实际 ' + editing.value);

      await wc.executeJavaScript(`(() => {
        const input = document.querySelector('.ch .rename-input');
        input.value = '楔子·改';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return true;
      })()`);
      await wait(900);
      const chAfter = await wc.executeJavaScript(`({
        title: document.querySelector('.ch .ch-title').textContent.trim(),
        stillEditing: !!document.querySelector('.rename-input'),
        editorAlive: document.getElementById('editor').value.length > 0,
        status: document.getElementById('save-status').textContent
      })`);
      console.log('[check] rename-chapter probe ' + JSON.stringify(chAfter));
      if (chAfter.title !== '楔子·改') problems.push('章节改名未落到目录树，实际 ' + chAfter.title);
      if (chAfter.stillEditing) problems.push('章节改名后输入框未收起');
      if (!chAfter.editorAlive) problems.push('章节改名后正文被清空');

      // 卷改名：目录换名，打开中的章节要跟着换 id
      await wc.executeJavaScript(`(async () => {
        const head = document.querySelector('.vol');
        head.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 250));
        const input = head.querySelector('.rename-input');
        input.value = '卷一·风起';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return true;
      })()`);
      await wait(1000);
      const volAfter = await wc.executeJavaScript(`(() => {
        const head = document.querySelector('.vol');
        const words = head.querySelector('.vol-words');
        return {
          title: head.textContent.replace(words ? words.textContent : '', '').trim(),
          chapter: document.querySelector('.ch .ch-title').textContent.trim(),
          editorAlive: document.getElementById('editor').value.length > 0,
          words: document.getElementById('word-chapter').textContent
        };
      })()`);
      console.log('[check] rename-volume probe ' + JSON.stringify(volAfter));
      if (volAfter.title !== '卷一·风起') problems.push('分卷改名未落到目录树，实际 ' + volAfter.title);
      if (volAfter.chapter !== '楔子·改') problems.push('分卷改名后卷内章节丢失，实际 ' + volAfter.chapter);
      if (!volAfter.editorAlive) problems.push('分卷改名后正文被清空');
      if (!volAfter.words) problems.push('分卷改名后章节统计丢失');

      // 书名改名：走 book.json，不动目录名
      const book = await wc.executeJavaScript(`(async () => {
        const dir = ${JSON.stringify(seedDir)};
        const saved = await window.mushu.updateBook(dir, { title: '长夜行·新名' });
        const t = await window.mushu.tree(dir);
        return { title: saved.ok ? saved.data.title : saved.error, volumes: t.ok ? t.data.volumes.length : t.error };
      })()`);
      console.log('[check] rename-book probe ' + JSON.stringify(book));
      if (book.title !== '长夜行·新名') problems.push('书名改名失败，实际 ' + book.title);
      if (book.volumes < 1) problems.push('书名改名后目录树丢失');

      // 故事大纲：从顶栏打开 → 占中间区（正文让位）→ 直接在排版上编辑 → 自动保存回 bible/outline.md
      await wc.executeJavaScript("document.getElementById('btn-outline').click(); true");
      await wait(500);
      const outline = await wc.executeJavaScript(`(async () => {
        const pane = document.getElementById('outline-pane');
        const open = !pane.classList.contains('hidden');
        const editorVisible = !document.getElementById('editor-pane').classList.contains('hidden');
        const tabActive = document.getElementById('btn-outline').classList.contains('active');
        const body = document.getElementById('outline-body');
        const src = '# 大纲测试\\n\\n| 列A | 列B |\\n| --- | --- |\\n| 一 | 二 |\\n\\n- 要点一';
        body.innerHTML = window.renderMarkdown(src);
        body.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 2000));
        const back = await window.mushu.readOutline(${JSON.stringify(seedDir)});
        const round = window.markdownFromDom(body);
        const h1 = body.querySelector('h1');
        return {
          open,
          editorVisible,
          tabActive,
          status: document.getElementById('outline-status').textContent,
          count: document.getElementById('word-chapter').textContent,
          tableShown: !!body.querySelector('table'),
          headingShown: h1 ? h1.textContent : '',
          stored: back.ok ? String(back.data) : back.error,
          roundOk: round.includes('# 大纲测试') && round.includes('| 列A | 列B |') && round.includes('- 要点一')
        };
      })()`);
      console.log('[check] outline probe ' + JSON.stringify(outline));
      if (!outline.open || !outline.tabActive) problems.push('故事大纲未在中间区打开');
      if (outline.editorVisible) problems.push('打开大纲时正文编辑器应让位（中间区互斥）');
      if (!/^大纲 \d+ 字$/.test(outline.count)) problems.push('状态栏未按页面统计大纲字数：' + outline.count);
      if (!outline.tableShown) problems.push('大纲未以排版形式显示表格');
      if (outline.headingShown !== '大纲测试') problems.push('大纲未以排版形式显示标题：' + outline.headingShown);
      if (!outline.roundOk) problems.push('编辑区 DOM 未能还原成 Markdown');
      if (!outline.stored.includes('大纲测试')) problems.push('故事大纲未保存到 bible/outline.md');
      if (!outline.stored.includes('| 列A | 列B |')) problems.push('大纲存盘未保持 Markdown 表格');
      await wc.executeJavaScript("document.getElementById('overlay').classList.add('hidden'); true");
      await wait(200);
      await shot(wc, 'outline');

      // AI 助手：大纲还在中间区，切到「对话」页签后 AI 仍应盯着大纲；关掉大纲再回到正文
      const aiProbe = await wc.executeJavaScript(`(async () => {
        const panel = document.getElementById('ai-panel');
        const hasBridge = typeof window.mushu.aiChat === 'function' && typeof window.mushu.onAiDelta === 'function';
        document.getElementById('tab-ai').click();
        await new Promise((r) => setTimeout(r, 250));
        const shown = !panel.classList.contains('hidden');
        const outlineCtx = document.getElementById('ai-context').textContent;
        document.getElementById('tab-cards').click();
        await new Promise((r) => setTimeout(r, 250));
        const cardPaneShown = !document.getElementById('card-panel').classList.contains('hidden');
        document.getElementById('tab-ai').click();
        await new Promise((r) => setTimeout(r, 250));
        document.getElementById('outline-close').click();
        await new Promise((r) => setTimeout(r, 500));
        const editorBack = !document.getElementById('editor-pane').classList.contains('hidden');
        const chapterCtx = document.getElementById('ai-context').textContent;
        return { hasBridge, shown, outlineCtx, cardPaneShown, editorBack, chapterCtx, hasInput: !!document.getElementById('ai-input') };
      })()`);
      console.log('[check] ai probe ' + JSON.stringify(aiProbe));
      if (!aiProbe.hasBridge) problems.push('AI 桥接方法缺失（aiChat / onAiDelta）');
      if (!aiProbe.shown) problems.push('点击「对话」页签后 AI 面板未显示');
      if (!aiProbe.hasInput) problems.push('AI 对话窗口缺少输入框');
      if (!aiProbe.cardPaneShown) problems.push('左栏「角色卡片」页签未切换');
      if (aiProbe.outlineCtx !== '故事大纲') problems.push('大纲页 AI 上下文不正确：' + aiProbe.outlineCtx);
      if (!aiProbe.editorBack) problems.push('点「返回正文」后正文编辑器未回来');
      if (!/^正文/.test(aiProbe.chapterCtx)) problems.push('正文页 AI 上下文不正确：' + aiProbe.chapterCtx);
      await shot(wc, 'ai');

      // 左栏角色页签：card-add 只把角色建进角色库（不上画布），点列表项才摆到画布上
      const cards = await wc.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const clickItem = (el) => {
          const r = el.getBoundingClientRect();
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: r.left + 10, clientY: r.top + 12 }));
          document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: r.left + 10, clientY: r.top + 12 }));
        };
        document.getElementById('tab-cards').click();
        await wait(300);
        document.getElementById('card-add').click();
        await wait(500);
        const canvasAfterAdd = !document.getElementById('canvas-pane').classList.contains('hidden');
        const items = document.querySelectorAll('#card-list .rail-item').length;
        const onCanvasAfterAdd = document.querySelectorAll('#canvas-cards .cv-card').length;
        const tagged = !!document.querySelector('#card-list .rail-item.unplaced .rail-tag');
        clickItem(document.querySelector('#card-list .rail-item'));
        await wait(700);
        const canvasShown = !document.getElementById('canvas-pane').classList.contains('hidden');
        const onCanvas = document.querySelectorAll('#canvas-cards .cv-card').length;
        const count = document.getElementById('word-chapter').textContent;
        document.getElementById('canvas-close').click();
        await wait(400);
        document.getElementById('tab-beats').click();
        await wait(300);
        const beatEmpty = !!document.querySelector('#beat-list .rail-empty');
        return { canvasAfterAdd, items, onCanvasAfterAdd, tagged, canvasShown, onCanvas, count, beatEmpty };
      })()`);
      console.log('[check] rail-cards probe ' + JSON.stringify(cards));
      if (cards.canvasAfterAdd) problems.push('新建角色不应自动跳到画布');
      if (cards.items < 1) problems.push('角色卡片列表未渲染新增角色');
      if (cards.onCanvasAfterAdd !== 0) problems.push('新建角色不应默认摆到画布上，实际 ' + cards.onCanvasAfterAdd);
      if (!cards.tagged) problems.push('未上画布的角色缺少「未上画布」标记');
      if (!cards.canvasShown) problems.push('点角色列表项未打开画布');
      if (cards.onCanvas !== 1) problems.push('点角色列表项后画布上卡片数应为 1，实际 ' + cards.onCanvas);
      if (!/卡片 1 · 关系 0 条/.test(cards.count)) problems.push('画布状态栏未按已上画布卡片计数：' + cards.count);
      if (cards.beatEmpty !== true) problems.push('剧情卡片页签未显示空状态');

      // 知识图谱：切到图谱视图，从卡片手柄拖到另一张卡片建立关系，再删除
      const graph = await wc.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        // 从左侧角色库把未上画布的角色拖到画布上的指定位置
        const dragFirstUnplaced = async (fx, fy) => {
          const el = document.querySelector('#card-list .rail-item.unplaced');
          if (!el) return false;
          const r = el.getBoundingClientRect();
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: r.left + 10, clientY: r.top + 12 }));
          document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, button: 0, clientX: r.left + 60, clientY: r.top + 12 }));
          document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, button: 0, clientX: fx, clientY: fy }));
          document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: fx, clientY: fy }));
          await wait(300);
          return true;
        };
        document.getElementById('tab-cards').click();
        await wait(300);
        document.getElementById('card-add').click(); // 建两个角色进库
        await wait(150);
        document.getElementById('card-add').click();
        await wait(250);
        // 打开画布，再把两个新角色拖到画布上两个不同位置
        document.getElementById('card-open-canvas').click();
        await wait(500);
        const vp = document.getElementById('canvas-viewport').getBoundingClientRect();
        await dragFirstUnplaced(vp.left + vp.width * 0.32, vp.top + vp.height * 0.4);
        await dragFirstUnplaced(vp.left + vp.width * 0.68, vp.top + vp.height * 0.62);
        await wait(200);
        // 角色卡片只属于知识图谱：故事线视图里不应该出现卡片
        document.getElementById('cv-mode-story').click();
        await wait(250);
        const storyCards = document.querySelectorAll('#canvas-cards .cv-card').length;
        const storyLines = document.querySelectorAll('#canvas-svg-root .cv-line').length;
        document.getElementById('cv-mode-graph').click();
        await wait(350);
        const graphCards = document.querySelectorAll('#canvas-cards .cv-card').length;
        const cards = [...document.querySelectorAll('#canvas-cards .cv-card')];
        if (cards.length < 2) return { error: '卡片不足两张', n: cards.length };
        // 布局后两张卡可能挨得很近，先把第二张拖开，免得遮住连线与标签
        const r1 = cards[1].getBoundingClientRect();
        const nx = r1.left + 320;
        const ny = r1.top + 160;
        cards[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: r1.left + 30, clientY: r1.top + 20 }));
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: nx, clientY: ny }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: nx, clientY: ny }));
        await wait(250);
        const cards2 = [...document.querySelectorAll('#canvas-cards .cv-card')];
        const handle = cards2[0].querySelector('.cv-connect-handle');
        if (!handle) return { error: '图谱模式下卡片没有连线手柄' };
        const h = handle.getBoundingClientRect();
        const t = cards2[1].getBoundingClientRect();
        const tx = t.left + t.width / 2;
        const ty = t.top + t.height / 2;
        handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: h.left + h.width / 2, clientY: h.top + h.height / 2 }));
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: tx, clientY: ty }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: tx, clientY: ty }));
        await wait(300);
        const modalOpen = !document.getElementById('overlay').classList.contains('hidden');
        const input = document.querySelector('#overlay-box input[type="text"]');
        if (input) input.value = '师徒';
        const ok = document.querySelector('#overlay-box .overlay-actions .primary');
        if (ok) ok.click();
        await wait(400);
        const lines = document.querySelectorAll('#canvas-svg-root .cv-link').length;
        const arrow = document.querySelectorAll('#canvas-svg-root .cv-link[marker-end]').length;
        const labels = [...document.querySelectorAll('#canvas-svg-root .cv-link-label')].map((x) => x.textContent).join(',');
        const countText = document.getElementById('word-chapter').textContent;
        return { storyCards, storyLines, graphCards, modalOpen, lines, arrow, labels, countText };
      })()`);
      console.log('[check] graph probe ' + JSON.stringify(graph));
      if (graph.error) problems.push('知识图谱：' + graph.error);
      if (graph.storyCards !== 0) problems.push('故事线视图里不应出现角色卡片，实际 ' + graph.storyCards);
      if (graph.graphCards < 2) problems.push('知识图谱视图里未画出角色卡片，实际 ' + graph.graphCards);
      if (!graph.modalOpen) problems.push('拖拽连线后未弹出关系词输入框');
      if (graph.lines < 1) problems.push('知识图谱未渲染关系连线');
      if (graph.arrow < 1) problems.push('关系连线缺少箭头 marker');
      if (!String(graph.labels || '').includes('师徒')) problems.push('关系标签未渲染：' + graph.labels);
      if (!/关系/.test(String(graph.countText || ''))) problems.push('图谱状态栏未显示关系数：' + graph.countText);
      await shot(wc, 'graph'); // 趁关系连线还在时截图留档

      // 选中连线按 Delete 删除，再切回故事线并关掉画布
      const graphDel = await wc.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const hit = document.querySelector('#canvas-svg-root .cv-link-hit');
        if (hit) hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 0, clientY: 0 }));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
        await wait(300);
        const yes = document.querySelector('#overlay-box .overlay-actions .primary');
        if (yes) yes.click();
        await wait(500);
        const after = document.querySelectorAll('#canvas-svg-root .cv-link').length;
        document.getElementById('cv-mode-story').click();
        await wait(200);
        const storyBack = document.querySelectorAll('#canvas-svg-root .cv-line').length;
        document.getElementById('canvas-close').click();
        return { after, storyBack };
      })()`);
      console.log('[check] graph-del probe ' + JSON.stringify(graphDel));
      if (graphDel.after !== 0) problems.push('Delete 删除关系未生效，剩余 ' + graphDel.after);

      // 知识图谱径向视图：人形头像、以圆心分层、层级切换、关系一览面板
      const radial = await wc.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const dragFirstUnplaced = async (fx, fy) => {
          const el = document.querySelector('#card-list .rail-item.unplaced');
          if (!el) return false;
          const r = el.getBoundingClientRect();
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: r.left + 10, clientY: r.top + 12 }));
          document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, button: 0, clientX: r.left + 60, clientY: r.top + 12 }));
          document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, button: 0, clientX: fx, clientY: fy }));
          document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: fx, clientY: fy }));
          await wait(300);
          return true;
        };
        // 从第 i 张卡的连线手柄拖到第 j 张卡，弹框里填关系词
        const linkCards = async (i, j, label) => {
          const all = [...document.querySelectorAll('#canvas-cards .cv-card')];
          const handle = all[i] && all[i].querySelector('.cv-connect-handle');
          if (!handle) return false;
          const h = handle.getBoundingClientRect();
          const t = all[j].getBoundingClientRect();
          const tx = t.left + t.width / 2;
          const ty = t.top + t.height / 2;
          handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: h.left + h.width / 2, clientY: h.top + h.height / 2 }));
          document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, button: 0, clientX: tx, clientY: ty }));
          document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: tx, clientY: ty }));
          await wait(300);
          const input = document.querySelector('#overlay-box input[type="text"]');
          if (input) input.value = label;
          const ok = document.querySelector('#overlay-box .overlay-actions .primary');
          if (ok) ok.click();
          await wait(450);
          return true;
        };
        document.getElementById('tab-cards').click();
        await wait(250);
        document.getElementById('card-add').click();
        await wait(150);
        document.getElementById('card-add').click();
        await wait(250);
        document.getElementById('card-open-canvas').click();
        await wait(500);
        const vp = document.getElementById('canvas-viewport').getBoundingClientRect();
        await dragFirstUnplaced(vp.left + vp.width * 0.3, vp.top + vp.height * 0.35);
        await dragFirstUnplaced(vp.left + vp.width * 0.7, vp.top + vp.height * 0.6);
        await wait(200);
        document.getElementById('cv-mode-graph').click();
        await wait(500);
        const cardsN = document.querySelectorAll('#canvas-cards .cv-card').length;
        const avatars = document.querySelectorAll('#canvas-cards .cv-card .cv-avatar svg').length;
        const toolsShown = !document.getElementById('cv-graph-tools').classList.contains('hidden');
        const chip = document.getElementById('cv-focus-chip').textContent;
        const focusMarks = document.querySelectorAll('#canvas-cards .cv-card.focus').length;
        const ringBefore = document.querySelectorAll('#canvas-svg-root .cv-ring').length;
        const panelShown = !document.getElementById('cv-rel-panel').classList.contains('hidden');
        const rowsBefore = document.querySelectorAll('#cv-rel-panel .rel-row').length;
        // 从圆心出发连两条：圆心 → 第 2 人 → 第 3 人，形成两层
        if (!(await linkCards(0, 1, '师徒'))) return { error: '圆心卡片缺少连线手柄', cardsN };
        if (!(await linkCards(1, 2, '同门'))) return { error: '第二张卡片缺少连线手柄', cardsN };
        document.getElementById('canvas-fit').click();
        await wait(350);
        const ringAfter = document.querySelectorAll('#canvas-svg-root .cv-ring').length;
        const rowsAfter = document.querySelectorAll('#cv-rel-panel .rel-row').length;
        const groups = [...document.querySelectorAll('#cv-rel-panel .rel-group h4')].map((x) => x.textContent);
        const viaText = [...document.querySelectorAll('#cv-rel-panel .rel-via')].map((x) => x.textContent).join(',');
        // 第一层的卡片应正好落在「圆心到参考环」的距离上（ringStep = 320 世界单位）
        const focused = document.querySelector('#canvas-cards .cv-card.focus');
        const second = [...document.querySelectorAll('#canvas-cards .cv-card')][1];
        const zoom = Number(document.getElementById('canvas-zoom-label').textContent.replace('%', '')) / 100 || 1;
        const fr = focused.getBoundingClientRect();
        const sr = second.getBoundingClientRect();
        const worldDist = Math.hypot(sr.left - fr.left, sr.top - fr.top) / zoom;
        const onRing = Math.abs(worldDist - 320) < 60 ? 1 : 0;
        // 层级切换：一层 / 全部
        document.getElementById('cv-depth-1').click();
        await wait(400);
        const depthBtn = document.querySelector('.cv-depth-btn.active');
        const d1 = depthBtn ? depthBtn.id : '';
        const ringsDepth1 = document.querySelectorAll('#canvas-svg-root .cv-ring').length;
        document.getElementById('cv-depth-all').click();
        await wait(400);
        const depthBtn2 = document.querySelector('.cv-depth-btn.active');
        const dAll = depthBtn2 ? depthBtn2.id : '';
        const ringsDepthAll = document.querySelectorAll('#canvas-svg-root .cv-ring').length;
        // 换圆心：点圆心按钮 → 选关系最多的那张（第 2 人，有两条关系）
        document.getElementById('cv-focus-chip').click();
        await wait(250);
        const menuItems = document.querySelectorAll('.ctx-menu .ctx-item').length;
        const firstItem = document.querySelector('.ctx-menu .ctx-item');
        const firstLabel = firstItem ? firstItem.textContent : '';
        if (firstItem) firstItem.click();
        await wait(500);
        const focusMarks2 = document.querySelectorAll('#canvas-cards .cv-card.focus').length;
        const chip2 = document.getElementById('cv-focus-chip').textContent;
        const g2 = document.querySelector('#cv-rel-panel .rel-group h4');
        const firstGroupText = g2 ? g2.textContent : '';
        const ringsAfterFocus = document.querySelectorAll('#canvas-svg-root .cv-ring').length;
        // 关系分类：分类由本书关系词现算（师徒 / 同门 无共用汉字 → 应是两类），点芯片可整类显隐
        const catChips = [...document.querySelectorAll('#cv-rel-panel .rel-cat')];
        const catNames = catChips.map((b) => b.dataset.cat).sort();
        const catsN = catChips.length;
        const linksBeforeCats = document.querySelectorAll('#canvas-svg-root .cv-link').length;
        if (!catChips.length) return { error: '关系一览缺少关系分类芯片', cardsN };
        catChips[0].click();
        await wait(350);
        const linksAfterHide = document.querySelectorAll('#canvas-svg-root .cv-link').length;
        const offAfterHide = document.querySelectorAll('#cv-rel-panel .rel-cat.off').length;
        const hasResetCats = !!document.querySelector('#cv-rel-panel .rel-cats-reset');
        const resetCatsBtn = document.querySelector('#cv-rel-panel .rel-cats-reset');
        if (resetCatsBtn) resetCatsBtn.click();
        await wait(350);
        const linksAfterShow = document.querySelectorAll('#canvas-svg-root .cv-link').length;
        const offAfterShow = document.querySelectorAll('#cv-rel-panel .rel-cat.off').length;
        document.getElementById('cv-relayout').click();
        await wait(400);
        const cardsAfter = document.querySelectorAll('#canvas-cards .cv-card').length;
        // 先不退出图谱：留一张径向视图的截图供人工确认，收尾放到截图之后
        return {
          cardsN, avatars, toolsShown, chip, focusMarks, ringBefore, ringAfter,
          panelShown, rowsBefore, rowsAfter, groups, viaText, onRing, d1, dAll,
          ringsDepth1, ringsDepthAll, menuItems, firstLabel, focusMarks2, chip2,
          firstGroupText, ringsAfterFocus, catsN, catNames, linksBeforeCats,
          linksAfterHide, offAfterHide, hasResetCats, linksAfterShow, offAfterShow, cardsAfter
        };
      })()`);
      console.log('[check] graph-radial probe ' + JSON.stringify(radial));
      if (radial.error) problems.push('图谱径向视图：' + radial.error);
      if (radial.cardsN < 5) problems.push('图谱径向视图卡片数不足，实际 ' + radial.cardsN);
      if (radial.avatars !== radial.cardsN) problems.push('画布卡片未渲染人形头像节点');
      if (!radial.toolsShown) problems.push('知识图谱下未显示圆心 / 层级 / 整理布局控件');
      if (!/^圆心：/.test(String(radial.chip || ''))) problems.push('圆心按钮未显示当前圆心：' + radial.chip);
      if (radial.focusMarks !== 1) problems.push('圆心卡片未唯一高亮，实际 ' + radial.focusMarks);
      if (radial.ringBefore !== 0) problems.push('没有关系时不应出现参考环，实际 ' + radial.ringBefore);
      if (radial.ringAfter !== 2) problems.push('两层关系应画出 2 个参考环，实际 ' + radial.ringAfter);
      if (radial.onRing !== 1) problems.push('第 2 张卡片没有落在第一层参考环上');
      if (!radial.panelShown) problems.push('知识图谱下未显示关系一览面板');
      if (radial.rowsBefore !== radial.cardsN - 1) problems.push('关系一览应列出除圆心外的全部角色：' + radial.rowsBefore);
      if (radial.rowsAfter !== radial.cardsN - 1) problems.push('建立关系后关系一览行数异常：' + radial.rowsAfter);
      const grp = radial.groups || [];
      if (!String(grp[0] || '').includes('直接关系 · 1')) problems.push('关系一览未按层分组：' + JSON.stringify(grp));
      if (!String(grp[1] || '').includes('二度关系 · 1')) problems.push('关系一览缺少二度关系分组：' + JSON.stringify(grp));
      if (!/经 /.test(String(radial.viaText || ''))) problems.push('二度关系未标注「经 X」：' + radial.viaText);
      if (radial.d1 !== 'cv-depth-1') problems.push('层级切换「一层」未生效：' + radial.d1);
      if (radial.ringsDepth1 !== 1) problems.push('只显示一层时应只剩 1 个参考环，实际 ' + radial.ringsDepth1);
      if (radial.dAll !== 'cv-depth-all') problems.push('层级切换「全部」未生效：' + radial.dAll);
      if (radial.ringsDepthAll !== 2) problems.push('「全部」应恢复 2 个参考环，实际 ' + radial.ringsDepthAll);
      if (radial.menuItems !== radial.cardsN) problems.push('圆心选择列表条目数不正确：' + radial.menuItems);
      if (!String(radial.firstLabel || '').includes('2 条关系')) problems.push('圆心候选未按关系数排序：' + radial.firstLabel);
      if (radial.focusMarks2 !== 1) problems.push('换圆心后圆心高亮不唯一，实际 ' + radial.focusMarks2);
      if (radial.chip2 === radial.chip) problems.push('换圆心后按钮文案未更新：' + radial.chip2);
      if (radial.ringsAfterFocus !== 1) problems.push('换圆心后参考环未重算，实际 ' + radial.ringsAfterFocus);
      if (!String(radial.firstGroupText || '').includes('直接关系 · 2')) {
        problems.push('换圆心后关系一览未重算：' + radial.firstGroupText);
      }
      if (radial.cardsAfter !== radial.cardsN) problems.push('整理布局后卡片数发生变化：' + radial.cardsAfter);
      if (radial.catsN !== 2) {
        problems.push('关系分类应把「师徒 / 同门」聚成 2 类，实际 ' + radial.catsN + ' ' + JSON.stringify(radial.catNames));
      }
      if (radial.linksAfterHide !== radial.linksBeforeCats - 1) {
        problems.push('关掉一个关系分类后应少画一条关系线，实际 ' + radial.linksAfterHide);
      }
      if (radial.offAfterHide !== 1) problems.push('关掉的分类未在芯片上显示为已关闭，实际 ' + radial.offAfterHide);
      if (!radial.hasResetCats) problems.push('关掉分类后未出现「全部显示」按钮');
      if (radial.linksAfterShow !== radial.linksBeforeCats) {
        problems.push('「全部显示」未恢复全部关系线，实际 ' + radial.linksAfterShow);
      }
      if (radial.offAfterShow !== 0) problems.push('「全部显示」后仍有分类处于关闭状态，实际 ' + radial.offAfterShow);
      await shot(wc, 'graph-radial');
      // 截图后再退出图谱，避免影响后续探针
      await wc.executeJavaScript(`(() => {
        document.getElementById('cv-mode-story').click();
        document.getElementById('canvas-close').click();
        return true;
      })()`);
      await wait(500);

      // 画布右侧卡片详情面板：点左侧角色卡片 → 画布打开并选中 → 面板显示介绍与出场章节
      const detail = await wc.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        document.getElementById('tab-cards').click();
        await wait(300);
        const item = document.querySelector('#card-list .rail-item');
        if (!item) return { error: '左栏没有角色卡片可点' };
        const ir = item.getBoundingClientRect();
        item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: ir.left + 10, clientY: ir.top + 12 }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: ir.left + 10, clientY: ir.top + 12 }));
        await wait(800); // 等画布打开 + 出场章节扫描回填
        const head = document.getElementById('canvas-detail-head').textContent;
        const body = document.getElementById('canvas-detail-body').textContent;
        const box = document.getElementById('cv-detail-appear');
        return {
          head,
          hasIntro: body.includes('角色介绍'),
          hasAppear: body.includes('出场章节'),
          appearText: box ? box.textContent : '',
          failed: body.includes('扫描失败')
        };
      })()`);
      console.log('[check] canvas-detail probe ' + JSON.stringify(detail));
      if (detail.error) problems.push('卡片详情面板：' + detail.error);
      if (!String(detail.head || '').trim()) problems.push('选中卡片后详情面板标题为空');
      if (!detail.hasIntro) problems.push('详情面板缺少「角色介绍」分区');
      if (!detail.hasAppear) problems.push('详情面板缺少「出场章节」分区');
      if (!String(detail.appearText || '').trim()) problems.push('出场章节区没有内容（未回填）');
      if (detail.failed) problems.push('出场章节扫描失败');
      await shot(wc, 'canvas-detail');

      // 点画布空白：清空选中，详情面板回到空状态，随后关掉画布
      const detailClear = await wc.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const vp = document.getElementById('canvas-viewport');
        const r = vp.getBoundingClientRect();
        vp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: r.left + 30, clientY: r.top + 30 }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: r.left + 30, clientY: r.top + 30 }));
        await wait(300);
        const head = document.getElementById('canvas-detail-head').textContent;
        const body = document.getElementById('canvas-detail-body').textContent;
        document.getElementById('canvas-close').click();
        return { head, body };
      })()`);
      console.log('[check] canvas-detail-clear probe ' + JSON.stringify(detailClear));
      if (String(detailClear.head || '').trim()) problems.push('点空白后详情面板标题未清空');
      if (!/点击画布/.test(String(detailClear.body || ''))) problems.push('点空白后详情面板未回到空状态');

      // 情节点下钻：双击节点进入它自己的新画布（不是弹详情框），还能继续往下钻
      const pdOpen = await wc.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const crumbs = () => [...document.querySelectorAll('#cv-crumbs .cv-crumb')].map((b) => b.textContent);
        document.getElementById('tab-beats').click();
        await wait(250);
        document.getElementById('beat-add').click();
        await wait(900);
        const hit = document.querySelector('#canvas-svg-root .cv-node-hit');
        if (!hit) return { error: '故事线里没有可以双击的情节点' };
        hit.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await wait(600);
        const enter = {
          canvasShown: !document.getElementById('canvas-pane').classList.contains('hidden'),
          crumbs: crumbs(),
          nodes: document.querySelectorAll('#canvas-svg-root .cv-node-hit').length,
          hint: document.getElementById('canvas-hint').textContent,
          overlayOpen: !document.getElementById('overlay').classList.contains('hidden')
        };
        // 子画布里再放一个情节点：验证新增落在当前层，而不是写回根画布
        document.getElementById('beat-add').click();
        await wait(700);
        const childNodes = document.querySelectorAll('#canvas-svg-root .cv-node-hit').length;
        const child = document.querySelector('#canvas-svg-root .cv-node-hit');
        if (child) child.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await wait(600);
        const deeper = {
          crumbs: crumbs(),
          nodes: document.querySelectorAll('#canvas-svg-root .cv-node-hit').length
        };
        // 点第一个面包屑回到根画布
        const rootCrumb = document.querySelector('#cv-crumbs .cv-crumb');
        if (rootCrumb) rootCrumb.click();
        await wait(600);
        const backRoot = {
          crumbs: crumbs(),
          nodes: document.querySelectorAll('#canvas-svg-root .cv-node-hit').length
        };
        return { enter, childNodes, deeper, backRoot };
      })()`);
      console.log('[check] point-drill probe ' + JSON.stringify(pdOpen));
      if (pdOpen.error) problems.push('情节点下钻：' + pdOpen.error);
      const enterInfo = pdOpen.enter || {};
      if (!enterInfo.canvasShown) problems.push('双击情节点后没有进入新的画布');
      if ((enterInfo.crumbs || []).length !== 2) problems.push('下钻后的画布路径层级不正确：' + JSON.stringify(enterInfo.crumbs));
      if ((enterInfo.crumbs || [])[1] !== '新情节点') problems.push('画布路径没有显示当前情节点名称：' + JSON.stringify(enterInfo.crumbs));
      if (enterInfo.nodes !== 0) problems.push('新的子画布应该是空的，实际有 ' + enterInfo.nodes + ' 个情节点');
      if (!String(enterInfo.hint || '').includes('空白子画布')) problems.push('空子画布缺少引导文案');
      if (enterInfo.overlayOpen) problems.push('双击情节点不应再弹出详情框');
      if (pdOpen.childNodes !== 1) problems.push('子画布里新增情节点后数量应为 1，实际 ' + pdOpen.childNodes);
      const deeper = pdOpen.deeper || {};
      if ((deeper.crumbs || []).length !== 3) problems.push('二级下钻后画布路径层级不正确：' + JSON.stringify(deeper.crumbs));
      if (deeper.nodes !== 0) problems.push('二级子画布应该是空的，实际有 ' + deeper.nodes + ' 个情节点');
      const backRoot = pdOpen.backRoot || {};
      if ((backRoot.crumbs || []).length !== 1) problems.push('点面包屑没有回到根画布：' + JSON.stringify(backRoot.crumbs));
      if (backRoot.nodes !== 1) problems.push('回到根画布后情节点数不正确，实际 ' + backRoot.nodes);
      await shot(wc, 'point-drill');

      // 编辑节点信息 + 落盘：详情面板打开弹层，写详细经过 / 人物 → 面板同步 → 子画布结构与字段都能读回
      const pdSave = await wc.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const selectPoint = async () => {
          const hit = document.querySelector('#canvas-svg-root .cv-node-hit');
          if (!hit) return null;
          const r = hit.getBoundingClientRect();
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: x, clientY: y }));
          document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: x, clientY: y }));
          await wait(400);
          return hit;
        };
        await selectPoint();
        const panelText = document.getElementById('canvas-detail-body').textContent;
        const enterBtn = document.getElementById('cv-point-enter');
        const openBtn = document.getElementById('cv-point-open');
        if (!openBtn) return { error: '详情面板缺少「编辑节点信息」按钮', panelText };
        openBtn.click();
        await wait(400);
        const box = document.getElementById('overlay-box');
        const fieldByLabel = (kw) => {
          const lab = [...box.querySelectorAll('.pt-body label')].find((l) => l.textContent.includes(kw));
          return lab ? lab.nextElementSibling : null;
        };
        const modalTitle = box.querySelector('.pt-title') ? box.querySelector('.pt-title').textContent : '';
        const labels = [...box.querySelectorAll('.pt-body label')].map((l) => l.textContent);
        const hasSelect = !!box.querySelector('.pt-body select');
        const optionCount = box.querySelectorAll('.pt-body select option').length;
        const type = '起因：城门将闭。经过：他挤进人群。结果：结识旧识。';
        const ta = box.querySelector('.pt-body textarea');
        if (!ta) return { error: '编辑弹层缺少「详细经过」文本框' };
        ta.value = type;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        const whoEl = fieldByLabel('涉及人物');
        if (whoEl) { whoEl.value = '他、旧识'; whoEl.dispatchEvent(new Event('input', { bubbles: true })); }
        await wait(1500);
        const detailText = document.getElementById('canvas-detail-body').textContent;
        const moreDot = document.querySelectorAll('#canvas-svg-root .cv-node-more').length;
        const done = box.querySelector('.overlay-actions .primary');
        if (done) done.click();
        await wait(250);
        const closed = document.getElementById('overlay').classList.contains('hidden');
        // 关掉画布再打开，双击节点应再次进入子画布，且子画布里的情节点还在
        document.getElementById('canvas-close').click();
        await wait(600);
        document.getElementById('beat-open-canvas').click();
        await wait(900);
        const rootHit = await selectPoint();
        if (rootHit) rootHit.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await wait(700);
        const subNodes = document.querySelectorAll('#canvas-svg-root .cv-node-hit').length;
        const subCrumbs = [...document.querySelectorAll('#cv-crumbs .cv-crumb')].map((b) => b.textContent);
        const back = document.querySelector('#cv-crumbs .cv-crumb');
        if (back) back.click();
        await wait(600);
        // 回到根画布后再核对刚才写的字段
        await selectPoint();
        const btn2 = document.getElementById('cv-point-open');
        if (btn2) btn2.click();
        await wait(400);
        const box2 = document.getElementById('overlay-box');
        const ta2 = box2.querySelector('.pt-body textarea');
        const who2 = (() => {
          const lab = [...box2.querySelectorAll('.pt-body label')].find((l) => l.textContent.includes('涉及人物'));
          return lab ? lab.nextElementSibling : null;
        })();
        const out = {
          panelText, modalTitle, labels, hasSelect, optionCount, detailText, moreDot, closed,
          hasEnterBtn: !!enterBtn,
          subNodes, subCrumbs,
          reopened: !document.getElementById('overlay').classList.contains('hidden'),
          detailBack: ta2 ? ta2.value : '',
          whoBack: who2 ? who2.value : '',
          type
        };
        const done2 = box2.querySelector('.overlay-actions .primary');
        if (done2) done2.click();
        await wait(200);
        document.getElementById('canvas-close').click();
        await wait(600);
        return out;
      })()`);
      console.log('[check] point-edit probe ' + JSON.stringify(pdSave));
      if (pdSave.error) problems.push('情节点编辑：' + pdSave.error);
      if (!pdSave.hasEnterBtn) problems.push('详情面板缺少「进入子画布」按钮');
      if (pdSave.modalTitle !== '编辑节点信息') problems.push('节点信息弹层标题不正确：' + pdSave.modalTitle);
      const pdLabels = (pdSave.labels || []).join('|');
      if (!/详细经过/.test(pdLabels)) problems.push('节点信息弹层缺少「详细经过」字段');
      if (!/涉及人物/.test(pdLabels)) problems.push('节点信息弹层缺少「涉及人物」字段');
      if (!/地点/.test(pdLabels)) problems.push('节点信息弹层缺少「地点」字段');
      if (!/关联章节/.test(pdLabels)) problems.push('节点信息弹层缺少「关联章节」字段');
      if (!pdSave.hasSelect || pdSave.optionCount < 2) problems.push('节点信息弹层缺少「关联章节」下拉选项');
      if (!String(pdSave.detailText || '').includes('起因')) problems.push('写详细经过后右侧详情面板未同步');
      if (pdSave.moreDot < 1) problems.push('写了详细内容后画布节点未出现下钻小点');
      if (!pdSave.closed) problems.push('点「完成」后节点信息弹层未关闭');
      if (pdSave.subNodes !== 1) problems.push('重开画布后子画布里的情节点丢失，实际 ' + pdSave.subNodes);
      if ((pdSave.subCrumbs || []).length !== 2) problems.push('重开画布后下钻路径未恢复：' + JSON.stringify(pdSave.subCrumbs));
      if (!pdSave.reopened) problems.push('重开画布后无法再次打开节点信息弹层');
      if (pdSave.detailBack !== pdSave.type) problems.push('详细经过未落盘 / 读回不一致：' + pdSave.detailBack);
      if (pdSave.whoBack !== '他、旧识') problems.push('涉及人物未落盘 / 读回不一致：' + pdSave.whoBack);
      // 直接读盘：子画布必须跟着根画布一起落盘
      const savedRoot = canvasService.read(seedDir);
      const savedParent = savedRoot.points[0];
      if (!savedParent || !savedParent.sub) problems.push('子画布没有随根画布落盘');
      else {
        if (savedParent.sub.points.length !== 1) problems.push('落盘的子画布里情节点数不正确：' + savedParent.sub.points.length);
        if (savedParent.sub.points[0] && savedParent.sub.points[0].title !== '新情节点') {
          problems.push('落盘的子画布情节点标题不正确：' + savedParent.sub.points[0].title);
        }
      }

      // 界面缩放：Ctrl/⌘ + = / - / 0
      const zoom = await wc.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true, cancelable: true }));
        const toastText = () => (document.getElementById('toast') || {}).textContent || '';
        const label = () => (document.getElementById('zoom-label') || {}).textContent || '';
        const hasCtrl = !!(document.getElementById('zoom-out') && document.getElementById('zoom-in') && document.getElementById('zoom-label'));
        const w0 = window.innerWidth;
        const d0 = window.devicePixelRatio;
        const label0 = label();
        key('='); await wait(250);
        const wUp = window.innerWidth;
        const dUp = window.devicePixelRatio;
        const tUp = toastText();
        const labelUp = label();
        key('='); await wait(250);
        const tUp2 = toastText();
        key('-'); await wait(250);
        const tDown = toastText();
        const labelDown = label();
        document.getElementById('zoom-in').click(); await wait(250);
        const labelBtn = label();
        key('0'); await wait(250);
        const tReset = toastText();
        const labelReset = label();
        const wReset = window.innerWidth;
        const dReset = window.devicePixelRatio;
        return { w0, wUp, wReset, d0, dUp, dReset, tUp, tUp2, tDown, tReset, hasCtrl, label0, labelUp, labelDown, labelBtn, labelReset };
      })()`);
      console.log('[check] ui-zoom probe ' + JSON.stringify(zoom));
      if (!/界面缩放 110%/.test(zoom.tUp)) problems.push('Ctrl+= 未放大界面：' + zoom.tUp);
      if (!/界面缩放 120%/.test(zoom.tUp2)) problems.push('连续 Ctrl+= 未继续放大：' + zoom.tUp2);
      if (!/界面缩放 110%/.test(zoom.tDown)) problems.push('Ctrl+- 未缩小界面：' + zoom.tDown);
      if (!/界面缩放 100%/.test(zoom.tReset)) problems.push('Ctrl+0 未恢复 100%：' + zoom.tReset);
      if (!(zoom.wUp < zoom.w0 || zoom.dUp > zoom.d0)) problems.push('放大后视口未变化（缩放未真正生效）');
      if (!(zoom.wReset > zoom.wUp || zoom.dReset < zoom.dUp)) problems.push('复位后视口没有恢复');
      if (!zoom.hasCtrl) problems.push('状态栏缺少可见的界面缩放控件');
      if (zoom.label0 !== '100%') problems.push('缩放控件初始应显示 100%，实际 ' + zoom.label0);
      if (zoom.labelUp !== '110%') problems.push('放大后缩放控件未同步为 110%，实际 ' + zoom.labelUp);
      if (zoom.labelDown !== '110%') problems.push('缩小后缩放控件未同步为 110%，实际 ' + zoom.labelDown);
      if (zoom.labelBtn !== '120%') problems.push('点击 A+ 未放大到 120%，实际 ' + zoom.labelBtn);
      if (zoom.labelReset !== '100%') problems.push('复位后缩放控件未恢复 100%，实际 ' + zoom.labelReset);

      // 导入 TXT：原生选文件框没法自动化，直接走桥接验证「切章 → 建作品 → 留档」这条链路
      const imp = await wc.executeJavaScript(`(async () => {
        const res = await window.mushu.importTxt({ file: ${JSON.stringify(importTxtPath)}, title: '导入样书', author: '我' });
        if (!res.ok) return { error: res.error };
        const d = res.data;
        return {
          title: d.project.book.title,
          author: d.project.book.author,
          chapters: d.imported.chapters,
          treeChapters: d.tree.chapterCount,
          firstTitle: d.tree.volumes[0] && d.tree.volumes[0].chapters[0] ? d.tree.volumes[0].chapters[0].title : '',
          words: d.imported.words,
          source: d.imported.source,
          skipped: d.imported.skipped
        };
      })()`);
      console.log('[check] import-txt probe ' + JSON.stringify(imp));
      if (imp.error) problems.push('导入 TXT：' + imp.error);
      if (imp.title !== '导入样书' || imp.author !== '我') problems.push('导入 TXT 后书名 / 作者不正确：' + imp.title + ' / ' + imp.author);
      if (imp.chapters !== 2 || imp.treeChapters !== 2) problems.push('导入 TXT 应切出 2 章，实际 ' + imp.chapters + ' / ' + imp.treeChapters);
      if (imp.firstTitle !== '第一章 起风') problems.push('导入 TXT 首章标题不正确：' + imp.firstTitle);
      if (!(imp.words > 0)) problems.push('导入 TXT 字数统计异常：' + imp.words);
      if (!/^source\//.test(String(imp.source || ''))) problems.push('导入 TXT 未在 source/ 下留档原文：' + imp.source);

      // 没有章节标题的样稿必须被挡住，不能瞎切
      const impBad = await wc.executeJavaScript(`(async () => {
        const res = await window.mushu.importTxt({ file: ${JSON.stringify(importBadPath)}, title: '无标题样稿' });
        return { ok: res.ok, error: res.error || '' };
      })()`);
      console.log('[check] import-txt-reject probe ' + JSON.stringify(impBad));
      if (impBad.ok) problems.push('识别不到章节标题时不应导入成功');
      if (!/没有识别到章节标题/.test(impBad.error)) problems.push('无标题样稿的报错文案不对：' + impBad.error);

      // 左侧对话输入框：能正常输入，并支持粘贴图片 / 拖入文件（多模态）
      const aiInput = await wc.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        document.getElementById('tab-ai').click();
        await wait(300);
        const input = document.getElementById('ai-input');
        const composer = document.getElementById('ai-composer');
        if (!input) return { error: '找不到对话输入框' };
        const box = input.getBoundingClientRect();
        input.focus();
        input.value = '测试输入';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const typed = input.value;
        const focused = document.activeElement === input;
        // 模拟粘贴一张 1x1 PNG
        const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        const bin = atob(png);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const file = new File([bytes], 'snap.png', { type: 'image/png' });
        const dt = new DataTransfer();
        dt.items.add(file);
        input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        await wait(900);
        const chips = document.querySelectorAll('#ai-atts .ai-att.image');
        const thumb = document.querySelector('#ai-atts .ai-att img');
        const thumbSrc = thumb ? thumb.getAttribute('src') : '';
        const del = document.querySelector('#ai-atts .ai-att-del');
        if (del) del.click();
        await wait(200);
        const afterRemove = document.querySelectorAll('#ai-atts .ai-att').length;
        const fileInput = document.getElementById('ai-file');
        return {
          height: Math.round(box.height),
          offsetHeight: input.offsetHeight,
          typed,
          focused,
          h: composer.getBoundingClientRect().height,
          chips: chips.length,
          thumbData: /^data:image\\//.test(thumbSrc),
          afterRemove,
          hasFilePicker: !!fileInput && /image/.test(fileInput.getAttribute('accept') || ''),
          hasAttachBtn: !!document.getElementById('ai-attach'),
          placeholder: input.getAttribute('placeholder') || ''
        };
      })()`);
      console.log('[check] ai-input probe ' + JSON.stringify(aiInput));
      if (aiInput.error) problems.push('对话输入：' + aiInput.error);
      else {
        if (aiInput.offsetHeight < 20) problems.push('对话输入框被压扁，无法输入（高度 ' + aiInput.offsetHeight + 'px）');
        if (aiInput.typed !== '测试输入') problems.push('对话输入框无法接收输入');
        if (!aiInput.focused) problems.push('对话输入框无法聚焦');
        if (aiInput.chips !== 1) problems.push('粘贴图片后未生成附件（' + aiInput.chips + '）');
        if (!aiInput.thumbData) problems.push('图片附件没有本地预览');
        if (aiInput.afterRemove !== 0) problems.push('附件移除按钮无效');
        if (!aiInput.hasFilePicker) problems.push('缺少图片 / 文件选择入口');
        if (!aiInput.hasAttachBtn) problems.push('缺少附件按钮');
        if (!/粘贴图片/.test(aiInput.placeholder)) problems.push('输入框提示未说明可粘贴图片');
      }
      await shot(wc, 'ai-composer');

      // 关闭作品：书名旁的 ✕（平时隐形，移入书名才浮现）能退回欢迎页
      const closeProbe = await wc.executeJavaScript(`(async () => {
        const btn = document.getElementById('btn-book-close');
        const hiddenStyle = getComputedStyle(btn).opacity;
        btn.click();
        await new Promise((r) => setTimeout(r, 600));
        return {
          idleOpacity: hiddenStyle,
          welcomeBack: !document.getElementById('welcome').classList.contains('hidden'),
          workspaceGone: document.getElementById('workspace').classList.contains('hidden')
        };
      })()`);
      console.log('[check] book-close probe ' + JSON.stringify(closeProbe));
      if (closeProbe.idleOpacity !== '0') problems.push('关闭作品按钮未做到平时隐形（移入书名才浮现）');
      if (!closeProbe.welcomeBack || !closeProbe.workspaceGone) problems.push('点关闭作品未退回欢迎页');
    } catch (err) {
      problems.push('executeJavaScript 失败: ' + err.message);
    }

    restoreUserData();
    if (problems.length) {
      console.log('\n[check] FAILED\n  - ' + problems.join('\n  - '));
      console.log('截图：' + shots.join(' , '));
      app.exit(1);
    } else {
      console.log('\n[check] STARTUP OK');
      console.log('截图：' + shots.join(' , '));
      app.exit(0);
    }
  });
});

require('../src/main/main.js');
