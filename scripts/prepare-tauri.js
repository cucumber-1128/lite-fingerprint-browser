'use strict';
/**
 * 给 Tauri 准备 sidecar：
 *   1. 用 scripts/build.js 打出单文件 Node 程序
 *   2. 按 Tauri 的命名规则复制成 src-tauri/binaries/fb-<target-triple>[.exe]
 *
 *   npm run client:prepare
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TRIPLES = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
};

const key = process.platform + '-' + process.arch;
const triple = TRIPLES[key];
if (!triple) {
  console.error('不支持的平台：' + key);
  process.exit(1);
}

console.log('· 打包 sidecar（Node SEA）…');
execFileSync(process.execPath, [path.join(__dirname, 'build.js')], { stdio: 'inherit' });

const exeName = process.platform === 'win32' ? 'LiteFingerprint.exe' : 'lite-fingerprint';
const src = path.join(ROOT, 'dist', exeName);
const dir = path.join(ROOT, 'src-tauri', 'binaries');
fs.mkdirSync(dir, { recursive: true });
const dst = path.join(dir, 'fb-' + triple + (process.platform === 'win32' ? '.exe' : ''));
fs.copyFileSync(src, dst);
if (process.platform !== 'win32') fs.chmodSync(dst, 0o755);
console.log('· sidecar 就位：' + path.relative(ROOT, dst));
