'use strict';

let state = { profiles: [], browserPath: '', timezones: {}, webglPool: [], screenPool: [] };
let editingId = null;

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

let toastTimer = null;
function toast(msg, isErr) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr ? ' err' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3600);
}

/* --------------------------------- 渲染 --------------------------------- */

function render() {
  const grid = $('#grid');
  const list = state.profiles || [];
  $('#empty').hidden = list.length > 0;

  $('#hint').innerHTML =
    '浏览器内核：<b>' +
    (state.browserPath ? esc(state.browserPath) : '未找到，请安装 Chrome 或用 FB_BROWSER 指定') +
    '</b> · 每个环境使用独立 <b>user-data-dir</b>，Cookie / 缓存 / 登录态互不相通；' +
    '指纹在 Chromium 原生层（UA、UA-CH、时区、locale）与主世界脚本（Canvas、WebGL、Audio、屏幕）两层同时伪装。';

  if (editingId === null) {
    $('#browserVer').textContent = state.browserPath
      ? '内核 · ' + state.browserPath.split(/[\\/]/).pop()
      : '未找到浏览器内核';
  }

  grid.innerHTML = list
    .map((p) => {
      const running = !!p.running;
      const proxy = p.proxy || {};
      const proxyText =
        proxy.type && proxy.type !== 'none' && proxy.host
          ? proxy.type.toUpperCase() + ' ' + proxy.host + ':' + proxy.port
          : '直连';
      const scr = p.screen || {};
      return `
      <article class="card ${running ? 'running' : ''}" data-id="${esc(p.id)}">
        <div class="card-head">
          <span class="name">${esc(p.name)}</span>
          <span class="tag ${running ? 'on' : 'off'}">${running ? '运行中' : '已停止'}</span>
          <span class="tag">${esc(p.platform)}</span>
        </div>
        <div class="meta">
          <span>屏幕 <code>${esc(scr.width)}×${esc(scr.height)}</code> · CPU ${esc(p.hardwareConcurrency)} · 内存 ${esc(p.deviceMemory)}G</span>
          <span>时区 <code>${esc(p.timezone)}</code> · 语言 <code>${esc((p.languages || []).join(','))}</code></span>
          <span>WebGL <code>${esc((p.webglRenderer || '').slice(0, 46))}</code></span>
          <span>代理 <code>${esc(proxyText)}</code> · WebRTC ${esc(p.webrtc)}</span>
        </div>
        <div class="card-actions">
          ${
            running
              ? `<button class="btn danger" data-act="stop">关闭</button>
                 <button class="btn" data-act="probe">检测指纹</button>`
              : `<button class="btn primary" data-act="launch">启动</button>
                 <button class="btn" data-act="probe" disabled title="先启动环境">检测指纹</button>`
          }
          <button class="btn ghost" data-act="edit">编辑</button>
          <button class="btn ghost danger" data-act="delete">删除</button>
        </div>
      </article>`;
    })
    .join('');
}

let renderedJson = '';

async function load(force) {
  try {
    const next = await api('/api/state');
    state = next;
    const json = JSON.stringify(next);
    // 数据没变就不重绘：以前每 6s 把整张卡片列表 innerHTML 重建一遍
    if (force || json !== renderedJson) {
      renderedJson = json;
      render();
    }
  } catch (e) {
    toast('读取状态失败：' + e.message, true);
  }
}

/* -------------------------------- 编辑器 -------------------------------- */

function setVal(name, v) {
  const el = $('#editorForm').querySelector('[name="' + name + '"]');
  if (!el) return;
  if (el.type === 'checkbox') el.checked = !!v;
  else el.value = v == null ? '' : v;
}

function getVal(name) {
  const el = $('#editorForm').querySelector('[name="' + name + '"]');
  if (!el) return '';
  if (el.type === 'checkbox') return el.checked;
  return el.value;
}

