'use strict';

function detectUaPlatform(userAgent) {
  const ua = String(userAgent || '');
  if (/Windows NT/i.test(ua)) return 'win';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
  if (/X11;\s*Linux|Linux (?:x86_64|i[36]86|aarch64|arm)/i.test(ua)) return 'linux';
  return '';
}

function profileConfigErrors(profile, browserVersion = '') {
  if (!profile || profile.userAgentMode !== 'custom' || !profile.userAgentCustom) return [];
  const errors = [];
  const ua = String(profile.userAgentCustom);
  const uaPlatform = detectUaPlatform(ua);
  if (uaPlatform && profile.platform && uaPlatform !== profile.platform) {
    const names = { win: 'Windows', mac: 'macOS', linux: 'Linux' };
    errors.push('自定义 UA 声明 ' + names[uaPlatform] + '，但环境平台设置为 ' + (names[profile.platform] || profile.platform));
  }

  const uaVersion = /(?:Chrome|Chromium)\/(\d+)(?:\.\d+){0,3}/i.exec(ua);
  const generatedVersion = /^(\d+)(?:\.\d+){1,3}$/.exec(String(browserVersion || '').trim());
  if (uaVersion && generatedVersion && uaVersion[1] !== generatedVersion[1]) {
    errors.push('自定义 UA 声明 Chromium ' + uaVersion[1] + '，但当前浏览器是 ' + generatedVersion[1]);
  }
  return errors;
}

function assertProfileConfig(profile, browserVersion) {
  const errors = profileConfigErrors(profile, browserVersion);
  if (!errors.length) return;
  const error = new Error(errors.join('；') + '。请调整为一致的平台/版本，或使用自动生成的默认 UA。');
  error.code = 'PROFILE_CONFIG_INVALID';
  throw error;
}

function profileWarnings(profile, profiles = []) {
  const warnings = [];
  const proxy = profile && profile.proxy ? profile.proxy : {};
  const hasProxy = proxy.type && proxy.type !== 'none' && proxy.host && proxy.port;
  if (!hasProxy) {
    warnings.push('未配置代理；浏览器流量将通过本机网络直连。');
  } else {
    const endpoint = [String(proxy.type).toLowerCase(), String(proxy.host).toLowerCase(), String(proxy.port)].join('|');
    const shared = profiles.filter((other) => {
      if (!other || other.id === profile.id) return false;
      const otherProxy = other.proxy || {};
      return otherProxy.type && otherProxy.type !== 'none' && otherProxy.host && otherProxy.port &&
        [String(otherProxy.type).toLowerCase(), String(otherProxy.host).toLowerCase(), String(otherProxy.port)].join('|') === endpoint;
    });
    if (shared.length) {
      warnings.push('另有环境配置了相同代理端点；实际出口是否相同无法仅凭此配置判断。');
    }
  }
  warnings.push(profile && profile.autoGeo === true
    ? '已启用启动时地区同步；出口或查询变化仍可能造成地区不一致。'
    : '时区与地理位置尚未按网络出口验证；这不代表配置错误。');
  return warnings;
}

module.exports = { detectUaPlatform, profileConfigErrors, assertProfileConfig, profileWarnings };
