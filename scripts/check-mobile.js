'use strict';

/**
 * 运行 iPad 端数据层自检。
 * 用 esbuild 把自检入口和桌面端服务模块打成一个 Node 可执行文件（fs/path/crypto 换成移动端实现），
 * 避免污染真实磁盘。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MOBILE = path.join(ROOT, 'src', 'mobile');
const OUT = path.join(os.tmpdir(), `mushu-mobile-selftest-${process.pid}.cjs`);

async function main() {
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'mobile-selftest.entry.js')],
    outfile: OUT,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: ['node18'],
    logLevel: 'silent',
    nodePaths: [path.join(ROOT, 'mobile', 'node_modules')],
    plugins: [
      {
        name: 'mushu-node-shims',
        setup(build) {
          build.onResolve({ filter: /^fs$/ }, () => ({ path: path.join(MOBILE, 'shims', 'fs.js') }));
          build.onResolve({ filter: /^path$/ }, () => ({ path: path.join(MOBILE, 'shims', 'path.js') }));
          build.onResolve({ filter: /^crypto$/ }, () => ({ path: path.join(MOBILE, 'shims', 'crypto.js') }));
        },
      },
    ],
  });
  execFileSync(process.execPath, [OUT], { stdio: 'inherit' });
}

main()
  .catch((err) => {
    console.error('[check-mobile] 失败：', err.message || err);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      fs.unlinkSync(OUT);
    } catch {
      /* 忽略 */
    }
  });