function openEditor(profile) {
  editingId = profile ? profile.id : null;
  $('#editorTitle').textContent = profile ? '编辑环境' : '新建环境';
  $('#editorErr').textContent = '';

  // 密码是"只写不读"：接口不回密码，这里始终留空
  const pwInput = $('#editorForm').querySelector('[name="proxyPassword"]');
  pwInput.value = '';
  pwInput.placeholder = '';

  if (profile) {
    const s = profile.screen || {};
    const px = profile.proxy || {};
    setVal('name', profile.name);
    setVal('startUrl', profile.startUrl);
    setVal('platform', profile.platform);
    setVal('timezone', profile.timezone);
    setVal('languages', (profile.languages || []).join(','));
    setVal('locale', profile.locale);
    setVal('screenWidth', s.width);
    setVal('screenHeight', s.height);
    setVal('screenAvailHeight', s.availHeight);
    setVal('pixelRatio', s.pixelRatio);
    setVal('colorDepth', s.colorDepth);
    setVal('hardwareConcurrency', profile.hardwareConcurrency);
    setVal('deviceMemory', profile.deviceMemory);
    setVal('maxTouchPoints', profile.maxTouchPoints);
    setVal('webglVendor', profile.webglVendor);
    setVal('webglRenderer', profile.webglRenderer);
    setVal('userAgentMode', profile.userAgentMode || 'auto');
    setVal('userAgentCustom', profile.userAgentCustom);
    setVal('webrtc', profile.webrtc || 'proxy');
    setVal('canvasNoise', profile.canvasNoise !== false);
    setVal('audioNoise', profile.audioNoise !== false);
    setVal('textNoise', profile.textNoise !== false);
    setVal('rectNoise', profile.rectNoise === true);
    setVal('proxyType', px.type || 'none');
    setVal('proxyHost', px.host);
    setVal('proxyPort', px.port);
    setVal('proxyUsername', px.username);
    pwInput.placeholder = px.hasPassword ? '已保存，留空表示不修改' : '';
  } else {
    setVal('name', '');
    setVal('startUrl', 'about:blank');
    setVal('platform', 'win');
    setVal('timezone', 'Asia/Shanghai');
    setVal('languages', 'zh-CN,zh,en-US,en');
    setVal('locale', 'zh-CN');
    setVal('screenWidth', 1920);
    setVal('screenHeight', 1080);
    setVal('screenAvailHeight', 1040);
    setVal('pixelRatio', 1);
    setVal('colorDepth', 24);
    setVal('hardwareConcurrency', 8);
    setVal('deviceMemory', 8);
    setVal('maxTouchPoints', 0);
    setVal('webglVendor', 'Google Inc. (NVIDIA)');
    setVal('webglRenderer', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)');
    setVal('userAgentMode', 'auto');
    setVal('userAgentCustom', '');
    setVal('webrtc', 'proxy');
    setVal('canvasNoise', true);
    setVal('audioNoise', true);
    setVal('textNoise', true);
    setVal('rectNoise', false);
    setVal('proxyType', 'none');
    setVal('proxyHost', '');
    setVal('proxyPort', '');
    setVal('proxyUsername', '');
    setVal('proxyPassword', '');
  }
  syncUaWrap();
  $('#editor').showModal();
}

function syncUaWrap() {
  $('#uaWrap').style.opacity = getVal('userAgentMode') === 'custom' ? '1' : '.45';
}

