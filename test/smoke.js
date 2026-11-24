'use strict';
/**
 * 冒烟测试：不依赖任何测试框架。
 *   node test/smoke.js
 * 会真的启动两个 Chrome 环境、读回指纹、做断言，最后全部关掉。
 */
const net = require('node:net');
const dgram = require('node:dgram');
const tls = require('node:tls');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

// 测试不碰生产数据：整个 data 目录指到临时目录
process.env.FB_DATA = process.env.FB_DATA || path.join(os.tmpdir(), 'fb-smoke-' + process.pid);

const store = require('../src/store');
const launcher = require('../src/launch');
const agent = require('../src/agent');
const { CDP } = require('../src/cdp');
const { createRelay } = require('../src/proxy');
const browser = require('../src/browser');
const { findBrowser } = browser;
const { createServer } = require('../src/server');
const { resolveCount } = require('../src/cliutil');
const { profileConfigErrors, profileWarnings } = require('../src/profile-validation');

let pass = 0;
let skipped = 0;
const failures = [];
let baselineCapabilities = null;

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

function skip(label, reason) {
  skipped++;
  console.log('  \x1b[33m↷ SKIP\x1b[0m ' + label + '：' + reason);
}

function webglAvailable(surface) {
  if (!baselineCapabilities) {
    ok(false, '未获得未注入浏览器能力基线，不能将 WebGL 断言当作环境跳过');
    return false;
  }
  if (!baselineCapabilities[surface]) {
    skip(surface + ' WebGL 断言', '未注入 Chrome 基线无法创建 WebGL context');
    return false;
  }
  return true;
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

function freeLocalPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function stopRawBrowser(proc) {
  if (!proc || !proc.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }
  await Promise.race([
    new Promise((resolve) => proc.once('exit', resolve)),
    sleep(1500),
  ]);
}

async function createLocalStunServer() {
  const socket = dgram.createSocket('udp4');
  let requests = 0;
  socket.on('message', (message, remote) => {
    if (message.length < 20 || message.readUInt32BE(4) !== 0x2112a442 || message.readUInt16BE(0) !== 0x0001) return;
    requests++;
    const parts = remote.address.split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return;
    const address = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
    const response = Buffer.alloc(32);
    response.writeUInt16BE(0x0101, 0);
    response.writeUInt16BE(12, 2);
    response.writeUInt32BE(0x2112a442, 4);
    message.copy(response, 8, 8, 20);
    response.writeUInt16BE(0x0020, 20);
    response.writeUInt16BE(8, 22);
    response[24] = 0;
    response[25] = 1;
    response.writeUInt16BE(remote.port ^ 0x2112, 26);
    response.writeUInt32BE((address ^ 0x2112a442) >>> 0, 28);
    socket.send(response, remote.port, remote.address);
  });
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', resolve);
  });
  return {
    port: socket.address().port,
    get requests() { return requests; },
    close: () => new Promise((resolve) => socket.close(resolve)),
  };
}

async function gatherLocalIce(profileId, port) {
  const raw = await launcher.evaluateInProbePage(profileId, `(async () => {
    if (typeof RTCPeerConnection !== 'function') return JSON.stringify({ unsupported: true });
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${port}' }] });
    const candidates = [];
    pc.createDataChannel('local-check');
    const gathered = new Promise((resolve) => {
      const timer = setTimeout(() => { pc.close(); resolve(false); }, 7000);
      pc.onicecandidate = (event) => {
        if (event.candidate) candidates.push(event.candidate.candidate);
        else {
          clearTimeout(timer);
          pc.close();
          resolve(true);
        }
      };
    });
    try {
      await pc.setLocalDescription(await pc.createOffer());
      const complete = await gathered;
      return JSON.stringify({ complete, candidates });
    } catch (error) {
      pc.close();
      return JSON.stringify({ error: String(error) });
    }
  })()`);
  return JSON.parse(raw);
}

async function localWebRtcChecks(profileId, mode) {
  if (!baselineCapabilities || !baselineCapabilities.webRtc) {
    skip('真实本机 WebRTC ' + mode + ' 测试', '未注入浏览器不支持 RTCPeerConnection');
    return;
  }
  if (!baselineCapabilities.localStunRequests) {
    skip('真实本机 WebRTC ' + mode + ' 测试', baselineCapabilities.localStunReason || '未注入浏览器未能访问 loopback STUN');
    return;
  }
  let stun;
  try {
    stun = await createLocalStunServer();
  } catch (e) {
    skip('真实本机 WebRTC ' + mode + ' 测试', 'loopback UDP 服务不可用：' + e.message);
    return;
  }
  try {
    const result = await gatherLocalIce(profileId, stun.port);
    if (result.unsupported || result.error) {
      ok(false, '真实本机 WebRTC ' + mode + ' 收集失败', result);
      return;
    }
    if (mode === 'proxy') {
      eq(result.complete, true, 'proxy 模式真实 ICE 收集正常完成');
      ok(result.candidates.length > 0, 'proxy 模式实际收集到候选以供暴露检查', result.candidates);
      const cfg = launcher.buildConfig(store.get(profileId));
      const allowed = new Set([cfg.fakeIp, cfg.publicIp].filter(Boolean));
      const exposed = Array.from(new Set(result.candidates.flatMap((candidate) =>
        String(candidate).match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || []
      )));
      const unexpected = exposed.filter((address) => !allowed.has(address));
      eq(unexpected.length, 0, 'proxy 模式实际 ICE 候选中的 IPv4 仅为配置的假地址或 profile 地理 IP', {
        unexpected,
        allowed: Array.from(allowed),
      });
      console.log('     proxy 模式 loopback STUN 请求=' + stun.requests + '（仅本机回环测试，不代表公网 UDP 可达性）');
    } else {
      eq(result.complete, true, 'real 模式真实 ICE 收集正常完成');
      ok(stun.requests > 0, 'real 模式的真实 ICE 流量仅到本机 STUN 测试端点', { requests: stun.requests });
    }
  } catch (e) {
    ok(false, '真实本机 WebRTC ' + mode + ' 测试异常: ' + e.message);
  } finally {
    await stun.close();
  }
}

