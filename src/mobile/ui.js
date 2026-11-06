'use strict';

/**
 * iPad 端的小型界面补丁：加载页、作品选择器、菜单、同步状态、首次连接向导。
 * 只补充桌面端没有的「移动端必需交互」，不改动原有页面结构。
 */

const fs = require('./shims/fs');
const path = require('./shims/path');
const { readText } = require('../main/services/fsutil');

const IOS_CLASS = 'is-ios';

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v != null) node.setAttribute(k, v);
  });
  (children || []).forEach((child) => {
    if (child == null) return;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  });
  return node;
}

function markIos() {
  document.body.classList.add(IOS_CLASS);
}

// ---------------- 加载页 ----------------

function ensureLoading() {
  let node = document.getElementById('mushu-ios-loading');
  if (node) return node;
  node = el('div', { id: 'mushu-ios-loading' }, [
    el('div', { class: 'mushu-ios-loading-card' }, [
      el('div', { class: 'mushu-ios-loading-logo', text: '墨枢' }),
      el('div', { class: 'mushu-ios-loading-text', id: 'mushu-ios-loading-text', text: '正在载入本地作品…' }),
    ]),
  ]);
  document.body.appendChild(node);
  return node;
}

function setLoading(text) {
  const node = ensureLoading();
  const label = node.querySelector('#mushu-ios-loading-text');
  if (label) label.textContent = text;
  node.classList.remove('hidden');
}

let loadingHidden = false;
function hideLoading() {
  if (loadingHidden) return;
  loadingHidden = true;
  const node = document.getElementById('mushu-ios-loading');
  if (node) {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 260);
  }
}

// ---------------- Toast ----------------

let toastTimer = null;
function toast(message, duration) {
  const text = String(message == null ? '' : message).trim();
  if (!text) return;
  let node = document.getElementById('mushu-ios-toast');
  if (!node) {
    node = el('div', { id: 'mushu-ios-toast' });
    document.body.appendChild(node);
  }
  node.textContent = text;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), Number(duration) || 2600);
}

// ---------------- 通用浮层 ----------------

function overlay(content, { onClose } = {}) {
  const mask = el('div', { class: 'mushu-ios-mask' });
  const sheet = el('div', { class: 'mushu-ios-sheet' }, [content]);
  mask.appendChild(sheet);
  const close = () => {
    mask.remove();
    if (onClose) onClose();
  };
  mask.addEventListener('click', (e) => {
    if (e.target === mask) close();
  });
  document.body.appendChild(mask);
  return { mask, sheet, close };
}

// ---------------- 作品选择器 ----------------

function listWorks(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const bookFile = path.join(dir, 'book.json');
    if (!fs.existsSync(bookFile)) continue;
    let book = {};
    try {
      book = JSON.parse(readText(bookFile, '{}'));
    } catch {
      book = {};
    }
    out.push({ dir, title: book.title || entry.name, at: fs.statSync(dir).mtimeMs });
  }
  out.sort((a, b) => b.at - a.at);
  return out;
}

function pickWorkDir(root) {
  return new Promise((resolve) => {
    const works = listWorks(root);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const list = el('div', { class: 'mushu-ios-work-list' });
    if (!works.length) {
      list.appendChild(el('div', { class: 'mushu-ios-empty', text: '还没有本地作品，先新建或从服务器同步一个吧' }));
    }
    for (const work of works) {
      list.appendChild(
        el('button', { class: 'mushu-ios-work', onclick: () => {
          finish(work.dir);
          ctx.close();
        } }, [
          el('span', { class: 'mushu-ios-work-title', text: work.title }),
          el('span', { class: 'mushu-ios-work-path', text: work.dir.replace('/mushu/works/', '') }),
        ])
      );
    }

    const cancel = el('button', { class: 'mushu-ios-btn ghost', text: '取消', onclick: () => {
      finish(null);
      ctx.close();
    } });
    const ctx = overlay(
      el('div', {}, [
        el('div', { class: 'mushu-ios-sheet-title', text: '选择作品' }),
        list,
        el('div', { class: 'mushu-ios-sheet-actions' }, [cancel]),
      ]),
      { onClose: () => finish(null) }
    );
  });
}

// ---------------- 菜单 ----------------

function hideMenus() {
  document.querySelectorAll('.mushu-ios-menu').forEach((n) => n.remove());
}

