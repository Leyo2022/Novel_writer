'use strict';

const path = require('path');
const { readText, writeTextAtomic } = require('./fsutil');

const CAST_REL = path.join('bible', 'cast.json');

function castPath(dir) {
  return path.join(dir, CAST_REL);
}

/** 规范化一组词条：名称去空且唯一，别名去空去重且不等于名称 */
function normalizeList(list) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const name = String((item && item.name) || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const aliases = [];
    const aliasSeen = new Set();
    for (const a of Array.isArray(item && item.aliases) ? item.aliases : []) {
      const s = String(a || '').trim();
      if (s && s !== name && !aliasSeen.has(s)) {
        aliasSeen.add(s);
        aliases.push(s);
      }
    }
    out.push({ name, aliases, desc: String((item && item.desc) || '') });
  }
  return out;
}

function normalize(data) {
  return {
    characters: normalizeList(data && data.characters),
    settings: normalizeList(data && data.settings),
  };
}

function read(dir) {
  const raw = readText(castPath(dir));
  if (!raw) return { characters: [], settings: [] };
  try {
    return normalize(JSON.parse(raw));
  } catch {
    return { characters: [], settings: [] };
  }
}

function save(dir, data) {
  const clean = normalize(data);
  writeTextAtomic(castPath(dir), JSON.stringify(clean, null, 2) + '\n');
  return clean;
}

module.exports = { read, save, castPath };
