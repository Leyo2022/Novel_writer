'use strict';

const path = require('path');
const fs = require('fs');
const { ensureDir, readText, writeTextAtomic, listDir, exists, countWords, safeFileName } = require('./fsutil');
const fm = require('./frontmatter');
const versions = require('./versions');

const CHAPTERS_DIR = 'chapters';
const DRAFTS_DIR = path.join('.mushu', 'drafts');

const VOLUME_RE = /^v(\d{3,})-(.+)$/;
const CHAPTER_RE = /^(\d{4,})-(.+)\.md$/;

const pad = (n, len) => String(n).padStart(len, '0');

/** 作品内的相对路径统一用 / 分隔，作为章节 id */
function toId(rel) {
  return rel.split(path.sep).join('/');
}

function fromId(dir, id) {
  return path.join(dir, ...id.split('/'));
}

function chaptersRoot(dir) {
  return path.join(dir, CHAPTERS_DIR);
}

function draftPath(dir, id) {
  return path.join(dir, DRAFTS_DIR, `${id.replace(/[\\/]/g, '__')}.json`);
}

/** 扫描作品目录，返回分卷 + 章节树（顺序由数字前缀决定，不依赖任何索引文件） */
function tree(dir) {
  const root = chaptersRoot(dir);
  const volumes = listDir(root)
    .filter((e) => e.isDirectory() && VOLUME_RE.test(e.name))
    .map((e) => {
      const m = e.name.match(VOLUME_RE);
      const volAbs = path.join(root, e.name);
      const chapters = listDir(volAbs)
        .filter((c) => c.isFile() && CHAPTER_RE.test(c.name))
        .map((c) => {
          const cm = c.name.match(CHAPTER_RE);
          const rel = toId(path.join(CHAPTERS_DIR, e.name, c.name));
          const raw = readText(path.join(volAbs, c.name), '');
          const { meta, body } = fm.split(raw);
          return {
            id: rel,
            index: Number(cm[1]),
            title: meta.title || cm[2],
            status: meta.status || 'draft',
            words: meta.words != null ? Number(meta.words) || 0 : countWords(body),
          };
        })
        .sort((a, b) => a.index - b.index);
      return {
        path: toId(path.join(CHAPTERS_DIR, e.name)),
        name: e.name,
        index: Number(m[1]),
        title: m[2],
        words: chapters.reduce((s, c) => s + c.words, 0),
        chapters,
      };
    })
    .sort((a, b) => a.index - b.index);

  return {
    volumes,
    totalWords: volumes.reduce((s, v) => s + v.words, 0),
    chapterCount: volumes.reduce((s, v) => s + v.chapters.length, 0),
  };
}

function readChapter(dir, id) {
  const abs = fromId(dir, id);
  const raw = readText(abs);
  if (raw === null) throw new Error('章节不存在：' + id);
  const { meta, body } = fm.split(raw);
  const draft = loadDraft(dir, id);
  const stat = fs.statSync(abs);
  return {
    id,
    meta: { id, status: 'draft', ...meta },
    body,
    words: countWords(body),
    updatedAt: stat.mtime.toISOString(),
    // 草稿比正文文件新，说明上次是异常退出，存在未提交内容
    recoverableDraft: draft && draft.body !== body ? draft : null,
  };
}

function saveChapter(dir, id, { meta = {}, body = '' } = {}) {
  const abs = fromId(dir, id);
  const prevRaw = readText(abs, '');
  const prev = fm.split(prevRaw);
  const prevWords = countWords(prev.body);

  const now = new Date().toISOString();
  const nextMeta = {
    ...prev.meta,
    ...meta,
    id,
    words: countWords(body),
    created: prev.meta.created || now,
    updated: now,
  };
  writeTextAtomic(abs, fm.serialize(nextMeta, body));
  clearDraft(dir, id);

  return { id, meta: nextMeta, words: nextMeta.words, prevWords, delta: nextMeta.words - prevWords, savedAt: now };
}

