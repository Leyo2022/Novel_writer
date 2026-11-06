'use strict';

/**
 * 阶段 1 冒烟测试：不依赖 Electron，直接验证全部文件服务。
 * 用法：npm run smoke
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const project = require('../src/main/services/project');
const chapters = require('../src/main/services/chapters');
const versions = require('../src/main/services/versions');
const stats = require('../src/main/services/stats');
const fm = require('../src/main/services/frontmatter');
const canvas = require('../src/main/services/canvas');
const importer = require('../src/main/services/importer');
const { readText } = require('../src/main/services/fsutil');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mushu-smoke-'));
let failed = 0;

function step(name, fn) {
  try {
    fn();
    console.log('  PASS  ' + name);
  } catch (err) {
    failed += 1;
    console.log('  FAIL  ' + name + ' -> ' + err.message);
  }
}

console.log('作品目录：' + dir);

step('创建作品并生成目录结构', () => {
  project.createProject(dir, { title: '测试之书', author: '我' });
  assert.ok(readText(path.join(dir, 'book.json')), 'book.json 未生成');
  assert.ok(fs.existsSync(path.join(dir, 'chapters', 'v001-第一卷')), '默认卷未生成');
  assert.ok(fs.existsSync(path.join(dir, 'bible', 'characters')), '人物目录未生成');
  assert.ok(fs.existsSync(path.join(dir, 'ledger', 'foreshadows.md')), '伏笔台账未生成');
});

step('重复创建同一目录应报错', () => {
  assert.throws(() => project.createProject(dir, {}), /已经是一个作品目录/);
});

step('新建章节', () => {
  const { id } = chapters.createChapter(dir, 'chapters/v001-第一卷', '楔子');
  assert.strictEqual(id, 'chapters/v001-第一卷/0001-楔子.md');
});

let firstSaveWords = 0;
step('保存正文并统计字数', () => {
  const id = 'chapters/v001-第一卷/0001-楔子.md';
  const body = '风起于青萍之末。\n他握紧了拳头。\n';
  const res = chapters.saveChapter(dir, id, { meta: { status: 'draft', pov: '主角' }, body });
  firstSaveWords = res.words;
  assert.strictEqual(res.words, 15, '非空白字符数应为 15，实际 ' + res.words);
  const back = chapters.readChapter(dir, id);
  assert.strictEqual(back.body, body, '正文回读不一致');
  assert.strictEqual(back.meta.pov, '主角', 'front matter 未往返');
});

step('版本快照：相同内容去重', () => {
  const id = 'chapters/v001-第一卷/0001-楔子.md';
  const abs = chapters.fromId(dir, id);
  const text = readText(abs, '');
  const a = versions.snapshot(dir, id, text);
  const b = versions.snapshot(dir, id, text);
  assert.ok(a === null || typeof a === 'string');
  assert.strictEqual(b, null, '相同内容不应重复快照');
});

step('版本列表按时间倒序', () => {
  const id = 'chapters/v001-第一卷/0001-楔子.md';
  const list = versions.list(dir, id);
  assert.ok(list.length >= 1, '至少应有一个版本');
  assert.ok(list[0].at && list[0].words > 0, '版本信息不完整');
});

step('行级 diff 能识别新增与删除', () => {
  const hunks = versions.diffLines('a\nb\nc', 'a\nx\nc');
  const types = hunks.map((h) => h.type).join(',');
  assert.strictEqual(types, 'eq,del,add,eq', '实际：' + types);
});

step('回滚到历史版本（只替换正文，不串入旧 front matter）', () => {
  const id = 'chapters/v001-第一卷/0001-楔子.md';
  const abs = chapters.fromId(dir, id);
  const original = chapters.readChapter(dir, id).body;
  versions.snapshot(dir, id, readText(abs, ''));
  chapters.saveChapter(dir, id, { meta: { status: 'checking' }, body: '改坏了的内容。' });
  versions.snapshot(dir, id, readText(abs, ''));
  const list = versions.list(dir, id);
  const oldest = list[list.length - 1];
  const parsed = fm.split(versions.read(dir, id, oldest.file).text);
  chapters.saveChapter(dir, id, { meta: parsed.meta, body: parsed.body });
  const after = chapters.readChapter(dir, id);
  assert.strictEqual(after.body, original, '回滚后正文不符');
  assert.ok(!after.body.includes('---'), '回滚后正文里不应残留 front matter');
});

step('写作统计记录净增字数', () => {
  const id = 'chapters/v001-第一卷/0001-楔子.md';
  stats.addWords(dir, id, 500);
  const sum = stats.summary(dir);
  assert.strictEqual(sum.today, 500, '今日字数应为 500，实际 ' + sum.today);
  assert.strictEqual(sum.streak, 1, '连续天数应为 1');
  assert.strictEqual(sum.recent.length, 30);
});

step('章节目录树反映结构', () => {
  const t = chapters.tree(dir);
  assert.strictEqual(t.volumes.length, 1);
  assert.strictEqual(t.volumes[0].title, '第一卷');
  assert.strictEqual(t.chapterCount, 1);
  assert.ok(t.totalWords > 0, '总字数应大于 0');
});

step('新建第二卷后排序正确', () => {
  chapters.createVolume(dir, '第二卷');
  chapters.createChapter(dir, 'chapters/v002-第二卷', '新的开始');
  const t = chapters.tree(dir);
  assert.deepStrictEqual(
    t.volumes.map((v) => v.title),
    ['第一卷', '第二卷']
  );
  assert.strictEqual(t.volumes[1].chapters[0].title, '新的开始');
});

step('草稿可保存、读取与清理', () => {
  const id = 'chapters/v001-第一卷/0001-楔子.md';
  chapters.saveDraft(dir, id, { meta: {}, body: '未提交的内容' });
  assert.strictEqual(chapters.loadDraft(dir, id).body, '未提交的内容');
  chapters.clearDraft(dir, id);
  assert.strictEqual(chapters.loadDraft(dir, id), null);
});

step('未保存草稿会被识别为可恢复', () => {
  const id = 'chapters/v001-第一卷/0001-楔子.md';
  chapters.saveDraft(dir, id, { meta: {}, body: '崩溃前的最后一段' });
  assert.ok(chapters.readChapter(dir, id).recoverableDraft, '未识别出可恢复草稿');
  chapters.clearDraft(dir, id);
  assert.strictEqual(chapters.readChapter(dir, id).recoverableDraft, null);
});

step('章节改名：文件、front matter、草稿、版本一起搬', () => {
  const id = 'chapters/v001-第一卷/0001-楔子.md';
  chapters.saveDraft(dir, id, { meta: {}, body: '改名前的草稿' });
  const versionsBefore = versions.list(dir, id).length;
  assert.ok(versionsBefore >= 1, '前置条件：该章节应有版本快照');

  const res = chapters.renameChapter(dir, id, '楔子（改）');
  assert.strictEqual(res.id, 'chapters/v001-第一卷/0001-楔子（改）.md');
  assert.ok(fs.existsSync(chapters.fromId(dir, res.id)), '改名后的文件不存在');
  assert.ok(!fs.existsSync(chapters.fromId(dir, id)), '旧文件没有清掉');
  assert.strictEqual(chapters.readChapter(dir, res.id).meta.title, '楔子（改）', 'front matter 标题未同步');
  assert.strictEqual(chapters.loadDraft(dir, res.id).body, '改名前的草稿', '草稿未随改名迁移');
  assert.strictEqual(versions.list(dir, res.id).length, versionsBefore, '版本快照未随改名迁移');
  chapters.clearDraft(dir, res.id);
});

step('章节名含非法字符会被清理', () => {
  const id = 'chapters/v001-第一卷/0001-楔子（改）.md';
  const res = chapters.renameChapter(dir, id, '楔子: 上/下');
  assert.strictEqual(path.basename(res.id), '0001-楔子 上下.md');
  assert.strictEqual(res.title, '楔子 上下');
  chapters.renameChapter(dir, res.id, '楔子（改）');
});

step('分卷改名：目录换名，卷内章节 id 与历史一起迁移', () => {
  const t0 = chapters.tree(dir);
  const oldPath = t0.volumes[0].path;
  const oldChapterId = t0.volumes[0].chapters[0].id;
  const versionsBefore = versions.list(dir, oldChapterId).length;

  const res = chapters.renameVolume(dir, oldPath, '第一卷·风起');
  assert.strictEqual(res.path, 'chapters/v001-第一卷·风起');
  assert.ok(fs.existsSync(path.join(dir, 'chapters', 'v001-第一卷·风起')), '分卷目录未换名');
  assert.ok(!fs.existsSync(path.join(dir, 'chapters', 'v001-第一卷')), '旧分卷目录仍在');

  const t1 = chapters.tree(dir);
  assert.strictEqual(t1.volumes[0].title, '第一卷·风起');
  assert.strictEqual(t1.volumes[0].chapters.length, t0.volumes[0].chapters.length, '卷内章节数变了');
  const newChapterId = t1.volumes[0].chapters[0].id;
  assert.notStrictEqual(newChapterId, oldChapterId);
  assert.ok(fs.existsSync(chapters.fromId(dir, newChapterId)), '迁移后的章节文件找不到');
  assert.strictEqual(versions.list(dir, newChapterId).length, versionsBefore, '版本快照未随分卷迁移');

  assert.strictEqual(chapters.renameVolume(dir, res.path, '第一卷·风起'), null, '名字没变时不应动手');

  // 序号前缀保留，所以只有同名同序号的目录才会撞车
  fs.mkdirSync(path.join(dir, 'chapters', 'v001-占位'));
  assert.throws(() => chapters.renameVolume(dir, res.path, '占位'), /同名分卷已存在/);
  fs.rmSync(path.join(dir, 'chapters', 'v001-占位'), { recursive: true, force: true });
});

step('书名转文件夹名：清掉非法字符与首尾点号', () => {
  assert.strictEqual(project.safeFolderName('长夜/行:上'), '长夜行上');
  assert.strictEqual(project.safeFolderName('  ..大王饶命..  '), '大王饶命');
  assert.strictEqual(project.safeFolderName(''), '未命名作品');
  assert.strictEqual(project.safeFolderName('   '), '未命名作品');
  assert.ok(project.safeFolderName('长'.repeat(80)).length <= 60, '文件夹名过长未截断');
});

step('同书名自动加 (1) (2)，非空目录也算占用', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mushu-root-'));
  fs.mkdirSync(path.join(root, '长夜行')); // 已存在的普通文件夹同样要避让

  const first = project.resolveProjectDir(root, '长夜行');
  assert.strictEqual(path.basename(first), '长夜行 (1)');
  project.createProject(first, { title: '长夜行' });

  const second = project.resolveProjectDir(root, '长夜行');
  assert.strictEqual(path.basename(second), '长夜行 (2)');
  project.createProject(second, { title: '长夜行' });

  assert.strictEqual(path.basename(project.resolveProjectDir(root, '长夜行')), '长夜行 (3)');
  assert.strictEqual(path.basename(project.resolveProjectDir(root, '另一本书')), '另一本书');
  fs.rmSync(root, { recursive: true, force: true });
});

step('画布关系：归一化 / 同向去重 / 丢弃非法边', () => {
  const n = canvas.normalize({
    cards: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    links: [
      { from: 'a', to: 'b', label: '师徒' },
      { from: 'a', to: 'b', label: '重复' }, // 同向重复：只留第一条
      { from: 'a', to: 'a', label: '自连' }, // 自连：丢弃
      { from: 'ghost', to: 'b', label: '悬空' }, // 悬空引用：丢弃
      { from: 'b', to: 'a', label: '敌对' }, // 反向：保留
    ],
  });
  assert.strictEqual(n.cards.length, 2);
  assert.strictEqual(n.links.length, 2);
  assert.strictEqual(n.links[0].label, '师徒');
  assert.strictEqual(n.links[1].label, '敌对');
  assert.ok(n.links.every((l) => l.id && l.from && l.to), '关系缺少必备字段');
  assert.strictEqual(n.mode, 'story', '未指定模式时应兜底为 story');
  assert.strictEqual(n.cards[0].placed, false, '未标记 placed 的卡片应兜底为 false');
  assert.strictEqual(canvas.normalize({ mode: 'graph' }).mode, 'graph');
  // 图谱圆心 / 层级：非法值一律回落，圆心必须是真实存在的卡片
  assert.strictEqual(canvas.normalize({ cards: [{ id: 'a', name: 'A' }] }).focus, '', '未指定圆心时应为空');
  assert.strictEqual(canvas.normalize({ cards: [{ id: 'a', name: 'A' }] }).depth, 2, '层级默认应为 2');
  assert.strictEqual(
    canvas.normalize({ cards: [{ id: 'a', name: 'A' }], focus: 'ghost' }).focus,
    '',
    '指向不存在卡片的圆心应被丢弃'
  );
  assert.strictEqual(
    canvas.normalize({ cards: [{ id: 'a', name: 'A' }], focus: 'a', depth: 9 }).depth,
    2,
    '越界层级应回落为 2'
  );
  assert.strictEqual(
    canvas.normalize({ cards: [{ id: 'a', name: 'A' }], focus: 'a', depth: 0 }).depth,
    0,
    '层级 0（全部）应被保留'
  );
});

step('画布关系：老文件向后兼容 + 落盘往返', () => {
  // 老 canvas.json 没有 links / mode 字段
  assert.deepStrictEqual(canvas.normalize({ cards: [{ name: 'A' }] }).links, []);
  assert.strictEqual(canvas.normalize({ cards: [{ name: 'A' }] }).mode, 'story');
  assert.deepStrictEqual(canvas.normalize({ cards: [{ name: 'A' }] }).hiddenCats, []);

  // 每次运行用独立临时目录，避免读到上一次的残留文件
  const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mushu-canvas-'));
  // 老情节点只有 title / desc / 坐标，二级页面的新字段应补成空串
  const legacyPoint = canvas.normalize({ points: [{ title: '旧节点', desc: '一句话' }] }).points[0];
  assert.strictEqual(legacyPoint.detail, '');
  assert.strictEqual(legacyPoint.who, '');
  assert.strictEqual(legacyPoint.place, '');
  assert.strictEqual(legacyPoint.chapter, '');

  const clean = canvas.normalize({
    mode: 'graph',
    hiddenCats: ['敌对', '', '敌对'],
    cards: [{ id: 'a', name: 'A', placed: true }, { id: 'b', name: 'B' }],
    links: [{ from: 'a', to: 'b', label: '祖孙' }],
    points: [
      {
        title: '城门将闭',
        desc: '他挤进人群',
        detail: '起因：城门将闭。经过：他挤进人群。结果：结识旧识。',
        who: '他、旧识',
        place: '城门',
        chapter: 'v001-c003',
        x: 120,
        y: 60,
      },
    ],
  });
  canvas.save(cdir, clean);
  const back = canvas.read(cdir);
  assert.strictEqual(back.links.length, 1);
  assert.strictEqual(back.links[0].label, '祖孙');
  assert.strictEqual(back.mode, 'graph');
  assert.deepStrictEqual(back.hiddenCats, ['敌对'], '关掉的关系分类应原样往返，空串与重复项丢弃');
  assert.strictEqual(back.cards[0].placed, true, 'placed 应往返保留');
  assert.strictEqual(back.cards[1].placed, false, '未放置的角色应保持 false');
  assert.strictEqual(back.points[0].detail, '起因：城门将闭。经过：他挤进人群。结果：结识旧识。');
  assert.strictEqual(back.points[0].who, '他、旧识');
  assert.strictEqual(back.points[0].place, '城门');
  assert.strictEqual(back.points[0].chapter, 'v001-c003');

  // 情节点下钻出来的子画布：跟着根画布一起落盘；空子画布不保留，避免空壳越存越多
  const nested = canvas.normalize({
    points: [
      {
        title: '外层',
        sub: {
          cards: [{ id: 'sc', name: '子角色' }],
          points: [{ title: '内层', x: 10, y: 20, sub: { cards: [], points: [], links: [] } }],
          links: [],
        },
      },
      { title: '空壳', sub: { cards: [], points: [], links: [] } },
    ],
  });
  assert.ok(nested.points[0].sub, '有内容的子画布应保留');
  assert.strictEqual(nested.points[0].sub.points[0].title, '内层');
  assert.strictEqual(nested.points[0].sub.points[0].sub, undefined, '空的孙级画布应被丢弃');
  assert.strictEqual(nested.points[1].sub, undefined, '空的子画布应被丢弃');
  canvas.save(cdir, nested);
  const backNested = canvas.read(cdir);
  assert.strictEqual(backNested.points[0].sub.cards[0].name, '子角色');
  assert.strictEqual(backNested.points[0].sub.points[0].title, '内层', '子画布应随根画布原样往返');
  assert.strictEqual(backNested.points[0].sub.points[0].x, 10);
  fs.rmSync(cdir, { recursive: true, force: true });
});

step('章节出场扫描：命中计数 / 别名不重复计数 / 无命中章节被过滤', () => {
  const adir = fs.mkdtempSync(path.join(os.tmpdir(), 'mushu-appear-'));
  project.createProject(adir, { title: '出场测试' });
  const vol = 'chapters/v001-第一卷';
  const c1 = chapters.createChapter(adir, vol, '初遇');
  chapters.saveChapter(adir, c1.id, { meta: {}, body: '江晚棠来了。\n' });
  const c2 = chapters.createChapter(adir, vol, '独行');
  chapters.saveChapter(adir, c2.id, { meta: {}, body: '晚棠独自站着。\n' });
  const c3 = chapters.createChapter(adir, vol, '闲笔');
  chapters.saveChapter(adir, c3.id, { meta: {}, body: '风起于青萍之末。\n' });

  const rows = chapters.appearances(adir, ['江晚棠', '晚棠']);
  assert.strictEqual(rows.length, 2, '应只保留有命中的两章，实际 ' + rows.length);
  assert.strictEqual(rows[0].title, '初遇');
  assert.strictEqual(rows[0].count, 1, '别名是名字的子串，不应重复计数，实际 ' + rows[0].count);
  assert.strictEqual(rows[0].at, 0, '首个命中位置应为 0');
  assert.strictEqual(rows[0].term, '江晚棠', '命中的应是更长的角色名');
  assert.strictEqual(rows[1].title, '独行');
  assert.strictEqual(rows[1].count, 1);
  assert.deepStrictEqual(chapters.appearances(adir, []), [], '没有关键词时应返回空数组');
  assert.deepStrictEqual(chapters.appearances(adir, ['   ']), [], '空白关键词应被过滤');
  fs.rmSync(adir, { recursive: true, force: true });
});

step('TXT 编码识别：UTF-8（含 BOM）与 GBK 回落', () => {
  const utf8 = Buffer.from('第一章 风起\n正文。\n', 'utf8');
  assert.strictEqual(importer.decode(utf8), '第一章 风起\n正文。\n', 'UTF-8 解码不正确');
  assert.strictEqual(importer.decode(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8])), '第一章 风起\n正文。\n', 'BOM 未剥掉');
  // 「你好」的 GBK 字节，按 UTF-8 解会失败，必须回落到 GBK
  assert.strictEqual(importer.decode(Buffer.from([0xc4, 0xe3, 0xba, 0xc3])), '你好', 'GBK 回落失败');
  assert.strictEqual(importer.decode(Buffer.alloc(0)), '', '空文件应解出空串');
});

step('TXT 切章：按章标题切分 / 无标题不猜', () => {
  const text = '书名：测试\n作者：某人\n\n第一章 风起\n正文一。\n\n第二章 云涌\n正文二。\n';
  const res = importer.splitChapters(text);
  assert.strictEqual(res.chapters.length, 2);
  assert.strictEqual(res.chapters[0].title, '第一章 风起');
  assert.strictEqual(res.chapters[0].body, '正文一。');
  assert.strictEqual(res.chapters[1].title, '第二章 云涌');
  assert.strictEqual(res.chapters[1].body, '正文二。');
  assert.strictEqual(res.skipped, 10, '首个标题之前的书名 / 作者应被记为忽略字数，实际 ' + res.skipped);

  // 「第X卷」只当分隔行丢掉，不单独成章；Chapter N 也要认
  const mixed = importer.splitChapters('第一卷 少年游\n第一章 拜师\n正文。\nChapter 2\n英文正文。\n');
  assert.strictEqual(mixed.chapters.length, 2, '卷标题不应被当成一章');
  assert.strictEqual(mixed.chapters[0].body, '正文。');

  assert.deepStrictEqual(importer.splitChapters('通篇没有章节标题的正文。\n第二行。').chapters, [], '识别不到标题时不应瞎切');
});

step('TXT 导入：建作品 / 切章落盘 / 原文留档', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mushu-import-root-'));
  const txt = path.join(root, '乱世刀.txt');
  fs.writeFileSync(txt, '# 乱世刀\n\n第一章 入城\n城门在他身后合拢。\n\n第二章 旧识\n三月的雨落在瓦上。\n', 'utf8');

  const out = importer.importTxt({ file: txt, title: '乱世刀', author: '我', root });
  assert.strictEqual(path.basename(out.project.dir), '乱世刀', '作品目录未按书名创建');
  assert.strictEqual(out.project.book.author, '我');
  assert.strictEqual(out.imported.chapters, 2);
  assert.strictEqual(out.tree.chapterCount, 2, '章节树应有 2 章');
  assert.strictEqual(out.tree.volumes[0].chapters[0].title, '第一章 入城');
  assert.ok(fs.existsSync(path.join(out.project.dir, 'source', '乱世刀.txt')), '原文未留档到 source/');
  const read = chapters.readChapter(out.project.dir, out.tree.volumes[0].chapters[1].id);
  assert.strictEqual(read.body, '三月的雨落在瓦上。\n', '正文未按章落盘');
  assert.ok(out.imported.words > 0, '导入字数应大于 0');

  // 再导入同一本书：重名自动加序号，不覆盖
  const again = importer.importTxt({ file: txt, title: '乱世刀', author: '', root });
  assert.strictEqual(path.basename(again.project.dir), '乱世刀 (1)');

  const noHead = path.join(root, '无标题.txt');
  fs.writeFileSync(noHead, '这里没有章节标题。\n', 'utf8');
  assert.throws(() => importer.importTxt({ file: noHead, title: '无标题', root }), /没有识别到章节标题/);
  assert.throws(() => importer.importTxt({ file: path.join(root, '不存在.txt'), root }), /文件不存在/);
  fs.rmSync(root, { recursive: true, force: true });
});

step('AI 多模态：带图消息自动切视觉模型', () => {
  const ai = require('../src/main/services/ai');
  assert.strictEqual(ai.pickModel([{ role: 'user', content: '你好' }]), ai.MODEL);
  assert.strictEqual(
    ai.pickModel([
      {
        role: 'user',
        content: [
          { type: 'text', text: '看看这张图' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ]),
    ai.VISION_MODEL
  );
});

console.log(failed === 0 ? '\n全部通过。' : `\n失败 ${failed} 项。`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
