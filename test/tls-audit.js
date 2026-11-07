'use strict';
/**
 * TLS 指纹审计：截获真实 ClientHello 明文并解析出 JA3。
 *
 * 原理：TLS 握手第一包 ClientHello 是**明文**的，里面包含
 * 版本、密码套件列表、扩展列表、椭圆曲线、签名算法、ALPN……
 * 这些内容+顺序由客户端的 TLS 库决定，浏览器和网页 JS 都改不了。
 *
 *   node test/tls-audit.js
 */
const net = require('node:net');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

// 一次性探测脚本也不碰生产数据
process.env.FB_DATA = process.env.FB_DATA || path.join(os.tmpdir(), 'fb-tls-' + process.pid);

const launcher = require('../src/launch');
const store = require('../src/store');

/* ------------------------------- 名字映射 ------------------------------- */

const CIPHERS = {
  0x1301: 'TLS_AES_128_GCM_SHA256',
  0x1302: 'TLS_AES_256_GCM_SHA384',
  0x1303: 'TLS_CHACHA20_POLY1305_SHA256',
  0xc02b: 'ECDHE-ECDSA-AES128-GCM-SHA256',
  0xc02c: 'ECDHE-ECDSA-AES256-GCM-SHA384',
  0xc02f: 'ECDHE-RSA-AES128-GCM-SHA256',
  0xc030: 'ECDHE-RSA-AES256-GCM-SHA384',
  0xcca8: 'ECDHE-RSA-CHACHA20-POLY1305',
  0xcca9: 'ECDHE-ECDSA-CHACHA20-POLY1305',
  0xc013: 'ECDHE-RSA-AES128-SHA',
  0xc014: 'ECDHE-RSA-AES256-SHA',
  0xc009: 'ECDHE-ECDSA-AES128-SHA',
  0xc00a: 'ECDHE-ECDSA-AES256-SHA',
  0x009c: 'AES128-GCM-SHA256',
  0x009d: 'AES256-GCM-SHA384',
  0x002f: 'AES128-SHA',
  0x0035: 'AES256-SHA',
  0x000a: 'DES-CBC3-SHA',
  0x003c: 'AES128-SHA256',
  0x003d: 'AES256-SHA256',
  0xc007: 'ECDHE-ECDSA-RC4-SHA',
  0xc011: 'ECDHE-RSA-RC4-SHA',
  0xc012: 'ECDHE-RSA-DES-CBC3-SHA',
  0xc008: 'ECDHE-ECDSA-DES-CBC3-SHA',
  0x0016: 'DHE-RSA-DES-CBC3-SHA',
  0x0033: 'DHE-RSA-AES128-SHA',
  0x0039: 'DHE-RSA-AES256-SHA',
  0x0067: 'DHE-RSA-AES128-SHA256',
  0x006b: 'DHE-RSA-AES256-SHA256',
  0x0005: 'RC4-SHA',
  0x0004: 'RC4-MD5',
};

const EXTENSIONS = {
  0: 'server_name',
  1: 'max_fragment_length',
  5: 'status_request',
  10: 'supported_groups',
  11: 'ec_point_formats',
  13: 'signature_algorithms',
  16: 'alpn',
  18: 'signed_certificate_timestamp',
  21: 'padding',
  22: 'encrypt_then_mac',
  23: 'extended_master_secret',
  27: 'compress_certificate',
  28: 'record_size_limit',
  34: 'delegated_credentials',
  35: 'session_ticket',
  41: 'pre_shared_key',
  42: 'early_data',
  43: 'supported_versions',
  44: 'cookie',
  45: 'psk_key_exchange_modes',
  49: 'post_handshake_auth',
  50: 'signature_algorithms_cert',
  51: 'key_share',
  0x44cd: 'application_settings(ALPS)',
  17513: 'application_settings(ALPS)',
  17616: 'application_settings(ALPS)',
  65037: 'encrypted_client_hello(ECH)',
  65281: 'renegotiation_info',
};

const GROUPS = {
  23: 'secp256r1',
  24: 'secp384r1',
  25: 'secp521r1',
  29: 'x25519',
  30: 'x448',
  256: 'ffdhe2048',
  257: 'ffdhe3072',
  0x11ec: 'X25519MLKEM768',
  0x6399: 'X25519Kyber768',
  0x11eb: 'SecP256r1MLKEM768',
};

const nameOf = (map, v) => map[v] || '0x' + v.toString(16);
// RFC 8701：GREASE 是 0x0a0a / 0x1a1a / ... / 0xfafa 这些"两条相同字节、低半字节为 a"的值。
// Chrome 每次连接都会随机挑几个塞进去，JA3 规范要求剔除，否则同一个浏览器每次算出来的值都不一样。
const isGrease = (v) => (v >> 8) === (v & 0xff) && (v & 0x0f) === 0x0a;

/* ------------------------------ ClientHello ------------------------------ */