function nextIndex(names, re) {
  let max = 0;
  for (const name of names) {
    const m = name.match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

function createVolume(dir, title = '新卷') {
  const root = chaptersRoot(dir);
  ensureDir(root);
  const index = nextIndex(listDir(root).map((e) => e.name), VOLUME_RE);
  const name = `v${pad(index, 3)}-${title}`;
  ensureDir(path.join(root, name));
  return { path: toId(path.join(CHAPTERS_DIR, name)), name, index, title };
}

function createChapter(dir, volumePath, title = '新章节') {
  const volAbs = path.join(dir, ...volumePath.split('/'));
  ensureDir(volAbs);
  const index = nextIndex(listDir(volAbs).map((e) => e.name), CHAPTER_RE);
  const fileName = `${pad(index, 4)}-${title}.md`;
  const id = toId(path.join(volumePath, fileName));
  const now = new Date().toISOString();
  const meta = { id, title, status: 'draft', words: 0, pov: '', characters: [], foreshadows: [], created: now, updated: now };
  writeTextAtomic(path.join(volAbs, fileName), fm.serialize(meta, ''));
  return { id, meta, body: '', words: 0 };
}

// ---------- 重命名 ----------

/** 改名后把草稿一起搬走，否则崩溃恢复会跟丢 */
function migrateDrafts(dir, oldId, newId) {
  if (oldId === newId) return;
  const abs = path.join(dir, DRAFTS_DIR);
  const oldKey = oldId.replace(/[\\/]/g, '__');
  const newKey = newId.replace(/[\\/]/g, '__');
  for (const e of listDir(abs).filter((x) => x.isFile() && x.name.startsWith(oldKey))) {
    try {
      fs.renameSync(path.join(abs, e.name), path.join(abs, newKey + e.name.slice(oldKey.length)));
    } catch {
      /* 单个草稿搬不动不影响改名本身 */
    }
  }
}

function migrateArtifacts(dir, oldId, newId) {
  versions.migrate(dir, oldId, newId);
  migrateDrafts(dir, oldId, newId);
}

/** 重命名分卷：目录名一变，卷内所有章节 id 都跟着变 */
function renameVolume(dir, volumePath, title) {
  const root = chaptersRoot(dir);
  const oldName = path.basename(volumePath);
  const m = oldName.match(VOLUME_RE);
  if (!m) throw new Error('不是有效的分卷：' + oldName);

  const clean = safeFileName(title, '新卷');
  if (clean === m[2]) return null;

  const newName = `v${pad(Number(m[1]), 3)}-${clean}`;
  const newPath = toId(path.join(CHAPTERS_DIR, newName));
  if (exists(path.join(root, newName))) throw new Error('同名分卷已存在：' + clean);

  // 版本快照和草稿都是按「章节 id」平铺存的，所以要在改名前记下卷内每个章节的老 id
  const oldPath = toId(path.join(CHAPTERS_DIR, oldName));
  const chapterIds = listDir(path.join(root, oldName))
    .filter((c) => c.isFile() && CHAPTER_RE.test(c.name))
    .map((c) => toId(path.join(oldPath, c.name)));

  fs.renameSync(path.join(root, oldName), path.join(root, newName));
  for (const oldId of chapterIds) {
    migrateArtifacts(dir, oldId, newPath + oldId.slice(oldPath.length));
  }
  return { path: newPath, name: newName, index: Number(m[1]), title: clean };
}

/** 重命名章节：文件名和 front matter 里的 title 一起改 */
function renameChapter(dir, id, title) {
  const oldAbs = fromId(dir, id);
  const raw = readText(oldAbs);
  if (raw === null) throw new Error('章节不存在：' + id);

  const oldName = path.basename(id);
  const m = oldName.match(CHAPTER_RE);
  if (!m) throw new Error('不是有效的章节文件：' + oldName);

  const clean = safeFileName(title, '未命名章节');
  const newName = `${pad(Number(m[1]), 4)}-${clean}.md`;
  const newId = toId(path.join(path.dirname(id), newName));

  if (newName !== oldName) {
    if (exists(fromId(dir, newId))) throw new Error('同名章节已存在：' + clean);
    fs.renameSync(oldAbs, fromId(dir, newId));
    migrateArtifacts(dir, id, newId);
  }

  const { meta, body } = fm.split(raw);
  const nextMeta = { ...meta, id: newId, title: clean, updated: new Date().toISOString() };
  writeTextAtomic(fromId(dir, newId), fm.serialize(nextMeta, body));
  return { id: newId, title: clean, meta: nextMeta, words: countWords(body) };
}

// ---------- 崩溃恢复草稿 ----------

function saveDraft(dir, id, { meta, body }) {
  writeTextAtomic(draftPath(dir, id), JSON.stringify({ id, meta, body, at: new Date().toISOString() }));
}

function loadDraft(dir, id) {
  const raw = readText(draftPath(dir, id));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clearDraft(dir, id) {
  const p = draftPath(dir, id);
  if (exists(p)) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* 忽略：草稿清理失败不影响主流程 */
    }
  }
}

/**
 * 目录树搜索：先匹配章节名，再扫正文。
 * 返回 { chapters, hits, truncated }，hits 里带行号与上下文片段，供右栏直接渲染。
 */
function search(dir, query, limit = { chapters: 50, hits: 80 }) {
  const q = String(query == null ? '' : query).trim();
  const out = { chapters: [], hits: [], truncated: false };
  if (!q) return out;

  const needle = q.toLowerCase();
  for (const vol of tree(dir).volumes) {
    for (const ch of vol.chapters) {
      if (ch.title.toLowerCase().includes(needle)) {
        if (out.chapters.length < limit.chapters) {
          out.chapters.push({ id: ch.id, title: ch.title, volume: vol.title, index: ch.index });
        } else {
          out.truncated = true;
        }
      }
      if (out.hits.length >= limit.hits) {
        out.truncated = true;
        continue;
      }
      const lines = fm.split(readText(fromId(dir, ch.id), '')).body.split('\n');
      let offset = 0;
      for (let i = 0; i < lines.length; i += 1) {
        const col = lines[i].toLowerCase().indexOf(needle);
        if (col >= 0) {
          out.hits.push({
            id: ch.id,
            title: ch.title,
            line: i + 1,
            at: offset + col, // 正文里的字符位置，点一下就能把光标定位过去
            text: lines[i].trim().slice(0, 120),
          });
          if (out.hits.length >= limit.hits) {
            out.truncated = true;
            break;
          }
        }
        offset += lines[i].length + 1;
      }
    }
  }
  return out;
}

/**
 * 角色出场扫描：在一部作品的全部章节正文里统计若干关键词（角色名 + 别名）的出现情况。
 * terms 按长度倒序合成单个全局正则，避免「江晚棠」里的「晚棠」被重复计数。
 * 返回 [{ id, title, volume, index, count, at, term }]，按目录顺序，只保留命中的章节。
 */
function appearances(dir, terms) {
  const list = [...new Set((Array.isArray(terms) ? terms : []).map((t) => String(t == null ? '' : t).trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  if (!list.length) return [];
  const re = new RegExp(list.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  const out = [];
  for (const vol of tree(dir).volumes) {
    for (const ch of vol.chapters) {
      const body = fm.split(readText(fromId(dir, ch.id), '')).body;
      re.lastIndex = 0;
      let m = re.exec(body);
      if (!m) continue;
      const at = m.index;
      const term = m[0]; // 首个命中词
      let count = 0;
      while (m) {
        count += 1;
        m = re.exec(body);
      }
      out.push({ id: ch.id, title: ch.title, volume: vol.title, index: ch.index, count, at, term });
    }
  }
  return out;
}

module.exports = {
  tree,
  search,
  appearances,
  readChapter,
  saveChapter,
  createVolume,
  createChapter,
  renameVolume,
  renameChapter,
  saveDraft,
  loadDraft,
  clearDraft,
  fromId,
  CHAPTERS_DIR,
};
