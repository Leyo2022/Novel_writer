'use strict';

/**
 * 本地优先同步。
 *
 * 规则（和你的使用习惯一致）：
 *   1. 所有写入先落 iPad 本地，永远不阻塞写作；
 *   2. 空闲/定时/切后台时把本地变更推到服务器；
 *   3. 服务器上多出来的文件（换设备、桌面端新写的）在本地没改过时拉回来；
 *   4. 删除不向服务器传播，避免误删整章；冲突时以本地为准。
 *
 * 复用服务器已有的 /api/sync/* 接口，桌面端同步脚本不需要改。
 */

const fs = require('./shims/fs');
const path = require('./shims/path');
const { readText } = require('../main/services/fsutil');
const config = require('./config');
const ui = require('./ui');

const PROJECTS_ROOT = '/mushu/works';
const STATE_FILE = '/mushu/sync-state.json';
const SKIP_PREFIX = ['.mushu/versions/', '.mushu/drafts/'];
const MAX_PUSH_BYTES = 24 * 1024 * 1024;
const SYNC_INTERVAL_MS = 3 * 60 * 1000;

let running = null;
let timer = null;
let debounceTimer = null;
let lastError = '';
let started = false;

function skipRel(rel) {
  return SKIP_PREFIX.some((p) => rel.startsWith(p)) || /\.tmp-\d+-\d+$/.test(rel);
}

function loadState() {
  try {
    return JSON.parse(readText(STATE_FILE, '{}')) || {};
  } catch {
    return {};
  }
}

function saveState(state) {
  const { writeTextAtomic } = require('../main/services/fsutil');
  writeTextAtomic(STATE_FILE, JSON.stringify(state, null, 2));
}

function localWorks() {
  if (!fs.existsSync(PROJECTS_ROOT)) return [];
  return fs
    .readdirSync(PROJECTS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(PROJECTS_ROOT, e.name, 'book.json')))
    .map((e) => e.name);
}

function localFiles(work) {
  const root = path.join(PROJECTS_ROOT, work);
  const out = [];
  const walk = (dir, relBase) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skipRel(rel) || skipRel(rel + '/')) continue;
        walk(abs, rel);
      } else if (e.isFile()) {
        if (skipRel(rel)) continue;
        out.push({ rel, abs, mtime: fs.statSync(abs).mtimeMs });
      }
    }
  };
  walk(root, '');
  return out;
}

function headers() {
  const cfg = config.get();
  return {
    'Content-Type': 'application/json',
    'X-Mushu-Password': cfg.password || '',
  };
}

function apiUrl(p) {
  return config.get().baseUrl.replace(/\/+$/, '') + p;
}

async function request(p, init) {
  const res = await fetch(apiUrl(p), {
    ...init,
    headers: { ...headers(), ...((init && init.headers) || {}) },
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).error || '';
    } catch {
      detail = '';
    }
    throw new Error(detail || `服务器返回 ${res.status}`);
  }
  return res.json();
}

function setStatus(text, tone) {
  ui.setSyncStatus(text, tone);
}

async function pullWork(work, state, remote) {
  const root = path.join(PROJECTS_ROOT, work);
  fs.mkdirSync(root, { recursive: true });
  let pulled = 0;
  const entries = Object.entries(remote || {});
  for (const [rel, info] of entries) {
    if (skipRel(rel)) continue;
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    try {
      const data = await request(`/api/sync/file?work=${encodeURIComponent(work)}&path=${encodeURIComponent(rel)}`);
      if (!data.exists) continue;
      fs.writeFileSync(abs, String(data.text == null ? '' : data.text), 'utf8');
      const mtime = Number(data.mtime) || Number(info && info.mtime) || Date.now();
      try {
        fs.utimesSync(abs, mtime / 1000, mtime / 1000);
      } catch {
        /* 时间戳失败不影响内容 */
      }
      state[rel] = mtime;
      pulled += 1;
    } catch (err) {
      lastError = err.message || String(err);
    }
  }
  return pulled;
}

