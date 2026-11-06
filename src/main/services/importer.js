'use strict';

/**
 * TXT 小说导入：识别编码 → 按章节标题切分 → 建作品并逐章落盘。
 * 章节标题识别不到时直接报错，不做猜测性切分（避免把正文切碎）。
 */

const path = require('path');
const fs = require('fs');
const { ensureDir, safeFileName, countWords } = require('./fsutil');
const project = require('./project');
const chapters = require('./chapters');

const DEFAULT_VOLUME = 'chapters/v001-第一卷';
const SOURCE_DIR = 'source';

// 章节标题：第X章 / 第X回 / 第X节 / 第X篇，序号可阿拉伯数字或中文数字
const CHAPTER_HEAD_RE = /^第\s*[0-9零一二三四五六七八九十百千万〇两壹贰叁肆伍陆柒捌玖拾佰仟]+\s*[章回节篇](?![0-9])/;
// 少量英文文本用 Chapter 3 这类标题
const CHAPTER_ALT_RE = /^(?:chapter|chap\.?)\s*[0-9ivxlcdm]+/i;
// 卷标题只作为分隔行丢掉，不当成一章
const VOLUME_HEAD_RE = /^第\s*[0-9零一二三四五六七八九十百千万〇两]+\s*卷/;

/** 章节标题行不能太长，否则多半是正文里恰好以「第X章」开头 */
const HEAD_MAX_LEN = 40;

function isChapterHead(line) {
  const t = line.trim();
  if (!t || t.length > HEAD_MAX_LEN) return false;
  return CHAPTER_HEAD_RE.test(t) || CHAPTER_ALT_RE.test(t);
}

/**
 * 解码 TXT：BOM 优先，其次按 UTF-8 严格解码，失败再回落 GBK（老网文常见）。
 */
function decode(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buf.subarray(3));
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString('utf16le').replace(/^\uFEFF/, '');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('gbk').decode(buf);
  }
}

/**
 * 按章节标题切分。返回 { chapters: [{ title, body }], skipped }。
 * skipped 是首个章节标题之前被丢弃的字数（通常是书名 / 作者 / 简介）。
 */
function splitChapters(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  const heads = [];
  lines.forEach((line, i) => {
    if (isChapterHead(line)) heads.push(i);
  });
  if (!heads.length) return { chapters: [], skipped: countWords(lines.join('\n')) };

  const out = [];
  for (let i = 0; i < heads.length; i += 1) {
    const start = heads[i];
    const end = i + 1 < heads.length ? heads[i + 1] : lines.length;
    const title = safeFileName(lines[start].trim(), `第${i + 1}章`);
    const body = lines
      .slice(start + 1, end)
      .filter((line) => !VOLUME_HEAD_RE.test(line.trim()))
      .join('\n')
      .trim();
    out.push({ title, body });
  }
  return { chapters: out, skipped: countWords(lines.slice(0, heads[0]).join('\n')) };
}

/**
 * 导入一本 TXT：在 root 下按书名建作品，原文留档到 source/，逐章写进第一卷。
 * 返回 { project, tree, imported }。
 */
function importTxt({ file, title, author, root } = {}) {
  const abs = String(file || '').trim();
  if (!abs) throw new Error('没有选择 TXT 文件');
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error('文件不存在：' + abs);
  if (!root) throw new Error('还没有设置默认作品目录，请先在「设置」里指定');

  let buffer;
  try {
    buffer = fs.readFileSync(abs);
  } catch (err) {
    throw new Error('读取文件失败：' + err.message);
  }

  const { chapters: list, skipped } = splitChapters(decode(buffer));
  if (!list.length) {
    throw new Error('没有识别到章节标题（如「第一章 楔子」），无法自动切章。请先在 TXT 里加上章节标题再导入。');
  }

  const fallbackTitle = path.basename(abs, path.extname(abs));
  const bookTitle = String(title || '').trim() || fallbackTitle || '未命名作品';
  const dir = project.resolveProjectDir(root, bookTitle);
  const { book } = project.createProject(dir, { title: bookTitle, author });

  // 原文按字节原样留档，方便之后重新切章或校对
  const sourceName = safeFileName(path.basename(abs), '原文.txt');
  ensureDir(path.join(dir, SOURCE_DIR));
  fs.copyFileSync(abs, path.join(dir, SOURCE_DIR, sourceName));

  let words = 0;
  for (const item of list) {
    const created = chapters.createChapter(dir, DEFAULT_VOLUME, item.title);
    const saved = chapters.saveChapter(dir, created.id, { meta: { status: 'draft' }, body: item.body ? item.body + '\n' : '' });
    words += saved.words;
  }

  return {
    project: { dir, book },
    tree: chapters.tree(dir),
    imported: {
      dir,
      chapters: list.length,
      words,
      skipped,
      file: abs,
      source: `${SOURCE_DIR}/${sourceName}`,
    },
  };
}

module.exports = { decode, splitChapters, importTxt, DEFAULT_VOLUME, SOURCE_DIR };
