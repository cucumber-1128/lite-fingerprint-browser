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
      type: scheme === 'socks5' ? 'socks5' : 'http',
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
    return {
      type: parts[0].toLowerCase() === 'socks5' ? 'socks5' : 'http',
      host: parts[1],
      port: parts[2],
      username: parts[3],
      password: parts[4],
    };
  }
  throw new Error('看不懂的代理格式：' + s + '（建议用 http://user:pass@host:port）');
}

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

module.exports = { PRESETS, getPreset, parseProxyLine, parseProxies, readJsonArg };