function showMenu(items, onPick) {
  hideMenus();
  const anchor = document.getElementById('menu-btn') || document.getElementById('titlebar');
  const rect = anchor ? anchor.getBoundingClientRect() : { left: 12, bottom: 48 };
  const menu = el('div', { class: 'mushu-ios-menu' });
  for (const item of items) {
    if (item.sep) {
      menu.appendChild(el('div', { class: 'mushu-ios-menu-sep' }));
      continue;
    }
    menu.appendChild(
      el('button', {
        class: 'mushu-ios-menu-item',
        text: item.label,
        onclick: () => {
          hideMenus();
          onPick(item.key);
        },
      })
    );
  }
  menu.style.left = Math.max(8, rect.left) + 'px';
  menu.style.top = Math.min(window.innerHeight - 60, rect.bottom + 6) + 'px';
  document.body.appendChild(menu);

  setTimeout(() => {
    const off = (e) => {
      if (!menu.contains(e.target)) {
        hideMenus();
        document.removeEventListener('pointerdown', off, true);
      }
    };
    document.addEventListener('pointerdown', off, true);
  }, 0);
}

// ---------------- 同步状态 ----------------

let syncNode = null;

function ensureSyncIndicator() {
  if (syncNode && document.body.contains(syncNode)) return syncNode;
  const bar = document.getElementById('statusbar') || document.getElementById('center');
  if (!bar) return null;
  syncNode = el('span', {
    id: 'mushu-ios-sync',
    class: 'mushu-ios-sync',
    title: '点按立即同步',
    onclick: () => {
      if (typeof window.__mushuSyncNow === 'function') window.__mushuSyncNow();
    },
  });
  bar.appendChild(syncNode);
  return syncNode;
}

function setSyncStatus(text, tone) {
  const node = ensureSyncIndicator();
  if (!node) return;
  node.textContent = text;
  node.dataset.tone = tone || 'idle';
}

// ---------------- 首次连接向导 ----------------

function showSetup({ baseUrl, password, autoSync, onSave, onSkip }) {
  return new Promise((resolve) => {
    const urlInput = el('input', { class: 'mushu-ios-input', type: 'url', value: baseUrl || '', placeholder: 'https://mushu.sfangjie.cn' });
    const pwdInput = el('input', { class: 'mushu-ios-input', type: 'password', value: password || '', placeholder: '服务器访问密码' });
    const auto = el('input', { type: 'checkbox' });
    auto.checked = autoSync !== false;
    const error = el('div', { class: 'mushu-ios-error' });

    const save = el('button', { class: 'mushu-ios-btn primary', text: '保存并继续' });
    const skip = el('button', { class: 'mushu-ios-btn ghost', text: '稍后设置（仅本地）' });

    const ctx = overlay(
      el('div', {}, [
        el('div', { class: 'mushu-ios-sheet-title', text: '连接你的墨枢服务器' }),
        el('div', { class: 'mushu-ios-sheet-desc', text: '作品优先存在 iPad 本地，再定时备份到服务器。AI 助手也由服务器转发。' }),
        el('label', { class: 'mushu-ios-field' }, [el('span', { text: '服务器地址' }), urlInput]),
        el('label', { class: 'mushu-ios-field' }, [el('span', { text: '访问密码' }), pwdInput]),
        el('label', { class: 'mushu-ios-check' }, [auto, el('span', { text: '允许自动同步' })]),
        error,
        el('div', { class: 'mushu-ios-sheet-actions' }, [skip, save]),
      ]),
      { onClose: () => resolve(false) }
    );

    save.onclick = async () => {
      error.textContent = '';
      save.disabled = true;
      try {
        await onSave({
          baseUrl: urlInput.value.trim(),
          password: pwdInput.value,
          autoSync: auto.checked,
        });
        ctx.close();
        resolve(true);
      } catch (err) {
        error.textContent = err && err.message ? err.message : String(err);
      } finally {
        save.disabled = false;
      }
    };
    skip.onclick = async () => {
      if (onSkip) await onSkip();
      ctx.close();
      resolve(false);
    };
  });
}

module.exports = {
  el,
  markIos,
  ensureLoading,
  setLoading,
  hideLoading,
  toast,
  pickWorkDir,
  showMenu,
  ensureSyncIndicator,
  setSyncStatus,
  showSetup,
};
