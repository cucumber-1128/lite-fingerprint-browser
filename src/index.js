#!/usr/bin/env node
'use strict';
/**
 * 轻量指纹浏览器 —— 入口
 *
 *   node src/index.js                 启动控制台（默认自动打开浏览器）
 *   node src/index.js --port 8787     指定端口
 *   node src/index.js --no-open       不自动打开
 *   node src/index.js launch <id>     命令行直接启动某个环境
 *   node src/index.js list            列出所有环境
 *   node src/index.js stop-all        关掉所有已启动环境
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('./server');
const store = require('./store');
const launcher = require('./launch');
const { findBrowser } = require('./browser');

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

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

/**
 * 用 Chrome/Edge 的 app 模式打开控制台：没有地址栏、没有标签栏，任务栏里就是一个独立窗口。
 * 这就是"轻量客户端"的外观，但不用背 Electron/Tauri 那套运行时。
 */
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

/** 已经有一个控制台在跑？避免双击两次起两个实例互相覆盖 profiles.json */
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
    const req = http.get(
      { host: '127.0.0.1', port: info.port, path: '/api/state', timeout: 1200 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200 ? info : null);
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function main() {
  const cmd = argv[0];

  // 控制台重启后，之前开着的浏览器还能被重新接管（不然会显示"已停止"且关不掉）
  try {
    await launcher.reattach();
  } catch {
    /* 接管失败不影响启动 */
  }

  if (cmd === 'list') {
    const rows = store.list();
    if (!rows.length) {
      console.log('还没有任何环境，运行 node src/index.js 后在控制台里新建。');
      return;
    }
    console.log('ID             状态   平台   名称');
    for (const p of rows) {
      const run = launcher.getRunning(p.id) ? '运行中' : '已停止';
      console.log(p.id.padEnd(15) + run.padEnd(7) + String(p.platform).padEnd(6) + p.name);
    }
    return;
  }

  if (cmd === 'launch') {
    const id = argv[1];
    if (!id) throw new Error('用法: node src/index.js launch <环境ID>');
    const info = await launcher.launch(id);
    console.log('已启动，PID=' + info.pid + '，DevTools 端口=' + info.devtoolsPort);
    console.log('UA: ' + info.ua);
    // 浏览器已经 detached 起来了，CLI 到这儿就该退出；
    // 否则子进程句柄和 CDP 的长连接会把事件循环一直挂住
    process.exit(0);
  }

  if (cmd === 'stop-all') {
    const ids = await launcher.stopAll();
    console.log(ids.length ? '已关闭：' + ids.join(', ') : '没有运行中的环境');
    return;
  }

  if (cmd === 'stop') {
    const id = argv[1];
    if (!id) throw new Error('用法: node src/index.js stop <环境ID>');
    const ok = await launcher.stop(id);
    console.log(ok ? '已关闭' : '该环境未在运行');
    return;
  }

  /* 默认：起控制台 */
  const port = Number(flag('port', 0)) || 0;
  const wantOpen = flag('open', true) !== false && flag('no-open', false) === false;

  // 双击第二次时不要起第二个实例：直接打开已经在跑的那个
  if (!port) {
    const live = await liveConsole();
    if (live) {
      const u = 'http://127.0.0.1:' + live.port;
      console.log('控制台已经在运行：' + u);
      if (wantOpen && !openAppWindow(u)) openBrowser(u);
      return;
    }
  }

  const server = createServer();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actual = server.address().port;
  const url = 'http://127.0.0.1:' + actual;

  const chrome = findBrowser();
  console.log('');
  console.log('  轻量指纹浏览器 · 控制台已启动');
  console.log('  ' + url);
  console.log('  浏览器内核: ' + (chrome || '未找到（请安装 Chrome 或用 FB_BROWSER 指定）'));
  console.log('  环境数据: ' + store.DATA);
  console.log('  按 Ctrl+C 退出（会一并关闭已启动的环境）');
  console.log('');

  const consoleFile = path.join(store.DATA, 'console.json');
  try {
    fs.mkdirSync(store.DATA, { recursive: true });
    fs.writeFileSync(consoleFile, JSON.stringify({ pid: process.pid, port: actual, startedAt: Date.now() }), 'utf8');
  } catch {
    /* 写不进去也不影响运行 */
  }

  if (wantOpen) {
    if (!openAppWindow(url)) openBrowser(url);
  }

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log('\n正在关闭已启动的环境…');
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
}

main().catch((e) => {
  console.error('出错了：' + (e && e.message ? e.message : e));
  process.exit(1);
});
