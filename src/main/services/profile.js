'use strict';

/**
 * 单个角色的档案分析：从全书正文里抽出这个角色出场的片段，交给模型提炼
 * 背景 / 性格 / 外貌。只读不写，结果由渲染层回填到角色卡片上。
 */

const chapters = require('./chapters');
const ai = require('./ai');

const MAX_EXCERPT_CHARS = 24000;
const PER_CHAPTER_CHARS = 2400;

const STAGE_SPEC =
  '{"stage":"幼年/少年/青年/中年/老年（或原文写明的阶段）","age":"大致年龄或年龄段","appearance":"该阶段的外貌、服饰、气质","summary":"该阶段的身份、处境或关键变化"}';

const PROFILE_PROMPT = [
  '你是中文长篇小说的人物档案整理器。只输出一个 JSON 对象，不要输出解释或 Markdown。',
  'JSON 结构：{"background":"","personality":"","appearance":"","stages":[' + STAGE_SPEC + ']}',
  '规则：',
  '1. background：出身、身份、立场、关键经历，120 字以内；只写原文有依据的内容。',
  '2. personality：性格特征与行事风格，用短语概括，80 字以内；结合人物言行，不要空泛评价。',
  '3. appearance：最能代表这个人物的整体外貌印象，80 字以内；原文没有描写就写「原文未细写」，不要臆造。',
  '4. stages：同一个人在不同人生阶段的样貌变体，不是不同人物；按时间顺序排列，最多 6 项，没有明显阶段性变化就只给 1 项。',
  '5. stages 只写原文有依据的阶段；原文没有该阶段的样貌描写就不要硬凑，宁缺毋滥。',
  '6. 不要复述大段剧情，不要写人物关系清单，不要评价文笔。',
  '7. 原文材料不足时，可以结合给出的已有简介做保守概括，但不得编造具体事实。',
].join('\n');

const STAGES_PROMPT = [
  '你是中文长篇小说的人物样貌整理器。只输出一个 JSON 对象，不要输出解释或 Markdown。',
  'JSON 结构：{"stages":[' + STAGE_SPEC + ']}',
  '规则：',
  '1. stages 是同一个角色在不同人生阶段的样貌变体，不是不同人物；按时间顺序，最多 6 项。',
  '2. 阶段可以是幼年、少年、青年、中年、老年，也可以是原文明确写出的阶段（如「入京前」「称帝后」）。',
  '3. 只写原文有依据的外貌、服饰、气质；没有描写就不要硬凑，没有阶段变化就只给 1 项。',
  '4. 不写剧情流水账，不评价文笔，不要臆造原文没有的细节。',
].join('\n');

/** 是否只需要阶段样貌：老卡片已有档案但没有变体时，只补 stages，不覆盖人物介绍 */
function buildSystemPrompt(mode) {
  return mode === 'stages' ? STAGES_PROMPT : PROFILE_PROMPT;
}