function parseClientHello(buf) {
  if (buf.length < 9 || buf[0] !== 0x16) return null;
  const recLen = buf.readUInt16BE(3);
  if (buf.length < 5 + recLen) return null;
  if (buf[5] !== 0x01) return null;
  const hsLen = (buf[6] << 16) | (buf[7] << 8) | buf[8];
  if (buf.length < 9 + hsLen) return null;

  let p = 9;
  const legacyVersion = buf.readUInt16BE(p);
  p += 2 + 32; // version + random
  const sidLen = buf[p];
  p += 1 + sidLen;
  const csLen = buf.readUInt16BE(p);
  p += 2;
  const ciphers = [];
  for (let i = 0; i < csLen; i += 2) ciphers.push(buf.readUInt16BE(p + i));
  p += csLen;
  const compLen = buf[p];
  p += 1 + compLen;

  let extensions = [];
  let groups = [];
  let sigalgs = [];
  let alpn = [];
  let sni = '';
  let supportedVersions = [];
  let ecFormats = [];
  let hasAlps = false;

  if (p + 2 <= buf.length) {
    const extLen = buf.readUInt16BE(p);
    p += 2;
    const extEnd = Math.min(p + extLen, buf.length);
    while (p + 4 <= extEnd) {
      const type = buf.readUInt16BE(p);
      const len = buf.readUInt16BE(p + 2);
      const d = buf.subarray(p + 4, p + 4 + len);
      extensions.push(type);
      try {
        if (type === 10) {
          const n = d.readUInt16BE(0);
          for (let i = 0; i < n; i += 2) groups.push(d.readUInt16BE(2 + i));
        } else if (type === 13) {
          const n = d.readUInt16BE(0);
          for (let i = 0; i < n; i += 2) sigalgs.push(d.readUInt16BE(2 + i));
        } else if (type === 11) {
          const n = d[0];
          for (let i = 0; i < n; i++) ecFormats.push(d[1 + i]);
        } else if (type === 16) {
          let q = 2;
          while (q < d.length) {
            const l = d[q];
            alpn.push(d.subarray(q + 1, q + 1 + l).toString());
            q += 1 + l;
          }
        } else if (type === 43) {
          const n = d[0];
          for (let i = 0; i < n; i += 2) supportedVersions.push(d.readUInt16BE(1 + i));
        } else if (type === 0) {
          const l = d.readUInt16BE(3);
          sni = d.subarray(5, 5 + l).toString();
        } else if (type === 17616 || type === 17513 || type === 17613) {
          hasAlps = true;
        }
      } catch (e) {
        /* 单个扩展解析失败不影响整体 */
      }
      p += 4 + len;
    }
  }

  // JA3 规范：过滤 GREASE，按原始顺序拼接
  const f = (arr) => arr.filter((v) => !isGrease(v));
  const ja3Str = [
    legacyVersion,
    f(ciphers).join('-'),
    f(extensions).join('-'),
    f(groups).join('-'),
    f(ecFormats).join('-'),
  ].join(',');
  const ja3 = crypto.createHash('md5').update(ja3Str).digest('hex');

  return {
    legacyVersion,
    supportedVersions,
    ciphers,
    extensions,
    groups,
    sigalgs,
    alpn,
    sni,
    ecFormats,
    hasAlps,
    ja3,
    ja3Str,
  };
}

const vname = (v) =>
  ({ 0x0304: 'TLS1.3', 0x0303: 'TLS1.2', 0x0302: 'TLS1.1', 0x0301: 'TLS1.0' }[v] || '0x' + v.toString(16));

/**
 * JA4（FoxIO 新一代标准）。
 * 和 JA3 最大的区别：**先排序再哈希**。
 * 因为 Chrome 会故意打乱 ClientHello 里扩展的顺序来对抗 JA3，不排序的话同一个浏览器
 * 每次算出来的 JA3 都不同，根本没法当指纹用。
 */
function computeJa4(r) {
  const f = (arr) => arr.filter((v) => !isGrease(v));
  const hex = (v) => v.toString(16).padStart(4, '0');
  const ciphers = f(r.ciphers);
  const exts = f(r.extensions);
  const ver = r.supportedVersions.includes(0x0304)
    ? '13'
    : r.supportedVersions.includes(0x0303)
      ? '12'
      : r.supportedVersions.length
        ? '11'
        : '12';
  const a =
    't' +
    ver +
    (r.sni ? 'd' : 'i') +
    String(Math.min(ciphers.length, 99)).padStart(2, '0') +
    String(Math.min(exts.length, 99)).padStart(2, '0') +
    (r.alpn.length ? r.alpn[0][0] + r.alpn[0].slice(-1) : '00');
  const b = crypto
    .createHash('sha256')
    .update(ciphers.map(hex).sort().join(','))
    .digest('hex')
    .slice(0, 12);
  const extPart = exts
    .filter((e) => e !== 0 && e !== 16) // 规范要求排除 SNI 与 ALPN
    .map(hex)
    .sort()
    .join(',');
  const sigPart = f(r.sigalgs).map(hex).sort().join(',');
  const c = crypto.createHash('sha256').update(extPart + '_' + sigPart).digest('hex').slice(0, 12);
  return a + '_' + b + '_' + c;
}

