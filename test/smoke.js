'use strict';
/**
 * 冒烟测试：不依赖任何测试框架。
 *   node test/smoke.js
 * 会真的启动两个 Chrome 环境、读回指纹、做断言，最后全部关掉。
 */
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFileSync, spawnSync } = require('node:child_process');

// 测试不碰生产数据：整个 data 目录指到临时目录
process.env.FB_DATA = process.env.FB_DATA || path.join(os.tmpdir(), 'fb-smoke-' + process.pid);

const store = require('../src/store');
const launcher = require('../src/launch');
const { CDP } = require('../src/cdp');
const { createRelay } = require('../src/proxy');
const { findBrowser } = require('../src/browser');

let pass = 0;
const failures = [];

function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log('  \x1b[32m✓\x1b[0m ' + label);
  } else {
    failures.push(label + (extra ? ' → ' + JSON.stringify(extra) : ''));
    console.log('  \x1b[31m✗\x1b[0m ' + label + (extra ? ' → ' + JSON.stringify(extra) : ''));
  }
}

function eq(actual, expected, label) {
  ok(actual === expected, label, { expected, actual });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 收掉临时数据目录（浏览器都关掉之后才能删干净） */
function cleanupData() {
  try {
    fs.rmSync(process.env.FB_DATA, { recursive: true, force: true });
  } catch {
    /* 被占用就留着，反正下次是新的临时目录 */
  }
}

/* ----------------------------- 1. 静态自检 ----------------------------- */

function staticChecks() {
  console.log('\n[1] 静态自检');
  const chrome = findBrowser();
  ok(!!chrome, '找到 Chromium 内核: ' + (chrome || ''));
  ok(typeof WebSocket === 'function', 'Node 内置 WebSocket 可用（CDP 无需第三方包）');

  const profile = {
    seed: 'testseed',
    hardwareConcurrency: 12,
    deviceMemory: 8,
    maxTouchPoints: 0,
    screen: { width: 2560, height: 1440, availHeight: 1400, colorDepth: 24, pixelRatio: 1 },
    webglVendor: 'Google Inc. (AMD)',
    webglRenderer: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    canvasNoise: true,
    audioNoise: true,
    webrtc: 'proxy',
  };
  let src = '';
  try {
    src = launcher.buildInjectionSource(profile, '141.0.7390.55');
    ok(src.length > 500, '注入脚本生成成功（' + src.length + ' 字节）');
  } catch (e) {
    ok(false, '注入脚本生成失败: ' + e.message);
    return;
  }
  ok(!src.includes('__CFG__'), '__CFG__ 占位符已被替换');
  ok(src.includes('2560') && src.includes('Radeon RX 6600'), '指纹参数已写入脚本');
  ok(launcher.buildUserAgent(profile, '141.0.7390.55').includes('Chrome/141.0.0.0'), 'UA 用 Chrome 的 reduction 形态（完整版本只在 UA-CH 里）');

  /* 字体白名单 / WebGL 档位 */
  const macCfg = launcher.buildConfig({ platform: 'mac', seed: 's' });
  const winCfg = launcher.buildConfig({ platform: 'win', seed: 's' });
  ok(Array.isArray(macCfg.fontWhitelist) && macCfg.fontWhitelist.includes('PingFang SC'), 'mac 指纹带 macOS 字体白名单');
  ok(!macCfg.fontWhitelist.includes('Microsoft YaHei'), 'mac 白名单不含 Windows 专属字体');
  ok(winCfg.fontWhitelist.includes('Microsoft YaHei'), 'win 白名单含微软雅黑');
  ok(src.includes('fontWhitelist') || src.includes('MAX_TEXTURE_SIZE') || src.includes('0x0d33'), '字体/WebGL 补丁已注入');

  /* 克隆 / 导入导出 */
  const cloneSrc = store.create({
    name: 'clone-src',
    group: 'g1',
    proxy: { type: 'http', host: '1.1.1.1', port: '8080', username: 'u', password: 'secret123' },
  });
  const copy = store.clone(cloneSrc.id);
  ok(copy && copy.id !== cloneSrc.id, '克隆产生新 id');
  ok(copy && copy.seed !== cloneSrc.seed, '克隆换了新 seed（Canvas/Audio 噪声跟着变）');
  ok(copy && copy.group === 'g1' && copy.proxy.host === '1.1.1.1', '克隆保留分组与代理配置');

  const exported = store.exportAll();
  const exportedJson = JSON.stringify(exported);
  ok(exported.length >= 2, '导出包含所有环境');
  ok(!exportedJson.includes('secret123'), '导出不含代理密码');
  ok(!exportedJson.includes('"createdAt"'), '导出不含时间戳');

  const imported = store.importAll([
    { name: 'imp1', group: 'g2', seed: 'x', proxy: { type: 'socks5', host: '2.2.2.2', port: '1080', password: 'drop-me' } },
  ]);
  ok(imported.length === 1 && !!imported[0].id, '导入分配了新 id');
  ok(imported[0].group === 'g2', '导入保留分组');
  ok(imported[0].proxy.password === '', '导入清空代理密码');
  ok(store.list().filter((p) => p.name.indexOf('imp1') >= 0).length === 1, '导入的环境已落库');

  for (const id of [cloneSrc.id, copy.id, imported[0].id]) store.remove(id);

  /* CLI 工具：预设 / 代理串 */
  const cliutil = require('../src/cliutil');
  ok(cliutil.getPreset('us-shop').timezone === 'America/New_York', '预设 us-shop 的时区是纽约');
  ok(cliutil.getPreset('jp-shop').languages[0] === 'ja-JP', '预设 jp-shop 的主语言是 ja-JP');
  let threw = false;
  try {
    cliutil.getPreset('nope');
  } catch {
    threw = true;
  }
  ok(threw, '未知预设会报错');

  const px1 = cliutil.parseProxyLine('http://u:p@1.2.3.4:8080');
  ok(px1 && px1.type === 'http' && px1.host === '1.2.3.4' && px1.password === 'p', '代理串解析：URL 形式');
  const px2 = cliutil.parseProxyLine('socks5://1.2.3.4:1080');
  ok(px2 && px2.type === 'socks5' && px2.port === '1080', '代理串解析：socks5 URL');
  const px3 = cliutil.parseProxyLine('1.2.3.4:8080:user:pass');
  ok(px3 && px3.username === 'user' && px3.password === 'pass', '代理串解析：host:port:user:pass');
  ok(cliutil.parseProxies('# 注释\nhttp://a.b:1\n\n1.2.3.4:80').length === 2, '代理文件：忽略注释和空行');

  const linuxFp = store.randomFingerprint('linux');
  ok(
    !/Direct3D|D3D11/i.test(linuxFp.webglRenderer) && /OpenGL|Mesa/i.test(linuxFp.webglRenderer),
    'Linux 平台随机出 OpenGL/Mesa 渲染器（不出 D3D11）',
    linuxFp.webglRenderer
  );
  eq(
    store.normalizeScreen({ width: 1920, height: 1080, availHeight: 728 }, 'win').availHeight,
    1040,
    'normalizeScreen 自动修复异常小的 availHeight'
  );
}

/* ---------------------------- 2. 代理中继自检 ---------------------------- */

function testRelay() {
  return new Promise((resolve) => {
    console.log('\n[2] 代理中继（带认证的 HTTP 上游）');

    const echo = net.createServer((s) => s.pipe(s));
    echo.listen(0, '127.0.0.1', async () => {
      const echoPort = echo.address().port;

      const upstream = http.createServer();
      upstream.on('connect', (req, socket, head) => {
        const expect = 'Basic ' + Buffer.from('user:pass').toString('base64');
        if (req.headers['proxy-authorization'] !== expect) {
          socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
          return;
        }
        const m = /^([^:]+):(\d+)$/.exec(req.url);
        if (!m) {
          socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
          return;
        }
        const up = net.connect(Number(m[2]), m[1], () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head && head.length) up.write(head);
          up.pipe(socket);
          socket.pipe(up);
        });
        up.on('error', () => socket.destroy());
      });
      upstream.listen(0, '127.0.0.1', async () => {
        const upstreamPort = upstream.address().port;

        const throughRelay = (relayPort) =>
          new Promise((res) => {
            const sock = net.connect(relayPort, '127.0.0.1', () => {
              sock.write(
                'CONNECT 127.0.0.1:' + echoPort + ' HTTP/1.1\r\nHost: 127.0.0.1:' + echoPort + '\r\n\r\n'
              );
            });
            let buf = Buffer.alloc(0);
            let tunneled = false;
            const timer = setTimeout(() => res({ ok: false, reason: '超时' }), 5000);
            sock.on('data', (c) => {
              buf = Buffer.concat([buf, c]);
              if (!tunneled) {
                const idx = buf.indexOf('\r\n\r\n');
                if (idx < 0) return;
                const head = buf.subarray(0, idx).toString('latin1');
                tunneled = true;
                if (!/ 200 /.test(head.split('\r\n')[0])) {
                  clearTimeout(timer);
                  sock.destroy();
                  return res({ ok: false, reason: head.split('\r\n')[0] });
                }
                buf = buf.subarray(idx + 4);
                sock.write('ping-through-relay');
              }
              if (tunneled && buf.includes(Buffer.from('ping-through-relay'))) {
                clearTimeout(timer);
                sock.destroy();
                res({ ok: true });
              }
            });
            sock.on('error', () => {
              clearTimeout(timer);
              res({ ok: false, reason: 'socket error' });
            });
          });

        try {
          const relay = await createRelay({
            type: 'http',
            host: '127.0.0.1',
            port: upstreamPort,
            username: 'user',
            password: 'pass',
          });
          const r1 = await throughRelay(relay.port);
          ok(r1.ok, '正确账号密码：中继成功建立隧道并把数据透传回来', r1);

          await relay.close();

          const badRelay = await createRelay({
            type: 'http',
            host: '127.0.0.1',
            port: upstreamPort,
            username: 'user',
            password: 'wrong',
          });
          const r2 = await throughRelay(badRelay.port);
          ok(!r2.ok, '密码错误：中继拒绝（不会静默直连）', r2);
          await badRelay.close();
        } catch (e) {
          ok(false, '中继测试异常: ' + e.message);
        } finally {
          upstream.close();
          echo.close();
          resolve();
        }
      });
    });
  });
}

