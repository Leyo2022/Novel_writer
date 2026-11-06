'use strict';

const path = require('path');
const { readText, writeTextAtomic, localDate } = require('./fsutil');

const STATS_REL = path.join('.mushu', 'stats.json');

function statsPath(dir) {
  return path.join(dir, STATS_REL);
}

function load(dir) {
  const raw = readText(statsPath(dir));
  if (!raw) return { schema: 1, total: 0, days: {}, lastChapter: null };
  try {
    const data = JSON.parse(raw);
    return { schema: 1, total: 0, days: {}, lastChapter: null, ...data };
  } catch {
    return { schema: 1, total: 0, days: {}, lastChapter: null };
  }
}

function save(dir, data) {
  writeTextAtomic(statsPath(dir), JSON.stringify(data, null, 2) + '\n');
}

/**
 * 记录一次保存带来的净增字数。
 * delta <= 0（删改、回滚）不扣减，避免"改稿越多产量越低"的负数感。
 */
function addWords(dir, chapterId, delta) {
  const data = load(dir);
  const today = localDate();
  if (delta > 0) {
    data.days[today] = (data.days[today] || 0) + delta;
    data.total += delta;
  }
  data.lastChapter = { id: chapterId, at: new Date().toISOString() };
  save(dir, data);
  return data;
}

function streak(days) {
  const keys = Object.keys(days).filter((k) => days[k] > 0).sort();
  if (!keys.length) return 0;
  const oneDay = 86400000;
  const toTime = (k) => new Date(k + 'T00:00:00').getTime();
  const today = toTime(localDate());
  let cursor = toTime(keys[keys.length - 1]);
  // 允许"今天还没写"：从昨天开始算
  if (cursor < today - oneDay) return 0;
  let n = 0;
  while (days[localDate(new Date(cursor))] > 0) {
    n += 1;
    cursor -= oneDay;
  }
  return n;
}

function summary(dir, recentDays = 30) {
  const data = load(dir);
  const today = localDate();
  const list = [];
  const oneDay = 86400000;
  const base = new Date(today + 'T00:00:00').getTime();
  for (let i = recentDays - 1; i >= 0; i -= 1) {
    const d = localDate(new Date(base - i * oneDay));
    list.push({ date: d, words: data.days[d] || 0 });
  }
  return {
    today: data.days[today] || 0,
    total: data.total || 0,
    streak: streak(data.days),
    lastChapter: data.lastChapter || null,
    recent: list,
  };
}

module.exports = { load, save, addWords, summary, statsPath };
