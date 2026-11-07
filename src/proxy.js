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

/* ------------------------------ HTTP 上游隧道 ------------------------------ */

function httpProxyConnect(upstream, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: upstream.host, port: upstream.port });
    let buf = Buffer.alloc(0);
    let settled = false;

    const fail = (msg) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new Error(msg));
    };

    sock.setTimeout(20000, () => fail('HTTP 上游代理超时'));
    sock.on('error', (e) => fail('HTTP 上游代理错误：' + e.message));
    sock.on('connect', () => {
      const hostPort = targetHost + ':' + targetPort;
      const lines = ['CONNECT ' + hostPort + ' HTTP/1.1', 'Host: ' + hostPort];
      if (upstream.username) {
        lines.push('Proxy-Authorization: ' + basicAuth(upstream.username, upstream.password));
      }
      lines.push('', '');
      sock.write(lines.join('\r\n'));
    });

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
 * @param {{type:'http'|'socks5', host:string, port:number, username?:string, password?:string}} upstream
 * @returns {Promise<{port:number, close:()=>Promise<void>}>}
 */
async function createRelay(upstream, opts = {}) {
  const up = {
    host: String(upstream.host || '').trim(),
    port: Number(upstream.port),
    username: upstream.username || '',
    password: upstream.password || '',
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
      sock.pipe(clientSocket);
      clientSocket.pipe(sock);
      sock.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => sock.destroy());
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
      const sock = net.connect(up.port, up.host, () => pipe(sock, true));
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
      sock.pipe(clientSocket);
      clientSocket.pipe(sock);
      sock.on('error', () => clientSocket.destroy());
      clientSocket.on('close', () => sock.destroy());
      sock.on('close', () => clientSocket.destroy());
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
      const r = http.request({
        host: up.host,
        port: up.port,
        method: req.method,
        path: req.url,
        headers,
      });
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

module.exports = { createRelay, socks5Connect };
