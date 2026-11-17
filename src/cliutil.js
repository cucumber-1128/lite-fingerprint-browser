'use strict';
/**
 * CLI 的小工具：地区预设、代理串解析、JSON 参数读取。
 * 这些函数同时给 index.js 和测试用，所以单独成模块。
 */
const fs = require('node:fs');

/** 地区预设：只锁"和地区绑定的字段"，屏幕/CPU/GPU 仍然随机，保证每个环境指纹不同 */
const PRESETS = {
  'us-shop': {
    label: '美国店铺',
    platform: 'win',
    locale: 'en-US',
    languages: ['en-US', 'en'],
    timezone: 'America/New_York',
  },
  'us-west': {
    label: '美西店铺',
    platform: 'win',
    locale: 'en-US',
    languages: ['en-US', 'en'],
    timezone: 'America/Los_Angeles',
  },
  'uk-shop': {
    label: '英国店铺',
    platform: 'win',
    locale: 'en-GB',
    languages: ['en-GB', 'en'],
    timezone: 'Europe/London',
  },
  'de-shop': {
    label: '德国店铺',
    platform: 'win',
    locale: 'de-DE',
    languages: ['de-DE', 'de', 'en-US', 'en'],
    timezone: 'Europe/Berlin',
  },
  'jp-shop': {
    label: '日本店铺',
    platform: 'win',
    locale: 'ja-JP',
    languages: ['ja-JP', 'ja', 'en-US', 'en'],
    timezone: 'Asia/Tokyo',
  },
  'tw-shop': {
    label: '台湾店铺',
    platform: 'win',
    locale: 'zh-TW',
    languages: ['zh-TW', 'zh', 'en-US', 'en'],
    timezone: 'Asia/Taipei',
  },
  'cn-shop': {
    label: '国内店铺',
    platform: 'win',
    locale: 'zh-CN',
    languages: ['zh-CN', 'zh', 'en-US', 'en'],
    timezone: 'Asia/Shanghai',
  },
  'mac-us': {
    label: 'macOS 美国',
    platform: 'mac',
    locale: 'en-US',
    languages: ['en-US', 'en'],
    timezone: 'America/New_York',
  },
};

/** @returns {{key:string,label:string,platform:string,locale:string,languages:string[],timezone:string}} */
function getPreset(name) {
  const key = String(name || '')
    .trim()
    .toLowerCase();
  const p = PRESETS[key];
  if (!p) {
    throw new Error('没有这个预设：' + name + '（可用：' + Object.keys(PRESETS).join(', ') + '）');
  }
  return { key, ...p };
}

/**
 * 一行一个代理，支持的写法：
 *   http://user:pass@host:port      https://host:port
 *   socks5://user:pass@host:port
 *   host:port:user:pass             host:port
 *   socks5:host:port:user:pass
 * 以 # 开头的行当注释。
 */
function parseProxyLine(line) {
  let s = String(line || '').trim();
  if (!s || s.startsWith('#')) return null;
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);

  const url = /^(https?|socks5):\/\/(?:([^:@/]*):([^@/]*)@)?([^:/]+):(\d{1,5})$/i.exec(s);
  if (url) {
    const scheme = url[1].toLowerCase();
    return {
      type: scheme === 'socks5' ? 'socks5' : scheme === 'https' ? 'https' : 'http',
      host: url[4],
      port: url[5],
      username: url[2] || '',
      password: url[3] || '',
    };
  }

  const parts = s.split(':');
  if (parts.length === 2 && parts[0] && /^\d+$/.test(parts[1])) {
    return { type: 'http', host: parts[0], port: parts[1], username: '', password: '' };
  }
  if (parts.length === 4) {
    return { type: 'http', host: parts[0], port: parts[1], username: parts[2], password: parts[3] };
  }
  if (parts.length === 5) {
    const scheme = parts[0].toLowerCase();
    return {
      type: scheme === 'socks5' ? 'socks5' : scheme === 'https' ? 'https' : 'http',
      host: parts[1],
      port: parts[2],
      username: parts[3],
      password: parts[4],
    };
  }
  throw new Error('看不懂的代理格式：' + s + '（建议用 http://user:pass@host:port）');
}

