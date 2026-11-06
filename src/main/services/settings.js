'use strict';

const { readText, writeTextAtomic } = require('./fsutil');

/**
 * 极简设置存储：单个 JSON 文件，读取时与默认值合并。
 * 与具体 Electron 路径解耦，默认值由调用方注入。
 */
function createStore(file, defaults) {
  function load() {
    const base = defaults();
    const raw = readText(file);
    if (!raw) return { ...base };
    try {
      const parsed = JSON.parse(raw);
      return { ...base, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
    } catch {
      return { ...base };
    }
  }

  function save(patch) {
    const next = { ...load(), ...(patch || {}) };
    writeTextAtomic(file, JSON.stringify(next, null, 2) + '\n');
    return next;
  }

  return { load, save };
}

module.exports = { createStore };
