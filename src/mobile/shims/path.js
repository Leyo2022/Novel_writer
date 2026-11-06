'use strict';

/**
 * path 的浏览器实现（只覆盖墨枢服务层用到的 POSIX 能力）。
 * 桌面端用的是 node:path，这里保持同名 API，避免服务层代码改动。
 */

const sep = '/';

function slashes(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/');
}

function normalize(input) {
  const p = slashes(input);
  const abs = p.startsWith('/');
  const out = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!abs) out.push('..');
      continue;
    }
    out.push(seg);
  }
  let s = out.join('/');
  if (abs) s = '/' + s;
  if (!s) s = abs ? '/' : '.';
  return s;
}

function join(...parts) {
  const list = parts.filter((p) => p != null && p !== '');
  return normalize(list.length ? list.join('/') : '.');
}

function resolve(...parts) {
  const list = parts.filter((p) => p != null && p !== '');
  const p = list.length ? list.join('/') : '/';
  return normalize(p.startsWith('/') ? p : '/' + p);
}

function dirname(p) {
  const s = normalize(p);
  if (s === '/') return '/';
  const i = s.lastIndexOf('/');
  if (i < 0) return '.';
  if (i === 0) return '/';
  return s.slice(0, i);
}

function basename(p, ext) {
  const s = normalize(p);
  const name = s.slice(s.lastIndexOf('/') + 1);
  if (!name) return '';
  if (ext && name.endsWith(ext) && name.length > ext.length) return name.slice(0, -ext.length);
  return name;
}

function extname(p) {
  const name = basename(p);
  const i = name.lastIndexOf('.');
  if (i <= 0) return '';
  return name.slice(i);
}

function isAbsolute(p) {
  return slashes(p).startsWith('/');
}

function split(p) {
  return normalize(p).split('/').filter(Boolean);
}

function relative(from, to) {
  const a = split(resolve(from));
  const b = split(resolve(to));
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

module.exports = {
  sep,
  delimiter: ':',
  normalize,
  join,
  resolve,
  dirname,
  basename,
  extname,
  isAbsolute,
  relative,
};
