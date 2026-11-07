'use strict';
/** 环境（profile）配置存储：data/profiles.json + 每个环境独立的 user-data-dir */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
// 数据目录可用 FB_DATA 覆盖：测试、双开、放移动硬盘都用得上
const DATA = process.env.FB_DATA ? path.resolve(process.env.FB_DATA) : path.join(ROOT, 'data');
const FILE = path.join(DATA, 'profiles.json');
const PROFILE_ROOT = path.join(DATA, 'profiles');

/* ------------------------------ 指纹素材池 ------------------------------ */

const WEBGL_POOL = [
  ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (AMD)', 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (AMD)', 'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'],
];

// macOS 走 Metal，ANGLE 的字符串形态和 Windows 完全不同，混用会一眼假
const WEBGL_MAC = [
  ['Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)'],
  ['Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'],
  ['Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)'],
  ['Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics, OpenGL 4.1)'],
];

const SCREEN_POOL = [
  { width: 1920, height: 1080, colorDepth: 24, pixelRatio: 1 },
  { width: 2560, height: 1440, colorDepth: 24, pixelRatio: 1 },
  { width: 1600, height: 900, colorDepth: 24, pixelRatio: 1 },
  { width: 1440, height: 900, colorDepth: 24, pixelRatio: 1 },
  { width: 1366, height: 768, colorDepth: 24, pixelRatio: 1 },
  { width: 1536, height: 864, colorDepth: 24, pixelRatio: 1.25 },
];

const CPU_POOL = [4, 8, 8, 12, 16];
// deviceMemory 的规范上限就是 8，真 Chrome 永远不会报 16
const MEM_POOL = [4, 8, 8, 8];

const TIMEZONES = {
  'zh-CN': ['Asia/Shanghai'],
  'zh-TW': ['Asia/Taipei'],
  'en-US': ['America/New_York', 'America/Chicago', 'America/Los_Angeles'],
  'en-GB': ['Europe/London'],
  'ja-JP': ['Asia/Tokyo'],
  'de-DE': ['Europe/Berlin'],
};

/* --------------------------------- 工具 --------------------------------- */

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** 内存值归一化：deviceMemory 只可能是 1/2/4/8（上限 8），其余值按 8 处理 */
function clampMemory(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return 8;
  return Math.min(8, Math.max(1, n));
}

function uid() {
  return crypto.randomBytes(6).toString('hex');
}

function ensure() {
  fs.mkdirSync(PROFILE_ROOT, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({ version: 1, profiles: [] }, null, 2), 'utf8');
  }
}

function load() {
  ensure();
  let raw;
  try {
    raw = fs.readFileSync(FILE, 'utf8');
  } catch {
    return { version: 1, profiles: [] };
  }
  try {
    const db = JSON.parse(raw);
    if (!Array.isArray(db.profiles)) db.profiles = [];
    return db;
  } catch (e) {
    // 坏文件先备份再放空库：否则下一次 save 会把所有环境覆盖掉
    const backup = FILE + '.corrupt-' + Date.now();
    try {
      fs.copyFileSync(FILE, backup);
    } catch {
      /* ignore */
    }
    console.warn('[store] profiles.json 解析失败，已备份到 ' + backup + '：' + e.message);
    return { version: 1, profiles: [] };
  }
}

