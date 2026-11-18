'use strict';
/**
 * 本地代理中继。
 *
 * 为什么要它：Chrome 的 --proxy-server 不支持带账号密码，而商用住宅代理几乎都要认证。
 * 做法：Chrome 指向本机中继（无认证），中继再带上 Proxy-Authorization 连上游。
 * 上游支持 http(s) 与 socks5，两者都支持用户名密码。
 */
const net = require('node:net');
const http = require('node:http');
const tls = require('node:tls');
const https = require('node:https');

function basicAuth(user, pass) {
  return 'Basic ' + Buffer.from(String(user) + ':' + String(pass)).toString('base64');
}

/* ------------------------------ SOCKS5 客户端 ------------------------------ */

function socks5Connect(opts) {
  return new Promise((resolve, reject) => {
    const { host, port, username, password, targetHost, targetPort } = opts;
    const sock = net.connect({ host, port });
    let stage = 0; // 0=握手 1=认证 2=连接 3=完成
    let buf = Buffer.alloc(0);
    let settled = false;

    const fail = (msg) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new Error(msg));
    };

    sock.setTimeout(20000, () => fail('SOCKS5 上游超时'));
    sock.on('error', (e) => fail('SOCKS5 上游错误：' + e.message));
    sock.on('connect', () => {
      sock.write(username ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]));
    });

    function sendConnect() {
      let addr;
      if (net.isIPv4(targetHost)) {
        addr = Buffer.concat([Buffer.from([1]), Buffer.from(targetHost.split('.').map(Number))]);
      } else if (net.isIPv6(targetHost)) {
        const parts = expandIPv6(targetHost);
        addr = Buffer.concat([Buffer.from([4]), parts]);
      } else {
        const b = Buffer.from(targetHost);
        addr = Buffer.concat([Buffer.from([3, b.length]), b]);
      }
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(targetPort);
      sock.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, portBuf]));
    }

    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        if (buf.length < 2) return;
        const ver = buf[0];
        const method = buf[1];
        buf = buf.subarray(2);
        if (ver !== 5) return fail('SOCKS5 版本错误');
        if (method === 0xff) return fail('SOCKS5 上游拒绝所有认证方式');
        if (method === 2) {
          stage = 1;
          const u = Buffer.from(String(username || ''));
          const p = Buffer.from(String(password || ''));
          sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
          return;
        }
        stage = 2;
        return sendConnect();
      }
      if (stage === 1) {
        if (buf.length < 2) return;
        const status = buf[1];
        buf = buf.subarray(2);
        if (status !== 0) return fail('SOCKS5 用户名或密码错误');
        stage = 2;
        return sendConnect();
      }
      if (stage === 2) {
        if (buf.length < 4) return;
        const rep = buf[1];
        const atyp = buf[3];
        if (rep !== 0) return fail('SOCKS5 连接被拒，code=' + rep);
        let need = 0;
        if (atyp === 1) need = 10;
        else if (atyp === 4) need = 22;
        else if (atyp === 3) {
          if (buf.length < 5) return;
          need = 4 + 1 + buf[4] + 2;
        } else return fail('SOCKS5 未知地址类型');
        if (buf.length < need) return;
        settled = true;
        const rest = buf.subarray(need);
        sock.removeListener('data', onData);
        sock.setTimeout(0);
        if (rest.length) sock.unshift(rest);
        resolve(sock);
      }
    }

    sock.on('data', onData);
  });
}

function expandIPv6(ip) {
  const out = Buffer.alloc(16);
  let parts = ip.split('::');
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length > 1 && parts[1] ? parts[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  const all = [...head, ...Array(Math.max(0, fill)).fill('0'), ...tail];
  for (let i = 0; i < 8; i++) out.writeUInt16BE(parseInt(all[i] || '0', 16) || 0, i * 2);
  return out;
}

/* ------------------------------ HTTP/HTTPS 上游隧道 ------------------------------ */

function connectUpstreamSocket(upstream, onConnect) {
  if (upstream.type === 'https') {
    const tlsOpts = {
      host: upstream.host,
      port: Number(upstream.port),
      rejectUnauthorized: upstream.rejectUnauthorized !== false,
    };
    if (!net.isIP(upstream.host)) tlsOpts.servername = upstream.host;
    return tls.connect(tlsOpts, onConnect);
  }
  return net.connect({ host: upstream.host, port: Number(upstream.port) }, onConnect);
}

function wireTunnel(sock, clientSocket) {
  try {
    sock.setNoDelay(true);
    clientSocket.setNoDelay(true);
  } catch {
    /* ignore */
  }
  const IDLE_MS = 600000;
  sock.setTimeout(IDLE_MS, () => {
    sock.destroy();
    clientSocket.destroy();
  });
  clientSocket.setTimeout(IDLE_MS, () => {
    clientSocket.destroy();
    sock.destroy();
  });
  sock.pipe(clientSocket);
  clientSocket.pipe(sock);
  sock.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => sock.destroy());
  clientSocket.on('close', () => sock.destroy());
  sock.on('close', () => clientSocket.destroy());
}

