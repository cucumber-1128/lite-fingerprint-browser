'use strict';
/**
 * 启动一个指纹环境：
 *   独立 user-data-dir → 独立代理中继 → 启动本机 Chromium → CDP 原生层覆写 → 注入 JS 指纹补丁
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { CDP } = require('./cdp');
const { findBrowser } = require('./browser');
const { createRelay } = require('./proxy');
const store = require('./store');

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
async function ensureProbePage() {
  if (probeUrl) return probeUrl;
  const http = require('node:http');
  probeServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end('<!doctype html><meta charset="utf-8"><title>fingerprint probe</title><body></body>');
  });
  await new Promise((resolve) => probeServer.listen(0, '127.0.0.1', resolve));
  // unref：这个常驻的检测页服务不应该拖住 Node 进程退出
  probeServer.unref();
  probeUrl = 'http://127.0.0.1:' + probeServer.address().port + '/probe';
  return probeUrl;
}

/* ------------------------------- 指纹参数组装 ------------------------------- */

function buildUserAgent(profile, fullVersion) {
  if (profile.userAgentMode === 'custom' && profile.userAgentCustom) return profile.userAgentCustom;
  const p = PLATFORM_UA[profile.platform] || PLATFORM_UA.win;
  return (
    'Mozilla/5.0 (' +
    p.ua +
    ') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' +
    fullVersion +
    ' Safari/537.36'
  );
}

function buildUaMetadata(profile, fullVersion) {
  const p = PLATFORM_UA[profile.platform] || PLATFORM_UA.win;
  const major = String(fullVersion).split('.')[0];
  return {
    brands: [
      { brand: 'Google Chrome', version: major },
      { brand: 'Chromium', version: major },
      { brand: 'Not_A Brand', version: '24' },
    ],
    fullVersionList: [
      { brand: 'Google Chrome', version: fullVersion },
      { brand: 'Chromium', version: fullVersion },
      { brand: 'Not_A Brand', version: '24.0.0.0' },
    ],
    fullVersion,
    platform: p.chPlatform,
    platformVersion: p.chVersion,
    architecture: p.arch,
    model: '',
    mobile: false,
    bitness: p.bitness,
    wow64: false,
  };
}

/** 读取并校验注入脚本，把 __CFG__ 替换成该环境的指纹参数 */
function buildInjectionSource(profile, fullVersion) {
  const tpl = fs.readFileSync(PATCH_FILE, 'utf8');
  const REAL_PLATFORM = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform] || 'linux';
  const cfg = {
    seed: profile.seed || 'seed',
    platform: profile.platform || 'win',
    realPlatform: REAL_PLATFORM,
    hardwareConcurrency: Number(profile.hardwareConcurrency) || 8,
    deviceMemory: Number(profile.deviceMemory) || 8,
    maxTouchPoints: Number(profile.maxTouchPoints) || 0,
    screen: {
      width: Number(profile.screen && profile.screen.width) || 1920,
      height: Number(profile.screen && profile.screen.height) || 1080,
      availHeight: Number(profile.screen && profile.screen.availHeight) || 1040,
      colorDepth: Number(profile.screen && profile.screen.colorDepth) || 24,
      pixelRatio: Number(profile.screen && profile.screen.pixelRatio) || 1,
    },
    webglVendor: profile.webglVendor || 'Google Inc. (NVIDIA)',
    webglRenderer:
      profile.webglRenderer ||
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    canvasNoise: profile.canvasNoise !== false,
    audioNoise: profile.audioNoise !== false,
    textNoise: profile.textNoise !== false,
    rectNoise: profile.rectNoise === true,
    webrtc: profile.webrtc || 'proxy',
  };
  const src = tpl.replace('__CFG__', JSON.stringify(cfg));
  // 占位符必须被完全替换掉，否则注入脚本会抛 ReferenceError 并静默失效
  if (src.includes('__CFG__')) {
    throw new Error('注入脚本的配置占位符没有被替换（检查 fp/patch.js 里是否还有多余的占位符）');
  }
  // 语法自检：坏脚本要在这里就报出来，而不是等用户打开网页才发现
  new Function(src);
  return src;
}

