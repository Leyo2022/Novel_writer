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

/** 阶段样貌变体：同一角色的不同人生阶段，不是不同人物 */
function normalizeStages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const stage = str(item.stage).trim().slice(0, 20);
    const age = str(item.age).trim().slice(0, 20);
    const appearance = str(item.appearance).trim().slice(0, 400);
    const summary = str(item.summary).trim().slice(0, 300);
    if (!stage && !appearance) continue;
    out.push({ stage, age, appearance, summary });
    if (out.length >= 8) break;
  }
  return out;
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
    // AI 档案：从正文里提炼的背景 / 性格 / 外貌，用户也可以手改
    background: str(raw && raw.background),
    personality: str(raw && raw.personality),
    appearance: str(raw && raw.appearance),
    // 同一个人在不同人生阶段的样貌变体（幼年/少年/青年/中年/老年…）
    stages: normalizeStages(raw && raw.stages),
    // 已生成标记：有值就不再自动生成，避免每次点开都重复请求模型
    profileAt: str(raw && raw.profileAt),
    stagesAt: str(raw && raw.stagesAt),
    x: num(raw && raw.x, 0),
    y: num(raw && raw.y, 0),
    // 是否已摆到画布上：cards 是「角色库」，未放置的只留在左栏，不进知识图谱
    placed: raw && raw.placed === true,
  };
}

// 每个情节点都可以有自己的子画布，子画布里的情节点还能继续往下钻；限制层数避免异常数据无限递归
const MAX_SUB_DEPTH = 6;

/** 情节点：标题必填，坐标即世界坐标（y 越高代表情绪越高扬） */
function normalizePoint(raw, level) {
  const title = str(raw && raw.title).trim();
  if (!title) return null;
  const point = {
    id: str(raw && raw.id).trim() || newId('beat'),
    title,
    desc: str(raw && raw.desc),
    // 下面几项是节点信息里的详细内容，画布上只显示标题 + 一句话
    detail: str(raw && raw.detail),
    who: str(raw && raw.who),
    place: str(raw && raw.place),
    chapter: str(raw && raw.chapter),
    x: num(raw && raw.x, 0),
    y: num(raw && raw.y, 0),
  };
  // 双击节点下钻进入的那张独立画布；没有内容就丢掉，避免空壳越存越多
  if (level < MAX_SUB_DEPTH && raw && raw.sub && typeof raw.sub === 'object') {
    const sub = normalizeCanvas(raw.sub, level + 1);
    if (sub.cards.length || sub.points.length || sub.links.length) point.sub = sub;
  }
  return point;
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

function normalizeCanvas(data, level) {
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
    // 被关掉的关系分类（分类名由前端按本书关系词现算），空数组代表全部显示
    hiddenCats: [...new Set((Array.isArray(data && data.hiddenCats) ? data.hiddenCats : []).map(str).filter(Boolean))],
    viewport: {
      x: num(vp.x, 0),
      y: num(vp.y, 0),
      zoom: Math.min(3, Math.max(0.2, num(vp.zoom, 1))),
    },
    focus: ids.has(focus) ? focus : '',
    depth: [0, 1, 2, 3].includes(rawDepth) ? rawDepth : 2,
    cards,
    points: (Array.isArray(data && data.points) ? data.points : []).map((p) => normalizePoint(p, level)).filter(Boolean),
    links,
  };
}

function normalize(data) {
  return normalizeCanvas(data, 0);
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
