'use strict';
/**
 * 启动一个指纹环境：
 *   独立 user-data-dir → 独立代理中继 → 启动本机 Chromium → CDP 原生层覆写 → 注入 JS 指纹补丁
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { CDP } = require('./cdp');
const { findBrowser } = require('./browser');
const { createRelay, testProxy } = require('./proxy');
const { countryToLocale, TIMEZONE_COORDS, parseCookiesInput } = require('./cliutil');
const runtime = require('./runtime');
const store = require('./store');
const { assertProfileConfig } = require('./profile-validation');

const PATCH_FILE = path.join(__dirname, 'fp', 'patch.js');

const PLATFORM_UA = {
  win: {
    ua: 'Windows NT 10.0; Win64; x64',
    nav: 'Win32',
    chPlatform: 'Windows',
    chVersion: '15.0.0',
    arch: 'x86',
    bitness: '64',
  },
  mac: {
    ua: 'Macintosh; Intel Mac OS X 10_15_7',
    nav: 'MacIntel',
    chPlatform: 'macOS',
    chVersion: '14.6.0',
    arch: 'arm',
    bitness: '64',
  },
  linux: {
    ua: 'X11; Linux x86_64',
    nav: 'Linux x86_64',
    chPlatform: 'Linux',
    chVersion: '6.5.0',
    arch: 'x86',
    bitness: '64',
  },
};

/** 各平台"干净系统"自带的字体。声明了哪个平台，就只让这些字体被探测到 */
const FONT_POOL = {
  win: [
    'Arial', 'Arial Black', 'Calibri', 'Cambria', 'Cambria Math', 'Candara', 'Comic Sans MS',
    'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Ebrima', 'Franklin Gothic Medium',
    'Gabriola', 'Georgia', 'Impact', 'Lucida Console', 'Lucida Sans Unicode', 'Malgun Gothic',
    'Microsoft Himalaya', 'Microsoft JhengHei', 'Microsoft Sans Serif', 'Microsoft YaHei',
    'MingLiU', 'MS Gothic', 'MV Boli', 'Nirmala UI', 'Palatino Linotype', 'Segoe Print',
    'Segoe Script', 'Segoe UI', 'SimSun', 'Sylfaen', 'Tahoma', 'Times New Roman',
    'Trebuchet MS', 'Verdana', 'Webdings', 'Wingdings', 'Yu Gothic',
  ],
  mac: [
    'Helvetica', 'Helvetica Neue', 'Arial', 'Arial Black', 'Arial Rounded MT Bold', 'Avenir',
    'Avenir Next', 'Baskerville', 'Big Caslon', 'Bradley Hand', 'Chalkboard', 'Chalkduster',
    'Cochin', 'Comic Sans MS', 'Copperplate', 'Courier', 'Courier New', 'Didot', 'Futura',
    'Geneva', 'Georgia', 'Gill Sans', 'Hoefler Text', 'Impact', 'Lucida Grande', 'Luminari',
    'Marker Felt', 'Menlo', 'Monaco', 'Optima', 'Palatino', 'Papyrus', 'Rockwell',
    'Snell Roundhand', 'Tahoma', 'Times', 'Times New Roman', 'Trebuchet MS', 'Verdana',
    'Zapfino', 'PingFang SC', 'PingFang TC', 'Hiragino Sans', 'Hiragino Sans GB',
    'Hiragino Mincho ProN', 'STHeiti', 'Songti SC', 'Heiti SC', 'Apple SD Gothic Neo',
    'Apple Color Emoji', 'SF Pro Text', 'SF Pro Display',
  ],
  linux: [
    'DejaVu Sans', 'DejaVu Serif', 'DejaVu Sans Mono', 'Liberation Sans', 'Liberation Serif',
    'Liberation Mono', 'Noto Sans', 'Noto Serif', 'Noto Sans CJK SC', 'Ubuntu', 'Cantarell',
    'FreeSans', 'FreeSerif', 'FreeMono', 'Droid Sans', 'WenQuanYi Micro Hei',
  ],
};

/** profileId -> 运行中实例 */
const running = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 指纹检测页。
 * about:blank / data: 都是非安全上下文，navigator.deviceMemory、userAgentData 会缺失，
 * 所以检测页走 127.0.0.1（localhost 属于安全上下文），测出来的才是真实情况。
 */
let probeUrl = null;
let probeServer = null;
let probeWaiters = [];
async function ensureProbePage() {
  if (probeUrl) return probeUrl;
  const http = require('node:http');
  probeServer = http.createServer((req, res) => {
    // 顺手记下请求头：Client Hints 的真值就是从这里读的
    const waiters = probeWaiters;
    probeWaiters = [];
    for (const w of waiters) {
      try {
        w(req.headers || {});
      } catch {
        /* ignore */
      }
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end('<!doctype html><meta charset="utf-8"><title>fingerprint probe</title><body></body>');
  });
  await new Promise((resolve) => probeServer.listen(0, '127.0.0.1', resolve));
  // unref：这个常驻的检测页服务不应该拖住 Node 进程退出
  probeServer.unref();
  probeUrl = 'http://127.0.0.1:' + probeServer.address().port + '/probe';
  return probeUrl;
}

/** 等下一次到达探针页的请求（用于拿浏览器真实发出的请求头） */
function onceProbeRequest(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(null);
    }, timeoutMs);
    probeWaiters.push((headers) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(headers);
    });
  });
}

/* --------------------------- Client Hints 真值 --------------------------- */
/**
 * `sec-ch-ua` 里的 GREASE 品牌名、版本号、**顺序** 每个 Chrome 版本都不一样，
 * 自己拼一套必然和真机对不上（实测 Chrome 156 是 `"Not:A-Brand";v="8", "Chromium";v="156",
 * "Google Chrome";v="156"`，而手拼的是反过来的顺序 + `Not_A Brand";v="24"`）。
 * 所以启动时开一个后台标签页请求本地探针，把浏览器自己发的头和高熵值读回来，
 * 每个 Chrome 版本只读一次，缓存在 data/client-hints.json。
 */
const HINTS_FILE = path.join(store.DATA, 'client-hints.json');

let hintsCache = null;
try {
  const cached = JSON.parse(fs.readFileSync(HINTS_FILE, 'utf8'));
  if (cached && cached.key && cached.value) hintsCache = cached;
} catch {
  /* 没有缓存就算了 */
}

function parseBrands(header) {
  const out = [];
  const re = /"([^"]+)"\s*;\s*v\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(String(header || '')))) out.push({ brand: m[1], version: m[2] });
  return out;
}

const UA_CH_EXPR = `(async () => {
  if (!navigator.userAgentData) return '{}';
  try {
    return JSON.stringify(await navigator.userAgentData.getHighEntropyValues(
      ['platform', 'platformVersion', 'architecture', 'bitness', 'model', 'uaFullVersion', 'wow64', 'fullVersionList']
    ));
  } catch (e) {
    return '{}';
  }
})()`;

