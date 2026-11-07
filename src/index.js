#!/usr/bin/env node
'use strict';
/**
 * 轻量指纹浏览器 —— 入口 / CLI
 *
 * 人用：
 *   node src/index.js                       起控制台（自动打开浏览器）
 *   node src/index.js create --name 店铺A --preset us-shop
 *   node src/index.js list
 *
 * agent 用（全部支持 --json，stdout 只输出 JSON，退出码 0/1）：
 *   node src/index.js create --spec '{"name":"店铺A","preset":"us-shop"}' --json
 *   node src/index.js list --json
 *   node src/index.js launch --group 美国店铺 --json
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { createServer } = require('./server');
const store = require('./store');
const launcher = require('./launch');
const { findBrowser } = require('./browser');
const { testProxy } = require('./proxy');
const { PRESETS, getPreset, parseProxyLine, parseProxies, readJsonArg } = require('./cliutil');

const argv = process.argv.slice(2);
const jsonMode = hasFlag('json');
const cmd = argv[0] && !String(argv[0]).startsWith('--') ? String(argv[0]).toLowerCase() : 'serve';

/* -------------------------------- 参数工具 -------------------------------- */

function hasFlag(name) {
  return argv.includes('--' + name);
}

function argValue(name) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return null;
  const v = argv[i + 1];
  return v && !String(v).startsWith('--') ? v : null;
}

/** 位置参数（跳过 --flag 与其值） */
function positional() {
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (String(a).startsWith('--')) {
      const v = argv[i + 1];
      if (v !== undefined && !String(v).startsWith('--')) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function emit(obj, text) {
  const payload = jsonMode ? JSON.stringify(obj, null, 2) + '\n' : text ? text + '\n' : '';
  if (!payload) return Promise.resolve();
  return new Promise((resolve) => process.stdout.write(payload, resolve));
}

function fail(message) {
  if (jsonMode) {
    process.stdout.write(JSON.stringify({ ok: false, error: message }, null, 2) + '\n', () => process.exit(1));
  } else {
    console.error('✗ ' + message);
    process.exit(1);
  }
}

/* ------------------------------- 控制台相关 ------------------------------- */

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true, detached: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
  } catch {
    /* ignore */
  }
}

/** 用 Chrome/Edge 的 app 模式打开控制台：无地址栏、无标签栏 */
function openAppWindow(url) {
  const browser = findBrowser();
  if (!browser) return false;
  try {
    spawn(browser, ['--app=' + url, '--window-size=1180,820', '--window-position=80,60'], {
      stdio: 'ignore',
      detached: true,
    }).unref();
    return true;
  } catch {
    return false;
  }
}

/** 已经有一个控制台在跑？返回 {pid, port} */
function liveConsole() {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(path.join(store.DATA, 'console.json'), 'utf8'));
  } catch {
    return Promise.resolve(null);
  }
  if (!info || !info.port || !info.pid) return Promise.resolve(null);
  try {
    process.kill(info.pid, 0);
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: info.port, path: '/api/state', timeout: 1200 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200 ? info : null);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/* --------------------------------- 命令 ---------------------------------- */

async function cmdList() {
  await launcher.reattach();
  const rows = store.list().map((p) => {
    const info = launcher.getRunning(p.id);
    return { ...store.publicProfile(p), running: !!info, pid: info ? info.pid : null };
  });
  if (jsonMode) return emit({ ok: true, count: rows.length, profiles: rows });
  if (!rows.length) return emit({ ok: true, count: 0 }, '还没有任何环境。例：node src/index.js create --name 店铺A --preset us-shop');
  const lines = ['ID             状态   平台   分组          名称'];
  for (const p of rows) {
    lines.push(
      p.id.padEnd(15) +
        (p.running ? '运行中' : '已停止').padEnd(7) +
        String(p.platform).padEnd(6) +
        String(p.group || '-').padEnd(13) +
        p.name
    );
  }
  emit({ ok: true, count: rows.length }, lines.join('\n'));
}

