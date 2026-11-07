'use strict';
/**
 * 资源读取层。
 * 直接跑源码时从磁盘读；打包成单文件 exe 后，public/ 和 fp/patch.js 已经内嵌进可执行文件，
 * 由打包脚本挂到 globalThis.__FB_ASSETS__ 上，这里按同样的 key 取。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.FB_APP_ROOT ? path.resolve(process.env.FB_APP_ROOT) : path.resolve(__dirname, '..');

/** @param {string} key 形如 'public/index.html' / 'src/fp/patch.js' */
function readAsset(key) {
  const map = globalThis.__FB_ASSETS__;
  if (map && Object.prototype.hasOwnProperty.call(map, key)) return map[key];
  try {
    return fs.readFileSync(path.join(ROOT, key), 'utf8');
  } catch {
    return null;
  }
}

module.exports = { readAsset, ROOT };