/** 去掉空段，保留段落边界，便于按段筛出角色出场的内容 */
function splitParagraphs(text) {
  return String(text || '')
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 挑出角色出场的章节片段；过多时按章节均匀取样，避免只读到开头 */
function collectExcerpts(dir, terms) {
  const volumes = (chapters.tree(dir) || {}).volumes || [];
  const chunks = [];
  for (const vol of volumes) {
    for (const ch of vol.chapters) {
      let body = '';
      try {
        body = chapters.readChapter(dir, ch.id).body;
      } catch {
        continue;
      }
      const hits = splitParagraphs(body).filter((p) => terms.some((t) => p.includes(t)));
      if (!hits.length) continue;
      chunks.push({
        label: `${vol.title} / ${ch.title}`,
        text: hits.join('\n').slice(0, PER_CHAPTER_CHARS),
      });
    }
  }
  if (!chunks.length) return { text: '', chapters: 0 };

  const total = chunks.reduce((n, c) => n + c.text.length, 0);
  if (total <= MAX_EXCERPT_CHARS) {
    return { text: chunks.map((c) => `【${c.label}】\n${c.text}`).join('\n\n'), chapters: chunks.length };
  }

  // 超预算：按「首尾保留 + 中间均匀取样」挑选，兼顾早期设定与后期变化
  const picked = [];
  const step = Math.max(1, total / MAX_EXCERPT_CHARS);
  let acc = 0;
  let next = 0;
  for (const c of chunks) {
    if (acc >= next) {
      picked.push(c);
      next += step * Math.max(1, c.text.length);
    }
    acc += c.text.length;
  }
  return { text: picked.map((c) => `【${c.label}】\n${c.text}`).join('\n\n'), chapters: picked.length };
}

function parseModelJson(raw) {
  let s = String(raw || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end > start) s = s.slice(start, end + 1);
  const data = JSON.parse(s);
  const pick = (v, max) =>
    String(v == null ? '' : v)
      .replace(/\r/g, '')
      .trim()
      .slice(0, max);
  return {
    background: pick(data && data.background, 400),
    personality: pick(data && data.personality, 300),
    appearance: pick(data && data.appearance, 300),
    stages: normalizeStages(data && data.stages),
  };
}

function normalizeStages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const stage = String(item.stage == null ? '' : item.stage).trim().slice(0, 20);
    const age = String(item.age == null ? '' : item.age).trim().slice(0, 20);
    const appearance = String(item.appearance == null ? '' : item.appearance).trim().slice(0, 400);
    const summary = String(item.summary == null ? '' : item.summary).trim().slice(0, 300);
    if (!stage && !appearance) continue;
    out.push({ stage, age, appearance, summary });
    if (out.length >= 8) break;
  }
  return out;
}

async function analyze({ dir, name, aliases, desc, relations, mode, signal } = {}) {
  const onlyStages = mode === 'stages';
  if (!dir) throw new Error('请先打开一个作品');
  const title = String(name || '').trim();
  if (!title) throw new Error('角色没有名字，无法分析');
  // 先确认密钥，避免白读一遍全书正文
  if (!ai.apiKey()) throw new Error('没有配置 DeepSeek API Key，请先在「设置 → AI」里填写');

  const terms = [...new Set([title, ...(Array.isArray(aliases) ? aliases : [])].map((s) => String(s || '').trim()).filter(Boolean))];
  const { text, chapters: chapterCount } = collectExcerpts(dir, terms);
  const intro = String(desc || '').trim();
  const rel = String(relations || '').trim();
  if (!text && !intro && !rel) {
    throw new Error('正文里还没找到「' + title + '」的戏份，先写几章再分析');
  }

  const userPrompt = [
    `【角色】${title}`,
    `【别名】${terms.slice(1).join('、') || '（无）'}`,
    `【已有简介】${intro || '（无）'}`,
    `【人物关系】${rel || '（无）'}`,
    `【出场原文片段${chapterCount ? `（${chapterCount} 处）` : '（正文中没有找到，仅依据简介与关系）'}】`,
    '<<<',
    text || '（无原文片段）',
    '>>>',
  ].join('\n');

  const messages = [
    { role: 'system', content: buildSystemPrompt(mode) },
    { role: 'user', content: userPrompt },
  ];

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await ai.chat({
        messages: attempt === 0 ? messages : [...messages, { role: 'user', content: '上次输出不是合法 JSON，请只输出 JSON 对象。' }],
        signal,
        temperature: 0.3,
        json: true,
        maxTokens: onlyStages ? 1400 : 2200,
        timeoutMs: 180000,
      });
      const out = parseModelJson(raw);
      if (onlyStages) {
        if (!out.stages.length) throw new Error('模型没有返回阶段样貌');
        return { background: '', personality: '', appearance: '', stages: out.stages, chapters: chapterCount };
      }
      if (!out.background && !out.personality && !out.appearance) throw new Error('模型没有返回档案内容');
      return { ...out, chapters: chapterCount };
    } catch (err) {
      if (signal && signal.aborted) throw err;
      lastErr = err;
    }
  }
  throw new Error('角色档案分析失败：' + (lastErr ? lastErr.message : '模型输出不是合法 JSON'));
}

module.exports = { analyze };
