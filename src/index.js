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

async function main() {
  const cmd = argv[0];

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
    return;
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

  if (flag('open', true) !== false && flag('no-open', false) === false) openBrowser(url);

  const shutdown = async () => {
    console.log('\n正在关闭已启动的环境…');
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