async function unpatchedBrowserCapabilities(chromePath) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-smoke-baseline-'));
  const probe = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>baseline</title>');
  });
  let stun = null;
  let proc;
  let cdp;
  try { stun = await createLocalStunServer(); } catch { /* UDP loopback may be restricted */ }
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  try {
    const port = await freeLocalPort();
    proc = spawn(chromePath, [
      '--user-data-dir=' + userDataDir,
      '--remote-debugging-port=' + port,
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      'about:blank',
    ], { stdio: 'ignore', detached: true, windowsHide: true });
    proc.once('error', (error) => { proc.__spawnError = error; });

    const deadline = Date.now() + 15000;
    let wsUrl = '';
    while (Date.now() < deadline) {
      if (proc.__spawnError) throw proc.__spawnError;
      if (proc.exitCode !== null) throw new Error('unpatched browser exited with code ' + proc.exitCode);
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(500) });
        const version = await response.json();
        wsUrl = version.webSocketDebuggerUrl || '';
        if (wsUrl) break;
      } catch {
        /* browser is still starting */
      }
      await sleep(100);
    }
    if (!wsUrl) throw new Error('unpatched browser DevTools did not become ready');
    cdp = await CDP.connect(wsUrl, 5000);
    const { targetId } = await cdp.send('Target.createTarget', {
      url: 'http://127.0.0.1:' + probe.address().port + '/',
    });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.try_('Runtime.enable', {}, sessionId);
    const result = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const canvas = document.createElement('canvas');
        let windowWebgl = false;
        try { windowWebgl = !!canvas.getContext('webgl'); } catch {}
        const workerWebgl = await new Promise((resolve) => {
          if (typeof OffscreenCanvas !== 'function' || typeof Worker !== 'function') return resolve(false);
          let worker;
          try {
            worker = new Worker(URL.createObjectURL(new Blob(['try { postMessage(!!new OffscreenCanvas(16,16).getContext("webgl")); } catch { postMessage(false); }'], { type: 'application/javascript' })));
          } catch { return resolve(false); }
          const timer = setTimeout(() => { worker.terminate(); resolve(false); }, 3000);
          worker.onmessage = (event) => { clearTimeout(timer); worker.terminate(); resolve(event.data === true); };
          worker.onerror = () => { clearTimeout(timer); worker.terminate(); resolve(false); };
        });
        let localIce = false;
        if (typeof RTCPeerConnection === 'function' && ${stun ? `'stun:127.0.0.1:${stun.port}'` : 'null'}) {
          try {
            const pc = new RTCPeerConnection({ iceServers: [{ urls: ${stun ? `'stun:127.0.0.1:${stun.port}'` : '""'} }] });
            pc.createDataChannel('baseline');
            const gathered = new Promise((resolve) => {
              const timer = setTimeout(() => { pc.close(); resolve(false); }, 6000);
              pc.onicecandidate = (event) => {
                if (event.candidate) return;
                clearTimeout(timer);
                pc.close();
                resolve(true);
              };
            });
            await pc.setLocalDescription(await pc.createOffer());
            localIce = await gathered;
          } catch { localIce = false; }
        }
        return JSON.stringify({ windowWebgl, workerWebgl, webRtc: typeof RTCPeerConnection === 'function', localIce });
      })()`,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    if (!result || !result.result || typeof result.result.value !== 'string') throw new Error('baseline capability result was unavailable');
    const capabilities = JSON.parse(result.result.value);
    capabilities.localStunRequests = !!stun && stun.requests > 0;
    if (!stun) capabilities.localStunReason = 'loopback UDP server could not bind';
    else if (!capabilities.localStunRequests) capabilities.localStunReason = 'unpatched browser did not send a local STUN request';
    return capabilities;
  } finally {
    if (cdp) cdp.close();
    await stopRawBrowser(proc);
    await new Promise((resolve) => probe.close(resolve));
    if (stun) await stun.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

async function serverValidationChecks() {
  console.log('\n[2a] HTTP 输入验证');
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const request = (method, requestPath, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: requestPath,
      headers: {
        host: '127.0.0.1:' + port,
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

  try {
    const malformed = await request('GET', '/%ZZ');
    eq(malformed.status, 400, '畸形百分号编码路径返回 HTTP 400');
    let malformedBody = {};
    try { malformedBody = JSON.parse(malformed.body); } catch { /* asserted below */ }
    ok(/路径格式错误/.test(malformedBody.error || ''), '畸形路径返回结构化错误');
    const healthy = await request('GET', '/api/state');
    eq(healthy.status, 200, '处理畸形 URL 后服务仍可响应后续请求');

    const invalidBatch = await request('POST', '/api/profiles/batch', { count: 1.5, proxiesText: '' });
    eq(invalidBatch.status, 400, 'API 拒绝小数批量数量');
    const overLimit = await request('POST', '/api/profiles/batch', { count: 101, proxiesText: '' });
    eq(overLimit.status, 400, 'API 拒绝超过共享上限的批量数量');
    const mismatchedUa = await request('POST', '/api/profiles', {
      name: 'invalid-custom-ua',
      platform: 'win',
      userAgentMode: 'custom',
      userAgentCustom: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    });
    eq(mismatchedUa.status, 400, 'API 保存时拒绝可识别的平台冲突自定义 UA');
    let mismatchBody = {};
    try { mismatchBody = JSON.parse(mismatchedUa.body); } catch { /* asserted below */ }
    ok(/自动生成/.test(mismatchBody.error || ''), 'UA 冲突错误建议使用自动生成的默认 UA');

    const defaultBatch = await request('POST', '/api/profiles/batch', { name: 'api-default-count', proxiesText: '' });
    eq(defaultBatch.status, 200, 'API 未提供 count 时保留默认批量创建行为');
    const defaultResult = JSON.parse(defaultBatch.body);
    eq(defaultResult.count, 1, '未提供 count 且无代理时默认创建一个环境');
    ok(defaultResult.created[0].warnings.some((warning) => /直连/.test(warning)), 'API 返回无代理直连警告');
  } catch (e) {
    ok(false, 'HTTP 输入验证测试异常: ' + e.message);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function concurrentStoreChecks() {
  console.log('\n[2b] 跨进程存储并发');
  const dataDir = path.join(os.tmpdir(), 'fb-smoke-concurrency-' + process.pid);
  fs.rmSync(dataDir, { recursive: true, force: true });
  const storePath = path.resolve(__dirname, '../src/store.js');
  const seedScript = `const store = require(${JSON.stringify(storePath)}); console.log(JSON.stringify(store.createMany(Array.from({length: 12}, (_, i) => ({name: 'seed-' + i}))).map(p => p.id)));`;
  const baseEnv = { ...process.env, FB_DATA: dataDir };
  const seeded = spawnSync(process.execPath, ['-e', seedScript], { env: baseEnv, encoding: 'utf8', timeout: 15000 });
  if (seeded.status !== 0) {
    ok(false, '并发测试初始化失败: ' + (seeded.stderr || seeded.error || 'unknown'));
    fs.rmSync(dataDir, { recursive: true, force: true });
    return;
  }
  const ids = JSON.parse(seeded.stdout.trim());
  const childScript = `
    const store = require(${JSON.stringify(storePath)});
    const args = JSON.parse(process.env.STORE_OP_ARGS);
    let result;
    if (process.env.STORE_OP === 'create') result = store.create({name: args.name});
    if (process.env.STORE_OP === 'update') result = store.update(args.id, {notes: args.notes});
    if (process.env.STORE_OP === 'remove') result = store.remove(args.id);
    if (process.env.STORE_OP === 'clone') result = store.clone(args.id);
    if (process.env.STORE_OP === 'import') result = store.importAll([{name: args.name}]);
    if (!result) throw new Error('store operation failed: ' + process.env.STORE_OP);
  `;
  const jobs = [
    ...ids.slice(0, 8).map((id, i) => ({ op: 'update', args: { id, notes: 'updated-' + i } })),
    ...ids.slice(8, 12).map((id) => ({ op: 'remove', args: { id } })),
    ...Array.from({ length: 8 }, (_, i) => ({ op: 'create', args: { name: 'parallel-' + i } })),
    ...Array.from({ length: 3 }, (_, i) => ({ op: 'import', args: { name: 'imported-' + i } })),
    ...Array.from({ length: 3 }, () => ({ op: 'clone', args: { id: ids[0] } })),
  ];
  const runJob = (job) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', childScript], {
      env: { ...baseEnv, STORE_OP: job.op, STORE_OP_ARGS: JSON.stringify(job.args) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(job.op + ' exited ' + code + ': ' + stderr)));
  });
  try {
    await Promise.all(jobs.map(runJob));
    const db = JSON.parse(fs.readFileSync(path.join(dataDir, 'profiles.json'), 'utf8'));
    const updated = ids.slice(0, 8).every((id, i) => db.profiles.some((profile) => profile.id === id && profile.notes === 'updated-' + i));
    const deleted = ids.slice(8, 12).every((id) => !db.profiles.some((profile) => profile.id === id));
    eq(db.profiles.length, 22, '并发 create/update/remove/import/clone 后记录数完整');
    ok(updated && deleted, '不同进程的更新与删除互不覆盖');
  } catch (e) {
    ok(false, '并发存储测试异常: ' + e.message);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function staleStoreRecoveryChecks() {
  console.log('\n[2b.1] 同时回收陈旧锁并原子初始化存储');
  const dataDir = path.join(os.tmpdir(), 'fb-smoke-stale-lock-' + process.pid);
  const lockDir = path.join(dataDir, 'profiles.json.lock');
  const readyDir = path.join(dataDir, 'ready');
  const releaseFile = path.join(dataDir, 'release');
  const renameAttempts = path.join(dataDir, 'rename-attempts');
  const storePath = path.resolve(__dirname, '../src/store.js');
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(lockDir, { recursive: true });
  fs.mkdirSync(readyDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: 0, createdAt: 0 }));
  const count = 8;
  const childScript = `
    const fs = require('node:fs');
    const path = require('node:path');
    const store = require(${JSON.stringify(storePath)});
    const lock = path.join(process.env.FB_DATA, 'profiles.json.lock');
    fs.writeFileSync(path.join(process.env.READY_DIR, process.env.WORKER_INDEX), 'ready');
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(process.env.RELEASE_FILE)) Atomics.wait(wait, 0, 0, 10);
    const renameSync = fs.renameSync;
    fs.renameSync = function (from, to) {
      if (from === lock) {
        fs.appendFileSync(process.env.RENAME_ATTEMPTS, process.pid + '\\n');
        while (!fs.existsSync(process.env.RELEASE_FILE + '.rename')) Atomics.wait(wait, 0, 0, 10);
      }
      return renameSync.call(fs, from, to);
    };
    store.create({ name: 'recovered-' + process.env.WORKER_INDEX });
  `;
  const workers = Array.from({ length: count }, (_, index) => {
    const child = spawn(process.execPath, ['-e', childScript], {
      env: {
        ...process.env,
        FB_DATA: dataDir,
        READY_DIR: readyDir,
        RELEASE_FILE: releaseFile,
        RENAME_ATTEMPTS: renameAttempts,
        WORKER_INDEX: String(index),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => code === 0 ? resolve() : reject(new Error('worker exited ' + code + ': ' + stderr)));
    });
    return { child, done };
  });
  const allDone = Promise.all(workers.map((worker) => worker.done));
  allDone.catch(() => {});
  try {
    const deadline = Date.now() + 15000;
    while (fs.readdirSync(readyDir).length < count && Date.now() < deadline) {
      if (workers.some(({ child }) => child.exitCode !== null)) throw new Error('a worker exited before the barrier');
      await sleep(10);
    }
    eq(fs.readdirSync(readyDir).length, count, '所有写入进程同时到达陈旧锁恢复屏障');
    await sleep(250);
    fs.writeFileSync(releaseFile, 'go');
    await sleep(250);
    fs.writeFileSync(releaseFile + '.rename', 'go');
    await allDone;
    const db = JSON.parse(fs.readFileSync(path.join(dataDir, 'profiles.json'), 'utf8'));
    eq(db.profiles.length, count, '并发陈旧锁恢复与首次初始化保留全部 profile');
    const attempts = fs.existsSync(renameAttempts) ? fs.readFileSync(renameAttempts, 'utf8').trim().split('\n').filter(Boolean) : [];
    eq(attempts.length, 1, '同一陈旧锁只允许一个进程执行目录回收');
    ok(!fs.existsSync(lockDir) && !fs.existsSync(lockDir + '.reaper'), '锁及回收协调目录在所有写入结束后清理');
  } catch (e) {
    ok(false, '同时回收陈旧锁测试异常: ' + e.message);
  } finally {
    try { fs.writeFileSync(releaseFile, 'go'); } catch {}
    try { fs.writeFileSync(releaseFile + '.rename', 'go'); } catch {}
    await Promise.allSettled(workers.map((worker) => worker.done));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function launchPortRetryChecks() {
  console.log('\n[2c] DevTools 端口冲突重试');
  if (process.platform === 'win32') {
    skip('DevTools 端口冲突重试', '本测试的可执行 stub 仅适用于 POSIX');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-smoke-port-retry-'));
  const fakeBrowser = path.join(dir, 'fake-chrome');
  const attemptsFile = path.join(dir, 'attempts');
  const versionCallsFile = path.join(dir, 'version-calls');
  const foreignQueriesFile = path.join(dir, 'foreign-queries');
  fs.writeFileSync(fakeBrowser, `#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