/** 在（还没有被覆写的）新标签页里读一次真实 UA-CH，读完关掉 */
async function fetchRealHints(cdp) {
  const url = await ensureProbePage();
  let targetId = null;
  let sessionId = null;
  try {
    // background: 不抢焦点；老协议不认这个参数就退回去
    let created;
    try {
      created = await cdp.send('Target.createTarget', { url: 'about:blank', background: true });
    } catch {
      created = await cdp.send('Target.createTarget', { url: 'about:blank' });
    }
    targetId = created.targetId;
    sessionId = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    await cdp.try_('Page.enable', {}, sessionId);

    const headersP = onceProbeRequest(6000);
    const loadedP = new Promise((resolve) => {
      const onLoad = (params, sid) => {
        if (sid !== sessionId) return;
        cdp.removeListener('Page.loadEventFired', onLoad);
        resolve(true);
      };
      cdp.on('Page.loadEventFired', onLoad);
      setTimeout(() => {
        cdp.removeListener('Page.loadEventFired', onLoad);
        resolve(false);
      }, 6000);
    });
    await cdp.send('Page.navigate', { url }, sessionId);
    const headers = await headersP;
    await loadedP;
    if (!headers) return null;

    let high = {};
    try {
      const res = await cdp.send(
        'Runtime.evaluate',
        { expression: UA_CH_EXPR, awaitPromise: true, returnByValue: true },
        sessionId
      );
      if (res && res.result && typeof res.result.value === 'string') high = JSON.parse(res.result.value);
    } catch {
      /* 高熵值拿不到不致命，用下面的兜底 */
    }

    return {
      userAgent: headers['user-agent'] || '',
      brands: parseBrands(headers['sec-ch-ua']),
      platformVersion: high.platformVersion || '',
      architecture: high.architecture || '',
      bitness: high.bitness || '',
      model: high.model || '',
      wow64: high.wow64 === true,
      fullVersion: high.uaFullVersion || '',
      fullVersionList: Array.isArray(high.fullVersionList) ? high.fullVersionList : [],
    };
  } finally {
    if (targetId) {
      try {
        await cdp.send('Target.closeTarget', { targetId });
      } catch {
        /* ignore */
      }
    }
  }
}

/** 取真实 UA-CH（带进程内 + 磁盘缓存，Chrome 不升级就不重复开标签页） */
async function getRealHints(cdp, product) {
  const key = String(product || '');
  if (hintsCache && hintsCache.key === key) return hintsCache.value;
  let value = null;
  try {
    value = await fetchRealHints(cdp);
  } catch {
    value = null;
  }
  if (value && key) {
    hintsCache = { key, value };
    try {
      fs.mkdirSync(store.DATA, { recursive: true });
      fs.writeFileSync(HINTS_FILE, JSON.stringify(hintsCache, null, 2), 'utf8');
    } catch {
      /* 缓存写不进去不影响启动 */
    }
  }
  return value;
}

/* ------------------------------- 指纹参数组装 ------------------------------- */

/**
 * 拼 UA。
 * 真 Chrome 从 110 起就把 UA 做了 reduction：请求头里只有 `Chrome/<major>.0.0.0`，
 * 完整版本号只出现在 UA-CH（`uaFullVersion`）里。所以这里绝不能塞完整版本号——
 * 那会让"用真内核"反而变成最明显的特征。直接用浏览器自己报的 UA 当模板，只换平台段。
 */
function buildUserAgent(profile, fullVersion, hints) {
  if (profile.userAgentMode === 'custom' && profile.userAgentCustom) return profile.userAgentCustom;
  const p = PLATFORM_UA[profile.platform] || PLATFORM_UA.win;
  const major = String(fullVersion).split('.')[0];

  let ua = String((hints && hints.userAgent) || '').trim();
  ua = ua
    .replace(/Chrome\/[0-9.]+/g, 'Chrome/' + major + '.0.0.0')
    .replace(/Edg\/[0-9.]+/g, 'Edg/' + major + '.0.0.0');
  if (!ua || ua.indexOf('Chrome/') < 0) {
    ua =
      'Mozilla/5.0 (' +
      p.ua +
      ') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' +
      major +
      '.0.0.0 Safari/537.36';
  }
  // 只替换平台段（UA 里只有一对括号）
  return ua.replace(/\([^()]*\)/, '(' + p.ua + ')');
}

/**
 * UA-CH 元数据：品牌列表用浏览器自己发的（GREASE 名字、版本、顺序都对），
 * 平台相关的高熵值按声明的平台替换；声明平台==真实平台时连架构/系统版本都沿用真值，
 * 这样在 Windows 上跑 Windows 指纹时，服务端看到的和真机逐字段一致。
 */
function buildUaMetadata(profile, fullVersion, hints) {
  const p = PLATFORM_UA[profile.platform] || PLATFORM_UA.win;
  const REAL_PLATFORM = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform] || 'linux';
  const native = profile.platform === REAL_PLATFORM;
  const major = String(fullVersion).split('.')[0];
  const full = (hints && hints.fullVersion) || fullVersion;

  const real = hints && Array.isArray(hints.brands) ? hints.brands.filter((b) => b && b.brand) : [];
  const brands = real.length
    ? real
    : [
        { brand: 'Not:A-Brand', version: '8' },
        { brand: 'Chromium', version: major },
        { brand: 'Google Chrome', version: major },
      ];

  // fullVersionList：与 brands 保持等长（包含 GREASE 项，否则长度对不上）
  const fullVersionList = brands.map((b) => {
    if (/not.?a.?brand/i.test(String(b.brand))) {
      const gv = String(b.version || '99');
      return { brand: b.brand, version: gv.includes('.') ? gv : gv + '.0.0.0' };
    }
    return { brand: b.brand, version: full };
  });

  return {
    brands,
    fullVersionList,
    fullVersion: full,
    platform: p.chPlatform,
    platformVersion: (native && hints && hints.platformVersion) || p.chVersion,
    architecture: (native && hints && hints.architecture) || p.arch,
    model: (native && hints && hints.model) || '',
    mobile: false,
    bitness: (native && hints && hints.bitness) || p.bitness,
    wow64: native && hints ? hints.wow64 === true : false,
  };
}

/** 按 seed 派生一个"像家用网段"的私网地址：所有环境共用一个 192.168.1.88 反而是聚类信号 */
function deriveFakeIp(seed) {
  const h = crypto.createHash('sha256').update(String(seed)).digest();
  return '192.168.' + (20 + (h[0] % 200)) + '.' + (20 + (h[1] % 200));
}

