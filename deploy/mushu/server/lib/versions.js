'use strict';

const path = require('path');
const fs = require('fs');
const { ensureDir, exists, readText, writeTextAtomic, listDir, sha1, countWords, mtime, safeFileName } = require('./fsutil');

const VERSIONS_DIR = path.join('.mushu', 'versions');
const KEEP_PER_CHAPTER = 100;
const BACKUP_STATE = path.join('.mushu', 'backup-state.json');

/**
 * 版本快照的存放根目录由设置注入（默认在「文档/墨枢备份」），
 * 注入函数返回空表示退回「作品内 .mushu/versions」的老位置。
 */
let rootResolver = null;
function setRootResolver(fn) {
  rootResolver = fn;
}

function backupRoot() {
  const r = rootResolver ? rootResolver() : null;
  return r || null;
}

/** 作品目录 → 备份根下的唯一键（路径哈希 + 目录名，便于人眼识别） */
function projectKey(dir) {
  const abs = path.resolve(dir);
  return `${sha1(abs).slice(0, 10)}-${safeFileName(path.basename(abs), 'project')}`;
}

function versionBase(dir) {
  const root = backupRoot();
  return root ? path.join(root, projectKey(dir), 'versions') : path.join(dir, VERSIONS_DIR);
}

function versionDir(dir, id) {
  ensureLegacyMigrated(dir);
  return path.join(versionBase(dir), id.replace(/[\\/]/g, '__'));
}

function listFiles(dir, id) {
  const abs = versionDir(dir, id);
  return listDir(abs)
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort();
}

/**
 * 为一次保存生成快照。
 * 内容与最近一次快照一致时跳过（去重）；每个章节只保留最近 KEEP_PER_CHAPTER 个。
 */
function snapshot(dir, id, text) {
  const abs = versionDir(dir, id);
  ensureDir(abs);
  const files = listFiles(dir, id);
  const hash = sha1(text);
  const latest = files[files.length - 1];
  if (latest && latest.includes(hash.slice(0, 8))) return null;

  const ts = new Date();
  const stamp = [
    ts.getFullYear(),
    String(ts.getMonth() + 1).padStart(2, '0'),
    String(ts.getDate()).padStart(2, '0'),
  ].join('') + '-' + [
    String(ts.getHours()).padStart(2, '0'),
    String(ts.getMinutes()).padStart(2, '0'),
    String(ts.getSeconds()).padStart(2, '0'),
  ].join('') + '-' + String(ts.getMilliseconds()).padStart(3, '0');

  const fileName = `${stamp}-${hash.slice(0, 8)}.md`;
  writeTextAtomic(path.join(abs, fileName), text);

  const all = listFiles(dir, id);
  if (all.length > KEEP_PER_CHAPTER) {
    for (const old of all.slice(0, all.length - KEEP_PER_CHAPTER)) {
      try {
        fs.unlinkSync(path.join(abs, old));
      } catch {
        /* 忽略 */
      }
    }
  }
  return fileName;
}

