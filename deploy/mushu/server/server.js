'use strict';

/**
 * 墨枢 · 移动端服务（零依赖，运行在 node:22-alpine）
 *
 * 职责：
 *   1) 手机网页的登录（应用内密码页 + 签名 Cookie）
 *   2) 读取/编辑服务器上的作品目录（复用桌面端同款 chapters/cast 模块，格式完全一致）
 *   3) 给桌面端同步脚本提供 manifest / 读文件 / 写文件三个接口
 *
 * 只监听容器内 8787，由宿主机 tmm-nginx 按域名反代并终止 TLS。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const chapters = require('./lib/chapters');
const cast = require('./lib/cast');
const canvas = require('./lib/canvas');
const { readText, writeTextAtomic, countWords } = require('./lib/fsutil');

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const WEB_DIR = path.join(__dirname, '..', 'web');
const PASSWORD = process.env.MUSHU_PASSWORD || '';
const SECRET = process.env.MUSHU_SECRET || crypto.randomBytes(16).toString('hex');
const COOKIE = 'mushu_auth';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const BODY_LIMIT = 32 * 1024 * 1024;
const AI_ENDPOINT = process.env.DEEPSEEK_ENDPOINT || 'https://api.deepseek.com/chat/completions';
const AI_KEY_FILE = path.join(DATA_DIR, '.settings', 'ai-key.json');
const AI_KEY_CACHE_MS = 5000;

let aiKeyCache = { at: 0, key: '', source: '' };

// 同步时跳过的目录：桌面端本地产物，没必要来回搬
const SYNC_SKIP = [path.join('.mushu', 'versions'), path.join('.mushu', 'drafts')];

if (!PASSWORD) console.warn('[warn] MUSHU_PASSWORD 未设置，任何登录都会失败');

// ---------- 登录票据 ----------

function sign(exp) {
  return crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex');
}

function makeToken() {
  const exp = Date.now() + SESSION_MS;
  return `${exp}.${sign(exp)}`;
}

function validToken(token) {
  if (!token) return false;
  const i = token.indexOf('.');
  if (i <= 0) return false;
  const exp = token.slice(0, i);
  const sig = token.slice(i + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const expect = sign(exp);
  if (sig.length !== expect.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  return validToken(parseCookies(req)[COOKIE]);
}

/** 桌面端同步脚本用密码头鉴权，手机网页用 Cookie 会话，二者等价 */
function isAuthedAny(req) {
  if (isAuthed(req)) return true;
  const h = req.headers['x-mushu-password'];
  return Boolean(PASSWORD) && typeof h === 'string' && h === PASSWORD;
}