/** 组装注入脚本用的配置（probe 的期望值也用它，避免两处各算一套） */
function buildConfig(profile, nonce) {
  const REAL_PLATFORM = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform] || 'linux';
  const platform = profile.platform || 'win';
  const scr = store.normalizeScreen(profile.screen || {}, platform);
  return {
    seed: profile.seed || 'seed',
    nonce: nonce || crypto.randomBytes(16).toString('hex'),
    platform,
    realPlatform: REAL_PLATFORM,
    locale: profile.locale || 'zh-CN',
    hardwareConcurrency: Number(profile.hardwareConcurrency) || 8,
    // 规范上限就是 8：真 Chrome 永远不会报 16，报 16 等于自曝
    deviceMemory: Math.min(8, Math.max(1, Number(profile.deviceMemory) || 8)),
    maxTouchPoints: Number(profile.maxTouchPoints) || 0,
    screen: scr,
    webglVendor: profile.webglVendor || 'Google Inc. (NVIDIA)',
    webglRenderer:
      profile.webglRenderer ||
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    canvasNoise: profile.canvasNoise !== false,
    audioNoise: profile.audioNoise !== false,
    textNoise: profile.textNoise !== false,
    fontNoise: profile.fontNoise !== false,
    fontWhitelist: FONT_POOL[platform] || FONT_POOL.win,
    rectNoise: profile.rectNoise === true,
    webrtc: profile.webrtc || 'proxy',
    fakeIp: deriveFakeIp(profile.seed || 'seed'),
    publicIp: (profile.geo && profile.geo.ip) || '',
  };
}

/** 按 profile.geo 或时区计算带确定性街区级微扰的经纬度 */
function resolveGeolocation(profile) {
  const g = profile && profile.geo;
  const tzCoord = TIMEZONE_COORDS[profile && profile.timezone];
  const base =
    g && typeof g.lat === 'number' && typeof g.lon === 'number' && isFinite(g.lat) && isFinite(g.lon)
      ? { lat: g.lat, lon: g.lon, spread: 0.004 }
      : tzCoord
        ? { lat: tzCoord.lat, lon: tzCoord.lon, spread: 0.02 }
        : null;
  if (!base) return null;
  const h = crypto
    .createHash('sha256')
    .update(String((profile && (profile.seed || profile.id)) || 'geo'))
    .digest();
  const jLat = ((h[0] / 255) * 2 - 1) * base.spread;
  const jLon = ((h[1] / 255) * 2 - 1) * base.spread;
  return {
    latitude: Math.round((base.lat + jLat) * 1e6) / 1e6,
    longitude: Math.round((base.lon + jLon) * 1e6) / 1e6,
    accuracy: 25 + (h[4] % 45),
  };
}

/** 经代理探测出口地理信息，并自动对齐环境的时区、语言与经纬度 */
async function syncProfileGeoFromProxy(profileId) {
  const p = store.get(profileId);
  if (!p) throw new Error('环境不存在：' + profileId);
  const px = p.proxy || {};
  if (px.type === 'none' || !px.host || !px.port) {
    throw new Error('这个环境没有配置代理');
  }
  const r = await testProxy({
    type: px.type,
    host: px.host,
    port: px.port,
    username: px.username,
    password: px.password,
  });
  if (!r.ok) {
    throw new Error(r.error || '代理测试失败');
  }
  const loc = countryToLocale(r.countryCode);
  const patch = {
    locale: loc.locale,
    languages: loc.languages,
  };
  if (r.timezone) patch.timezone = r.timezone;
  if (typeof r.lat === 'number' && typeof r.lon === 'number') {
    patch.geo = { lat: r.lat, lon: r.lon, ip: r.ip };
  } else if (r.ip) {
    patch.geo = { ...(p.geo || {}), ip: r.ip };
  }
  const updated = store.update(profileId, patch);
  return { profile: updated, proxy: r };
}

/** 读取并校验注入脚本，把 __CFG__ 替换成该环境的指纹参数 */
function buildInjectionSource(profile) {
  const tpl = runtime.readAsset('src/fp/patch.js');
  if (!tpl) throw new Error('找不到注入脚本 src/fp/patch.js（打包时漏了？）');
  const nonce = crypto.randomBytes(16).toString('hex');
  const cfg = buildConfig(profile, nonce);
  // 用函数式替换：JSON 里若出现 $& / $1 之类，字符串替换会被当成替换模式
  const src = tpl.replace('__CFG__', () => JSON.stringify(cfg));
  // 占位符必须被完全替换掉，否则注入脚本会抛 ReferenceError 并静默失效
  if (src.includes('__CFG__')) {
    throw new Error('注入脚本的配置占位符没有被替换（检查 fp/patch.js 里是否还有多余的占位符）');
  }
  // 语法自检：坏脚本要在这里就报出来，而不是等用户打开网页才发现
  new Function(src);
  return src;
}

/* ------------------------------- DevTools 端口 ------------------------------- */

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function validDevToolsEndpoint(value, expectedPort) {
  try {
    const endpoint = new URL(value);
    if (
      endpoint.protocol === 'ws:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) &&
      Number(endpoint.port) === expectedPort &&
      /^\/devtools\/browser\/[^/]+$/.test(endpoint.pathname)
    ) {
      return endpoint.href;
    }
  } catch {
    /* ignore malformed endpoint */
  }
  return '';
}

function devToolsEndpoint(logPath, startOffset, expectedPort) {
  let fd;
  try {
    fd = fs.openSync(logPath, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(startOffset, size - 131072);
    const buf = Buffer.alloc(Math.max(0, size - start));
    if (!buf.length) return '';
    fs.readSync(fd, buf, 0, buf.length, start);
    const output = buf.toString('utf8');
    const matches = output.matchAll(/DevTools listening on (ws:\/\/[^\s]+)/g);
    for (const match of matches) {
      const endpoint = validDevToolsEndpoint(match[1], expectedPort);
      if (endpoint) return endpoint;
    }
    return '';
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function devToolsPortConflict(logPath, startOffset) {
  let fd;
  try {
    fd = fs.openSync(logPath, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(startOffset, size - 65536);
    const buf = Buffer.alloc(Math.max(0, size - start));
    if (buf.length) fs.readSync(fd, buf, 0, buf.length, start);
    return /address already in use|eaddrinuse|failed to bind.*(?:debug|port)|cannot bind.*(?:debug|port)/i.test(buf.toString('utf8'));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

async function waitForDevTools(proc, timeoutMs = 25000, knownPort = 0, logPath = '', logOffset = 0) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (logPath && devToolsPortConflict(logPath, logOffset)) {
      const error = new Error('DevTools port is already in use');
      error.code = 'DEVTOOLS_PORT_CONFLICT';
      throw error;
    }
    if (proc.exitCode !== null) throw new Error('浏览器启动后立即退出（exit ' + proc.exitCode + '）');
    if (knownPort) {
      const wsUrl = logPath && devToolsEndpoint(logPath, logOffset, knownPort);
      if (wsUrl) {
        await sleep(120);
        return { port: knownPort, wsUrl };
      }
    }
    await sleep(120);
  }
  throw new Error('等待 DevTools 端口超时，Chrome 可能启动失败（看 data/logs 里的日志）');
}

async function killAndWait(proc, timeoutMs = 1000) {
  if (!proc || !proc.pid) return;
  const exited = new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode) return resolve();
    proc.once('exit', resolve);
  });
  await killTree(proc.pid);
  await Promise.race([exited, sleep(timeoutMs)]);
}

async function spawnBrowserWithPortRetry(chromePath, args, logPath, logFd, initialPort) {
  let port = initialPort;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) port = await freePort();
    const logOffset = fs.fstatSync(logFd).size;
    const attemptArgs = args.map((arg) =>
      String(arg).startsWith('--remote-debugging-port=') ? '--remote-debugging-port=' + port : arg
    );
    const proc = spawn(chromePath, attemptArgs, {
      stdio: ['ignore', 'ignore', logFd],
      detached: true,
      windowsHide: false,
    });
    proc.on('error', (e) => {
      try {
        fs.appendFileSync(logPath, '\n[spawn error] ' + e.message + '\n');
      } catch {
        /* ignore */
      }
    });

    try {
      const devtools = await waitForDevTools(proc, 25000, port, logPath, logOffset);
      return { proc, port, devtools };
    } catch (e) {
      if (e.code !== 'DEVTOOLS_PORT_CONFLICT' || attempt === 2) {
        await killAndWait(proc);
        throw e;
      }
      await killAndWait(proc);
    }
  }
  throw new Error('DevTools port allocation retries exhausted');
}

