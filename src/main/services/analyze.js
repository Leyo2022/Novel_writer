'use strict';

/**
 * 全书分析：把作品正文读成「角色卡片 + 人物关系 + 分卷情节点」。
 *
 * 防漏配角是这条流水线的第一目标，所以分成两段：
 *  1) 本地高频挖掘（不花 token）：用「说话人 + 道/说」、自我介绍句（名叫/叫做…）、
 *     称谓（X先生/X姑娘）三类句式，扫全书每一章，统计人物出现频次与章数；
 *  2) 分卷 LLM 精读：把本地候选名单连同原文节选交给模型，要求逐个确认、补全别名与身份。
 *     模型没提到的候选不会被丢掉，会以「频率补漏」的身份留在预览里，由用户决定是否写入。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const chapters = require('./chapters');
const canvas = require('./canvas');
const ai = require('./ai');
const { readText, writeTextAtomic, ensureDir } = require('./fsutil');

const CACHE_REL = path.join('.mushu', 'analysis');
const CACHE_VERSION = 2;
const CARD_W = 88;
const CARD_H = 104;
const MAX_CARDS = 400;
const MIN_MENTIONS = 5;
const MIN_CHAPTERS = 2;

const SURNAMES =
  '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯管卢莫经房裘缪干解应宗丁宣邓郁单杭洪包诸左石崔吉龚程邢滑裴陆荣翁荀羊惠甄曲封芮储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩聂晁勾敖融冷訾辛阚那简饶空曾毋沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公';

const STOP = new Set(
  (
    '他们 她们 我们 你们 咱们 大家 众人 众人皆 有人 有人 那人 这人 此人 对方 两人 三人 一人 自己 心中 心头 脸上 眼中 ' +
    '所有人 一群人 男人 女人 老人 少年 青年 孩子 父亲 母亲 儿子 女儿 哥哥 姐姐 弟弟 妹妹 丈夫 妻子 爷爷 奶奶 老爷 夫人 ' +
    '小姐 公子 姑娘 先生 掌柜 老板 丫鬟 小厮 士兵 军官 将军 皇帝 皇上 太后 王爷 大人 小人 属下 在下 诸位 各位 一边 ' +
    '此时 这时 那时 当下 当时 原本 本来 随后 接着 然后 于是 因此 但是 不过 只是 就是 还是 可是 所以 如果 虽然 已经 正在 ' +
    '刚刚 忽然 突然 顿时 立刻 马上 终于 果然 依然 仍旧 仍然 只有 没有 不是 不能 不会 不要 一个 两个 三个 几个 许多 很多 ' +
    '有些 所有 整个 全部 这样 那样 这里 那里 哪里 什么 怎么 为何 因为 到了 看到 听到 想到 知道 觉得 认为 看到 说着 ' +
    '说话 开口 点头 摇头 皱眉 叹气 回答 答应 开口 沉声 低声 轻声 大声 高声 急忙 连忙 冷笑 苦笑 笑道 说道 问道 答道 应道 ' +
    // 高频虚词 / 地名 / 组织，避免被说话人句式误判成人名
    '方才 方才说 通常 通常来 相对 相对来 一直 一直被 富家 体制 姑爷 地雷 竹记 华夏军 华夏军来 青木寨 小苍河 ' +
    '桃亭县 黄石沟 九木岭 霍川岭 夏村 杭州 江宁 汴梁 燕京 太原 泽州 吕梁 山东 河北 江南 中原 天下 朝廷 皇宫 军中 军中诸 ' +
    // 常见动宾/形容词短语、泛称与场所名，避免被当成无姓名的昵称
    '说出 平等 杀人 作诗仙 一声 一声明 有声 无声 作为 作对 行事 说话 开口 起身 动身 出手 收手 放心 小心 用心 专心 ' +
    '文学 人权 大势 理想 价值观 三观 胎教 水枪 上甘岭 将军岭 救天下 天下无 为第一 为江宁 武林盟 白鹿观 文翰苑 同文轩 ' +
    '时候 后来 许多 许多人 简单 简直 平静 平静地 经明白 相公 相府 娘子 夫君 老丈 老者 汉子 妇人'
  )
    .split(/\s+/)
    .filter(Boolean)
);

/** 名字前面常粘上的连词/副词，截取时逐层剥掉 */
const LEAD_NOISE = [
  '只见',
  '这时',
  '此时',
  '那时',
  '随后',
  '接着',
  '然后',
  '于是',
  '忽然',
  '突然',
  '顿时',
  '立刻',
  '马上',
  '终于',
  '果然',
  '依然',
  '仍旧',
  '仍然',
  '只有',
  '没有',
  '不是',
  '不能',
  '不会',
  '不要',
  '一边',
  '当下',
  '当时',
  '原本',
  '本来',
  '只是',
  '还是',
  '可是',
  '所以',
  '如果',
  '虽然',
  '已经',
  '正在',
  '刚刚',
  '众人',
  '有人',
  '那人',
  '这人',
  '此人',
  '对方',
  '两人',
  '三人',
  '一人',
  '自己',
  '大家',
  '他们',
  '她们',
  '我们',
  '你们',
  '咱们',
  // 「对于宁毅来说」「至于苏檀儿」这类句式
  '对于',
  '关于',
  '至于',
  '叫作',
  '叫做',
  '名叫',
  '称为',
];