function setCookieHeader(req, token, maxAgeSec) {
  const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

// ---------- AI（DeepSeek 代理） ----------

function aiKey() {
  const now = Date.now();
  if (now - aiKeyCache.at < AI_KEY_CACHE_MS) return aiKeyCache;
  const envKey = String(process.env.DEEPSEEK_API_KEY || process.env.MUSHU_AI_KEY || '').trim();
  if (envKey) {
    aiKeyCache = { at: now, key: envKey, source: 'env' };
    return aiKeyCache;
  }
  let fileKey = '';
  try {
    fileKey = String(JSON.parse(readText(AI_KEY_FILE, '{}')).key || '').trim();
  } catch {
    fileKey = '';
  }
  aiKeyCache = { at: now, key: fileKey, source: fileKey ? 'file' : '' };
  return aiKeyCache;
}

function saveAiKey(key) {
  const value = String(key == null ? '' : key).trim();
  fs.mkdirSync(path.dirname(AI_KEY_FILE), { recursive: true });
  writeTextAtomic(AI_KEY_FILE, JSON.stringify({ key: value }, null, 2));
  try {
    fs.chmodSync(AI_KEY_FILE, 0o600);
  } catch {
    /* 非 POSIX 环境忽略 */
  }
  aiKeyCache = { at: Date.now(), key: value, source: value ? 'file' : '' };
}

function aiStatus() {
  const info = aiKey();
  return { configured: Boolean(info.key), source: info.source };
}

async function proxyAiChat(req, res) {
  const info = aiKey();
  if (!info.key) {
    return sendJson(res, 400, { error: '服务器还没有配置 DeepSeek API Key' });
  }

  const body = await jsonBody(req);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return sendJson(res, 400, { error: 'messages 不能为空' });

  const payload = {
    model: body.model || 'deepseek-chat',
    messages,
    stream: body.stream !== false,
    temperature: Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : 0.7,
  };
  if (Number(body.maxTokens) > 0) payload.max_tokens = Math.round(Number(body.maxTokens));
  if (body.json) payload.response_format = { type: 'json_object' };

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  let upstream;
  try {
    upstream = await fetch(AI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${info.key}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) return;
    return sendJson(res, 502, { error: '连接 AI 服务失败：' + (err.message || String(err)) });
  }

  if (!upstream.ok) {
    let detail = '';
    try {
      const text = await upstream.text();
      try {
        detail = JSON.parse(text).error?.message || text;
      } catch {
        detail = text;
      }
    } catch {
      detail = '';
    }
    return sendJson(res, upstream.status || 502, { error: detail || `AI 服务返回 ${upstream.status}` });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  try {
    for await (const chunk of upstream.body) {
      if (res.writableEnded) break;
      res.write(chunk);
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      try {
        res.write(`data: ${JSON.stringify({ error: err.message || String(err) })}\n\n`);
      } catch {
        /* 客户端已断开 */
      }
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
}

// ---------- 路径安全 ----------

function workDir(name) {
  const dir = path.join(DATA_DIR, String(name || ''));
  const rel = path.relative(DATA_DIR, dir);
  if (!name || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('非法作品名');
  return dir;
}

function safeJoin(dir, rel) {
  const abs = path.join(dir, ...String(rel || '').split('/'));
  const r = path.relative(dir, abs);
  if (!rel || r.startsWith('..') || path.isAbsolute(r)) throw new Error('非法路径');
  return abs;
}

function listWorks() {
  let entries = [];
  try {
    entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    if (!fs.existsSync(path.join(DATA_DIR, e.name, 'book.json'))) continue;
    let title = e.name;
    try {
      title = JSON.parse(readText(path.join(DATA_DIR, e.name, 'book.json'), '{}')).title || e.name;
    } catch {
      /* 书名读不出来就退回目录名 */
    }
    out.push({ name: e.name, title });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
}

// ---------- 搜索：大纲 / 角色卡片 ----------

function makeFinder(query) {
  const needle = String(query || '').trim().toLowerCase();
  return needle ? (s) => String(s || '').toLowerCase().includes(needle) : () => false;
}

function searchOutline(dir, query) {
  const hit = makeFinder(query);
  if (!hit(query)) return [];
  const body = readText(path.join(dir, 'bible', 'outline.md'), '');
  const out = [];
  body.split('\n').forEach((line, i) => {
    if (out.length < 80 && hit(line)) out.push({ line: i + 1, text: line.trim().slice(0, 120) });
  });
  return out;
}

function searchCast(dir, query) {
  const hit = makeFinder(query);
  if (!hit(query)) return [];
  const data = cast.read(dir);
  const out = [];
  for (const group of ['characters', 'settings']) {
    for (const item of data[group] || []) {
      const fields = [['名称', item.name], ['别名', (item.aliases || []).join(' / ')], ['简介', item.desc]];
      for (const [field, value] of fields) {
        if (value && hit(value)) out.push({ group, name: item.name, field, text: String(value).slice(0, 120) });
      }
    }
  }
  return out;
}

// ---------- 同步：目录遍历 ----------

function walk(root, dir, acc) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (e.isDirectory()) {
      if (SYNC_SKIP.some((s) => rel === s.split(path.sep).join('/'))) continue;
      walk(root, abs, acc);
    } else if (e.isFile()) {
      const st = fs.statSync(abs);
      acc[rel] = { mtime: Math.round(st.mtimeMs), size: st.size };
    }
  }
  return acc;
}

// ---------- HTTP ----------

function sendJson(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function jsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  return JSON.parse(raw);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const abs = path.join(WEB_DIR, rel);
  if (!path.relative(WEB_DIR, abs).startsWith('..') && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-cache, must-revalidate' });
    res.end(fs.readFileSync(abs));
    return;
  }
  // 单页应用：其余路径一律回 index.html
  res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache, must-revalidate' });
  res.end(fs.readFileSync(path.join(WEB_DIR, 'index.html')));
}

/**
 * 人物唯一来源是无限画布的卡片（桌面端已把角色收敛到画布），设定仍存 cast.json。
 */
function readCastWithCanvas(dir) {
  const stored = cast.read(dir);
  const cards = canvas.read(dir).cards || [];
  return {
    characters: cards.map((c) => ({ name: c.name, aliases: c.aliases || [], desc: c.desc || '' })),
    settings: stored.settings || [],
  };
}

/** 反向写回：人物落进画布卡片（尽量保留原 id 与坐标，避免打乱画布布局），设定落进 cast.json */
function writeCastWithCanvas(dir, data) {
  const cv = canvas.read(dir);
  const prev = new Map((cv.cards || []).map((c) => [c.name, c]));
  const cards = (Array.isArray(data.characters) ? data.characters : [])
    .filter((c) => c && String(c.name || '').trim())
    .map((c, i) => {
      const old = prev.get(c.name);
      return {
        id: old ? old.id : undefined,
        name: c.name,
        aliases: c.aliases || [],
        desc: c.desc || '',
        x: old ? old.x : i * 240,
        y: old ? old.y : 0,
      };
    });
  canvas.save(dir, { ...cv, cards });
  const stored = cast.read(dir);
  stored.settings = Array.isArray(data.settings) ? data.settings : stored.settings || [];
  cast.save(dir, stored);
  return readCastWithCanvas(dir);
}

async function handleApi(req, res, url) {
  const q = url.searchParams;
  const route = `${req.method} ${url.pathname}`;
  const dir = () => workDir(q.get('work'));

  // 免登录
  if (route === 'POST /api/login') {
    const { password } = await jsonBody(req);
    if (!PASSWORD || String(password || '') !== PASSWORD) {
      return sendJson(res, 401, { error: '密码不正确' });
    }
    const token = makeToken();
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': setCookieHeader(req, token, Math.floor(SESSION_MS / 1000)) });
  }
  if (route === 'POST /api/logout') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': setCookieHeader(req, '', 0) });
  }
  if (route === 'GET /api/me') {
    return sendJson(res, 200, { authed: isAuthed(req) });
  }

  if (!isAuthedAny(req)) return sendJson(res, 401, { error: '未登录' });

  switch (route) {
    // ---- AI 代理（iPad 端不持有密钥，统一由服务器转发） ----
    case 'GET /api/ai/status':
      return sendJson(res, 200, aiStatus());
    case 'POST /api/ai/key': {
      const { key } = await jsonBody(req);
      saveAiKey(key);
      return sendJson(res, 200, aiStatus());
    }
    case 'POST /api/ai/chat':
      return proxyAiChat(req, res);

    case 'GET /api/works':
      return sendJson(res, 200, { works: listWorks() });

    case 'GET /api/tree':
      return sendJson(res, 200, chapters.tree(dir()));

    case 'GET /api/chapter': {
      const id = q.get('id');
      return sendJson(res, 200, chapters.readChapter(dir(), id));
    }
    case 'PUT /api/chapter': {
      const { work, id, body = '' } = await jsonBody(req);
      const d = workDir(work);
      const result = chapters.saveChapter(d, id, { body });
      return sendJson(res, 200, { ...result, tree: chapters.tree(d) });
    }

    case 'GET /api/outline':
      return sendJson(res, 200, { body: readText(path.join(dir(), 'bible', 'outline.md'), '') });
    case 'PUT /api/outline': {
      const { work, body = '' } = await jsonBody(req);
      const p = path.join(workDir(work), 'bible', 'outline.md');
      writeTextAtomic(p, String(body));
      return sendJson(res, 200, { ok: true, words: countWords(String(body)) });
    }

    case 'GET /api/cast':
      return sendJson(res, 200, readCastWithCanvas(dir()));
    case 'PUT /api/cast': {
      const { work, data } = await jsonBody(req);
      return sendJson(res, 200, writeCastWithCanvas(workDir(work), data || {}));
    }

    case 'GET /api/search': {
      const d = dir();
      const query = q.get('q') || '';
      const result = chapters.search(d, query);
      // 现有搜索只覆盖章节正文，这里把大纲与角色卡片也纳入
      result.outline = searchOutline(d, query);
      result.cast = searchCast(d, query);
      return sendJson(res, 200, result);
    }

    // ---- 同步 ----
    case 'GET /api/sync/manifest':
      return sendJson(res, 200, { files: walk(dir(), dir(), {}) });

    case 'GET /api/sync/file': {
      const abs = safeJoin(dir(), q.get('path'));
      if (!fs.existsSync(abs)) return sendJson(res, 200, { exists: false });
      const st = fs.statSync(abs);
      return sendJson(res, 200, { exists: true, text: readText(abs, ''), mtime: Math.round(st.mtimeMs), size: st.size });
    }
    case 'PUT /api/sync/file': {
      const { work, path: rel, text = '', mtime } = await jsonBody(req);
      const d = workDir(work);
      const abs = safeJoin(d, rel);
      writeTextAtomic(abs, String(text));
      if (Number.isFinite(Number(mtime))) {
        const t = Number(mtime) / 1000;
        try {
          fs.utimesSync(abs, t, t);
        } catch {
          /* 设置 mtime 失败不影响内容 */
        }
      }
      return sendJson(res, 200, { ok: true });
    }

    default:
      return sendJson(res, 404, { error: '接口不存在' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      // 原生 App 的 WebView origin 是 capacitor://localhost，需要放开跨域
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Mushu-Password');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '86400');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }
      const len = Number(req.headers['content-length'] || 0);
      if (len > BODY_LIMIT) return sendJson(res, 413, { error: '请求体过大' });
      return await handleApi(req, res, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: '不支持的方法' });
    }
    serveStatic(res, url.pathname);
  } catch (err) {
    sendJson(res, 500, { error: err.message || String(err) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[mushu] 监听 :${PORT}，数据目录 ${DATA_DIR}`);
});