function save(db) {
  ensure();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

/** 生成一套随机但自洽的指纹 */
function randomFingerprint(platform) {
  const plat = platform || pick(['win', 'win', 'win', 'mac']);
  // 必须拷贝：下面会按平台改写屏幕，直接改池子里的对象会污染后续所有环境
  const screen = { ...pick(SCREEN_POOL) };
  const gl = pick(plat === 'mac' ? WEBGL_MAC : WEBGL_POOL);
  const locale = plat === 'mac' ? pick(['en-US', 'zh-CN']) : pick(['zh-CN', 'zh-CN', 'en-US']);
  const langMap = {
    'zh-CN': ['zh-CN', 'zh', 'en-US', 'en'],
    'en-US': ['en-US', 'en'],
    'en-GB': ['en-GB', 'en'],
    'ja-JP': ['ja-JP', 'ja', 'en-US', 'en'],
    'de-DE': ['de-DE', 'de', 'en-US', 'en'],
    'zh-TW': ['zh-TW', 'zh', 'en-US', 'en'],
  };
  if (plat === 'mac') {
    screen.width = 1728;
    screen.height = 1117;
    screen.pixelRatio = 2;
  }
  return {
    platform: plat,
    languages: langMap[locale] || langMap['en-US'],
    locale,
    timezone: pick(TIMEZONES[locale] || ['Asia/Shanghai']),
    screen: {
      width: screen.width,
      height: screen.height,
      availHeight: screen.height - (plat === 'mac' ? 25 : 40),
      colorDepth: screen.colorDepth,
      pixelRatio: screen.pixelRatio,
    },
    hardwareConcurrency: pick(CPU_POOL),
    deviceMemory: pick(MEM_POOL),
    webglVendor: gl[0],
    webglRenderer: gl[1],
    seed: crypto.randomBytes(8).toString('hex'),
  };
}

function defaults(input = {}) {
  const base = randomFingerprint(input.platform);
  return {
    id: uid(),
    name: input.name || '新环境',
    startUrl: input.startUrl || 'about:blank',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),

    platform: base.platform,
    userAgentMode: 'auto', // auto = 用本机 Chrome 版本号拼装，custom = 手填
    userAgentCustom: '',
    languages: base.languages,
    locale: base.locale,
    timezone: base.timezone,
    screen: base.screen,
    hardwareConcurrency: base.hardwareConcurrency,
    deviceMemory: base.deviceMemory,
    maxTouchPoints: 0,
    webglVendor: base.webglVendor,
    webglRenderer: base.webglRenderer,

    canvasNoise: true,
    audioNoise: true,
    webrtc: 'proxy', // proxy | disabled | real
    rectNoise: false,

    proxy: { type: 'none', host: '', port: '', username: '', password: '' },
    seed: base.seed,
  };
}

/* -------------------------------- CRUD --------------------------------- */

function list() {
  return load().profiles;
}

function get(id) {
  return load().profiles.find((p) => p.id === id) || null;
}

function create(input = {}) {
  const db = load();
  const p = defaults(input);
  // 允许覆盖任意字段
  for (const [k, v] of Object.entries(input)) {
    if (k === 'id') continue;
    if (k === 'proxy' && v && typeof v === 'object') {
      const { hasPassword, ...rest } = v; // 只读派生字段，不落库
      p.proxy = { ...p.proxy, ...rest };
    } else if (k === 'screen' && v && typeof v === 'object') {
      p.screen = { ...p.screen, ...v };
    } else if (k === 'deviceMemory') {
      p.deviceMemory = clampMemory(v);
    } else {
      p[k] = v;
    }
  }
  p.updatedAt = new Date().toISOString();
  db.profiles.push(p);
  save(db);
  fs.mkdirSync(profileDir(p.id), { recursive: true });
  return p;
}

function update(id, patch = {}) {
  const db = load();
  const p = db.profiles.find((x) => x.id === id);
  if (!p) return null;
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'id' || k === 'createdAt') continue;
    if (k === 'proxy' && v && typeof v === 'object') {
      const { hasPassword, ...rest } = v; // 只读派生字段，不落库
      p.proxy = { ...p.proxy, ...rest };
    } else if (k === 'screen' && v && typeof v === 'object') {
      p.screen = { ...p.screen, ...v };
    } else if (k === 'deviceMemory') {
      p.deviceMemory = clampMemory(v);
    } else {
      p[k] = v;
    }
  }
  p.updatedAt = new Date().toISOString();
  save(db);
  return p;
}

function remove(id) {
  const db = load();
  const i = db.profiles.findIndex((x) => x.id === id);
  if (i < 0) return false;
  db.profiles.splice(i, 1);
  save(db);
  try {
    fs.rmSync(profileDir(id), { recursive: true, force: true });
  } catch {
    /* 文件被浏览器占用时忽略 */
  }
  return true;
}

function profileDir(id) {
  return path.join(PROFILE_ROOT, id);
}

module.exports = {
  ROOT,
  DATA,
  list,
  get,
  create,
  update,
  remove,
  profileDir,
  randomFingerprint,
  TIMEZONES,
  WEBGL_POOL,
  WEBGL_MAC,
  SCREEN_POOL,
};