/** 名字后面常粘上的动词字（「宁毅冷笑」被截成「宁毅冷」时剥掉） */
const TRAIL_VERB = ['冷笑', '苦笑', '沉声', '低声', '轻声', '大声', '高声', '急忙', '连忙', '开口', '点头', '摇头', '皱眉', '叹气', '笑着'];
const TRAIL_CHAR = new Set('冷热笑怒沉低轻大高急缓忙暗心嘴口眉眼面脸手头身脚声'.split(''));

const ATTR_VERBS =
  '说道|问道|答道|应道|笑道|冷笑道|沉声道|低声道|轻声道|喝道|叫道|怒道|叹道|回答道|开口道|道|说|问|答|回答';
const ATTR_RE = new RegExp(`([\\u4e00-\\u9fa5]{2,4})(?=(?:${ATTR_VERBS})[：:，,。！？\\s“"」』])`, 'g');
const INTRO_RE = /(?:名叫|叫做|唤作|名唤|人称|外号|绰号)([\u4e00-\u9fa5]{2,3})/g;
const APPELLATION_RE =
  /([\u4e00-\u9fa5]{2,3})(?=(?:先生|姑娘|小姐|公子|大人|将军|夫人|掌柜|老板|师父|师傅|师兄|师姐|少爷))/g;

function stripLead(name) {
  let s = name;
  for (let i = 0; i < 4; i += 1) {
    const hit = LEAD_NOISE.find((p) => s.length > p.length && s.startsWith(p));
    if (!hit) break;
    s = s.slice(hit.length);
  }
  return s;
}

function stripTrail(name) {
  let s = name;
  for (let i = 0; i < 3; i += 1) {
    const hit = TRAIL_VERB.find((p) => s.length > p.length && s.endsWith(p));
    if (hit) {
      s = s.slice(0, -hit.length);
      continue;
    }
    // 「对于宁毅来说」的尾巴、以及「宁毅说」被多截进来的动词
    if (s.length > 2 && /[来道说问答看想叫喊]$/.test(s)) {
      s = s.slice(0, -1);
      continue;
    }
    if (s.length > 2 && TRAIL_CHAR.has(s[s.length - 1])) {
      s = s.slice(0, -1);
      continue;
    }
    break;
  }
  return s;
}

/** 候选名是否像人名：姓氏开头 / 曾出现在介绍句 / 高频昵称 */
function plausible(name, mentioned = 0, intro = 0) {
  if (!name || name.length < 2 || name.length > 4) return false;
  if (STOP.has(name)) return false;
  if (/[的了是在和与就都也又很更太最不没我你他她它们这那]/.test(name)) return false;
  if (intro > 0) return true;
  // 「一声」「这厮」这类量词/指示词开头的基本都是短语碎片
  if (/^[一这那每各某几半]/.test(name)) return false;
  if (SURNAMES.includes(name[0])) return true;
  return mentioned >= 15;
}

function sha1(text) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex');
}

function normalizeCandidate(raw) {
  return stripTrail(stripLead(String(raw || '').trim()));
}

