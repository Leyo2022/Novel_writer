"use strict";
(() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };

  // src/mobile/shims/path.js
  var require_path = __commonJS({
    "src/mobile/shims/path.js"(exports, module) {
      "use strict";
      var sep = "/";
      function slashes(p) {
        return String(p == null ? "" : p).replace(/\\/g, "/");
      }
      function normalize(input) {
        const p = slashes(input);
        const abs = p.startsWith("/");
        const out = [];
        for (const seg of p.split("/")) {
          if (!seg || seg === ".") continue;
          if (seg === "..") {
            if (out.length && out[out.length - 1] !== "..") out.pop();
            else if (!abs) out.push("..");
            continue;
          }
          out.push(seg);
        }
        let s = out.join("/");
        if (abs) s = "/" + s;
        if (!s) s = abs ? "/" : ".";
        return s;
      }
      function join(...parts) {
        const list = parts.filter((p) => p != null && p !== "");
        return normalize(list.length ? list.join("/") : ".");
      }
      function resolve(...parts) {
        const list = parts.filter((p2) => p2 != null && p2 !== "");
        const p = list.length ? list.join("/") : "/";
        return normalize(p.startsWith("/") ? p : "/" + p);
      }
      function dirname(p) {
        const s = normalize(p);
        if (s === "/") return "/";
        const i = s.lastIndexOf("/");
        if (i < 0) return ".";
        if (i === 0) return "/";
        return s.slice(0, i);
      }
      function basename(p, ext) {
        const s = normalize(p);
        const name = s.slice(s.lastIndexOf("/") + 1);
        if (!name) return "";
        if (ext && name.endsWith(ext) && name.length > ext.length) return name.slice(0, -ext.length);
        return name;
      }
      function extname(p) {
        const name = basename(p);
        const i = name.lastIndexOf(".");
        if (i <= 0) return "";
        return name.slice(i);
      }
      function isAbsolute(p) {
        return slashes(p).startsWith("/");
      }
      function split(p) {
        return normalize(p).split("/").filter(Boolean);
      }
      function relative(from, to) {
        const a = split(resolve(from));
        const b = split(resolve(to));
        let i = 0;
        while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
        return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
      }
      module.exports = {
        sep,
        delimiter: ":",
        normalize,
        join,
        resolve,
        dirname,
        basename,
        extname,
        isAbsolute,
        relative
      };
    }
  });

  // src/mobile/shims/fs.js
  var require_fs = __commonJS({
    "src/mobile/shims/fs.js"(exports, module) {
      "use strict";
      var path = require_path();
      var EPOCH = Date.UTC(2020, 0, 1);
      var nodes = /* @__PURE__ */ new Map();
      nodes.set("/", { type: "dir", data: "", mtime: Date.now() });
      var changeHook = null;
      function setChangeHook(fn) {
        changeHook = typeof fn === "function" ? fn : null;
      }
      function emit(p, kind) {
        if (changeHook) {
          try {
            changeHook(p, kind);
          } catch {
          }
        }
      }
      function enoent(p) {
        const err = new Error(`ENOENT: no such file or directory, '${p}'`);
        err.code = "ENOENT";
        return err;
      }
      function enotdir(p) {
        const err = new Error(`ENOTDIR: not a directory, '${p}'`);
        err.code = "ENOTDIR";
        return err;
      }
      function normalize(p) {
        return path.normalize(String(p == null ? "" : p));
      }
      function parentOf(p) {
        return path.dirname(normalize(p));
      }
      function ensureParents(p) {
        const parts = normalize(p).split("/").filter(Boolean);
        let cur = "";
        for (let i = 0; i < parts.length - 1; i += 1) {
          cur += "/" + parts[i];
          const node = nodes.get(cur);
          if (!node) {
            nodes.set(cur, { type: "dir", data: "", mtime: Date.now() });
            emit(cur, "dir");
          } else if (node.type !== "dir") throw enotdir(cur);
        }
      }
      function existsSync(p) {
        return nodes.has(normalize(p));
      }
      function statSync(p) {
        const key = normalize(p);
        const node = nodes.get(key);
        if (!node) throw enoent(key);
        const mtime = new Date(node.mtime);
        return {
          size: node.type === "file" ? new TextEncoder().encode(node.data).length : 0,
          mtime,
          mtimeMs: node.mtime,
          ctime: mtime,
          birthtime: mtime,
          isFile: () => node.type === "file",
          isDirectory: () => node.type === "dir"
        };
      }
      function lstatSync(p) {
        return statSync(p);
      }
      function encodeUtf8(text) {
        return new TextEncoder().encode(String(text == null ? "" : text));
      }
      function readFileSync(p, encoding) {
        const key = normalize(p);
        const node = nodes.get(key);
        if (!node || node.type !== "file") throw enoent(key);
        if (encoding) {
          if (String(encoding).toLowerCase().replace("-", "") === "utf8") return node.data;
          return node.data;
        }
        return makeBuffer(encodeUtf8(node.data));
      }
      function writeFileSync(p, data, encoding) {
        const key = normalize(p);
        ensureParents(key);
        const text = typeof data === "string" ? data : decodeBytes(data);
        nodes.set(key, { type: "file", data: text, mtime: Date.now() });
        emit(key, "put");
      }
      function decodeBytes(data) {
        if (!data) return "";
        if (typeof data === "string") return data;
        if (data.bytes) return new TextDecoder("utf-8").decode(new Uint8Array(data.bytes));
        if (data instanceof Uint8Array) return new TextDecoder("utf-8").decode(data);
        if (data instanceof ArrayBuffer) return new TextDecoder("utf-8").decode(new Uint8Array(data));
        return String(data);
      }
      function mkdirSync(p, options) {
        const recursive = options && options.recursive;
        const key = normalize(p);
        if (key === "/") return;
        if (nodes.has(key)) {
          if (nodes.get(key).type !== "dir") {
            const err = new Error(`EEXIST: file already exists, '${key}'`);
            err.code = "EEXIST";
            throw err;
          }
          return;
        }
        if (recursive) {
          ensureParents(key);
          nodes.set(key, { type: "dir", data: "", mtime: Date.now() });
          emit(key, "dir");
          return;
        }
        const parent = parentOf(key);
        if (!nodes.has(parent)) throw enoent(parent);
        nodes.set(key, { type: "dir", data: "", mtime: Date.now() });
        emit(key, "dir");
      }
      function readdirSync(p, options) {
        const key = normalize(p);
        const node = nodes.get(key);
        if (!node) throw enoent(key);
        if (node.type !== "dir") throw enotdir(key);
        const prefix = key === "/" ? "/" : key + "/";
        const names = [];
        for (const k of nodes.keys()) {
          if (k === key || !k.startsWith(prefix)) continue;
          const rest = k.slice(prefix.length);
          if (!rest || rest.includes("/")) continue;
          names.push({ name: rest, key: k });
        }
        names.sort((a, b) => a.name.localeCompare(b.name));
        if (options && options.withFileTypes) {
          return names.map(({ name, key: full }) => {
            const child = nodes.get(full);
            return {
              name,
              isFile: () => child.type === "file",
              isDirectory: () => child.type === "dir",
              isSymbolicLink: () => false
            };
          });
        }
        return names.map((n) => n.name);
      }
      function renameSync(from, to) {
        const src = normalize(from);
        const dst = normalize(to);
        const node = nodes.get(src);
        if (!node) throw enoent(src);
        if (src === dst) return;
        ensureParents(dst);
        const old = nodes.get(dst);
        if (old && old.type === "dir" && node.type === "file") {
          const err = new Error(`EISDIR: illegal operation on a directory, rename '${src}'`);
          err.code = "EISDIR";
          throw err;
        }
        if (old && old.type === "file" && node.type === "dir") {
          const err = new Error(`ENOTDIR: not a directory, rename '${dst}'`);
          err.code = "ENOTDIR";
          throw err;
        }
        if (node.type === "file") {
          nodes.delete(src);
          nodes.set(dst, node);
          emit(src, "delete");
          emit(dst, "put");
          return;
        }
        const prefix = src === "/" ? "/" : src + "/";
        const moved = [];
        for (const k of [...nodes.keys()]) {
          if (k !== src && !k.startsWith(prefix)) continue;
          moved.push([k, nodes.get(k)]);
        }
        for (const [k] of moved) nodes.delete(k);
        for (const [k, value] of moved) {
          const next = dst + k.slice(src.length);
          nodes.set(next, value);
          emit(next, value.type === "file" ? "put" : "dir");
        }
        emit(src, "delete");
      }
      function unlinkSync(p) {
        const key = normalize(p);
        const node = nodes.get(key);
        if (!node) throw enoent(key);
        if (node.type === "dir") {
          const err = new Error(`EISDIR: illegal operation on a directory, unlink '${key}'`);
          err.code = "EISDIR";
          throw err;
        }
        nodes.delete(key);
        emit(key, "delete");
      }
      function rmdirSync(p) {
        const key = normalize(p);
        const node = nodes.get(key);
        if (!node) throw enoent(key);
        if (node.type !== "dir") throw enotdir(key);
        const prefix = key === "/" ? "/" : key + "/";
        for (const k of nodes.keys()) {
          if (k !== key && k.startsWith(prefix)) {
            const err = new Error(`ENOTEMPTY: directory not empty, rmdir '${key}'`);
            err.code = "ENOTEMPTY";
            throw err;
          }
        }
        nodes.delete(key);
        emit(key, "delete");
      }
      function rmSync(p, options) {
        const key = normalize(p);
        if (!nodes.has(key)) {
          if (options && options.force) return;
          throw enoent(key);
        }
        const prefix = key === "/" ? "/" : key + "/";
        for (const k of [...nodes.keys()]) {
          if (k === key || k.startsWith(prefix)) nodes.delete(k);
        }
        emit(key, "delete");
      }
      function copyFileSync(from, to) {
        const src = normalize(from);
        const node = nodes.get(src);
        if (!node || node.type !== "file") throw enoent(src);
        const dst = normalize(to);
        ensureParents(dst);
        nodes.set(dst, { type: "file", data: node.data, mtime: Date.now() });
        emit(dst, "put");
      }
      function utimesSync(p, atime, mtime) {
        const key = normalize(p);
        const node = nodes.get(key);
        if (!node) throw enoent(key);
        const t = Number(mtime);
        node.mtime = Number.isFinite(t) ? t > 1e12 ? t : t * 1e3 : Date.now();
        if (node.type === "file") emit(key, "put");
      }
      var Buf = class _Buf extends Uint8Array {
        static isBuffer(value) {
          return value instanceof _Buf;
        }
        static from(value) {
          if (typeof value === "string") return new _Buf(encodeUtf8(value));
          if (value instanceof Uint8Array) return new _Buf(value);
          if (value instanceof ArrayBuffer) return new _Buf(new Uint8Array(value));
          return new _Buf(0);
        }
        subarray(begin, end) {
          return new _Buf(super.subarray(begin, end));
        }
        toString(encoding) {
          const enc = String(encoding || "utf8").toLowerCase();
          if (enc === "utf16le" || enc === "ucs2" || enc === "utf-16le") {
            const view = new Uint8Array(this);
            let out = "";
            for (let i = 0; i + 1 < view.length; i += 2) out += String.fromCharCode(view[i] | view[i + 1] << 8);
            return out;
          }
          return new TextDecoder("utf-8").decode(this);
        }
      };
      function makeBuffer(bytes) {
        return new Buf(bytes);
      }
      function installBuffer() {
        if (!globalThis.Buffer) globalThis.Buffer = Buf;
      }
      function loadEntries(entries) {
        nodes.clear();
        nodes.set("/", { type: "dir", data: "", mtime: Date.now() });
        const list = (entries || []).map((item) => ({ ...item, path: normalize(item.path) })).sort((a, b) => a.path.length - b.path.length);
        for (const item of list) {
          const key = item.path;
          if (!key || key === "/") continue;
          ensureParents(key);
          if (item.type === "dir") {
            nodes.set(key, { type: "dir", data: "", mtime: item.mtime || Date.now() });
          } else {
            nodes.set(key, { type: "file", data: String(item.data == null ? "" : item.data), mtime: item.mtime || Date.now() });
          }
        }
      }
      function* allEntries() {
        for (const [key, node] of nodes) {
          if (key === "/") continue;
          yield { path: key, type: node.type, data: node.data, mtime: node.mtime };
        }
      }
      function getNode(p) {
        return nodes.get(normalize(p)) || null;
      }
      module.exports = {
        // node:fs 兼容接口
        existsSync,
        statSync,
        lstatSync,
        readFileSync,
        writeFileSync,
        mkdirSync,
        readdirSync,
        renameSync,
        unlinkSync,
        rmdirSync,
        rmSync,
        copyFileSync,
        utimesSync,
        constants: { F_OK: 0 },
        // 内部接口
        setChangeHook,
        loadEntries,
        allEntries,
        getNode,
        installBuffer,
        Buf
      };
    }
  });

  // mobile/node_modules/@capacitor/core/dist/index.cjs.js
  var require_index_cjs = __commonJS({
    "mobile/node_modules/@capacitor/core/dist/index.cjs.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      var createCapacitorPlatforms = (win) => {
        const defaultPlatformMap = /* @__PURE__ */ new Map();
        defaultPlatformMap.set("web", { name: "web" });
        const capPlatforms = win.CapacitorPlatforms || {
          currentPlatform: { name: "web" },
          platforms: defaultPlatformMap
        };
        const addPlatform2 = (name, platform) => {
          capPlatforms.platforms.set(name, platform);
        };
        const setPlatform2 = (name) => {
          if (capPlatforms.platforms.has(name)) {
            capPlatforms.currentPlatform = capPlatforms.platforms.get(name);
          }
        };
        capPlatforms.addPlatform = addPlatform2;
        capPlatforms.setPlatform = setPlatform2;
        return capPlatforms;
      };
      var initPlatforms = (win) => win.CapacitorPlatforms = createCapacitorPlatforms(win);
      var CapacitorPlatforms = /* @__PURE__ */ initPlatforms(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : {});
      var addPlatform = CapacitorPlatforms.addPlatform;
      var setPlatform = CapacitorPlatforms.setPlatform;
      var legacyRegisterWebPlugin = (cap, webPlugin) => {
        var _a;
        const config2 = webPlugin.config;
        const Plugins2 = cap.Plugins;
        if (!(config2 === null || config2 === void 0 ? void 0 : config2.name)) {
          throw new Error(`Capacitor WebPlugin is using the deprecated "registerWebPlugin()" function, but without the config. Please use "registerPlugin()" instead to register this web plugin."`);
        }
        console.warn(`Capacitor plugin "${config2.name}" is using the deprecated "registerWebPlugin()" function`);
        if (!Plugins2[config2.name] || ((_a = config2 === null || config2 === void 0 ? void 0 : config2.platforms) === null || _a === void 0 ? void 0 : _a.includes(cap.getPlatform()))) {
          Plugins2[config2.name] = webPlugin;
        }
      };
      exports.ExceptionCode = void 0;
      (function(ExceptionCode) {
        ExceptionCode["Unimplemented"] = "UNIMPLEMENTED";
        ExceptionCode["Unavailable"] = "UNAVAILABLE";
      })(exports.ExceptionCode || (exports.ExceptionCode = {}));
      var CapacitorException = class extends Error {
        constructor(message, code, data) {
          super(message);
          this.message = message;
          this.code = code;
          this.data = data;
        }
      };
      var getPlatformId = (win) => {
        var _a, _b;
        if (win === null || win === void 0 ? void 0 : win.androidBridge) {
          return "android";
        } else if ((_b = (_a = win === null || win === void 0 ? void 0 : win.webkit) === null || _a === void 0 ? void 0 : _a.messageHandlers) === null || _b === void 0 ? void 0 : _b.bridge) {
          return "ios";
        } else {
          return "web";
        }
      };
      var createCapacitor = (win) => {
        var _a, _b, _c, _d, _e;
        const capCustomPlatform = win.CapacitorCustomPlatform || null;
        const cap = win.Capacitor || {};
        const Plugins2 = cap.Plugins = cap.Plugins || {};
        const capPlatforms = win.CapacitorPlatforms;
        const defaultGetPlatform = () => {
          return capCustomPlatform !== null ? capCustomPlatform.name : getPlatformId(win);
        };
        const getPlatform = ((_a = capPlatforms === null || capPlatforms === void 0 ? void 0 : capPlatforms.currentPlatform) === null || _a === void 0 ? void 0 : _a.getPlatform) || defaultGetPlatform;
        const defaultIsNativePlatform = () => getPlatform() !== "web";
        const isNativePlatform = ((_b = capPlatforms === null || capPlatforms === void 0 ? void 0 : capPlatforms.currentPlatform) === null || _b === void 0 ? void 0 : _b.isNativePlatform) || defaultIsNativePlatform;
        const defaultIsPluginAvailable = (pluginName) => {
          const plugin = registeredPlugins.get(pluginName);
          if (plugin === null || plugin === void 0 ? void 0 : plugin.platforms.has(getPlatform())) {
            return true;
          }
          if (getPluginHeader(pluginName)) {
            return true;
          }
          return false;
        };
        const isPluginAvailable = ((_c = capPlatforms === null || capPlatforms === void 0 ? void 0 : capPlatforms.currentPlatform) === null || _c === void 0 ? void 0 : _c.isPluginAvailable) || defaultIsPluginAvailable;
        const defaultGetPluginHeader = (pluginName) => {
          var _a2;
          return (_a2 = cap.PluginHeaders) === null || _a2 === void 0 ? void 0 : _a2.find((h) => h.name === pluginName);
        };
        const getPluginHeader = ((_d = capPlatforms === null || capPlatforms === void 0 ? void 0 : capPlatforms.currentPlatform) === null || _d === void 0 ? void 0 : _d.getPluginHeader) || defaultGetPluginHeader;
        const handleError = (err) => win.console.error(err);
        const pluginMethodNoop = (_target, prop, pluginName) => {
          return Promise.reject(`${pluginName} does not have an implementation of "${prop}".`);
        };
        const registeredPlugins = /* @__PURE__ */ new Map();
        const defaultRegisterPlugin = (pluginName, jsImplementations = {}) => {
          const registeredPlugin = registeredPlugins.get(pluginName);
          if (registeredPlugin) {
            console.warn(`Capacitor plugin "${pluginName}" already registered. Cannot register plugins twice.`);
            return registeredPlugin.proxy;
          }
          const platform = getPlatform();
          const pluginHeader = getPluginHeader(pluginName);
          let jsImplementation;
          const loadPluginImplementation = async () => {
            if (!jsImplementation && platform in jsImplementations) {
              jsImplementation = typeof jsImplementations[platform] === "function" ? jsImplementation = await jsImplementations[platform]() : jsImplementation = jsImplementations[platform];
            } else if (capCustomPlatform !== null && !jsImplementation && "web" in jsImplementations) {
              jsImplementation = typeof jsImplementations["web"] === "function" ? jsImplementation = await jsImplementations["web"]() : jsImplementation = jsImplementations["web"];
            }
            return jsImplementation;
          };
          const createPluginMethod = (impl, prop) => {
            var _a2, _b2;
            if (pluginHeader) {
              const methodHeader = pluginHeader === null || pluginHeader === void 0 ? void 0 : pluginHeader.methods.find((m) => prop === m.name);
              if (methodHeader) {
                if (methodHeader.rtype === "promise") {
                  return (options) => cap.nativePromise(pluginName, prop.toString(), options);
                } else {
                  return (options, callback) => cap.nativeCallback(pluginName, prop.toString(), options, callback);
                }
              } else if (impl) {
                return (_a2 = impl[prop]) === null || _a2 === void 0 ? void 0 : _a2.bind(impl);
              }
            } else if (impl) {
              return (_b2 = impl[prop]) === null || _b2 === void 0 ? void 0 : _b2.bind(impl);
            } else {
              throw new CapacitorException(`"${pluginName}" plugin is not implemented on ${platform}`, exports.ExceptionCode.Unimplemented);
            }
          };
          const createPluginMethodWrapper = (prop) => {
            let remove;
            const wrapper = (...args) => {
              const p = loadPluginImplementation().then((impl) => {
                const fn = createPluginMethod(impl, prop);
                if (fn) {
                  const p2 = fn(...args);
                  remove = p2 === null || p2 === void 0 ? void 0 : p2.remove;
                  return p2;
                } else {
                  throw new CapacitorException(`"${pluginName}.${prop}()" is not implemented on ${platform}`, exports.ExceptionCode.Unimplemented);
                }
              });
              if (prop === "addListener") {
                p.remove = async () => remove();
              }
              return p;
            };
            wrapper.toString = () => `${prop.toString()}() { [capacitor code] }`;
            Object.defineProperty(wrapper, "name", {
              value: prop,
              writable: false,
              configurable: false
            });
            return wrapper;
          };
          const addListener = createPluginMethodWrapper("addListener");
          const removeListener = createPluginMethodWrapper("removeListener");
          const addListenerNative = (eventName, callback) => {
            const call = addListener({ eventName }, callback);
            const remove = async () => {
              const callbackId = await call;
              removeListener({
                eventName,
                callbackId
              }, callback);
            };
            const p = new Promise((resolve) => call.then(() => resolve({ remove })));
            p.remove = async () => {
              console.warn(`Using addListener() without 'await' is deprecated.`);
              await remove();
            };
            return p;
          };
          const proxy = new Proxy({}, {
            get(_, prop) {
              switch (prop) {
                // https://github.com/facebook/react/issues/20030
                case "$$typeof":
                  return void 0;
                case "toJSON":
                  return () => ({});
                case "addListener":
                  return pluginHeader ? addListenerNative : addListener;
                case "removeListener":
                  return removeListener;
                default:
                  return createPluginMethodWrapper(prop);
              }
            }
          });
          Plugins2[pluginName] = proxy;
          registeredPlugins.set(pluginName, {
            name: pluginName,
            proxy,
            platforms: /* @__PURE__ */ new Set([
              ...Object.keys(jsImplementations),
              ...pluginHeader ? [platform] : []
            ])
          });
          return proxy;
        };
        const registerPlugin2 = ((_e = capPlatforms === null || capPlatforms === void 0 ? void 0 : capPlatforms.currentPlatform) === null || _e === void 0 ? void 0 : _e.registerPlugin) || defaultRegisterPlugin;
        if (!cap.convertFileSrc) {
          cap.convertFileSrc = (filePath) => filePath;
        }
        cap.getPlatform = getPlatform;
        cap.handleError = handleError;
        cap.isNativePlatform = isNativePlatform;
        cap.isPluginAvailable = isPluginAvailable;
        cap.pluginMethodNoop = pluginMethodNoop;
        cap.registerPlugin = registerPlugin2;
        cap.Exception = CapacitorException;
        cap.DEBUG = !!cap.DEBUG;
        cap.isLoggingEnabled = !!cap.isLoggingEnabled;
        cap.platform = cap.getPlatform();
        cap.isNative = cap.isNativePlatform();
        return cap;
      };
      var initCapacitorGlobal = (win) => win.Capacitor = createCapacitor(win);
      var Capacitor = /* @__PURE__ */ initCapacitorGlobal(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : {});
      var registerPlugin = Capacitor.registerPlugin;
      var Plugins = Capacitor.Plugins;
      var registerWebPlugin = (plugin) => legacyRegisterWebPlugin(Capacitor, plugin);
      var WebPlugin = class {
        constructor(config2) {
          this.listeners = {};
          this.retainedEventArguments = {};
          this.windowListeners = {};
          if (config2) {
            console.warn(`Capacitor WebPlugin "${config2.name}" config object was deprecated in v3 and will be removed in v4.`);
            this.config = config2;
          }
        }
        addListener(eventName, listenerFunc) {
          let firstListener = false;
          const listeners = this.listeners[eventName];
          if (!listeners) {
            this.listeners[eventName] = [];
            firstListener = true;
          }
          this.listeners[eventName].push(listenerFunc);
          const windowListener = this.windowListeners[eventName];
          if (windowListener && !windowListener.registered) {
            this.addWindowListener(windowListener);
          }
          if (firstListener) {
            this.sendRetainedArgumentsForEvent(eventName);
          }
          const remove = async () => this.removeListener(eventName, listenerFunc);
          const p = Promise.resolve({ remove });
          return p;
        }
        async removeAllListeners() {
          this.listeners = {};
          for (const listener in this.windowListeners) {
            this.removeWindowListener(this.windowListeners[listener]);
          }
          this.windowListeners = {};
        }
        notifyListeners(eventName, data, retainUntilConsumed) {
          const listeners = this.listeners[eventName];
          if (!listeners) {
            if (retainUntilConsumed) {
              let args = this.retainedEventArguments[eventName];
              if (!args) {
                args = [];
              }
              args.push(data);
              this.retainedEventArguments[eventName] = args;
            }
            return;
          }
          listeners.forEach((listener) => listener(data));
        }
        hasListeners(eventName) {
          return !!this.listeners[eventName].length;
        }
        registerWindowListener(windowEventName, pluginEventName) {
          this.windowListeners[pluginEventName] = {
            registered: false,
            windowEventName,
            pluginEventName,
            handler: (event) => {
              this.notifyListeners(pluginEventName, event);
            }
          };
        }
        unimplemented(msg = "not implemented") {
          return new Capacitor.Exception(msg, exports.ExceptionCode.Unimplemented);
        }
        unavailable(msg = "not available") {
          return new Capacitor.Exception(msg, exports.ExceptionCode.Unavailable);
        }
        async removeListener(eventName, listenerFunc) {
          const listeners = this.listeners[eventName];
          if (!listeners) {
            return;
          }
          const index = listeners.indexOf(listenerFunc);
          this.listeners[eventName].splice(index, 1);
          if (!this.listeners[eventName].length) {
            this.removeWindowListener(this.windowListeners[eventName]);
          }
        }
        addWindowListener(handle) {
          window.addEventListener(handle.windowEventName, handle.handler);
          handle.registered = true;
        }
        removeWindowListener(handle) {
          if (!handle) {
            return;
          }
          window.removeEventListener(handle.windowEventName, handle.handler);
          handle.registered = false;
        }
        sendRetainedArgumentsForEvent(eventName) {
          const args = this.retainedEventArguments[eventName];
          if (!args) {
            return;
          }
          delete this.retainedEventArguments[eventName];
          args.forEach((arg) => {
            this.notifyListeners(eventName, arg);
          });
        }
      };
      var WebView = /* @__PURE__ */ registerPlugin("WebView");
      var encode = (str) => encodeURIComponent(str).replace(/%(2[346B]|5E|60|7C)/g, decodeURIComponent).replace(/[()]/g, escape);
      var decode = (str) => str.replace(/(%[\dA-F]{2})+/gi, decodeURIComponent);
      var CapacitorCookiesPluginWeb = class extends WebPlugin {
        async getCookies() {
          const cookies = document.cookie;
          const cookieMap = {};
          cookies.split(";").forEach((cookie) => {
            if (cookie.length <= 0)
              return;
            let [key, value] = cookie.replace(/=/, "CAP_COOKIE").split("CAP_COOKIE");
            key = decode(key).trim();
            value = decode(value).trim();
            cookieMap[key] = value;
          });
          return cookieMap;
        }
        async setCookie(options) {
          try {
            const encodedKey = encode(options.key);
            const encodedValue = encode(options.value);
            const expires = `; expires=${(options.expires || "").replace("expires=", "")}`;
            const path = (options.path || "/").replace("path=", "");
            const domain = options.url != null && options.url.length > 0 ? `domain=${options.url}` : "";
            document.cookie = `${encodedKey}=${encodedValue || ""}${expires}; path=${path}; ${domain};`;
          } catch (error) {
            return Promise.reject(error);
          }
        }
        async deleteCookie(options) {
          try {
            document.cookie = `${options.key}=; Max-Age=0`;
          } catch (error) {
            return Promise.reject(error);
          }
        }
        async clearCookies() {
          try {
            const cookies = document.cookie.split(";") || [];
            for (const cookie of cookies) {
              document.cookie = cookie.replace(/^ +/, "").replace(/=.*/, `=;expires=${(/* @__PURE__ */ new Date()).toUTCString()};path=/`);
            }
          } catch (error) {
            return Promise.reject(error);
          }
        }
        async clearAllCookies() {
          try {
            await this.clearCookies();
          } catch (error) {
            return Promise.reject(error);
          }
        }
      };
      var CapacitorCookies = registerPlugin("CapacitorCookies", {
        web: () => new CapacitorCookiesPluginWeb()
      });
      var readBlobAsBase64 = async (blob) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const base64String = reader.result;
          resolve(base64String.indexOf(",") >= 0 ? base64String.split(",")[1] : base64String);
        };
        reader.onerror = (error) => reject(error);
        reader.readAsDataURL(blob);
      });
      var normalizeHttpHeaders = (headers = {}) => {
        const originalKeys = Object.keys(headers);
        const loweredKeys = Object.keys(headers).map((k) => k.toLocaleLowerCase());
        const normalized = loweredKeys.reduce((acc, key, index) => {
          acc[key] = headers[originalKeys[index]];
          return acc;
        }, {});
        return normalized;
      };
      var buildUrlParams = (params, shouldEncode = true) => {
        if (!params)
          return null;
        const output = Object.entries(params).reduce((accumulator, entry) => {
          const [key, value] = entry;
          let encodedValue;
          let item;
          if (Array.isArray(value)) {
            item = "";
            value.forEach((str) => {
              encodedValue = shouldEncode ? encodeURIComponent(str) : str;
              item += `${key}=${encodedValue}&`;
            });
            item.slice(0, -1);
          } else {
            encodedValue = shouldEncode ? encodeURIComponent(value) : value;
            item = `${key}=${encodedValue}`;
          }
          return `${accumulator}&${item}`;
        }, "");
        return output.substr(1);
      };
      var buildRequestInit = (options, extra = {}) => {
        const output = Object.assign({ method: options.method || "GET", headers: options.headers }, extra);
        const headers = normalizeHttpHeaders(options.headers);
        const type = headers["content-type"] || "";
        if (typeof options.data === "string") {
          output.body = options.data;
        } else if (type.includes("application/x-www-form-urlencoded")) {
          const params = new URLSearchParams();
          for (const [key, value] of Object.entries(options.data || {})) {
            params.set(key, value);
          }
          output.body = params.toString();
        } else if (type.includes("multipart/form-data") || options.data instanceof FormData) {
          const form = new FormData();
          if (options.data instanceof FormData) {
            options.data.forEach((value, key) => {
              form.append(key, value);
            });
          } else {
            for (const key of Object.keys(options.data)) {
              form.append(key, options.data[key]);
            }
          }
          output.body = form;
          const headers2 = new Headers(output.headers);
          headers2.delete("content-type");
          output.headers = headers2;
        } else if (type.includes("application/json") || typeof options.data === "object") {
          output.body = JSON.stringify(options.data);
        }
        return output;
      };
      var CapacitorHttpPluginWeb = class extends WebPlugin {
        /**
         * Perform an Http request given a set of options
         * @param options Options to build the HTTP request
         */
        async request(options) {
          const requestInit = buildRequestInit(options, options.webFetchExtra);
          const urlParams = buildUrlParams(options.params, options.shouldEncodeUrlParams);
          const url = urlParams ? `${options.url}?${urlParams}` : options.url;
          const response = await fetch(url, requestInit);
          const contentType = response.headers.get("content-type") || "";
          let { responseType = "text" } = response.ok ? options : {};
          if (contentType.includes("application/json")) {
            responseType = "json";
          }
          let data;
          let blob;
          switch (responseType) {
            case "arraybuffer":
            case "blob":
              blob = await response.blob();
              data = await readBlobAsBase64(blob);
              break;
            case "json":
              data = await response.json();
              break;
            case "document":
            case "text":
            default:
              data = await response.text();
          }
          const headers = {};
          response.headers.forEach((value, key) => {
            headers[key] = value;
          });
          return {
            data,
            headers,
            status: response.status,
            url: response.url
          };
        }
        /**
         * Perform an Http GET request given a set of options
         * @param options Options to build the HTTP request
         */
        async get(options) {
          return this.request(Object.assign(Object.assign({}, options), { method: "GET" }));
        }
        /**
         * Perform an Http POST request given a set of options
         * @param options Options to build the HTTP request
         */
        async post(options) {
          return this.request(Object.assign(Object.assign({}, options), { method: "POST" }));
        }
        /**
         * Perform an Http PUT request given a set of options
         * @param options Options to build the HTTP request
         */
        async put(options) {
          return this.request(Object.assign(Object.assign({}, options), { method: "PUT" }));
        }
        /**
         * Perform an Http PATCH request given a set of options
         * @param options Options to build the HTTP request
         */
        async patch(options) {
          return this.request(Object.assign(Object.assign({}, options), { method: "PATCH" }));
        }
        /**
         * Perform an Http DELETE request given a set of options
         * @param options Options to build the HTTP request
         */
        async delete(options) {
          return this.request(Object.assign(Object.assign({}, options), { method: "DELETE" }));
        }
      };
      var CapacitorHttp = registerPlugin("CapacitorHttp", {
        web: () => new CapacitorHttpPluginWeb()
      });
      exports.Capacitor = Capacitor;
      exports.CapacitorCookies = CapacitorCookies;
      exports.CapacitorException = CapacitorException;
      exports.CapacitorHttp = CapacitorHttp;
      exports.CapacitorPlatforms = CapacitorPlatforms;
      exports.Plugins = Plugins;
      exports.WebPlugin = WebPlugin;
      exports.WebView = WebView;
      exports.addPlatform = addPlatform;
      exports.buildRequestInit = buildRequestInit;
      exports.registerPlugin = registerPlugin;
      exports.registerWebPlugin = registerWebPlugin;
      exports.setPlatform = setPlatform;
    }
  });

  // mobile/node_modules/@capacitor/filesystem/dist/plugin.cjs.js
  var require_plugin_cjs = __commonJS({
    "mobile/node_modules/@capacitor/filesystem/dist/plugin.cjs.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      var core = require_index_cjs();
      exports.Directory = void 0;
      (function(Directory) {
        Directory["Documents"] = "DOCUMENTS";
        Directory["Data"] = "DATA";
        Directory["Library"] = "LIBRARY";
        Directory["Cache"] = "CACHE";
        Directory["External"] = "EXTERNAL";
        Directory["ExternalStorage"] = "EXTERNAL_STORAGE";
      })(exports.Directory || (exports.Directory = {}));
      exports.Encoding = void 0;
      (function(Encoding) {
        Encoding["UTF8"] = "utf8";
        Encoding["ASCII"] = "ascii";
        Encoding["UTF16"] = "utf16";
      })(exports.Encoding || (exports.Encoding = {}));
      var FilesystemDirectory = exports.Directory;
      var FilesystemEncoding = exports.Encoding;
      var Filesystem = core.registerPlugin("Filesystem", {
        web: () => Promise.resolve().then(function() {
          return web;
        }).then((m) => new m.FilesystemWeb())
      });
      function resolve(path) {
        const posix = path.split("/").filter((item) => item !== ".");
        const newPosix = [];
        posix.forEach((item) => {
          if (item === ".." && newPosix.length > 0 && newPosix[newPosix.length - 1] !== "..") {
            newPosix.pop();
          } else {
            newPosix.push(item);
          }
        });
        return newPosix.join("/");
      }
      function isPathParent(parent, children) {
        parent = resolve(parent);
        children = resolve(children);
        const pathsA = parent.split("/");
        const pathsB = children.split("/");
        return parent !== children && pathsA.every((value, index) => value === pathsB[index]);
      }
      var FilesystemWeb = class _FilesystemWeb extends core.WebPlugin {
        constructor() {
          super(...arguments);
          this.DB_VERSION = 1;
          this.DB_NAME = "Disc";
          this._writeCmds = ["add", "put", "delete"];
          this.downloadFile = async (options) => {
            var _a, _b;
            const requestInit = core.buildRequestInit(options, options.webFetchExtra);
            const response = await fetch(options.url, requestInit);
            let blob;
            if (!options.progress)
              blob = await response.blob();
            else if (!(response === null || response === void 0 ? void 0 : response.body))
              blob = new Blob();
            else {
              const reader = response.body.getReader();
              let bytes = 0;
              const chunks = [];
              const contentType = response.headers.get("content-type");
              const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
              while (true) {
                const { done, value } = await reader.read();
                if (done)
                  break;
                chunks.push(value);
                bytes += (value === null || value === void 0 ? void 0 : value.length) || 0;
                const status = {
                  url: options.url,
                  bytes,
                  contentLength
                };
                this.notifyListeners("progress", status);
              }
              const allChunks = new Uint8Array(bytes);
              let position = 0;
              for (const chunk of chunks) {
                if (typeof chunk === "undefined")
                  continue;
                allChunks.set(chunk, position);
                position += chunk.length;
              }
              blob = new Blob([allChunks.buffer], { type: contentType || void 0 });
            }
            const result = await this.writeFile({
              path: options.path,
              directory: (_a = options.directory) !== null && _a !== void 0 ? _a : void 0,
              recursive: (_b = options.recursive) !== null && _b !== void 0 ? _b : false,
              data: blob
            });
            return { path: result.uri, blob };
          };
        }
        async initDb() {
          if (this._db !== void 0) {
            return this._db;
          }
          if (!("indexedDB" in window)) {
            throw this.unavailable("This browser doesn't support IndexedDB");
          }
          return new Promise((resolve2, reject) => {
            const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);
            request.onupgradeneeded = _FilesystemWeb.doUpgrade;
            request.onsuccess = () => {
              this._db = request.result;
              resolve2(request.result);
            };
            request.onerror = () => reject(request.error);
            request.onblocked = () => {
              console.warn("db blocked");
            };
          });
        }
        static doUpgrade(event) {
          const eventTarget = event.target;
          const db = eventTarget.result;
          switch (event.oldVersion) {
            case 0:
            case 1:
            default: {
              if (db.objectStoreNames.contains("FileStorage")) {
                db.deleteObjectStore("FileStorage");
              }
              const store = db.createObjectStore("FileStorage", { keyPath: "path" });
              store.createIndex("by_folder", "folder");
            }
          }
        }
        async dbRequest(cmd, args) {
          const readFlag = this._writeCmds.indexOf(cmd) !== -1 ? "readwrite" : "readonly";
          return this.initDb().then((conn) => {
            return new Promise((resolve2, reject) => {
              const tx = conn.transaction(["FileStorage"], readFlag);
              const store = tx.objectStore("FileStorage");
              const req = store[cmd](...args);
              req.onsuccess = () => resolve2(req.result);
              req.onerror = () => reject(req.error);
            });
          });
        }
        async dbIndexRequest(indexName, cmd, args) {
          const readFlag = this._writeCmds.indexOf(cmd) !== -1 ? "readwrite" : "readonly";
          return this.initDb().then((conn) => {
            return new Promise((resolve2, reject) => {
              const tx = conn.transaction(["FileStorage"], readFlag);
              const store = tx.objectStore("FileStorage");
              const index = store.index(indexName);
              const req = index[cmd](...args);
              req.onsuccess = () => resolve2(req.result);
              req.onerror = () => reject(req.error);
            });
          });
        }
        getPath(directory, uriPath) {
          const cleanedUriPath = uriPath !== void 0 ? uriPath.replace(/^[/]+|[/]+$/g, "") : "";
          let fsPath = "";
          if (directory !== void 0)
            fsPath += "/" + directory;
          if (uriPath !== "")
            fsPath += "/" + cleanedUriPath;
          return fsPath;
        }
        async clear() {
          const conn = await this.initDb();
          const tx = conn.transaction(["FileStorage"], "readwrite");
          const store = tx.objectStore("FileStorage");
          store.clear();
        }
        /**
         * Read a file from disk
         * @param options options for the file read
         * @return a promise that resolves with the read file data result
         */
        async readFile(options) {
          const path = this.getPath(options.directory, options.path);
          const entry = await this.dbRequest("get", [path]);
          if (entry === void 0)
            throw Error("File does not exist.");
          return { data: entry.content ? entry.content : "" };
        }
        /**
         * Write a file to disk in the specified location on device
         * @param options options for the file write
         * @return a promise that resolves with the file write result
         */
        async writeFile(options) {
          const path = this.getPath(options.directory, options.path);
          let data = options.data;
          const encoding = options.encoding;
          const doRecursive = options.recursive;
          const occupiedEntry = await this.dbRequest("get", [path]);
          if (occupiedEntry && occupiedEntry.type === "directory")
            throw Error("The supplied path is a directory.");
          const parentPath = path.substr(0, path.lastIndexOf("/"));
          const parentEntry = await this.dbRequest("get", [parentPath]);
          if (parentEntry === void 0) {
            const subDirIndex = parentPath.indexOf("/", 1);
            if (subDirIndex !== -1) {
              const parentArgPath = parentPath.substr(subDirIndex);
              await this.mkdir({
                path: parentArgPath,
                directory: options.directory,
                recursive: doRecursive
              });
            }
          }
          if (!encoding && !(data instanceof Blob)) {
            data = data.indexOf(",") >= 0 ? data.split(",")[1] : data;
            if (!this.isBase64String(data))
              throw Error("The supplied data is not valid base64 content.");
          }
          const now = Date.now();
          const pathObj = {
            path,
            folder: parentPath,
            type: "file",
            size: data instanceof Blob ? data.size : data.length,
            ctime: now,
            mtime: now,
            content: data
          };
          await this.dbRequest("put", [pathObj]);
          return {
            uri: pathObj.path
          };
        }
        /**
         * Append to a file on disk in the specified location on device
         * @param options options for the file append
         * @return a promise that resolves with the file write result
         */
        async appendFile(options) {
          const path = this.getPath(options.directory, options.path);
          let data = options.data;
          const encoding = options.encoding;
          const parentPath = path.substr(0, path.lastIndexOf("/"));
          const now = Date.now();
          let ctime = now;
          const occupiedEntry = await this.dbRequest("get", [path]);
          if (occupiedEntry && occupiedEntry.type === "directory")
            throw Error("The supplied path is a directory.");
          const parentEntry = await this.dbRequest("get", [parentPath]);
          if (parentEntry === void 0) {
            const subDirIndex = parentPath.indexOf("/", 1);
            if (subDirIndex !== -1) {
              const parentArgPath = parentPath.substr(subDirIndex);
              await this.mkdir({
                path: parentArgPath,
                directory: options.directory,
                recursive: true
              });
            }
          }
          if (!encoding && !this.isBase64String(data))
            throw Error("The supplied data is not valid base64 content.");
          if (occupiedEntry !== void 0) {
            if (occupiedEntry.content instanceof Blob) {
              throw Error("The occupied entry contains a Blob object which cannot be appended to.");
            }
            if (occupiedEntry.content !== void 0 && !encoding) {
              data = btoa(atob(occupiedEntry.content) + atob(data));
            } else {
              data = occupiedEntry.content + data;
            }
            ctime = occupiedEntry.ctime;
          }
          const pathObj = {
            path,
            folder: parentPath,
            type: "file",
            size: data.length,
            ctime,
            mtime: now,
            content: data
          };
          await this.dbRequest("put", [pathObj]);
        }
        /**
         * Delete a file from disk
         * @param options options for the file delete
         * @return a promise that resolves with the deleted file data result
         */
        async deleteFile(options) {
          const path = this.getPath(options.directory, options.path);
          const entry = await this.dbRequest("get", [path]);
          if (entry === void 0)
            throw Error("File does not exist.");
          const entries = await this.dbIndexRequest("by_folder", "getAllKeys", [
            IDBKeyRange.only(path)
          ]);
          if (entries.length !== 0)
            throw Error("Folder is not empty.");
          await this.dbRequest("delete", [path]);
        }
        /**
         * Create a directory.
         * @param options options for the mkdir
         * @return a promise that resolves with the mkdir result
         */
        async mkdir(options) {
          const path = this.getPath(options.directory, options.path);
          const doRecursive = options.recursive;
          const parentPath = path.substr(0, path.lastIndexOf("/"));
          const depth = (path.match(/\//g) || []).length;
          const parentEntry = await this.dbRequest("get", [parentPath]);
          const occupiedEntry = await this.dbRequest("get", [path]);
          if (depth === 1)
            throw Error("Cannot create Root directory");
          if (occupiedEntry !== void 0)
            throw Error("Current directory does already exist.");
          if (!doRecursive && depth !== 2 && parentEntry === void 0)
            throw Error("Parent directory must exist");
          if (doRecursive && depth !== 2 && parentEntry === void 0) {
            const parentArgPath = parentPath.substr(parentPath.indexOf("/", 1));
            await this.mkdir({
              path: parentArgPath,
              directory: options.directory,
              recursive: doRecursive
            });
          }
          const now = Date.now();
          const pathObj = {
            path,
            folder: parentPath,
            type: "directory",
            size: 0,
            ctime: now,
            mtime: now
          };
          await this.dbRequest("put", [pathObj]);
        }
        /**
         * Remove a directory
         * @param options the options for the directory remove
         */
        async rmdir(options) {
          const { path, directory, recursive } = options;
          const fullPath = this.getPath(directory, path);
          const entry = await this.dbRequest("get", [fullPath]);
          if (entry === void 0)
            throw Error("Folder does not exist.");
          if (entry.type !== "directory")
            throw Error("Requested path is not a directory");
          const readDirResult = await this.readdir({ path, directory });
          if (readDirResult.files.length !== 0 && !recursive)
            throw Error("Folder is not empty");
          for (const entry2 of readDirResult.files) {
            const entryPath = `${path}/${entry2.name}`;
            const entryObj = await this.stat({ path: entryPath, directory });
            if (entryObj.type === "file") {
              await this.deleteFile({ path: entryPath, directory });
            } else {
              await this.rmdir({ path: entryPath, directory, recursive });
            }
          }
          await this.dbRequest("delete", [fullPath]);
        }
        /**
         * Return a list of files from the directory (not recursive)
         * @param options the options for the readdir operation
         * @return a promise that resolves with the readdir directory listing result
         */
        async readdir(options) {
          const path = this.getPath(options.directory, options.path);
          const entry = await this.dbRequest("get", [path]);
          if (options.path !== "" && entry === void 0)
            throw Error("Folder does not exist.");
          const entries = await this.dbIndexRequest("by_folder", "getAllKeys", [IDBKeyRange.only(path)]);
          const files = await Promise.all(entries.map(async (e) => {
            let subEntry = await this.dbRequest("get", [e]);
            if (subEntry === void 0) {
              subEntry = await this.dbRequest("get", [e + "/"]);
            }
            return {
              name: e.substring(path.length + 1),
              type: subEntry.type,
              size: subEntry.size,
              ctime: subEntry.ctime,
              mtime: subEntry.mtime,
              uri: subEntry.path
            };
          }));
          return { files };
        }
        /**
         * Return full File URI for a path and directory
         * @param options the options for the stat operation
         * @return a promise that resolves with the file stat result
         */
        async getUri(options) {
          const path = this.getPath(options.directory, options.path);
          let entry = await this.dbRequest("get", [path]);
          if (entry === void 0) {
            entry = await this.dbRequest("get", [path + "/"]);
          }
          return {
            uri: (entry === null || entry === void 0 ? void 0 : entry.path) || path
          };
        }
        /**
         * Return data about a file
         * @param options the options for the stat operation
         * @return a promise that resolves with the file stat result
         */
        async stat(options) {
          const path = this.getPath(options.directory, options.path);
          let entry = await this.dbRequest("get", [path]);
          if (entry === void 0) {
            entry = await this.dbRequest("get", [path + "/"]);
          }
          if (entry === void 0)
            throw Error("Entry does not exist.");
          return {
            type: entry.type,
            size: entry.size,
            ctime: entry.ctime,
            mtime: entry.mtime,
            uri: entry.path
          };
        }
        /**
         * Rename a file or directory
         * @param options the options for the rename operation
         * @return a promise that resolves with the rename result
         */
        async rename(options) {
          await this._copy(options, true);
          return;
        }
        /**
         * Copy a file or directory
         * @param options the options for the copy operation
         * @return a promise that resolves with the copy result
         */
        async copy(options) {
          return this._copy(options, false);
        }
        async requestPermissions() {
          return { publicStorage: "granted" };
        }
        async checkPermissions() {
          return { publicStorage: "granted" };
        }
        /**
         * Function that can perform a copy or a rename
         * @param options the options for the rename operation
         * @param doRename whether to perform a rename or copy operation
         * @return a promise that resolves with the result
         */
        async _copy(options, doRename = false) {
          let { toDirectory } = options;
          const { to, from, directory: fromDirectory } = options;
          if (!to || !from) {
            throw Error("Both to and from must be provided");
          }
          if (!toDirectory) {
            toDirectory = fromDirectory;
          }
          const fromPath = this.getPath(fromDirectory, from);
          const toPath = this.getPath(toDirectory, to);
          if (fromPath === toPath) {
            return {
              uri: toPath
            };
          }
          if (isPathParent(fromPath, toPath)) {
            throw Error("To path cannot contain the from path");
          }
          let toObj;
          try {
            toObj = await this.stat({
              path: to,
              directory: toDirectory
            });
          } catch (e) {
            const toPathComponents = to.split("/");
            toPathComponents.pop();
            const toPath2 = toPathComponents.join("/");
            if (toPathComponents.length > 0) {
              const toParentDirectory = await this.stat({
                path: toPath2,
                directory: toDirectory
              });
              if (toParentDirectory.type !== "directory") {
                throw new Error("Parent directory of the to path is a file");
              }
            }
          }
          if (toObj && toObj.type === "directory") {
            throw new Error("Cannot overwrite a directory with a file");
          }
          const fromObj = await this.stat({
            path: from,
            directory: fromDirectory
          });
          const updateTime = async (path, ctime2, mtime) => {
            const fullPath = this.getPath(toDirectory, path);
            const entry = await this.dbRequest("get", [fullPath]);
            entry.ctime = ctime2;
            entry.mtime = mtime;
            await this.dbRequest("put", [entry]);
          };
          const ctime = fromObj.ctime ? fromObj.ctime : Date.now();
          switch (fromObj.type) {
            // The "from" object is a file
            case "file": {
              const file = await this.readFile({
                path: from,
                directory: fromDirectory
              });
              if (doRename) {
                await this.deleteFile({
                  path: from,
                  directory: fromDirectory
                });
              }
              let encoding;
              if (!(file.data instanceof Blob) && !this.isBase64String(file.data)) {
                encoding = exports.Encoding.UTF8;
              }
              const writeResult = await this.writeFile({
                path: to,
                directory: toDirectory,
                data: file.data,
                encoding
              });
              if (doRename) {
                await updateTime(to, ctime, fromObj.mtime);
              }
              return writeResult;
            }
            case "directory": {
              if (toObj) {
                throw Error("Cannot move a directory over an existing object");
              }
              try {
                await this.mkdir({
                  path: to,
                  directory: toDirectory,
                  recursive: false
                });
                if (doRename) {
                  await updateTime(to, ctime, fromObj.mtime);
                }
              } catch (e) {
              }
              const contents = (await this.readdir({
                path: from,
                directory: fromDirectory
              })).files;
              for (const filename of contents) {
                await this._copy({
                  from: `${from}/${filename.name}`,
                  to: `${to}/${filename.name}`,
                  directory: fromDirectory,
                  toDirectory
                }, doRename);
              }
              if (doRename) {
                await this.rmdir({
                  path: from,
                  directory: fromDirectory
                });
              }
            }
          }
          return {
            uri: toPath
          };
        }
        isBase64String(str) {
          try {
            return btoa(atob(str)) == str;
          } catch (err) {
            return false;
          }
        }
      };
      FilesystemWeb._debug = true;
      var web = /* @__PURE__ */ Object.freeze({
        __proto__: null,
        FilesystemWeb
      });
      exports.Filesystem = Filesystem;
      exports.FilesystemDirectory = FilesystemDirectory;
      exports.FilesystemEncoding = FilesystemEncoding;
    }
  });

  // mobile/node_modules/@capacitor/preferences/dist/plugin.cjs.js
  var require_plugin_cjs2 = __commonJS({
    "mobile/node_modules/@capacitor/preferences/dist/plugin.cjs.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      var core = require_index_cjs();
      var Preferences = core.registerPlugin("Preferences", {
        web: () => Promise.resolve().then(function() {
          return web;
        }).then((m) => new m.PreferencesWeb())
      });
      var PreferencesWeb = class extends core.WebPlugin {
        constructor() {
          super(...arguments);
          this.group = "CapacitorStorage";
        }
        async configure({ group }) {
          if (typeof group === "string") {
            this.group = group;
          }
        }
        async get(options) {
          const value = this.impl.getItem(this.applyPrefix(options.key));
          return { value };
        }
        async set(options) {
          this.impl.setItem(this.applyPrefix(options.key), options.value);
        }
        async remove(options) {
          this.impl.removeItem(this.applyPrefix(options.key));
        }
        async keys() {
          const keys = this.rawKeys().map((k) => k.substring(this.prefix.length));
          return { keys };
        }
        async clear() {
          for (const key of this.rawKeys()) {
            this.impl.removeItem(key);
          }
        }
        async migrate() {
          var _a;
          const migrated = [];
          const existing = [];
          const oldprefix = "_cap_";
          const keys = Object.keys(this.impl).filter((k) => k.indexOf(oldprefix) === 0);
          for (const oldkey of keys) {
            const key = oldkey.substring(oldprefix.length);
            const value = (_a = this.impl.getItem(oldkey)) !== null && _a !== void 0 ? _a : "";
            const { value: currentValue } = await this.get({ key });
            if (typeof currentValue === "string") {
              existing.push(key);
            } else {
              await this.set({ key, value });
              migrated.push(key);
            }
          }
          return { migrated, existing };
        }
        async removeOld() {
          const oldprefix = "_cap_";
          const keys = Object.keys(this.impl).filter((k) => k.indexOf(oldprefix) === 0);
          for (const oldkey of keys) {
            this.impl.removeItem(oldkey);
          }
        }
        get impl() {
          return window.localStorage;
        }
        get prefix() {
          return this.group === "NativeStorage" ? "" : `${this.group}.`;
        }
        rawKeys() {
          return Object.keys(this.impl).filter((k) => k.indexOf(this.prefix) === 0);
        }
        applyPrefix(key) {
          return this.prefix + key;
        }
      };
      var web = /* @__PURE__ */ Object.freeze({
        __proto__: null,
        PreferencesWeb
      });
      exports.Preferences = Preferences;
    }
  });

  // mobile/node_modules/@capacitor/status-bar/dist/plugin.cjs.js
  var require_plugin_cjs3 = __commonJS({
    "mobile/node_modules/@capacitor/status-bar/dist/plugin.cjs.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      var core = require_index_cjs();
      exports.Style = void 0;
      (function(Style) {
        Style["Dark"] = "DARK";
        Style["Light"] = "LIGHT";
        Style["Default"] = "DEFAULT";
      })(exports.Style || (exports.Style = {}));
      exports.Animation = void 0;
      (function(Animation) {
        Animation["None"] = "NONE";
        Animation["Slide"] = "SLIDE";
        Animation["Fade"] = "FADE";
      })(exports.Animation || (exports.Animation = {}));
      var StatusBarAnimation = exports.Animation;
      var StatusBarStyle = exports.Style;
      var StatusBar = core.registerPlugin("StatusBar");
      exports.StatusBar = StatusBar;
      exports.StatusBarAnimation = StatusBarAnimation;
      exports.StatusBarStyle = StatusBarStyle;
    }
  });

  // mobile/node_modules/@capacitor/keyboard/dist/plugin.cjs.js
  var require_plugin_cjs4 = __commonJS({
    "mobile/node_modules/@capacitor/keyboard/dist/plugin.cjs.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      var core = require_index_cjs();
      exports.KeyboardStyle = void 0;
      (function(KeyboardStyle) {
        KeyboardStyle["Dark"] = "DARK";
        KeyboardStyle["Light"] = "LIGHT";
        KeyboardStyle["Default"] = "DEFAULT";
      })(exports.KeyboardStyle || (exports.KeyboardStyle = {}));
      exports.KeyboardResize = void 0;
      (function(KeyboardResize) {
        KeyboardResize["Body"] = "body";
        KeyboardResize["Ionic"] = "ionic";
        KeyboardResize["Native"] = "native";
        KeyboardResize["None"] = "none";
      })(exports.KeyboardResize || (exports.KeyboardResize = {}));
      var Keyboard = core.registerPlugin("Keyboard");
      exports.Keyboard = Keyboard;
    }
  });

  // mobile/node_modules/@capacitor/app/dist/plugin.cjs.js
  var require_plugin_cjs5 = __commonJS({
    "mobile/node_modules/@capacitor/app/dist/plugin.cjs.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      var core = require_index_cjs();
      var App = core.registerPlugin("App", {
        web: () => Promise.resolve().then(function() {
          return web;
        }).then((m) => new m.AppWeb())
      });
      var AppWeb = class extends core.WebPlugin {
        constructor() {
          super();
          this.handleVisibilityChange = () => {
            const data = {
              isActive: document.hidden !== true
            };
            this.notifyListeners("appStateChange", data);
            if (document.hidden) {
              this.notifyListeners("pause", null);
            } else {
              this.notifyListeners("resume", null);
            }
          };
          document.addEventListener("visibilitychange", this.handleVisibilityChange, false);
        }
        exitApp() {
          throw this.unimplemented("Not implemented on web.");
        }
        async getInfo() {
          throw this.unimplemented("Not implemented on web.");
        }
        async getLaunchUrl() {
          return { url: "" };
        }
        async getState() {
          return { isActive: document.hidden !== true };
        }
        async minimizeApp() {
          throw this.unimplemented("Not implemented on web.");
        }
      };
      var web = /* @__PURE__ */ Object.freeze({
        __proto__: null,
        AppWeb
      });
      exports.App = App;
    }
  });

  // src/mobile/native.js
  var require_native = __commonJS({
    "src/mobile/native.js"(exports, module) {
      "use strict";
      var core = null;
      var fsPlugin = null;
      var preferencesPlugin = null;
      var statusBarPlugin = null;
      var keyboardPlugin = null;
      var appPlugin = null;
      try {
        core = require_index_cjs();
      } catch {
        core = null;
      }
      try {
        fsPlugin = require_plugin_cjs().Filesystem;
      } catch {
        fsPlugin = null;
      }
      try {
        preferencesPlugin = require_plugin_cjs2().Preferences;
      } catch {
        preferencesPlugin = null;
      }
      try {
        statusBarPlugin = require_plugin_cjs3().StatusBar;
      } catch {
        statusBarPlugin = null;
      }
      try {
        keyboardPlugin = require_plugin_cjs4().Keyboard;
      } catch {
        keyboardPlugin = null;
      }
      try {
        appPlugin = require_plugin_cjs5().App;
      } catch {
        appPlugin = null;
      }
      function capacitor() {
        return core && core.Capacitor || (typeof window !== "undefined" ? window.Capacitor : null) || null;
      }
      function platform() {
        const cap = capacitor();
        if (cap && typeof cap.getPlatform === "function") return cap.getPlatform();
        return "web";
      }
      function isNative() {
        const cap = capacitor();
        if (cap && typeof cap.isNativePlatform === "function") return Boolean(cap.isNativePlatform());
        return false;
      }
      function fallback(name) {
        const cap = capacitor();
        return cap && cap.Plugins && cap.Plugins[name] || null;
      }
      function filesystem() {
        return fsPlugin || fallback("Filesystem");
      }
      function preferences() {
        return preferencesPlugin || fallback("Preferences");
      }
      function statusBar() {
        return statusBarPlugin || fallback("StatusBar");
      }
      function keyboard() {
        return keyboardPlugin || fallback("Keyboard");
      }
      function app() {
        return appPlugin || fallback("App");
      }
      module.exports = { capacitor, platform, isNative, filesystem, preferences, statusBar, keyboard, app };
    }
  });

  // src/mobile/storage.js
  var require_storage = __commonJS({
    "src/mobile/storage.js"(exports, module) {
      "use strict";
      var fs2 = require_fs();
      var native2 = require_native();
      var ROOT = "mushu";
      var MANIFEST = `${ROOT}/.vfs-manifest.json`;
      function nativeFs() {
        if (!native2.isNative()) return null;
        return native2.filesystem();
      }
      function nativePath(p) {
        return ROOT + (p.startsWith("/") ? p : "/" + p);
      }
      async function nativeLoad(FS) {
        let manifest = {};
        try {
          const res = await FS.readFile({ path: MANIFEST, directory: "DATA", encoding: "utf8" });
          const parsed = JSON.parse(res.data || "{}");
          manifest = parsed && parsed.files || {};
        } catch {
          manifest = {};
        }
        const out = [];
        const walk = async (rel) => {
          let entries = [];
          try {
            const res = await FS.readdir({ path: rel ? `${ROOT}/${rel}` : ROOT, directory: "DATA" });
            entries = res.files || [];
          } catch {
            return;
          }
          for (const raw of entries) {
            const name = typeof raw === "string" ? raw : raw.name;
            if (!name) continue;
            const childRel = rel ? `${rel}/${name}` : name;
            const abs = `${ROOT}/${childRel}`;
            let info = null;
            try {
              info = await FS.stat({ path: abs, directory: "DATA" });
            } catch {
              continue;
            }
            if (info.type === "directory") {
              out.push({ path: "/" + childRel, type: "dir" });
              await walk(childRel);
              continue;
            }
            if (childRel === ".vfs-manifest.json") continue;
            try {
              const file = await FS.readFile({ path: abs, directory: "DATA", encoding: "utf8" });
              const p = "/" + childRel;
              out.push({ path: p, type: "file", data: String(file.data == null ? "" : file.data), mtime: manifest[p] || Number(info.mtime) || Date.now() });
            } catch {
            }
          }
        };
        try {
          await FS.mkdir({ path: ROOT, directory: "DATA", recursive: true });
        } catch {
        }
        await walk("");
        return out;
      }
      async function nativeApply(FS, ops) {
        for (const [p, kind] of ops) {
          const target = nativePath(p);
          if (kind === "put") {
            const node = fs2.getNode(p);
            if (!node) continue;
            if (node.type === "dir") {
              try {
                await FS.mkdir({ path: target, directory: "DATA", recursive: true });
              } catch {
              }
              continue;
            }
            await FS.writeFile({ path: target, data: node.data, directory: "DATA", encoding: "utf8", recursive: true });
          } else {
            try {
              await FS.deleteFile({ path: target, directory: "DATA" });
            } catch {
              try {
                await FS.rmdir({ path: target, directory: "DATA", recursive: true });
              } catch {
              }
            }
          }
        }
        const files = {};
        for (const entry of fs2.allEntries()) {
          if (entry.type === "file") files[entry.path] = entry.mtime;
        }
        try {
          await FS.writeFile({ path: MANIFEST, data: JSON.stringify({ version: 1, files }), directory: "DATA", encoding: "utf8", recursive: true });
        } catch {
        }
      }
      var DB_NAME = "mushu-vfs";
      var STORE = "files";
      function openDb() {
        return new Promise((resolve, reject) => {
          const req = indexedDB.open(DB_NAME, 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "path" });
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error || new Error("IndexedDB 打开失败"));
        });
      }
      async function idbLoad() {
        const db = await openDb();
        return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, "readonly");
          const req = tx.objectStore(STORE).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error || new Error("IndexedDB 读取失败"));
        });
      }
      async function idbApply(ops) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          const store = tx.objectStore(STORE);
          for (const [p, kind] of ops) {
            if (kind === "put") {
              const node = fs2.getNode(p);
              if (!node) continue;
              if (node.type === "dir") store.put({ path: p, type: "dir", mtime: node.mtime });
              else store.put({ path: p, type: "file", data: node.data, mtime: node.mtime });
            } else {
              store.delete(p);
            }
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || new Error("IndexedDB 写入失败"));
        });
      }
      var backend = null;
      var dirty = /* @__PURE__ */ new Map();
      var timer = null;
      var flushing = null;
      var onFlush = null;
      function setFlushListener(fn) {
        onFlush = typeof fn === "function" ? fn : null;
      }
      async function loadAll() {
        const FS = nativeFs();
        if (FS) {
          backend = { load: () => nativeLoad(FS), apply: (ops) => nativeApply(FS, ops) };
          return backend.load();
        }
        backend = { load: idbLoad, apply: idbApply };
        return backend.load();
      }
      function mark(p, kind) {
        if (/\.tmp-\d+-\d+$/.test(p)) {
          if (kind === "delete") {
            dirty.delete(p);
          }
          return;
        }
        if (kind === "put" || kind === "dir") dirty.set(p, "put");
        else dirty.set(p, "delete");
        schedule();
      }
      function schedule() {
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          flush().catch(() => {
          });
        }, 250);
      }
      async function flush() {
        if (flushing) return flushing;
        flushing = (async () => {
          while (dirty.size) {
            const ops = [];
            for (const [p, kind] of dirty) ops.push([p, kind]);
            dirty = /* @__PURE__ */ new Map();
            if (backend) await backend.apply(ops);
            if (onFlush) onFlush(ops);
          }
        })();
        try {
          await flushing;
        } finally {
          flushing = null;
        }
      }
      async function flushNow() {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        await flush();
      }
      module.exports = { loadAll, mark, flush, flushNow, setFlushListener };
    }
  });

  // src/mobile/config.js
  var require_config = __commonJS({
    "src/mobile/config.js"(exports, module) {
      "use strict";
      var native2 = require_native();
      var STORE_KEY = "mushu.mobile.config";
      var DEFAULTS = {
        baseUrl: "https://mushu.sfangjie.cn",
        password: "",
        autoSync: true,
        lastSyncAt: "",
        setupDone: false
      };
      var cached = { ...DEFAULTS };
      var prefs = null;
      function nativePrefs() {
        if (!native2.isNative()) return null;
        return native2.preferences();
      }
      function normalizeUrl(url) {
        const s = String(url || "").trim().replace(/\/+$/, "");
        if (!s) return DEFAULTS.baseUrl;
        if (!/^https?:\/\//i.test(s)) return "https://" + s;
        return s;
      }
      async function load() {
        prefs = nativePrefs();
        let raw = "";
        try {
          if (prefs) {
            const res = await prefs.get({ key: STORE_KEY });
            raw = res && res.value ? res.value : "";
          } else {
            raw = localStorage.getItem(STORE_KEY) || "";
          }
        } catch {
          raw = "";
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
        cached = { ...cached, ...patch || {} };
        cached.baseUrl = normalizeUrl(cached.baseUrl);
        const text = JSON.stringify(cached);
        try {
          if (!prefs) prefs = nativePrefs();
          if (prefs) await prefs.set({ key: STORE_KEY, value: text });
          else localStorage.setItem(STORE_KEY, text);
        } catch {
        }
        return { ...cached };
      }
      function get() {
        return { ...cached };
      }
      module.exports = { load, save, get, DEFAULTS };
    }
  });

  // src/mobile/shims/crypto.js
  var require_crypto = __commonJS({
    "src/mobile/shims/crypto.js"(exports, module) {
      "use strict";
      function utf8Bytes(str) {
        return new TextEncoder().encode(String(str == null ? "" : str));
      }
      function sha1Hex(bytes) {
        const len = bytes.length;
        const bitLen = len * 8;
        const total = Math.ceil((len + 9) / 64) * 64;
        const buf = new Uint8Array(total);
        buf.set(bytes);
        buf[len] = 128;
        const dv = new DataView(buf.buffer);
        dv.setUint32(total - 8, Math.floor(bitLen / 4294967296), false);
        dv.setUint32(total - 4, bitLen >>> 0, false);
        let h0 = 1732584193;
        let h1 = 4023233417;
        let h2 = 2562383102;
        let h3 = 271733878;
        let h4 = 3285377520;
        const w = new Uint32Array(80);
        for (let i = 0; i < total; i += 64) {
          for (let j = 0; j < 16; j += 1) w[j] = dv.getUint32(i + j * 4, false);
          for (let j = 16; j < 80; j += 1) {
            const n = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
            w[j] = n << 1 | n >>> 31;
          }
          let a = h0;
          let b = h1;
          let c = h2;
          let d = h3;
          let e = h4;
          for (let j = 0; j < 80; j += 1) {
            let f;
            let k;
            if (j < 20) {
              f = b & c | ~b & d;
              k = 1518500249;
            } else if (j < 40) {
              f = b ^ c ^ d;
              k = 1859775393;
            } else if (j < 60) {
              f = b & c | b & d | c & d;
              k = 2400959708;
            } else {
              f = b ^ c ^ d;
              k = 3395469782;
            }
            const t = (a << 5 | a >>> 27) + f + e + k + w[j] >>> 0;
            e = d;
            d = c;
            c = (b << 30 | b >>> 2) >>> 0;
            b = a;
            a = t;
          }
          h0 = h0 + a >>> 0;
          h1 = h1 + b >>> 0;
          h2 = h2 + c >>> 0;
          h3 = h3 + d >>> 0;
          h4 = h4 + e >>> 0;
        }
        return [h0, h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, "0")).join("");
      }
      function createHash(algorithm) {
        const name = String(algorithm || "").toLowerCase();
        if (name !== "sha1") throw new Error("仅支持 sha1 摘要");
        let data = "";
        return {
          update(value) {
            data += String(value == null ? "" : value);
            return this;
          },
          digest() {
            return sha1Hex(utf8Bytes(data));
          }
        };
      }
      module.exports = { createHash, sha1Hex };
    }
  });

  // src/main/services/fsutil.js
  var require_fsutil = __commonJS({
    "src/main/services/fsutil.js"(exports, module) {
      "use strict";
      var fs2 = require_fs();
      var path = require_path();
      var crypto = require_crypto();
      function ensureDir(dir) {
        fs2.mkdirSync(dir, { recursive: true });
      }
      function exists(p) {
        return fs2.existsSync(p);
      }
      function readText(file, fallback = null) {
        try {
          return fs2.readFileSync(file, "utf8");
        } catch (err) {
          if (err.code === "ENOENT") return fallback;
          throw err;
        }
      }
      function writeTextAtomic(file, text) {
        ensureDir(path.dirname(file));
        const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
        fs2.writeFileSync(tmp, text.replace(/\r\n/g, "\n"), "utf8");
        fs2.renameSync(tmp, file);
      }
      function listDir(dir) {
        try {
          return fs2.readdirSync(dir, { withFileTypes: true });
        } catch (err) {
          if (err.code === "ENOENT") return [];
          throw err;
        }
      }
      function sha1(text) {
        return crypto.createHash("sha1").update(text, "utf8").digest("hex");
      }
      function mtime(file) {
        try {
          return fs2.statSync(file).mtimeMs;
        } catch {
          return 0;
        }
      }
      function countWords(text) {
        if (!text) return 0;
        return text.replace(/\s/g, "").length;
      }
      function localDate(d = /* @__PURE__ */ new Date()) {
        const p = (n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      }
      function safeFileName(title, fallback = "未命名") {
        const cleaned = String(title || "").replace(/[\\/:*?"<>|]/g, "").replace(/[\u0000-\u001f]/g, "").replace(/\s+/g, " ").replace(/^[.\s]+/, "").replace(/[.\s]+$/, "").slice(0, 60).trim();
        return cleaned || fallback;
      }
      module.exports = {
        ensureDir,
        exists,
        readText,
        writeTextAtomic,
        listDir,
        sha1,
        mtime,
        countWords,
        localDate,
        safeFileName
      };
    }
  });

  // src/mobile/ui.js
  var require_ui = __commonJS({
    "src/mobile/ui.js"(exports, module) {
      "use strict";
      var fs2 = require_fs();
      var path = require_path();
      var { readText } = require_fsutil();
      var IOS_CLASS = "is-ios";
      function el(tag, attrs, children) {
        const node = document.createElement(tag);
        Object.entries(attrs || {}).forEach(([k, v]) => {
          if (k === "class") node.className = v;
          else if (k === "text") node.textContent = v;
          else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
          else if (v != null) node.setAttribute(k, v);
        });
        (children || []).forEach((child) => {
          if (child == null) return;
          node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
        });
        return node;
      }
      function markIos() {
        document.body.classList.add(IOS_CLASS);
      }
      function ensureLoading() {
        let node = document.getElementById("mushu-ios-loading");
        if (node) return node;
        node = el("div", { id: "mushu-ios-loading" }, [
          el("div", { class: "mushu-ios-loading-card" }, [
            el("div", { class: "mushu-ios-loading-logo", text: "墨枢" }),
            el("div", { class: "mushu-ios-loading-text", id: "mushu-ios-loading-text", text: "正在载入本地作品…" })
          ])
        ]);
        document.body.appendChild(node);
        return node;
      }
      function setLoading(text) {
        const node = ensureLoading();
        const label = node.querySelector("#mushu-ios-loading-text");
        if (label) label.textContent = text;
        node.classList.remove("hidden");
      }
      var loadingHidden = false;
      function hideLoading() {
        if (loadingHidden) return;
        loadingHidden = true;
        const node = document.getElementById("mushu-ios-loading");
        if (node) {
          node.classList.add("leaving");
          setTimeout(() => node.remove(), 260);
        }
      }
      var toastTimer = null;
      function toast(message, duration) {
        const text = String(message == null ? "" : message).trim();
        if (!text) return;
        let node = document.getElementById("mushu-ios-toast");
        if (!node) {
          node = el("div", { id: "mushu-ios-toast" });
          document.body.appendChild(node);
        }
        node.textContent = text;
        node.classList.add("show");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => node.classList.remove("show"), Number(duration) || 2600);
      }
      function overlay(content, { onClose } = {}) {
        const mask = el("div", { class: "mushu-ios-mask" });
        const sheet = el("div", { class: "mushu-ios-sheet" }, [content]);
        mask.appendChild(sheet);
        const close = () => {
          mask.remove();
          if (onClose) onClose();
        };
        mask.addEventListener("click", (e) => {
          if (e.target === mask) close();
        });
        document.body.appendChild(mask);
        return { mask, sheet, close };
      }
      function listWorks(root) {
        const out = [];
        if (!fs2.existsSync(root)) return out;
        for (const entry of fs2.readdirSync(root, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const dir = path.join(root, entry.name);
          const bookFile = path.join(dir, "book.json");
          if (!fs2.existsSync(bookFile)) continue;
          let book = {};
          try {
            book = JSON.parse(readText(bookFile, "{}"));
          } catch {
            book = {};
          }
          out.push({ dir, title: book.title || entry.name, at: fs2.statSync(dir).mtimeMs });
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
          const list = el("div", { class: "mushu-ios-work-list" });
          if (!works.length) {
            list.appendChild(el("div", { class: "mushu-ios-empty", text: "还没有本地作品，先新建或从服务器同步一个吧" }));
          }
          for (const work of works) {
            list.appendChild(
              el("button", { class: "mushu-ios-work", onclick: () => {
                finish(work.dir);
                ctx.close();
              } }, [
                el("span", { class: "mushu-ios-work-title", text: work.title }),
                el("span", { class: "mushu-ios-work-path", text: work.dir.replace("/mushu/works/", "") })
              ])
            );
          }
          const cancel = el("button", { class: "mushu-ios-btn ghost", text: "取消", onclick: () => {
            finish(null);
            ctx.close();
          } });
          const ctx = overlay(
            el("div", {}, [
              el("div", { class: "mushu-ios-sheet-title", text: "选择作品" }),
              list,
              el("div", { class: "mushu-ios-sheet-actions" }, [cancel])
            ]),
            { onClose: () => finish(null) }
          );
        });
      }
      function hideMenus() {
        document.querySelectorAll(".mushu-ios-menu").forEach((n) => n.remove());
      }
      function showMenu(items, onPick) {
        hideMenus();
        const anchor = document.getElementById("menu-btn") || document.getElementById("titlebar");
        const rect = anchor ? anchor.getBoundingClientRect() : { left: 12, bottom: 48 };
        const menu = el("div", { class: "mushu-ios-menu" });
        for (const item of items) {
          if (item.sep) {
            menu.appendChild(el("div", { class: "mushu-ios-menu-sep" }));
            continue;
          }
          menu.appendChild(
            el("button", {
              class: "mushu-ios-menu-item",
              text: item.label,
              onclick: () => {
                hideMenus();
                onPick(item.key);
              }
            })
          );
        }
        menu.style.left = Math.max(8, rect.left) + "px";
        menu.style.top = Math.min(window.innerHeight - 60, rect.bottom + 6) + "px";
        document.body.appendChild(menu);
        setTimeout(() => {
          const off = (e) => {
            if (!menu.contains(e.target)) {
              hideMenus();
              document.removeEventListener("pointerdown", off, true);
            }
          };
          document.addEventListener("pointerdown", off, true);
        }, 0);
      }
      var syncNode = null;
      function ensureSyncIndicator() {
        if (syncNode && document.body.contains(syncNode)) return syncNode;
        const bar = document.getElementById("statusbar") || document.getElementById("center");
        if (!bar) return null;
        syncNode = el("span", {
          id: "mushu-ios-sync",
          class: "mushu-ios-sync",
          title: "点按立即同步",
          onclick: () => {
            if (typeof window.__mushuSyncNow === "function") window.__mushuSyncNow();
          }
        });
        bar.appendChild(syncNode);
        return syncNode;
      }
      function setSyncStatus(text, tone) {
        const node = ensureSyncIndicator();
        if (!node) return;
        node.textContent = text;
        node.dataset.tone = tone || "idle";
      }
      function showSetup({ baseUrl, password, autoSync, onSave, onSkip }) {
        return new Promise((resolve) => {
          const urlInput = el("input", { class: "mushu-ios-input", type: "url", value: baseUrl || "", placeholder: "https://mushu.sfangjie.cn" });
          const pwdInput = el("input", { class: "mushu-ios-input", type: "password", value: password || "", placeholder: "服务器访问密码" });
          const auto = el("input", { type: "checkbox" });
          auto.checked = autoSync !== false;
          const error = el("div", { class: "mushu-ios-error" });
          const save = el("button", { class: "mushu-ios-btn primary", text: "保存并继续" });
          const skip = el("button", { class: "mushu-ios-btn ghost", text: "稍后设置（仅本地）" });
          const ctx = overlay(
            el("div", {}, [
              el("div", { class: "mushu-ios-sheet-title", text: "连接你的墨枢服务器" }),
              el("div", { class: "mushu-ios-sheet-desc", text: "作品优先存在 iPad 本地，再定时备份到服务器。AI 助手也由服务器转发。" }),
              el("label", { class: "mushu-ios-field" }, [el("span", { text: "服务器地址" }), urlInput]),
              el("label", { class: "mushu-ios-field" }, [el("span", { text: "访问密码" }), pwdInput]),
              el("label", { class: "mushu-ios-check" }, [auto, el("span", { text: "允许自动同步" })]),
              error,
              el("div", { class: "mushu-ios-sheet-actions" }, [skip, save])
            ]),
            { onClose: () => resolve(false) }
          );
          save.onclick = async () => {
            error.textContent = "";
            save.disabled = true;
            try {
              await onSave({
                baseUrl: urlInput.value.trim(),
                password: pwdInput.value,
                autoSync: auto.checked
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
        showSetup
      };
    }
  });

  // src/main/services/project.js
  var require_project = __commonJS({
    "src/main/services/project.js"(exports, module) {
      "use strict";
      var path = require_path();
      var fs2 = require_fs();
      var { ensureDir, readText, writeTextAtomic, safeFileName } = require_fsutil();
      var BOOK_FILE = "book.json";
      var DIRS = [
        "chapters/v001-第一卷",
        "bible/characters",
        "bible/world",
        "ledger",
        ".mushu/versions",
        ".mushu/drafts"
      ];
      function bookPath(dir) {
        return path.join(dir, BOOK_FILE);
      }
      function safeFolderName(title) {
        return safeFileName(title, "未命名作品");
      }
      function resolveProjectDir(root, title) {
        const base = safeFolderName(title);
        let dir = path.join(root, base);
        for (let i = 1; fs2.existsSync(dir); i += 1) dir = path.join(root, `${base} (${i})`);
        return dir;
      }
      function createProject(dir, { title, author } = {}) {
        if (readText(bookPath(dir)) !== null) {
          throw new Error("该目录已经是一个作品目录（存在 book.json），请改用「打开作品」。");
        }
        ensureDir(dir);
        DIRS.forEach((d) => ensureDir(path.join(dir, d)));
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const book = {
          schema: 1,
          title: title || "未命名作品",
          author: author || "",
          createdAt: now,
          updatedAt: now
        };
        writeTextAtomic(bookPath(dir), JSON.stringify(book, null, 2) + "\n");
        writeTextAtomic(path.join(dir, "bible", "timeline.md"), "# 时间线\n\n");
        writeTextAtomic(path.join(dir, "bible", "terms.md"), "# 术语表\n\n");
        writeTextAtomic(path.join(dir, "bible", "outline.md"), "# 故事大纲\n\n");
        writeTextAtomic(path.join(dir, "ledger", "foreshadows.md"), "# 伏笔台账\n\n");
        return { dir, book };
      }
      function openProject(dir) {
        const raw = readText(bookPath(dir));
        if (raw === null) {
          throw new Error("不是有效的作品目录：缺少 book.json");
        }
        let book;
        try {
          book = JSON.parse(raw);
        } catch (err) {
          throw new Error("book.json 解析失败：" + err.message);
        }
        return { dir, book };
      }
      function updateBook(dir, patch) {
        const raw = readText(bookPath(dir));
        if (raw === null) throw new Error("作品不存在：" + dir);
        const book = { ...JSON.parse(raw), ...patch, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
        writeTextAtomic(bookPath(dir), JSON.stringify(book, null, 2) + "\n");
        return book;
      }
      module.exports = { BOOK_FILE, createProject, openProject, updateBook, bookPath, safeFolderName, resolveProjectDir };
    }
  });

  // src/main/services/frontmatter.js
  var require_frontmatter = __commonJS({
    "src/main/services/frontmatter.js"(exports, module) {
      "use strict";
      function unquote(v) {
        const s = String(v).trim();
        if (s.length >= 2 && (s[0] === '"' && s.endsWith('"') || s[0] === "'" && s.endsWith("'"))) {
          return s.slice(1, -1);
        }
        return s;
      }
      function quoteIfNeeded(v) {
        const s = String(v);
        if (s === "") return '""';
        if (/[:#[\]"'{}]/.test(s) || s !== s.trim()) return JSON.stringify(s);
        return s;
      }
      function parse(head) {
        const meta = {};
        let listKey = null;
        for (const rawLine of head.split("\n")) {
          const line = rawLine.replace(/\s+$/, "");
          if (!line.trim()) continue;
          const item = line.match(/^\s+-\s*(.*)$/);
          if (item && listKey) {
            meta[listKey].push(unquote(item[1]));
            continue;
          }
          const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
          if (!kv) continue;
          const key = kv[1];
          const value = kv[2].trim();
          if (value === "") {
            listKey = key;
            meta[key] = [];
          } else if (value.startsWith("[") && value.endsWith("]")) {
            listKey = null;
            meta[key] = value.slice(1, -1).split(",").map((s) => unquote(s)).filter((s) => s !== "");
          } else {
            listKey = null;
            meta[key] = unquote(value);
          }
        }
        return meta;
      }
      var KEY_ORDER = ["id", "title", "status", "words", "pov", "characters", "foreshadows", "created", "updated"];
      function serialize(meta, body) {
        const keys = [...KEY_ORDER.filter((k) => k in meta), ...Object.keys(meta).filter((k) => !KEY_ORDER.includes(k))];
        const lines = ["---"];
        for (const key of keys) {
          const value = meta[key];
          if (Array.isArray(value)) {
            lines.push(`${key}: [${value.map((v) => quoteIfNeeded(v)).join(", ")}]`);
          } else {
            lines.push(`${key}: ${quoteIfNeeded(value == null ? "" : value)}`);
          }
        }
        lines.push("---", "");
        return `${lines.join("\n")}${body || ""}`;
      }
      function split(text) {
        const src = (text || "").replace(/\r\n/g, "\n");
        if (src.slice(0, 3) !== "---") return { meta: {}, body: src };
        const end = src.indexOf("\n---", 3);
        if (end === -1) return { meta: {}, body: src };
        const head = src.slice(3, end).replace(/^\n/, "");
        let body = src.slice(end + 4);
        if (body.startsWith("\n")) body = body.slice(1);
        return { meta: parse(head), body };
      }
      module.exports = { split, serialize, parse };
    }
  });

  // src/main/services/versions.js
  var require_versions = __commonJS({
    "src/main/services/versions.js"(exports, module) {
      "use strict";
      var path = require_path();
      var fs2 = require_fs();
      var { ensureDir, exists, readText, writeTextAtomic, listDir, sha1, countWords, mtime, safeFileName } = require_fsutil();
      var VERSIONS_DIR = path.join(".mushu", "versions");
      var KEEP_PER_CHAPTER = 100;
      var BACKUP_STATE = path.join(".mushu", "backup-state.json");
      var rootResolver = null;
      function setRootResolver(fn) {
        rootResolver = fn;
      }
      function backupRoot() {
        const r = rootResolver ? rootResolver() : null;
        return r || null;
      }
      function projectKey(dir) {
        const abs = path.resolve(dir);
        return `${sha1(abs).slice(0, 10)}-${safeFileName(path.basename(abs), "project")}`;
      }
      function versionBase(dir) {
        const root = backupRoot();
        return root ? path.join(root, projectKey(dir), "versions") : path.join(dir, VERSIONS_DIR);
      }
      function versionDir(dir, id) {
        ensureLegacyMigrated(dir);
        return path.join(versionBase(dir), id.replace(/[\\/]/g, "__"));
      }
      function listFiles(dir, id) {
        const abs = versionDir(dir, id);
        return listDir(abs).filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name).sort();
      }
      function snapshot(dir, id, text) {
        const abs = versionDir(dir, id);
        ensureDir(abs);
        const files = listFiles(dir, id);
        const hash = sha1(text);
        const latest = files[files.length - 1];
        if (latest && latest.includes(hash.slice(0, 8))) return null;
        const ts = /* @__PURE__ */ new Date();
        const stamp = [
          ts.getFullYear(),
          String(ts.getMonth() + 1).padStart(2, "0"),
          String(ts.getDate()).padStart(2, "0")
        ].join("") + "-" + [
          String(ts.getHours()).padStart(2, "0"),
          String(ts.getMinutes()).padStart(2, "0"),
          String(ts.getSeconds()).padStart(2, "0")
        ].join("") + "-" + String(ts.getMilliseconds()).padStart(3, "0");
        const fileName = `${stamp}-${hash.slice(0, 8)}.md`;
        writeTextAtomic(path.join(abs, fileName), text);
        const all = listFiles(dir, id);
        if (all.length > KEEP_PER_CHAPTER) {
          for (const old of all.slice(0, all.length - KEEP_PER_CHAPTER)) {
            try {
              fs2.unlinkSync(path.join(abs, old));
            } catch {
            }
          }
        }
        return fileName;
      }
      function list(dir, id) {
        const abs = versionDir(dir, id);
        return listFiles(dir, id).map((name) => {
          const p = path.join(abs, name);
          const text = readText(p, "");
          const [datePart, timePart] = name.split("-");
          const iso = `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}T${timePart.slice(0, 2)}:${timePart.slice(2, 4)}:${timePart.slice(4, 6)}`;
          return {
            file: name,
            at: iso,
            words: countWords(text),
            size: text.length,
            mtime: mtime(p)
          };
        }).sort((a, b) => b.mtime - a.mtime);
      }
      function read(dir, id, file) {
        const abs = path.join(versionDir(dir, id), path.basename(file));
        const text = readText(abs);
        if (text === null) throw new Error("版本不存在：" + file);
        return { file, text, words: countWords(text) };
      }
      function migrate(dir, oldId, newId) {
        if (oldId === newId) return false;
        const from = versionDir(dir, oldId);
        const to = versionDir(dir, newId);
        if (!fs2.existsSync(from) || fs2.existsSync(to)) return false;
        fs2.renameSync(from, to);
        return true;
      }
      function statTree(dir) {
        let files = 0;
        let bytes = 0;
        const walk = (d) => {
          for (const e of listDir(d)) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else {
              files += 1;
              try {
                bytes += fs2.statSync(p).size;
              } catch {
              }
            }
          }
        };
        if (fs2.existsSync(dir)) walk(dir);
        return { files, bytes };
      }
      function copyTree(src, dst) {
        ensureDir(dst);
        for (const e of listDir(src)) {
          const from = path.join(src, e.name);
          const to = path.join(dst, e.name);
          if (e.isDirectory()) copyTree(from, to);
          else {
            ensureDir(path.dirname(to));
            fs2.copyFileSync(from, to);
          }
        }
      }
      function moveTree(src, dst) {
        if (!fs2.existsSync(src)) return;
        ensureDir(path.dirname(dst));
        try {
          fs2.renameSync(src, dst);
          return;
        } catch {
        }
        const before = statTree(src);
        copyTree(src, dst);
        const after = statTree(dst);
        if (after.files >= before.files && after.bytes >= before.bytes) {
          fs2.rmSync(src, { recursive: true, force: true });
        } else {
          throw new Error("备份迁移校验失败，已保留原目录：" + src);
        }
      }
      function mergeMove(src, dst) {
        if (!fs2.existsSync(dst)) {
          moveTree(src, dst);
          return;
        }
        for (const e of listDir(src)) {
          const from = path.join(src, e.name);
          const to = path.join(dst, e.name);
          if (!fs2.existsSync(to)) moveTree(from, to);
          else if (e.isDirectory()) mergeMove(from, to);
        }
        try {
          if (fs2.existsSync(src) && !listDir(src).length) fs2.rmdirSync(src);
        } catch {
        }
      }
      function migrateBackupRoot(oldRoot, newRoot) {
        if (!oldRoot || !newRoot) return false;
        if (path.resolve(oldRoot) === path.resolve(newRoot)) return false;
        if (!fs2.existsSync(oldRoot)) return false;
        mergeMove(oldRoot, newRoot);
        return true;
      }
      var legacyChecked = /* @__PURE__ */ new Set();
      function ensureLegacyMigrated(dir) {
        if (legacyChecked.has(dir)) return false;
        const root = backupRoot();
        if (!root) return false;
        legacyChecked.add(dir);
        const legacy = path.join(dir, VERSIONS_DIR);
        if (!fs2.existsSync(legacy)) return false;
        const target = versionBase(dir);
        if (fs2.existsSync(target) && listDir(target).length) return false;
        try {
          mergeMove(legacy, target);
        } catch {
          return false;
        }
        return true;
      }
      function backupStatePath(dir) {
        return path.join(dir, BACKUP_STATE);
      }
      function loadBackupState(dir) {
        try {
          return JSON.parse(readText(backupStatePath(dir), "{}")) || {};
        } catch {
          return {};
        }
      }
      function saveBackupState(dir, st) {
        writeTextAtomic(backupStatePath(dir), JSON.stringify(st, null, 2) + "\n");
      }
      function noteSave(dir, delta, threshold) {
        const st = loadBackupState(dir);
        const pending = (Number(st.pending) || 0) + Math.max(0, Number(delta) || 0);
        if (!threshold || pending >= Number(threshold)) {
          if (st.pending) {
            st.pending = 0;
            saveBackupState(dir, st);
          }
          return true;
        }
        st.pending = pending;
        saveBackupState(dir, st);
        return false;
      }
      function resetPending(dir) {
        const st = loadBackupState(dir);
        if (st.pending) {
          st.pending = 0;
          saveBackupState(dir, st);
        }
      }
      function diffLines(before, after) {
        const A = (before || "").split("\n");
        const B = (after || "").split("\n");
        const n = A.length;
        const m = B.length;
        if (n * m > 4e6) {
          return [{ type: "info", text: "内容过大，已跳过逐行对比" }];
        }
        const W = m + 1;
        const dp = new Uint32Array((n + 1) * W);
        for (let i2 = n - 1; i2 >= 0; i2 -= 1) {
          for (let j2 = m - 1; j2 >= 0; j2 -= 1) {
            dp[i2 * W + j2] = A[i2] === B[j2] ? dp[(i2 + 1) * W + (j2 + 1)] + 1 : Math.max(dp[(i2 + 1) * W + j2], dp[i2 * W + (j2 + 1)]);
          }
        }
        const out = [];
        let i = 0;
        let j = 0;
        while (i < n && j < m) {
          if (A[i] === B[j]) {
            out.push({ type: "eq", text: A[i] });
            i += 1;
            j += 1;
          } else if (dp[(i + 1) * W + j] >= dp[i * W + (j + 1)]) {
            out.push({ type: "del", text: A[i] });
            i += 1;
          } else {
            out.push({ type: "add", text: B[j] });
            j += 1;
          }
        }
        while (i < n) out.push({ type: "del", text: A[i++] });
        while (j < m) out.push({ type: "add", text: B[j++] });
        return out;
      }
      module.exports = {
        snapshot,
        list,
        read,
        diffLines,
        versionDir,
        versionBase,
        migrate,
        setRootResolver,
        projectKey,
        migrateBackupRoot,
        ensureLegacyMigrated,
        noteSave,
        resetPending,
        statTree
      };
    }
  });

  // src/main/services/chapters.js
  var require_chapters = __commonJS({
    "src/main/services/chapters.js"(exports, module) {
      "use strict";
      var path = require_path();
      var fs2 = require_fs();
      var { ensureDir, readText, writeTextAtomic, listDir, exists, countWords, safeFileName } = require_fsutil();
      var fm = require_frontmatter();
      var versions = require_versions();
      var CHAPTERS_DIR = "chapters";
      var DRAFTS_DIR = path.join(".mushu", "drafts");
      var VOLUME_RE = /^v(\d{3,})-(.+)$/;
      var CHAPTER_RE = /^(\d{4,})-(.+)\.md$/;
      var pad = (n, len) => String(n).padStart(len, "0");
      function toId(rel) {
        return rel.split(path.sep).join("/");
      }
      function fromId(dir, id) {
        return path.join(dir, ...id.split("/"));
      }
      function chaptersRoot(dir) {
        return path.join(dir, CHAPTERS_DIR);
      }
      function draftPath(dir, id) {
        return path.join(dir, DRAFTS_DIR, `${id.replace(/[\\/]/g, "__")}.json`);
      }
      function tree(dir) {
        const root = chaptersRoot(dir);
        const volumes = listDir(root).filter((e) => e.isDirectory() && VOLUME_RE.test(e.name)).map((e) => {
          const m = e.name.match(VOLUME_RE);
          const volAbs = path.join(root, e.name);
          const chapters = listDir(volAbs).filter((c) => c.isFile() && CHAPTER_RE.test(c.name)).map((c) => {
            const cm = c.name.match(CHAPTER_RE);
            const rel = toId(path.join(CHAPTERS_DIR, e.name, c.name));
            const raw = readText(path.join(volAbs, c.name), "");
            const { meta, body } = fm.split(raw);
            return {
              id: rel,
              index: Number(cm[1]),
              title: meta.title || cm[2],
              status: meta.status || "draft",
              words: meta.words != null ? Number(meta.words) || 0 : countWords(body)
            };
          }).sort((a, b) => a.index - b.index);
          return {
            path: toId(path.join(CHAPTERS_DIR, e.name)),
            name: e.name,
            index: Number(m[1]),
            title: m[2],
            words: chapters.reduce((s, c) => s + c.words, 0),
            chapters
          };
        }).sort((a, b) => a.index - b.index);
        return {
          volumes,
          totalWords: volumes.reduce((s, v) => s + v.words, 0),
          chapterCount: volumes.reduce((s, v) => s + v.chapters.length, 0)
        };
      }
      function readChapter(dir, id) {
        const abs = fromId(dir, id);
        const raw = readText(abs);
        if (raw === null) throw new Error("章节不存在：" + id);
        const { meta, body } = fm.split(raw);
        const draft = loadDraft(dir, id);
        const stat = fs2.statSync(abs);
        return {
          id,
          meta: { id, status: "draft", ...meta },
          body,
          words: countWords(body),
          updatedAt: stat.mtime.toISOString(),
          // 草稿比正文文件新，说明上次是异常退出，存在未提交内容
          recoverableDraft: draft && draft.body !== body ? draft : null
        };
      }
      function saveChapter(dir, id, { meta = {}, body = "" } = {}) {
        const abs = fromId(dir, id);
        const prevRaw = readText(abs, "");
        const prev = fm.split(prevRaw);
        const prevWords = countWords(prev.body);
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const nextMeta = {
          ...prev.meta,
          ...meta,
          id,
          words: countWords(body),
          created: prev.meta.created || now,
          updated: now
        };
        writeTextAtomic(abs, fm.serialize(nextMeta, body));
        clearDraft(dir, id);
        return { id, meta: nextMeta, words: nextMeta.words, prevWords, delta: nextMeta.words - prevWords, savedAt: now };
      }
      function nextIndex(names, re) {
        let max = 0;
        for (const name of names) {
          const m = name.match(re);
          if (m) max = Math.max(max, Number(m[1]));
        }
        return max + 1;
      }
      function createVolume(dir, title = "新卷") {
        const root = chaptersRoot(dir);
        ensureDir(root);
        const index = nextIndex(listDir(root).map((e) => e.name), VOLUME_RE);
        const name = `v${pad(index, 3)}-${title}`;
        ensureDir(path.join(root, name));
        return { path: toId(path.join(CHAPTERS_DIR, name)), name, index, title };
      }
      function createChapter(dir, volumePath, title = "新章节") {
        const volAbs = path.join(dir, ...volumePath.split("/"));
        ensureDir(volAbs);
        const index = nextIndex(listDir(volAbs).map((e) => e.name), CHAPTER_RE);
        const fileName = `${pad(index, 4)}-${title}.md`;
        const id = toId(path.join(volumePath, fileName));
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const meta = { id, title, status: "draft", words: 0, pov: "", characters: [], foreshadows: [], created: now, updated: now };
        writeTextAtomic(path.join(volAbs, fileName), fm.serialize(meta, ""));
        return { id, meta, body: "", words: 0 };
      }
      function migrateDrafts(dir, oldId, newId) {
        if (oldId === newId) return;
        const abs = path.join(dir, DRAFTS_DIR);
        const oldKey = oldId.replace(/[\\/]/g, "__");
        const newKey = newId.replace(/[\\/]/g, "__");
        for (const e of listDir(abs).filter((x) => x.isFile() && x.name.startsWith(oldKey))) {
          try {
            fs2.renameSync(path.join(abs, e.name), path.join(abs, newKey + e.name.slice(oldKey.length)));
          } catch {
          }
        }
      }
      function migrateArtifacts(dir, oldId, newId) {
        versions.migrate(dir, oldId, newId);
        migrateDrafts(dir, oldId, newId);
      }
      function renameVolume(dir, volumePath, title) {
        const root = chaptersRoot(dir);
        const oldName = path.basename(volumePath);
        const m = oldName.match(VOLUME_RE);
        if (!m) throw new Error("不是有效的分卷：" + oldName);
        const clean = safeFileName(title, "新卷");
        if (clean === m[2]) return null;
        const newName = `v${pad(Number(m[1]), 3)}-${clean}`;
        const newPath = toId(path.join(CHAPTERS_DIR, newName));
        if (exists(path.join(root, newName))) throw new Error("同名分卷已存在：" + clean);
        const oldPath = toId(path.join(CHAPTERS_DIR, oldName));
        const chapterIds = listDir(path.join(root, oldName)).filter((c) => c.isFile() && CHAPTER_RE.test(c.name)).map((c) => toId(path.join(oldPath, c.name)));
        fs2.renameSync(path.join(root, oldName), path.join(root, newName));
        for (const oldId of chapterIds) {
          migrateArtifacts(dir, oldId, newPath + oldId.slice(oldPath.length));
        }
        return { path: newPath, name: newName, index: Number(m[1]), title: clean };
      }
      function renameChapter(dir, id, title) {
        const oldAbs = fromId(dir, id);
        const raw = readText(oldAbs);
        if (raw === null) throw new Error("章节不存在：" + id);
        const oldName = path.basename(id);
        const m = oldName.match(CHAPTER_RE);
        if (!m) throw new Error("不是有效的章节文件：" + oldName);
        const clean = safeFileName(title, "未命名章节");
        const newName = `${pad(Number(m[1]), 4)}-${clean}.md`;
        const newId = toId(path.join(path.dirname(id), newName));
        if (newName !== oldName) {
          if (exists(fromId(dir, newId))) throw new Error("同名章节已存在：" + clean);
          fs2.renameSync(oldAbs, fromId(dir, newId));
          migrateArtifacts(dir, id, newId);
        }
        const { meta, body } = fm.split(raw);
        const nextMeta = { ...meta, id: newId, title: clean, updated: (/* @__PURE__ */ new Date()).toISOString() };
        writeTextAtomic(fromId(dir, newId), fm.serialize(nextMeta, body));
        return { id: newId, title: clean, meta: nextMeta, words: countWords(body) };
      }
      function saveDraft(dir, id, { meta, body }) {
        writeTextAtomic(draftPath(dir, id), JSON.stringify({ id, meta, body, at: (/* @__PURE__ */ new Date()).toISOString() }));
      }
      function loadDraft(dir, id) {
        const raw = readText(draftPath(dir, id));
        if (!raw) return null;
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }
      function clearDraft(dir, id) {
        const p = draftPath(dir, id);
        if (exists(p)) {
          try {
            fs2.unlinkSync(p);
          } catch {
          }
        }
      }
      function search(dir, query, limit = { chapters: 50, hits: 80 }) {
        const q = String(query == null ? "" : query).trim();
        const out = { chapters: [], hits: [], truncated: false };
        if (!q) return out;
        const needle = q.toLowerCase();
        for (const vol of tree(dir).volumes) {
          for (const ch of vol.chapters) {
            if (ch.title.toLowerCase().includes(needle)) {
              if (out.chapters.length < limit.chapters) {
                out.chapters.push({ id: ch.id, title: ch.title, volume: vol.title, index: ch.index });
              } else {
                out.truncated = true;
              }
            }
            if (out.hits.length >= limit.hits) {
              out.truncated = true;
              continue;
            }
            const lines = fm.split(readText(fromId(dir, ch.id), "")).body.split("\n");
            let offset = 0;
            for (let i = 0; i < lines.length; i += 1) {
              const col = lines[i].toLowerCase().indexOf(needle);
              if (col >= 0) {
                out.hits.push({
                  id: ch.id,
                  title: ch.title,
                  line: i + 1,
                  at: offset + col,
                  // 正文里的字符位置，点一下就能把光标定位过去
                  text: lines[i].trim().slice(0, 120)
                });
                if (out.hits.length >= limit.hits) {
                  out.truncated = true;
                  break;
                }
              }
              offset += lines[i].length + 1;
            }
          }
        }
        return out;
      }
      function appearances(dir, terms) {
        const list = [...new Set((Array.isArray(terms) ? terms : []).map((t) => String(t == null ? "" : t).trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
        if (!list.length) return [];
        const re = new RegExp(list.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
        const out = [];
        for (const vol of tree(dir).volumes) {
          for (const ch of vol.chapters) {
            const body = fm.split(readText(fromId(dir, ch.id), "")).body;
            re.lastIndex = 0;
            let m = re.exec(body);
            if (!m) continue;
            const at = m.index;
            const term = m[0];
            let count = 0;
            while (m) {
              count += 1;
              m = re.exec(body);
            }
            out.push({ id: ch.id, title: ch.title, volume: vol.title, index: ch.index, count, at, term });
          }
        }
        return out;
      }
      module.exports = {
        tree,
        search,
        appearances,
        readChapter,
        saveChapter,
        createVolume,
        createChapter,
        renameVolume,
        renameChapter,
        saveDraft,
        loadDraft,
        clearDraft,
        fromId,
        CHAPTERS_DIR
      };
    }
  });

  // src/main/services/stats.js
  var require_stats = __commonJS({
    "src/main/services/stats.js"(exports, module) {
      "use strict";
      var path = require_path();
      var { readText, writeTextAtomic, localDate } = require_fsutil();
      var STATS_REL = path.join(".mushu", "stats.json");
      function statsPath(dir) {
        return path.join(dir, STATS_REL);
      }
      function load(dir) {
        const raw = readText(statsPath(dir));
        if (!raw) return { schema: 1, total: 0, days: {}, lastChapter: null };
        try {
          const data = JSON.parse(raw);
          return { schema: 1, total: 0, days: {}, lastChapter: null, ...data };
        } catch {
          return { schema: 1, total: 0, days: {}, lastChapter: null };
        }
      }
      function save(dir, data) {
        writeTextAtomic(statsPath(dir), JSON.stringify(data, null, 2) + "\n");
      }
      function addWords(dir, chapterId, delta) {
        const data = load(dir);
        const today = localDate();
        if (delta > 0) {
          data.days[today] = (data.days[today] || 0) + delta;
          data.total += delta;
        }
        data.lastChapter = { id: chapterId, at: (/* @__PURE__ */ new Date()).toISOString() };
        save(dir, data);
        return data;
      }
      function streak(days) {
        const keys = Object.keys(days).filter((k) => days[k] > 0).sort();
        if (!keys.length) return 0;
        const oneDay = 864e5;
        const toTime = (k) => (/* @__PURE__ */ new Date(k + "T00:00:00")).getTime();
        const today = toTime(localDate());
        let cursor = toTime(keys[keys.length - 1]);
        if (cursor < today - oneDay) return 0;
        let n = 0;
        while (days[localDate(new Date(cursor))] > 0) {
          n += 1;
          cursor -= oneDay;
        }
        return n;
      }
      function summary(dir, recentDays = 30) {
        const data = load(dir);
        const today = localDate();
        const list = [];
        const oneDay = 864e5;
        const base = (/* @__PURE__ */ new Date(today + "T00:00:00")).getTime();
        for (let i = recentDays - 1; i >= 0; i -= 1) {
          const d = localDate(new Date(base - i * oneDay));
          list.push({ date: d, words: data.days[d] || 0 });
        }
        return {
          today: data.days[today] || 0,
          total: data.total || 0,
          streak: streak(data.days),
          lastChapter: data.lastChapter || null,
          recent: list
        };
      }
      module.exports = { load, save, addWords, summary, statsPath };
    }
  });

  // src/main/services/settings.js
  var require_settings = __commonJS({
    "src/main/services/settings.js"(exports, module) {
      "use strict";
      var { readText, writeTextAtomic } = require_fsutil();
      function createStore(file, defaults) {
        function load() {
          const base = defaults();
          const raw = readText(file);
          if (!raw) return { ...base };
          try {
            const parsed = JSON.parse(raw);
            return { ...base, ...parsed && typeof parsed === "object" ? parsed : {} };
          } catch {
            return { ...base };
          }
        }
        function save(patch) {
          const next = { ...load(), ...patch || {} };
          writeTextAtomic(file, JSON.stringify(next, null, 2) + "\n");
          return next;
        }
        return { load, save };
      }
      module.exports = { createStore };
    }
  });

  // src/main/services/shortcuts.js
  var require_shortcuts = __commonJS({
    "src/main/services/shortcuts.js"(exports, module) {
      "use strict";
      var DEFAULT_SHORTCUTS = {
        newChapter: "CommandOrControl+N",
        fullscreen: "CommandOrControl+.",
        formatText: "CommandOrControl+K",
        insertDivider: "CommandOrControl+Alt+S",
        gotoChapterStart: "CommandOrControl+Up",
        gotoChapterEnd: "CommandOrControl+Down",
        bossKey: "Alt+`",
        showShortcuts: "CommandOrControl+0",
        outline: "CommandOrControl+1",
        settingPanel: "CommandOrControl+2",
        canvas: "CommandOrControl+3",
        findReplace: "CommandOrControl+F",
        saveChapter: "CommandOrControl+S"
      };
      var SHORTCUT_LABELS = {
        newChapter: "新建章节",
        fullscreen: "全屏",
        formatText: "一键排版",
        insertDivider: "插入分割线",
        gotoChapterStart: "定位章首",
        gotoChapterEnd: "定位章尾",
        bossKey: "老板键",
        showShortcuts: "查看快捷键",
        outline: "大纲",
        settingPanel: "设定",
        canvas: "无限画布",
        findReplace: "查找替换",
        saveChapter: "保存章节"
      };
      function normalizeShortcuts(patch) {
        const out = { ...DEFAULT_SHORTCUTS };
        if (patch && typeof patch === "object") {
          for (const key of Object.keys(DEFAULT_SHORTCUTS)) {
            if (typeof patch[key] === "string") out[key] = patch[key].trim();
          }
        }
        return out;
      }
      module.exports = { DEFAULT_SHORTCUTS, SHORTCUT_LABELS, normalizeShortcuts };
    }
  });

  // src/main/services/cast.js
  var require_cast = __commonJS({
    "src/main/services/cast.js"(exports, module) {
      "use strict";
      var path = require_path();
      var { readText, writeTextAtomic } = require_fsutil();
      var CAST_REL = path.join("bible", "cast.json");
      function castPath(dir) {
        return path.join(dir, CAST_REL);
      }
      function normalizeList(list) {
        const seen = /* @__PURE__ */ new Set();
        const out = [];
        for (const item of Array.isArray(list) ? list : []) {
          const name = String(item && item.name || "").trim();
          if (!name || seen.has(name)) continue;
          seen.add(name);
          const aliases = [];
          const aliasSeen = /* @__PURE__ */ new Set();
          for (const a of Array.isArray(item && item.aliases) ? item.aliases : []) {
            const s = String(a || "").trim();
            if (s && s !== name && !aliasSeen.has(s)) {
              aliasSeen.add(s);
              aliases.push(s);
            }
          }
          out.push({ name, aliases, desc: String(item && item.desc || "") });
        }
        return out;
      }
      function normalize(data) {
        return {
          characters: normalizeList(data && data.characters),
          settings: normalizeList(data && data.settings)
        };
      }
      function read(dir) {
        const raw = readText(castPath(dir));
        if (!raw) return { characters: [], settings: [] };
        try {
          return normalize(JSON.parse(raw));
        } catch {
          return { characters: [], settings: [] };
        }
      }
      function save(dir, data) {
        const clean = normalize(data);
        writeTextAtomic(castPath(dir), JSON.stringify(clean, null, 2) + "\n");
        return clean;
      }
      module.exports = { read, save, castPath };
    }
  });

  // src/main/services/canvas.js
  var require_canvas = __commonJS({
    "src/main/services/canvas.js"(exports, module) {
      "use strict";
      var path = require_path();
      var { readText, writeTextAtomic } = require_fsutil();
      var CANVAS_REL = path.join("bible", "canvas.json");
      function canvasPath(dir) {
        return path.join(dir, CANVAS_REL);
      }
      var seq = 0;
      function newId(prefix) {
        seq += 1;
        return `${prefix}-${Date.now().toString(36)}-${seq}`;
      }
      function num(v, fallback) {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
      }
      function str(v) {
        return String(v == null ? "" : v);
      }
      function normalizeStages(raw) {
        if (!Array.isArray(raw)) return [];
        const out = [];
        for (const item of raw) {
          if (!item || typeof item !== "object") continue;
          const stage = str(item.stage).trim().slice(0, 20);
          const age = str(item.age).trim().slice(0, 20);
          const appearance = str(item.appearance).trim().slice(0, 400);
          const summary = str(item.summary).trim().slice(0, 300);
          if (!stage && !appearance) continue;
          out.push({ stage, age, appearance, summary });
          if (out.length >= 8) break;
        }
        return out;
      }
      function normalizeCard(raw) {
        const name = str(raw && raw.name).trim();
        if (!name) return null;
        const aliases = [];
        for (const a of Array.isArray(raw && raw.aliases) ? raw.aliases : []) {
          const s = str(a).trim();
          if (s && s !== name && !aliases.includes(s)) aliases.push(s);
        }
        return {
          id: str(raw && raw.id).trim() || newId("card"),
          name,
          aliases,
          desc: str(raw && raw.desc),
          // AI 档案：从正文里提炼的背景 / 性格 / 外貌，用户也可以手改
          background: str(raw && raw.background),
          personality: str(raw && raw.personality),
          appearance: str(raw && raw.appearance),
          // 同一个人在不同人生阶段的样貌变体（幼年/少年/青年/中年/老年…）
          stages: normalizeStages(raw && raw.stages),
          // 已生成标记：有值就不再自动生成，避免每次点开都重复请求模型
          profileAt: str(raw && raw.profileAt),
          stagesAt: str(raw && raw.stagesAt),
          x: num(raw && raw.x, 0),
          y: num(raw && raw.y, 0),
          // 是否已摆到画布上：cards 是「角色库」，未放置的只留在左栏，不进知识图谱
          placed: raw && raw.placed === true
        };
      }
      var MAX_SUB_DEPTH = 6;
      function normalizePoint(raw, level) {
        const title = str(raw && raw.title).trim();
        if (!title) return null;
        const point = {
          id: str(raw && raw.id).trim() || newId("beat"),
          title,
          desc: str(raw && raw.desc),
          // 下面几项是节点信息里的详细内容，画布上只显示标题 + 一句话
          detail: str(raw && raw.detail),
          who: str(raw && raw.who),
          place: str(raw && raw.place),
          chapter: str(raw && raw.chapter),
          x: num(raw && raw.x, 0),
          y: num(raw && raw.y, 0)
        };
        if (level < MAX_SUB_DEPTH && raw && raw.sub && typeof raw.sub === "object") {
          const sub = normalizeCanvas(raw.sub, level + 1);
          if (sub.cards.length || sub.points.length || sub.links.length) point.sub = sub;
        }
        return point;
      }
      function normalizeLink(raw, cardIds) {
        const from = str(raw && raw.from).trim();
        const to = str(raw && raw.to).trim();
        if (!from || !to || from === to) return null;
        if (cardIds && (!cardIds.has(from) || !cardIds.has(to))) return null;
        return {
          id: str(raw && raw.id).trim() || newId("link"),
          from,
          to,
          label: str(raw && raw.label).trim()
        };
      }
      function normalizeCanvas(data, level) {
        const vp = data && data.viewport || {};
        const cards = (Array.isArray(data && data.cards) ? data.cards : []).map(normalizeCard).filter(Boolean);
        const ids = new Set(cards.map((c) => c.id));
        const links = [];
        const seen = /* @__PURE__ */ new Set();
        for (const raw of Array.isArray(data && data.links) ? data.links : []) {
          const l = normalizeLink(raw, ids);
          if (!l) continue;
          const key = l.from + ">" + l.to;
          if (seen.has(key)) continue;
          seen.add(key);
          links.push(l);
        }
        const focus = str(data && data.focus).trim();
        const rawDepth = num(data && data.depth, 2);
        return {
          schema: 1,
          mode: data && data.mode === "graph" ? "graph" : "story",
          // 被关掉的关系分类（分类名由前端按本书关系词现算），空数组代表全部显示
          hiddenCats: [...new Set((Array.isArray(data && data.hiddenCats) ? data.hiddenCats : []).map(str).filter(Boolean))],
          viewport: {
            x: num(vp.x, 0),
            y: num(vp.y, 0),
            zoom: Math.min(3, Math.max(0.2, num(vp.zoom, 1)))
          },
          focus: ids.has(focus) ? focus : "",
          depth: [0, 1, 2, 3].includes(rawDepth) ? rawDepth : 2,
          cards,
          points: (Array.isArray(data && data.points) ? data.points : []).map((p) => normalizePoint(p, level)).filter(Boolean),
          links
        };
      }
      function normalize(data) {
        return normalizeCanvas(data, 0);
      }
      function read(dir) {
        const raw = readText(canvasPath(dir));
        if (raw === null) return { ...normalize({}), fresh: true };
        try {
          return { ...normalize(JSON.parse(raw)), fresh: false };
        } catch {
          return { ...normalize({}), fresh: false };
        }
      }
      function save(dir, data) {
        const clean = normalize(data);
        writeTextAtomic(canvasPath(dir), JSON.stringify(clean, null, 2) + "\n");
        return clean;
      }
      module.exports = { read, save, canvasPath, normalize };
    }
  });

  // src/main/services/importer.js
  var require_importer = __commonJS({
    "src/main/services/importer.js"(exports, module) {
      "use strict";
      var path = require_path();
      var fs2 = require_fs();
      var { ensureDir, safeFileName, countWords } = require_fsutil();
      var project = require_project();
      var chapters = require_chapters();
      var DEFAULT_VOLUME = "chapters/v001-第一卷";
      var SOURCE_DIR = "source";
      var CHAPTER_HEAD_RE = /^第\s*[0-9零一二三四五六七八九十百千万〇两壹贰叁肆伍陆柒捌玖拾佰仟]+\s*[章回节篇](?![0-9])/;
      var CHAPTER_ALT_RE = /^(?:chapter|chap\.?)\s*[0-9ivxlcdm]+/i;
      var VOLUME_HEAD_RE = /^第\s*[0-9零一二三四五六七八九十百千万〇两]+\s*卷/;
      var HEAD_MAX_LEN = 40;
      function isChapterHead(line) {
        const t = line.trim();
        if (!t || t.length > HEAD_MAX_LEN) return false;
        return CHAPTER_HEAD_RE.test(t) || CHAPTER_ALT_RE.test(t);
      }
      function decode(buffer) {
        const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
        if (buf.length >= 3 && buf[0] === 239 && buf[1] === 187 && buf[2] === 191) {
          return new TextDecoder("utf-8").decode(buf.subarray(3));
        }
        if (buf.length >= 2 && buf[0] === 255 && buf[1] === 254) {
          return buf.toString("utf16le").replace(/^\uFEFF/, "");
        }
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(buf);
        } catch {
          return new TextDecoder("gbk").decode(buf);
        }
      }
      function splitChapters(text) {
        const lines = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
        const heads = [];
        lines.forEach((line, i) => {
          if (isChapterHead(line)) heads.push(i);
        });
        if (!heads.length) return { chapters: [], skipped: countWords(lines.join("\n")) };
        const out = [];
        for (let i = 0; i < heads.length; i += 1) {
          const start2 = heads[i];
          const end = i + 1 < heads.length ? heads[i + 1] : lines.length;
          const title = safeFileName(lines[start2].trim(), `第${i + 1}章`);
          const body = lines.slice(start2 + 1, end).filter((line) => !VOLUME_HEAD_RE.test(line.trim())).join("\n").trim();
          out.push({ title, body });
        }
        return { chapters: out, skipped: countWords(lines.slice(0, heads[0]).join("\n")) };
      }
      function importTxt({ file, title, author, root } = {}) {
        const abs = String(file || "").trim();
        if (!abs) throw new Error("没有选择 TXT 文件");
        if (!fs2.existsSync(abs) || !fs2.statSync(abs).isFile()) throw new Error("文件不存在：" + abs);
        if (!root) throw new Error("还没有设置默认作品目录，请先在「设置」里指定");
        let buffer;
        try {
          buffer = fs2.readFileSync(abs);
        } catch (err) {
          throw new Error("读取文件失败：" + err.message);
        }
        const { chapters: list, skipped } = splitChapters(decode(buffer));
        if (!list.length) {
          throw new Error("没有识别到章节标题（如「第一章 楔子」），无法自动切章。请先在 TXT 里加上章节标题再导入。");
        }
        const fallbackTitle = path.basename(abs, path.extname(abs));
        const bookTitle = String(title || "").trim() || fallbackTitle || "未命名作品";
        const dir = project.resolveProjectDir(root, bookTitle);
        const { book } = project.createProject(dir, { title: bookTitle, author });
        const sourceName = safeFileName(path.basename(abs), "原文.txt");
        ensureDir(path.join(dir, SOURCE_DIR));
        fs2.copyFileSync(abs, path.join(dir, SOURCE_DIR, sourceName));
        let words = 0;
        for (const item of list) {
          const created = chapters.createChapter(dir, DEFAULT_VOLUME, item.title);
          const saved = chapters.saveChapter(dir, created.id, { meta: { status: "draft" }, body: item.body ? item.body + "\n" : "" });
          words += saved.words;
        }
        return {
          project: { dir, book },
          tree: chapters.tree(dir),
          imported: {
            dir,
            chapters: list.length,
            words,
            skipped,
            file: abs,
            source: `${SOURCE_DIR}/${sourceName}`
          }
        };
      }
      module.exports = { decode, splitChapters, importTxt, DEFAULT_VOLUME, SOURCE_DIR };
    }
  });

  // src/mobile/ai-client.js
  var require_ai_client = __commonJS({
    "src/mobile/ai-client.js"(exports, module) {
      "use strict";
      var config2 = require_config();
      var MODEL = "deepseek-chat";
      var VISION_MODEL = "deepseek-v4-flash-vision-exp";
      var MAX_CONTEXT_CHARS = 12e4;
      var configured = null;
      var detectedSource = "";
      function pickModel(messages) {
        const list = Array.isArray(messages) ? messages : [];
        const hasImage = list.some(
          (m) => m && Array.isArray(m.content) && m.content.some((part) => part && part.type === "image_url")
        );
        return hasImage ? VISION_MODEL : MODEL;
      }
      function url(p) {
        return config2.get().baseUrl.replace(/\/+$/, "") + p;
      }
      function headers(extra) {
        const cfg = config2.get();
        return {
          "Content-Type": "application/json",
          "X-Mushu-Password": cfg.password || "",
          ...extra || {}
        };
      }
      function requireConnection() {
        const cfg = config2.get();
        if (!cfg.baseUrl) throw new Error("还没有设置服务器地址");
        if (!cfg.password) throw new Error("还没有填写服务器访问密码，请到「设置 → 同步」里填写");
      }
      async function refreshStatus() {
        try {
          requireConnection();
          const res = await fetch(url("/api/ai/status"), { headers: headers() });
          if (!res.ok) throw new Error("HTTP " + res.status);
          const data = await res.json();
          configured = !!data.configured;
          detectedSource = data.source || "";
        } catch {
          configured = null;
          detectedSource = "";
        }
        return { configured: configured !== false, source: detectedSource || "server" };
      }
      async function verify({ baseUrl, password }) {
        const root = String(baseUrl || "").trim().replace(/\/+$/, "");
        const url0 = (!root ? "" : /^https?:\/\//i.test(root) ? root : "https://" + root) + "/api/ai/status";
        let res;
        try {
          res = await fetch(url0, { headers: { "X-Mushu-Password": String(password || "") } });
        } catch {
          throw new Error("连不上服务器，请检查地址和网络");
        }
        if (res.status === 401) throw new Error("访问密码不正确");
        if (!res.ok) throw new Error("服务器返回 " + res.status);
        return res.json();
      }
      async function setKey(key) {
        requireConnection();
        const res = await fetch(url("/api/ai/key"), {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ key: String(key == null ? "" : key) })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "保存密钥失败");
        configured = !!data.configured;
        detectedSource = data.source || "";
        return { configured: configured !== false, source: detectedSource || "server" };
      }
      function apiKey() {
        return configured === false ? "" : "server";
      }
      function keySource() {
        return configured === false ? "" : "server";
      }
      function setKeyProvider() {
      }
      function parseChunk(line, onDelta, acc) {
        const text = line.trim();
        if (!text.startsWith("data:")) return acc;
        const payload = text.slice(5).trim();
        if (!payload || payload === "[DONE]") return acc;
        try {
          const json = JSON.parse(payload);
          const delta = json.choices && json.choices[0] && json.choices[0].delta;
          const piece = delta && delta.content;
          if (piece) {
            acc += piece;
            if (onDelta) onDelta(piece);
          }
        } catch {
        }
        return acc;
      }
      async function chat({ messages, signal, onDelta, temperature, json, maxTokens, timeoutMs }) {
        requireConnection();
        const cfg = config2.get();
        let controller = null;
        let timer = null;
        let merged = signal;
        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
          controller = new AbortController();
          timer = setTimeout(() => controller.abort(new Error("请求超时")), timeoutMs);
          merged = signal && typeof AbortSignal !== "undefined" && AbortSignal.any ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        }
        try {
          const res = await fetch(url("/api/ai/chat"), {
            method: "POST",
            headers: headers(),
            body: JSON.stringify({
              messages,
              model: pickModel(messages),
              stream: true,
              temperature: Number.isFinite(temperature) ? temperature : 0.7,
              json: !!json,
              maxTokens: Number.isFinite(maxTokens) ? Math.round(maxTokens) : 0
            }),
            signal: merged
          });
          if (!res.ok) {
            let detail = "";
            try {
              const data = await res.json();
              detail = data.error || "";
            } catch {
              detail = "";
            }
            throw new Error(detail || `AI 接口返回 ${res.status}`);
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder("utf-8");
          let buf = "";
          let full = "";
          for (; ; ) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf("\n")) !== -1) {
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
        pickModel
      };
    }
  });

  // src/main/services/analyze.js
  var require_analyze = __commonJS({
    "src/main/services/analyze.js"(exports, module) {
      "use strict";
      var fs2 = require_fs();
      var path = require_path();
      var crypto = require_crypto();
      var chapters = require_chapters();
      var canvas = require_canvas();
      var ai2 = require_ai_client();
      var { readText, writeTextAtomic, ensureDir } = require_fsutil();
      var CACHE_REL = path.join(".mushu", "analysis");
      var CACHE_VERSION = 2;
      var CARD_W = 88;
      var MAX_CARDS = 400;
      var MIN_MENTIONS = 5;
      var MIN_CHAPTERS = 2;
      var SURNAMES = "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯管卢莫经房裘缪干解应宗丁宣邓郁单杭洪包诸左石崔吉龚程邢滑裴陆荣翁荀羊惠甄曲封芮储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩聂晁勾敖融冷訾辛阚那简饶空曾毋沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公";
      var STOP = new Set(
        "他们 她们 我们 你们 咱们 大家 众人 众人皆 有人 有人 那人 这人 此人 对方 两人 三人 一人 自己 心中 心头 脸上 眼中 所有人 一群人 男人 女人 老人 少年 青年 孩子 父亲 母亲 儿子 女儿 哥哥 姐姐 弟弟 妹妹 丈夫 妻子 爷爷 奶奶 老爷 夫人 小姐 公子 姑娘 先生 掌柜 老板 丫鬟 小厮 士兵 军官 将军 皇帝 皇上 太后 王爷 大人 小人 属下 在下 诸位 各位 一边 此时 这时 那时 当下 当时 原本 本来 随后 接着 然后 于是 因此 但是 不过 只是 就是 还是 可是 所以 如果 虽然 已经 正在 刚刚 忽然 突然 顿时 立刻 马上 终于 果然 依然 仍旧 仍然 只有 没有 不是 不能 不会 不要 一个 两个 三个 几个 许多 很多 有些 所有 整个 全部 这样 那样 这里 那里 哪里 什么 怎么 为何 因为 到了 看到 听到 想到 知道 觉得 认为 看到 说着 说话 开口 点头 摇头 皱眉 叹气 回答 答应 开口 沉声 低声 轻声 大声 高声 急忙 连忙 冷笑 苦笑 笑道 说道 问道 答道 应道 方才 方才说 通常 通常来 相对 相对来 一直 一直被 富家 体制 姑爷 地雷 竹记 华夏军 华夏军来 青木寨 小苍河 桃亭县 黄石沟 九木岭 霍川岭 夏村 杭州 江宁 汴梁 燕京 太原 泽州 吕梁 山东 河北 江南 中原 天下 朝廷 皇宫 军中 军中诸 说出 平等 杀人 作诗仙 一声 一声明 有声 无声 作为 作对 行事 说话 开口 起身 动身 出手 收手 放心 小心 用心 专心 文学 人权 大势 理想 价值观 三观 胎教 水枪 上甘岭 将军岭 救天下 天下无 为第一 为江宁 武林盟 白鹿观 文翰苑 同文轩 时候 后来 许多 许多人 简单 简直 平静 平静地 经明白 相公 相府 娘子 夫君 老丈 老者 汉子 妇人".split(/\s+/).filter(Boolean)
      );
      var LEAD_NOISE = [
        "只见",
        "这时",
        "此时",
        "那时",
        "随后",
        "接着",
        "然后",
        "于是",
        "忽然",
        "突然",
        "顿时",
        "立刻",
        "马上",
        "终于",
        "果然",
        "依然",
        "仍旧",
        "仍然",
        "只有",
        "没有",
        "不是",
        "不能",
        "不会",
        "不要",
        "一边",
        "当下",
        "当时",
        "原本",
        "本来",
        "只是",
        "还是",
        "可是",
        "所以",
        "如果",
        "虽然",
        "已经",
        "正在",
        "刚刚",
        "众人",
        "有人",
        "那人",
        "这人",
        "此人",
        "对方",
        "两人",
        "三人",
        "一人",
        "自己",
        "大家",
        "他们",
        "她们",
        "我们",
        "你们",
        "咱们",
        // 「对于宁毅来说」「至于苏檀儿」这类句式
        "对于",
        "关于",
        "至于",
        "叫作",
        "叫做",
        "名叫",
        "称为"
      ];
      var TRAIL_VERB = ["冷笑", "苦笑", "沉声", "低声", "轻声", "大声", "高声", "急忙", "连忙", "开口", "点头", "摇头", "皱眉", "叹气", "笑着"];
      var TRAIL_CHAR = new Set("冷热笑怒沉低轻大高急缓忙暗心嘴口眉眼面脸手头身脚声".split(""));
      var ATTR_VERBS = "说道|问道|答道|应道|笑道|冷笑道|沉声道|低声道|轻声道|喝道|叫道|怒道|叹道|回答道|开口道|道|说|问|答|回答";
      var ATTR_RE = new RegExp(`([\\u4e00-\\u9fa5]{2,4})(?=(?:${ATTR_VERBS})[：:，,。！？\\s“"」』])`, "g");
      var INTRO_RE = /(?:名叫|叫做|唤作|名唤|人称|外号|绰号)([\u4e00-\u9fa5]{2,3})/g;
      var APPELLATION_RE = /([\u4e00-\u9fa5]{2,3})(?=(?:先生|姑娘|小姐|公子|大人|将军|夫人|掌柜|老板|师父|师傅|师兄|师姐|少爷))/g;
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
      function plausible(name, mentioned = 0, intro = 0) {
        if (!name || name.length < 2 || name.length > 4) return false;
        if (STOP.has(name)) return false;
        if (/[的了是在和与就都也又很更太最不没我你他她它们这那]/.test(name)) return false;
        if (intro > 0) return true;
        if (/^[一这那每各某几半]/.test(name)) return false;
        if (SURNAMES.includes(name[0])) return true;
        return mentioned >= 15;
      }
      function sha1(text) {
        return crypto.createHash("sha1").update(String(text), "utf8").digest("hex");
      }
      function normalizeCandidate(raw) {
        return stripTrail(stripLead(String(raw || "").trim()));
      }
      function mineVolume(chapterList) {
        const cand = /* @__PURE__ */ new Map();
        const touch2 = (raw2, chapterId, kind) => {
          const name = normalizeCandidate(raw2);
          if (!plausible(name, 1, kind === "intro" ? 1 : 0)) return "";
          let item = cand.get(name);
          if (!item) {
            item = { name, mentions: 0, chapters: /* @__PURE__ */ new Set(), intro: 0, first: chapterId };
            cand.set(name, item);
          }
          item.mentions += 1;
          item.chapters.add(chapterId);
          if (kind === "intro") item.intro += 1;
          return name;
        };
        for (const ch of chapterList) {
          const text = ch.body || "";
          for (const m of text.matchAll(ATTR_RE)) touch2(m[1], ch.id, "attr");
          for (const m of text.matchAll(INTRO_RE)) touch2(m[1], ch.id, "intro");
          for (const m of text.matchAll(APPELLATION_RE)) touch2(m[1], ch.id, "appellation");
        }
        let list = [...cand.values()].map((c) => ({ name: c.name, mentions: c.mentions, chapters: c.chapters.size, intro: c.intro, first: c.first })).filter((c) => plausible(c.name, c.mentions, c.intro)).sort((a, b) => b.mentions - a.mentions || b.chapters - a.chapters);
        list = list.filter((c) => {
          const container = list.find(
            (k) => k !== c && c.name.length > k.name.length && c.name.includes(k.name) && (k.mentions >= c.mentions * 2 || !c.intro)
          );
          return !container;
        });
        const pick = (minMentions) => new Set(
          list.filter((c) => c.mentions >= minMentions && c.chapters >= MIN_CHAPTERS || c.intro > 0).map((c) => c.name)
        );
        const candNames = pick(MIN_MENTIONS);
        const rawNames = pick(2);
        const full = countOccurrences(chapterList, list.map((c) => c.name));
        const counted = list.map((c) => {
          const f = full.get(c.name);
          return { ...c, mentions: f ? f.mentions : c.mentions, chapters: f ? f.chapters : c.chapters };
        }).filter((c) => plausible(c.name, c.mentions, c.intro));
        const raw = counted.filter((c) => rawNames.has(c.name)).sort((a, b) => b.mentions - a.mentions);
        const candidates = counted.filter((c) => candNames.has(c.name)).sort((a, b) => b.mentions - a.mentions || b.chapters - a.chapters);
        const pairs = /* @__PURE__ */ new Map();
        const names = candidates.map((c) => c.name);
        if (names.length && names.length <= 1200) {
          for (const ch of chapterList) {
            for (const para of String(ch.body || "").split("\n")) {
              if (para.length < 4 || para.length > 1200) continue;
              const hit = names.filter((n) => para.includes(n));
              if (hit.length < 2) continue;
              const top = hit.slice(0, 6);
              for (let i = 0; i < top.length; i += 1) {
                for (let j = i + 1; j < top.length; j += 1) {
                  const key = top[i] + "|" + top[j];
                  pairs.set(key, (pairs.get(key) || 0) + 1);
                }
              }
            }
          }
        }
        const pairList = [...pairs.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([key, n]) => {
          const [a, b] = key.split("|");
          return { a, b, count: n };
        });
        return { candidates, raw, pairs: pairList };
      }
      function countOccurrences(chapterList, names) {
        const set = new Set(names);
        const stats = new Map(names.map((n) => [n, { mentions: 0, chapters: 0 }]));
        if (!set.size) return stats;
        for (const ch of chapterList) {
          const text = String(ch.body || "");
          const hit = /* @__PURE__ */ new Set();
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
      function sampleText(chapterList, budget) {
        const joined = chapterList.map((c) => `【${c.title}】
${String(c.body || "").trim()}`).join("\n\n");
        const total = joined.length;
        const want = Math.max(4e3, Math.min(Number(budget) || 3e4, 2e5));
        if (total <= want) return joined;
        const chunk = 6e3;
        const count = Math.max(1, Math.round(want / chunk));
        const step = (total - chunk) / Math.max(1, count - 1);
        const parts = [];
        for (let i = 0; i < count; i += 1) {
          let start2 = Math.floor(i * step);
          let end = Math.min(total, start2 + chunk);
          if (start2 > 0) {
            const nl = joined.indexOf("\n", start2);
            if (nl !== -1 && nl - start2 < 600) start2 = nl + 1;
          }
          if (end < total) {
            const nl = joined.lastIndexOf("\n", end);
            if (nl !== -1 && end - nl < 600) end = nl;
          }
          parts.push(joined.slice(start2, end).trim());
        }
        return parts.join("\n\n……\n\n");
      }
      var SYSTEM_PROMPT = [
        "你是中文长篇小说的人物关系抽取器。只输出一个 JSON 对象，不要输出任何解释或 Markdown。",
        "JSON 结构：",
        '{"characters":[{"name":"","aliases":[],"role":"","desc":"","importance":1}],',
        ' "relations":[{"from":"","to":"","label":""}],',
        ' "events":[{"title":"","desc":"","emotion":0,"who":"","place":"","detail":""}]}',
        "规则：",
        "1. name 必须取自【本地候选名单】，或原文中确凿出现的人名；不得臆造，不得把称谓当名字。",
        "2. 候选名单里凡是真实人物，都必须出现在 characters 中，不得因为戏份少而省略；地名、门派、组织、器物直接略过。",
        "3. aliases 只收原文明确指代同一人的称呼（姓名、字、小名、绰号、排行称呼），不要凭猜测。",
        "4. role 用 4-8 字概括身份（如「苏家赘婿」「吕梁宗师」「金国主帅」）。",
        "5. desc 不超过 60 字，写身份与关键作为，不要写评价。",
        "6. importance 取 1-5：5=主角/贯穿全书，4=核心配角，3=重要配角，2=一般配角，1=龙套。",
        "7. relations 的 from/to 必须是 characters 里的 name；label 不超过 6 字（夫妻、父子、师徒、敌对、上下级…）；没有把握就不要写。",
        "8. events 最多 3 条，按时间顺序，emotion 为 -100 到 100 的整数。",
        "9. 每条 event 要写清这一节到底发生了什么：desc 是画布上显示的一句话（不超过 40 字）；who 是本节出场人物，取自 characters 的 name，用「、」分隔；place 是发生地点（不超过 12 字）；detail 是详细经过，80-150 字，按起因、经过、结果写，只说本卷原文里有的事，不要编造。"
      ].join("\n");
      function buildUserPrompt(volTitle, candidates, pairs, text) {
        const cand = candidates.slice(0, 80).map((c) => `${c.name}(${c.mentions})`).join("、");
        const pairText = pairs.slice(0, 20).map((p) => `${p.a}-${p.b}(${p.count})`).join("、");
        return [
          `【本卷】${volTitle}`,
          `【本地候选名单（括号内为全书出现次数）】${cand || "（无）"}`,
          `【本卷高频同场人物对】${pairText || "（无）"}`,
          "【原文节选】",
          "<<<",
          text,
          ">>>"
        ].join("\n");
      }
      function parseModelJson(raw) {
        let s = String(raw || "").trim();
        const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fence) s = fence[1].trim();
        const start2 = s.indexOf("{");
        const end = s.lastIndexOf("}");
        if (start2 !== -1 && end > start2) s = s.slice(start2, end + 1);
        const data = JSON.parse(s);
        const out = { characters: [], relations: [], events: [] };
        for (const raw2 of Array.isArray(data.characters) ? data.characters : []) {
          const name = String(raw2 && raw2.name || "").trim();
          if (!name || name.length > 20) continue;
          const aliases = [];
          for (const a of Array.isArray(raw2.aliases) ? raw2.aliases : []) {
            const s2 = String(a || "").trim();
            if (s2 && s2 !== name && s2.length <= 12 && !aliases.includes(s2)) aliases.push(s2);
          }
          out.characters.push({
            name,
            aliases,
            role: String(raw2 && raw2.role || "").trim().slice(0, 20),
            desc: String(raw2 && raw2.desc || "").trim().slice(0, 200),
            importance: Math.min(5, Math.max(1, Math.round(Number(raw2 && raw2.importance) || 2)))
          });
        }
        for (const raw2 of Array.isArray(data.relations) ? data.relations : []) {
          const from = String(raw2 && raw2.from || "").trim();
          const to = String(raw2 && raw2.to || "").trim();
          if (!from || !to || from === to) continue;
          out.relations.push({ from, to, label: String(raw2 && raw2.label || "").trim().slice(0, 12) });
        }
        for (const raw2 of Array.isArray(data.events) ? data.events : []) {
          const title = String(raw2 && raw2.title || "").trim();
          if (!title) continue;
          out.events.push({
            title: title.slice(0, 30),
            desc: String(raw2 && raw2.desc || "").trim().slice(0, 120),
            emotion: Math.min(100, Math.max(-100, Math.round(Number(raw2 && raw2.emotion) || 0))),
            who: String(raw2 && raw2.who || "").trim().slice(0, 60),
            place: String(raw2 && raw2.place || "").trim().slice(0, 24),
            detail: String(raw2 && raw2.detail || "").trim().slice(0, 400)
          });
        }
        return out;
      }
      async function analyzeVolume({ volTitle, candidates, pairs, text, signal, onDelta }) {
        const messages = [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(volTitle, candidates, pairs, text) }
        ];
        let lastErr = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const raw = await ai2.chat({
              messages: attempt === 0 ? messages : [...messages, { role: "user", content: "上次输出不是合法 JSON，请只输出 JSON 对象。" }],
              signal,
              onDelta,
              temperature: 0.2,
              json: true,
              // 角色多的卷（几十上百人）加上情节点详细经过，输出很容易超过 4000 token 被截断成非法 JSON
              maxTokens: 8e3,
              timeoutMs: 3e5
            });
            return parseModelJson(raw);
          } catch (err) {
            if (signal && signal.aborted) throw err;
            lastErr = err;
          }
        }
        throw new Error(`第「${volTitle}」卷解析失败：${lastErr ? lastErr.message : "模型输出不是合法 JSON"}`);
      }
      function cacheFile(dir) {
        return path.join(dir, CACHE_REL, "volumes.json");
      }
      function loadCache(dir) {
        try {
          const raw = readText(cacheFile(dir));
          if (!raw) return { schema: CACHE_VERSION, volumes: {} };
          const data = JSON.parse(raw);
          if (!data || data.schema !== CACHE_VERSION || typeof data.volumes !== "object") return { schema: CACHE_VERSION, volumes: {} };
          return data;
        } catch {
          return { schema: CACHE_VERSION, volumes: {} };
        }
      }
      function saveCache(dir, cache) {
        ensureDir(path.join(dir, CACHE_REL));
        writeTextAtomic(cacheFile(dir), JSON.stringify(cache, null, 2) + "\n");
      }
      function volumeSignature(vol) {
        return sha1(vol.path + "|" + vol.chapters.map((c) => c.id + ":" + c.words).join(","));
      }
      async function scan({ dir, onProgress, signal }) {
        const tree = chapters.tree(dir);
        if (!tree.volumes.length) throw new Error("这个作品还没有章节，先写几章再分析");
        const result = [];
        let done = 0;
        for (const vol of tree.volumes) {
          const list = [];
          for (const c of vol.chapters) {
            if (signal && signal.aborted) throw new Error("已取消");
            const ch = chapters.readChapter(dir, c.id);
            list.push({ id: c.id, title: ch.meta.title || c.title, body: ch.body });
            done += 1;
            if (onProgress && done % 30 === 0) {
              onProgress({ phase: "scan", message: `已扫描 ${done} 章`, current: done, total: tree.chapterCount });
            }
          }
          const mined = mineVolume(list);
          result.push({
            path: vol.path,
            title: vol.title,
            chapters: list.length,
            candidates: mined.candidates,
            raw: mined.raw,
            pairs: mined.pairs
          });
        }
        return result;
      }
      async function run({ dir, budget = 3e4, force = false, signal, onProgress } = {}) {
        const tree = chapters.tree(dir);
        if (!tree.volumes.length) throw new Error("这个作品还没有章节，先写几章再分析");
        if (!ai2.apiKey()) throw new Error("还没有配置 DeepSeek API Key，请到「设置 → AI」里填写");
        const cache = loadCache(dir);
        const progress = (p) => {
          if (onProgress) {
            try {
              onProgress(p);
            } catch {
            }
          }
        };
        const perVolume = [];
        const globalCand = /* @__PURE__ */ new Map();
        let chapterDone = 0;
        let totalChars = 0;
        for (let vi = 0; vi < tree.volumes.length; vi += 1) {
          const vol = tree.volumes[vi];
          if (signal && signal.aborted) throw new Error("已取消");
          const list = [];
          for (const c of vol.chapters) {
            if (signal && signal.aborted) throw new Error("已取消");
            const ch = chapters.readChapter(dir, c.id);
            list.push({ id: c.id, title: ch.meta.title || c.title, body: ch.body });
            chapterDone += 1;
            totalChars += (ch.body || "").length;
            if (chapterDone % 40 === 0) {
              progress({
                phase: "scan",
                message: `正在扫描全书… 已读 ${chapterDone} / ${tree.chapterCount} 章`,
                current: chapterDone,
                total: tree.chapterCount
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
              phase: "volume",
              message: `第 ${vi + 1}/${tree.volumes.length} 卷「${vol.title}」：命中缓存`,
              current: vi + 1,
              total: tree.volumes.length
            });
          } else {
            mined = mineVolume(list);
            const text = sampleText(list, budget);
            progress({
              phase: "volume",
              message: `第 ${vi + 1}/${tree.volumes.length} 卷「${vol.title}」：候选 ${mined.candidates.length} 人，精读 ${text.length} 字`,
              current: vi + 1,
              total: tree.volumes.length
            });
            parsed = await analyzeVolume({
              volTitle: vol.title,
              candidates: mined.candidates,
              pairs: mined.pairs,
              text,
              signal
            });
            cache.volumes[vol.path] = { sig, mined, result: parsed, at: (/* @__PURE__ */ new Date()).toISOString() };
            saveCache(dir, cache);
          }
          for (const c of mined.raw || mined.candidates) {
            let g = globalCand.get(c.name);
            if (!g) {
              g = { name: c.name, mentions: 0, chapters: 0, intro: 0, volumes: /* @__PURE__ */ new Set(), first: c.first };
              globalCand.set(c.name, g);
            }
            g.mentions += c.mentions;
            g.chapters += c.chapters;
            g.intro += c.intro;
            g.volumes.add(vol.title);
          }
          const missed = parsed.characters.map((ch) => ch.name).filter((n) => n && !globalCand.has(n));
          for (const [name, st] of countOccurrences(list, missed)) {
            if (!st.mentions) continue;
            let g = globalCand.get(name);
            if (!g) {
              g = { name, mentions: 0, chapters: 0, intro: 0, volumes: /* @__PURE__ */ new Set() };
              globalCand.set(name, g);
            }
            g.mentions += st.mentions;
            g.chapters += st.chapters;
            g.volumes.add(vol.title);
          }
          perVolume.push({ vol, mined, parsed });
        }
        progress({ phase: "merge", message: "正在合并人物、去重别名与关系…" });
        const nodes = [];
        const nameIndex = /* @__PURE__ */ new Map();
        const canon = (names) => {
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
                desc: "",
                role: "",
                importance: 1,
                mentions: 0,
                chapters: 0,
                volumes: /* @__PURE__ */ new Set(),
                stub: false,
                llm: true
              };
              nodes.push(node);
            }
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
        const BAD_LEAD = /^[为做作乃叫赞有在给把被让使令本此那这其该对向从与和同带着的吗吧呢啊]/;
        const PLACE_TAIL = /[观门派遣盟帮阁堂轩苑坊店庄岭村街集县州府馆寺庙宫殿社军营楼]$/;
        const stubs = [...globalCand.values()].filter((g) => !nameIndex.has(g.name)).filter((g) => plausible(g.name, g.mentions, g.intro)).filter((g) => {
          if (BAD_LEAD.test(g.name)) return false;
          if (PLACE_TAIL.test(g.name) && g.intro < 2) return false;
          if (g.mentions >= 100) return true;
          if (g.mentions >= 8 && g.chapters >= 2 && SURNAMES.includes(g.name[0])) return true;
          return g.intro >= 2 && g.mentions >= 5;
        }).sort((a, b) => b.mentions - a.mentions);
        for (const g of stubs) {
          if (nodes.length >= MAX_CARDS) break;
          const node = {
            key: g.name,
            name: g.name,
            aliases: [],
            desc: `全书出现 ${g.mentions} 次，分布在 ${g.chapters} 章；AI 未给出简介，待补充。`,
            role: "",
            importance: g.mentions >= 60 ? 2 : 1,
            mentions: g.mentions,
            chapters: g.chapters,
            volumes: g.volumes,
            stub: true,
            llm: false
          };
          nodes.push(node);
          nameIndex.set(g.name, node);
        }
        for (const node of nodes) {
          let mentions = 0;
          let chapters2 = 0;
          const seenVol = /* @__PURE__ */ new Set();
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
          if (!node.role && node.stub) node.role = "";
        }
        const links = [];
        const seenLink = /* @__PURE__ */ new Set();
        for (const { parsed } of perVolume) {
          for (const r of parsed.relations) {
            const a = nameIndex.get(r.from);
            const b = nameIndex.get(r.to);
            if (!a || !b || a === b) continue;
            const key = a.key + ">" + b.key;
            if (seenLink.has(key)) continue;
            seenLink.add(key);
            links.push({ from: a.key, to: b.key, label: r.label });
          }
        }
        const points = [];
        perVolume.forEach(({ vol, parsed }, vi) => {
          const events = parsed.events.slice(0, 3);
          const volChaps = vol.chapters || [];
          events.forEach((e, i) => {
            const ci = events.length > 1 ? Math.round(i * (volChaps.length - 1) / (events.length - 1)) : 0;
            points.push({
              title: e.title,
              desc: e.desc,
              emotion: e.emotion,
              volume: vol.title,
              order: vi * 10 + i,
              who: e.who || "",
              place: e.place || "",
              detail: e.detail || "",
              chapter: volChaps[ci] ? volChaps[ci].id : ""
            });
          });
        });
        nodes.sort((a, b) => b.importance - a.importance || b.mentions - a.mentions || a.name.localeCompare(b.name, "zh"));
        const result = {
          schema: 1,
          generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
          model: ai2.MODEL,
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
            cachedVolumes: perVolume.filter((p) => cache.volumes[p.vol.path] && cache.volumes[p.vol.path].sig === volumeSignature(p.vol) && !force).length
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
            likely: !n.stub || SURNAMES.includes(n.name[0]) || n.mentions >= 100
          })),
          links,
          points
        };
        ensureDir(path.join(dir, CACHE_REL));
        writeTextAtomic(path.join(dir, CACHE_REL, "last.json"), JSON.stringify(result, null, 2) + "\n");
        progress({
          phase: "done",
          message: `识别 ${result.stats.cards} 人（AI 确认 ${result.stats.llmCards}，频率补漏 ${result.stats.stubCards}），关系 ${result.stats.links} 条`,
          current: tree.volumes.length,
          total: tree.volumes.length
        });
        return result;
      }
      function endIdFor(name, used) {
        const base = "card-" + sha1(name).slice(0, 10);
        if (!used.has(base)) return base;
        let i = 2;
        while (used.has(base + "-" + i)) i += 1;
        return base + "-" + i;
      }
      function apply({ dir, result, selectedKeys, writePoints = false }) {
        if (!result || !Array.isArray(result.cards)) throw new Error("分析结果为空，请重新分析");
        const keys = new Set(Array.isArray(selectedKeys) ? selectedKeys : []);
        if (!keys.size) throw new Error("至少勾选一个人物");
        const current = canvas.read(dir);
        const hadCards = current.cards.length > 0;
        const existing = current.cards;
        const byName = /* @__PURE__ */ new Map();
        for (const c of existing) {
          byName.set(c.name, c);
          for (const a of c.aliases || []) if (!byName.has(a)) byName.set(a, c);
        }
        const usedIds = new Set(existing.map((c) => c.id));
        const picked = result.cards.filter((c) => keys.has(c.key));
        const keyToCard = /* @__PURE__ */ new Map();
        const created = [];
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
            for (const a of c.aliases || []) {
              if (a !== card.name && !card.aliases.includes(a)) card.aliases.push(a);
            }
            if (!card.desc && c.desc) card.desc = c.desc;
            card.placed = true;
            updated += 1;
          } else {
            const id = endIdFor(c.name, usedIds);
            usedIds.add(id);
            card = {
              id,
              name: c.name,
              aliases: c.aliases || [],
              desc: c.desc || (c.role ? c.role : ""),
              x: 0,
              y: 0,
              placed: true
            };
            existing.push(card);
            byName.set(card.name, card);
            for (const a of card.aliases) if (!byName.has(a)) byName.set(a, card);
            created.push({ card, importance: c.importance || 1 });
            added += 1;
          }
          keyToCard.set(c.key, card);
        }
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
            const ang = idx / Math.max(1, n) * Math.PI * 2;
            card.x = Math.round(Math.cos(ang) * tier - CARD_W / 2);
            card.y = Math.round(Math.sin(ang) * tier - 36);
          });
        }
        const links = Array.isArray(current.links) ? current.links : [];
        const seen = new Set(links.map((l) => l.from + ">" + l.to));
        let linkCount = 0;
        for (const r of result.links || []) {
          const a = keyToCard.get(r.from);
          const b = keyToCard.get(r.to);
          if (!a || !b || a === b) continue;
          const key = a.id + ">" + b.id;
          if (seen.has(key)) continue;
          seen.add(key);
          links.push({ id: "lk-" + sha1(key).slice(0, 10), from: a.id, to: b.id, label: r.label || "" });
          linkCount += 1;
        }
        let pointCount = 0;
        const points = Array.isArray(current.points) ? current.points : [];
        if (writePoints) {
          const titles = new Set(points.map((p) => p.title));
          const maxX = points.length ? points.reduce((m, p) => Math.max(m, Number(p.x) || 0), 0) : 0;
          (result.points || []).forEach((p, i) => {
            if (titles.has(p.title)) return;
            titles.add(p.title);
            points.push({
              id: "beat-" + sha1(p.volume + "|" + p.title).slice(0, 10),
              title: p.title,
              desc: p.desc || "",
              detail: p.detail || "",
              who: p.who || "",
              place: p.place || "",
              chapter: p.chapter || "",
              x: maxX + 520 * (i + 1),
              y: 420 - Math.round((Number(p.emotion) || 0) * 2)
            });
            pointCount += 1;
          });
        }
        const focusStillThere = existing.some((c) => c.id === current.focus);
        const saved = canvas.save(dir, {
          schema: 1,
          mode: "graph",
          viewport: current.viewport,
          focus: focusStillThere ? current.focus : mainCard ? mainCard.id : "",
          depth: hadCards ? current.depth : 3,
          cards: existing,
          points,
          links
        });
        return {
          canvas: saved,
          stats: { added, updated, links: linkCount, points: pointCount, totalCards: saved.cards.length }
        };
      }
      module.exports = { run, scan, apply, sampleText, mineVolume };
    }
  });

  // src/main/services/profile.js
  var require_profile = __commonJS({
    "src/main/services/profile.js"(exports, module) {
      "use strict";
      var chapters = require_chapters();
      var ai2 = require_ai_client();
      var MAX_EXCERPT_CHARS = 24e3;
      var PER_CHAPTER_CHARS = 2400;
      var STAGE_SPEC = '{"stage":"幼年/少年/青年/中年/老年（或原文写明的阶段）","age":"大致年龄或年龄段","appearance":"该阶段的外貌、服饰、气质","summary":"该阶段的身份、处境或关键变化"}';
      var PROFILE_PROMPT = [
        "你是中文长篇小说的人物档案整理器。只输出一个 JSON 对象，不要输出解释或 Markdown。",
        'JSON 结构：{"background":"","personality":"","appearance":"","stages":[' + STAGE_SPEC + "]}",
        "规则：",
        "1. background：出身、身份、立场、关键经历，120 字以内；只写原文有依据的内容。",
        "2. personality：性格特征与行事风格，用短语概括，80 字以内；结合人物言行，不要空泛评价。",
        "3. appearance：最能代表这个人物的整体外貌印象，80 字以内；原文没有描写就写「原文未细写」，不要臆造。",
        "4. stages：同一个人在不同人生阶段的样貌变体，不是不同人物；按时间顺序排列，最多 6 项，没有明显阶段性变化就只给 1 项。",
        "5. stages 只写原文有依据的阶段；原文没有该阶段的样貌描写就不要硬凑，宁缺毋滥。",
        "6. 不要复述大段剧情，不要写人物关系清单，不要评价文笔。",
        "7. 原文材料不足时，可以结合给出的已有简介做保守概括，但不得编造具体事实。"
      ].join("\n");
      var STAGES_PROMPT = [
        "你是中文长篇小说的人物样貌整理器。只输出一个 JSON 对象，不要输出解释或 Markdown。",
        'JSON 结构：{"stages":[' + STAGE_SPEC + "]}",
        "规则：",
        "1. stages 是同一个角色在不同人生阶段的样貌变体，不是不同人物；按时间顺序，最多 6 项。",
        "2. 阶段可以是幼年、少年、青年、中年、老年，也可以是原文明确写出的阶段（如「入京前」「称帝后」）。",
        "3. 只写原文有依据的外貌、服饰、气质；没有描写就不要硬凑，没有阶段变化就只给 1 项。",
        "4. 不写剧情流水账，不评价文笔，不要臆造原文没有的细节。"
      ].join("\n");
      function buildSystemPrompt(mode) {
        return mode === "stages" ? STAGES_PROMPT : PROFILE_PROMPT;
      }
      function splitParagraphs(text) {
        return String(text || "").split(/\n+/).map((s) => s.trim()).filter(Boolean);
      }
      function collectExcerpts(dir, terms) {
        const volumes = (chapters.tree(dir) || {}).volumes || [];
        const chunks = [];
        for (const vol of volumes) {
          for (const ch of vol.chapters) {
            let body = "";
            try {
              body = chapters.readChapter(dir, ch.id).body;
            } catch {
              continue;
            }
            const hits = splitParagraphs(body).filter((p) => terms.some((t) => p.includes(t)));
            if (!hits.length) continue;
            chunks.push({
              label: `${vol.title} / ${ch.title}`,
              text: hits.join("\n").slice(0, PER_CHAPTER_CHARS)
            });
          }
        }
        if (!chunks.length) return { text: "", chapters: 0 };
        const total = chunks.reduce((n, c) => n + c.text.length, 0);
        if (total <= MAX_EXCERPT_CHARS) {
          return { text: chunks.map((c) => `【${c.label}】
${c.text}`).join("\n\n"), chapters: chunks.length };
        }
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
        return { text: picked.map((c) => `【${c.label}】
${c.text}`).join("\n\n"), chapters: picked.length };
      }
      function parseModelJson(raw) {
        let s = String(raw || "").trim();
        const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fence) s = fence[1].trim();
        const start2 = s.indexOf("{");
        const end = s.lastIndexOf("}");
        if (start2 !== -1 && end > start2) s = s.slice(start2, end + 1);
        const data = JSON.parse(s);
        const pick = (v, max) => String(v == null ? "" : v).replace(/\r/g, "").trim().slice(0, max);
        return {
          background: pick(data && data.background, 400),
          personality: pick(data && data.personality, 300),
          appearance: pick(data && data.appearance, 300),
          stages: normalizeStages(data && data.stages)
        };
      }
      function normalizeStages(raw) {
        if (!Array.isArray(raw)) return [];
        const out = [];
        for (const item of raw) {
          if (!item || typeof item !== "object") continue;
          const stage = String(item.stage == null ? "" : item.stage).trim().slice(0, 20);
          const age = String(item.age == null ? "" : item.age).trim().slice(0, 20);
          const appearance = String(item.appearance == null ? "" : item.appearance).trim().slice(0, 400);
          const summary = String(item.summary == null ? "" : item.summary).trim().slice(0, 300);
          if (!stage && !appearance) continue;
          out.push({ stage, age, appearance, summary });
          if (out.length >= 8) break;
        }
        return out;
      }
      async function analyze({ dir, name, aliases, desc, relations, mode, signal } = {}) {
        const onlyStages = mode === "stages";
        if (!dir) throw new Error("请先打开一个作品");
        const title = String(name || "").trim();
        if (!title) throw new Error("角色没有名字，无法分析");
        if (!ai2.apiKey()) throw new Error("没有配置 DeepSeek API Key，请先在「设置 → AI」里填写");
        const terms = [...new Set([title, ...Array.isArray(aliases) ? aliases : []].map((s) => String(s || "").trim()).filter(Boolean))];
        const { text, chapters: chapterCount } = collectExcerpts(dir, terms);
        const intro = String(desc || "").trim();
        const rel = String(relations || "").trim();
        if (!text && !intro && !rel) {
          throw new Error("正文里还没找到「" + title + "」的戏份，先写几章再分析");
        }
        const userPrompt = [
          `【角色】${title}`,
          `【别名】${terms.slice(1).join("、") || "（无）"}`,
          `【已有简介】${intro || "（无）"}`,
          `【人物关系】${rel || "（无）"}`,
          `【出场原文片段${chapterCount ? `（${chapterCount} 处）` : "（正文中没有找到，仅依据简介与关系）"}】`,
          "<<<",
          text || "（无原文片段）",
          ">>>"
        ].join("\n");
        const messages = [
          { role: "system", content: buildSystemPrompt(mode) },
          { role: "user", content: userPrompt }
        ];
        let lastErr = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const raw = await ai2.chat({
              messages: attempt === 0 ? messages : [...messages, { role: "user", content: "上次输出不是合法 JSON，请只输出 JSON 对象。" }],
              signal,
              temperature: 0.3,
              json: true,
              maxTokens: onlyStages ? 1400 : 2200,
              timeoutMs: 18e4
            });
            const out = parseModelJson(raw);
            if (onlyStages) {
              if (!out.stages.length) throw new Error("模型没有返回阶段样貌");
              return { background: "", personality: "", appearance: "", stages: out.stages, chapters: chapterCount };
            }
            if (!out.background && !out.personality && !out.appearance) throw new Error("模型没有返回档案内容");
            return { ...out, chapters: chapterCount };
          } catch (err) {
            if (signal && signal.aborted) throw err;
            lastErr = err;
          }
        }
        throw new Error("角色档案分析失败：" + (lastErr ? lastErr.message : "模型输出不是合法 JSON"));
      }
      module.exports = { analyze };
    }
  });

  // src/mobile/api.js
  var require_api = __commonJS({
    "src/mobile/api.js"(exports, module) {
      "use strict";
      var fs2 = require_fs();
      var path = require_path();
      var storage2 = require_storage();
      var config2 = require_config();
      var ui2 = require_ui();
      var { readText, writeTextAtomic } = require_fsutil();
      var project = require_project();
      var chapters = require_chapters();
      var versions = require_versions();
      var stats = require_stats();
      var fm = require_frontmatter();
      var settings = require_settings();
      var shortcuts = require_shortcuts();
      var cast = require_cast();
      var canvas = require_canvas();
      var importer = require_importer();
      var analyze = require_analyze();
      var profile = require_profile();
      var ai2 = require_ai_client();
      var RECENT_LIMIT = 12;
      var PROJECTS_ROOT = "/mushu/works";
      var BACKUP_ROOT = "/mushu/backups";
      var SETTINGS_FILE = "/mushu/settings.json";
      var RECENT_FILE = "/mushu/recent.json";
      var IMPORT_DIR = "/mushu/imports";
      var store = null;
      var readyResolve = null;
      var ready = new Promise((resolve) => {
        readyResolve = resolve;
      });
      function markReady() {
        if (readyResolve) readyResolve();
        readyResolve = null;
      }
      function settingsStore() {
        if (!store) {
          store = settings.createStore(SETTINGS_FILE, () => ({
            projectsRoot: PROJECTS_ROOT,
            editorFont: "",
            editorSize: 18,
            editorLineHeight: 2,
            autoScrollMode: "off",
            autoScrollPercent: 60,
            wheelChapterSwitch: false,
            highlight: { characters: true, settings: true, scope: "chapter", style: "underline" },
            backupRoot: BACKUP_ROOT,
            autoBackupWords: 2e3,
            shortcuts: { ...shortcuts.DEFAULT_SHORTCUTS },
            autoLaunch: false,
            hardwareAcceleration: true,
            aiKeyEnc: ""
          }));
          versions.setRootResolver(() => settingsStore().load().backupRoot);
          ai2.setKeyProvider(() => "");
        }
        return store;
      }
      function publicSettings(s) {
        const { aiKeyEnc, ...rest } = s || {};
        return {
          ...rest,
          aiKeySet: ai2.keySource() !== "",
          aiKeySource: ai2.keySource()
        };
      }
      function requireProjectsRoot() {
        const root = settingsStore().load().projectsRoot;
        if (!root) throw new Error("还没有设置默认作品目录，请先在「设置」里指定");
        try {
          fs2.mkdirSync(root, { recursive: true });
        } catch (err) {
          throw new Error(`默认作品目录不可用：${root}（${err.message}）`);
        }
        return root;
      }
      function loadRecent() {
        try {
          const list = JSON.parse(readText(RECENT_FILE, "[]"));
          return Array.isArray(list) ? list : [];
        } catch {
          return [];
        }
      }
      function pushRecent(dir, book) {
        const list = loadRecent().filter((r) => r.dir !== dir);
        list.unshift({ dir, title: book.title, at: (/* @__PURE__ */ new Date()).toISOString() });
        writeTextAtomic(RECENT_FILE, JSON.stringify(list.slice(0, RECENT_LIMIT), null, 2));
        return list.slice(0, RECENT_LIMIT);
      }
      var listeners = {
        aiDelta: /* @__PURE__ */ new Set(),
        analyzeProgress: /* @__PURE__ */ new Set(),
        menu: /* @__PURE__ */ new Set(),
        windowState: /* @__PURE__ */ new Set()
      };
      function emit(set, payload) {
        for (const cb of set) {
          try {
            cb(payload);
          } catch {
          }
        }
      }
      function ok(data) {
        return { ok: true, data };
      }
      function fail(err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
      }
      function handle(fn) {
        return async (payload) => {
          await ready;
          try {
            const data = await fn(payload || {});
            return ok(data);
          } catch (err) {
            return fail(err);
          }
        };
      }
      var aiJobs = /* @__PURE__ */ new Map();
      var analyzeJobs = /* @__PURE__ */ new Map();
      function decodeFileText(buffer) {
        const bytes = new Uint8Array(buffer);
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          try {
            return new TextDecoder("gbk").decode(bytes);
          } catch {
            return new TextDecoder("utf-8").decode(bytes);
          }
        }
      }
      function pickTxtFile() {
        return new Promise((resolve) => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = ".txt,text/plain";
          input.style.position = "fixed";
          input.style.left = "-9999px";
          document.body.appendChild(input);
          let settled = false;
          const done = (value) => {
            if (settled) return;
            settled = true;
            input.remove();
            resolve(value);
          };
          input.onchange = async () => {
            const file = input.files && input.files[0];
            if (!file) return done(null);
            try {
              const buf = await file.arrayBuffer();
              const text = decodeFileText(buf);
              const safeName = file.name.replace(/[\\/:*?"<>|]/g, "_");
              const dest = path.join(IMPORT_DIR, `${Date.now()}-${safeName}`);
              fs2.mkdirSync(IMPORT_DIR, { recursive: true });
              fs2.writeFileSync(dest, text, "utf8");
              done(dest);
            } catch (err) {
              ui2.toast("读取 TXT 失败：" + (err.message || err));
              done(null);
            }
          };
          input.click();
        });
      }
      async function pickDir(title) {
        if (title === "选择作品目录") return ui2.pickWorkDir(requireProjectsRoot());
        ui2.toast("iPad 版的作品统一存放在应用内，不支持选择外部目录");
        return null;
      }
      var impl = {
        // 文件选择
        pickDir: handle(async ({ title }) => pickDir(title)),
        pickTxt: handle(async () => pickTxtFile()),
        // 设置
        getSettings: handle(async () => publicSettings(settingsStore().load())),
        loginState: handle(async () => ({ openAtLogin: false })),
        setSettings: handle(async ({ patch }) => {
          const prev = settingsStore().load();
          let next = { ...patch || {} };
          let keyTouched = false;
          if ("aiKey" in next) {
            keyTouched = true;
            const value = String(next.aiKey == null ? "" : next.aiKey).trim();
            await ai2.setKey(value);
            delete next.aiKey;
          }
          if ("aiKeyEnc" in next) {
            next.aiKeyEnc = prev.aiKeyEnc;
          }
          const requireDir = (value, label, emptyMsg) => {
            const root = String(value).trim();
            if (!root) throw new Error(emptyMsg);
            if (fs2.existsSync(root) && !fs2.statSync(root).isDirectory()) throw new Error(`${label}已存在但不是目录`);
            fs2.mkdirSync(root, { recursive: true });
            return root;
          };
          if (next.projectsRoot != null) next = { ...next, projectsRoot: requireDir(next.projectsRoot, "默认作品目录", "默认作品目录不能为空") };
          if (next.backupRoot != null) next = { ...next, backupRoot: requireDir(next.backupRoot, "备份目录", "备份目录不能为空") };
          const clampNum = (v, min, max, fallback) => {
            const n = Number(v);
            return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
          };
          if (next.editorSize != null) next = { ...next, editorSize: clampNum(next.editorSize, 12, 40, 18) };
          if (next.editorLineHeight != null) next = { ...next, editorLineHeight: clampNum(next.editorLineHeight, 1.2, 3.5, 2) };
          if (next.editorFont != null) next = { ...next, editorFont: String(next.editorFont).trim() };
          if (next.uiScale != null) next = { ...next, uiScale: clampNum(next.uiScale, 0.7, 2, 1) };
          if (next.autoScrollPercent != null) next = { ...next, autoScrollPercent: clampNum(next.autoScrollPercent, 0, 90, 60) };
          if (next.autoBackupWords != null) next = { ...next, autoBackupWords: Math.round(clampNum(next.autoBackupWords, 0, 1e5, 2e3)) };
          if (next.autoScrollMode != null) next = { ...next, autoScrollMode: ["off", "line", "enter"].includes(next.autoScrollMode) ? next.autoScrollMode : "off" };
          if (next.wheelChapterSwitch != null) next = { ...next, wheelChapterSwitch: Boolean(next.wheelChapterSwitch) };
          if (next.autoLaunch != null) next = { ...next, autoLaunch: Boolean(next.autoLaunch) };
          if (next.hardwareAcceleration != null) next = { ...next, hardwareAcceleration: Boolean(next.hardwareAcceleration) };
          if (next.highlight != null) {
            const h = next.highlight || {};
            next = {
              ...next,
              highlight: {
                characters: h.characters !== false,
                settings: h.settings !== false,
                scope: h.scope === "always" ? "always" : "chapter",
                style: ["underline", "background", "bold"].includes(h.style) ? h.style : "underline"
              }
            };
          }
          if (next.shortcuts != null) next = { ...next, shortcuts: shortcuts.normalizeShortcuts(next.shortcuts) };
          const saved = settingsStore().save(next);
          if (keyTouched) ai2.setKeyProvider(() => "");
          if (next.backupRoot != null && prev.backupRoot && prev.backupRoot !== saved.backupRoot) {
            try {
              versions.migrateBackupRoot(prev.backupRoot, saved.backupRoot);
            } catch (err) {
              throw new Error("备份目录已修改，但旧数据迁移失败：" + err.message);
            }
          }
          return publicSettings(saved);
        }),
        // 作品
        createProject: handle(async ({ title, author }) => {
          const dir = project.resolveProjectDir(requireProjectsRoot(), title);
          const { book } = project.createProject(dir, { title, author });
          pushRecent(dir, book);
          return { project: project.openProject(dir), tree: chapters.tree(dir), recent: loadRecent() };
        }),
        openProject: handle(async ({ dir }) => {
          const proj = project.openProject(dir);
          pushRecent(dir, proj.book);
          versions.ensureLegacyMigrated(dir);
          return { project: proj, tree: chapters.tree(dir), recent: loadRecent() };
        }),
        importTxt: handle(async ({ file, title, author }) => {
          if (!file) throw new Error("没有选择 TXT 文件");
          const result = importer.importTxt({ file, title, author, root: requireProjectsRoot() });
          pushRecent(result.project.dir, result.project.book);
          return { ...result, recent: loadRecent() };
        }),
        recentProjects: handle(async () => loadRecent().filter((r) => fs2.existsSync(r.dir))),
        updateBook: handle(async ({ dir, patch }) => project.updateBook(dir, patch)),
        // 大纲
        readOutline: handle(async ({ dir }) => readText(path.join(dir, "bible", "outline.md"), "")),
        saveOutline: handle(async ({ dir, body }) => {
          writeTextAtomic(path.join(dir, "bible", "outline.md"), String(body == null ? "" : body));
          return true;
        }),
        // 目录 / 章节
        tree: handle(async ({ dir }) => chapters.tree(dir)),
        searchChapters: handle(async ({ dir, query }) => chapters.search(dir, query)),
        chapterAppearances: handle(async ({ dir, terms }) => chapters.appearances(dir, terms)),
        readChapter: handle(async ({ dir, id }) => chapters.readChapter(dir, id)),
        saveChapter: handle(async ({ dir, id, meta, body }) => {
          const result = chapters.saveChapter(dir, id, { meta, body });
          const threshold = settingsStore().load().autoBackupWords;
          if (versions.noteSave(dir, result.delta, threshold)) {
            versions.snapshot(dir, id, readText(chapters.fromId(dir, id), ""));
          }
          stats.addWords(dir, id, result.delta);
          return { ...result, tree: chapters.tree(dir), stats: stats.summary(dir) };
        }),
        createChapter: handle(async ({ dir, volumePath, title }) => {
          const chapter = chapters.createChapter(dir, volumePath, title);
          return { chapter, tree: chapters.tree(dir) };
        }),
        createVolume: handle(async ({ dir, title }) => {
          const volume = chapters.createVolume(dir, title);
          return { volume, tree: chapters.tree(dir) };
        }),
        renameChapter: handle(async ({ dir, id, title }) => {
          const chapter = chapters.renameChapter(dir, id, title);
          return { chapter, tree: chapters.tree(dir) };
        }),
        renameVolume: handle(async ({ dir, path: volumePath, title }) => {
          const volume = chapters.renameVolume(dir, volumePath, title);
          return { volume, tree: chapters.tree(dir) };
        }),
        // 草稿
        saveDraft: handle(async ({ dir, id, meta, body }) => {
          chapters.saveDraft(dir, id, { meta, body });
          return true;
        }),
        discardDraft: handle(async ({ dir, id }) => {
          chapters.clearDraft(dir, id);
          return true;
        }),
        // 历史版本
        listVersions: handle(async ({ dir, id }) => versions.list(dir, id)),
        diffVersion: handle(async ({ dir, id, file }) => {
          const ver = versions.read(dir, id, file);
          const before = fm.split(ver.text).body;
          const after = chapters.readChapter(dir, id).body;
          return { before, after, hunks: versions.diffLines(before, after) };
        }),
        rollbackVersion: handle(async ({ dir, id, file }) => {
          const ver = versions.read(dir, id, file);
          const parsed = fm.split(ver.text);
          const abs = chapters.fromId(dir, id);
          versions.snapshot(dir, id, readText(abs, ""));
          chapters.saveChapter(dir, id, { meta: parsed.meta, body: parsed.body });
          return { chapter: chapters.readChapter(dir, id), tree: chapters.tree(dir) };
        }),
        stats: handle(async ({ dir }) => stats.summary(dir)),
        openFolder: handle(async () => true),
        snapshotNow: handle(async ({ dir, id }) => {
          const file = versions.snapshot(dir, id, readText(chapters.fromId(dir, id), ""));
          versions.resetPending(dir);
          return { file, list: versions.list(dir, id) };
        }),
        backupRootPath: handle(async ({ dir }) => ({
          backupRoot: settingsStore().load().backupRoot,
          projectDir: dir ? versions.versionBase(dir) : null
        })),
        cleanCache: handle(async ({ dir }) => {
          let bytes = 0;
          const removeFile = (p, size) => {
            try {
              fs2.unlinkSync(p);
              bytes += Number(size) || 0;
            } catch {
            }
          };
          const draftsDir = path.join(dir, ".mushu", "drafts");
          for (const e of fs2.existsSync(draftsDir) ? fs2.readdirSync(draftsDir, { withFileTypes: true }) : []) {
            if (!e.isFile()) continue;
            const p = path.join(draftsDir, e.name);
            removeFile(p, fs2.existsSync(p) ? fs2.statSync(p).size : 0);
          }
          const mushuDir = path.join(dir, ".mushu");
          for (const e of fs2.existsSync(mushuDir) ? fs2.readdirSync(mushuDir, { withFileTypes: true }) : []) {
            if (e.isFile() && /\.tmp-\d+-\d+$/.test(e.name)) {
              const p = path.join(mushuDir, e.name);
              removeFile(p, fs2.existsSync(p) ? fs2.statSync(p).size : 0);
            }
          }
          versions.resetPending(dir);
          return { bytes };
        }),
        // 设定库 / 画布
        readCast: handle(async ({ dir }) => cast.read(dir)),
        saveCast: handle(async ({ dir, data }) => cast.save(dir, data)),
        readCanvas: handle(async ({ dir }) => canvas.read(dir)),
        saveCanvas: handle(async ({ dir, data }) => canvas.save(dir, data)),
        analyzeProfile: handle(async ({ dir, ...payload }) => profile.analyze({ dir, ...payload })),
        registerShortcuts: handle(async () => ({})),
        // AI 助手
        aiChat: handle(async ({ id, messages }) => {
          const jobId = String(id || "");
          const controller = new AbortController();
          if (jobId) aiJobs.set(jobId, controller);
          try {
            const text = await ai2.chat({
              messages: Array.isArray(messages) ? messages : [],
              signal: controller.signal,
              onDelta: (piece) => emit(listeners.aiDelta, { id: jobId, text: piece })
            });
            return { text };
          } catch (err) {
            if (controller.signal.aborted) return { text: "", cancelled: true };
            throw err;
          } finally {
            if (jobId && aiJobs.get(jobId) === controller) aiJobs.delete(jobId);
          }
        }),
        aiCancel: handle(async ({ id }) => {
          const controller = aiJobs.get(String(id || ""));
          if (controller) controller.abort();
          return true;
        }),
        onAiDelta: (cb) => {
          listeners.aiDelta.add(cb);
        },
        aiKeyStatus: handle(async () => ({ configured: ai2.apiKey() !== "", source: ai2.keySource() })),
        aiKeySet: handle(async ({ key }) => {
          const value = String(key == null ? "" : key).trim();
          return ai2.setKey(value);
        }),
        // 智能解析
        analyzeRun: handle(async ({ id, dir, budget, force }) => {
          if (!dir) throw new Error("请先打开一个作品");
          const jobId = String(id || "");
          const controller = new AbortController();
          if (jobId) analyzeJobs.set(jobId, controller);
          try {
            return await analyze.run({
              dir,
              budget,
              force: !!force,
              signal: controller.signal,
              onProgress: (p) => emit(listeners.analyzeProgress, { id: jobId, ...p })
            });
          } catch (err) {
            if (controller.signal.aborted) throw new Error("已取消分析");
            throw err;
          } finally {
            if (jobId && analyzeJobs.get(jobId) === controller) analyzeJobs.delete(jobId);
          }
        }),
        analyzeCancel: handle(async ({ id }) => {
          const controller = analyzeJobs.get(String(id || ""));
          if (controller) controller.abort();
          return true;
        }),
        analyzeApply: handle(async ({ dir, result, selectedKeys, writePoints }) => {
          if (!dir) throw new Error("请先打开一个作品");
          return analyze.apply({ dir, result, selectedKeys, writePoints: !!writePoints });
        }),
        onAnalyzeProgress: (cb) => {
          listeners.analyzeProgress.add(cb);
        },
        // 无边框窗口控制：iPad 没有窗口概念，全部安全降级
        minimize: handle(async () => true),
        toggleMaximize: handle(async () => false),
        toggleFullScreen: handle(async () => false),
        closeWindow: handle(async () => true),
        windowState: handle(async () => ({ maximized: false, fullScreen: false })),
        setZoom: handle(async ({ factor }) => {
          const value = Math.min(2, Math.max(0.7, Number(factor) || 1));
          document.documentElement.style.zoom = String(value);
          return true;
        }),
        popupMenu: async () => {
          const actions = [
            { key: "newProject", label: "新建作品…" },
            { key: "openProject", label: "打开作品…" },
            { key: "closeProject", label: "关闭作品" },
            { sep: true },
            { key: "settings", label: "设置…" },
            { key: "server", label: "服务器连接…" },
            { sep: true },
            { key: "save", label: "立即保存" },
            { key: "focusMode", label: "专注模式" },
            { key: "versions", label: "版本历史" },
            { key: "outline", label: "故事大纲" },
            { key: "canvas", label: "无限画布" },
            { sep: true },
            { key: "zoomReset", label: "重置缩放" },
            { key: "zoomIn", label: "放大" },
            { key: "zoomOut", label: "缩小" },
            { key: "openFolder", label: "作品目录" },
            { key: "about", label: "关于墨枢" }
          ];
          ui2.showMenu(actions, (action) => {
            if (action === "server") {
              if (typeof window.__mushuOpenSetup === "function") window.__mushuOpenSetup();
              return;
            }
            emit(listeners.menu, action);
          });
        },
        onWindowState: (cb) => {
          listeners.windowState.add(cb);
        },
        onMenu: (cb) => {
          listeners.menu.add(cb);
        }
      };
      var api2 = {
        pickDir: (title) => impl.pickDir({ title }),
        pickTxt: () => impl.pickTxt(),
        getSettings: () => impl.getSettings(),
        setSettings: (patch) => impl.setSettings({ patch }),
        loginState: () => impl.loginState(),
        createProject: (payload) => impl.createProject(payload),
        importTxt: (payload) => impl.importTxt(payload),
        openProject: (dir) => impl.openProject({ dir }),
        recentProjects: () => impl.recentProjects(),
        updateBook: (dir, patch) => impl.updateBook({ dir, patch }),
        readOutline: (dir) => impl.readOutline({ dir }),
        saveOutline: (dir, body) => impl.saveOutline({ dir, body }),
        tree: (dir) => impl.tree({ dir }),
        searchChapters: (dir, query) => impl.searchChapters({ dir, query }),
        chapterAppearances: (dir, terms) => impl.chapterAppearances({ dir, terms }),
        readChapter: (dir, id) => impl.readChapter({ dir, id }),
        saveChapter: (dir, id, meta, body) => impl.saveChapter({ dir, id, meta, body }),
        createChapter: (dir, volumePath, title) => impl.createChapter({ dir, volumePath, title }),
        createVolume: (dir, title) => impl.createVolume({ dir, title }),
        renameChapter: (dir, id, title) => impl.renameChapter({ dir, id, title }),
        renameVolume: (dir, volumePath, title) => impl.renameVolume({ dir, path: volumePath, title }),
        saveDraft: (dir, id, meta, body) => impl.saveDraft({ dir, id, meta, body }),
        discardDraft: (dir, id) => impl.discardDraft({ dir, id }),
        listVersions: (dir, id) => impl.listVersions({ dir, id }),
        diffVersion: (dir, id, file) => impl.diffVersion({ dir, id, file }),
        rollbackVersion: (dir, id, file) => impl.rollbackVersion({ dir, id, file }),
        stats: (dir) => impl.stats({ dir }),
        openFolder: (dir) => impl.openFolder({ dir }),
        snapshotNow: (dir, id) => impl.snapshotNow({ dir, id }),
        backupRootPath: (dir) => impl.backupRootPath({ dir }),
        cleanCache: (dir) => impl.cleanCache({ dir }),
        readCast: (dir) => impl.readCast({ dir }),
        saveCast: (dir, data) => impl.saveCast({ dir, data }),
        readCanvas: (dir) => impl.readCanvas({ dir }),
        saveCanvas: (dir, data) => impl.saveCanvas({ dir, data }),
        analyzeProfile: (dir, payload) => impl.analyzeProfile({ dir, ...payload || {} }),
        registerShortcuts: () => impl.registerShortcuts(),
        aiChat: (id, messages) => impl.aiChat({ id, messages }),
        aiCancel: (id) => impl.aiCancel({ id }),
        onAiDelta: (cb) => impl.onAiDelta(cb),
        aiKeyStatus: () => impl.aiKeyStatus(),
        aiKeySet: (key) => impl.aiKeySet({ key }),
        analyzeRun: (id, dir, budget, force) => impl.analyzeRun({ id, dir, budget, force }),
        analyzeCancel: (id) => impl.analyzeCancel({ id }),
        analyzeApply: (dir, result, selectedKeys, writePoints) => impl.analyzeApply({ dir, result, selectedKeys, writePoints }),
        onAnalyzeProgress: (cb) => impl.onAnalyzeProgress(cb),
        minimize: () => impl.minimize(),
        toggleMaximize: () => impl.toggleMaximize(),
        toggleFullScreen: () => impl.toggleFullScreen(),
        closeWindow: () => impl.closeWindow(),
        windowState: () => impl.windowState(),
        setZoom: (factor) => impl.setZoom({ factor }),
        popupMenu: () => impl.popupMenu(),
        onWindowState: (cb) => impl.onWindowState(cb),
        onMenu: (cb) => impl.onMenu(cb)
      };
      function expose() {
        window.mushu = api2;
      }
      module.exports = { expose, markReady, ready, settingsStore, PROJECTS_ROOT, BACKUP_ROOT };
    }
  });

  // src/mobile/sync.js
  var require_sync = __commonJS({
    "src/mobile/sync.js"(exports, module) {
      "use strict";
      var fs2 = require_fs();
      var path = require_path();
      var { readText } = require_fsutil();
      var config2 = require_config();
      var ui2 = require_ui();
      var PROJECTS_ROOT = "/mushu/works";
      var STATE_FILE = "/mushu/sync-state.json";
      var SKIP_PREFIX = [".mushu/versions/", ".mushu/drafts/"];
      var MAX_PUSH_BYTES = 24 * 1024 * 1024;
      var SYNC_INTERVAL_MS = 3 * 60 * 1e3;
      var running = null;
      var timer = null;
      var debounceTimer = null;
      var lastError = "";
      var started = false;
      function skipRel(rel) {
        return SKIP_PREFIX.some((p) => rel.startsWith(p)) || /\.tmp-\d+-\d+$/.test(rel);
      }
      function loadState() {
        try {
          return JSON.parse(readText(STATE_FILE, "{}")) || {};
        } catch {
          return {};
        }
      }
      function saveState(state) {
        const { writeTextAtomic } = require_fsutil();
        writeTextAtomic(STATE_FILE, JSON.stringify(state, null, 2));
      }
      function localWorks() {
        if (!fs2.existsSync(PROJECTS_ROOT)) return [];
        return fs2.readdirSync(PROJECTS_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory() && fs2.existsSync(path.join(PROJECTS_ROOT, e.name, "book.json"))).map((e) => e.name);
      }
      function localFiles(work) {
        const root = path.join(PROJECTS_ROOT, work);
        const out = [];
        const walk = (dir, relBase) => {
          let entries = [];
          try {
            entries = fs2.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            const rel = relBase ? `${relBase}/${e.name}` : e.name;
            const abs = path.join(dir, e.name);
            if (e.isDirectory()) {
              if (skipRel(rel) || skipRel(rel + "/")) continue;
              walk(abs, rel);
            } else if (e.isFile()) {
              if (skipRel(rel)) continue;
              out.push({ rel, abs, mtime: fs2.statSync(abs).mtimeMs });
            }
          }
        };
        walk(root, "");
        return out;
      }
      function headers() {
        const cfg = config2.get();
        return {
          "Content-Type": "application/json",
          "X-Mushu-Password": cfg.password || ""
        };
      }
      function apiUrl(p) {
        return config2.get().baseUrl.replace(/\/+$/, "") + p;
      }
      async function request(p, init) {
        const res = await fetch(apiUrl(p), {
          ...init,
          headers: { ...headers(), ...init && init.headers || {} }
        });
        if (!res.ok) {
          let detail = "";
          try {
            detail = (await res.json()).error || "";
          } catch {
            detail = "";
          }
          throw new Error(detail || `服务器返回 ${res.status}`);
        }
        return res.json();
      }
      function setStatus(text, tone) {
        ui2.setSyncStatus(text, tone);
      }
      async function pullWork(work, state, remote) {
        const root = path.join(PROJECTS_ROOT, work);
        fs2.mkdirSync(root, { recursive: true });
        let pulled = 0;
        const entries = Object.entries(remote || {});
        for (const [rel, info] of entries) {
          if (skipRel(rel)) continue;
          const abs = path.join(root, ...rel.split("/"));
          fs2.mkdirSync(path.dirname(abs), { recursive: true });
          try {
            const data = await request(`/api/sync/file?work=${encodeURIComponent(work)}&path=${encodeURIComponent(rel)}`);
            if (!data.exists) continue;
            fs2.writeFileSync(abs, String(data.text == null ? "" : data.text), "utf8");
            const mtime = Number(data.mtime) || Number(info && info.mtime) || Date.now();
            try {
              fs2.utimesSync(abs, mtime / 1e3, mtime / 1e3);
            } catch {
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
          if (remoteMtime > localMtime + 1200 && unchangedLocally) continue;
          if (sameAsRemote) {
            state[file.rel] = localMtime;
            continue;
          }
          if (unchangedLocally) continue;
          const text = readText(file.abs, "");
          if (new TextEncoder().encode(text).length > MAX_PUSH_BYTES) continue;
          await request("/api/sync/file", {
            method: "PUT",
            body: JSON.stringify({ work, path: file.rel, text, mtime: localMtime })
          });
          state[file.rel] = localMtime;
          pushed += 1;
        }
        return pushed;
      }
      async function pullAllRemote(state) {
        const data = await request("/api/works");
        const works = Array.isArray(data.works) ? data.works : [];
        for (const work of works) {
          const name = work.name;
          if (!name) continue;
          if (!fs2.existsSync(path.join(PROJECTS_ROOT, name, "book.json"))) {
            const manifest = await request(`/api/sync/manifest?work=${encodeURIComponent(name)}`);
            state[name] = state[name] || {};
            await pullWork(name, state[name], manifest.files || {});
          }
        }
      }
      async function syncOnce(reason) {
        const cfg = config2.get();
        if (!cfg.password) {
          setStatus("仅本地", "idle");
          if (reason === "manual" && typeof window.__mushuOpenSetup === "function") window.__mushuOpenSetup();
          return { skipped: true };
        }
        setStatus("同步中…", "syncing");
        const state = loadState();
        let pulled = 0;
        let pushed = 0;
        try {
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
          const at = /* @__PURE__ */ new Date();
          lastError = "";
          await config2.save({ lastSyncAt: at.toISOString() });
          setStatus(`已同步 ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`, "ok");
          return { pulled, pushed, reason };
        } catch (err) {
          lastError = err && err.message ? err.message : String(err);
          setStatus("同步失败", "error");
          if (reason !== "auto") ui2.toast("同步失败：" + lastError);
          return { error: lastError };
        }
      }
      function runSync(reason) {
        if (running) return running;
        running = (async () => {
          try {
            return await syncOnce(reason || "auto");
          } finally {
            running = null;
          }
        })();
        return running;
      }
      function schedule(delayMs) {
        if (!config2.get().autoSync) return;
        if (!config2.get().password) return;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          runSync("auto");
        }, Number.isFinite(delayMs) ? delayMs : 8e3);
      }
      function start2() {
        window.__mushuSyncNow = () => runSync("manual");
        if (started) return;
        started = true;
        clearInterval(timer);
        timer = setInterval(() => runSync("auto"), SYNC_INTERVAL_MS);
        if (navigator.onLine) setTimeout(() => runSync("auto"), 2500);
        window.addEventListener("online", () => schedule(1500));
      }
      module.exports = { start: start2, runSync, schedule, syncOnce };
    }
  });

  // src/mobile/touch.js
  var require_touch = __commonJS({
    "src/mobile/touch.js"(exports, module) {
      "use strict";
      var EDITABLE = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]';
      function isEditable(target) {
        return !!(target && target.closest && target.closest(EDITABLE));
      }
      function inCanvas(target) {
        return !!(target && target.closest && target.closest("#canvas-viewport, #canvas-palette"));
      }
      function mouse(type, touch2, buttons) {
        return new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          button: 0,
          buttons: buttons == null ? 1 : buttons,
          clientX: touch2.clientX,
          clientY: touch2.clientY,
          screenX: touch2.screenX,
          screenY: touch2.screenY
        });
      }
      function fire(target, type, touch2, buttons) {
        const ev = mouse(type, touch2, buttons);
        (target || document).dispatchEvent(ev);
        return ev;
      }
      function install() {
        if (typeof navigator === "undefined" || !("ontouchstart" in window || navigator.maxTouchPoints > 0)) return;
        let longPressTimer = null;
        let suppressClick = false;
        let startPoint = null;
        let startTarget = null;
        let moved = false;
        let dragging = false;
        let lastTap = null;
        let pinch = null;
        const clearLongPress = () => {
          if (longPressTimer) clearTimeout(longPressTimer);
          longPressTimer = null;
        };
        const openContextMenu = (target, touch2) => {
          suppressClick = true;
          const ev = mouse("contextmenu", touch2, 0);
          (target || document).dispatchEvent(ev);
        };
        const onTouchStart = (e) => {
          if (isEditable(e.target)) return;
          if (e.touches.length >= 2 && inCanvas(e.target)) {
            e.preventDefault();
            clearLongPress();
            if (dragging) {
              fire(document, "mouseup", startPoint || e.touches[0], 0);
              dragging = false;
            }
            const [a, b] = [e.touches[0], e.touches[1]];
            pinch = {
              dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
              x: (a.clientX + b.clientX) / 2,
              y: (a.clientY + b.clientY) / 2
            };
            return;
          }
          if (!inCanvas(e.target)) {
            const touch3 = e.touches[0];
            startPoint = { clientX: touch3.clientX, clientY: touch3.clientY, screenX: touch3.screenX, screenY: touch3.screenY };
            startTarget = e.target;
            moved = false;
            clearLongPress();
            longPressTimer = setTimeout(() => {
              if (!moved && startTarget) openContextMenu(startTarget, startPoint);
            }, 560);
            return;
          }
          e.preventDefault();
          const touch2 = e.touches[0];
          startPoint = { clientX: touch2.clientX, clientY: touch2.clientY, screenX: touch2.screenX, screenY: touch2.screenY };
          startTarget = e.target;
          moved = false;
          dragging = true;
          fire(e.target, "mousedown", touch2, 1);
          clearLongPress();
          longPressTimer = setTimeout(() => {
            if (!moved && startTarget) {
              openContextMenu(startTarget, startPoint);
              fire(document, "mouseup", startPoint, 0);
              dragging = false;
            }
          }, 560);
        };
        const onTouchMove = (e) => {
          if (isEditable(e.target) && !inCanvas(e.target)) return;
          if (pinch && e.touches.length >= 2) {
            e.preventDefault();
            const [a, b] = [e.touches[0], e.touches[1]];
            const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
            const x = (a.clientX + b.clientX) / 2;
            const y = (a.clientY + b.clientY) / 2;
            if (pinch.dist > 0) {
              const ratio = dist / pinch.dist;
              if (Math.abs(Math.log(ratio)) > 0.04) {
                const steps = Math.max(1, Math.round(Math.log(ratio) / Math.log(1.12)));
                const viewport = document.getElementById("canvas-viewport");
                if (viewport) {
                  for (let i = 0; i < Math.abs(steps); i += 1) {
                    const ev = new WheelEvent("wheel", {
                      bubbles: true,
                      cancelable: true,
                      clientX: x,
                      clientY: y,
                      deltaY: steps > 0 ? -1 : 1
                    });
                    viewport.dispatchEvent(ev);
                  }
                }
                pinch.dist = dist;
              }
            }
            pinch.x = x;
            pinch.y = y;
            return;
          }
          if (!startPoint) return;
          const touch2 = e.touches[0];
          if (!touch2) return;
          if (Math.hypot(touch2.clientX - startPoint.clientX, touch2.clientY - startPoint.clientY) > 8) {
            moved = true;
            clearLongPress();
          }
          if (dragging || inCanvas(e.target)) {
            e.preventDefault();
            fire(document, "mousemove", touch2, 1);
          }
        };
        const onTouchEnd = (e) => {
          clearLongPress();
          const touch2 = e.changedTouches && e.changedTouches[0];
          if (pinch) {
            if (e.touches.length < 2) pinch = null;
            return;
          }
          if (!startPoint || !touch2) {
            startPoint = null;
            return;
          }
          if (dragging) {
            fire(document, "mouseup", touch2, 0);
            dragging = false;
          }
          const dx = touch2.clientX - startPoint.clientX;
          const dy = touch2.clientY - startPoint.clientY;
          const isTap = !moved && Math.hypot(dx, dy) <= 12;
          if (isTap && startTarget) {
            const now = Date.now();
            if (lastTap && now - lastTap.at < 320 && Math.hypot(touch2.clientX - lastTap.x, touch2.clientY - lastTap.y) < 32) {
              fire(startTarget, "dblclick", touch2, 0);
              lastTap = null;
            } else {
              lastTap = { at: now, x: touch2.clientX, y: touch2.clientY, target: startTarget };
            }
          } else {
            lastTap = null;
          }
          startPoint = null;
          startTarget = null;
          moved = false;
        };
        document.addEventListener("touchstart", onTouchStart, { passive: false, capture: true });
        document.addEventListener("touchmove", onTouchMove, { passive: false, capture: true });
        document.addEventListener("touchend", onTouchEnd, { passive: false, capture: true });
        document.addEventListener("touchcancel", onTouchEnd, { passive: false, capture: true });
        document.addEventListener(
          "click",
          (e) => {
            if (suppressClick) {
              suppressClick = false;
              e.stopPropagation();
              e.preventDefault();
            }
          },
          true
        );
        document.addEventListener("gesturestart", (e) => e.preventDefault());
        if (window.visualViewport) {
          const vv = window.visualViewport;
          const onResize = () => {
            document.documentElement.style.setProperty("--mushu-vvh", vv.height + "px");
            if (document.activeElement && isEditable(document.activeElement)) {
              document.activeElement.scrollIntoView({ block: "nearest" });
            }
          };
          vv.addEventListener("resize", onResize);
          onResize();
        }
      }
      function adaptLayout() {
        const apply = () => {
          const narrow = window.innerWidth < 920;
          document.body.classList.toggle("mushu-narrow", narrow);
          if (narrow) {
            const close = document.getElementById("rail-right-close");
            const panel = document.getElementById("panel");
            if (close && panel && !panel.classList.contains("collapsed")) close.click();
          }
        };
        apply();
        window.addEventListener("orientationchange", () => setTimeout(apply, 250));
        window.addEventListener("resize", apply);
      }
      module.exports = { install, adaptLayout };
    }
  });

  // src/mobile/boot.js
  var fs = require_fs();
  var storage = require_storage();
  var config = require_config();
  var ui = require_ui();
  var api = require_api();
  var sync = require_sync();
  var touch = require_touch();
  var ai = require_ai_client();
  var native = require_native();
  if (!globalThis.process) globalThis.process = { pid: 1, env: {}, cwd: () => "/" };
  fs.installBuffer();
  api.expose();
  async function flushOnHide() {
    try {
      await storage.flushNow();
      await sync.runSync("auto");
    } catch {
    }
  }
  function setupPlugin(name) {
    if (!native.isNative()) return null;
    const getter = native[name];
    return typeof getter === "function" ? getter() : null;
  }
  async function openSetup() {
    const cfg = config.get();
    return ui.showSetup({
      baseUrl: cfg.baseUrl,
      password: cfg.password,
      autoSync: cfg.autoSync,
      onSave: async (next) => {
        await ai.verify(next);
        await config.save({ ...next, baseUrl: next.baseUrl || cfg.baseUrl, setupDone: true });
        await ai.refreshStatus();
        sync.start();
        sync.runSync("manual");
      },
      onSkip: async () => {
        await config.save({ autoSync: false, setupDone: true });
        ui.setSyncStatus("仅本地", "idle");
      }
    });
  }
  async function start() {
    ui.markIos();
    ui.setLoading("正在载入本地作品…");
    try {
      await config.load();
      const entries = await storage.loadAll();
      fs.loadEntries(entries);
      fs.setChangeHook(storage.mark);
      fs.mkdirSync("/mushu/works", { recursive: true });
      fs.mkdirSync("/mushu/backups", { recursive: true });
      api.markReady();
      ui.hideLoading();
      ui.ensureSyncIndicator();
      ui.setSyncStatus(config.get().password ? "等待同步" : "仅本地", "idle");
      storage.setFlushListener(() => sync.schedule(8e3));
      touch.install();
      touch.adaptLayout();
      const statusBar = setupPlugin("statusBar");
      if (statusBar) {
        try {
          statusBar.setStyle({ style: "DARK" });
          statusBar.setOverlay({ overlay: false });
        } catch {
        }
      }
      const keyboard = setupPlugin("keyboard");
      if (keyboard && typeof keyboard.setResizeMode === "function") {
        try {
          keyboard.setResizeMode({ mode: "native" });
        } catch {
        }
      }
      const appPlugin = setupPlugin("app");
      if (appPlugin && typeof appPlugin.addListener === "function") {
        appPlugin.addListener("appStateChange", ({ isActive }) => {
          if (!isActive) flushOnHide();
        });
      }
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flushOnHide();
      });
      window.addEventListener("pagehide", () => {
        flushOnHide();
      });
      if (!config.get().password) {
        window.__mushuOpenSetup = () => openSetup();
        if (!config.get().setupDone) setTimeout(() => openSetup(), 400);
        return;
      }
      await config.save({ setupDone: true });
      window.__mushuOpenSetup = () => openSetup();
      await ai.refreshStatus();
      sync.start();
    } catch (err) {
      console.error("[mushu] 启动失败", err);
      ui.setLoading("启动失败：" + (err && err.message ? err.message : String(err)));
      api.markReady();
    }
  }
  window.__mushuIpad = { api, sync, storage, config, openSetup };
  start();
})();
