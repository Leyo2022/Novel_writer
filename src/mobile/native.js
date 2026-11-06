'use strict';

/**
 * Capacitor 能力入口。
 *
 * 注意：native-bridge 只提供桥本身，window.Capacitor.Plugins 是由各插件的 JS
 * 包装层调用 registerPlugin 之后才填充的。所以这里必须把插件包一起打进 bundle，
 * 其它模块统一从这里取，不要直接读 window.Capacitor.Plugins。
 */

let core = null;
let fsPlugin = null;
let preferencesPlugin = null;
let statusBarPlugin = null;
let keyboardPlugin = null;
let appPlugin = null;

try {
  core = require('@capacitor/core');
} catch {
  core = null;
}
try {
  fsPlugin = require('@capacitor/filesystem').Filesystem;
} catch {
  fsPlugin = null;
}
try {
  preferencesPlugin = require('@capacitor/preferences').Preferences;
} catch {
  preferencesPlugin = null;
}
try {
  statusBarPlugin = require('@capacitor/status-bar').StatusBar;
} catch {
  statusBarPlugin = null;
}
try {
  keyboardPlugin = require('@capacitor/keyboard').Keyboard;
} catch {
  keyboardPlugin = null;
}
try {
  appPlugin = require('@capacitor/app').App;
} catch {
  appPlugin = null;
}

function capacitor() {
  return (core && core.Capacitor) || (typeof window !== 'undefined' ? window.Capacitor : null) || null;
}

function platform() {
  const cap = capacitor();
  if (cap && typeof cap.getPlatform === 'function') return cap.getPlatform();
  return 'web';
}

function isNative() {
  const cap = capacitor();
  if (cap && typeof cap.isNativePlatform === 'function') return Boolean(cap.isNativePlatform());
  return false;
}

/** 兜底：万一插件包装层没打进 bundle，退回原生桥注入的全局代理 */
function fallback(name) {
  const cap = capacitor();
  return (cap && cap.Plugins && cap.Plugins[name]) || null;
}

function filesystem() {
  return fsPlugin || fallback('Filesystem');
}

function preferences() {
  return preferencesPlugin || fallback('Preferences');
}

function statusBar() {
  return statusBarPlugin || fallback('StatusBar');
}

function keyboard() {
  return keyboardPlugin || fallback('Keyboard');
}

function app() {
  return appPlugin || fallback('App');
}

module.exports = { capacitor, platform, isNative, filesystem, preferences, statusBar, keyboard, app };
