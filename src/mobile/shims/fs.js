'use strict';

/**
 * 浏览器端内存文件系统（同步 API）。
 *
 * 墨枢的数据层（chapters / versions / stats / project / importer …）是围绕 node:fs
 * 的同步调用写的。iPad 上没有 node，这里提供一个同样签名的内存实现：
 *   - 启动时由 storage 层把本地文件灌进来；
 *   - 运行期所有读写都在内存完成，保证服务层代码零改动；
 *   - 每次变更通过 changeHook 通知 storage 层异步落盘。
 */

const path = require('./path');

const EPOCH = Date.UTC(2020, 0, 1);

/** @type {Map<string, {type:'file'|'dir', data:string, mtime:number}>} */
const nodes = new Map();
nodes.set('/', { type: 'dir', data: '', mtime: Date.now() });

let changeHook = null;

function setChangeHook(fn) {
  changeHook = typeof fn === 'function' ? fn : null;
}

function emit(p, kind) {
  if (changeHook) {
    try {
      changeHook(p, kind);
    } catch {
      /* 落盘层异常不能影响业务读写 */
    }
  }
}

function enoent(p) {
  const err = new Error(`ENOENT: no such file or directory, '${p}'`);
  err.code = 'ENOENT';
  return err;
}

function enotdir(p) {
  const err = new Error(`ENOTDIR: not a directory, '${p}'`);
  err.code = 'ENOTDIR';
  return err;
}

function normalize(p) {
  return path.normalize(String(p == null ? '' : p));
}

function parentOf(p) {
  return path.dirname(normalize(p));
}

function ensureParents(p) {
  const parts = normalize(p).split('/').filter(Boolean);
  let cur = '';
  for (let i = 0; i < parts.length - 1; i += 1) {
    cur += '/' + parts[i];
    const node = nodes.get(cur);
    if (!node) {
      nodes.set(cur, { type: 'dir', data: '', mtime: Date.now() });
      // 父目录也要落盘：否则空分卷这类空目录重启后会消失
      emit(cur, 'dir');
    } else if (node.type !== 'dir') throw enotdir(cur);
  }
}

function existsSync(p) {
  return nodes.has(normalize(p));
}

function statSync(p) {
  const key = normalize(p);
  const node = nodes.get(key);
  if (!node) throw enoent(key);
  const mtime = new Date(node.mtime);
  return {
    size: node.type === 'file' ? new TextEncoder().encode(node.data).length : 0,
    mtime,
    mtimeMs: node.mtime,
    ctime: mtime,
    birthtime: mtime,
    isFile: () => node.type === 'file',
    isDirectory: () => node.type === 'dir',
  };
}

function lstatSync(p) {
  return statSync(p);
}

function encodeUtf8(text) {
  return new TextEncoder().encode(String(text == null ? '' : text));
}

function readFileSync(p, encoding) {
  const key = normalize(p);
  const node = nodes.get(key);
  if (!node || node.type !== 'file') throw enoent(key);
  if (encoding) {
    if (String(encoding).toLowerCase().replace('-', '') === 'utf8') return node.data;
    return node.data;
  }
  return makeBuffer(encodeUtf8(node.data));
}

function writeFileSync(p, data, encoding) {
  const key = normalize(p);
  ensureParents(key);
  const text = typeof data === 'string' ? data : decodeBytes(data);
  nodes.set(key, { type: 'file', data: text, mtime: Date.now() });
  emit(key, 'put');
}

function decodeBytes(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (data.bytes) return new TextDecoder('utf-8').decode(new Uint8Array(data.bytes));
  if (data instanceof Uint8Array) return new TextDecoder('utf-8').decode(data);
  if (data instanceof ArrayBuffer) return new TextDecoder('utf-8').decode(new Uint8Array(data));
  return String(data);
}

function mkdirSync(p, options) {
  const recursive = options && options.recursive;
  const key = normalize(p);
  if (key === '/') return;
  if (nodes.has(key)) {
    if (nodes.get(key).type !== 'dir') {
      const err = new Error(`EEXIST: file already exists, '${key}'`);
      err.code = 'EEXIST';
      throw err;
    }
    return;
  }
  if (recursive) {
    ensureParents(key);
    nodes.set(key, { type: 'dir', data: '', mtime: Date.now() });
    emit(key, 'dir');
    return;
  }
  const parent = parentOf(key);
  if (!nodes.has(parent)) throw enoent(parent);
  nodes.set(key, { type: 'dir', data: '', mtime: Date.now() });
  emit(key, 'dir');
}

function readdirSync(p, options) {
  const key = normalize(p);
  const node = nodes.get(key);
  if (!node) throw enoent(key);
  if (node.type !== 'dir') throw enotdir(key);
  const prefix = key === '/' ? '/' : key + '/';
  const names = [];
  for (const k of nodes.keys()) {
    if (k === key || !k.startsWith(prefix)) continue;
    const rest = k.slice(prefix.length);
    if (!rest || rest.includes('/')) continue;
    names.push({ name: rest, key: k });
  }
  names.sort((a, b) => a.name.localeCompare(b.name));
  if (options && options.withFileTypes) {
    return names.map(({ name, key: full }) => {
      const child = nodes.get(full);
      return {
        name,
        isFile: () => child.type === 'file',
        isDirectory: () => child.type === 'dir',
        isSymbolicLink: () => false,
      };
    });
  }
  return names.map((n) => n.name);
}

