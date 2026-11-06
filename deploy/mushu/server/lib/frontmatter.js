'use strict';

/**
 * 极简 YAML front matter 解析/序列化。
 * 只支持本项目用到的形态：标量、行内数组 [a, b]、以及紧跟键名的 `- item` 列表。
 * 目的：不引入任何依赖，且文件对人类始终可读可手改。
 */

function unquote(v) {
  const s = String(v).trim();
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function quoteIfNeeded(v) {
  const s = String(v);
  if (s === '') return '""';
  if (/[:#[\]"'{}]/.test(s) || s !== s.trim()) return JSON.stringify(s);
  return s;
}

function parse(head) {
  const meta = {};
  let listKey = null;
  for (const rawLine of head.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;

    const item = line.match(/^\s+-\s*(.*)$/);
    if (item && listKey) {
      meta[listKey].push(unquote(item[1]));
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim();

    if (value === '') {
      listKey = key;
      meta[key] = [];
    } else if (value.startsWith('[') && value.endsWith(']')) {
      listKey = null;
      meta[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s))
        .filter((s) => s !== '');
    } else {
      listKey = null;
      meta[key] = unquote(value);
    }
  }
  return meta;
}

const KEY_ORDER = ['id', 'title', 'status', 'words', 'pov', 'characters', 'foreshadows', 'created', 'updated'];

function serialize(meta, body) {
  const keys = [...KEY_ORDER.filter((k) => k in meta), ...Object.keys(meta).filter((k) => !KEY_ORDER.includes(k))];
  const lines = ['---'];
  for (const key of keys) {
    const value = meta[key];
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => quoteIfNeeded(v)).join(', ')}]`);
    } else {
      lines.push(`${key}: ${quoteIfNeeded(value == null ? '' : value)}`);
    }
  }
  lines.push('---', '');
  return `${lines.join('\n')}${body || ''}`;
}

/** 从整篇文本中拆出 meta 与 body */
function split(text) {
  const src = (text || '').replace(/\r\n/g, '\n');
  if (src.slice(0, 3) !== '---') return { meta: {}, body: src };
  const end = src.indexOf('\n---', 3);
  if (end === -1) return { meta: {}, body: src };
  const head = src.slice(3, end).replace(/^\n/, '');
  let body = src.slice(end + 4);
  if (body.startsWith('\n')) body = body.slice(1);
  return { meta: parse(head), body };
}

module.exports = { split, serialize, parse };