if (process.argv.includes('--version')) {
  fs.appendFileSync(process.env.FB_PORT_VERSION_CALLS_FILE, 'called\\n');
  process.stdout.write('Google Chrome 156.0.0.0\\n');
  process.exit(0);
}
const port = Number(process.argv.find((arg) => arg.startsWith('--remote-debugging-port=')).split('=')[1]);
fs.appendFileSync(process.env.FB_PORT_RETRY_FILE, port + '\\n');
const server = http.createServer((req, res) => {
  if (req.url === '/json/version') {
    fs.appendFileSync(process.env.FB_PORT_FOREIGN_QUERIES_FILE, 'queried\\n');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:' + port + '/devtools/browser/foreign-listener' }));
    return;
  }
  res.writeHead(404).end();
});
const reportBindFailure = () => setTimeout(() => process.stderr.write('DevTools bind failed: Address already in use\\n'), 250);
server.once('error', reportBindFailure);
server.listen(port, '127.0.0.1', reportBindFailure);
`, { mode: 0o755 });
  const oldPath = process.env.FB_PORT_RETRY_FILE;
  const oldVersionCalls = process.env.FB_PORT_VERSION_CALLS_FILE;
  const oldForeignQueries = process.env.FB_PORT_FOREIGN_QUERIES_FILE;
  process.env.FB_PORT_RETRY_FILE = attemptsFile;
  process.env.FB_PORT_VERSION_CALLS_FILE = versionCallsFile;
  process.env.FB_PORT_FOREIGN_QUERIES_FILE = foreignQueriesFile;
  const profile = store.create({ name: 'port-retry-test' });
  try {
    let error = null;
    try { await launcher.launch(profile.id, { chromePath: fakeBrowser }); } catch (e) { error = e; }
    eq(error && error.code, 'DEVTOOLS_PORT_CONFLICT', '端口冲突错误被识别并在有界重试后返回');
    const attemptedPorts = fs.existsSync(attemptsFile) ? fs.readFileSync(attemptsFile, 'utf8').trim().split('\n') : [];
    eq(attemptedPorts.length, 3, '端口绑定冲突最多启动尝试三次');
    eq(new Set(attemptedPorts).size, 3, '每次重试都为 DevTools 选择新的固定端口');
    ok(!fs.existsSync(foreignQueriesFile), '不会把候选端口上另一 Chrome 的 /json/version 当作本次启动');
    ok(!fs.existsSync(versionCallsFile), '默认 UA 启动不会额外同步执行 Chrome --version');
    const portsReleased = await Promise.all(attemptedPorts.map((port) => new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(Number(port), '127.0.0.1', () => probe.close(() => resolve(true)));
    })));
    ok(portsReleased.every(Boolean), '冲突重试结束后所有模拟监听端口均已释放');
    eq(launcher.getRunning(profile.id), null, '冲突重试失败后没有残留运行实例');
  } catch (e) {
    ok(false, 'DevTools 端口重试测试异常: ' + e.message);
  } finally {
    await launcher.stop(profile.id);
    store.remove(profile.id);
    if (oldPath === undefined) delete process.env.FB_PORT_RETRY_FILE;
    else process.env.FB_PORT_RETRY_FILE = oldPath;
    if (oldVersionCalls === undefined) delete process.env.FB_PORT_VERSION_CALLS_FILE;
    else process.env.FB_PORT_VERSION_CALLS_FILE = oldVersionCalls;
    if (oldForeignQueries === undefined) delete process.env.FB_PORT_FOREIGN_QUERIES_FILE;
    else process.env.FB_PORT_FOREIGN_QUERIES_FILE = oldForeignQueries;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ----------------------------- 1. 静态自检 ----------------------------- */

function staticChecks() {
  console.log('\n[1] 静态自检');
  const chrome = findBrowser();
  ok(!!chrome, '找到 Chromium 内核: ' + (chrome || ''));
  ok(typeof WebSocket === 'function', 'Node 内置 WebSocket 可用（CDP 无需第三方包）');

  const savedPath = process.env.PATH;
  const savedBrowser = process.env.FB_BROWSER;
  const pathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-smoke-path-'));
  const pathName = process.platform === 'win32' ? 'chrome.exe' : 'google-chrome';
  const pathBrowser = path.join(pathDir, pathName);
  fs.writeFileSync(pathBrowser, '');
  const existsSync = fs.existsSync;
  const accessSync = fs.accessSync;
  try {
    process.env.PATH = pathDir;
    process.env.FB_BROWSER = '';
    fs.existsSync = (candidate) => path.resolve(candidate) === path.resolve(pathBrowser);
    fs.accessSync = (candidate, mode) => {
      if (path.resolve(candidate) === path.resolve(pathBrowser)) return;
      return accessSync(candidate, mode);
    };
    eq(browser.findBrowser(), pathBrowser, '浏览器可从 PATH 中发现');
  } finally {
    fs.existsSync = existsSync;
    fs.accessSync = accessSync;
    process.env.PATH = savedPath;
    if (savedBrowser === undefined) delete process.env.FB_BROWSER;
    else process.env.FB_BROWSER = savedBrowser;
    fs.rmSync(pathDir, { recursive: true, force: true });
  }

  eq(resolveCount(undefined, 2), 2, '数量省略时使用既有默认值');
  for (const invalid of [0, 1.5, Infinity, 101, 'not-a-number']) {
    let rejected = false;
    try { resolveCount(invalid); } catch { rejected = true; }
    ok(rejected, '共享数量验证拒绝 ' + String(invalid));
  }
  const cliData = path.join(os.tmpdir(), 'fb-smoke-count-' + process.pid);
  const cliCount = spawnSync(process.execPath, [path.resolve(__dirname, '../src/index.js'), 'create', '--count', 'Infinity', '--json'], {
    env: { ...process.env, FB_DATA: cliData },
    encoding: 'utf8',
    timeout: 10000,
  });
  eq(cliCount.status, 1, 'CLI 在创建前拒绝 --count Infinity');
  ok(/有限整数/.test(cliCount.stdout || ''), 'CLI 数量错误返回可操作说明');
  fs.rmSync(cliData, { recursive: true, force: true });

  const importData = path.join(os.tmpdir(), 'fb-smoke-import-' + process.pid);
  const importFile = path.join(os.tmpdir(), 'fb-smoke-import-' + process.pid + '.json');
  fs.writeFileSync(importFile, JSON.stringify([{ name: 'import-warning-test' }]));
  const cliImport = spawnSync(process.execPath, [path.resolve(__dirname, '../src/index.js'), 'import', importFile], {
    env: { ...process.env, FB_DATA: importData },
    encoding: 'utf8',
    timeout: 10000,
  });
  eq(cliImport.status, 0, 'CLI import 成功');
  ok(/未配置代理/.test(cliImport.stdout || ''), 'CLI import 文本明确提示未配置代理会直连');
  ok(/尚未按网络出口验证/.test(cliImport.stdout || ''), 'CLI import 文本提示地区一致性尚未验证');
  fs.rmSync(importFile, { force: true });
  fs.rmSync(importData, { recursive: true, force: true });

  const listData = path.join(os.tmpdir(), 'fb-smoke-list-warnings-' + process.pid);
  const cliCreateForList = spawnSync(process.execPath, [path.resolve(__dirname, '../src/index.js'), 'create', '--name', 'list-warning-test', '--json'], {
    env: { ...process.env, FB_DATA: listData },
    encoding: 'utf8',
    timeout: 10000,
  });
  eq(cliCreateForList.status, 0, '为 CLI list JSON 警告测试创建隔离环境');
  const cliList = spawnSync(process.execPath, [path.resolve(__dirname, '../src/index.js'), 'list', '--json'], {
    env: { ...process.env, FB_DATA: listData },
    encoding: 'utf8',
    timeout: 10000,
  });
  eq(cliList.status, 0, 'CLI list --json 成功');
  let listPayload = {};
  try { listPayload = JSON.parse(cliList.stdout || '{}'); } catch {}
  ok(
    listPayload.profiles && listPayload.profiles[0] && listPayload.profiles[0].warnings.some((warning) => /未配置代理/.test(warning)),
    'CLI list --json profile 中包含直连警告'
  );
  fs.rmSync(listData, { recursive: true, force: true });

  const goodUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/156.0.0.0 Safari/537.36';
  const matchingProfile = { platform: 'win', userAgentMode: 'custom', userAgentCustom: goodUa };
  eq(profileConfigErrors(matchingProfile, '156.0.8078.47').length, 0, '保留与平台及 Chromium 主版本相符的自定义 UA');
  ok(profileConfigErrors({ ...matchingProfile, platform: 'mac' }).length > 0, '检测自定义 UA 与平台的已知冲突');
  ok(profileConfigErrors(matchingProfile, '157.0.1.2').length > 0, '检测自定义 UA 与 Chromium 主版本的已知冲突');
  const validStoredUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
  const updateProfile = store.create({ name: 'ua-update-validation', platform: 'win', userAgentMode: 'custom', userAgentCustom: validStoredUa });
  let updateRejected = false;
  try {
    store.update(updateProfile.id, {
      userAgentCustom: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    });
  } catch { updateRejected = true; }
  ok(updateRejected, '更新时拒绝自定义 UA 平台冲突');
  eq(store.get(updateProfile.id).userAgentCustom, validStoredUa, '拒绝冲突更新后保留原有有效配置');
  store.remove(updateProfile.id);

  const directWarnings = profileWarnings({ id: 'direct', proxy: { type: 'none' }, autoGeo: false }, []);
  ok(directWarnings.some((warning) => /直连/.test(warning)), '无代理配置生成直连警告');
  ok(directWarnings.some((warning) => /尚未按网络出口验证/.test(warning)), '未验证的地区配置生成不确定性警告');
  const sameEndpoint = profileWarnings(
    { id: 'one', proxy: { type: 'http', host: 'proxy.local', port: '8080', password: 'a' } },
    [
      { id: 'one', proxy: { type: 'http', host: 'proxy.local', port: '8080', password: 'a' } },
      { id: 'two', proxy: { type: 'http', host: 'proxy.local', port: '8080', password: 'b' } },
    ]
  );
  ok(sameEndpoint.some((warning) => /相同代理端点/.test(warning) && /无法仅凭此配置判断/.test(warning)), '相同代理端点只提示配置相同，不断言实际出口相同');

  const originalWriteFile = fs.writeFileSync;
  let profileFileWrites = 0;
  fs.writeFileSync = function (file, ...args) {
    if (String(file).startsWith(path.join(store.DATA, 'profiles.json.')) && String(file).endsWith('.tmp')) profileFileWrites++;
    return originalWriteFile.call(this, file, ...args);
  };
  let batchCreated;
  try {
    batchCreated = store.createMany([{ name: 'atomic-batch-1' }, { name: 'atomic-batch-2' }]);
  } finally {
    fs.writeFileSync = originalWriteFile;
  }
  eq(batchCreated.length, 2, '批量创建返回所有新环境且不重复');
  eq(profileFileWrites, 1, '批量创建只原子写入一次 profiles.json');
  const beforeInvalidBatch = store.list().length;
  let invalidBatchRejected = false;
  try {
    store.createMany([
      { name: 'batch-valid-before-invalid' },
      {
        name: 'batch-invalid',
        platform: 'win',
        userAgentMode: 'custom',
        userAgentCustom: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/156.0.0.0 Safari/537.36',
      },
    ]);
  } catch { invalidBatchRejected = true; }
  ok(invalidBatchRejected, '批量创建遇到无效配置时拒绝整批');
  eq(store.list().length, beforeInvalidBatch, '无效批量创建没有部分写入');
  for (const profile of batchCreated) store.remove(profile.id);

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
  const pxHttps = cliutil.parseProxyLine('https://u:p@1.2.3.4:443');
  ok(pxHttps && pxHttps.type === 'https' && pxHttps.port === '443', '代理串解析：https 保留 https 类型');
  const nyGeo = launcher.resolveGeolocation({ timezone: 'America/New_York', seed: 's1' });
  const jpGeo = launcher.resolveGeolocation({ timezone: 'Asia/Tokyo', seed: 's1' });
  ok(
    nyGeo && Math.abs(nyGeo.latitude - 40.7128) < 0.05 && Math.abs(nyGeo.longitude - -74.006) < 0.05,
    'resolveGeolocation 按纽约时区计算确定性经纬度',
    nyGeo
  );
  ok(
    jpGeo && Math.abs(jpGeo.latitude - 35.6762) < 0.05 && Math.abs(jpGeo.longitude - 139.6503) < 0.05,
    'resolveGeolocation 按东京时区计算确定性经纬度',
    jpGeo
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

/* ------------------------- 2c. HTTPS 上游中继自检 ------------------------- */

function selfSignedCert() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const derLen = (n) =>
    n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  const tag = (t, b) => Buffer.concat([Buffer.from([t]), derLen(b.length), b]);
  const seq = (...a) => tag(0x30, Buffer.concat(a));
  const set = (...a) => tag(0x31, Buffer.concat(a));
  const oid = (bytes) => tag(0x06, Buffer.from(bytes));
  const alg = seq(oid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]), Buffer.from([0x05, 0x00]));
  const cn = seq(set(seq(oid([0x55, 0x04, 0x03]), tag(0x0c, Buffer.from('127.0.0.1')))));
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const tbs = seq(
    tag(0xa0, Buffer.from([2, 1, 2])),
    Buffer.from([2, 1, 1]),
    alg,
    cn,
    seq(tag(0x17, Buffer.from('250101000000Z')), tag(0x17, Buffer.from('350101000000Z'))),
    cn,
    spki
  );
  const sig = crypto.sign('sha256', tbs, privateKey);
  const certDer = seq(tbs, alg, tag(0x03, Buffer.concat([Buffer.from([0]), sig])));
  return {
    cert:
      '-----BEGIN CERTIFICATE-----\n' +
      certDer.toString('base64').match(/.{1,64}/g).join('\n') +
      '\n-----END CERTIFICATE-----\n',
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

function testHttpsRelay() {
  return new Promise((resolve) => {
    console.log('\n[2c] 代理中继（HTTPS 上游，TLS 隧道 + 认证）');
    const echo = net.createServer((s) => s.pipe(s));
    echo.listen(0, '127.0.0.1', async () => {
      const echoPort = echo.address().port;
      const upstream = tls.createServer(selfSignedCert(), (socket) => {
        let buf = '';
        const onData = (c) => {
          buf += c.toString('latin1');
          const idx = buf.indexOf('\r\n\r\n');
          if (idx < 0) return;
          socket.removeListener('data', onData);
          const head = buf.slice(0, idx);
          const lines = head.split('\r\n');
          const expect = 'Basic ' + Buffer.from('user:pass').toString('base64');
          const authOk = lines.some((l) => l.toLowerCase() === ('proxy-authorization: ' + expect).toLowerCase());
          if (!authOk) {
            socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
            return;
          }
          const m = /^CONNECT\s+([^:]+):(\d+)/i.exec(lines[0] || '');
          if (!m) {
            socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
            return;
          }
          const up = net.connect(Number(m[2]), m[1], () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            const rest = buf.slice(idx + 4);
            if (rest) up.write(rest, 'latin1');
            up.pipe(socket);
            socket.pipe(up);
          });
          up.on('error', () => socket.destroy());
        };
        socket.on('data', onData);
        socket.on('error', () => {});
      });
      upstream.listen(0, '127.0.0.1', async () => {
        const upPort = upstream.address().port;
        const tunnel = (relayPort) =>
          new Promise((res) => {
            const sock = net.connect(relayPort, '127.0.0.1', () => {
              sock.write('CONNECT 127.0.0.1:' + echoPort + ' HTTP/1.1\r\nHost: 127.0.0.1:' + echoPort + '\r\n\r\n');
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
                sock.write('ping-https-proxy');
              }
              if (tunneled && buf.includes(Buffer.from('ping-https-proxy'))) {
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
            type: 'https',
            host: '127.0.0.1',
            port: upPort,
            username: 'user',
            password: 'pass',
            rejectUnauthorized: false,
          });
          ok((await tunnel(relay.port)).ok, 'HTTPS 上游代理：TLS 握手 + Basic 认证 + 隧道透传成功');
          await relay.close();

          const bad = await createRelay({
            type: 'https',
            host: '127.0.0.1',
            port: upPort,
            username: 'user',
            password: 'wrong',
            rejectUnauthorized: false,
          });
          ok(!(await tunnel(bad.port)).ok, 'HTTPS 上游代理：密码错误被拒绝');
          await bad.close();
        } catch (e) {
          ok(false, 'HTTPS 上游代理测试异常: ' + e.message);
        } finally {
          upstream.close();
          echo.close();
          resolve();
        }
      });
    });
  });
}

/* --------------------------- 3. 真实环境指纹自检 --------------------------- */

async function browserChecks() {
  console.log('\n[3] 真实启动 + 指纹读回');
  try {
    baselineCapabilities = await unpatchedBrowserCapabilities(findBrowser());
    ok(true, '未注入 Chrome 基线已测量 WebGL/WebRTC 能力', baselineCapabilities);
  } catch (e) {
    baselineCapabilities = null;
    ok(false, '未注入 Chrome 能力基线检查失败: ' + e.message);
  }

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
    geo: { lat: 40.7128, lon: -74.006, ip: '45.67.89.10' },
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
    const consistentUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/' + infoA.browserVersion.split('.')[0] + '.0.0.0 Safari/537.36';
    const consistentProfile = store.create({ name: 'consistent-custom-ua', platform: 'win', userAgentMode: 'custom', userAgentCustom: consistentUa });
    eq(launcher.buildUserAgent(consistentProfile, infoA.browserVersion), consistentUa, '一致的自定义 UA 被原样保留而不自动改写');
    store.remove(consistentProfile.id);

    let versionGuardRequests = 0;
    const versionGuardServer = http.createServer((_req, res) => {
      versionGuardRequests++;
      res.end('must not navigate here');
    });
    await new Promise((resolve, reject) => {
      versionGuardServer.once('error', reject);
      versionGuardServer.listen(0, '127.0.0.1', resolve);
    });
    const mismatchMajor = Number(infoA.browserVersion.split('.')[0]) + 1;
    const mismatchProfile = store.create({
      name: 'ua-version-cdp-validation',
      platform: 'win',
      userAgentMode: 'custom',
      userAgentCustom: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/' + mismatchMajor + '.0.0.0 Safari/537.36',
      startUrl: 'http://127.0.0.1:' + versionGuardServer.address().port + '/must-not-navigate',
    });
    try {
      let versionError = null;
      try { await launcher.launch(mismatchProfile.id); } catch (e) { versionError = e; }
      eq(versionError && versionError.code, 'PROFILE_CONFIG_INVALID', '真实 Chromium 版本经 CDP 查询后拒绝矛盾 UA');
      ok(versionError && /当前浏览器/.test(versionError.message), '版本拒绝来自实际 CDP 版本而非平台预检');
      eq(versionGuardRequests, 0, 'CDP 版本校验在启动后的用户起始页导航之前完成');
      eq(launcher.getRunning(mismatchProfile.id), null, 'CDP 版本不匹配后清理已启动的浏览器实例');
    } finally {
      await launcher.stop(mismatchProfile.id);
      store.remove(mismatchProfile.id);
      await new Promise((resolve) => versionGuardServer.close(resolve));
    }

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
    if (webglAvailable('windowWebgl')) {
      eq(ra.webglVendor, 'Google Inc. (AMD)', 'WebGL 厂商被覆盖');
      eq(ra.webglRenderer, 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'WebGL 渲染器被覆盖');
    }
    eq(ra.webdriver, false, 'navigator.webdriver 为 false');
    ok(typeof ra.canvasHash === 'number' && ra.canvasHash !== 0, 'Canvas 指纹可读（' + ra.canvasHash + '）');
    ok(typeof ra.audioHash === 'number' && ra.audioHash > 0, 'Audio 指纹可读（' + ra.audioHash + '）');
    ok(
      ra.health &&
        ra.health.workerConsistent === true &&
        ra.health.iframeToStringClean === true &&
        ra.health.illegalInvocationClean === true &&
        ra.health.canvasSolidClean === true &&
        ra.health.uaChConsistent === true,
      'probe v2 健康体检 5 项指标全部通过',
      ra.health
    );

    const prefA = JSON.parse(fs.readFileSync(path.join(store.profileDir(a.id), 'Default', 'Preferences'), 'utf8'));
    eq(prefA && prefA.profile && prefA.profile.name, '测试A', 'Chrome Default/Preferences 已写入防串号环境名');

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

        // 4) WebRTC IPv6 候选脱敏与 srflx 公网 IP 改写
        const fakeSdp = [
          'v=0',
          'a=candidate:1 1 udp 2122260223 10.0.0.5 54321 typ host generation 0',
          'a=candidate:2 1 udp 2122262783 240e:390:123:456::1 54322 typ host generation 0',
          'a=candidate:3 1 udp 1686052607 203.0.113.99 54323 typ srflx raddr 10.0.0.5 rport 54321',
          ''
        ].join('\\r\\n');
        const desc = new RTCSessionDescription({ type: 'offer', sdp: fakeSdp });
        const cand6 = new RTCIceCandidate({
          candidate: 'candidate:2 1 udp 2122262783 240e:390:123:456::1 54322 typ host',
          sdpMid: '0',
          sdpMLineIndex: 0
        });
        const candSrflx = new RTCIceCandidate({
          candidate: 'candidate:3 1 udp 1686052607 203.0.113.99 54323 typ srflx raddr 10.0.0.5 rport 54321',
          sdpMid: '0',
          sdpMLineIndex: 0
        });

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
          solidCorrupted,
          sdpOut: desc.sdp,
          cand6Out: cand6.candidate,
          candSrflxJson: candSrflx.toJSON().candidate
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
    if (webglAvailable('workerWebgl')) {
      eq(audit.worker.webglVendor, 'Google Inc. (AMD)', 'Worker OffscreenCanvas WebGL 厂商一致');
      ok(
        String(audit.worker.webglRenderer || '').includes('Radeon RX 6600'),
        'Worker OffscreenCanvas WebGL 渲染器一致',
        audit.worker
      );
    }
    ok(
      audit.uaChBrandsLen > 0 && audit.uaChBrandsLen === audit.uaChFullLen,
      'UA-CH brands 与 fullVersionList 均存在且长度一致（' + audit.uaChBrandsLen + '）',
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
    ok(
      !audit.sdpOut.includes('240e:390') && !audit.sdpOut.includes('10.0.0.5') && audit.sdpOut.includes('45.67.89.10'),
      'WebRTC SDP 已过滤 IPv6 候选、替换真实内网 IP 且将 srflx 映射为代理出口 IP',
      audit.sdpOut
    );
    ok(!audit.cand6Out.includes('240e:390'), 'RTCIceCandidate IPv6 候选已被脱敏', audit.cand6Out);
    ok(
      audit.candSrflxJson.includes('45.67.89.10') && !audit.candSrflxJson.includes('203.0.113.99'),
      'RTCIceCandidate.toJSON() 已同步改写 srflx 公网地址',
      audit.candSrflxJson
    );

    await localWebRtcChecks(a.id, 'proxy');
    const realWebRtcProfile = store.create({ name: '本机 WebRTC real 测试', webrtc: 'real' });
    try {
      await launcher.launch(realWebRtcProfile.id);
      await localWebRtcChecks(realWebRtcProfile.id, 'real');
    } catch (e) {
      ok(false, '启动本机 WebRTC real 测试环境失败: ' + e.message);
    } finally {
      await launcher.stop(realWebRtcProfile.id);
      store.remove(realWebRtcProfile.id);
    }

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
    if (webglAvailable('windowWebgl')) ok(ra.webglRenderer !== rb.webglRenderer, '两个环境的 WebGL 渲染器不同');
    ok(JSON.stringify(ra.languages) !== JSON.stringify(rb.languages), '两个环境的语言不同');

    // 同一环境重开：验证离线 Cookie 导入 + 运行态导出，以及 Canvas 确定性
    await launcher.stop(a.id);
    await sleep(600);
    const impJson = await launcher.importCookies(a.id, [
      {
        name: 'json_ck',
        value: 'v1',
        domain: '.example.org',
        path: '/',
        secure: true,
        expirationDate: Math.floor(Date.now() / 1000) + 86400,
      },
    ]);
    eq(impJson.imported, 1, '离线状态导入 JSON 格式 Cookie 成功');
    const netscapeTxt = '#HttpOnly_.example.net\tTRUE\t/\tTRUE\t1999999999\tnet_ck\tv2\n';
    const impNet = await launcher.importCookies(a.id, netscapeTxt);
    eq(impNet.imported, 1, '离线状态导入 Netscape 格式 Cookie 成功');

    await launcher.launch(a.id);
    const ra2 = await launcher.probe(a.id);
    eq(ra2.canvasHash, ra.canvasHash, '同一环境重启后 Canvas 指纹保持一致（确定性）');

    const exportedCookies = await launcher.exportCookies(a.id);
    const ckJson = exportedCookies.find((c) => c.name === 'json_ck');
    const ckNet = exportedCookies.find((c) => c.name === 'net_ck');
    ok(ckJson && ckJson.value === 'v1', '运行态导出包含离线导入的 JSON Cookie');
    ok(ckNet && ckNet.value === 'v2' && ckNet.httpOnly === true, '运行态导出包含离线导入的 Netscape HttpOnly Cookie');

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
    if (webglAvailable('windowWebgl')) eq(r.glMaxTextureSize, 16384, 'WebGL 最大纹理与声明的 GPU 档位一致');
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

    const listed = spawnSync(process.execPath, [indexJs, 'list', '--json'], { env, encoding: 'utf8', timeout: 10000 });
    eq(listed.status, 0, '守护进程运行时 CLI list --json 成功');
    let listedPayload = {};
    try { listedPayload = JSON.parse(listed.stdout || '{}'); } catch {}
    const listedProfile = (listedPayload.profiles || []).find((profile) => profile.id === id);
    ok(listedProfile && listedProfile.warnings.some((warning) => /未配置代理/.test(warning)), '守护进程路径的 list --json 同样返回直连警告');

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
      if (webglAvailable('windowWebgl')) eq(tabVal.gpu, expectGpu, 'CLI launch 退出后新开标签页仍保持伪装 WebGL 渲染器');
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

/* --------------- 6. Agent 无痕操控原语与 MCP 协议自检 --------------- */

async function agentAndMcpChecks() {
  console.log('\n[6] Agent 无痕操控原语与 MCP 协议自检');

  const srv = http.createServer((req, res) => {
    if (req.url === '/challenge') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><meta charset="utf-8"><title>挑战页</title><body>' +
          '<h1>安全验证</h1>' +
          '<iframe src="https://challenges.cloudflare.com/turnstile/v0/api.js" style="width:300px;height:65px;border:0"></iframe>' +
          '<button id="after">下一步</button></body>'
      );
      return;
    }
    if (req.url === '/tab2') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>第二个标签页</title><body><p>tab2 ok</p></body>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><meta charset="utf-8"><title>注册测试页</title><body>' +
        '<h2>账号注册</h2>' +
        '<form onsubmit="return false">' +
        '<input id="user" placeholder="用户名" />' +
        '<select id="role"><option value="buyer">买家</option><option value="seller">卖家</option></select>' +
        '<input id="avatar" type="file" />' +
        '<button id="sub" type="button">提交注册</button>' +
        '</form>' +
        '<pre id="result"></pre>' +
        '<script>' +
        'document.getElementById("sub").addEventListener("click", function (ev) {' +
        '  var f = document.getElementById("avatar").files;' +
        '  document.getElementById("result").textContent = JSON.stringify({' +
        '    value: document.getElementById("user").value,' +
        '    role: document.getElementById("role").value,' +
        '    fileCount: f ? f.length : 0,' +
        '    fileName: f && f[0] ? f[0].name : "",' +
        '    isTrusted: ev.isTrusted' +
        '  });' +
        '});' +
        '</script></body>'
    );
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const baseUrl = 'http://127.0.0.1:' + srv.address().port;

  const p = store.create({
    name: 'Agent测试环境',
    platform: 'win',
    timezone: 'America/Chicago',
    locale: 'en-US',
    languages: ['en-US', 'en'],
    hardwareConcurrency: 8,
  });

  const tempUpload = path.join(os.tmpdir(), 'fb-upload-' + process.pid + '.txt');
  const shotPath = path.join(os.tmpdir(), 'fb-shot-' + process.pid + '.png');
  fs.writeFileSync(tempUpload, 'hello-upload', 'utf8');

  const mcpData = path.join(os.tmpdir(), 'fb-mcp-smoke-' + process.pid);

  try {
    await launcher.launch(p.id);

    const nav = await agent.navigate(p.id, { url: baseUrl + '/' });
    eq(nav.title, '注册测试页', 'agent.navigate 打开测试页面并返回标题');
    eq(nav.blockedByChallenge, false, '普通表单页未误报人机验证');

    const snap = await agent.snapshot(p.id);
    ok(snap.elementCount >= 4 && snap.elements.some((e) => e.ref === '@e1'), 'agent.snapshot 返回 @e1..@eN 可交互元素引用');
    ok((snap.text || '').includes('账号注册'), 'agent.snapshot 提取页面可读正文');

    // 零痕迹审计：DOM 与 window 上不得残留任何 __fb / agent / data-ref 标记
    const footprint = await agent.evaluate(p.id, {
      expression: `(() => {
        const html = document.documentElement.outerHTML;
        const winKeys = Object.getOwnPropertyNames(window).filter((k) => /__fb|agentRef/i.test(k));
        const winSyms = Object.getOwnPropertySymbols(window).map((s) => String(s)).filter((s) => /fb|agent/i.test(s));
        return {
          hasDataMarker: /data-fb|data-agent|@e1/.test(html),
          winKeys,
          winSyms
        };
      })()`,
    });
    ok(
      footprint.value &&
        footprint.value.hasDataMarker === false &&
        footprint.value.winKeys.length === 0 &&
        footprint.value.winSyms.length === 0,
      'snapshot 不在 DOM 属性或 window 上留下任何全局标记（页面零痕迹）',
      footprint.value
    );

    const userEl = snap.elements.find((e) => e.tag === 'input' && e.type !== 'file');
    const roleEl = snap.elements.find((e) => e.tag === 'select');
    const fileEl = snap.elements.find((e) => e.tag === 'input' && e.type === 'file');
    ok(!!(userEl && roleEl && fileEl), '快照准确识别输入框 / 下拉框 / 文件控件');

    await agent.act(p.id, { action: 'fill', target: userEl.ref, value: 'Alice_测试' });
    await agent.act(p.id, { action: 'select', target: roleEl.ref, value: 'seller' });
    await agent.act(p.id, { action: 'upload', target: fileEl.ref, files: [tempUpload] });
    await agent.act(p.id, { action: 'click', target: 'text=提交注册' });

    const submitRes = await agent.evaluate(p.id, {
      expression: 'JSON.parse(document.getElementById("result").textContent || "{}")',
    });
    const submitted = submitRes.value || {};
    eq(submitted.value, 'Alice_测试', 'agent.fill 支持 Unicode/中文输入并写入输入框');
    eq(submitted.role, 'seller', 'agent.select 成功切换 <select> 选项并触发 change');
    eq(submitted.fileCount, 1, 'agent.upload 成功为 <input type=file> 挂载本地文件');
    eq(submitted.isTrusted, true, 'agent.click 触发真实浏览器信任事件 (event.isTrusted === true)');

    // 截图校验 PNG 文件头
    const shot = await agent.screenshot(p.id, { path: shotPath });
    const pngBytes = fs.readFileSync(shot.path);
    ok(
      pngBytes.length > 500 && pngBytes[0] === 0x89 && pngBytes[1] === 0x50 && pngBytes[2] === 0x4e && pngBytes[3] === 0x47,
      'agent.screenshot 输出合法 PNG 图片（' + pngBytes.length + ' 字节）'
    );

    // 多标签页控制 + 指纹持久性
    const t2 = await agent.newTab(p.id, baseUrl + '/tab2');
    const tabsBefore = await agent.listTabs(p.id);
    ok(tabsBefore.tabs.length >= 2, 'agent.newTab 成功打开第二个标签页（当前 ' + tabsBefore.tabs.length + ' 个）');
    const tab2Tz = await agent.evaluate(p.id, {
      expression: 'Intl.DateTimeFormat().resolvedOptions().timeZone',
    });
    eq(tab2Tz.value, 'America/Chicago', '新开标签页保持环境设定的 America/Chicago 时区');
    await agent.switchTab(p.id, 0);
    const tabsSwitched = await agent.listTabs(p.id);
    eq(tabsSwitched.activeTargetId, tabsBefore.tabs[0].targetId, 'agent.switchTab 可切回第 0 个标签页');
    await agent.closeTab(p.id, t2.targetId);
    const tabsAfterClose = await agent.listTabs(p.id);
    ok(!tabsAfterClose.tabs.some((t) => t.targetId === t2.targetId), 'agent.closeTab 成功关闭指定标签页');

    // 人机验证护栏：仅被动识别，绝不自动点击验证 iframe
    await agent.navigate(p.id, { url: baseUrl + '/challenge' });
    const snapChallenge = await agent.snapshot(p.id);
    eq(snapChallenge.blockedByChallenge, true, 'snapshot 准确识别人机验证组件并标记 blockedByChallenge=true');
    let clickBlocked = false;
    try {
      await agent.act(p.id, { action: 'click', target: 'iframe' });
    } catch (e) {
      clickBlocked = /人机验证|禁止/.test(String(e && e.message));
    }
    ok(clickBlocked, 'agent.act 严禁点击人机验证 iframe（安全护栏生效）');

    // MCP Stdio 服务端协议端到端自检
    const indexJs = path.resolve(__dirname, '..', 'src', 'index.js');
    const mcpProc = spawn(process.execPath, [indexJs, 'mcp'], {
      env: { ...process.env, FB_DATA: mcpData },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const mcpReply = await new Promise((resolve, reject) => {
      let stdoutBuf = '';
      let stderrBuf = '';
      const messages = [];
      const timer = setTimeout(() => {
        try { mcpProc.kill(); } catch {}
        reject(new Error('MCP 测试超时; stdout=' + stdoutBuf + '; stderr=' + stderrBuf));
      }, 20000);
      mcpProc.stdout.setEncoding('utf8');
      mcpProc.stdout.on('data', (chunk) => {
        stdoutBuf += chunk;
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop();
        for (const line of lines) {
          const s = line.trim();
          if (!s) continue;
          try {
            messages.push(JSON.parse(s));
          } catch (e) {
            clearTimeout(timer);
            reject(new Error('MCP stdout 混入非 JSON 内容：' + s));
            return;
          }
        }
        if (messages.some((m) => m.id === 1) && messages.some((m) => m.id === 2) && messages.some((m) => m.id === 3)) {
          clearTimeout(timer);
          mcpProc.stdin.end();
          resolve(messages);
        }
      });
      mcpProc.stderr.on('data', (d) => (stderrBuf += d.toString('utf8')));
      mcpProc.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });

      const reqs = [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fb_list_profiles', arguments: {} } },
      ];
      mcpProc.stdin.write(reqs.map((r) => JSON.stringify(r)).join('\n') + '\n');
    });

    const mInit = mcpReply.find((m) => m.id === 1);
    const mTools = mcpReply.find((m) => m.id === 2);
    const mCall = mcpReply.find((m) => m.id === 3);
    ok(mInit && mInit.result && mInit.result.serverInfo && mInit.result.serverInfo.name === 'lite-fingerprint', 'MCP initialize 握手返回 serverInfo');
    eq(mTools && mTools.result && mTools.result.tools && mTools.result.tools.length, 20, 'MCP tools/list 注册全部 20 个工具');
    const callPayload = mCall && mCall.result && mCall.result.content && mCall.result.content[0] && JSON.parse(mCall.result.content[0].text);
    ok(callPayload && callPayload.ok === true && Array.isArray(callPayload.profiles), 'MCP tools/call(fb_list_profiles) 通过后台守护进程正常返回');
  } catch (e) {
    ok(false, 'Agent / MCP 测试异常: ' + (e && e.message ? e.message : e));
  } finally {
    await launcher.stop(p.id);
    await sleep(300);
    store.remove(p.id);
    try {
      const cinfo = JSON.parse(fs.readFileSync(path.join(mcpData, 'console.json'), 'utf8'));
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
    for (const f of [tempUpload, shotPath]) {
      try { fs.rmSync(f, { force: true }); } catch {}
    }
    try { fs.rmSync(mcpData, { recursive: true, force: true }); } catch {}
  }
}

/* ------------------------------- 跑起来 ------------------------------- */

(async () => {
  console.log('轻量指纹浏览器 · 冒烟测试');
  staticChecks();
  await serverValidationChecks();
  await concurrentStoreChecks();
  await staleStoreRecoveryChecks();
  await launchPortRetryChecks();
  await testRelay();
  await testSocks5Relay();
  await testHttpsRelay();
  await browserChecks();
  await headerChecks();
  await cliDaemonChecks();
  await agentAndMcpChecks();

  console.log('\n' + '─'.repeat(58));
  if (failures.length) {
    console.log('\x1b[31m失败 ' + failures.length + ' 项\x1b[0m，通过 ' + pass + ' 项，跳过 ' + skipped + ' 项');
    for (const f of failures) console.log('  · ' + f);
    cleanupData();
    process.exit(1);
  }
  console.log('\x1b[32m全部通过\x1b[0m（' + pass + ' 项断言，跳过 ' + skipped + ' 项）');
  cleanupData();
  process.exit(0);
})();