/* -------------------------------- 抓包 -------------------------------- */

function report(label, r) {
  console.log('\n  ── ' + label + ' ──');
  console.log('     JA3（看顺序）   ' + r.ja3);
  console.log('     JA4（先排序）   ' + computeJa4(r));
  console.log('     记录层版本      ' + vname(r.legacyVersion));
  console.log(
    '     支持版本        ' + (r.supportedVersions.length ? r.supportedVersions.map(vname).join(', ') : '(无)')
  );
  console.log('     密码套件        ' + r.ciphers.length + ' 个，前 6 个：');
  console.log(
    '                     ' +
      r.ciphers
        .slice(0, 6)
        .map((c) => (isGrease(c) ? 'GREASE' : nameOf(CIPHERS, c)))
        .join(', ')
  );
  console.log('     扩展            ' + r.extensions.length + ' 个，顺序：');
  console.log('                     ' + r.extensions.map((e) => (isGrease(e) ? 'GREASE' : nameOf(EXTENSIONS, e))).join(' → '));
  console.log('     曲线            ' + r.groups.map((g) => (isGrease(g) ? 'GREASE' : nameOf(GROUPS, g))).join(', '));
  console.log('     签名算法        ' + r.sigalgs.length + ' 个');
  console.log('     ALPN            ' + (r.alpn.join(', ') || '(无)'));
  console.log('     ALPS            ' + (r.hasAlps ? '有（Chrome 特有）' : '无'));
  console.log('     SNI             ' + (r.sni || '(无)'));
}

(async () => {
  const captures = [];
  const srv = net.createServer((sock) => {
    sock.on('error', () => {});
    let buf = Buffer.alloc(0);
    const onData = (c) => {
      buf = Buffer.concat([buf, c]);
      let r = null;
      try {
        r = parseClientHello(buf);
      } catch (e) {
        r = null;
      }
      if (r) {
        captures.push(r);
        sock.removeListener('data', onData);
        sock.destroy();
      } else if (buf.length > 20000) {
        sock.destroy();
      }
    };
    sock.on('data', onData);
    setTimeout(() => {
      try {
        sock.destroy();
      } catch (e) {}
    }, 4000);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const waitFor = async (n, ms) => {
    const t0 = Date.now();
    while (captures.length <= n && Date.now() - t0 < ms) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return captures.length > n ? captures[n] : null;
  };

  const results = [];

  // 1) Chrome：走我们自己的指纹浏览器启动器
  let profile = null;
  try {
    profile = store.create({ name: 'tls-probe', platform: 'win' });
    const before = captures.length;
    await launcher.launch(profile.id, { startUrl: 'https://127.0.0.1:' + port + '/' });
    const r = await waitFor(before, 8000);
    if (r) results.push(['Chrome（本项目的环境）', r]);
  } catch (e) {
    console.log('  Chrome 抓包失败: ' + e.message);
  } finally {
    if (profile) {
      await launcher.stop(profile.id);
      store.remove(profile.id);
    }
  }

  // 2) Node 自己的 TLS 客户端（Node 项目/爬虫脚本的典型指纹）
  {
    const before = captures.length;
    const tls = require('node:tls');
    const s = tls.connect({ host: '127.0.0.1', port, servername: 'example.test', rejectUnauthorized: false });
    s.on('error', () => {});
    const r = await waitFor(before, 5000);
    if (r) results.push(['Node.js tls 客户端', r]);
    try {
      s.destroy();
    } catch (e) {}
  }

  // 3) curl（可用才有）
  await new Promise((resolve) => {
    const before = captures.length;
    execFile('curl', ['-sk', '--max-time', '3', 'https://127.0.0.1:' + port + '/'], () => {});
    waitFor(before, 5000).then((r) => {
      if (r) results.push(['curl', r]);
      resolve();
    });
  });

  srv.close();

  console.log('');
  console.log('TLS 指纹审计（截获真实 ClientHello）');
  for (const [label, r] of results) report(label, r);

  if (results.length >= 2) {
    console.log('\n  ── 结论 ──');
    const chrome = results.find((r) => /Chrome/.test(r[0]));
    const others = results.filter((r) => !/Chrome/.test(r[0]));
    if (chrome) {
      console.log('     Chrome   JA4: ' + computeJa4(chrome[1]) + '   ← 同版本 Chrome 每次一致');
      console.log('     Chrome   JA3: ' + chrome[1].ja3 + '   ← 每次连接都变（Chrome 故意打乱扩展顺序）');
      for (const [label, r] of others) {
        const same = computeJa4(r) === computeJa4(chrome[1]);
        console.log(
          '     ' + label + ' JA4: ' + computeJa4(r) + (same ? '（与 Chrome 相同）' : '（与 Chrome 不同 ← 一眼区分）')
        );
      }
    }
  }
  console.log('');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