/* ------------------------------- DevTools 端口 ------------------------------- */

async function waitForDevTools(userDataDir, proc, timeoutMs = 25000) {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (proc.exitCode !== null) throw new Error('浏览器启动后立即退出（exit ' + proc.exitCode + '）');
    try {
      const txt = fs.readFileSync(file, 'utf8');
      const lines = txt.split('\n').map((s) => s.trim());
      const port = parseInt(lines[0], 10);
      const wsPath = lines[1] || '';
      if (port > 0 && wsPath) {
        await sleep(120);
        return { port, wsUrl: 'ws://127.0.0.1:' + port + wsPath };
      }
    } catch {
      /* 还没生成，继续等 */
    }
    await sleep(120);
  }
  throw new Error('等待 DevTools 端口超时，Chrome 可能启动失败（看 data/logs 里的日志）');
}

/* --------------------------------- 会话接管 -------------------------------- */

function makeSessionPatcher(cdp, ctx) {
  return async function applySession(sessionId, targetInfo) {
    const type = targetInfo && targetInfo.type;
    if (type !== 'page' && type !== 'iframe') return;
    await cdp.try_('Page.enable', {}, sessionId);
    await cdp.try_('Emulation.setUserAgentOverride', ctx.uaOverride, sessionId);
    await cdp.try_('Emulation.setTimezoneOverride', { timezoneId: ctx.timezone }, sessionId);
    await cdp.try_('Emulation.setLocaleOverride', { locale: ctx.locale }, sessionId);
    await cdp.try_(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: ctx.script, runImmediately: true },
      sessionId
    );
    if (type === 'page') {
      await cdp.try_('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
      // 页面里的跨域 iframe 是独立 target，也要挂上自动接管
      await cdp.try_(
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
        sessionId
      );
    }
  };
}

/* ---------------------------------- 启动 ---------------------------------- */