async function cmdCreate() {
  const spec = readJsonArg(argValue('spec')) || {};
  const presetName = argValue('preset') || spec.preset || null;
  const preset = presetName ? getPreset(presetName) : null;

  let proxies = [];
  const proxiesFile = argValue('proxies');
  if (proxiesFile) {
    proxies = parseProxies(fs.readFileSync(proxiesFile, 'utf8'));
  } else if (argValue('proxy')) {
    proxies = [parseProxyLine(argValue('proxy'))];
  }

  const countGiven = argValue('count') !== null;
  let count = countGiven ? Math.max(1, Number(argValue('count')) || 1) : proxies.length || 1;
  if (proxies.length && count > proxies.length) {
    return fail('代理只有 ' + proxies.length + ' 个，但 --count=' + count + '；一对一是硬要求');
  }

  const baseName = argValue('name') || spec.name || (preset ? preset.label : '新环境');
  const group = argValue('group') || spec.group || (preset ? preset.label : '');

  const created = [];
  for (let i = 0; i < count; i++) {
    const fields = { ...spec };
    delete fields.preset;
    if (preset) {
      fields.platform = fields.platform || preset.platform;
      fields.locale = fields.locale || preset.locale;
      fields.languages = fields.languages || preset.languages;
      fields.timezone = fields.timezone || preset.timezone;
    }
    fields.name = count > 1 ? baseName + '-' + (i + 1) : baseName;
    fields.group = fields.group || group;
    if (proxies[i]) fields.proxy = proxies[i];
    created.push(store.publicProfile(store.create(fields)));
  }

  const text = created
    .map((p) => '✓ ' + p.name + '  ' + p.id + '  ' + p.platform + ' / ' + p.timezone + (p.proxy.host ? ' / ' + p.proxy.type + ' ' + p.proxy.host : ''))
    .join('\n');
  return emit({ ok: true, count: created.length, created }, text);
}

async function cmdClone(id) {
  if (!id) return fail('用法：clone <环境ID> [--name 新名字]');
  const p = store.clone(id);
  if (!p) return fail('环境不存在：' + id);
  const name = argValue('name');
  const saved = name ? store.update(p.id, { name }) : p;
  return emit({ ok: true, profile: store.publicProfile(saved) }, '✓ 已克隆为「' + saved.name + '」（' + saved.id + '）');
}

async function cmdRm(ids) {
  await launcher.reattach();
  const target = ids.length ? ids : resolveTargets();
  if (!target.length) return fail('用法：rm <环境ID>... 或 --group <分组>');
  const results = [];
  for (const id of target) {
    const existed = !!store.get(id);
    if (existed) await launcher.stop(id);
    const ok = existed && store.remove(id);
    results.push({ id, ok });
  }
  const removed = results.filter((r) => r.ok).length;
  return emit(
    { ok: true, removed, results },
    removed ? '✓ 已删除 ' + removed + ' 个环境' : '没有删除任何环境（ID 对不上？）'
  );
}

function resolveTargets() {
  if (hasFlag('all')) return store.list().map((p) => p.id);
  const group = argValue('group');
  if (group) {
    return store
      .list()
      .filter((p) => (p.group || '') === group)
      .map((p) => p.id);
  }
  return positional();
}