/** 单卷扫描：统计人物频次、章数、自我介绍句、称谓，以及同段共现对 */
function mineVolume(chapterList) {
  const cand = new Map(); // name -> { mentions, chapters:Set, intro, first }
  const touch = (raw, chapterId, kind) => {
    const name = normalizeCandidate(raw);
    if (!plausible(name, 1, kind === 'intro' ? 1 : 0)) return '';
    let item = cand.get(name);
    if (!item) {
      item = { name, mentions: 0, chapters: new Set(), intro: 0, first: chapterId };
      cand.set(name, item);
    }
    item.mentions += 1;
    item.chapters.add(chapterId);
    if (kind === 'intro') item.intro += 1;
    return name;
  };

  for (const ch of chapterList) {
    const text = ch.body || '';
    for (const m of text.matchAll(ATTR_RE)) touch(m[1], ch.id, 'attr');
    for (const m of text.matchAll(INTRO_RE)) touch(m[1], ch.id, 'intro');
    for (const m of text.matchAll(APPELLATION_RE)) touch(m[1], ch.id, 'appellation');
  }

  let list = [...cand.values()]
    .map((c) => ({ name: c.name, mentions: c.mentions, chapters: c.chapters.size, intro: c.intro, first: c.first }))
    .filter((c) => plausible(c.name, c.mentions, c.intro))
    .sort((a, b) => b.mentions - a.mentions || b.chapters - a.chapters);

  // 去掉「于宁毅来」这类把介词/语气词粘进来的长噪声：长名里包含一个更高频的短名就丢掉
  list = list.filter((c) => {
    const container = list.find(
      (k) => k !== c && c.name.length > k.name.length && c.name.includes(k.name) && (k.mentions >= c.mentions * 2 || !c.intro)
    );
    return !container;
  });

  // 重算前先按「说话人 / 介绍句」的命中筛一遍：
  // 只看子串频次的话，「时候说」这类虚词会靠全文出现次数混进候选。
  // candidates 沿用原来的戏份门槛；raw 放宽到 2 次，专门留给跨卷汇总补漏。
  const pick = (minMentions) =>
    new Set(
      list
        .filter((c) => (c.mentions >= minMentions && c.chapters >= MIN_CHAPTERS) || c.intro > 0)
        .map((c) => c.name)
    );
  const candNames = pick(MIN_MENTIONS);
  const rawNames = pick(2);

  // 用本卷真实出现次数重算频次与章数（说话人句式的命中会偏少，排序会失真）
  const full = countOccurrences(chapterList, list.map((c) => c.name));
  const counted = list
    .map((c) => {
      const f = full.get(c.name);
      return { ...c, mentions: f ? f.mentions : c.mentions, chapters: f ? f.chapters : c.chapters };
    })
    .filter((c) => plausible(c.name, c.mentions, c.intro));

  // raw 不再卡单卷戏份：配角在某一卷里可能只露几次，要靠跨卷汇总才看得出来，
  // 在这里就丢掉的话「频率补漏」永远补不到他们。
  const raw = counted.filter((c) => rawNames.has(c.name)).sort((a, b) => b.mentions - a.mentions);
  const candidates = counted
    .filter((c) => candNames.has(c.name))
    .sort((a, b) => b.mentions - a.mentions || b.chapters - a.chapters);

  // 同段共现：只统计留下来的候选，给模型当关系提示
  const pairs = new Map();
  const names = candidates.map((c) => c.name);
  if (names.length && names.length <= 1200) {
    for (const ch of chapterList) {
      for (const para of String(ch.body || '').split('\n')) {
        if (para.length < 4 || para.length > 1200) continue;
        const hit = names.filter((n) => para.includes(n));
        if (hit.length < 2) continue;
        const top = hit.slice(0, 6);
        for (let i = 0; i < top.length; i += 1) {
          for (let j = i + 1; j < top.length; j += 1) {
            const key = top[i] + '|' + top[j];
            pairs.set(key, (pairs.get(key) || 0) + 1);
          }
        }
      }
    }
  }

  const pairList = [...pairs.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([key, n]) => {
      const [a, b] = key.split('|');
      return { a, b, count: n };
    });

  return { candidates, raw, pairs: pairList };
}

/** 全量统计候选名在正文里的真实出现次数：长名优先，避免「李师师」被「师师」重复计数 */
function countOccurrences(chapterList, names) {
  const set = new Set(names);
  const stats = new Map(names.map((n) => [n, { mentions: 0, chapters: 0 }]));
  if (!set.size) return stats;
  for (const ch of chapterList) {
    const text = String(ch.body || '');
    const hit = new Set();
    for (let i = 0; i < text.length; i += 1) {
      const lens = text.length - i >= 4 ? [4, 3, 2] : text.length - i >= 3 ? [3, 2] : [2];
      for (const len of lens) {
        const sub = text.slice(i, i + len);
        if (!set.has(sub)) continue;
        const st = stats.get(sub);
        st.mentions += 1;
        hit.add(sub);
        i += len - 1;
        break;
      }
    }
    for (const n of hit) stats.get(n).chapters += 1;
  }
  return stats;
}

/** 节选原文：按段落均分取样，避免只读到卷首或卷尾 */
function sampleText(chapterList, budget) {
  const joined = chapterList
    .map((c) => `【${c.title}】\n${String(c.body || '').trim()}`)
    .join('\n\n');
  const total = joined.length;
  const want = Math.max(4000, Math.min(Number(budget) || 30000, 200000));
  if (total <= want) return joined;

  const chunk = 6000;
  const count = Math.max(1, Math.round(want / chunk));
  const step = (total - chunk) / Math.max(1, count - 1);
  const parts = [];
  for (let i = 0; i < count; i += 1) {
    let start = Math.floor(i * step);
    let end = Math.min(total, start + chunk);
    // 首尾对齐到段落边界，读起来更像原文
    if (start > 0) {
      const nl = joined.indexOf('\n', start);
      if (nl !== -1 && nl - start < 600) start = nl + 1;
    }
    if (end < total) {
      const nl = joined.lastIndexOf('\n', end);
      if (nl !== -1 && end - nl < 600) end = nl;
    }
    parts.push(joined.slice(start, end).trim());
  }
  return parts.join('\n\n……\n\n');
}