function list(dir, id) {
  const abs = versionDir(dir, id);
  return listFiles(dir, id)
    .map((name) => {
      const p = path.join(abs, name);
      const text = readText(p, '');
      const [datePart, timePart] = name.split('-');
      const iso =
        `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}` +
        `T${timePart.slice(0, 2)}:${timePart.slice(2, 4)}:${timePart.slice(4, 6)}`;
      return {
        file: name,
        at: iso,
        words: countWords(text),
        size: text.length,
        mtime: mtime(p),
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function read(dir, id, file) {
  const abs = path.join(versionDir(dir, id), path.basename(file));
  const text = readText(abs);
  if (text === null) throw new Error('版本不存在：' + file);
  return { file, text, words: countWords(text) };
}

/** 章节/分卷改名后，把版本快照目录一起搬走，否则历史会跟丢 */
function migrate(dir, oldId, newId) {
  if (oldId === newId) return false;
  const from = versionDir(dir, oldId);
  const to = versionDir(dir, newId);
  if (!fs.existsSync(from) || fs.existsSync(to)) return false;
  fs.renameSync(from, to);
  return true;
}

// ---------- 备份根迁移 ----------

/** 递归统计目录内的文件数与总字节，用于迁移后的完整性校验 */
function statTree(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const e of listDir(d)) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        files += 1;
        try {
          bytes += fs.statSync(p).size;
        } catch {
          /* 忽略统计失败的单个文件 */
        }
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return { files, bytes };
}

function copyTree(src, dst) {
  ensureDir(dst);
  for (const e of listDir(src)) {
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(from, to);
    else {
      ensureDir(path.dirname(to));
      fs.copyFileSync(from, to);
    }
  }
}

/** 移动目录：优先 rename，跨盘或失败时「先复制校验再删源」，校验不通过则不删源 */
function moveTree(src, dst) {
  if (!fs.existsSync(src)) return;
  ensureDir(path.dirname(dst));
  try {
    fs.renameSync(src, dst);
    return;
  } catch {
    /* 跨设备或被占用：退回复制 */
  }
  const before = statTree(src);
  copyTree(src, dst);
  const after = statTree(dst);
  if (after.files >= before.files && after.bytes >= before.bytes) {
    fs.rmSync(src, { recursive: true, force: true });
  } else {
    throw new Error('备份迁移校验失败，已保留原目录：' + src);
  }
}

/** 把 src 的内容并入 dst（同名保留目标，避免覆盖），完成后清理空的 src */
function mergeMove(src, dst) {
  if (!fs.existsSync(dst)) {
    moveTree(src, dst);
    return;
  }
  for (const e of listDir(src)) {
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (!fs.existsSync(to)) moveTree(from, to);
    else if (e.isDirectory()) mergeMove(from, to);
  }
  try {
    if (fs.existsSync(src) && !listDir(src).length) fs.rmdirSync(src);
  } catch {
    /* 目录非空或占用则忽略 */
  }
}

/** 设置里改了备份根后，把旧根内容搬到新根 */
function migrateBackupRoot(oldRoot, newRoot) {
  if (!oldRoot || !newRoot) return false;
  if (path.resolve(oldRoot) === path.resolve(newRoot)) return false;
  if (!fs.existsSync(oldRoot)) return false;
  mergeMove(oldRoot, newRoot);
  return true;
}

/** 老版本快照放在作品内，首次使用新根时把它们搬过去，保证历史不丢 */
const legacyChecked = new Set();
function ensureLegacyMigrated(dir) {
  if (legacyChecked.has(dir)) return false;
  const root = backupRoot();
  if (!root) return false; // 备份根还没准备好，下次再试（此时不能记为已检查）
  legacyChecked.add(dir);
  const legacy = path.join(dir, VERSIONS_DIR);
  if (!fs.existsSync(legacy)) return false;
  const target = versionBase(dir);
  if (fs.existsSync(target) && listDir(target).length) return false;
  try {
    mergeMove(legacy, target);
  } catch {
    return false;
  }
  return true;
}

// ---------- 快照阈值（每 N 字保存一次本地历史版本） ----------

function backupStatePath(dir) {
  return path.join(dir, BACKUP_STATE);
}

function loadBackupState(dir) {
  try {
    return JSON.parse(readText(backupStatePath(dir), '{}')) || {};
  } catch {
    return {};
  }
}

function saveBackupState(dir, st) {
  writeTextAtomic(backupStatePath(dir), JSON.stringify(st, null, 2) + '\n');
}

/**
 * 记录一次保存净增的字数，达到阈值时返回 true（需要生成快照）。
 * threshold 为 0 / 空表示每次都存。
 */
function noteSave(dir, delta, threshold) {
  const st = loadBackupState(dir);
  const pending = (Number(st.pending) || 0) + Math.max(0, Number(delta) || 0);
  if (!threshold || pending >= Number(threshold)) {
    if (st.pending) {
      st.pending = 0;
      saveBackupState(dir, st);
    }
    return true;
  }
  st.pending = pending;
  saveBackupState(dir, st);
  return false;
}

/** 强制下次保存时生成快照（如「立即备份」） */
function resetPending(dir) {
  const st = loadBackupState(dir);
  if (st.pending) {
    st.pending = 0;
    saveBackupState(dir, st);
  }
}

// ---------- 逐行对比 ----------

/** 基于 LCS 的行级 diff，返回 [{type:'eq'|'add'|'del', text}] */
function diffLines(before, after) {
  const A = (before || '').split('\n');
  const B = (after || '').split('\n');
  const n = A.length;
  const m = B.length;
  if (n * m > 4_000_000) {
    return [{ type: 'info', text: '内容过大，已跳过逐行对比' }];
  }
  const W = m + 1;
  const dp = new Uint32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * W + j] = A[i] === B[j] ? dp[(i + 1) * W + (j + 1)] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + (j + 1)]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ type: 'eq', text: A[i] });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * W + j] >= dp[i * W + (j + 1)]) {
      out.push({ type: 'del', text: A[i] });
      i += 1;
    } else {
      out.push({ type: 'add', text: B[j] });
      j += 1;
    }
  }
  while (i < n) out.push({ type: 'del', text: A[i++] });
  while (j < m) out.push({ type: 'add', text: B[j++] });
  return out;
}

module.exports = {
  snapshot,
  list,
  read,
  diffLines,
  versionDir,
  versionBase,
  migrate,
  setRootResolver,
  projectKey,
  migrateBackupRoot,
  ensureLegacyMigrated,
  noteSave,
  resetPending,
  statTree,
};
