'use strict';

/**
 * 本地持久化层。
 *
 * iOS（Capacitor Filesystem）：文件真实落在 App 沙盒里，重启/升级都不丢；
 * 浏览器（Windows 调试）：没有原生桥，退回 IndexedDB，行为一致。
 *
 * 上层只看到 loadAll() / 变更通知 / flush()，不关心底层是哪种。
 */

const fs = require('./shims/fs');
const native = require('./native');

const ROOT = 'mushu';
const MANIFEST = `${ROOT}/.vfs-manifest.json`;

function nativeFs() {
  if (!native.isNative()) return null;
  return native.filesystem();
}

function nativePath(p) {
  return ROOT + (p.startsWith('/') ? p : '/' + p);
}

// ---------------- Capacitor Filesystem 后端 ----------------

async function nativeLoad(FS) {
  let manifest = {};
  try {
    const res = await FS.readFile({ path: MANIFEST, directory: 'DATA', encoding: 'utf8' });
    const parsed = JSON.parse(res.data || '{}');
    manifest = (parsed && parsed.files) || {};
  } catch {
    manifest = {};
  }

  const out = [];
  const walk = async (rel) => {
    let entries = [];
    try {
      const res = await FS.readdir({ path: rel ? `${ROOT}/${rel}` : ROOT, directory: 'DATA' });
      entries = res.files || [];
    } catch {
      return;
    }
    for (const raw of entries) {
      const name = typeof raw === 'string' ? raw : raw.name;
      if (!name) continue;
      const childRel = rel ? `${rel}/${name}` : name;
      const abs = `${ROOT}/${childRel}`;
      let info = null;
      try {
        info = await FS.stat({ path: abs, directory: 'DATA' });
      } catch {
        continue;
      }
      if (info.type === 'directory') {
        // 空分卷等空目录也要还原，否则目录树刷新后会缺卷
        out.push({ path: '/' + childRel, type: 'dir' });
        await walk(childRel);
        continue;
      }
      if (childRel === '.vfs-manifest.json') continue;
      try {
        const file = await FS.readFile({ path: abs, directory: 'DATA', encoding: 'utf8' });
        const p = '/' + childRel;
        out.push({ path: p, type: 'file', data: String(file.data == null ? '' : file.data), mtime: manifest[p] || Number(info.mtime) || Date.now() });
      } catch {
        /* 单个文件读失败不影响整体启动 */
      }
    }
  };

  try {
    await FS.mkdir({ path: ROOT, directory: 'DATA', recursive: true });
  } catch {
    /* 已存在 */
  }
  await walk('');
  return out;
}

async function nativeApply(FS, ops) {
  for (const [p, kind] of ops) {
    const target = nativePath(p);
    if (kind === 'put') {
      const node = fs.getNode(p);
      if (!node) continue;
      if (node.type === 'dir') {
        try {
          await FS.mkdir({ path: target, directory: 'DATA', recursive: true });
        } catch {
          /* 忽略 */
        }
        continue;
      }
      await FS.writeFile({ path: target, data: node.data, directory: 'DATA', encoding: 'utf8', recursive: true });
    } else {
      try {
        await FS.deleteFile({ path: target, directory: 'DATA' });
      } catch {
        try {
          await FS.rmdir({ path: target, directory: 'DATA', recursive: true });
        } catch {
          /* 本来就不存在 */
        }
      }
    }
  }
  // 记录 mtime：VFS 重启后仍能保持与服务器同步的判定依据
  const files = {};
  for (const entry of fs.allEntries()) {
    if (entry.type === 'file') files[entry.path] = entry.mtime;
  }
  try {
    await FS.writeFile({ path: MANIFEST, data: JSON.stringify({ version: 1, files }), directory: 'DATA', encoding: 'utf8', recursive: true });
  } catch {
    /* 清单写失败不影响正文 */
  }
}

// ---------------- IndexedDB 后端（浏览器调试） ----------------

const DB_NAME = 'mushu-vfs';
const STORE = 'files';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'path' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
  });
}

async function idbLoad() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error || new Error('IndexedDB 读取失败'));
  });
}

async function idbApply(ops) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const [p, kind] of ops) {
      if (kind === 'put') {
        const node = fs.getNode(p);
        if (!node) continue;
        if (node.type === 'dir') store.put({ path: p, type: 'dir', mtime: node.mtime });
        else store.put({ path: p, type: 'file', data: node.data, mtime: node.mtime });
      } else {
        store.delete(p);
      }
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB 写入失败'));
  });
}

// ---------------- 对外接口 ----------------

let backend = null; // { load, apply }
let dirty = new Map();
let timer = null;
let flushing = null;
let onFlush = null;

function setFlushListener(fn) {
  onFlush = typeof fn === 'function' ? fn : null;
}

async function loadAll() {
  const FS = nativeFs();
  if (FS) {
    backend = { load: () => nativeLoad(FS), apply: (ops) => nativeApply(FS, ops) };
    return backend.load();
  }
  backend = { load: idbLoad, apply: idbApply };
  return backend.load();
}

function mark(p, kind) {
  // 临时文件不落盘：writeTextAtomic 写完会立刻 rename 掉
  if (/\.tmp-\d+-\d+$/.test(p)) {
    if (kind === 'delete') {
      dirty.delete(p);
    }
    return;
  }
  if (kind === 'put' || kind === 'dir') dirty.set(p, 'put');
  else dirty.set(p, 'delete');
  schedule();
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flush().catch(() => {
      /* 下一轮再试 */
    });
  }, 250);
}

async function flush() {
  if (flushing) return flushing;
  flushing = (async () => {
    while (dirty.size) {
      const ops = [];
      for (const [p, kind] of dirty) ops.push([p, kind]);
      dirty = new Map();
      if (backend) await backend.apply(ops);
      if (onFlush) onFlush(ops);
    }
  })();
  try {
    await flushing;
  } finally {
    flushing = null;
  }
}

/** 立即把待写内容落盘（切后台 / 退出前调用） */
async function flushNow() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await flush();
}

module.exports = { loadAll, mark, flush, flushNow, setFlushListener };