const SYSTEM_PROMPT = [
  '你是中文长篇小说的人物关系抽取器。只输出一个 JSON 对象，不要输出任何解释或 Markdown。',
  'JSON 结构：',
  '{"characters":[{"name":"","aliases":[],"role":"","desc":"","importance":1}],',
  ' "relations":[{"from":"","to":"","label":""}],',
  ' "events":[{"title":"","desc":"","emotion":0,"who":"","place":"","detail":""}]}',
  '规则：',
  '1. name 必须取自【本地候选名单】，或原文中确凿出现的人名；不得臆造，不得把称谓当名字。',
  '2. 候选名单里凡是真实人物，都必须出现在 characters 中，不得因为戏份少而省略；地名、门派、组织、器物直接略过。',
  '3. aliases 只收原文明确指代同一人的称呼（姓名、字、小名、绰号、排行称呼），不要凭猜测。',
  '4. role 用 4-8 字概括身份（如「苏家赘婿」「吕梁宗师」「金国主帅」）。',
  '5. desc 不超过 60 字，写身份与关键作为，不要写评价。',
  '6. importance 取 1-5：5=主角/贯穿全书，4=核心配角，3=重要配角，2=一般配角，1=龙套。',
  '7. relations 的 from/to 必须是 characters 里的 name；label 不超过 6 字（夫妻、父子、师徒、敌对、上下级…）；没有把握就不要写。',
  '8. events 最多 3 条，按时间顺序，emotion 为 -100 到 100 的整数。',
  '9. 每条 event 要写清这一节到底发生了什么：desc 是画布上显示的一句话（不超过 40 字）；who 是本节出场人物，取自 characters 的 name，用「、」分隔；place 是发生地点（不超过 12 字）；detail 是详细经过，80-150 字，按起因、经过、结果写，只说本卷原文里有的事，不要编造。',
].join('\n');

function buildUserPrompt(volTitle, candidates, pairs, text) {
  const cand = candidates
    .slice(0, 80)
    .map((c) => `${c.name}(${c.mentions})`)
    .join('、');
  const pairText = pairs
    .slice(0, 20)
    .map((p) => `${p.a}-${p.b}(${p.count})`)
    .join('、');
  return [
    `【本卷】${volTitle}`,
    `【本地候选名单（括号内为全书出现次数）】${cand || '（无）'}`,
    `【本卷高频同场人物对】${pairText || '（无）'}`,
    '【原文节选】',
    '<<<',
    text,
    '>>>',
  ].join('\n');
}

/** 解析模型输出：允许 ```json 包裹、允许前后有杂字 */
function parseModelJson(raw) {
  let s = String(raw || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end > start) s = s.slice(start, end + 1);
  const data = JSON.parse(s);

  const out = { characters: [], relations: [], events: [] };
  for (const raw2 of Array.isArray(data.characters) ? data.characters : []) {
    const name = String((raw2 && raw2.name) || '').trim();
    if (!name || name.length > 20) continue;
    const aliases = [];
    for (const a of Array.isArray(raw2.aliases) ? raw2.aliases : []) {
      const s2 = String(a || '').trim();
      if (s2 && s2 !== name && s2.length <= 12 && !aliases.includes(s2)) aliases.push(s2);
    }
    out.characters.push({
      name,
      aliases,
      role: String((raw2 && raw2.role) || '').trim().slice(0, 20),
      desc: String((raw2 && raw2.desc) || '').trim().slice(0, 200),
      importance: Math.min(5, Math.max(1, Math.round(Number(raw2 && raw2.importance) || 2))),
    });
  }
  for (const raw2 of Array.isArray(data.relations) ? data.relations : []) {
    const from = String((raw2 && raw2.from) || '').trim();
    const to = String((raw2 && raw2.to) || '').trim();
    if (!from || !to || from === to) continue;
    out.relations.push({ from, to, label: String((raw2 && raw2.label) || '').trim().slice(0, 12) });
  }
  for (const raw2 of Array.isArray(data.events) ? data.events : []) {
    const title = String((raw2 && raw2.title) || '').trim();
    if (!title) continue;
    out.events.push({
      title: title.slice(0, 30),
      desc: String((raw2 && raw2.desc) || '').trim().slice(0, 120),
      emotion: Math.min(100, Math.max(-100, Math.round(Number(raw2 && raw2.emotion) || 0))),
      who: String((raw2 && raw2.who) || '').trim().slice(0, 60),
      place: String((raw2 && raw2.place) || '').trim().slice(0, 24),
      detail: String((raw2 && raw2.detail) || '').trim().slice(0, 400),
    });
  }
  return out;
}