async function pushWork(work, state, remote) {
  const files = localFiles(work);
  let pushed = 0;
  for (const file of files) {
    const info = remote && remote[file.rel];
    const remoteMtime = info ? Number(info.mtime) || 0 : 0;
    const last = Number(state[file.rel]) || 0;
    const localMtime = Math.round(file.mtime);
    const unchangedLocally = last && Math.abs(localMtime - last) < 1200;
    const sameAsRemote = remoteMtime && Math.abs(localMtime - remoteMtime) < 1200;

    // 服务器上有更新的版本、而本地自上次同步后没动过 → 留给 pull 处理
    if (remoteMtime > localMtime + 1200 && unchangedLocally) continue;
    if (sameAsRemote) {
      state[file.rel] = localMtime;
      continue;
    }
    if (unchangedLocally) continue;

    const text = readText(file.abs, '');
    if (new TextEncoder().encode(text).length > MAX_PUSH_BYTES) continue;
    await request('/api/sync/file', {
      method: 'PUT',
      body: JSON.stringify({ work, path: file.rel, text, mtime: localMtime }),
    });
    state[file.rel] = localMtime;
    pushed += 1;
  }
  return pushed;
}

async function pullAllRemote(state) {
  const data = await request('/api/works');
  const works = Array.isArray(data.works) ? data.works : [];
  for (const work of works) {
    const name = work.name;
    if (!name) continue;
    if (!fs.existsSync(path.join(PROJECTS_ROOT, name, 'book.json'))) {
      // 新设备/新作品：整份拉下来
      const manifest = await request(`/api/sync/manifest?work=${encodeURIComponent(name)}`);
      state[name] = state[name] || {};
      await pullWork(name, state[name], manifest.files || {});
    }
  }
}

async function syncOnce(reason) {
  const cfg = config.get();
  if (!cfg.password) {
    setStatus('仅本地', 'idle');
    if (reason === 'manual' && typeof window.__mushuOpenSetup === 'function') window.__mushuOpenSetup();
    return { skipped: true };
  }
  setStatus('同步中…', 'syncing');
  const state = loadState();
  let pulled = 0;
  let pushed = 0;

  try {
    // 先补拉服务器上本地还没有的作品（换设备 / 桌面端新建）
    await pullAllRemote(state);

    for (const work of localWorks()) {
      const manifest = await request(`/api/sync/manifest?work=${encodeURIComponent(work)}`);
      const remote = manifest.files || {};
      state[work] = state[work] || {};
      pulled += await pullWork(work, state[work], remote);
      pushed += await pushWork(work, state[work], remote);
      saveState(state);
    }

    saveState(state);
    const at = new Date();
    lastError = '';
    await config.save({ lastSyncAt: at.toISOString() });
    setStatus(`已同步 ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`, 'ok');
    return { pulled, pushed, reason };
  } catch (err) {
    lastError = err && err.message ? err.message : String(err);
    setStatus('同步失败', 'error');
    if (reason !== 'auto') ui.toast('同步失败：' + lastError);
    return { error: lastError };
  }
}

function runSync(reason) {
  if (running) return running;
  running = (async () => {
    try {
      return await syncOnce(reason || 'auto');
    } finally {
      running = null;
    }
  })();
  return running;
}

function schedule(delayMs) {
  if (!config.get().autoSync) return;
  if (!config.get().password) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    runSync('auto');
  }, Number.isFinite(delayMs) ? delayMs : 8000);
}

function start() {
  window.__mushuSyncNow = () => runSync('manual');
  if (started) return;
  started = true;
  clearInterval(timer);
  timer = setInterval(() => runSync('auto'), SYNC_INTERVAL_MS);
  if (navigator.onLine) setTimeout(() => runSync('auto'), 2500);
  window.addEventListener('online', () => schedule(1500));
}

module.exports = { start, runSync, schedule, syncOnce };
