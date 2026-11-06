'use strict';

/**
 * iPad 端的连接配置：服务器地址 + 访问密码 + 自动同步开关。
 * 原生环境用 Capacitor Preferences（UserDefaults）持久化，浏览器调试退回 localStorage。
 */

const native = require('./native');

const STORE_KEY = 'mushu.mobile.config';

const DEFAULTS = {
  baseUrl: 'https://mushu.sfangjie.cn',
  password: '',
  autoSync: true,
  lastSyncAt: '',
  setupDone: false,
};

let cached = { ...DEFAULTS };
let prefs = null;

function nativePrefs() {
  if (!native.isNative()) return null;
  return native.preferences();
}

function normalizeUrl(url) {
  const s = String(url || '').trim().replace(/\/+$/, '');
  if (!s) return DEFAULTS.baseUrl;
  if (!/^https?:\/\//i.test(s)) return 'https://' + s;
  return s;
}

async function load() {
  prefs = nativePrefs();
  let raw = '';
  try {
    if (prefs) {
      const res = await prefs.get({ key: STORE_KEY });
      raw = res && res.value ? res.value : '';
    } else {
      raw = localStorage.getItem(STORE_KEY) || '';
    }
  } catch {
    raw = '';
  }
  if (raw) {
    try {
      cached = { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
      cached = { ...DEFAULTS };
    }
  }
  cached.baseUrl = normalizeUrl(cached.baseUrl);
  return { ...cached };
}

async function save(patch) {
  cached = { ...cached, ...(patch || {}) };
  cached.baseUrl = normalizeUrl(cached.baseUrl);
  const text = JSON.stringify(cached);
  try {
    if (!prefs) prefs = nativePrefs();
    if (prefs) await prefs.set({ key: STORE_KEY, value: text });
    else localStorage.setItem(STORE_KEY, text);
  } catch {
    /* 存不下也不影响本次会话 */
  }
  return { ...cached };
}

function get() {
  return { ...cached };
}

module.exports = { load, save, get, DEFAULTS };