async function analyzeVolume({ volTitle, candidates, pairs, text, signal, onDelta }) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(volTitle, candidates, pairs, text) },
  ];
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await ai.chat({
        messages: attempt === 0 ? messages : [...messages, { role: 'user', content: '上次输出不是合法 JSON，请只输出 JSON 对象。' }],
        signal,
        onDelta,
        temperature: 0.2,
        json: true,
        // 角色多的卷（几十上百人）加上情节点详细经过，输出很容易超过 4000 token 被截断成非法 JSON
        maxTokens: 8000,
        timeoutMs: 300000,
      });
      return parseModelJson(raw);
    } catch (err) {
      if (signal && signal.aborted) throw err;
      lastErr = err;
    }
  }
  throw new Error(`第「${volTitle}」卷解析失败：${lastErr ? lastErr.message : '模型输出不是合法 JSON'}`);
}

function cacheFile(dir) {
  return path.join(dir, CACHE_REL, 'volumes.json');
}

function loadCache(dir) {
  try {
    const raw = readText(cacheFile(dir));
    if (!raw) return { schema: CACHE_VERSION, volumes: {} };
    const data = JSON.parse(raw);
    if (!data || data.schema !== CACHE_VERSION || typeof data.volumes !== 'object') return { schema: CACHE_VERSION, volumes: {} };
    return data;
  } catch {
    return { schema: CACHE_VERSION, volumes: {} };
  }
}

function saveCache(dir, cache) {
  ensureDir(path.join(dir, CACHE_REL));
  writeTextAtomic(cacheFile(dir), JSON.stringify(cache, null, 2) + '\n');
}

function volumeSignature(vol) {
  return sha1(vol.path + '|' + vol.chapters.map((c) => c.id + ':' + c.words).join(','));
}

/** 只做本地扫描，不调用模型（用于自检 / 调参） */
async function scan({ dir, onProgress, signal }) {
  const tree = chapters.tree(dir);
  if (!tree.volumes.length) throw new Error('这个作品还没有章节，先写几章再分析');
  const result = [];
  let done = 0;
  for (const vol of tree.volumes) {
    const list = [];
    for (const c of vol.chapters) {
      if (signal && signal.aborted) throw new Error('已取消');
      const ch = chapters.readChapter(dir, c.id);
      list.push({ id: c.id, title: ch.meta.title || c.title, body: ch.body });
      done += 1;
      if (onProgress && done % 30 === 0) {
        onProgress({ phase: 'scan', message: `已扫描 ${done} 章`, current: done, total: tree.chapterCount });
      }
    }
    const mined = mineVolume(list);
    result.push({
      path: vol.path,
      title: vol.title,
      chapters: list.length,
      candidates: mined.candidates,
      raw: mined.raw,
      pairs: mined.pairs,
    });
  }
  return result;
}

/**
 * 执行完整分析。
 * @returns 预览数据：{ stats, cards, links, points, generatedAt, model }
 */
