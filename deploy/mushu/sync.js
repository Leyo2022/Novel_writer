'use strict';

/**
 * 墨枢 · 桌面端双向同步脚本（在电脑上运行）
 *
 *   用法：
 *     node sync.js                  # 同步配置里的全部作品
 *     node sync.js 大奉无双          # 只同步指定作品
 *     node sync.js --dry            # 只看会改哪些文件，不实际写入
 *
 * 规则（按文件修改时间，新的一边覆盖旧的一边）：
 *   - 两边都有：mtime 差 <= 2 秒视为一致；否则较新的一侧覆盖较旧的一侧
 *   - 只有本地：上传；只有服务器：下载
 *   - 覆盖本地文件前，先备份到 作品目录/.sync-backup/<时间戳>/
 *   - 传输时会带上 mtime，两边写完都把 mtime 对齐，避免来回抖动
 *
 * 配置：同目录 sync.config.json（可从 sync.config.example.json 复制）
 *
 * 注意：删除不会自动同步（避免误删）；删除请两边手动处理。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const HERE = __dirname;
const CONFIG_PATH = path.join(HERE, 'sync.config.json');
const SKIP_DIRS = [['.mushu', 'versions'], ['.mushu', 'drafts'], ['.sync-backup']];
const TEXT_EXT = new Set(['.md', '.json', '.txt', '.yml', '.yaml', '.csv']);
const TOLERANCE_MS = 2000;

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`找不到配置文件：${CONFIG_PATH}\n请先复制 sync.config.example.json 为 sync.config.json 并填写。`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!cfg.baseUrl || !cfg.password || !Array.isArray(cfg.works)) {
    console.error('sync.config.json 需要 baseUrl / password / works 三个字段。');
    process.exit(1);
  }
  return cfg;
}

// ---------- HTTP ----------

function request(cfg, method, urlPath, body) {
  const u = new URL(urlPath, cfg.baseUrl);
  const lib = u.protocol === 'https:' ? https : http;
  const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
  const headers = { 'X-Mushu-Password': cfg.password };
  if (payload) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    headers['Content-Length'] = payload.length;
  }
  return new Promise((resolve, reject) => {
    const req = lib.request(
      { method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          try { resolve(text ? JSON.parse(text) : {}); } catch (e) { reject(new Error('响应不是 JSON：' + text.slice(0, 120))); }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------- 本地遍历 ----------

function isSkipped(relParts) {
  return SKIP_DIRS.some((skip) => skip.every((seg, i) => relParts[i] === seg) && relParts.length >= skip.length);
}

function walkLocal(root) {
  const out = {};
  const stack = [['', []]];
  while (stack.length) {
    const [dir, relParts] = stack.pop();
    const abs = path.join(root, dir);
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const parts = relParts.concat(e.name);
      if (e.isDirectory()) {
        if (isSkipped(parts)) continue;
        stack.push([path.join(dir, e.name), parts]);
      } else if (e.isFile()) {
        if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;
        const st = fs.statSync(path.join(abs, e.name));
        out[parts.join('/')] = { mtime: Math.round(st.mtimeMs), size: st.size };
      }
    }
  }
  return out;
}

// ---------- 同步一件作品 ----------

async function syncWork(cfg, work, dry) {
  const { name, localDir } = work;
  if (!fs.existsSync(localDir)) {
    console.log(`✗ [${name}] 本地目录不存在：${localDir}`);
    return { up: 0, down: 0, skip: 0, fail: 1 };
  }
  const manifest = (await request(cfg, 'GET', `/api/sync/manifest?work=${encodeURIComponent(name)}`)).files || {};
  const local = walkLocal(localDir);
  const rels = Array.from(new Set([...Object.keys(manifest), ...Object.keys(local)])).sort();

  const stat = { up: 0, down: 0, skip: 0, fail: 0 };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(localDir, '.sync-backup', stamp);
  const todo = [];

  for (const rel of rels) {
    const l = local[rel];
    const r = manifest[rel];
    if (l && r) {
      if (Math.abs(l.mtime - r.mtime) <= TOLERANCE_MS) { stat.skip += 1; continue; }
      todo.push({ rel, dir: l.mtime > r.mtime ? 'up' : 'down' });
    } else if (l) {
      todo.push({ rel, dir: 'up' });
    } else {
      todo.push({ rel, dir: 'down' });
    }
  }

  console.log(`\n[${name}] 本地 ${Object.keys(local).length} 个文件 / 服务器 ${Object.keys(manifest).length} 个文件 → 待处理 ${todo.length} 个`);
  if (!todo.length) { console.log('  已是最新'); return stat; }

  for (const { rel, dir } of todo) {
    const abs = path.join(localDir, ...rel.split('/'));
    try {
      if (dir === 'up') {
        const text = fs.readFileSync(abs, 'utf8');
        if (dry) { console.log(`  ↑ ${rel}`); stat.up += 1; continue; }
        await request(cfg, 'PUT', '/api/sync/file', { work: name, path: rel, text, mtime: local[rel].mtime });
        console.log(`  ↑ ${rel}`);
        stat.up += 1;
      } else {
        const res = await request(cfg, 'GET', `/api/sync/file?work=${encodeURIComponent(name)}&path=${encodeURIComponent(rel)}`);
        if (!res.exists) { console.log(`  ? ${rel}（服务器上已不存在，跳过）`); stat.fail += 1; continue; }
        if (dry) { console.log(`  ↓ ${rel}`); stat.down += 1; continue; }
        if (fs.existsSync(abs)) {
          const bak = path.join(backupDir, ...rel.split('/'));
          fs.mkdirSync(path.dirname(bak), { recursive: true });
          fs.copyFileSync(abs, bak);
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, res.text, 'utf8');
        const t = (res.mtime || Date.now()) / 1000;
        try { fs.utimesSync(abs, t, t); } catch { /* 对齐 mtime 失败无妨 */ }
        console.log(`  ↓ ${rel}`);
        stat.down += 1;
      }
    } catch (e) {
      console.log(`  ✗ ${rel}：${e.message}`);
      stat.fail += 1;
    }
  }
  if (stat.down && !dry) console.log(`  覆盖前的本地副本已备份到 ${backupDir}`);
  return stat;
}

// ---------- 入口 ----------

(async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const only = args.filter((a) => !a.startsWith('--'));
  const cfg = loadConfig();
  const works = only.length ? cfg.works.filter((w) => only.includes(w.name)) : cfg.works;
  if (!works.length) { console.error('没有匹配的作品：' + only.join(', ')); process.exit(1); }
  if (dry) console.log('（--dry：只预览，不写入）');

  const total = { up: 0, down: 0, skip: 0, fail: 0 };
  for (const w of works) {
    const s = await syncWork(cfg, w, dry);
    total.up += s.up; total.down += s.down; total.skip += s.skip; total.fail += s.fail;
  }
  console.log(`\n完成：上传 ${total.up} · 下载 ${total.down} · 跳过 ${total.skip} · 失败 ${total.fail}`);
  if (total.fail) process.exit(2);
})().catch((e) => { console.error('同步失败：' + e.message); process.exit(1); });
