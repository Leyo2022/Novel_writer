'use strict';

const path = require('path');
const { readText, writeTextAtomic } = require('./fsutil');

const CANVAS_REL = path.join('bible', 'canvas.json');

function canvasPath(dir) {
  return path.join(dir, CANVAS_REL);
}

let seq = 0;
function newId(prefix) {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v) {
  return String(v == null ? '' : v);
}

/** 角色卡片：名称必填，别名去重且不等于名称 */
function normalizeCard(raw) {
  const name = str(raw && raw.name).trim();
  if (!name) return null;
  const aliases = [];
  for (const a of Array.isArray(raw && raw.aliases) ? raw.aliases : []) {
    const s = str(a).trim();
    if (s && s !== name && !aliases.includes(s)) aliases.push(s);
  }
  return {
    id: str(raw && raw.id).trim() || newId('card'),
    name,
    aliases,
    desc: str(raw && raw.desc),
    x: num(raw && raw.x, 0),
    y: num(raw && raw.y, 0),
    // 是否已摆到画布上：卡片本体是「角色库」，未放置的不出现在故事线/图谱里
    placed: raw && raw.placed === true,
  };
}

/** 情节点：标题必填，坐标即世界坐标（y 越高代表情绪越高扬） */
function normalizePoint(raw) {
  const title = str(raw && raw.title).trim();
  if (!title) return null;
  return {
    id: str(raw && raw.id).trim() || newId('beat'),
    title,
    desc: str(raw && raw.desc),
    x: num(raw && raw.x, 0),
    y: num(raw && raw.y, 0),
  };
}

/** 关系连线：两端卡片必须存在、不可自连；label 允许为空 */
function normalizeLink(raw, cardIds) {
  const from = str(raw && raw.from).trim();
  const to = str(raw && raw.to).trim();
  if (!from || !to || from === to) return null;
  if (cardIds && (!cardIds.has(from) || !cardIds.has(to))) return null; // 悬空引用直接丢弃
  return {
    id: str(raw && raw.id).trim() || newId('link'),
    from,
    to,
    label: str(raw && raw.label).trim(),
  };
}

function normalize(data) {
  const vp = (data && data.viewport) || {};
  const cards = (Array.isArray(data && data.cards) ? data.cards : []).map(normalizeCard).filter(Boolean);
  const ids = new Set(cards.map((c) => c.id));
  // 关系依赖卡片 id，先算 cards 再算 links；同向重复只保留第一条
  const links = [];
  const seen = new Set();
  for (const raw of Array.isArray(data && data.links) ? data.links : []) {
    const l = normalizeLink(raw, ids);
    if (!l) continue;
    const key = l.from + '>' + l.to;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(l);
  }
  // 知识图谱的圆心与展开层级：圆心必须是已存在的卡片，否则回落到「由前端自动选主角度」
  const focus = str(data && data.focus).trim();
  const rawDepth = num(data && data.depth, 2);
  return {
    schema: 1,
    mode: data && data.mode === 'graph' ? 'graph' : 'story',
    viewport: {
      x: num(vp.x, 0),
      y: num(vp.y, 0),
      zoom: Math.min(3, Math.max(0.2, num(vp.zoom, 1))),
    },
    focus: ids.has(focus) ? focus : '',
    depth: [0, 1, 2, 3].includes(rawDepth) ? rawDepth : 2,
    cards,
    points: (Array.isArray(data && data.points) ? data.points : []).map(normalizePoint).filter(Boolean),
    links,
  };
}

/** 读取画布；文件不存在时返回空画布并标记 fresh，供前端首次进入时自动「适应窗口」 */
function read(dir) {
  const raw = readText(canvasPath(dir));
  if (raw === null) return { ...normalize({}), fresh: true };
  try {
    return { ...normalize(JSON.parse(raw)), fresh: false };
  } catch {
    return { ...normalize({}), fresh: false };
  }
}

function save(dir, data) {
  const clean = normalize(data);
  writeTextAtomic(canvasPath(dir), JSON.stringify(clean, null, 2) + '\n');
  return clean;
}

module.exports = { read, save, canvasPath, normalize };
