'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function exists(p) {
  return fs.existsSync(p);
}

function readText(file, fallback = null) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

/** 原子写入：先写临时文件再 rename，避免半截文件。统一使用 \n 换行。 */
function writeTextAtomic(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text.replace(/\r\n/g, '\n'), 'utf8');
  fs.renameSync(tmp, file);
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function sha1(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** 网文字数口径：非空白字符数 */
function countWords(text) {
  if (!text) return 0;
  return text.replace(/\s/g, '').length;
}

/** 本地日期 YYYY-MM-DD */
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 标题 → 安全的文件/文件夹名（去掉文件系统不认的字符，避免首尾的点和空格） */
function safeFileName(title, fallback = '未命名') {
  const cleaned = String(title || '')
    .replace(/[\\/:*?"<>|]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, 60)
    .trim();
  return cleaned || fallback;
}

module.exports = {
  ensureDir,
  exists,
  readText,
  writeTextAtomic,
  listDir,
  sha1,
  mtime,
  countWords,
  localDate,
  safeFileName,
};