function httpProxyConnect(upstream, targetHost, targetPort, useHttp11 = upstream.type === 'https') {
  return new Promise((resolve, reject) => {
    let sock = null;
    let buf = Buffer.alloc(0);
    let settled = false;

    const fail = (msg) => {
      if (settled) return;
      settled = true;
      if (sock) sock.destroy();
      reject(new Error(msg));
    };

    sock = connectUpstreamSocket(upstream, () => {
      const hostPort = (net.isIPv6(targetHost) ? '[' + targetHost + ']' : targetHost) + ':' + targetPort;
      // Some HTTP upstreams stall when CONNECT repeats its authority in Host.
      const lines = useHttp11
        ? ['CONNECT ' + hostPort + ' HTTP/1.1', 'Host: ' + hostPort]
        : ['CONNECT ' + hostPort + ' HTTP/1.0'];
      if (upstream.username) {
        lines.push('Proxy-Authorization: ' + basicAuth(upstream.username, upstream.password));
      }
      lines.push('', '');
      sock.write(lines.join('\r\n'));
    });

    sock.setTimeout(20000, () => fail('HTTP 上游代理超时'));
    sock.on('error', (e) => fail('HTTP 上游代理错误：' + e.message));

    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) {
        if (buf.length > 32768) fail('上游代理响应头过大');
        return;
      }
      const head = buf.subarray(0, idx).toString('latin1');
      const first = head.split('\r\n')[0] || '';
      const m = /^HTTP\/1\.[01]\s+(\d{3})/.exec(first);
      if (!m) return fail('上游代理响应无法解析：' + first);
      const code = Number(m[1]);
      if (!useHttp11 && (code === 400 || code === 505 || code === 426)) {
        settled = true;
        sock.destroy();
        resolve(httpProxyConnect(upstream, targetHost, targetPort, true));
        return;
      }
      if (code !== 200) {
        const isAuth = code === 407 || code === 401;
        return fail('上游代理拒绝连接（' + code + '）' + (isAuth ? '：请检查代理账号密码' : ''));
      }
      settled = true;
      const rest = buf.subarray(idx + 4);
      sock.removeListener('data', onData);
      sock.setTimeout(0);
      if (rest.length) sock.unshift(rest);
      resolve(sock);
    }
    sock.on('data', onData);
  });
}

/* -------------------------------- 中继本体 -------------------------------- */

/**
 * @param {{type:'http'|'https'|'socks5', host:string, port:number, username?:string, password?:string, rejectUnauthorized?:boolean}} upstream
 * @returns {Promise<{port:number, close:()=>Promise<void>}>}
 */