async function cmdLaunch() {
  await launcher.reattach();
  const ids = resolveTargets();
  if (!ids.length) return fail('没有匹配的环境（用 ID、--group <分组> 或 --all）');
  const results = [];
  for (const id of ids) {
    try {
      const info = await launcher.launch(id);
      results.push({
        id,
        ok: true,
        pid: info.pid,
        port: info.devtoolsPort,
        alreadyRunning: !!info.alreadyRunning,
      });
    } catch (e) {
      results.push({ id, ok: false, error: e.message });
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  const text = results
    .map((r) => (r.ok ? '✓ ' + r.id + '  已启动 PID ' + r.pid : '✗ ' + r.id + '  ' + r.error))
    .join('\n');
  return emit({ ok: okCount === results.length, launched: okCount, results }, text);
}

async function cmdStop() {
  await launcher.reattach();
  if (hasFlag('all')) {
    const ids = await launcher.stopAll();
    return emit({ ok: true, stopped: ids }, ids.length ? '已关闭：' + ids.join(', ') : '没有运行中的环境');
  }
  const ids = resolveTargets();
  if (!ids.length) return fail('用法：stop <环境ID>... / --group <分组> / --all');
  const results = [];
  for (const id of ids) results.push({ id, ok: await launcher.stop(id) });
  const stopped = results.filter((r) => r.ok).length;
  return emit({ ok: true, stopped, results }, stopped ? '✓ 已关闭 ' + stopped + ' 个环境' : '这些环境都没在运行');
}

async function cmdProbe(id) {
  if (!id) return fail('用法：probe <环境ID>');
  await launcher.reattach();
  const report = await launcher.probe(id);
  const text = [
    '✓ ' + id + ' 指纹',
    '  UA        ' + report.userAgent,
    '  平台/时区  ' + report.platform + ' / ' + report.timezone + ' / ' + report.locale,
    '  CPU/内存   ' + report.hardwareConcurrency + ' / ' + report.deviceMemory,
    '  屏幕       ' + (report.screen ? report.screen.width + '×' + report.screen.height + ' DPR ' + report.screen.dpr : '-'),
    '  WebGL      ' + report.webglRenderer,
    '  Canvas     ' + report.canvasHash + '   Audio ' + report.audioHash,
    '  注入生效   ' + report.injected,
  ].join('\n');
  return emit({ ok: true, report }, text);
}

async function cmdProxyTest(id) {
  if (!id) return fail('用法：proxy-test <环境ID>');
  const p = store.get(id);
  if (!p) return fail('环境不存在：' + id);
  const px = p.proxy || {};
  if (!px.host || px.type === 'none') return fail('这个环境没有配置代理');
  const r = await testProxy({
    type: px.type,
    host: px.host,
    port: px.port,
    username: px.username,
    password: px.password,
  });
  const text = r.ok
    ? '✓ 出口 ' + r.ip + '  ' + [r.country, r.city].filter(Boolean).join(' / ') + '  ' + r.ms + 'ms' + (r.leaked ? '\n⚠ 出口和直连 IP 一样，代理可能没生效' : '')
    : '✗ 代理不可用：' + r.error;
  return emit({ ok: r.ok, result: r }, text);
}

async function cmdExport(file) {
  const payload = { version: 1, exportedAt: new Date().toISOString(), profiles: store.exportAll() };
  if (file) {
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    return emit({ ok: true, file, count: payload.profiles.length }, '✓ 已导出 ' + payload.profiles.length + ' 个环境到 ' + file + '（不含代理密码）');
  }
  return emit(payload, JSON.stringify(payload, null, 2));
}

async function cmdImport(file) {
  if (!file) return fail('用法：import <文件.json>');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const items = Array.isArray(raw) ? raw : raw.profiles;
  if (!Array.isArray(items)) return fail('文件里没有 profiles 数组');
  const created = store.importAll(items);
  return emit(
    { ok: true, imported: created.length, profiles: created.map(store.publicProfile) },
    '✓ 已导入 ' + created.length + ' 个环境（代理密码需重新填写）'
  );
}

async function cmdPresets() {
  const rows = Object.entries(PRESETS).map(([key, p]) => ({ key, ...p }));
  return emit(
    { ok: true, presets: rows },
    rows.map((r) => r.key.padEnd(10) + r.label + '  ' + r.platform + ' / ' + r.timezone).join('\n')
  );
}

async function cmdDoctor() {
  await launcher.reattach().catch(() => []);
  const browser = findBrowser();
  let writable = true;
  try {
    fs.accessSync(store.DATA, fs.constants.W_OK);
  } catch {
    writable = false;
  }
  const live = await liveConsole();
  const running = launcher.listRunning();
  const report = {
    ok: !!browser && writable,
    node: process.version,
    platform: process.platform + '-' + process.arch,
    browser: browser || null,
    dataDir: store.DATA,
    dataWritable: writable,
    profiles: store.list().length,
    running: running.length,
    console: live ? 'http://127.0.0.1:' + live.port : null,
  };
  const text = [
    (report.ok ? '✓' : '✗') + ' 环境自检',
    '  Node        ' + report.node + ' (' + report.platform + ')',
    '  浏览器内核   ' + (report.browser || '未找到，装 Chrome/Edge 或设 FB_BROWSER'),
    '  数据目录     ' + report.dataDir + (writable ? '' : '（不可写！）'),
    '  环境数量     ' + report.profiles + '（运行中 ' + report.running + '）',
    '  控制台       ' + (report.console || '未运行'),
  ].join('\n');
  return emit(report, text);
}

function printHelp() {
  const lines = [
    '轻量指纹浏览器 · CLI',
    '',
    '  node src/index.js [serve] [--port N] [--no-open]   启动控制台（默认）',
    '  node src/index.js list [--json]                    列出环境',
    '  node src/index.js create --name 名称 [选项]         新建环境',
    '  node src/index.js clone <id> [--name 名称]          克隆（换新 seed）',
    '  node src/index.js rm <id>... | --group <g>          删除',
    '  node src/index.js launch <id>... | --group <g>      启动',
    '  node src/index.js stop <id>... | --group <g> | --all  关闭',
    '  node src/index.js probe <id> [--json]               读一次真实指纹',
    '  node src/index.js proxy-test <id> [--json]          测出口 IP',
    '  node src/index.js export [文件.json]                导出（不含密码）',
    '  node src/index.js import <文件.json>                导入',
    '  node src/index.js presets [--json]                  列出地区预设',
    '  node src/index.js doctor [--json]                   环境自检',
    '',
    'create 选项：',
    '  --preset us-shop      地区预设（presets 命令可列）',
    '  --count 5             批量，配合 --proxies 时默认等于代理条数',
    '  --proxies 文件        一行一个代理（# 注释）',
    '  --proxy <串>          单个代理，支持 http://user:pass@host:port',
    '  --group 名称          分组',
    '  --spec <json|@文件>   直接给完整字段（优先级最高）',
    '',
    '所有命令都支持 --json：stdout 只有 JSON，退出码 0 成功 / 1 失败。',
  ];
  console.log(lines.join('\n'));
}

/* --------------------------------- 控制台 --------------------------------- */

async function serve() {
  const port = Number(argValue('port') || 0) || 0;
  const wantOpen = !hasFlag('no-open') && !hasFlag('machine');
  const machine = hasFlag('machine');

  const say = (line) => {
    if (machine) process.stdout.write(line + '\n');
    else console.log(line);
  };

  if (!port) {
    const live = await liveConsole();
    if (live) {
      const u = 'http://127.0.0.1:' + live.port;
      if (machine) {
        say('FB_READY ' + JSON.stringify({ url: u, port: live.port, reused: true }));
        return;
      }
      console.log('控制台已经在运行：' + u);
      if (wantOpen && !openAppWindow(u)) openBrowser(u);
      return;
    }
  }

  const server = createServer();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actual = server.address().port;
  const url = 'http://127.0.0.1:' + actual;

  const consoleFile = path.join(store.DATA, 'console.json');
  try {
    fs.mkdirSync(store.DATA, { recursive: true });
    fs.writeFileSync(consoleFile, JSON.stringify({ pid: process.pid, port: actual, startedAt: Date.now() }), 'utf8');
  } catch {
    /* 写不进去也不影响运行 */
  }

  if (machine) {
    say('FB_READY ' + JSON.stringify({ url, port: actual, dataDir: store.DATA, pid: process.pid }));
  } else {
    const chrome = findBrowser();
    console.log('');
    console.log('  轻量指纹浏览器 · 控制台已启动');
    console.log('  ' + url);
    console.log('  浏览器内核: ' + (chrome || '未找到（请安装 Chrome 或用 FB_BROWSER 指定）'));
    console.log('  环境数据: ' + store.DATA);
    console.log('  按 Ctrl+C 退出（会一并关闭已启动的环境）');
    console.log('');
    if (wantOpen) {
      if (!openAppWindow(url)) openBrowser(url);
    }
  }

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    if (!machine) console.log('\n正在关闭已启动的环境…');
    try {
      fs.rmSync(consoleFile, { force: true });
    } catch {
      /* ignore */
    }
    await launcher.stopAll();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (machine) {
    process.stdin.on('end', shutdown);
    process.stdin.on('close', shutdown);
    try {
      process.stdin.resume();
    } catch {
      /* ignore */
    }
  }
}

/* --------------------------------- 入口 ---------------------------------- */

async function main() {
  switch (cmd) {
    case 'serve':
      return serve();
    case 'list':
    case 'ls':
      await cmdList();
      break;
    case 'create':
    case 'new':
      await cmdCreate();
      break;
    case 'clone':
      await cmdClone(positional()[0]);
      break;
    case 'rm':
    case 'remove':
    case 'delete':
      await cmdRm(positional());
      break;
    case 'launch':
    case 'start':
      await cmdLaunch();
      break;
    case 'stop':
      await cmdStop();
      break;
    case 'stop-all': {
      await launcher.reattach();
      const ids = await launcher.stopAll();
      await emit({ ok: true, stopped: ids }, ids.length ? '已关闭：' + ids.join(', ') : '没有运行中的环境');
      break;
    }
    case 'probe':
      await cmdProbe(positional()[0]);
      break;
    case 'proxy-test':
      await cmdProxyTest(positional()[0]);
      break;
    case 'export':
      await cmdExport(positional()[0]);
      break;
    case 'import':
      await cmdImport(positional()[0]);
      break;
    case 'presets':
      await cmdPresets();
      break;
    case 'doctor':
      await cmdDoctor();
      break;
    case 'help':
    case '-h':
    case '--help':
      printHelp();
      break;
    default:
      printHelp();
      fail('未知命令：' + cmd);
  }
  // 这些命令可能留下了 CDP 连接/子进程句柄，明确退出，免得 CLI 挂住
  process.exit(0);
}

main().catch((e) => {
  if (jsonMode) {
    process.stdout.write(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }, null, 2) + '\n', () =>
      process.exit(1)
    );
  } else {
    console.error('出错了：' + (e && e.message ? e.message : e));
    process.exit(1);
  }
});
