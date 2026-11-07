'use strict';
/**
 * 打包成单文件可执行程序（Node SEA，无需目标机器装 Node）。
 *
 *   npm run build
 *   → dist/LiteFingerprint.exe   （Windows）
 *
 * 做法：把 src/*.js 塞进一个极小的 CommonJS 注册表，public/ 与 fp/patch.js 作为资源内嵌，
 * 生成 dist/sea-main.js，再用 Node 自带的 --experimental-sea-config 产出 blob，
 * 最后用 postject 把 blob 注进 node 可执行文件。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT_NAME = process.platform === 'win32' ? 'LiteFingerprint.exe' : 'lite-fingerprint';
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const MODULES = ['index', 'server', 'store', 'launch', 'cdp', 'proxy', 'browser', 'runtime'];

function readModules() {
  const out = {};
  for (const name of MODULES) {
    const file = path.join(ROOT, 'src', name + '.js');
    // shebang 放在函数体里会语法错误
    out['src/' + name + '.js'] = fs.readFileSync(file, 'utf8').replace(/^#![^\n]*\n/, '');
  }
  return out;
}

function readAssets() {
  const out = {};
  for (const name of fs.readdirSync(path.join(ROOT, 'public'))) {
    const file = path.join(ROOT, 'public', name);
    if (!fs.statSync(file).isFile()) continue;
    out['public/' + name] = fs.readFileSync(file, 'utf8');
  }
  out['src/fp/patch.js'] = fs.readFileSync(path.join(ROOT, 'src', 'fp', 'patch.js'), 'utf8');
  return out;
}

function buildBundle(modules, assets) {
  const parts = [];
  parts.push("'use strict';");
  parts.push("const path = require('node:path');");
  parts.push('globalThis.__FB_ASSETS__ = ' + JSON.stringify(assets) + ';');
  // 绿色版：数据目录、日志都放在 exe 旁边（不可写时 store.js 会退到 LOCALAPPDATA）
  parts.push('if (!process.env.FB_APP_ROOT) process.env.FB_APP_ROOT = path.dirname(process.execPath);');
  parts.push('const MODULES = {');
  for (const [id, src] of Object.entries(modules)) {
    parts.push(JSON.stringify(id) + ': function (module, exports, require, __filename, __dirname) {');
    parts.push(src);
    parts.push('},');
  }
  parts.push('};');
  parts.push(
    [
      'const CACHE = Object.create(null);',
      'function load(id) {',
      '  if (CACHE[id]) return CACHE[id].exports;',
      '  const factory = MODULES[id];',
      '  if (!factory) return require(id);',
      '  const m = { exports: {} };',
      '  CACHE[id] = m;',
      '  const dir = path.posix.dirname(id);',
      '  const req = (rel) => {',
      "    if (!rel.startsWith('.')) return require(rel);",
      '    let p = path.posix.normalize(path.posix.join(dir, rel));',
      "    if (!p.endsWith('.js')) p += '.js';",
      '    return load(p);',
      '  };',
      '  factory(m, m.exports, req, id, dir);',
      '  return m.exports;',
      '}',
      "load('src/index.js');",
    ].join('\n')
  );
  return parts.join('\n');
}

async function main() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  const bundle = buildBundle(readModules(), readAssets());
  fs.writeFileSync(path.join(DIST, 'sea-main.js'), bundle, 'utf8');

  fs.writeFileSync(
    path.join(DIST, 'sea-config.json'),
    JSON.stringify(
      {
        main: 'dist/sea-main.js',
        output: 'dist/sea-prep.blob',
        disableExperimentalSEAWarning: true,
      },
      null,
      2
    ),
    'utf8'
  );

  console.log('· 生成 SEA blob…');
  execFileSync(process.execPath, ['--experimental-sea-config', path.join(DIST, 'sea-config.json')], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  const exe = path.join(DIST, OUT_NAME);
  fs.copyFileSync(process.execPath, exe);

  console.log('· 注入 blob…');
  const postject = require('postject');
  await postject.inject(exe, 'NODE_SEA_BLOB', fs.readFileSync(path.join(DIST, 'sea-prep.blob')), {
    sentinelFuse: SENTINEL,
  });

  fs.rmSync(path.join(DIST, 'sea-prep.blob'), { force: true });
  const mb = (fs.statSync(exe).size / 1024 / 1024).toFixed(1);
  console.log('· 完成：' + path.relative(ROOT, exe) + '（' + mb + ' MB）');
  console.log('  双击即可；数据目录默认在 exe 同级的 data/，可用 FB_DATA 覆盖。');
}

main().catch((e) => {
  console.error('打包失败：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