/* --------------------------------- 会话接管 -------------------------------- */

function makeSessionPatcher(cdp, ctx) {
  return async function applySession(sessionId, targetInfo) {
    const type = targetInfo && targetInfo.type;
    const tid = targetInfo && targetInfo.targetId;
    const isWorker = type === 'worker' || type === 'shared_worker' || type === 'service_worker';
    if (type !== 'page' && type !== 'iframe' && !isWorker) return;

    if (isWorker) {
      await cdp.try_('Emulation.setUserAgentOverride', ctx.uaOverride, sessionId);
      await cdp.try_('Emulation.setTimezoneOverride', { timezoneId: ctx.timezone }, sessionId);
      await cdp.try_('Emulation.setLocaleOverride', { locale: ctx.locale }, sessionId);
      if (tid && !ctx.scripted.has(tid)) {
        const r = await cdp.try_('Runtime.evaluate', { expression: ctx.script }, sessionId);
        if (r !== null) ctx.scripted.add(tid);
      }
      await cdp.try_(
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
        sessionId
      );
      return;
    }

    await cdp.try_('Page.enable', {}, sessionId);
    await cdp.try_('Emulation.setUserAgentOverride', ctx.uaOverride, sessionId);
    await cdp.try_('Emulation.setTimezoneOverride', { timezoneId: ctx.timezone }, sessionId);
    await cdp.try_('Emulation.setLocaleOverride', { locale: ctx.locale }, sessionId);
    if (ctx.geo) {
      await cdp.try_('Emulation.setGeolocationOverride', ctx.geo, sessionId);
    }
    // 同一个 target 只挂一次注入脚本。
    // 幂等放在 Node 侧（而不是在页面里留一个 symbol 标记）——页面里任何标记
    // 都能被 Object.getOwnPropertySymbols(window) 一行枚举出来，等于自曝。
    if (tid && !ctx.scripted.has(tid)) {
      const r = await cdp.try_(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: ctx.script, runImmediately: true },
        sessionId
      );
      if (r !== null) ctx.scripted.add(tid);
    }
    if (type === 'page') {
      await cdp.try_('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
    }
    // 页面和跨域 iframe 里都可能继续创建子 iframe 或 Worker，统一挂上自动接管
    await cdp.try_(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      sessionId
    );
  };
}

/* ------------------------------ 实例注册表 ------------------------------ */
/**
 * data/instances.json 记录"哪个环境在哪个端口上跑着"。
 * 控制台重启后，浏览器进程还在，但内存里的 running 没了 —— 有这个表就能重新接管，
 * 而不是显示"已停止"、点启动还卡 25 秒超时。
 */
const REGISTRY_FILE = path.join(store.DATA, 'instances.json');

function readRegistry() {
  try {
    const db = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    return db && typeof db === 'object' ? db : {};
  } catch {
    return {};
  }
}

