'use strict';

/**
 * iPad 端数据层自检：在内存虚拟文件系统上跑一遍「建作品 → 建卷 → 建章 → 写正文 → 重启重载」，
 * 验证复用桌面端服务模块后行为与桌面一致。由 scripts/check-mobile.js 打包执行。
 */

const fs = require('fs');
const path = require('path');

const project = require('../src/main/services/project');
const chapters = require('../src/main/services/chapters');

function assert(cond, message) {
  if (!cond) throw new Error('断言失败：' + message);
}

fs.loadEntries([]);
const root = '/mushu/works';
fs.mkdirSync(root, { recursive: true });

const dir = path.join(root, '测试作品');
const { book } = project.createProject(dir, { title: '测试作品' });
assert(book.title === '测试作品', 'book.json 写入');

const tree0 = chapters.tree(dir);
if (!tree0.volumes.length) chapters.createVolume(dir, '第一卷');
const tree1 = chapters.tree(dir);
assert(tree1.volumes.length >= 1, '分卷可见');
assert(typeof tree1.volumes[0].path === 'string' && tree1.volumes[0].path.includes('/'), '分卷带 path');

const volumePath = tree1.volumes[tree1.volumes.length - 1].path;
const chapter = chapters.createChapter(dir, volumePath, '第一章');
assert(chapter.id.includes('第一章'), '章节 id 生成');

const saved = chapters.saveChapter(dir, chapter.id, {
  meta: { ...chapter.meta, title: '第一章' },
  body: '第一段测试正文',
});
assert(saved.words === 7, '字数统计');

// 模拟 App 重启：把内存节点重新装载一遍
const snapshot = [...fs.allEntries()];
fs.loadEntries(snapshot);

assert(fs.existsSync(dir), '重载后作品目录存在');
assert(fs.readdirSync(root).includes('测试作品'), '重载后作品可枚举');
const tree2 = chapters.tree(dir);
assert(tree2.volumes.length === 1, '重载后分卷仍在');
assert(tree2.volumes[0].chapters.length === 1, '重载后章节仍在');
const reloaded = chapters.readChapter(dir, chapter.id);
assert(reloaded.body.includes('第一段测试正文'), '重载后正文仍在');

console.log('[mobile-selftest] 通过：', JSON.stringify({ volumes: tree2.volumes.length, chapters: tree2.chapters, words: reloaded.words }));