const COUNTRY_LOCALES = {
  US: { locale: 'en-US', languages: ['en-US', 'en'] },
  GB: { locale: 'en-GB', languages: ['en-GB', 'en'] },
  UK: { locale: 'en-GB', languages: ['en-GB', 'en'] },
  AU: { locale: 'en-AU', languages: ['en-AU', 'en-US', 'en'] },
  CA: { locale: 'en-CA', languages: ['en-CA', 'en-US', 'en'] },
  SG: { locale: 'en-SG', languages: ['en-SG', 'en-US', 'en'] },
  DE: { locale: 'de-DE', languages: ['de-DE', 'de', 'en-US', 'en'] },
  AT: { locale: 'de-AT', languages: ['de-AT', 'de', 'en-US', 'en'] },
  CH: { locale: 'de-CH', languages: ['de-CH', 'de', 'en-US', 'en'] },
  FR: { locale: 'fr-FR', languages: ['fr-FR', 'fr', 'en-US', 'en'] },
  ES: { locale: 'es-ES', languages: ['es-ES', 'es', 'en-US', 'en'] },
  MX: { locale: 'es-MX', languages: ['es-MX', 'es', 'en-US', 'en'] },
  IT: { locale: 'it-IT', languages: ['it-IT', 'it', 'en-US', 'en'] },
  PT: { locale: 'pt-PT', languages: ['pt-PT', 'pt', 'en-US', 'en'] },
  BR: { locale: 'pt-BR', languages: ['pt-BR', 'pt', 'en-US', 'en'] },
  NL: { locale: 'nl-NL', languages: ['nl-NL', 'nl', 'en-US', 'en'] },
  RU: { locale: 'ru-RU', languages: ['ru-RU', 'ru', 'en-US', 'en'] },
  JP: { locale: 'ja-JP', languages: ['ja-JP', 'ja', 'en-US', 'en'] },
  KR: { locale: 'ko-KR', languages: ['ko-KR', 'ko', 'en-US', 'en'] },
  TW: { locale: 'zh-TW', languages: ['zh-TW', 'zh', 'en-US', 'en'] },
  HK: { locale: 'zh-HK', languages: ['zh-HK', 'zh', 'en-US', 'en'] },
  CN: { locale: 'zh-CN', languages: ['zh-CN', 'zh', 'en-US', 'en'] },
  VN: { locale: 'vi-VN', languages: ['vi-VN', 'vi', 'en-US', 'en'] },
  TH: { locale: 'th-TH', languages: ['th-TH', 'th', 'en-US', 'en'] },
  ID: { locale: 'id-ID', languages: ['id-ID', 'id', 'en-US', 'en'] },
  MY: { locale: 'ms-MY', languages: ['ms-MY', 'ms', 'en-US', 'en'] },
};

function countryToLocale(countryCode) {
  const key = String(countryCode || '').trim().toUpperCase();
  const entry = COUNTRY_LOCALES[key] || COUNTRY_LOCALES.US;
  return { locale: entry.locale, languages: [...entry.languages] };
}

const TIMEZONE_COORDS = {
  'America/New_York': { lat: 40.7128, lon: -74.006 },
  'America/Los_Angeles': { lat: 34.0522, lon: -118.2437 },
  'America/Chicago': { lat: 41.8781, lon: -87.6298 },
  'America/Denver': { lat: 39.7392, lon: -104.9903 },
  'America/Toronto': { lat: 43.6532, lon: -79.3832 },
  'America/Vancouver': { lat: 49.2827, lon: -123.1207 },
  'America/Mexico_City': { lat: 19.4326, lon: -99.1332 },
  'America/Sao_Paulo': { lat: -23.5505, lon: -46.6333 },
  'Europe/London': { lat: 51.5074, lon: -0.1278 },
  'Europe/Berlin': { lat: 52.52, lon: 13.405 },
  'Europe/Paris': { lat: 48.8566, lon: 2.3522 },
  'Europe/Madrid': { lat: 40.4168, lon: -3.7038 },
  'Europe/Rome': { lat: 41.9028, lon: 12.4964 },
  'Europe/Amsterdam': { lat: 52.3676, lon: 4.9041 },
  'Europe/Zurich': { lat: 47.3769, lon: 8.5417 },
  'Europe/Vienna': { lat: 48.2082, lon: 16.3738 },
  'Europe/Moscow': { lat: 55.7558, lon: 37.6173 },
  'Asia/Tokyo': { lat: 35.6762, lon: 139.6503 },
  'Asia/Seoul': { lat: 37.5665, lon: 126.978 },
  'Asia/Taipei': { lat: 25.033, lon: 121.5654 },
  'Asia/Hong_Kong': { lat: 22.3193, lon: 114.1694 },
  'Asia/Shanghai': { lat: 31.2304, lon: 121.4737 },
  'Asia/Singapore': { lat: 1.3521, lon: 103.8198 },
  'Asia/Bangkok': { lat: 13.7563, lon: 100.5018 },
  'Asia/Ho_Chi_Minh': { lat: 10.8231, lon: 106.6297 },
  'Asia/Jakarta': { lat: -6.2088, lon: 106.8456 },
  'Asia/Kuala_Lumpur': { lat: 3.139, lon: 101.6869 },
  'Australia/Sydney': { lat: -33.8688, lon: 151.2093 },
  'Australia/Melbourne': { lat: -37.8136, lon: 144.9631 },
};

function parseProxies(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const p = parseProxyLine(line);
    if (p) out.push(p);
  }
  return out;
}

/** --spec 支持内联 JSON 或 @文件 */
function readJsonArg(value) {
  if (value === null || value === undefined || value === '') return null;
  let raw = String(value);
  if (raw.startsWith('@')) raw = fs.readFileSync(raw.slice(1), 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error('--spec 不是合法 JSON：' + e.message);
  }
}

module.exports = { PRESETS, getPreset, parseProxyLine, parseProxies, readJsonArg, countryToLocale, TIMEZONE_COORDS };