async function run({ dir, budget = 30000, force = false, signal, onProgress } = {}) {
  const tree = chapters.tree(dir);
  if (!tree.volumes.length) throw new Error('这个作品还没有章节，先写几章再分析');
  if (!ai.apiKey()) throw new Error('还没有配置 DeepSeek API Key，请到「设置 → AI」里填写');

  const cache = loadCache(dir);
  const progress = (p) => {
    if (onProgress) {
      try {
        onProgress(p);
      } catch {
        /* 进度回调失败不影响分析 */
      }
    }
  };

  const perVolume = [];
  const globalCand = new Map(); // name -> { mentions, chapters:Set, intro, volumes:Set }
  let chapterDone = 0;
  let totalChars = 0;

  for (let vi = 0; vi < tree.volumes.length; vi += 1) {
    const vol = tree.volumes[vi];
    if (signal && signal.aborted) throw new Error('已取消');

    // 读本卷正文（tree 已经读过一遍，这里只需要正文）
    const list = [];
    for (const c of vol.chapters) {
      if (signal && signal.aborted) throw new Error('已取消');
      const ch = chapters.readChapter(dir, c.id);
      list.push({ id: c.id, title: ch.meta.title || c.title, body: ch.body });
      chapterDone += 1;
      totalChars += (ch.body || '').length;
      if (chapterDone % 40 === 0) {
        progress({
          phase: 'scan',
          message: `正在扫描全书… 已读 ${chapterDone} / ${tree.chapterCount} 章`,
          current: chapterDone,
          total: tree.chapterCount,
        });
      }
    }

    const sig = volumeSignature(vol);
    const cached = cache.volumes[vol.path];
    const reuse = !force && cached && cached.sig === sig && cached.mined && cached.result;

    let mined;
    let parsed;
    if (reuse) {
      mined = cached.mined;
      parsed = cached.result;
      progress({
        phase: 'volume',
        message: `第 ${vi + 1}/${tree.volumes.length} 卷「${vol.title}」：命中缓存`,
        current: vi + 1,
        total: tree.volumes.length,
      });
    } else {
      mined = mineVolume(list);
      const text = sampleText(list, budget);
      progress({
        phase: 'volume',
        message: `第 ${vi + 1}/${tree.volumes.length} 卷「${vol.title}」：候选 ${mined.candidates.length} 人，精读 ${text.length} 字`,
        current: vi + 1,
        total: tree.volumes.length,
      });
      parsed = await analyzeVolume({
        volTitle: vol.title,
        candidates: mined.candidates,
        pairs: mined.pairs,
        text,
        signal,
      });
      cache.volumes[vol.path] = { sig, mined, result: parsed, at: new Date().toISOString() };
      saveCache(dir, cache);
    }

    // 汇总全书候选（跨卷按名字合并）：用 raw 而非 candidates，
    // 这样在单卷里戏份不够的配角也能靠全书频次进入「频率补漏」
    for (const c of mined.raw || mined.candidates) {
      let g = globalCand.get(c.name);
      if (!g) {
        g = { name: c.name, mentions: 0, chapters: 0, intro: 0, volumes: new Set(), first: c.first };
        globalCand.set(c.name, g);
      }
      g.mentions += c.mentions;
      g.chapters += c.chapters;
      g.intro += c.intro;
      g.volumes.add(vol.title);
    }

    // 模型点出、本地句式却没抓到的名字（比如通篇只以「姑爷」称呼某人），
    // 用本卷正文补一次真实频次，预览里才不会显示「出现 0 次」。
    // 只补主名、不补别名：别名常是「姑爷」这类泛称，计进去会把主名挤掉。
    const missed = parsed.characters.map((ch) => ch.name).filter((n) => n && !globalCand.has(n));
    for (const [name, st] of countOccurrences(list, missed)) {
      if (!st.mentions) continue;
      let g = globalCand.get(name);
      if (!g) {
        g = { name, mentions: 0, chapters: 0, intro: 0, volumes: new Set() };
        globalCand.set(name, g);
      }
      g.mentions += st.mentions;
      g.chapters += st.chapters;
      g.volumes.add(vol.title);
    }

    perVolume.push({ vol, mined, parsed });
  }

  progress({ phase: 'merge', message: '正在合并人物、去重别名与关系…' });

  // ---------- 归并人物 ----------
  const nodes = [];
  const nameIndex = new Map(); // 任意称呼 -> node
  const canon = (names) => {
    // 同一人可能有多个称呼：取全书出现次数最高的那个作为主名
    let best = names[0];
    let bestN = -1;
    for (const n of names) {
      const g = globalCand.get(n);
      const count = g ? g.mentions : 0;
      if (count > bestN) {
        best = n;
        bestN = count;
      }
    }
    return best;
  };

  for (const { vol, parsed } of perVolume) {
    for (const ch of parsed.characters) {
      const names = [ch.name, ...ch.aliases];
      let node = null;
      for (const n of names) {
        if (nameIndex.has(n)) {
          node = nameIndex.get(n);
          break;
        }
      }
      if (!node) {
        const name = canon(names.filter((n) => globalCand.has(n)).concat(ch.name));
        node = {
          key: name,
          name,
          aliases: [],
          desc: '',
          role: '',
          importance: 1,
          mentions: 0,
          chapters: 0,
          volumes: new Set(),
          stub: false,
          llm: true,
        };
        nodes.push(node);
      }
      // 别名并入：只保留还没被别人占用的称呼
      for (const n of names) {
        if (!n || n === node.name) continue;
        const owner = nameIndex.get(n);
        if (owner && owner !== node) continue;
        if (!node.aliases.includes(n)) node.aliases.push(n);
        nameIndex.set(n, node);
      }
      nameIndex.set(node.name, node);
      if (ch.desc && ch.desc.length > node.desc.length) node.desc = ch.desc;
      if (ch.role && !node.role) node.role = ch.role;
      node.importance = Math.max(node.importance, ch.importance || 1);
      node.volumes.add(vol.title);
      node.llm = true;
    }
  }

  // ---------- 频率补漏：模型没提到、但本地反复出现的配角 ----------
  // 这里只兜「像人」的候选：高频或带姓氏依据的照单保留，场所/短语碎片挡在外面，
  // 否则预览里会塞进几百个噪声，用户反而看不到真正被漏掉的配角。
  const BAD_LEAD = /^[为做作乃叫赞有在给把被让使令本此那这其该对向从与和同带着的吗吧呢啊]/;
  const PLACE_TAIL = /[观门派遣盟帮阁堂轩苑坊店庄岭村街集县州府馆寺庙宫殿社军营楼]$/;
  const stubs = [...globalCand.values()]
    .filter((g) => !nameIndex.has(g.name))
    .filter((g) => plausible(g.name, g.mentions, g.intro))
    .filter((g) => {
      if (BAD_LEAD.test(g.name)) return false;
      if (PLACE_TAIL.test(g.name) && g.intro < 2) return false;
      if (g.mentions >= 100) return true; // 全书上百次，基本不可能是短语
      if (g.mentions >= 8 && g.chapters >= 2 && SURNAMES.includes(g.name[0])) return true;
      return g.intro >= 2 && g.mentions >= 5;
    })
    .sort((a, b) => b.mentions - a.mentions);

  for (const g of stubs) {
    if (nodes.length >= MAX_CARDS) break;
    const node = {
      key: g.name,
      name: g.name,
      aliases: [],
      desc: `全书出现 ${g.mentions} 次，分布在 ${g.chapters} 章；AI 未给出简介，待补充。`,
      role: '',
      importance: g.mentions >= 60 ? 2 : 1,
      mentions: g.mentions,
      chapters: g.chapters,
      volumes: g.volumes,
      stub: true,
      llm: false,
    };
    nodes.push(node);
    nameIndex.set(g.name, node);
  }

  // 用全书频次补齐统计（模型确认的人物也按本地频次排序）
  for (const node of nodes) {
    let mentions = 0;
    let chapters2 = 0;
    const seenVol = new Set();
    const all = [node.name, ...node.aliases];
    for (const n of all) {
      const g = globalCand.get(n);
      if (!g) continue;
      mentions += g.mentions;
      chapters2 += g.chapters;
      for (const v of g.volumes) seenVol.add(v);
    }
    node.mentions = Math.max(node.mentions, mentions);
    node.chapters = Math.max(node.chapters, chapters2);
    for (const v of seenVol) node.volumes.add(v);
    if (!node.role && node.stub) node.role = '';
  }

  // ---------- 关系 ----------
  const links = [];
  const seenLink = new Set();
  for (const { parsed } of perVolume) {
    for (const r of parsed.relations) {
      const a = nameIndex.get(r.from);
      const b = nameIndex.get(r.to);
      if (!a || !b || a === b) continue;
      const key = a.key + '>' + b.key;
      if (seenLink.has(key)) continue;
      seenLink.add(key);
      links.push({ from: a.key, to: b.key, label: r.label });
    }
  }

  // ---------- 情节点 ----------
  const points = [];
  perVolume.forEach(({ vol, parsed }, vi) => {
    const events = parsed.events.slice(0, 3);
    const volChaps = vol.chapters || [];
    events.forEach((e, i) => {
      // 事件按卷内先后粗略摊到该卷章节上：模型给的是整卷的事件，落不到具体某一章，
      // 这里只求「点进正文能落在这一卷」的近似定位，用户可在详情页改成准确章节。
      const ci = events.length > 1 ? Math.round((i * (volChaps.length - 1)) / (events.length - 1)) : 0;
      points.push({
        title: e.title,
        desc: e.desc,
        emotion: e.emotion,
        volume: vol.title,
        order: vi * 10 + i,
        who: e.who || '',
        place: e.place || '',
        detail: e.detail || '',
        chapter: volChaps[ci] ? volChaps[ci].id : '',
      });
    });
  });

  nodes.sort((a, b) => b.importance - a.importance || b.mentions - a.mentions || a.name.localeCompare(b.name, 'zh'));

  const result = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    model: ai.MODEL,
    stats: {
      chapters: tree.chapterCount,
      chars: totalChars,
      volumes: tree.volumes.length,
      candidates: globalCand.size,
      cards: nodes.length,
      llmCards: nodes.filter((n) => n.llm).length,
      stubCards: nodes.filter((n) => n.stub).length,
      links: links.length,
      points: points.length,
      cachedVolumes: perVolume.filter((p) => cache.volumes[p.vol.path] && cache.volumes[p.vol.path].sig === volumeSignature(p.vol) && !force).length,
    },
    cards: nodes.map((n) => ({
      key: n.key,
      name: n.name,
      aliases: n.aliases,
      desc: n.desc,
      role: n.role,
      importance: n.importance,
      mentions: n.mentions,
      chapters: n.chapters,
      volumes: [...n.volumes],
      stub: n.stub,
      // 预览默认勾选「可信」的人：AI 确认过，或本地补漏但有姓氏/高频依据
      likely: !n.stub || SURNAMES.includes(n.name[0]) || n.mentions >= 100,
    })),
    links,
    points,
  };

  ensureDir(path.join(dir, CACHE_REL));
  writeTextAtomic(path.join(dir, CACHE_REL, 'last.json'), JSON.stringify(result, null, 2) + '\n');
  progress({
    phase: 'done',
    message: `识别 ${result.stats.cards} 人（AI 确认 ${result.stats.llmCards}，频率补漏 ${result.stats.stubCards}），关系 ${result.stats.links} 条`,
    current: tree.volumes.length,
    total: tree.volumes.length,
  });
  return result;
}

