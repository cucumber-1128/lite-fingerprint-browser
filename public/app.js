'use strict';

let state = { profiles: [], browserPath: '', agentCli: null, timezones: {}, presets: [], webglPool: [], screenPool: [] };
let editingId = null;
let lastAutoAvail = 1040;
let pendingGeo = undefined;

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const needJsonBody = method === 'POST' || method === 'PUT';
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : needJsonBody ? '{}' : undefined;
  const res = await fetch(path, {
    ...opts,
    method,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    body,
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

let filterText = '';
let filterGroup = '';
const selectedIds = new Set();
let cookieProfileId = null;
let cachedCookies = [];

function visibleProfiles() {
  const q = filterText.trim().toLowerCase();
  return (state.profiles || []).filter((p) => {
    if (filterGroup && (p.group || '') !== filterGroup) return false;
    if (!q) return true;
    const hay = [p.name, p.group, p.notes, p.platform, p.timezone, p.locale, p.proxy && p.proxy.host, p.id]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return hay.indexOf(q) >= 0;
  });
}

function syncBatchBar() {
  const bar = $('#batchBar');
  if (!bar) return;
  const all = state.profiles || [];
  const validIds = new Set(all.map((p) => p.id));
  for (const id of [...selectedIds]) {
    if (!validIds.has(id)) selectedIds.delete(id);
  }
  bar.hidden = all.length === 0;
  const list = visibleProfiles();
  const visSelected = list.filter((p) => selectedIds.has(p.id)).length;
  const chk = $('#chkSelectAll');
  if (chk) {
    chk.checked = list.length > 0 && visSelected === list.length;
    chk.indeterminate = visSelected > 0 && visSelected < list.length;
  }
  $('#batchCount').textContent = '已选 ' + selectedIds.size + ' 个';
  const none = selectedIds.size === 0;
  $('#btnBatchLaunch').disabled = none;
  $('#btnBatchStop').disabled = none;
  $('#btnBatchDelete').disabled = none;
}

function render() {
  const grid = $('#grid');
  const all = state.profiles || [];
  const list = visibleProfiles();
  const filtered = all.length > 0 && list.length !== all.length;

  $('#empty').hidden = list.length > 0;
  $('#empty').innerHTML = all.length
    ? '<p>没有匹配的环境。</p><p>清空搜索框或切回「全部分组」。</p>'
    : '<p>还没有环境。</p><p>点右上角「新建环境」，每个环境有独立的 Cookie 存储、独立的指纹、独立的代理。</p>';

  $('#hint').innerHTML =
    '浏览器内核：<b>' +
    (state.browserPath ? esc(state.browserPath) : '未找到，请安装 Chrome 或用 FB_BROWSER 指定') +
    '</b> · 每个环境使用独立 <b>user-data-dir</b>，Cookie / 缓存 / 登录态互不相通；' +
    '指纹在 Chromium 原生层（UA、UA-CH、时区、locale）与主世界脚本（Canvas、WebGL、Audio、字体、屏幕）两层同时伪装。' +
    (filtered ? ' · 当前筛选出 <b>' + list.length + '</b> / ' + all.length + ' 个环境。' : '');

  if (editingId === null) {
    $('#browserVer').textContent = state.browserPath
      ? '内核 · ' + state.browserPath.split(/[\\/]/).pop()
      : '未找到浏览器内核';
  }

  grid.innerHTML = list
    .map((p) => {
      const running = !!p.running;
      const checked = selectedIds.has(p.id);
      const proxy = p.proxy || {};
      const hasProxy = proxy.type && proxy.type !== 'none' && proxy.host;
      const proxyText = hasProxy ? proxy.type.toUpperCase() + ' ' + proxy.host + ':' + proxy.port : '直连';
      const scr = p.screen || {};
      return `
      <article class="card ${running ? 'running' : ''} ${checked ? 'selected' : ''}" data-id="${esc(p.id)}">
        <div class="card-head">
          <input type="checkbox" class="card-check" data-select="${esc(p.id)}" ${checked ? 'checked' : ''} title="选中此环境" />
          <span class="name">${esc(p.name)}</span>
          ${p.group ? `<span class="tag group" title="分组">${esc(p.group)}</span>` : ''}
          <span class="tag ${running ? 'on' : 'off'}">${running ? '运行中' : '已停止'}</span>
          <span class="tag">${esc(p.platform)}</span>
        </div>
        <div class="meta">
          <span>屏幕 <code>${esc(scr.width)}×${esc(scr.height)}</code> · CPU ${esc(p.hardwareConcurrency)} · 内存 ${esc(p.deviceMemory)}G</span>
          <span>时区 <code>${esc(p.timezone)}</code> · 语言 <code>${esc((p.languages || []).join(','))}</code></span>
          <span>WebGL <code>${esc((p.webglRenderer || '').slice(0, 46))}</code></span>
          <span>代理 <code>${esc(proxyText)}</code> · WebRTC ${esc(p.webrtc)}</span>
          ${p.notes ? `<span class="note">备注 <code>${esc(p.notes)}</code></span>` : ''}
        </div>
        <div class="card-actions">
          ${
            running
              ? `<button class="btn danger" data-act="stop">关闭</button>
                 <button class="btn" data-act="probe">检测指纹</button>`
              : `<button class="btn primary" data-act="launch">启动</button>
                 <button class="btn" data-act="probe" disabled title="先启动环境">检测指纹</button>`
          }
          ${hasProxy ? `<button class="btn" data-act="proxy-test">测代理</button>` : ''}
          <button class="btn ghost" data-act="cookies">Cookie</button>
          <button class="btn ghost" data-act="clone">克隆</button>
          <button class="btn ghost" data-act="edit">编辑</button>
          <button class="btn ghost danger" data-act="delete">删除</button>
        </div>
      </article>`;
    })
    .join('');
  syncBatchBar();
}

/** 分组下拉：随时按现有分组重建，但保留当前选择 */
function renderGroupFilter() {
  const sel = $('#groupFilter');
  const cur = sel.value;
  const groups = [...new Set((state.profiles || []).map((p) => (p.group || '').trim()).filter(Boolean))].sort();
  sel.innerHTML =
    '<option value="">全部分组</option>' +
    groups.map((g) => '<option value="' + esc(g) + '">' + esc(g) + '</option>').join('');
  sel.value = groups.includes(cur) ? cur : '';
  filterGroup = sel.value;
}

function renderPresetSelect() {
  const presets = state.presets || [];
  const sel = $('#presetSelect');
  if (sel) {
    const cur = sel.value;
    sel.innerHTML =
      '<option value="">自定义</option>' +
      presets
        .map((p) => '<option value="' + esc(p.key) + '">' + esc(p.label + ' (' + p.key + ' · ' + p.timezone + ')') + '</option>')
        .join('');
    sel.value = presets.some((p) => p.key === cur) ? cur : '';
  }
  const bsel = $('#batchPreset');
  if (bsel) {
    const bcur = bsel.value;
    bsel.innerHTML =
      '<option value="">默认随机</option>' +
      presets
        .map((p) => '<option value="' + esc(p.key) + '">' + esc(p.label + ' (' + p.key + ' · ' + p.timezone + ')') + '</option>')
        .join('');
    bsel.value = presets.some((p) => p.key === bcur) ? bcur : '';
  }
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
      renderGroupFilter();
      if (!$('#editor').open) renderPresetSelect();
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
  pendingGeo = undefined;
  $('#editorTitle').textContent = profile ? '编辑环境' : '新建环境';
  $('#editorErr').textContent = '';

  // 密码是"只写不读"：接口不回密码，这里始终留空
  const pwInput = $('#editorForm').querySelector('[name="proxyPassword"]');
  pwInput.value = '';
  pwInput.placeholder = '';
  renderPresetSelect();
  if ($('#presetSelect')) $('#presetSelect').value = '';
  if ($('#proxyQuick')) $('#proxyQuick').value = '';

  if (profile) {
    const s = profile.screen || {};
    const px = profile.proxy || {};
    setVal('name', profile.name);
    setVal('group', profile.group || '');
    setVal('notes', profile.notes || '');
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
    setVal('fontNoise', profile.fontNoise !== false);
    setVal('rectNoise', profile.rectNoise === true);
    setVal('proxyType', px.type || 'none');
    setVal('proxyHost', px.host);
    setVal('proxyPort', px.port);
    setVal('proxyUsername', px.username);
    setVal('autoGeo', profile.autoGeo === true);
    pwInput.placeholder = px.hasPassword ? '已保存，留空表示不修改' : '';
  } else {
    setVal('name', '');
    setVal('group', '');
    setVal('notes', '');
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
    setVal('fontNoise', true);
    setVal('rectNoise', false);
    setVal('proxyType', 'none');
    setVal('proxyHost', '');
    setVal('proxyPort', '');
    setVal('proxyUsername', '');
    setVal('proxyPassword', '');
    setVal('autoGeo', false);
  }
  lastAutoAvail = (Number(getVal('screenHeight')) || 1080) - (getVal('platform') === 'mac' ? 25 : 40);
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
    group: getVal('group').trim(),
    notes: getVal('notes').trim(),
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
    fontNoise: getVal('fontNoise'),
    rectNoise: getVal('rectNoise'),
    autoGeo: getVal('autoGeo'),
    ...(pendingGeo !== undefined ? { geo: pendingGeo } : {}),
    proxy,
  };
}

async function saveEditor() {
  const data = readEditor();
  if (!data.name) {
    $('#editorErr').textContent = '请填名称';
    return;
  }
  if (Number(getVal('pixelRatio')) <= 0) {
    $('#editorErr').textContent = 'DPR 必须大于 0';
    return;
  }
  if (data.screen.availHeight > data.screen.height || data.screen.height - data.screen.availHeight > 160) {
    $('#editorErr').textContent = '可用高须在 ' + Math.max(1, data.screen.height - 160) + ' 到 ' + data.screen.height + ' 之间';
    return;
  }
  if (data.proxy.type !== 'none' && (!data.proxy.host || !data.proxy.port)) {
    $('#editorErr').textContent = '选了代理就要填主机和端口';
    return;
  }
  $('#btnSave').disabled = true;
  try {
    const saved = editingId
      ? await api('/api/profiles/' + editingId, { method: 'PUT', body: data })
      : await api('/api/profiles', { method: 'POST', body: data });
    $('#editor').close();
    await load();
    toast(saved.running ? '已保存，浏览器参数将在下次启动此环境时生效' : '已保存');
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
    if (act === 'cookies') return openCookieDlg(p);
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
    if (act === 'clone') {
      btn.disabled = true;
      const copy = await api('/api/profiles/' + id + '/clone', { method: 'POST' });
      await load(true);
      return toast('已克隆为「' + copy.name + '」（换了新 seed，指纹与 Cookie 都是新的）');
    }
    if (act === 'proxy-test') {
      btn.disabled = true;
      btn.textContent = '测试中…';
      try {
        const r = await api('/api/profiles/' + id + '/proxy-test', { method: 'POST' });
        showProxyResult(r);
      } finally {
        btn.disabled = false;
        btn.textContent = '测代理';
      }
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
  fontCheck: '字体探测（Arial / 微软雅黑 / 不存在的字体）',
  gpuVendor: 'WebGPU GPU 家族',
  gpuArch: 'WebGPU 架构',
  speechVoiceCount: '语音合成数量',
  speechVoices: '语音设备',
  speechHasMicrosoft: '含 Windows SAPI 语音',
  speechHasMac: '含 macOS 语音',
  audioHash: 'Audio 指纹哈希',
};

const HEALTH_LABELS = {
  workerConsistent: '主线程 / Worker 硬件一致',
  iframeToStringClean: '跨 iframe 原生函数伪装',
  illegalInvocationClean: '非法调用 Brand Check',
  canvasSolidClean: 'Canvas 纯色防陷阱',
  uaChConsistent: 'UA-CH 品牌与高熵值一致',
};

function showReport(r) {
  const rows = [];
  if (r.health && typeof r.health === 'object') {
    for (const hk of Object.keys(HEALTH_LABELS)) {
      if (r.health[hk] === undefined) continue;
      const ok = !!r.health[hk];
      rows.push(
        '<div class="k">' +
          esc(HEALTH_LABELS[hk]) +
          '</div><div class="v"><span class="' +
          (ok ? 'health-ok' : 'health-bad') +
          '">' +
          (ok ? '✓ 通过' : '✗ 异常') +
          '</span></div>'
      );
    }
    rows.push('<div class="health-sep"></div>');
  }
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

/* ------------------------------- 代理检测 ------------------------------- */

function showProxyResult(r) {
  const rows = [];
  const add = (k, v) => rows.push('<div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div>');

  if (!r.ok) {
    add('结果', '失败');
    add('原因', r.error || '未知错误');
    add('耗时', (r.ms || 0) + ' ms');
  } else {
    add('结果', '可用');
    add('出口 IP', r.ip || '(未获取)');
    add('国家 / 城市', [r.country, r.city].filter(Boolean).join(' / ') || '-');
    add('出口时区', r.timezone || '-');
    if (typeof r.lat === 'number' && typeof r.lon === 'number') {
      add('坐标', r.lat + ', ' + r.lon);
    }
    add('运营商', r.isp || '-');
    add('耗时', (r.ms || 0) + ' ms');
    if (r.directIp) {
      add('直连 IP', r.directIp);
      add('是否泄漏', r.leaked ? '⚠ 代理没生效，出口和直连一样' : '否（出口与直连不同）');
    }
  }
  $('#proxyBody').innerHTML = rows.join('');
  $('#proxyDlg').showModal();
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
$('#editorForm').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!$('#btnSave').disabled) saveEditor();
});
$('#btnCloseReport').addEventListener('click', () => $('#report').close());
$('#btnCloseProxy').addEventListener('click', () => $('#proxyDlg').close());
$('#editorForm').querySelector('[name="userAgentMode"]').addEventListener('change', syncUaWrap);

/* ------------------------------ 搜索 / 分组 ------------------------------ */

$('#search').addEventListener('input', (e) => {
  filterText = e.target.value;
  render();
});
$('#groupFilter').addEventListener('change', (e) => {
  filterGroup = e.target.value;
  render();
});

/* ------------------------------ 导入 / 导出 ------------------------------ */

async function exportProfiles() {
  try {
    const res = await fetch('/api/export');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'fb-profiles-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('已导出（不含代理密码，导入后需重新填写）');
  } catch (e) {
    toast('导出失败：' + e.message, true);
  }
}

async function importProfiles(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const r = await api('/api/import', { method: 'POST', body: data });
    await load(true);
    toast('已导入 ' + r.imported + ' 个环境（代理密码需重新填写）');
  } catch (err) {
    toast('导入失败：' + err.message, true);
  }
}

$('#btnExport').addEventListener('click', exportProfiles);
$('#btnImport').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', importProfiles);

$('#btnQuit').addEventListener('click', async () => {
  if (!confirm('退出控制台？已启动的环境会被一起关闭。')) return;
  try {
    await api('/api/shutdown', { method: 'POST', body: {} });
  } catch {
    /* 服务已经退出，请求失败是正常的 */
  }
  document.body.innerHTML =
    '<div style="padding:80px 24px;text-align:center;color:#8b949e;font:14px/1.8 sans-serif">' +
    '控制台已退出。重新打开程序即可继续。</div>';
});

function applyHardwareRandom(r) {
  setVal('screenWidth', r.screen.width);
  setVal('screenHeight', r.screen.height);
  setVal('screenAvailHeight', r.screen.availHeight);
  lastAutoAvail = r.screen.availHeight;
  setVal('pixelRatio', r.screen.pixelRatio);
  setVal('colorDepth', r.screen.colorDepth);
  setVal('hardwareConcurrency', r.hardwareConcurrency);
  setVal('deviceMemory', r.deviceMemory);
  setVal('webglVendor', r.webglVendor);
  setVal('webglRenderer', r.webglRenderer);
}

$('#btnRandom').addEventListener('click', async () => {
  try {
    const r = await api('/api/random', {
      method: 'POST',
      body: {
        platform: getVal('platform'),
        locale: getVal('locale').trim(),
        timezone: getVal('timezone').trim(),
      },
    });
    setVal('platform', r.platform);
    setVal('timezone', r.timezone);
    setVal('languages', r.languages.join(','));
    setVal('locale', r.locale);
    applyHardwareRandom(r);
    toast('已随机一套指纹');
  } catch (e) {
    toast(e.message, true);
  }
});

$('#presetSelect').addEventListener('change', async (e) => {
  const key = e.target.value;
  if (!key) return;
  const p = (state.presets || []).find((x) => x.key === key);
  if (!p) return;
  setVal('platform', p.platform);
  setVal('timezone', p.timezone);
  setVal('locale', p.locale);
  setVal('languages', (p.languages || []).join(','));
  if (!getVal('group').trim()) setVal('group', p.label);
  try {
    const r = await api('/api/random', {
      method: 'POST',
      body: { platform: p.platform, locale: p.locale, timezone: p.timezone },
    });
    applyHardwareRandom(r);
    toast('已套用预设：' + p.label);
  } catch (err) {
    toast(err.message, true);
  }
});

$('#editorForm').querySelector('[name="platform"]').addEventListener('change', async () => {
  try {
    const r = await api('/api/random', {
      method: 'POST',
      body: {
        platform: getVal('platform'),
        locale: getVal('locale').trim(),
        timezone: getVal('timezone').trim(),
      },
    });
    setVal('screenWidth', r.screen.width);
    setVal('screenHeight', r.screen.height);
    setVal('screenAvailHeight', r.screen.availHeight);
    lastAutoAvail = r.screen.availHeight;
    setVal('pixelRatio', r.screen.pixelRatio);
    setVal('colorDepth', r.screen.colorDepth);
    setVal('webglVendor', r.webglVendor);
    setVal('webglRenderer', r.webglRenderer);
  } catch (err) {
    toast(err.message, true);
  }
});

$('#editorForm').querySelector('[name="screenHeight"]').addEventListener('change', () => {
  const h = Number(getVal('screenHeight'));
  if (!h || h <= 200) return;
  const avail = Number(getVal('screenAvailHeight'));
  const bar = getVal('platform') === 'mac' ? 25 : 40;
  if (!avail || avail > h || h - avail > 160 || Math.abs(lastAutoAvail - avail) <= 5) {
    const nextAvail = Math.max(200, h - bar);
    setVal('screenAvailHeight', nextAvail);
    lastAutoAvail = nextAvail;
  }
});

async function parseQuickProxy() {
  const input = $('#proxyQuick');
  const line = input.value.trim();
  if (!line) return;
  try {
    const px = await api('/api/parse-proxy', { method: 'POST', body: { line } });
    setVal('proxyType', px.type || 'http');
    setVal('proxyHost', px.host || '');
    setVal('proxyPort', px.port || '');
    setVal('proxyUsername', px.username || '');
    setVal('proxyPassword', px.password || '');
    input.value = '';
    $('#editorErr').textContent = '';
    toast('已识别代理配置');
  } catch (err) {
    $('#editorErr').textContent = err.message;
  }
}

$('#proxyQuick').addEventListener('change', parseQuickProxy);
$('#proxyQuick').addEventListener('paste', () => setTimeout(parseQuickProxy, 0));

/* ------------------------------ 批量操作 & Cookie ------------------------------ */

document.addEventListener('change', (e) => {
  const chk = e.target.closest('input[data-select]');
  if (!chk) return;
  const id = chk.dataset.select;
  if (chk.checked) selectedIds.add(id);
  else selectedIds.delete(id);
  const card = chk.closest('.card');
  if (card) card.classList.toggle('selected', chk.checked);
  syncBatchBar();
});

$('#chkSelectAll').addEventListener('change', (e) => {
  const list = visibleProfiles();
  for (const p of list) {
    if (e.target.checked) selectedIds.add(p.id);
    else selectedIds.delete(p.id);
  }
  render();
});

$('#btnBatchLaunch').addEventListener('click', async () => {
  const ids = [...selectedIds];
  if (!ids.length) return;
  const btn = $('#btnBatchLaunch');
  btn.disabled = true;
  let okCount = 0;
  let errCount = 0;
  toast('正在批量启动 ' + ids.length + ' 个环境…');
  for (const id of ids) {
    try {
      await api('/api/profiles/' + id + '/launch', { method: 'POST', body: {} });
      okCount++;
    } catch {
      errCount++;
    }
  }
  await load(true);
  toast('批量启动完成：成功 ' + okCount + (errCount ? '，失败 ' + errCount : ''), errCount > 0);
});

$('#btnBatchStop').addEventListener('click', async () => {
  const ids = [...selectedIds];
  if (!ids.length) return;
  const btn = $('#btnBatchStop');
  btn.disabled = true;
  let okCount = 0;
  for (const id of ids) {
    try {
      const r = await api('/api/profiles/' + id + '/stop', { method: 'POST', body: {} });
      if (r && r.ok) okCount++;
    } catch {
      /* ignore */
    }
  }
  await load(true);
  toast('已关闭 ' + okCount + ' 个运行中的环境');
});

$('#btnBatchDelete').addEventListener('click', async () => {
  const ids = [...selectedIds];
  if (!ids.length) return;
  if (!confirm('删除选中的 ' + ids.length + ' 个环境？它们的 Cookie 和登录态会一起删掉。')) return;
  const btn = $('#btnBatchDelete');
  btn.disabled = true;
  for (const id of ids) {
    try {
      await api('/api/profiles/' + id, { method: 'DELETE' });
      selectedIds.delete(id);
    } catch {
      /* ignore */
    }
  }
  await load(true);
  toast('已删除选中环境');
});

$('#btnBatchNew').addEventListener('click', () => {
  renderPresetSelect();
  $('#batchErr').textContent = '';
  $('#batchName').value = '';
  $('#batchGroup').value = '';
  $('#batchCountInput').value = '';
  $('#batchProxies').value = '';
  $('#batchAutoGeo').checked = false;
  $('#batchDlg').showModal();
});

$('#btnCancelBatch').addEventListener('click', () => $('#batchDlg').close());

$('#btnSubmitBatch').addEventListener('click', async () => {
  const btn = $('#btnSubmitBatch');
  $('#batchErr').textContent = '';
  btn.disabled = true;
  try {
    const r = await api('/api/profiles/batch', {
      method: 'POST',
      body: {
        preset: $('#batchPreset').value,
        name: $('#batchName').value.trim(),
        group: $('#batchGroup').value.trim(),
        count: $('#batchCountInput').value ? Number($('#batchCountInput').value) : 0,
        proxiesText: $('#batchProxies').value,
        autoGeo: $('#batchAutoGeo').checked,
      },
    });
    $('#batchDlg').close();
    await load(true);
    toast('已批量创建 ' + r.count + ' 个环境');
  } catch (err) {
    $('#batchErr').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

async function openCookieDlg(profile) {
  cookieProfileId = profile.id;
  cachedCookies = [];
  $('#cookieTitle').textContent = 'Cookie 管理 · ' + profile.name;
  $('#cookieInfo').textContent = '正在读取 Cookie（未启动环境首次读取会稍慢）…';
  $('#cookieText').value = '';
  $('#cookieErr').textContent = '';
  $('#cookieDlg').showModal();
  try {
    const r = await api('/api/profiles/' + encodeURIComponent(profile.id) + '/cookies');
    cachedCookies = r.cookies || [];
    $('#cookieInfo').textContent = '当前共有 ' + cachedCookies.length + ' 条 Cookie';
  } catch (err) {
    $('#cookieInfo').textContent = '读取失败';
    $('#cookieErr').textContent = err.message;
  }
}

$('#btnCloseCookie').addEventListener('click', () => $('#cookieDlg').close());

$('#btnCopyCookies').addEventListener('click', async () => {
  const json = JSON.stringify(cachedCookies, null, 2);
  try {
    await navigator.clipboard.writeText(json);
    toast('已复制 ' + cachedCookies.length + ' 条 Cookie 到剪贴板');
  } catch {
    $('#cookieText').value = json;
    toast('已填充到下方输入框，请手动复制');
  }
});

$('#btnDownloadCookies').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(cachedCookies, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'cookies-' + (cookieProfileId || 'profile') + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('#btnPickCookieFile').addEventListener('click', () => $('#cookieFile').click());
$('#cookieFile').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  $('#cookieText').value = await f.text();
});

$('#btnImportCookies').addEventListener('click', async () => {
  if (!cookieProfileId) return;
  const text = $('#cookieText').value.trim();
  if (!text) {
    $('#cookieErr').textContent = '请粘贴或选择要导入的 Cookie';
    return;
  }
  const btn = $('#btnImportCookies');
  btn.disabled = true;
  $('#cookieErr').textContent = '';
  try {
    const r = await api('/api/profiles/' + encodeURIComponent(cookieProfileId) + '/cookies', {
      method: 'POST',
      body: { text },
    });
    toast('已导入 ' + r.imported + ' 条 Cookie');
    const refreshed = await api('/api/profiles/' + encodeURIComponent(cookieProfileId) + '/cookies');
    cachedCookies = refreshed.cookies || [];
    $('#cookieInfo').textContent = '当前共有 ' + cachedCookies.length + ' 条 Cookie';
    $('#cookieText').value = '';
  } catch (err) {
    $('#cookieErr').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('#btnSyncGeo').addEventListener('click', async () => {
  const btn = $('#btnSyncGeo');
  const px = readEditor().proxy;
  if (!px || px.type === 'none' || !px.host || !px.port) {
    $('#editorErr').textContent = '请先填写代理类型、主机和端口';
    return;
  }
  btn.disabled = true;
  btn.textContent = '检测中…';
  $('#editorErr').textContent = '';
  try {
    const r = await api('/api/proxy-check', {
      method: 'POST',
      body: { profileId: editingId, proxy: px },
    });
    if (!r.ok) {
      $('#editorErr').textContent = r.error || '代理不可用';
      return;
    }
    if (r.timezone) setVal('timezone', r.timezone);
    if (r.suggestedLocale) {
      setVal('locale', r.suggestedLocale.locale);
      setVal('languages', r.suggestedLocale.languages.join(','));
    }
    pendingGeo =
      typeof r.lat === 'number' && typeof r.lon === 'number'
        ? { lat: r.lat, lon: r.lon, ip: r.ip }
        : r.ip
          ? { ip: r.ip }
          : undefined;
    toast('已对齐出口 ' + r.ip + '（' + [r.countryCode || r.country, r.timezone].filter(Boolean).join(' · ') + '）');
  } catch (err) {
    $('#editorErr').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '测代理并对齐地区';
  }
});

function openAgentGuide() {
  const cli = state.agentCli || { command: 'fb.exe', mcpArgs: ['mcp'], isPackaged: true };
  const q = (s) => (/\s/.test(String(s)) ? '"' + String(s) + '"' : String(s));
  const fullCmd = [cli.command, ...(cli.mcpArgs || ['mcp'])].map(q).join(' ');
  const bin = cli.isPackaged ? q(cli.command) : 'node src/index.js';

  $('#codeClaude').textContent = 'claude mcp add lite-fingerprint -- ' + fullCmd;
  $('#codeCodex').textContent =
    '[mcp_servers.lite-fingerprint]\ncommand = ' +
    JSON.stringify(cli.command) +
    '\nargs = ' +
    JSON.stringify(cli.mcpArgs || ['mcp']);
  $('#codeMcpJson').textContent = JSON.stringify(
    {
      mcpServers: {
        'lite-fingerprint': {
          command: cli.command,
          args: cli.mcpArgs || ['mcp'],
        },
      },
    },
    null,
    2
  );
  $('#codeCli').textContent = [
    '# 1) 查看并启动环境',
    bin + ' list --json',
    bin + ' launch <id> --json',
    '',
    '# 2) 打开网页并提取页面正文与 @e1/@e2 可交互元素引用',
    bin + ' goto <id> https://example.com/signup --json',
    bin + ' snapshot <id> --json',
    '',
    '# 3) 用原生可信事件操控元素；遇到人机验证 (blockedByChallenge=true) 停手并切到前台请人工完成',
    bin + ' fill <id> @e1 "alice@example.com" --json',
    bin + ' click <id> @e2 --json',
    bin + ' focus <id> --json',
  ].join('\n');
  $('#agentDlg').showModal();
}

$('#btnAgentGuide').addEventListener('click', openAgentGuide);
$('#btnCloseAgent').addEventListener('click', () => $('#agentDlg').close());
$('#agentDlg').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy-target]');
  if (!btn) return;
  const el = document.querySelector(btn.dataset.copyTarget);
  if (!el) return;
  try {
    await navigator.clipboard.writeText(el.textContent);
    toast('已复制到剪贴板');
  } catch {
    toast('复制失败，请手动选中复制', true);
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
