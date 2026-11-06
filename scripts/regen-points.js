'use strict';

/**
 * 一次性脚本：清掉旧情节点，重跑全书分析，只把新的分卷情节点写回 canvas.json，
 * 角色卡片 / 人物关系 / 圆心 / 视图模式 / 关系分类显隐状态一律原样保留。
 *
 * 用法：node scripts/regen-points.js "<作品目录>" [每卷精读字数，默认 80000]
 */

const crypto = require('crypto');
const analyze = require('../src/main/services/analyze');
const canvas = require('../src/main/services/canvas');

function sha1(text) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex');
}

const dir = process.argv[2];
const budget = Number(process.argv[3]) || 80000;

if (!dir) {
  console.error('[regen] 缺少作品目录');
  process.exit(1);
}

(async () => {
  const before = canvas.read(dir);
  console.log(`[regen] 作品：${dir}`);
  console.log(`[regen] 改动前：卡片 ${before.cards.length} / 关系 ${before.links.length} / 情节点 ${before.points.length} / 圆心 ${before.focus}`);
  console.log(`[regen] 精读预算：每卷约 ${budget} 字`);

  const result = await analyze.run({
    dir,
    budget,
    onProgress: (p) => {
      if (p && p.message) console.log(`[regen] ${p.phase || ''} ${p.message}`);
    },
  });

  const raw = Array.isArray(result.points) ? result.points : [];
  const points = raw.map((p, i) => ({
    id: 'beat-' + sha1(p.volume + '|' + p.title).slice(0, 10),
    title: p.title,
    desc: p.desc || '',
    detail: p.detail || '',
    who: p.who || '',
    place: p.place || '',
    chapter: p.chapter || '',
    x: i * 700,
    y: 420 - Math.round((Number(p.emotion) || 0) * 2),
  }));

  const saved = canvas.save(dir, { ...before, points });

  console.log(`[regen] 改动后：情节点 ${before.points.length} → ${saved.points.length}`);
  console.log(`[regen] 卡片 ${saved.cards.length} / 关系 ${saved.links.length} / 圆心 ${saved.focus} / 模式 ${saved.mode}`);
  console.log(`[regen] 带「详细经过」的情节点：${saved.points.filter((p) => p.detail).length} / ${saved.points.length}`);
  console.log(`[regen] 带「涉及人物」的情节点：${saved.points.filter((p) => p.who).length} / ${saved.points.length}`);
  console.log('[regen] DONE');
})().catch((err) => {
  console.error('[regen] 失败：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
