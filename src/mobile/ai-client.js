'use strict';

/**
 * iPad 端的 AI 客户端。
 *
 * 浏览器/WKWebView 直连 DeepSeek 会被 CORS 拦住，所以统一走自己的服务器代理：
 * 服务器持有密钥、转发流式响应；iPad 上不留任何明文密钥。
 */

const config = require('./config');

const MODEL = 'deepseek-chat';
const VISION_MODEL = 'deepseek-v4-flash-vision-exp';
const MAX_CONTEXT_CHARS = 120000;

let configured = null; // null = 还没探测过
let detectedSource = '';

function pickModel(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const hasImage = list.some(
    (m) => m && Array.isArray(m.content) && m.content.some((part) => part && part.type === 'image_url')
  );
  return hasImage ? VISION_MODEL : MODEL;
}

function url(p) {
  return config.get().baseUrl.replace(/\/+$/, '') + p;
}

function headers(extra) {
  const cfg = config.get();
  return {
    'Content-Type': 'application/json',
    'X-Mushu-Password': cfg.password || '',
    ...(extra || {}),
  };
}

function requireConnection() {
  const cfg = config.get();
  if (!cfg.baseUrl) throw new Error('还没有设置服务器地址');
  if (!cfg.password) throw new Error('还没有填写服务器访问密码，请到「设置 → 同步」里填写');
}

async function refreshStatus() {
  try {
    requireConnection();
    const res = await fetch(url('/api/ai/status'), { headers: headers() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    configured = !!data.configured;
    detectedSource = data.source || '';
  } catch {
    // 探测失败不武断判成「未配置」：真正调用时会给明确错误
    configured = null;
    detectedSource = '';
  }
  return { configured: configured !== false, source: detectedSource || 'server' };
}

/** 首次连接向导用：错误直接抛出，方便界面提示「密码不正确 / 连不上」 */
async function verify({ baseUrl, password }) {
  const root = String(baseUrl || '').trim().replace(/\/+$/, '');
  const url0 = (!root ? '' : /^https?:\/\//i.test(root) ? root : 'https://' + root) + '/api/ai/status';
  let res;
  try {
    res = await fetch(url0, { headers: { 'X-Mushu-Password': String(password || '') } });
  } catch {
    throw new Error('连不上服务器，请检查地址和网络');
  }
  if (res.status === 401) throw new Error('访问密码不正确');
  if (!res.ok) throw new Error('服务器返回 ' + res.status);
  return res.json();
}

async function setKey(key) {
  requireConnection();
  const res = await fetch(url('/api/ai/key'), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ key: String(key == null ? '' : key) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '保存密钥失败');
  configured = !!data.configured;
  detectedSource = data.source || '';
  return { configured: configured !== false, source: detectedSource || 'server' };
}

function apiKey() {
  // 服务层只拿它做「有没有配置」的前置判断，真正的密钥留在服务器
  return configured === false ? '' : 'server';
}

function keySource() {
  return configured === false ? '' : 'server';
}

function setKeyProvider() {
  /* 与桌面端接口对齐；iPad 端密钥在服务器，不需要本地 provider */
}

function parseChunk(line, onDelta, acc) {
  const text = line.trim();
  if (!text.startsWith('data:')) return acc;
  const payload = text.slice(5).trim();
  if (!payload || payload === '[DONE]') return acc;
  try {
    const json = JSON.parse(payload);
    const delta = json.choices && json.choices[0] && json.choices[0].delta;
    const piece = delta && delta.content;
    if (piece) {
      acc += piece;
      if (onDelta) onDelta(piece);
    }
  } catch {
    /* 非 JSON 的心跳帧直接跳过 */
  }
  return acc;
}

/**
 * 流式对话：签名与桌面端 services/ai.js 保持一致，便于 analyze/profile 直接复用。
 */
async function chat({ messages, signal, onDelta, temperature, json, maxTokens, timeoutMs }) {
  requireConnection();
  const cfg = config.get();

  let controller = null;
  let timer = null;
  let merged = signal;
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    controller = new AbortController();
    timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs);
    merged =
      signal && typeof AbortSignal !== 'undefined' && AbortSignal.any
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
  }

  try {
    const res = await fetch(url('/api/ai/chat'), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        messages,
        model: pickModel(messages),
        stream: true,
        temperature: Number.isFinite(temperature) ? temperature : 0.7,
        json: !!json,
        maxTokens: Number.isFinite(maxTokens) ? Math.round(maxTokens) : 0,
      }),
      signal: merged,
    });

    if (!res.ok) {
      let detail = '';
      try {
        const data = await res.json();
        detail = data.error || '';
      } catch {
        detail = '';
      }
      throw new Error(detail || `AI 接口返回 ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let full = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        full = parseChunk(line, onDelta, full);
      }
    }
    if (buf.trim()) full = parseChunk(buf, onDelta, full);
    return full;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  chat,
  apiKey,
  keySource,
  setKeyProvider,
  refreshStatus,
  setKey,
  verify,
  parseEnv: () => ({}),
  MAX_CONTEXT_CHARS,
  MODEL,
  VISION_MODEL,
  pickModel,
};