function writeRegistry(db) {
  try {
    fs.mkdirSync(store.DATA, { recursive: true });
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

function remember(inst) {
  const db = readRegistry();
  db[inst.profileId] = {
    pid: inst.proc ? inst.proc.pid : null,
    port: inst.port,
    wsUrl: inst.wsUrl || null,
    startedAt: inst.startedAt,
    chromePath: inst.chromePath,
    relayPort: inst.relay ? inst.relay.port : inst.relayPortHint || null,
  };
  writeRegistry(db);
}

function forget(profileId) {
  const db = readRegistry();
  if (!db[profileId]) return;
  delete db[profileId];
  writeRegistry(db);
}

function cleanupInstance(inst) {
  running.delete(inst.profileId);
  forget(inst.profileId);
  if (inst.relay) {
    try {
      Promise.resolve(inst.relay.close()).catch(() => {});
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------ 目标挂载工具 ------------------------------ */

/** 统一挂上 autoAttach 的事件处理（launch 与 reattach 共用） */
function wireTargetHandlers(cdp, instance, applySession) {
  cdp.on('Target.attachedToTarget', async (params) => {
    const { sessionId, targetInfo, waitingForDebugger } = params;
    if (targetInfo && targetInfo.targetId) instance.sessions.set(targetInfo.targetId, sessionId);
    try {
      await applySession(sessionId, targetInfo);
    } catch {
      /* 单个 target 失败不影响整体 */
    }
    if (waitingForDebugger) {
      try {
        await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
      } catch {
        /* ignore */
      }
    }
  });
  cdp.on('Target.detachedFromTarget', ({ sessionId, targetId }) => {
    for (const [tid, sid] of instance.sessions) {
      if (sid === sessionId) {
        instance.sessions.delete(tid);
        instance.scripted.delete(tid);
      }
    }
    if (targetId) instance.scripted.delete(targetId);
  });
}

/** 接管已经存在的页面和 Worker，返回主页面 session */
async function attachExistingPages(cdp, instance, applySession) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const targets = targetInfos.filter(
    (t) =>
      t.type === 'page' ||
      t.type === 'worker' ||
      t.type === 'shared_worker' ||
      t.type === 'service_worker'
  );
  let mainSession = null;
  for (const t of targets) {
    try {
      const r = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      instance.sessions.set(t.targetId, r.sessionId);
      await applySession(r.sessionId, t);
      if (!mainSession && t.type === 'page') mainSession = r.sessionId;
    } catch {
      /* ignore */
    }
  }
  return mainSession;
}

/* -------------------------- 控制台重启后的重接管 -------------------------- */

/**
 * 扫描注册表，把还活着的浏览器重新接回 CDP。
 * 代理中继是随 Node 进程一起没的，所以尽量在原端口上重新拉起来（Chrome 的命令行还指着那个端口）。
 */
async function reattach() {
  const db = readRegistry();
  const ids = Object.keys(db);
  if (!ids.length) return [];

  const revived = [];
  for (const id of ids) {
    const meta = db[id] || {};
    const profile = store.get(id);
    if (!profile) {
      forget(id);
      continue;
    }

    // 优先使用本次启动时从浏览器进程日志确认的 endpoint。
    const expectedPort = Number(meta.port) || 0;
    let wsUrl = validDevToolsEndpoint(meta.wsUrl, expectedPort);
    let port = expectedPort;
    if (!wsUrl) {
      try {
        const lines = fs
          .readFileSync(path.join(store.profileDir(id), 'DevToolsActivePort'), 'utf8')
          .split('\n')
          .map((s) => s.trim());
        const activePort = parseInt(lines[0], 10) || 0;
        if (activePort > 0 && lines[1]) {
          wsUrl = validDevToolsEndpoint('ws://127.0.0.1:' + activePort + lines[1], activePort);
          if (wsUrl) port = activePort;
        }
      } catch {
        /* older fixed-port profiles may not have DevToolsActivePort */
      }
    }
    if (!wsUrl && expectedPort) {
      wsUrl = devToolsEndpoint(path.join(store.DATA, 'logs', id + '.log'), 0, expectedPort);
      if (wsUrl) port = expectedPort;
    }
    if (!wsUrl) {
      forget(id);
      continue;
    }

    let cdp = null;
    try {
      cdp = await CDP.connect(wsUrl, 3000);
    } catch {
      forget(id);
      continue;
    }

    try {
      const ver = await cdp.send('Browser.getVersion');
      const product = (ver && ver.product) || '';
      const fullVersion = (product.split('/')[1] || '').trim();

      let relay = null;
      const proxy = profile.proxy || {};
      if (proxy.type !== 'none' && proxy.host && proxy.port) {
        try {
          relay = await createRelay(
            {
              type: proxy.type,
              host: proxy.host,
              port: proxy.port,
              username: proxy.username,
              password: proxy.password,
            },
            { port: meta.relayPort || 0 }
          );
        } catch {
          relay = null; // 端口被占/上游不通：浏览器至少还能被接管、被关闭
        }
      }

      const hints = await getRealHints(cdp, product);
      const ua = buildUserAgent(profile, fullVersion, hints);
      const cfg = buildConfig(profile);
      const instance = {
        profileId: id,
        // 假 proc：只需要 pid 供 stop() 杀进程
        proc: { pid: meta.pid || null, exitCode: null, on() {} },
        relay,
        startedAt: meta.startedAt || Date.now(),
        logPath: path.join(store.DATA, 'logs', id + '.log'),
        chromePath: meta.chromePath || '',
        cdp,
        port,
        wsUrl,
        browserVersion: fullVersion,
        sessions: new Map(),
        scripted: new Set(),
        ua,
        reattached: true,
      };

      const ctx = {
        uaOverride: {
          userAgent: ua,
          acceptLanguage: (profile.languages || ['zh-CN']).join(','),
          platform: (PLATFORM_UA[profile.platform] || PLATFORM_UA.win).nav,
          userAgentMetadata: buildUaMetadata(profile, fullVersion, hints),
        },
        timezone: profile.timezone || 'Asia/Shanghai',
        locale: profile.locale || 'zh-CN',
        geo: resolveGeolocation(profile),
        script: buildInjectionSource(profile),
        scripted: instance.scripted,
      };
      const applySession = makeSessionPatcher(cdp, ctx);

      instance.__script = ctx.script;
      instance.__uaOverride = ctx.uaOverride;
      instance.__tz = ctx.timezone;
      instance.__locale = ctx.locale;
      instance.__geo = ctx.geo;
      instance.__expect = {
        hardwareConcurrency: cfg.hardwareConcurrency,
        deviceMemory: cfg.deviceMemory,
        screenWidth: cfg.screen.width,
        pixelRatio: cfg.screen.pixelRatio,
      };

      cdp.on('close', () => cleanupInstance(instance));
      wireTargetHandlers(cdp, instance, applySession);
      await cdp.try_('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });
      instance.mainSession = await attachExistingPages(cdp, instance, applySession);

      running.set(id, instance);
      // relay 没抢回端口时保留原记录，下次重启还可以再试
      if (!instance.relay && meta.relayPort) instance.relayPortHint = meta.relayPort;
      remember(instance);
      revived.push(publicInfo(instance));
    } catch (e) {
      try {
        cdp.close();
      } catch {
        /* ignore */
      }
      console.warn('[launch] 接管环境 ' + id + ' 失败，已从注册表移除：' + (e && e.message ? e.message : e));
      forget(id);
    }
  }
  return revived;
}

/* ---------------------------------- 启动 ---------------------------------- */

async function launch(profileId, options = {}) {
  let profile = store.get(profileId);
  if (!profile) throw new Error('环境不存在：' + profileId);
  if (running.has(profileId)) {
    const inst = running.get(profileId);
    return { ...publicInfo(inst), alreadyRunning: true };
  }

  const chromePath = options.chromePath || findBrowser();
  if (!chromePath) {
    throw new Error(
      '没找到 Chromium 内核浏览器。装 Chrome/Edge，或用 FB_BROWSER 环境变量指定 chrome.exe 路径'
    );
  }
  assertProfileConfig(profile);

  let proxy = profile.proxy || {};
  let useProxy = proxy.type !== 'none' && proxy.host && proxy.port;
  if ((options.autoGeo || profile.autoGeo) && useProxy) {
    try {
      await syncProfileGeoFromProxy(profileId);
      profile = store.get(profileId);
      proxy = profile.proxy || {};
      useProxy = proxy.type !== 'none' && proxy.host && proxy.port;
    } catch (e) {
      throw new Error('代理不可用，无法自动同步地区：' + (e && e.message ? e.message : e));
    }
  }

  const userDataDir = store.profileDir(profileId);
  fs.mkdirSync(userDataDir, { recursive: true });
  ensureChromeProfileName(userDataDir, profile.name);
  const logDir = path.join(store.DATA, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, profileId + '.log');

  // 清掉上次残留，否则可能读到旧端口
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  try {
    fs.rmSync(portFile, { force: true });
  } catch {
    /* ignore */
  }

  const S = store.normalizeScreen(profile.screen || {}, profile.platform || 'win');
  const screenW = S.width;
  const screenH = S.height;

  /* 1. 代理中继 */
  let relay = null;
  if (useProxy) {
    relay = await createRelay({
      type: proxy.type,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username,
      password: proxy.password,
    });
  }

  // 固定端口。写 0 的话 Chrome 会打开 AutomationControlled，navigator.webdriver 变成 true
  const debugPort = await freePort();

  // 按环境 seed 生成轻微窗口偏移，避免多开窗口全部堆在 (0,0) 重叠或 screenX/Y 恒为 0
  const posHash = crypto.createHash('sha256').update(String(profile.seed || profileId)).digest();
  const posX = 24 + (posHash[2] % 96);
  const posY = 20 + (posHash[3] % 64);

  /* 2. 组装参数 */
  const args = [
    '--user-data-dir=' + userDataDir,
    '--remote-debugging-port=' + debugPort,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    // 不要加 --disable-blink-features=AutomationControlled。
    // 那个参数会出黄条，Google 登录直接拒。也不要用 JS 覆写 webdriver：
    // 原生值已经是 false，假 getter 会被跨 realm 的 toString 识破。
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--window-size=' + Math.round(screenW * 0.86) + ',' + Math.round(screenH * 0.86),
    '--window-position=' + posX + ',' + posY,
    '--lang=' + (profile.languages && profile.languages[0] ? profile.languages[0] : 'zh-CN'),
  ];
  if (profile.platform === 'mac' || profile.platform === 'linux') {
    args.push('--enable-features=OverlayScrollbar');
  }
  if (relay) {
    args.push('--proxy-server=http://127.0.0.1:' + relay.port);
    // 禁止 Chrome 绕过代理做本地 DNS 解析，彻底防止 DNS 泄漏
    args.push('--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1 , EXCLUDE localhost');
  }
  if (relay || (profile.webrtc || 'proxy') !== 'real') {
    // 禁止 WebRTC 走非代理的 UDP，避免真实 IP 泄露
    args.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
  }
  if (profile.webrtc === 'disabled') {
    args.push('--enforce-webrtc-ip-permission-check');
  }
  args.push('about:blank');

  /* 3. 启动 */
  try {
    const st = fs.statSync(logPath);
    if (st.size > 2 * 1024 * 1024) {
      const fd = fs.openSync(logPath, 'r');
      try {
        const keep = 256 * 1024;
        const buf = Buffer.alloc(keep);
        const readBytes = fs.readSync(fd, buf, 0, keep, st.size - keep);
        fs.writeFileSync(logPath, buf.subarray(0, readBytes));
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    /* 日志不存在或截断失败不影响启动 */
  }
  const logFd = fs.openSync(logPath, 'a');
  let started;
  try {
    started = await spawnBrowserWithPortRetry(chromePath, args, logPath, logFd, debugPort);
  } catch (e) {
    try {
      fs.closeSync(logFd);
    } catch {
      /* ignore */
    }
    if (relay) {
      try {
        await relay.close();
      } catch {
        /* ignore */
      }
    }
    throw e;
  }
  const { proc, port, devtools } = started;

  const instance = {
    profileId,
    proc,
    relay,
    startedAt: Date.now(),
    logPath,
    chromePath,
    cdp: null,
    port,
    wsUrl: devtools.wsUrl,
    browserVersion: '',
    sessions: new Map(),
    scripted: new Set(), // 已经挂过注入脚本的 targetId（Node 侧幂等，页面里不留标记）
    ua: '',
  };
  running.set(profileId, instance);

  const cleanup = () => cleanupInstance(instance);

  try {
    /* 4. 连上 DevTools */
    const cdp = await CDP.connect(devtools.wsUrl);
    instance.cdp = cdp;
    // 先登记再接管：万一后面某步抛错，stop() 能把登记一起清掉
    remember(instance);

    cdp.on('close', () => cleanup());
    proc.on('exit', () => cleanup());

    /* 5. 拿真实 Chrome 版本 + 浏览器自己报的 UA-CH，拼 UA —— 版本/品牌都跟内核一致，不做"假版本" */
    const ver = await cdp.send('Browser.getVersion');
    const product = ver.product || '';
    const fullVersion = (product.split('/')[1] || '141.0.0.0').trim();
    assertProfileConfig(profile, fullVersion);
    instance.browserVersion = fullVersion;

    // 必须在任何 setUserAgentOverride 之前读，否则读到的是我们自己伪造的值
    const hints = await getRealHints(cdp, product);

    const ua = buildUserAgent(profile, fullVersion, hints);
    const uaOverride = {
      userAgent: ua,
      acceptLanguage: (profile.languages || ['zh-CN']).join(','),
      platform: (PLATFORM_UA[profile.platform] || PLATFORM_UA.win).nav,
      userAgentMetadata: buildUaMetadata(profile, fullVersion, hints),
    };

    const cfg = buildConfig(profile);
    const ctx = {
      uaOverride,
      timezone: profile.timezone || 'Asia/Shanghai',
      locale: profile.locale || 'zh-CN',
      geo: resolveGeolocation(profile),
      script: buildInjectionSource(profile),
      scripted: instance.scripted,
    };
    instance.ua = ua;
    // 供 probe() 在临时标签页里复用同一套覆写
    instance.__script = ctx.script;
    instance.__uaOverride = uaOverride;
    instance.__tz = ctx.timezone;
    instance.__locale = ctx.locale;
    instance.__geo = ctx.geo;
    // probe 用这几个值交叉验证"补丁到底生没生效"（页面里不再留 symbol 标记）
    instance.__expect = {
      hardwareConcurrency: cfg.hardwareConcurrency,
      deviceMemory: cfg.deviceMemory,
      screenWidth: cfg.screen.width,
      pixelRatio: cfg.screen.pixelRatio,
    };

    /* 6. 接管已有页面 */
    const applySession = makeSessionPatcher(cdp, ctx);

    // 先挂自动接管，再逐个处理已存在的页面，避免漏掉加载中的 iframe
    wireTargetHandlers(cdp, instance, applySession);
    await cdp.try_('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    const mainSession = await attachExistingPages(cdp, instance, applySession);
    instance.mainSession = mainSession;

    /* 7. 打开起始页（此时补丁与覆写已就位） */
    const startUrl = options.startUrl || profile.startUrl || 'about:blank';
    if (mainSession && startUrl && startUrl !== 'about:blank') {
      await cdp.try_('Page.navigate', { url: startUrl }, mainSession);
    }

    try {
      store.update(profileId, { lastLaunchedAt: new Date().toISOString() });
    } catch {
      /* ignore */
    }
    return publicInfo(instance);
  } catch (e) {
    await stop(profileId);
    throw e;
  } finally {
    try {
      fs.closeSync(logFd);
    } catch {
      /* ignore */
    }
  }
}

/* --------------------------------- 关闭 ---------------------------------- */

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    try {
      if (process.platform === 'win32') {
        const p = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
        p.on('exit', () => resolve());
        p.on('error', () => resolve());
      } else {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* ignore */
          }
        }
        resolve();
      }
    } catch {
      resolve();
    }
  });
}

async function stop(profileId) {
  const inst = running.get(profileId);
  if (!inst) {
    // 不在内存里，但注册表里可能有（比如刚重启还没 reattach），顺手清掉
    forget(profileId);
    return false;
  }
  running.delete(profileId);
  forget(profileId);
  try {
    if (inst.cdp) inst.cdp.close();
  } catch {
    /* ignore */
  }
  if (inst.proc && inst.proc.pid) await killTree(inst.proc.pid);
  if (inst.relay) {
    try {
      await inst.relay.close();
    } catch {
      /* ignore */
    }
  }
  return true;
}

async function stopAll() {
  const ids = [...running.keys()];
  await Promise.all(ids.map((id) => stop(id)));
  return ids;
}

/* -------------------------------- 状态查询 -------------------------------- */

function publicInfo(inst) {
  return {
    profileId: inst.profileId,
    pid: inst.proc ? inst.proc.pid : null,
    devtoolsPort: inst.port,
    browserVersion: inst.browserVersion,
    chromePath: inst.chromePath,
    startedAt: inst.startedAt,
    ua: inst.ua,
    logPath: inst.logPath,
  };
}

function getInstance(profileId) {
  return running.get(profileId) || null;
}

function getRunning(profileId) {
  const inst = running.get(profileId);
  return inst ? publicInfo(inst) : null;
}

function listRunning() {
  return [...running.values()].map(publicInfo);
}

/* ------------------------------ 指纹实时检测 ------------------------------ */

const PROBE_EXPR = `(async () => {
  const EXPECT = __EXPECT__;
  const out = {};
  // 注入脚本是否真的生效：拿几个只能由补丁产生的值交叉验证。
  // 以前这里是查 window 上的 Symbol(fb.<seed>)，那等于把检测方法教给站点。
  out.injected = navigator.hardwareConcurrency === EXPECT.hardwareConcurrency &&
    navigator.deviceMemory === EXPECT.deviceMemory &&
    screen.width === EXPECT.screenWidth &&
    window.devicePixelRatio === EXPECT.pixelRatio;
  out.secureContext = window.isSecureContext;
  out.userAgent = navigator.userAgent;
  out.platform = navigator.platform;
  out.languages = navigator.languages;
  out.hardwareConcurrency = navigator.hardwareConcurrency;
  out.deviceMemory = navigator.deviceMemory;
  out.webdriver = navigator.webdriver;
  out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  out.locale = Intl.DateTimeFormat().resolvedOptions().locale;
  out.screen = {
    width: screen.width, height: screen.height,
    availWidth: screen.availWidth, availHeight: screen.availHeight,
    colorDepth: screen.colorDepth, dpr: window.devicePixelRatio
  };
  try {
    const c = document.createElement('canvas');
    c.width = 220; c.height = 40;
    const ctx = c.getContext('2d');
    ctx.textBaseline = 'top'; ctx.font = '14px Arial';
    ctx.fillStyle = '#f60'; ctx.fillRect(0, 0, 120, 20);
    ctx.fillStyle = '#069'; ctx.fillText('fingerprint-abc-123', 2, 4);
    const d = ctx.getImageData(0, 0, 220, 40).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s = (s * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13) >>> 0;
    out.canvasHash = s;
    out.canvasTail = c.toDataURL().slice(-48);
  } catch (e) { out.canvasError = String(e); }
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    out.webglVendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(0x1f00);
    out.webglRenderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(0x1f01);
    out.glMaxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  } catch (e) { out.webglError = String(e); }
  // 字体探测：声明平台里不该有的字体必须查不到（白名单在注入脚本里）
  try {
    out.fontCheck = {
      arial: document.fonts.check('12px Arial'),
      yahei: document.fonts.check('12px "Microsoft YaHei"'),
      missing: document.fonts.check('12px "__fb_missing_font__"')
    };
  } catch (e) { out.fontError = String(e); }
  // WebGPU：真机上会暴露真实 GPU 家族，是"设备级"标识里最硬的一个
  try {
    if (navigator.gpu) {
      const a = await navigator.gpu.requestAdapter();
      if (a && a.info) {
        out.gpuVendor = a.info.vendor;
        out.gpuArch = a.info.architecture;
      }
    }
  } catch (e) { out.gpuError = String(e); }
  // 语音合成设备：Windows 是 Microsoft SAPI，macOS 是 Samantha/Ting-Ting 那一套
  try {
    let vs = speechSynthesis.getVoices();
    if (!vs.length) { await new Promise(r => setTimeout(r, 500)); vs = speechSynthesis.getVoices(); }
    out.speechVoiceCount = vs.length;
    out.speechVoices = vs.slice(0, 6).map(v => v.name);
    out.speechHasMicrosoft = vs.some(v => String(v.name).indexOf('Microsoft ') === 0);
    out.speechHasMac = vs.some(v => /^(Samantha|Alex|Victoria|Daniel|Ting-Ting|Meijia|Karen|Sin-ji|Kyoko|Anna|Thomas)$/.test(String(v.name)));
  } catch (e) { out.speechError = String(e); }
  try {
    const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (AC) {
      const ac = new AC(1, 44100, 44100);
      const osc = ac.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 10000;
      const comp = ac.createDynamicsCompressor();
      osc.connect(comp); comp.connect(ac.destination);
      osc.start(0);
      const buf = await ac.startRendering();
      const ch = buf.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < ch.length; i++) sum += Math.abs(ch[i]);
      out.audioHash = Math.round(sum * 1e10) / 1e10;
    }
  } catch (e) { out.audioError = String(e); }

  // 健康体检：交叉核验多开防关联关键指标
  try {
    const health = {};
    try {
      const wCode = [
        'const r = { hc: navigator.hardwareConcurrency, gpu: null };',
        'try { const oc = new OffscreenCanvas(16, 16); const gl = oc.getContext("webgl"); const ext = gl && gl.getExtension("WEBGL_debug_renderer_info"); r.gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null; } catch {}',
        'postMessage(r);',
      ].join('\\n');
      const wRes = await new Promise((resolve) => {
        const w = new Worker(URL.createObjectURL(new Blob([wCode], { type: 'application/javascript' })));
        const t = setTimeout(() => resolve(null), 2000);
        w.onmessage = (e) => { clearTimeout(t); w.terminate(); resolve(e.data); };
        w.onerror = () => { clearTimeout(t); resolve(null); };
      });
      health.workerConsistent = !!(
        wRes &&
        wRes.hc === out.hardwareConcurrency &&
        (!out.webglRenderer || wRes.gpu === out.webglRenderer)
      );
    } catch { health.workerConsistent = false; }

    try {
      const ifr = document.createElement('iframe');
      document.body.appendChild(ifr);
      const s = ifr.contentWindow.Function.prototype.toString.call(HTMLCanvasElement.prototype.toDataURL);
      ifr.remove();
      health.iframeToStringClean = typeof s === 'string' && s.indexOf('[native code]') >= 0;
    } catch { health.iframeToStringClean = false; }

    try {
      const d = Object.getOwnPropertyDescriptor(Navigator.prototype, 'hardwareConcurrency');
      let threw = false;
      try { d.get.call({}); } catch (err) { threw = err instanceof TypeError; }
      health.illegalInvocationClean = threw;
    } catch { health.illegalInvocationClean = false; }

    try {
      const sc = document.createElement('canvas');
      sc.width = 8; sc.height = 8;
      const sctx = sc.getContext('2d');
      sctx.fillStyle = '#123456';
      sctx.fillRect(0, 0, 8, 8);
      const sd = sctx.getImageData(0, 0, 8, 8).data;
      let dirty = 0;
      for (let i = 0; i < sd.length; i += 4) {
        if (sd[i] !== 0x12 || sd[i + 1] !== 0x34 || sd[i + 2] !== 0x56) dirty++;
      }
      health.canvasSolidClean = dirty === 0;
    } catch { health.canvasSolidClean = false; }

    try {
      if (!navigator.userAgentData) {
        health.uaChConsistent = true;
      } else {
        const hv = await navigator.userAgentData.getHighEntropyValues(['brands', 'fullVersionList']);
        health.uaChConsistent = Array.isArray(hv.brands) && Array.isArray(hv.fullVersionList) && hv.brands.length === hv.fullVersionList.length;
      }
    } catch { health.uaChConsistent = false; }

    out.health = health;
  } catch {}

  return JSON.stringify(out);
})()`;

/**
 * 在运行中的环境里开一个临时标签页执行任意表达式，跑完关掉。
 * probe() 就是基于它实现的；也方便排查"到底哪一层没生效"。
 */
async function evaluateInProbePage(profileId, expression) {
  const inst = running.get(profileId);
  if (!inst || !inst.cdp) throw new Error('环境未运行');
  const cdp = inst.cdp;

  const url = await ensureProbePage();

  // 新标签页先落在 about:blank，而 UA/时区覆盖只对"之后的新文档"生效；
  // 所以这里不能直接读指纹，必须自己显式覆写后再导航到检测页。
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  try {
    let sessionId = inst.sessions.get(targetId);
    const t0 = Date.now();
    while (!sessionId && Date.now() - t0 < 4000) {
      await sleep(50);
      sessionId = inst.sessions.get(targetId);
    }
    if (!sessionId) {
      const r = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      sessionId = r.sessionId;
      await cdp.try_('Page.enable', {}, sessionId);
    }

    // 显式覆写（和 autoAttach 里做的是同一套，重复设置同样的值无害）
    await cdp.try_('Page.enable', {}, sessionId);
    await cdp.try_('Emulation.setUserAgentOverride', inst.__uaOverride || {}, sessionId);
    await cdp.try_('Emulation.setTimezoneOverride', { timezoneId: inst.__tz || 'Asia/Shanghai' }, sessionId);
    await cdp.try_('Emulation.setLocaleOverride', { locale: inst.__locale || 'zh-CN' }, sessionId);
    if (inst.__geo) {
      await cdp.try_('Emulation.setGeolocationOverride', inst.__geo, sessionId);
    }

    // 注入脚本由 autoAttach 统一挂；这里只等它挂好（重复注入会让补丁叠加，指纹就变了）
    const t2 = Date.now();
    while (!inst.scripted.has(targetId) && Date.now() - t2 < 2000) await sleep(30);
    if (!inst.scripted.has(targetId)) {
      const r = await cdp.try_(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: inst.__script || '', runImmediately: true },
        sessionId
      );
      if (r !== null) inst.scripted.add(targetId);
    }

    // 导航到 localhost（安全上下文），并等真正的 load 事件
    let loaded = false;
    const onLoad = (params, sid) => {
      if (sid === sessionId) loaded = true;
    };
    cdp.on('Page.loadEventFired', onLoad);
    await cdp.send('Page.navigate', { url }, sessionId);
    const t1 = Date.now();
    while (!loaded && Date.now() - t1 < 8000) await sleep(60);
    cdp.removeListener('Page.loadEventFired', onLoad);

    const res = await cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId
    );
    if (res.exceptionDetails) {
      throw new Error('检测脚本出错：' + (res.exceptionDetails.text || 'unknown'));
    }
    return res.result.value;
  } finally {
    try {
      await cdp.send('Target.closeTarget', { targetId });
    } catch {
      /* ignore */
    }
  }
}

/** 写入 Chrome Profile 显示名（防多开窗口串号，网页 JS 不可见） */
function ensureChromeProfileName(userDataDir, name) {
  if (!name) return;
  try {
    const defDir = path.join(userDataDir, 'Default');
    fs.mkdirSync(defDir, { recursive: true });
    const prefFile = path.join(defDir, 'Preferences');
    let prefs = {};
    if (fs.existsSync(prefFile)) {
      try {
        prefs = JSON.parse(fs.readFileSync(prefFile, 'utf8'));
      } catch {
        return; // Preferences 损坏或格式异常时宁可跳过，不覆盖用户其它浏览器数据
      }
    }
    if (!prefs || typeof prefs !== 'object') prefs = {};
    prefs.profile = { ...(prefs.profile && typeof prefs.profile === 'object' ? prefs.profile : {}), name: String(name) };
    const tmp = prefFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(prefs), 'utf8');
    fs.renameSync(tmp, prefFile);
  } catch {
    /* ignore */
  }
}