/* ------------------------- 2b. SOCKS5 上游中继自检 ------------------------- */

/** 一个够用的 SOCKS5 服务端桩：支持可选用户名密码 + CONNECT */
function socks5Mock(requireAuth) {
  return new Promise((resolve) => {
    const srv = net.createServer((client) => {
      let stage = 0;
      let buf = Buffer.alloc(0);
      client.on('error', () => {});
      const onData = (chunk) => {
        if (chunk && chunk.length) buf = Buffer.concat([buf, chunk]);
        if (stage === 0) {
          if (buf.length < 2) return;
          const n = buf[1];
          if (buf.length < 2 + n) return;
          const methods = [...buf.subarray(2, 2 + n)];
          buf = buf.subarray(2 + n);
          if (requireAuth) {
            if (!methods.includes(2)) return client.end(Buffer.from([5, 0xff]));
            client.write(Buffer.from([5, 2]));
            stage = 1;
          } else {
            client.write(Buffer.from([5, 0]));
            stage = 2;
          }
          return onData(null);
        }
        if (stage === 1) {
          if (buf.length < 2) return;
          const ulen = buf[1];
          if (buf.length < 2 + ulen + 1) return;
          const user = buf.subarray(2, 2 + ulen).toString();
          const plen = buf[2 + ulen];
          if (buf.length < 3 + ulen + plen) return;
          const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
          buf = buf.subarray(3 + ulen + plen);
          if (user !== 'u' || pass !== 'p') return client.end(Buffer.from([1, 1]));
          client.write(Buffer.from([1, 0]));
          stage = 2;
          return onData(null);
        }
        if (stage === 2) {
          if (buf.length < 5) return;
          const atyp = buf[3];
          let host;
          let need;
          if (atyp === 1) {
            need = 10;
            if (buf.length < need) return;
            host = [...buf.subarray(4, 8)].join('.');
          } else if (atyp === 3) {
            const l = buf[4];
            need = 5 + l + 2;
            if (buf.length < need) return;
            host = buf.subarray(5, 5 + l).toString();
          } else {
            return client.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]));
          }
          const port = buf.readUInt16BE(need - 2);
          buf = buf.subarray(need);
          stage = 3;
          client.removeListener('data', onData);
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          const up = net.connect(port, host, () => {
            if (buf.length) up.write(buf);
            up.pipe(client);
            client.pipe(up);
          });
          up.on('error', () => client.destroy());
          return;
        }
      };
      client.on('data', onData);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function testSocks5Relay() {
  return new Promise((resolve) => {
    console.log('\n[2b] 代理中继（SOCKS5 上游，带用户名密码）');
    const echo = net.createServer((s) => s.pipe(s));
    echo.listen(0, '127.0.0.1', async () => {
      const echoPort = echo.address().port;
      const tunnel = (relayPort) =>
        new Promise((res) => {
          const sock = net.connect(relayPort, '127.0.0.1', () => {
            sock.write('CONNECT 127.0.0.1:' + echoPort + ' HTTP/1.1\r\nHost: x\r\n\r\n');
          });
          let buf = Buffer.alloc(0);
          let tunneled = false;
          const timer = setTimeout(() => res({ ok: false, reason: '超时' }), 5000);
          sock.on('data', (c) => {
            buf = Buffer.concat([buf, c]);
            if (!tunneled) {
              const idx = buf.indexOf('\r\n\r\n');
              if (idx < 0) return;
              const head = buf.subarray(0, idx).toString('latin1');
              tunneled = true;
              if (!/ 200 /.test(head.split('\r\n')[0])) {
                clearTimeout(timer);
                sock.destroy();
                return res({ ok: false, reason: head.split('\r\n')[0] });
              }
              buf = buf.subarray(idx + 4);
              sock.write('ping-socks5');
            }
            if (tunneled && buf.includes(Buffer.from('ping-socks5'))) {
              clearTimeout(timer);
              sock.destroy();
              res({ ok: true });
            }
          });
          sock.on('error', () => {
            clearTimeout(timer);
            res({ ok: false, reason: 'socket error' });
          });
        });

      const mock = await socks5Mock(true);
      try {
        const relay = await createRelay({
          type: 'socks5',
          host: '127.0.0.1',
          port: mock.address().port,
          username: 'u',
          password: 'p',
        });
        ok((await tunnel(relay.port)).ok, 'SOCKS5 正确账号密码：握手 + 隧道 + 数据透传都通');
        await relay.close();

        const bad = await createRelay({
          type: 'socks5',
          host: '127.0.0.1',
          port: mock.address().port,
          username: 'u',
          password: 'nope',
        });
        ok(!(await tunnel(bad.port)).ok, 'SOCKS5 密码错误：中继拒绝');
        await bad.close();
      } catch (e) {
        ok(false, 'SOCKS5 测试异常: ' + e.message);
      } finally {
        mock.close();
        echo.close();
        resolve();
      }
    });
  });
}

/* --------------------------- 3. 真实环境指纹自检 --------------------------- */

async function browserChecks() {
  console.log('\n[3] 真实启动 + 指纹读回');

  // 造两个指纹明显不同的环境
  const a = store.create({
    name: '测试A',
    platform: 'win',
    timezone: 'America/New_York',
    locale: 'en-US',
    languages: ['en-US', 'en'],
    hardwareConcurrency: 12,
    deviceMemory: 8,
    screen: { width: 2560, height: 1440, availHeight: 1400, colorDepth: 24, pixelRatio: 1 },
    webglVendor: 'Google Inc. (AMD)',
    webglRenderer: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    webrtc: 'proxy',
    seed: 'aaaa1111',
  });
  const b = store.create({
    name: '测试B',
    platform: 'win',
    timezone: 'Asia/Tokyo',
    locale: 'ja-JP',
    languages: ['ja-JP', 'ja', 'en-US', 'en'],
    hardwareConcurrency: 4,
    deviceMemory: 4,
    screen: { width: 1366, height: 768, availHeight: 728, colorDepth: 24, pixelRatio: 1 },
    webglVendor: 'Google Inc. (Intel)',
    webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    webrtc: 'disabled',
    seed: 'bbbb2222',
  });

  const cleanup = [];
  try {
    let t0 = Date.now();
    const infoA = await launcher.launch(a.id);
    ok(!!infoA.pid, '环境A启动成功（' + (Date.now() - t0) + 'ms，内核 ' + infoA.browserVersion + '）');
    cleanup.push(a.id);

    const ra = await launcher.probe(a.id);
    console.log('  ── 环境A 指纹 ──');
    console.log('     UA        ' + ra.userAgent);
    console.log('     platform  ' + ra.platform);
    console.log('     langs     ' + JSON.stringify(ra.languages));
    console.log('     tz/locale ' + ra.timezone + ' / ' + ra.locale);
    console.log('     screen    ' + JSON.stringify(ra.screen));
    console.log('     CPU/RAM   ' + ra.hardwareConcurrency + ' / ' + ra.deviceMemory);
    console.log('     canvas    ' + ra.canvasHash);
    console.log('     webgl     ' + ra.webglRenderer);
    console.log('     audio     ' + ra.audioHash);

    ok(ra.userAgent.includes('Windows NT 10.0'), 'UA 平台段是 Windows');
    ok(ra.injected === true, '指纹注入脚本已在页面里真正生效');
    ok(ra.userAgent.includes('Chrome/' + infoA.browserVersion.split('.')[0]), 'UA 版本号与本机内核一致');
    eq(ra.platform, 'Win32', 'navigator.platform = Win32');
    eq(ra.timezone, 'America/New_York', '时区被改为 America/New_York（Chromium 原生层）');
    eq(ra.locale, 'en-US', 'Locale 被改为 en-US');
    eq(JSON.stringify(ra.languages), JSON.stringify(['en-US', 'en']), 'navigator.languages 被覆盖');
    eq(ra.hardwareConcurrency, 12, 'CPU 核数被改为 12');
    eq(ra.deviceMemory, 8, '设备内存被改为 8GB（deviceMemory 的规范上限）');
    eq(ra.screen.width, 2560, 'screen.width = 2560');
    eq(ra.screen.height, 1440, 'screen.height = 1440');
    eq(ra.webglVendor, 'Google Inc. (AMD)', 'WebGL 厂商被覆盖');
    eq(ra.webglRenderer, 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'WebGL 渲染器被覆盖');
    eq(ra.webdriver, false, 'navigator.webdriver 为 false');
    ok(typeof ra.canvasHash === 'number' && ra.canvasHash !== 0, 'Canvas 指纹可读（' + ra.canvasHash + '）');
    ok(typeof ra.audioHash === 'number' && ra.audioHash > 0, 'Audio 指纹可读（' + ra.audioHash + '）');

    // 深度反检测审计：原型链无痕 + Web Worker + OffscreenCanvas + UA-CH + 语音 + matchMedia
    const auditRaw = await launcher.evaluateInProbePage(
      a.id,
      `(async () => {
        const hcDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'hardwareConcurrency');
        const tw = document.createElement('canvas').getContext('2d').measureText('abc');
        const worker = await new Promise((resolve) => {
          const code = [
            'const res = { hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };',
            'try { const oc = new OffscreenCanvas(32, 32); const gl = oc.getContext("webgl"); const ext = gl.getExtension("WEBGL_debug_renderer_info"); res.webglVendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null; res.webglRenderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null; } catch (e) { res.glErr = String(e); }',
            'postMessage(res);'
          ].join('\\n');
          const w = new Worker(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
          const t = setTimeout(() => resolve({ timeout: true }), 4000);
          w.onmessage = (e) => { clearTimeout(t); w.terminate(); resolve(e.data); };
          w.onerror = (e) => { clearTimeout(t); resolve({ err: e.message }); };
        });
        const uaCh = navigator.userAgentData
          ? await navigator.userAgentData.getHighEntropyValues(['brands', 'fullVersionList'])
          : null;
        let voices = speechSynthesis.getVoices();
        if (!voices.length) {
          await new Promise((r) => setTimeout(r, 400));
          voices = speechSynthesis.getVoices();
        }
        // 1) 跨 realm iframe toString（含 iframe 移除后双向检测）
        const ifr = document.createElement('iframe');
        document.body.appendChild(ifr);
        const ifrToString = ifr.contentWindow.Function.prototype.toString;
        const ifrToDataURL = ifr.contentWindow.HTMLCanvasElement.prototype.toDataURL;
        const crossRealmToStr = ifrToString.call(HTMLCanvasElement.prototype.toDataURL);
        ifr.remove();
        const reverseToStrAfterRemove = Function.prototype.toString.call(ifrToDataURL);

        // 2) Illegal invocation 与调用栈清洗
        let hcGetterThrows = false;
        try {
          hcDesc.get.call({});
        } catch (e) {
          hcGetterThrows = e instanceof TypeError;
        }
        let nullCallStack = '';
        try {
          HTMLCanvasElement.prototype.toDataURL.call(null);
        } catch (e) {
          nullCallStack = String(e.stack || e);
        }

        // 3) Canvas 纯色块陷阱（16x16 纯色矩形必须 0 噪点）
        const sc = document.createElement('canvas');
        sc.width = 16;
        sc.height = 16;
        const sctx = sc.getContext('2d');
        sctx.fillStyle = '#123456';
        sctx.fillRect(0, 0, 16, 16);
        const sd = sctx.getImageData(0, 0, 16, 16).data;
        let solidCorrupted = 0;
        for (let i = 0; i < sd.length; i += 4) {
          if (sd[i] !== 0x12 || sd[i + 1] !== 0x34 || sd[i + 2] !== 0x56) solidCorrupted++;
        }

        return JSON.stringify({
          hcGetterHasProto: hcDesc && hcDesc.get ? ('prototype' in hcDesc.get) : null,
          hcGetterName: hcDesc && hcDesc.get ? hcDesc.get.name : null,
          toDataURLHasProto: 'prototype' in HTMLCanvasElement.prototype.toDataURL,
          getImageDataLen: CanvasRenderingContext2D.prototype.getImageData.length,
          fnToStringHasProto: 'prototype' in Function.prototype.toString,
          textMetricsOwnProps: Object.getOwnPropertyNames(tw),
          worker,
          uaChBrandsLen: uaCh && uaCh.brands ? uaCh.brands.length : 0,
          uaChFullLen: uaCh && uaCh.fullVersionList ? uaCh.fullVersionList.length : 0,
          speechLeakCn: voices.some((v) => /Chinese \\(Simplified|Huihui|Kangkang|Yaoyao/i.test(String(v.name))),
          speechAllInstance: voices.every((v) => v instanceof SpeechSynthesisVoice),
          matchDeviceWidth: matchMedia('(device-width: 2560px)').matches,
          crossRealmToStr,
          reverseToStrAfterRemove,
          hcGetterThrows,
          nullCallStack,
          solidCorrupted
        });
      })()`
    );
    const audit = JSON.parse(auditRaw);
    eq(audit.hcGetterHasProto, false, '原型链 getter 无 prototype 属性（不可构造）');
    eq(audit.hcGetterName, 'get hardwareConcurrency', '原型链 getter .name 为 get hardwareConcurrency');
    eq(audit.toDataURLHasProto, false, '覆写方法 toDataURL 无 prototype 属性');
    eq(audit.getImageDataLen, 4, '覆写方法 getImageData.length 与原生一致（4）');
    eq(audit.fnToStringHasProto, false, 'Function.prototype.toString 无 prototype 属性');
    eq(audit.textMetricsOwnProps.length, 0, 'TextMetrics 实例无多余自有属性');
    eq(audit.worker.hardwareConcurrency, 12, 'Web Worker 内 hardwareConcurrency 与主线程一致（12）');
    eq(audit.worker.deviceMemory, 8, 'Web Worker 内 deviceMemory 与主线程一致（8）');
    eq(audit.worker.timezone, 'America/New_York', 'Web Worker 内时区与主线程一致');
    eq(audit.worker.webglVendor, 'Google Inc. (AMD)', 'Worker OffscreenCanvas WebGL 厂商一致');
    ok(
      String(audit.worker.webglRenderer || '').includes('Radeon RX 6600'),
      'Worker OffscreenCanvas WebGL 渲染器一致',
      audit.worker
    );
    ok(
      audit.uaChBrandsLen >= 3 && audit.uaChBrandsLen === audit.uaChFullLen,
      'UA-CH brands 与 fullVersionList 长度一致（' + audit.uaChBrandsLen + '）',
      audit
    );
    eq(audit.speechLeakCn, false, 'Windows en-US 环境 speechSynthesis 不泄露中文 SAPI 语音');
    eq(audit.speechAllInstance, true, 'speechSynthesis 语音对象保持 SpeechSynthesisVoice 实例');
    eq(audit.matchDeviceWidth, true, 'matchMedia(device-width: 2560px) 与伪装屏幕一致');
    eq(
      audit.crossRealmToStr,
      'function toDataURL() { [native code] }',
      '跨 realm iframe 调用 Function.prototype.toString 仍返回 [native code]'
    );
    eq(
      audit.reverseToStrAfterRemove,
      'function toDataURL() { [native code] }',
      'iframe 移除后父窗口反向调用 toString 仍返回 [native code]'
    );
    eq(audit.hcGetterThrows, true, '非法 receiver 调用 getter 会抛出原生 TypeError: Illegal invocation');
    ok(
      audit.nullCallStack.includes('TypeError') && !audit.nullCallStack.includes('at toDataURL (<anonymous>:'),
      '异常调用栈已清洗，不暴露注入层包装帧',
      audit.nullCallStack
    );
    eq(audit.solidCorrupted, 0, 'Canvas 纯色块无像素被扰动（免疫 Solid-Fill 陷阱）');

    // 第二个环境：指纹必须完全不同
    t0 = Date.now();
    await launcher.launch(b.id);
    cleanup.push(b.id);
    ok(true, '环境B启动成功（' + (Date.now() - t0) + 'ms）');
    const rb = await launcher.probe(b.id);
    console.log('  ── 环境B 指纹 ──');
    console.log('     UA        ' + rb.userAgent);
    console.log('     tz/locale ' + rb.timezone + ' / ' + rb.locale);
    console.log('     CPU/RAM   ' + rb.hardwareConcurrency + ' / ' + rb.deviceMemory);
    console.log('     canvas    ' + rb.canvasHash);
    console.log('     webgl     ' + rb.webglRenderer);

    eq(rb.timezone, 'Asia/Tokyo', '环境B 时区 = Asia/Tokyo');
    eq(rb.hardwareConcurrency, 4, '环境B CPU = 4');
    ok(ra.canvasHash !== rb.canvasHash, '两个环境的 Canvas 指纹不同（噪声按环境隔离）', {
      a: ra.canvasHash,
      b: rb.canvasHash,
    });
    ok(ra.webglRenderer !== rb.webglRenderer, '两个环境的 WebGL 渲染器不同');
    ok(JSON.stringify(ra.languages) !== JSON.stringify(rb.languages), '两个环境的语言不同');

    // 同一环境重开：Canvas 指纹必须稳定（否则每次刷新都变＝异常）
    await launcher.stop(a.id);
    await sleep(600);
    await launcher.launch(a.id);
    const ra2 = await launcher.probe(a.id);
    eq(ra2.canvasHash, ra.canvasHash, '同一环境重启后 Canvas 指纹保持一致（确定性）');

    // 隔离性：Cookie 目录必须分开
    const dirA = store.profileDir(a.id);
    const dirB = store.profileDir(b.id);
    ok(dirA !== dirB, '两个环境的 user-data-dir 互相独立');
    ok(
      (await import('node:fs')).existsSync(path.join(dirA, 'Default', 'Cookies')) ||
        (await import('node:fs')).existsSync(path.join(dirA, 'Default', 'Network', 'Cookies')),
      '环境A 的 Cookie 库落在自己的目录里'
    );
  } catch (e) {
    ok(false, '浏览器测试异常: ' + e.message);
    if (process.env.DEBUG) console.error(e);
  } finally {
    for (const id of cleanup) await launcher.stop(id);
    await sleep(400);
    store.remove(a.id);
    store.remove(b.id);
  }
}

/* ------------------- 4. 请求头层验证（UA + Client Hints） ------------------- */
/**
 * 这是最要紧的一项：UA 和 Sec-CH-UA 是发在 HTTP 头里的，
 * 纯 JS 注入改不了，只有 CDP 原生层能做到。服务端看到的就是这个。
 */
async function headerChecks() {
  console.log('\n[4] 请求头层验证（UA + Client Hints，服务端视角）');
  const captured = [];
  const srv = http.createServer((req, res) => {
    captured.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>header probe</title><body>ok');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port + '/';

  // 故意选 macOS 指纹（本机是 Windows），这样"假装"和"真实"一眼能分出来
  const p = store.create({
    name: '测试-请求头',
    platform: 'mac',
    timezone: 'Asia/Tokyo',
    locale: 'ja-JP',
    languages: ['ja-JP', 'ja', 'en-US', 'en'],
  });
  try {
    await launcher.launch(p.id, { startUrl: url });
    await sleep(1200);
    const doc = captured.find((c) => c.url === '/');
    ok(!!doc, '捕获到主文档请求（共 ' + captured.length + ' 次请求）');
    if (doc) {
      const h = doc.headers;
      console.log('     User-Agent        ' + h['user-agent']);
      console.log('     Sec-CH-UA         ' + h['sec-ch-ua']);
      console.log('     CH-UA-Platform    ' + h['sec-ch-ua-platform']);
      console.log('     Accept-Language   ' + h['accept-language']);
      ok(/Macintosh; Intel Mac OS X/.test(h['user-agent'] || ''), 'User-Agent 请求头已伪装成 macOS');
      ok(/Chrome/.test(h['user-agent'] || ''), 'User-Agent 仍自称 Chrome（不是奇怪的假 UA）');
      ok((h['sec-ch-ua-platform'] || '').includes('macOS'), 'Sec-CH-UA-Platform 请求头 = macOS');
      ok((h['sec-ch-ua'] || '').includes('Chromium'), 'Sec-CH-UA 品牌列表存在且自洽');
      ok(/ja-JP/.test(h['accept-language'] || ''), 'Accept-Language 已按环境覆盖');
    }

    /* ---- 设备级标识：这两个是实测出来的真漏洞 ---- */
    const r = await launcher.probe(p.id);
    console.log('     声明平台        ' + p.platform + '（真实：' + process.platform + '）');
    console.log('     WebGL 声明      ' + p.webglVendor);
    console.log('     WebGPU 报告     ' + r.gpuVendor + ' / ' + r.gpuArch);
    console.log('     语音设备        ' + r.speechVoiceCount + ' 个，含 SAPI: ' + r.speechHasMicrosoft);
    console.log('     语音样例        ' + JSON.stringify((r.speechVoices || []).slice(0, 4)));

    ok(r.speechHasMicrosoft === false, '声明 macOS 后不再暴露 Windows SAPI 语音');
    ok(r.speechHasMac === true, '语音设备列表换成了 macOS 那一套');

    console.log('     字体探测        Arial=' + JSON.stringify(r.fontCheck && r.fontCheck.arial) +
      ' 微软雅黑=' + JSON.stringify(r.fontCheck && r.fontCheck.yahei) +
      ' 不存在字体=' + JSON.stringify(r.fontCheck && r.fontCheck.missing));
    console.log('     WebGL 能力      MAX_TEXTURE_SIZE=' + r.glMaxTextureSize);
    ok(r.fontCheck && r.fontCheck.arial === true, 'mac 环境里 Arial 仍可探测到');
    ok(r.fontCheck && r.fontCheck.yahei === false, 'mac 环境里查不到微软雅黑（字体列表按声明平台过滤）');
    ok(r.fontCheck && r.fontCheck.missing === false, '不存在的字体查不到');
    eq(r.glMaxTextureSize, 16384, 'WebGL 最大纹理与声明的 GPU 档位一致');
    if (r.gpuVendor !== undefined) {
      const declared = String(p.webglVendor || '');
      const expectGpu = /Apple/.test(declared)
        ? 'apple'
        : /Intel/.test(declared)
          ? 'intel'
          : /AMD/.test(declared)
            ? 'amd'
            : 'nvidia';
      eq(r.gpuVendor, expectGpu, 'WebGPU 的 GPU 家族与 WebGL 声明一致（不再泄露真实硬件）');
    } else {
      console.log('     （本机 WebGPU 不可用，跳过 GPU 一致性断言）');
    }

    const macAuditRaw = await launcher.evaluateInProbePage(
      p.id,
      `(() => {
        const sb = document.createElement('div');
        sb.style.cssText = 'width:100px;height:100px;overflow:scroll;position:absolute;top:-9999px';
        document.body.appendChild(sb);
        const scrollbarWidth = sb.offsetWidth - sb.clientWidth;
        sb.remove();
        return JSON.stringify({ scrollbarWidth });
      })()`
    );
    const macAudit = JSON.parse(macAuditRaw);
    eq(macAudit.scrollbarWidth, 0, 'macOS 环境启用原生 OverlayScrollbar，滚动条宽度为 0px');
  } catch (e) {
    ok(false, '请求头测试异常: ' + e.message);
  } finally {
    await launcher.stop(p.id);
    await sleep(300);
    srv.close();
    store.remove(p.id);
  }
}

/* ------------------ 5. CLI 守护进程与新标签页持久性验证 ------------------ */

async function cliDaemonChecks() {
  console.log('\n[5] CLI 守护进程与新标签页持久性验证');
  const indexJs = path.resolve(__dirname, '..', 'src', 'index.js');
  const cliData = path.join(os.tmpdir(), 'fb-cli-smoke-' + process.pid);
  const env = { ...process.env, FB_DATA: cliData };
  let id = null;

  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>cli new tab</title><body>ok</body>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const testUrl = 'http://127.0.0.1:' + srv.address().port + '/';

  try {
    const helpRes = spawnSync(process.execPath, [indexJs, 'create', '--help'], {
      env,
      encoding: 'utf8',
      timeout: 10000,
    });
    eq(helpRes.status, 0, 'create --help 退出码为 0');
    ok((helpRes.stdout || '').includes('CLI'), 'create --help 输出帮助文本而不启动控制台');
    ok(!fs.existsSync(path.join(cliData, 'profiles.json')), 'create --help 不会误创建环境数据');

    const created = JSON.parse(
      execFileSync(process.execPath, [indexJs, 'create', '--preset', 'us-west', '--name', 'cli测试', '--json'], {
        env,
        encoding: 'utf8',
        timeout: 10000,
      })
    );
    id = created.created && created.created[0] && created.created[0].id;
    const expectGpu = created.created && created.created[0] && created.created[0].webglRenderer;
    const expectHc = created.created && created.created[0] && created.created[0].hardwareConcurrency;
    ok(!!id, 'CLI create --preset us-west 成功（' + id + '）');

    const launched = JSON.parse(
      execFileSync(process.execPath, [indexJs, 'launch', id, '--json'], {
        env,
        encoding: 'utf8',
        timeout: 45000,
      })
    );
    const port = launched.results && launched.results[0] && launched.results[0].port;
    ok(launched.ok === true && !!port, 'CLI launch 返回成功并带回调试端口 ' + port);

    // launch 进程已退出后，新建标签页仍须由后台守护进程持续维持完整伪装
    const verRes = await fetch('http://127.0.0.1:' + port + '/json/version');
    const { webSocketDebuggerUrl } = await verRes.json();
    const cdp = await CDP.connect(webSocketDebuggerUrl, 8000);
    let newTid = null;
    try {
      const createdTab = await cdp.send('Target.createTarget', { url: 'about:blank' });
      newTid = createdTab.targetId;
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: newTid, flatten: true });
      await cdp.try_('Page.enable', {}, sessionId);

      // 给 daemon 的 autoAttach 事件留一点处理间隙，然后导航到真实本地页面
      await sleep(300);
      let loaded = false;
      const onLoad = (params, sid) => {
        if (sid === sessionId) loaded = true;
      };
      cdp.on('Page.loadEventFired', onLoad);
      await cdp.send('Page.navigate', { url: testUrl }, sessionId);
      const t0 = Date.now();
      while (!loaded && Date.now() - t0 < 8000) await sleep(50);
      cdp.removeListener('Page.loadEventFired', onLoad);

      const ev = await cdp.send(
        'Runtime.evaluate',
        {
          expression: `(() => {
            const gl = document.createElement('canvas').getContext('webgl');
            const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
            return JSON.stringify({
              tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
              hc: navigator.hardwareConcurrency,
              gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null
            });
          })()`,
          returnByValue: true,
        },
        sessionId
      );
      const tabVal = JSON.parse(ev.result.value);
      eq(tabVal.tz, 'America/Los_Angeles', 'CLI launch 退出后新开标签页仍保持 America/Los_Angeles 时区');
      eq(tabVal.hc, expectHc, 'CLI launch 退出后新开标签页仍保持配置的 CPU 核数');
      eq(tabVal.gpu, expectGpu, 'CLI launch 退出后新开标签页仍保持伪装 WebGL 渲染器');
    } finally {
      if (newTid) await cdp.try_('Target.closeTarget', { targetId: newTid });
      cdp.close();
    }

    const stopped = JSON.parse(
      execFileSync(process.execPath, [indexJs, 'stop', id, '--json'], {
        env,
        encoding: 'utf8',
        timeout: 20000,
      })
    );
    eq(stopped.ok, true, 'CLI stop 成功关闭守护进程托管的环境');
  } catch (e) {
    ok(false, 'CLI 守护进程测试异常: ' + (e && e.message ? e.message : e));
  } finally {
    try {
      const cinfo = JSON.parse(fs.readFileSync(path.join(cliData, 'console.json'), 'utf8'));
      if (cinfo && cinfo.port) {
        await fetch('http://127.0.0.1:' + cinfo.port + '/api/shutdown', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }).catch(() => {});
        await sleep(350);
      }
    } catch {
      /* ignore */
    }
    srv.close();
    try {
      fs.rmSync(cliData, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------- 跑起来 ------------------------------- */

(async () => {
  console.log('轻量指纹浏览器 · 冒烟测试');
  staticChecks();
  await testRelay();
  await testSocks5Relay();
  await browserChecks();
  await headerChecks();
  await cliDaemonChecks();

  console.log('\n' + '─'.repeat(58));
  if (failures.length) {
    console.log('\x1b[31m失败 ' + failures.length + ' 项\x1b[0m，通过 ' + pass + ' 项');
    for (const f of failures) console.log('  · ' + f);
    cleanupData();
    process.exit(1);
  }
  console.log('\x1b[32m全部通过\x1b[0m（' + pass + ' 项断言）');
  cleanupData();
  process.exit(0);
})();
