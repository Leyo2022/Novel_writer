'use strict';

const path = require('path');
const fs = require('fs');
const { ensureDir, readText, writeTextAtomic, safeFileName } = require('./fsutil');

const BOOK_FILE = 'book.json';

/**
 * 作品目录结构（文件即数据源，脱离本应用也能读）：
 *   <作品目录>/
 *     book.json                  作品级信息
 *     chapters/v001-第一卷/0001-楔子.md
 *     bible/characters/*.md      人物档案（一人一文件）
 *     bible/world/*.md           世界观（一主题一文件）
 *     bible/timeline.md
 *     bible/terms.md             术语表
 *     bible/outline.md           故事大纲
 *     ledger/foreshadows.md      伏笔台账
 *     .mushu/versions/           版本快照
 *     .mushu/drafts/             崩溃恢复草稿
 *     .mushu/stats.json          写作统计
 */
const DIRS = [
  'chapters/v001-第一卷',
  'bible/characters',
  'bible/world',
  'ledger',
  '.mushu/versions',
  '.mushu/drafts',
];

function bookPath(dir) {
  return path.join(dir, BOOK_FILE);
}

/** 书名 → 安全的文件夹名 */
function safeFolderName(title) {
  return safeFileName(title, '未命名作品');
}

/** 在 root 下按书名分配目录，重名时自动追加 (1) (2) … */
function resolveProjectDir(root, title) {
  const base = safeFolderName(title);
  let dir = path.join(root, base);
  for (let i = 1; fs.existsSync(dir); i += 1) dir = path.join(root, `${base} (${i})`);
  return dir;
}

function createProject(dir, { title, author } = {}) {
  if (readText(bookPath(dir)) !== null) {
    throw new Error('该目录已经是一个作品目录（存在 book.json），请改用「打开作品」。');
  }
  ensureDir(dir);
  DIRS.forEach((d) => ensureDir(path.join(dir, d)));

  const now = new Date().toISOString();
  const book = {
    schema: 1,
    title: title || '未命名作品',
    author: author || '',
    createdAt: now,
    updatedAt: now,
  };
  writeTextAtomic(bookPath(dir), JSON.stringify(book, null, 2) + '\n');

  writeTextAtomic(path.join(dir, 'bible', 'timeline.md'), '# 时间线\n\n');
  writeTextAtomic(path.join(dir, 'bible', 'terms.md'), '# 术语表\n\n');
  writeTextAtomic(path.join(dir, 'bible', 'outline.md'), '# 故事大纲\n\n');
  writeTextAtomic(path.join(dir, 'ledger', 'foreshadows.md'), '# 伏笔台账\n\n');

  return { dir, book };
}

function openProject(dir) {
  const raw = readText(bookPath(dir));
  if (raw === null) {
    throw new Error('不是有效的作品目录：缺少 book.json');
  }
  let book;
  try {
    book = JSON.parse(raw);
  } catch (err) {
    throw new Error('book.json 解析失败：' + err.message);
  }
  return { dir, book };
}

function updateBook(dir, patch) {
  const raw = readText(bookPath(dir));
  if (raw === null) throw new Error('作品不存在：' + dir);
  const book = { ...JSON.parse(raw), ...patch, updatedAt: new Date().toISOString() };
  writeTextAtomic(bookPath(dir), JSON.stringify(book, null, 2) + '\n');
  return book;
}

module.exports = { BOOK_FILE, createProject, openProject, updateBook, bookPath, safeFolderName, resolveProjectDir };