/** 运行态直接复用 CDP；已停止的环境则拉起临时 headless 读写 Cookies 后优雅关闭 */
async function withCookieCdp(profileId, fn) {
  const profile = store.get(profileId);
  if (!profile) throw new Error('环境不存在：' + profileId);
  const inst = running.get(profileId);
  if (inst && inst.cdp) {
    return await fn(inst.cdp);
  }

  const chromePath = findBrowser();
  if (!chromePath) {
    throw new Error('没找到 Chromium 内核浏览器');
  }
  const userDataDir = store.profileDir(profileId);
  fs.mkdirSync(userDataDir, { recursive: true });
  const port = await freePort();
  const logDir = path.join(store.DATA, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, profileId + '.log');
  const logFd = fs.openSync(logPath, 'a');
  const logOffset = fs.fstatSync(logFd).size;
  let proc = null;
  let cdp = null;
  try {
    proc = spawn(
      chromePath,
      [
        '--headless=new',
        '--user-data-dir=' + userDataDir,
        '--remote-debugging-port=' + port,
        '--remote-debugging-address=127.0.0.1',
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', logFd], windowsHide: true }
    );
    proc.on('error', (e) => {
      try { fs.appendFileSync(logPath, '\n[cookie browser spawn error] ' + e.message + '\n'); } catch {}
    });
    const { wsUrl } = await waitForDevTools(proc, 15000, port, logPath, logOffset);
    cdp = await CDP.connect(wsUrl, 8000);
    return await fn(cdp);
  } finally {
    if (cdp) {
      await cdp.try_('Browser.close');
      cdp.close();
    }
    if (proc) {
      await new Promise((resolve) => {
        if (proc.exitCode !== null) return resolve();
        const timer = setTimeout(resolve, 3000);
        proc.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (proc.exitCode === null && proc.pid) {
        await killTree(proc.pid);
      }
      await sleep(150);
    }
    try { fs.closeSync(logFd); } catch {}
  }
}

async function exportCookies(profileId) {
  const r = await withCookieCdp(profileId, (cdp) => cdp.send('Storage.getCookies'));
  const list = (r && Array.isArray(r.cookies) ? r.cookies : []).map((c) => {
    const item = { ...c };
    if (typeof item.expires === 'number' && item.expires > 0) {
      item.expirationDate = item.expires;
    }
    return item;
  });
  return list;
}

async function importCookies(profileId, input) {
  const cookies = parseCookiesInput(input);
  if (!cookies.length) throw new Error('没有可导入的合法 Cookie');
  await withCookieCdp(profileId, (cdp) => cdp.send('Storage.setCookies', { cookies }));
  return { imported: cookies.length };
}

/** 指纹检测：返回结构化的指纹报告 */
async function probe(profileId) {
  const inst = running.get(profileId);
  if (!inst) throw new Error('环境未运行');
  const expect = inst.__expect || {};
  const raw = await evaluateInProbePage(profileId, PROBE_EXPR.replace('__EXPECT__', () => JSON.stringify(expect)));
  return JSON.parse(raw);
}

module.exports = {
  launch,
  stop,
  stopAll,
  reattach,
  probe,
  evaluateInProbePage,
  exportCookies,
  importCookies,
  getInstance,
  getRunning,
  listRunning,
  buildInjectionSource,
  buildConfig,
  buildUserAgent,
  buildUaMetadata,
  resolveGeolocation,
  syncProfileGeoFromProxy,
  PLATFORM_UA,
};
