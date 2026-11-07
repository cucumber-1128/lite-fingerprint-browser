'use strict';
/** 找到本机可用的 Chromium 内核浏览器 */
const fs = require('node:fs');
const path = require('node:path');

function candidates() {
  const list = [];
  const env = process.env.FB_BROWSER;
  if (env) list.push(env);

  const local = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

  list.push(
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Chromium', 'Application', 'chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  );

  // Playwright 自带的 Chromium（干净的、没品牌状态栏，适合做指纹环境）
  try {
    const pw = path.join(local, 'ms-playwright');
    if (fs.existsSync(pw)) {
      for (const dir of fs.readdirSync(pw)) {
        if (!dir.startsWith('chromium-')) continue;
        list.push(path.join(pw, dir, 'chrome-win', 'chrome.exe'));
        list.push(path.join(pw, dir, 'chrome-linux', 'chrome'));
      }
    }
  } catch {
    /* ignore */
  }
  return list;
}

function findBrowser() {
  for (const p of candidates()) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

module.exports = { findBrowser, candidates };