function readEditor() {
  const langs = String(getVal('languages') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const proxy = {
    type: getVal('proxyType'),
    host: getVal('proxyHost').trim(),
    port: getVal('proxyPort').trim(),
    username: getVal('proxyUsername').trim(),
  };
  // 留空 = 不修改已保存的密码（新建环境时留空就是没密码）
  const pw = getVal('proxyPassword');
  if (pw) proxy.password = pw;

  return {
    name: getVal('name').trim(),
    startUrl: getVal('startUrl').trim() || 'about:blank',
    platform: getVal('platform'),
    timezone: getVal('timezone').trim() || 'Asia/Shanghai',
    languages: langs.length ? langs : ['zh-CN'],
    locale: getVal('locale').trim() || langs[0] || 'zh-CN',
    screen: {
      width: Number(getVal('screenWidth')) || 1920,
      height: Number(getVal('screenHeight')) || 1080,
      availHeight: Number(getVal('screenAvailHeight')) || 1040,
      colorDepth: Number(getVal('colorDepth')) || 24,
      pixelRatio: Number(getVal('pixelRatio')) || 1,
    },
    hardwareConcurrency: Number(getVal('hardwareConcurrency')) || 8,
    deviceMemory: Number(getVal('deviceMemory')) || 8,
    maxTouchPoints: Number(getVal('maxTouchPoints')) || 0,
    webglVendor: getVal('webglVendor'),
    webglRenderer: getVal('webglRenderer'),
    userAgentMode: getVal('userAgentMode'),
    userAgentCustom: getVal('userAgentCustom').trim(),
    webrtc: getVal('webrtc'),
    canvasNoise: getVal('canvasNoise'),
    audioNoise: getVal('audioNoise'),
    textNoise: getVal('textNoise'),
    rectNoise: getVal('rectNoise'),
    proxy,
  };
}

async function saveEditor() {
  const data = readEditor();
  if (!data.name) {
    $('#editorErr').textContent = '请填名称';
    return;
  }
  if (data.proxy.type !== 'none' && (!data.proxy.host || !data.proxy.port)) {
    $('#editorErr').textContent = '选了代理就要填主机和端口';
    return;
  }
  $('#btnSave').disabled = true;
  try {
    if (editingId) await api('/api/profiles/' + editingId, { method: 'PUT', body: data });
    else await api('/api/profiles', { method: 'POST', body: data });
    $('#editor').close();
    await load();
    toast('已保存');
  } catch (e) {
    $('#editorErr').textContent = e.message;
  } finally {
    $('#btnSave').disabled = false;
  }
}

/* ------------------------------- 卡片动作 ------------------------------- */

async function onCardAction(id, act, btn) {
  const p = state.profiles.find((x) => x.id === id);
  try {
    if (act === 'edit') return openEditor(p);
    if (act === 'delete') {
      if (!confirm('删除环境「' + p.name + '」？它的 Cookie 和登录态会一起删掉。')) return;
      await api('/api/profiles/' + id, { method: 'DELETE' });
      await load();
      return toast('已删除');
    }
    if (act === 'launch') {
      btn.disabled = true;
      btn.textContent = '启动中…';
      toast('正在启动，首次启动会稍慢…');
      const info = await api('/api/profiles/' + id + '/launch', { method: 'POST', body: {} });
      await load();
      return toast('已启动，PID ' + info.pid + '（内核 ' + info.browserVersion + '）');
    }
    if (act === 'stop') {
      btn.disabled = true;
      await api('/api/profiles/' + id + '/stop', { method: 'POST' });
      await load();
      return toast('已关闭');
    }
    if (act === 'probe') {
      btn.disabled = true;
      btn.textContent = '检测中…';
      const report = await api('/api/profiles/' + id + '/probe', { method: 'POST' });
      showReport(report);
      btn.disabled = false;
      btn.textContent = '检测指纹';
      return;
    }
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
    btn.textContent = act === 'launch' ? '启动' : btn.textContent;
    await load();
  }
}

/* ------------------------------- 检测结果 ------------------------------- */

const LABELS = {
  injected: '注入脚本生效',
  secureContext: '安全上下文',
  userAgent: 'User-Agent',
  platform: 'navigator.platform',
  languages: 'navigator.languages',
  hardwareConcurrency: 'CPU 逻辑核数',
  deviceMemory: '设备内存 (GB)',
  webdriver: 'navigator.webdriver',
  timezone: '时区',
  locale: 'Locale',
  screen: '屏幕',
  canvasHash: 'Canvas 指纹哈希',
  canvasTail: 'Canvas DataURL 尾部',
  webglVendor: 'WebGL 厂商',
  webglRenderer: 'WebGL 渲染器',
  glMaxTextureSize: 'WebGL 最大纹理',
  gpuVendor: 'WebGPU GPU 家族',
  gpuArch: 'WebGPU 架构',
  speechVoiceCount: '语音合成数量',
  speechVoices: '语音设备',
  speechHasMicrosoft: '含 Windows SAPI 语音',
  speechHasMac: '含 macOS 语音',
  audioHash: 'Audio 指纹哈希',
};

function showReport(r) {
  const rows = [];
  for (const k of Object.keys(LABELS)) {
    if (r[k] === undefined) continue;
    let v = r[k];
    if (k === 'screen' && v && typeof v === 'object') {
      v = v.width + '×' + v.height + ' 可用高 ' + v.availHeight + ' 色深 ' + v.colorDepth + ' DPR ' + v.dpr;
    } else if (Array.isArray(v)) {
      v = v.join(', ');
    } else if (typeof v === 'object') {
      v = JSON.stringify(v);
    }
    rows.push('<div class="k">' + esc(LABELS[k]) + '</div><div class="v">' + esc(v) + '</div>');
  }
  for (const k of Object.keys(r)) {
    if (LABELS[k]) continue;
    if (!/Error$/.test(k)) continue;
    rows.push('<div class="k">' + esc(k) + '</div><div class="v">' + esc(r[k]) + '</div>');
  }
  $('#reportBody').innerHTML = rows.join('');
  $('#report').showModal();
}

/* -------------------------------- 事件绑定 -------------------------------- */

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const card = btn.closest('.card');
  if (!card) return;
  onCardAction(card.dataset.id, btn.dataset.act, btn);
});

$('#btnNew').addEventListener('click', () => openEditor(null));
$('#btnRefresh').addEventListener('click', () => load(true));
$('#btnCancel').addEventListener('click', () => $('#editor').close());
$('#btnSave').addEventListener('click', saveEditor);
$('#btnCloseReport').addEventListener('click', () => $('#report').close());
$('#editorForm').querySelector('[name="userAgentMode"]').addEventListener('change', syncUaWrap);

$('#btnRandom').addEventListener('click', async () => {
  try {
    const r = await api('/api/random', { method: 'POST', body: {} });
    setVal('platform', r.platform);
    setVal('timezone', r.timezone);
    setVal('languages', r.languages.join(','));
    setVal('locale', r.locale);
    setVal('screenWidth', r.screen.width);
    setVal('screenHeight', r.screen.height);
    setVal('screenAvailHeight', r.screen.availHeight);
    setVal('pixelRatio', r.screen.pixelRatio);
    setVal('colorDepth', r.screen.colorDepth);
    setVal('hardwareConcurrency', r.hardwareConcurrency);
    setVal('deviceMemory', r.deviceMemory);
    setVal('webglVendor', r.webglVendor);
    setVal('webglRenderer', r.webglRenderer);
    toast('已随机一套指纹');
  } catch (e) {
    toast(e.message, true);
  }
});

(async function init() {
  await load();
  // 时区候选
  const all = new Set(['Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'America/Chicago', 'Australia/Sydney']);
  for (const arr of Object.values(state.timezones || {})) for (const tz of arr) all.add(tz);
  $('#tzList').innerHTML = [...all].map((t) => '<option value="' + esc(t) + '">').join('');

  // 轮询同步运行状态（页面在后台就停掉，别白跑）
  setInterval(() => {
    if (document.hidden) return;
    if (document.querySelector('dialog[open]')) return;
    load();
  }, 6000);
})();