function renameSync(from, to) {
  const src = normalize(from);
  const dst = normalize(to);
  const node = nodes.get(src);
  if (!node) throw enoent(src);
  if (src === dst) return;
  ensureParents(dst);
  const old = nodes.get(dst);
  if (old && old.type === 'dir' && node.type === 'file') {
    const err = new Error(`EISDIR: illegal operation on a directory, rename '${src}'`);
    err.code = 'EISDIR';
    throw err;
  }
  if (old && old.type === 'file' && node.type === 'dir') {
    const err = new Error(`ENOTDIR: not a directory, rename '${dst}'`);
    err.code = 'ENOTDIR';
    throw err;
  }
  if (node.type === 'file') {
    nodes.delete(src);
    nodes.set(dst, node);
    emit(src, 'delete');
    emit(dst, 'put');
    return;
  }
  // 目录：整棵子树一起搬走
  const prefix = src === '/' ? '/' : src + '/';
  const moved = [];
  for (const k of [...nodes.keys()]) {
    if (k !== src && !k.startsWith(prefix)) continue;
    moved.push([k, nodes.get(k)]);
  }
  for (const [k] of moved) nodes.delete(k);
  for (const [k, value] of moved) {
    const next = dst + k.slice(src.length);
    nodes.set(next, value);
    emit(next, value.type === 'file' ? 'put' : 'dir');
  }
  emit(src, 'delete');
}

function unlinkSync(p) {
  const key = normalize(p);
  const node = nodes.get(key);
  if (!node) throw enoent(key);
  if (node.type === 'dir') {
    const err = new Error(`EISDIR: illegal operation on a directory, unlink '${key}'`);
    err.code = 'EISDIR';
    throw err;
  }
  nodes.delete(key);
  emit(key, 'delete');
}

function rmdirSync(p) {
  const key = normalize(p);
  const node = nodes.get(key);
  if (!node) throw enoent(key);
  if (node.type !== 'dir') throw enotdir(key);
  const prefix = key === '/' ? '/' : key + '/';
  for (const k of nodes.keys()) {
    if (k !== key && k.startsWith(prefix)) {
      const err = new Error(`ENOTEMPTY: directory not empty, rmdir '${key}'`);
      err.code = 'ENOTEMPTY';
      throw err;
    }
  }
  nodes.delete(key);
  emit(key, 'delete');
}

function rmSync(p, options) {
  const key = normalize(p);
  if (!nodes.has(key)) {
    if (options && options.force) return;
    throw enoent(key);
  }
  const prefix = key === '/' ? '/' : key + '/';
  for (const k of [...nodes.keys()]) {
    if (k === key || k.startsWith(prefix)) nodes.delete(k);
  }
  emit(key, 'delete');
}

function copyFileSync(from, to) {
  const src = normalize(from);
  const node = nodes.get(src);
  if (!node || node.type !== 'file') throw enoent(src);
  const dst = normalize(to);
  ensureParents(dst);
  nodes.set(dst, { type: 'file', data: node.data, mtime: Date.now() });
  emit(dst, 'put');
}

function utimesSync(p, atime, mtime) {
  const key = normalize(p);
  const node = nodes.get(key);
  if (!node) throw enoent(key);
  const t = Number(mtime);
  node.mtime = Number.isFinite(t) ? (t > 1e12 ? t : t * 1000) : Date.now();
  if (node.type === 'file') emit(key, 'put');
}

/** ---------- Buffer 兼容层（importer 的 TXT 解码会用到） ---------- */

class Buf extends Uint8Array {
  static isBuffer(value) {
    return value instanceof Buf;
  }

  static from(value) {
    if (typeof value === 'string') return new Buf(encodeUtf8(value));
    if (value instanceof Uint8Array) return new Buf(value);
    if (value instanceof ArrayBuffer) return new Buf(new Uint8Array(value));
    return new Buf(0);
  }

  subarray(begin, end) {
    return new Buf(super.subarray(begin, end));
  }

  toString(encoding) {
    const enc = String(encoding || 'utf8').toLowerCase();
    if (enc === 'utf16le' || enc === 'ucs2' || enc === 'utf-16le') {
      const view = new Uint8Array(this);
      let out = '';
      for (let i = 0; i + 1 < view.length; i += 2) out += String.fromCharCode(view[i] | (view[i + 1] << 8));
      return out;
    }
    return new TextDecoder('utf-8').decode(this);
  }
}

function makeBuffer(bytes) {
  return new Buf(bytes);
}

function installBuffer() {
  if (!globalThis.Buffer) globalThis.Buffer = Buf;
}

/** ---------- 启动装载 / 持久化遍历 ---------- */

function loadEntries(entries) {
  nodes.clear();
  nodes.set('/', { type: 'dir', data: '', mtime: Date.now() });
  const list = (entries || []).map((item) => ({ ...item, path: normalize(item.path) })).sort((a, b) => a.path.length - b.path.length);
  for (const item of list) {
    const key = item.path;
    if (!key || key === '/') continue;
    // 浏览器后端只存文件，这里补齐所有父目录，保证 readdirSync / existsSync 可用
    ensureParents(key);
    if (item.type === 'dir') {
      nodes.set(key, { type: 'dir', data: '', mtime: item.mtime || Date.now() });
    } else {
      nodes.set(key, { type: 'file', data: String(item.data == null ? '' : item.data), mtime: item.mtime || Date.now() });
    }
  }
}

function* allEntries() {
  for (const [key, node] of nodes) {
    if (key === '/') continue;
    yield { path: key, type: node.type, data: node.data, mtime: node.mtime };
  }
}

function getNode(p) {
  return nodes.get(normalize(p)) || null;
}

module.exports = {
  // node:fs 兼容接口
  existsSync,
  statSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
  rmdirSync,
  rmSync,
  copyFileSync,
  utimesSync,
  constants: { F_OK: 0 },
  // 内部接口
  setChangeHook,
  loadEntries,
  allEntries,
  getNode,
  installBuffer,
  Buf,
};