async function createRelay(upstream, opts = {}) {
  const up = {
    type: upstream.type || 'http',
    host: String(upstream.host || '').trim(),
    port: Number(upstream.port),
    username: upstream.username || '',
    password: upstream.password || '',
    rejectUnauthorized: upstream.rejectUnauthorized,
  };
  if (!up.host || !up.port) throw new Error('代理配置缺少 host/port');

  const dial = async (targetHost, targetPort) => {
    if (upstream.type === 'socks5') {
      return socks5Connect({ ...up, targetHost, targetPort });
    }
    return httpProxyConnect(up, targetHost, targetPort);
  };

  const server = http.createServer();

  /** 转发 Upgrade 请求头（明文 ws:// 走这里；wss:// 走 CONNECT） */
  function upgradeHead(req, url, absolute) {
    const lines = [req.method + ' ' + (absolute ? req.url : url.pathname + url.search) + ' HTTP/1.1'];
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === 'proxy-authorization' || k === 'proxy-connection') continue;
      lines.push(k + ': ' + (Array.isArray(v) ? v.join(', ') : v));
    }
    if (absolute && up.username) {
      lines.push('proxy-authorization: ' + basicAuth(up.username, up.password));
    }
    return lines.join('\r\n') + '\r\n\r\n';
  }

  server.on('upgrade', (req, clientSocket, head) => {
    let url;
    try {
      url = new URL(req.url);
    } catch {
      clientSocket.destroy();
      return;
    }
    const port = Number(url.port) || (url.protocol === 'wss:' ? 443 : 80);
    clientSocket.on('error', () => {});

    const pipe = (sock, absolute) => {
      sock.write(upgradeHead(req, url, absolute));
      if (head && head.length) sock.write(head);
      wireTunnel(sock, clientSocket);
    };

    if (upstream.type === 'socks5') {
      socks5Connect({ ...up, targetHost: url.hostname, targetPort: port })
        .then((sock) => pipe(sock, false))
        .catch((e) => {
          try {
            clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          } catch {
            /* ignore */
          }
          server.emit('relay-error', e);
        });
    } else {
      const sock = connectUpstreamSocket(up, () => pipe(sock, true));
      sock.on('error', (e) => {
        try {
          clientSocket.destroy();
        } catch {
          /* ignore */
        }
        server.emit('relay-error', e);
      });
    }
  });

  server.on('connect', async (req, clientSocket, head) => {
    clientSocket.on('error', () => {});
    const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(req.url || '');
    if (!m) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const host = m[1] || m[2];
    const port = Number(m[3]) || 443;
    try {
      const sock = await dial(host, port);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) sock.write(head);
      wireTunnel(sock, clientSocket);
    } catch (e) {
      try {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      } catch {
        /* ignore */
      }
      server.emit('relay-error', e);
    }
  });

  // 明文 HTTP（HTTPS 走上面的 CONNECT）
  server.on('request', (req, res) => {
    let url;
    try {
      url = new URL(req.url);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    const headers = { ...req.headers, host: url.host };
    const finish = (err, upstreamReq) => {
      if (err) {
        res.writeHead(502).end('proxy error: ' + err.message);
        server.emit('relay-error', err);
        return;
      }
      upstreamReq.on('error', () => {
        try {
          res.writeHead(502).end('proxy error');
        } catch {
          /* ignore */
        }
      });
      res.writeHead ? null : null;
      upstreamReq.on('response', (r) => {
        res.writeHead(r.statusCode || 502, r.headers);
        r.pipe(res);
      });
      req.pipe(upstreamReq);
      upstreamReq.end();
    };

    if (upstream.type === 'socks5') {
      socks5Connect({ ...up, targetHost: url.hostname, targetPort: port })
        .then((sock) => {
          const r = http.request({
            method: req.method,
            path: url.pathname + url.search,
            headers,
            createConnection: () => sock,
          });
          finish(null, r);
        })
        .catch((e) => finish(e));
    } else {
      headers['proxy-authorization'] = basicAuth(up.username, up.password);
      const client = up.type === 'https' ? https : http;
      const reqOpts = {
        host: up.host,
        port: up.port,
        method: req.method,
        path: req.url,
        headers,
      };
      if (up.type === 'https') {
        if (!net.isIP(up.host)) reqOpts.servername = up.host;
        reqOpts.rejectUnauthorized = up.rejectUnauthorized !== false;
      }
      const r = client.request(reqOpts);
      finish(null, r);
    }
  });

  server.on('clientError', (err, socket) => {
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    // 重接管时要抢回原来那个端口（Chrome 的命令行还指着它）
    server.listen(opts.port || 0, '127.0.0.1', resolve);
  });

  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
        setTimeout(resolve, 500);
      }),
  };
}

/* ------------------------------ 出口 IP 探测 ------------------------------ */

/** 在本地中继上开一条到目标的隧道（CONNECT），返回裸 socket */
function tunnelTo(relayPort, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port: relayPort });
    let buf = '';
    let settled = false;
    const fail = (msg) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new Error(msg));
    };
    sock.setTimeout(timeoutMs, () => fail('通过代理建隧道超时'));
    sock.on('error', (e) => fail('代理隧道错误：' + e.message));
    sock.on('connect', () => {
      sock.write(
        'CONNECT ' + targetHost + ':' + targetPort + ' HTTP/1.1\r\nHost: ' + targetHost + ':' + targetPort + '\r\n\r\n'
      );
    });
    sock.on('data', function onData(chunk) {
      buf += chunk.toString('latin1');
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) {
        if (buf.length > 16384) fail('代理响应头过大');
        return;
      }
      sock.removeListener('data', onData);
      const first = (buf.slice(0, idx).split('\r\n')[0] || '').split(/\s+/);
      const code = parseInt(first[1], 10);
      if (code !== 200) return fail('上游代理拒绝 CONNECT（' + code + '）');
      settled = true;
      sock.setTimeout(0);
      const rest = Buffer.from(buf.slice(idx + 4), 'latin1');
      if (rest.length) sock.unshift(rest);
      resolve(sock);
    });
  });
}

