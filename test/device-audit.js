'use strict';
/**
 * 一次性探测：看看真实 Chrome 到底把哪些"设备级"信息暴露给了网页。
 * 用来决定哪些值得伪装、哪些根本摸不到。
 *   node test/_device-probe.js
 */
const http = require('node:http');
const store = require('../src/store');
const launcher = require('../src/launch');

const EXPR = `(async () => {
  const out = {};
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  // 1. 媒体设备：deviceId / groupId / label —— 网页侧最接近"设备码"的东西
  try {
    const ds = await navigator.mediaDevices.enumerateDevices();
    out.mediaDeviceCount = ds.length;
    out.mediaDeviceIdNonEmpty = ds.filter(d => d.deviceId).length;
    out.mediaDevices = ds.map(d => ({ kind: d.kind, label: d.label, deviceId: d.deviceId, groupId: d.groupId }));
  } catch (e) { out.mediaError = String(e); }

  // 2. 语音合成设备：Windows 是 SAPI 语音，macOS 是另一套 —— 很强的系统标识
  try {
    let vs = speechSynthesis.getVoices();
    if (!vs.length) { await wait(600); vs = speechSynthesis.getVoices(); }
    out.speechVoiceCount = vs.length;
    out.speechVoices = vs.slice(0, 10).map(v => v.name + ' [' + v.lang + ']');
  } catch (e) { out.speechError = String(e); }

  // 3. Client Hints 高熵值（服务端也能看到一部分）
  try {
    out.uaHighEntropy = await navigator.userAgentData.getHighEntropyValues(
      ['platform','platformVersion','architecture','bitness','model','uaFullVersion','wow64']
    );
  } catch (e) { out.chError = String(e); }

  // 4. WebGPU adapter info：GPU 设备级标识
  try {
    out.hasGPU = !!navigator.gpu;
    if (navigator.gpu) {
      const a = await navigator.gpu.requestAdapter();
      if (a) {
        out.gpuInfo = a.info ? { vendor: a.info.vendor, architecture: a.info.architecture, device: a.info.device, description: a.info.description } : null;
      } else out.gpuInfo = null;
    }
  } catch (e) { out.gpuError = String(e); }

  // 5. 音频硬件参数
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    out.audioSampleRate = ac.sampleRate;
    out.audioBaseLatency = ac.baseLatency;
    out.audioMaxChannels = ac.destination.maxChannelCount;
    ac.close();
  } catch (e) { out.audioErr = String(e); }

  // 6. 内存 / 插件 / 连接
  out.perfMemoryLimit = performance.memory ? performance.memory.jsHeapSizeLimit : null;
  out.plugins = [...navigator.plugins].map(p => p.name);
  out.pdfViewerEnabled = navigator.pdfViewerEnabled;
  out.doNotTrack = navigator.doNotTrack;
  out.connection = navigator.connection
    ? { effectiveType: navigator.connection.effectiveType, rtt: navigator.connection.rtt, downlink: navigator.connection.downlink }
    : null;

  // 7. WebGL 更深的能力参数
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    out.glMaxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    out.glMaxViewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    out.glExtCount = gl.getSupportedExtensions().length;
    out.glRenderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
  } catch (e) { out.glError = String(e); }

  try {
    const est = await navigator.storage.estimate();
    out.storageQuota = est.quota;
  } catch (e) {}

  return JSON.stringify(out, null, 1);
})()`;

(async () => {
  const p = store.create({ name: 'device-probe', platform: 'win', timezone: 'Asia/Shanghai' });
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>probe</title><body>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port + '/';
  try {
    await launcher.launch(p.id, { startUrl: url });
    await new Promise((r) => setTimeout(r, 1500));
    const raw = await launcher.evaluateInProbePage(p.id, EXPR);
    console.log(raw);
  } finally {
    await launcher.stop(p.id);
    srv.close();
    store.remove(p.id);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
