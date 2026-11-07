'use strict';
/** 本地控制台服务：零依赖 HTTP + JSON API + 静态页面 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const store = require('./store');
const launcher = require('./launch');
const { findBrowser } = require('./browser');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

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
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  });
}

function withRunning(profile) {
  const info = launcher.getRunning(profile.id);
  return { ...profile, running: !!info, instance: info };
}

function createServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    const method = req.method || 'GET';

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