async function launch(profileId, options = {}) {
  const profile = store.get(profileId);
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

  const userDataDir = store.profileDir(profileId);
  fs.mkdirSync(userDataDir, { recursive: true });
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

  const S = profile.screen || {};
  const screenW = Number(S.width) || 1920;
  const screenH = Number(S.height) || 1080;

  /* 1. 代理中继 */
  let relay = null;
  const proxy = profile.proxy || {};
  const useProxy = proxy.type !== 'none' && proxy.host && proxy.port;
  if (useProxy) {
    relay = await createRelay({
      type: proxy.type,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username,
      password: proxy.password,
    });
  }

  /* 2. 组装参数 */
  const args = [
    '--user-data-dir=' + userDataDir,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--window-size=' + Math.round(screenW * 0.86) + ',' + Math.round(screenH * 0.86),
    '--lang=' + (profile.languages && profile.languages[0] ? profile.languages[0] : 'zh-CN'),
  ];
  if (relay) {
    args.push('--proxy-server=http://127.0.0.1:' + relay.port);
    // 禁止 WebRTC 走非代理的 UDP，避免真实 IP 泄露
    args.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
  }
  args.push('about:blank');

  /* 3. 启动 */
  const logFd = fs.openSync(logPath, 'a');
  const proc = spawn(chromePath, args, {
    stdio: ['ignore', 'ignore', logFd],
    windowsHide: false,
  });
  proc.on('error', (e) => {
    try {
      fs.appendFileSync(logPath, '\n[spawn error] ' + e.message + '\n');
    } catch {
      /* ignore */
    }
  });

  const instance = {
    profileId,
    proc,
    relay,
    startedAt: Date.now(),
    logPath,
    chromePath,
    cdp: null,
    port: 0,
    browserVersion: '',
    sessions: new Map(),
  };
  running.set(profileId, instance);

  const cleanup = async () => {
    running.delete(profileId);
    if (relay) await relay.close();
  };

  try {
    /* 4. 连上 DevTools */
    const { port, wsUrl } = await waitForDevTools(userDataDir, proc);
    instance.port = port;
    const cdp = await CDP.connect(wsUrl);
    instance.cdp = cdp;

    cdp.on('close', () => {
      cleanup();
    });
    proc.on('exit', () => {
      cleanup();
    });

    /* 5. 拿真实 Chrome 版本，拼 UA —— 保证 UA 版本与内核一致，不做"假版本" */
    const ver = await cdp.send('Browser.getVersion');
    const product = ver.product || '';
    const fullVersion = (product.split('/')[1] || '141.0.0.0').trim();
    instance.browserVersion = fullVersion;

    const ua = buildUserAgent(profile, fullVersion);
    const uaOverride = {
      userAgent: ua,
      acceptLanguage: (profile.languages || ['zh-CN']).join(','),
      platform: (PLATFORM_UA[profile.platform] || PLATFORM_UA.win).nav,
      userAgentMetadata: buildUaMetadata(profile, fullVersion),
    };

    const ctx = {
      uaOverride,
      timezone: profile.timezone || 'Asia/Shanghai',
      locale: profile.locale || 'zh-CN',
      script: buildInjectionSource(profile, fullVersion),
    };
    instance.ua = ua;
    // 供 probe() 在临时标签页里复用同一套覆写
    instance.__script = ctx.script;
    instance.__uaOverride = uaOverride;
    instance.__tz = ctx.timezone;
    instance.__locale = ctx.locale;

    /* 6. 接管已有页面 */
    const applySession = makeSessionPatcher(cdp, ctx);
    const { targetInfos } = await cdp.send('Target.getTargets');
    const pages = targetInfos.filter((t) => t.type === 'page');

    // 先挂自动接管，再逐个处理已存在的页面，避免漏掉加载中的 iframe
    cdp.on('Target.attachedToTarget', async (params) => {
      const { sessionId, targetInfo, waitingForDebugger } = params;
      if (targetInfo && targetInfo.targetId) instance.sessions.set(targetInfo.targetId, sessionId);
      try {
        await applySession(sessionId, targetInfo);
      } catch (e) {
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
    cdp.on('Target.detachedFromTarget', ({ sessionId }) => {
      for (const [tid, sid] of instance.sessions) {
        if (sid === sessionId) instance.sessions.delete(tid);
      }
    });
    await cdp.try_('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });

    let mainSession = null;
    for (const t of pages) {
      try {
        const r = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        instance.sessions.set(t.targetId, r.sessionId);
        await applySession(r.sessionId, t);
        if (!mainSession) mainSession = r.sessionId;
      } catch {
        /* ignore */
      }
    }
    instance.mainSession = mainSession;

    /* 7. 打开起始页（此时补丁与覆写已就位） */
    const startUrl = options.startUrl || profile.startUrl || 'about:blank';
    if (mainSession && startUrl && startUrl !== 'about:blank') {
      await cdp.try_('Page.navigate', { url: startUrl }, mainSession);
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
  if (!inst) return false;
  running.delete(profileId);
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

function getRunning(profileId) {
  const inst = running.get(profileId);
  return inst ? publicInfo(inst) : null;
}

function listRunning() {
  return [...running.values()].map(publicInfo);
}

/* ------------------------------ 指纹实时检测 ------------------------------ */

const PROBE_EXPR = `(async () => {
  const out = {};
  // 注入脚本是否真的生效（Symbol 不会出现在 getOwnPropertyNames 里，很难被站点枚举）
  out.injected = Object.getOwnPropertySymbols(window).some(s => String(s).indexOf('Symbol(fb.') === 0);
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
    await cdp.try_(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: inst.__script || '' },
      sessionId
    );

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

/** 指纹检测：返回结构化的指纹报告 */
async function probe(profileId) {
  const raw = await evaluateInProbePage(profileId, PROBE_EXPR);
  return JSON.parse(raw);
}

module.exports = {
  launch,
  stop,
  stopAll,
  probe,
  evaluateInProbePage,
  getRunning,
  listRunning,
  buildInjectionSource,
  buildUserAgent,
  PLATFORM_UA,
};