/** GET 一个 JSON 接口；relayPort 为 0 时直连 */
function fetchJson(url, relayPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const timer = setTimeout(() => reject(new Error('请求超时')), timeoutMs);

    const finish = (err, data) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(data);
    };

    const send = (socket) => {
      const opts = {
        host: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          host: u.hostname,
          accept: 'application/json',
          'user-agent': 'lite-fingerprint-browser/0.1',
          connection: 'close',
        },
        timeout: timeoutMs,
      };
      if (socket) {
        // agent: false creates a new Agent and ignores this connected tunnel.
        opts.createConnection = () => socket;
      }
      const req = (socket ? http : https).request(opts, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            finish(null, { status: res.statusCode, json: JSON.parse(body) });
          } catch {
            finish(new Error('返回的不是 JSON（HTTP ' + res.statusCode + '）'));
          }
        });
      });
      req.on('error', (e) => finish(e));
      req.on('timeout', () => req.destroy(new Error('请求超时')));
      req.end();
    };

    if (!relayPort) return send(null);

    tunnelTo(relayPort, u.hostname, isHttps ? 443 : 80, timeoutMs)
      .then((sock) => {
        if (!isHttps) return send(sock);
        const t = tls.connect({ socket: sock, servername: u.hostname }, () => send(t));
        t.on('error', (e) => finish(e));
        t.setTimeout(timeoutMs, () => t.destroy(new Error('TLS 握手超时')));
        return null;
      })
      .catch((e) => finish(e));
  });
}

/**
 * 测一个代理能不能用、出口 IP 是多少、是不是"假代理"（出口和直连一样）。
 * 走真实网络，只在这个按钮被点的时候发生。
 */
async function testProxy(upstream, opts = {}) {
  const timeoutMs = opts.timeoutMs || 6000;
  const started = Date.now();
  let relay = null;
  try {
    relay = await createRelay(upstream);
  } catch (e) {
    return { ok: false, error: e.message, ms: Date.now() - started };
  }

  let data = null;
  let error = null;
  try {
    const first = await fetchJson('https://ipinfo.io/json', relay.port, timeoutMs);
    if (first && first.json && first.json.ip) {
      data = first.json;
    } else {
      // 接口能连上但没给 ip（多半是限流）：换一个接口再试；
      // 连不上就直接失败，不再多等一个超时
      const second = await fetchJson(
        'http://ip-api.com/json/?fields=status,country,countryCode,regionName,city,isp,timezone,lat,lon,query',
        relay.port,
        timeoutMs
      );
      data = (second && second.json) || null;
    }
  } catch (e) {
    error = e;
  } finally {
    try {
      await relay.close();
    } catch {
      /* ignore */
    }
  }

  if (error) return { ok: false, error: error.message, ms: Date.now() - started };
  const d = data || {};
  const ip = d.ip || d.query || '';
  let lat = typeof d.lat === 'number' ? d.lat : null;
  let lon = typeof d.lon === 'number' ? d.lon : null;
  if ((lat === null || lon === null) && typeof d.loc === 'string' && d.loc.includes(',')) {
    const [la, lo] = d.loc.split(',').map(Number);
    if (isFinite(la) && isFinite(lo)) {
      lat = la;
      lon = lo;
    }
  }
  const countryCode = String(d.countryCode || (d.country && d.country.length === 2 ? d.country : '')).toUpperCase();
  const result = {
    ok: !!ip,
    ip,
    country: d.country || '',
    countryCode,
    city: d.city || d.regionName || '',
    isp: d.isp || d.org || '',
    timezone: d.timezone || '',
    lat,
    lon,
    ms: Date.now() - started,
    directIp: '',
    leaked: false,
  };

  // 直连再取一次：如果出口 IP 和直连一样，说明代理其实没生效
  try {
    const direct = await fetchJson('https://ipinfo.io/json', 0, Math.min(timeoutMs, 2500));
    result.directIp = (direct && direct.json && direct.json.ip) || '';
    result.leaked = !!(ip && result.directIp && ip === result.directIp);
  } catch {
    /* 直连失败就不比了 */
  }
  return result;
}

module.exports = { createRelay, socks5Connect, testProxy };
