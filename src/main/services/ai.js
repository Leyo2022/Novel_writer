'use strict';

/**
 * DeepSeek 对话服务（主进程专用）。
 * 渲染进程受 CSP 限制不能直连外网，所以统一由主进程发请求，
 * 再把流式增量通过 IPC 广播回渲染层。
 *
 * 密钥从项目根目录的 .env 读取（DEEPSEEK_API_KEY），没有 dotenv 依赖，这里手写极简解析。
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const API_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-chat';
// 带图片时走官方多模态视觉模型；可用环境变量换名字
const VISION_MODEL = process.env.MUSHU_VISION_MODEL || 'deepseek-v4-flash-vision-exp';
const MAX_CONTEXT_CHARS = 120000; // 超出部分的原文会被截断，避免一次塞爆上下文

/** 消息里带 image_url 片段就用视觉模型，纯文字仍用默认对话模型 */
function pickModel(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const hasImage = list.some(
    (m) => m && Array.isArray(m.content) && m.content.some((part) => part && part.type === 'image_url')
  );
  return hasImage ? VISION_MODEL : MODEL;
}

let cachedKey = null;
let keyProvider = null; // 由主进程注入：从设置里解密出来的密钥（settings.json）

/** 注入设置密钥来源；传 null 取消。函数返回空串表示没配置。 */
function setKeyProvider(fn) {
  keyProvider = typeof fn === 'function' ? fn : null;
  cachedKey = null; // 让下一次取值重新走一遍来源
}

/** 极简 .env 解析：只认 KEY=VALUE（允许 # 注释与成对引号） */
function parseEnv(text) {
  const out = {};
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** .env 候选位置：环境变量优先，其次打包根目录 / 项目根目录 / 当前工作目录 */
function envFileCandidates() {
  const list = [];
  if (process.env.MUSHU_ENV_FILE) list.push(process.env.MUSHU_ENV_FILE);
  try {
    list.push(path.join(app.getAppPath(), '.env'));
  } catch {
    /* app 尚未 ready 时忽略 */
  }
  list.push(path.join(__dirname, '..', '..', '..', '.env'));
  list.push(path.join(process.cwd(), '.env'));
  return list;
}

/** 只在 .env 里找密钥（不含环境变量与设置） */
function envFileKey() {
  for (const file of envFileCandidates()) {
    try {
      if (!file || !fs.existsSync(file)) continue;
      const env = parseEnv(fs.readFileSync(file, 'utf8'));
      if (env.DEEPSEEK_API_KEY) return env.DEEPSEEK_API_KEY.trim();
    } catch {
      /* 换下一个候选路径 */
    }
  }
  return '';
}

/** 取 API Key：进程环境变量 → 设置里加密保存的密钥 → .env 文件 */
function apiKey() {
  const fromEnv = (process.env.DEEPSEEK_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  if (cachedKey) return cachedKey;
  if (keyProvider) {
    try {
      const fromSettings = String(keyProvider() || '').trim();
      if (fromSettings) {
        cachedKey = fromSettings;
        return cachedKey;
      }
    } catch {
      /* 解密失败就当没配置，继续找 .env */
    }
  }
  const fromFile = envFileKey();
  if (fromFile) {
    cachedKey = fromFile;
    return cachedKey;
  }
  return '';
}

/** 密钥来源：env / settings / file / ''，设置页用来告诉用户当前用的是哪一个 */
function keySource() {
  if ((process.env.DEEPSEEK_API_KEY || '').trim()) return 'env';
  if (keyProvider) {
    try {
      if (String(keyProvider() || '').trim()) return 'settings';
    } catch {
      /* 忽略 */
    }
  }
  return envFileKey() ? 'file' : '';
}

/**
 * 流式对话：边收边通过 onDelta 回调推给调用方，最终返回完整文本。
 * 通过 signal 支持中途取消。
 */
async function chat({ messages, signal, onDelta, temperature, json, maxTokens, timeoutMs }) {
  const key = apiKey();
  if (!key) throw new Error('没有配置 DeepSeek API Key，请在「设置 → AI」里填写');

  const body = {
    model: pickModel(messages),
    messages,
    stream: true,
    temperature: Number.isFinite(temperature) ? temperature : 0.7,
  };
  if (json) body.response_format = { type: 'json_object' };
  if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = Math.round(maxTokens);

  // 长任务加超时：和外部取消信号合并，用户取消仍能立即中断
  let controller = null;
  let timer = null;
  let merged = signal;
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    controller = new AbortController();
    timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs);
    merged = signal && typeof AbortSignal !== 'undefined' && AbortSignal.any ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  }

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify(body),
    signal: merged,
  }).finally(() => {
    if (timer) clearTimeout(timer);
  });

  if (!res.ok || !res.body) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* 读不到正文就只报状态码 */
    }
    throw new Error(`DeepSeek 接口返回 ${res.status}${detail ? '：' + detail : ''}`);
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
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = json.choices && json.choices[0] && json.choices[0].delta;
      const piece = delta && delta.content;
      if (piece) {
        full += piece;
        if (onDelta) onDelta(piece);
      }
    }
  }

  return full;
}

module.exports = { chat, apiKey, keySource, setKeyProvider, parseEnv, MAX_CONTEXT_CHARS, MODEL, VISION_MODEL, pickModel };
