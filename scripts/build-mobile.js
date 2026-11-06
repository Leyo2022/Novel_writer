'use strict';

/**
 * 生成 iPad 端可打包的 www 目录。
 *
 * 思路：复用桌面端同一套渲染层（app.js / ai.js / markdown.js / styles.css），
 * 只在前面插入 iPad 专用的 window.mushu 实现（虚拟文件系统 + 同步 + AI 代理 + 触控适配）。
 *
 * 用法：node scripts/build-mobile.js
 */

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const MOBILE = path.join(ROOT, 'src', 'mobile');
const WWW = path.join(ROOT, 'mobile', 'www');

const COPY = ['app.js', 'ai.js', 'markdown.js', 'styles.css'];

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function buildIndex() {
  const source = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  let html = source;

  const headInject = [
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />',
    '<meta name="apple-mobile-web-app-capable" content="yes" />',
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
    '<meta name="format-detection" content="telephone=no" />',
    '<meta name="theme-color" content="#14161a" />',
  ].join('\n    ');

  if (!html.includes('<meta charset="UTF-8"')) throw new Error('index.html 里找不到 charset 声明');
  html = html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    ${headInject}`);

  // CSP：放开与自有服务器之间的请求（同步 / AI 代理）
  html = html.replace(
    /<meta http-equiv="Content-Security-Policy"[\s\S]*?>/,
    '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'; script-src \'self\'; img-src \'self\' data: blob:; connect-src \'self\' https: http://localhost:* ws:; font-src \'self\' data:; media-src \'self\' data: blob:" />'
  );

  html = html.replace('</head>', '    <link rel="stylesheet" href="ios.css" />\n  </head>');

  if (!html.includes('<script src="app.js"></script>')) throw new Error('index.html 里找不到 app.js 引入');
  html = html.replace(
    '<script src="markdown.js"></script>',
    '<script src="app.bundle.js"></script>\n    <script src="markdown.js"></script>'
  );

  fs.writeFileSync(path.join(WWW, 'index.html'), html, 'utf8');
}

async function buildBundle() {
  await esbuild.build({
    entryPoints: [path.join(MOBILE, 'boot.js')],
    outfile: path.join(WWW, 'app.bundle.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['safari15'],
    charset: 'utf8',
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
    nodePaths: [path.join(ROOT, 'mobile', 'node_modules')],
    plugins: [
      {
        name: 'mushu-node-shims',
        setup(build) {
          build.onResolve({ filter: /^fs$/ }, () => ({ path: path.join(MOBILE, 'shims', 'fs.js') }));
          build.onResolve({ filter: /^path$/ }, () => ({ path: path.join(MOBILE, 'shims', 'path.js') }));
          build.onResolve({ filter: /^crypto$/ }, () => ({ path: path.join(MOBILE, 'shims', 'crypto.js') }));
          build.onResolve({ filter: /^\.\/ai(\.js)?$/ }, (args) => {
            if (/[\\/]services[\\/]/.test(args.importer)) return { path: path.join(MOBILE, 'ai-client.js') };
            return null;
          });
        },
      },
    ],
  });
}

async function main() {
  fs.rmSync(WWW, { recursive: true, force: true });
  fs.mkdirSync(WWW, { recursive: true });

  for (const name of COPY) copyFile(path.join(RENDERER, name), path.join(WWW, name));
  copyFile(path.join(MOBILE, 'ios.css'), path.join(WWW, 'ios.css'));
  buildIndex();
  await buildBundle();

  const size = fs.statSync(path.join(WWW, 'app.bundle.js')).size;
  console.log(`[build-mobile] 完成：${path.relative(ROOT, WWW)}（app.bundle.js ${(size / 1024).toFixed(1)} KB）`);
}

main().catch((err) => {
  console.error('[build-mobile] 失败：', err);
  process.exit(1);
});
