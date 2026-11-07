'use strict';
/** 本地控制台服务：零依赖 HTTP + JSON API + 静态页面 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const store = require('./store');
const launcher = require('./launch');
const runtime = require('./runtime');
const { testProxy } = require('./proxy');
const { findBrowser } = require('./browser');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '').replace(/\\/g, '/');
  const key = path.posix.join('public', safe);
  const body = runtime.readAsset(key);
  if (body === null) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(key).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function withRunning(profile) {
  const info = launcher.getRunning(profile.id);
  return { ...store.publicProfile(profile), running: !!info, instance: info };
}

function createServer() {
  const server = http.createServer(async (req, res) => {
    const method = req.method || 'GET';
    const boundPort = server.address() ? server.address().port : 0;
    const host = String(req.headers.host || '').toLowerCase();
    const localHosts = ['127.0.0.1:' + boundPort, 'localhost:' + boundPort, '[::1]:' + boundPort];

    // 只认本机 Host：挡住 DNS rebinding——恶意域名解析到 127.0.0.1 后，
    // 页面就成了"同源"，能直接读走 /api/state（里面有代理配置）
    if (!localHosts.includes(host)) {
      return json(res, 403, { error: '只允许通过 127.0.0.1 访问控制台' });
    }

    // 写操作校验 Origin：挡住跨站表单 / fetch / sendBeacon（CSRF）
    if (method !== 'GET' && method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin) {
        let sameHost = false;
        try {
          sameHost = new URL(origin).host.toLowerCase() === host;
        } catch {
          sameHost = false;
        }
        if (!sameHost) return json(res, 403, { error: '跨站请求被拒绝' });
      }
    }

    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);

    try {
      /* ------------------------------- API ------------------------------- */
      if (pathname.startsWith('/api/')) {
        const parts = pathname.split('/').filter(Boolean); // ['api', ...]
        const seg = parts.slice(1);

        if (method === 'GET' && pathname === '/api/state') {
          const browser = findBrowser();
          return json(res, 200, {
            profiles: store.list().map(withRunning),
            running: launcher.listRunning(),
            browserPath: browser,
            timezones: store.TIMEZONES,
            webglPool: store.WEBGL_POOL,
            screenPool: store.SCREEN_POOL,
          });
        }

        if (method === 'GET' && pathname === '/api/browsers') {
          const { candidates } = require('./browser');
          return json(res, 200, {
            found: findBrowser(),
            candidates: candidates().filter((p) => {
              try {
                return p && fs.existsSync(p);
              } catch {
                return false;
              }
            }),
          });
        }

        if (method === 'POST' && pathname === '/api/random') {
          const body = await readBody(req);
          return json(res, 200, store.randomFingerprint(body.platform));
        }

        if (method === 'POST' && pathname === '/api/shutdown') {
          json(res, 200, { ok: true });
          // 先把响应发出去，再关环境退出；不然页面会看到连接被掐断
          setTimeout(async () => {
            try {
              await launcher.stopAll();
            } catch {
              /* ignore */
            }
            process.exit(0);
          }, 250);
          return;
        }

        // 导出：不含密码，可迁移到另一台机器
        if (method === 'GET' && pathname === '/api/export') {
          const body = JSON.stringify(
            { version: 1, exportedAt: new Date().toISOString(), profiles: store.exportAll() },
            null,
            2
          );
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(body),
            'content-disposition': 'attachment; filename="fb-profiles.json"',
            'cache-control': 'no-store',
          });
          return res.end(body);
        }

        if (method === 'POST' && pathname === '/api/import') {
          const body = await readBody(req);
          const items = Array.isArray(body)
            ? body
            : body && Array.isArray(body.profiles)
              ? body.profiles
              : null;
          if (!items) return json(res, 400, { error: '导入文件里没有 profiles 数组' });
          const created = store.importAll(items);
          return json(res, 200, { imported: created.length, profiles: created.map(withRunning) });
        }

        if (method === 'POST' && pathname === '/api/profiles') {
          const body = await readBody(req);
          const p = store.create(body);
          return json(res, 200, withRunning(p));
        }

        if (seg[0] === 'profiles' && seg[1]) {
          const id = seg[1];
          const action = seg[2];

          if (method === 'GET' && !action) {
            const p = store.get(id);
            if (!p) return json(res, 404, { error: '环境不存在' });
            return json(res, 200, withRunning(p));
          }

          if (method === 'PUT' && !action) {
            const body = await readBody(req);
            const p = store.update(id, body);
            if (!p) return json(res, 404, { error: '环境不存在' });
            return json(res, 200, withRunning(p));
          }

          if (method === 'DELETE' && !action) {
            const wasRunning = !!launcher.getRunning(id);
            if (wasRunning) await launcher.stop(id);
            const ok = store.remove(id);
            if (!ok) return json(res, 404, { error: '环境不存在' });
            return json(res, 200, { ok: true });
          }

          if (method === 'POST' && action === 'launch') {
            const body = await readBody(req);
            const info = await launcher.launch(id, { startUrl: body.startUrl });
            return json(res, 200, info);
          }

          if (method === 'POST' && action === 'stop') {
            const ok = await launcher.stop(id);
            return json(res, 200, { ok });
          }

          if (method === 'POST' && action === 'probe') {
            const report = await launcher.probe(id);
            return json(res, 200, report);
          }

          if (method === 'POST' && action === 'clone') {
            const p = store.clone(id);
            if (!p) return json(res, 404, { error: '环境不存在' });
            return json(res, 200, withRunning(p));
          }

          if (method === 'POST' && action === 'proxy-test') {
            const p = store.get(id);
            if (!p) return json(res, 404, { error: '环境不存在' });
            const px = p.proxy || {};
            if (px.type === 'none' || !px.host || !px.port) {
              return json(res, 400, { error: '这个环境没有配置代理' });
            }
            const result = await testProxy({
              type: px.type,
              host: px.host,
              port: px.port,
              username: px.username,
              password: px.password,
            });
            return json(res, 200, result);
          }
        }

        return json(res, 404, { error: '接口不存在：' + pathname });
      }

      /* ------------------------------ 静态页面 ------------------------------ */
      if (method !== 'GET') {
        res.writeHead(405).end('method not allowed');
        return;
      }
      serveStatic(req, res, pathname);
    } catch (e) {
      json(res, 500, { error: e && e.message ? e.message : String(e) });
    }
  });

  return server;
}

module.exports = { createServer };