function endIdFor(name, used) {
  const base = 'card-' + sha1(name).slice(0, 10);
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(base + '-' + i)) i += 1;
  return base + '-' + i;
}

/** 把预览里勾选的人物 / 关系写进 canvas.json；返回写入统计 */
function apply({ dir, result, selectedKeys, writePoints = false }) {
  if (!result || !Array.isArray(result.cards)) throw new Error('分析结果为空，请重新分析');
  const keys = new Set(Array.isArray(selectedKeys) ? selectedKeys : []);
  if (!keys.size) throw new Error('至少勾选一个人物');

  const current = canvas.read(dir);
  const hadCards = current.cards.length > 0;
  const existing = current.cards;
  const byName = new Map();
  for (const c of existing) {
    byName.set(c.name, c);
    for (const a of c.aliases || []) if (!byName.has(a)) byName.set(a, c);
  }
  const usedIds = new Set(existing.map((c) => c.id));

  const picked = result.cards.filter((c) => keys.has(c.key));
  const keyToCard = new Map();
  const created = []; // 本次新增的卡片：只给它们排初始位置
  let added = 0;
  let updated = 0;

  for (const c of picked) {
    let card = byName.get(c.name);
    if (!card) {
      for (const a of c.aliases || []) {
        if (byName.has(a)) {
          card = byName.get(a);
          break;
        }
      }
    }
    if (card) {
      // 已有卡片：只补空字段，不动用户写过的简介与位置
      for (const a of c.aliases || []) {
        if (a !== card.name && !card.aliases.includes(a)) card.aliases.push(a);
      }
      if (!card.desc && c.desc) card.desc = c.desc;
      // 用户确认写入，就让它出现在画布上（原先可能只是待在左栏角色库里）
      card.placed = true;
      updated += 1;
    } else {
      const id = endIdFor(c.name, usedIds);
      usedIds.add(id);
      card = {
        id,
        name: c.name,
        aliases: c.aliases || [],
        desc: c.desc || (c.role ? c.role : ''),
        x: 0,
        y: 0,
        placed: true,
      };
      existing.push(card);
      byName.set(card.name, card);
      for (const a of card.aliases) if (!byName.has(a)) byName.set(a, card);
      created.push({ card, importance: c.importance || 1 });
      added += 1;
    }
    keyToCard.set(c.key, card);
  }

  // ---------- 给新卡片排一个径向初始位置（打开画布后还会按关系自动整理） ----------
  const mainCard = picked[0] && keyToCard.get(picked[0].key);
  if (created.length) {
    const order = created.slice().sort((a, b) => b.importance - a.importance).map((x) => x.card);
    order.forEach((card, i) => {
      if (card === mainCard) {
        card.x = -CARD_W / 2;
        card.y = -36;
        return;
      }
      const tier = i <= 8 ? 320 : i <= 20 ? 700 : 1050;
      const idx = i <= 8 ? i - 1 : i <= 20 ? i - 9 : i - 21;
      const n = i <= 8 ? 8 : i <= 20 ? 12 : Math.max(1, order.length - 21);
      const ang = (idx / Math.max(1, n)) * Math.PI * 2;
      card.x = Math.round(Math.cos(ang) * tier - CARD_W / 2);
      card.y = Math.round(Math.sin(ang) * tier - 36);
    });
  }

  // ---------- 关系 ----------
  const links = Array.isArray(current.links) ? current.links : [];
  const seen = new Set(links.map((l) => l.from + '>' + l.to));
  let linkCount = 0;
  for (const r of result.links || []) {
    const a = keyToCard.get(r.from);
    const b = keyToCard.get(r.to);
    if (!a || !b || a === b) continue;
    const key = a.id + '>' + b.id;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ id: 'lk-' + sha1(key).slice(0, 10), from: a.id, to: b.id, label: r.label || '' });
    linkCount += 1;
  }

  // ---------- 情节点 ----------
  let pointCount = 0;
  const points = Array.isArray(current.points) ? current.points : [];
  if (writePoints) {
    const titles = new Set(points.map((p) => p.title));
    // 接在已有故事线末尾；画布上还没有情节点时从 0 附近开始，不要飘到很远
    const maxX = points.length ? points.reduce((m, p) => Math.max(m, Number(p.x) || 0), 0) : 0;
    (result.points || []).forEach((p, i) => {
      if (titles.has(p.title)) return;
      titles.add(p.title);
      points.push({
        id: 'beat-' + sha1(p.volume + '|' + p.title).slice(0, 10),
        title: p.title,
        desc: p.desc || '',
        detail: p.detail || '',
        who: p.who || '',
        place: p.place || '',
        chapter: p.chapter || '',
        x: maxX + 520 * (i + 1),
        y: 420 - Math.round((Number(p.emotion) || 0) * 2),
      });
      pointCount += 1;
    });
  }

  // ---------- 圆心 / 模式 ----------
  const focusStillThere = existing.some((c) => c.id === current.focus);
  const saved = canvas.save(dir, {
    schema: 1,
    mode: 'graph',
    viewport: current.viewport,
    focus: focusStillThere ? current.focus : mainCard ? mainCard.id : '',
    depth: hadCards ? current.depth : 3,
    cards: existing,
    points,
    links,
  });

  return {
    canvas: saved,
    stats: { added, updated, links: linkCount, points: pointCount, totalCards: saved.cards.length },
  };
}

module.exports = { run, scan, apply, sampleText, mineVolume };
