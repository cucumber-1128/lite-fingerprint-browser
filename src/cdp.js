'use strict';
/**
 * 极简 Chrome DevTools Protocol 客户端。
 * 只用 Node 22 内置的全局 WebSocket，不依赖 ws 包。
 * 支持 flatten 模式（sessionId 复用同一条连接）。
 */
const EventEmitter = require('node:events');

class CDP extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this._id = 0;
    this._pending = new Map();
    this._closed = false;
  }

  /** 建立连接并等待 open */
  static connect(url, timeoutMs = 10000) {
    const c = new CDP(url);
    return c._open(timeoutMs).then(() => c);
  }

  _open(timeoutMs) {
    return new Promise((resolve, reject) => {
      if (typeof WebSocket === 'undefined') {
        return reject(new Error('当前 Node 没有全局 WebSocket，请使用 Node 22 及以上'));
      }
      let settled = false;
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      };
      const timer = setTimeout(
        () => done(reject, new Error('连接 DevTools 超时：' + this.url)),
        timeoutMs
      );
      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        return done(reject, e);
      }
      this.ws = ws;
      ws.addEventListener('open', () => done(resolve));
      ws.addEventListener('error', (ev) => {
        const msg = (ev && (ev.message || (ev.error && ev.error.message))) || '未知错误';
        done(reject, new Error('DevTools WebSocket 错误：' + msg));
      });
      ws.addEventListener('message', (ev) => this._onMessage(ev.data));
      ws.addEventListener('close', () => {
        this._closed = true;
        for (const p of this._pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error('CDP 连接已关闭'));
        }
        this._pending.clear();
        this.emit('close');
      });
    });
  }

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    } catch {
      return;
    }
    if (msg.id) {
      const p = this._pending.get(msg.id);
      if (!p) return;
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      const sid = msg.sessionId;
      this.emit(msg.method, msg.params || {}, sid);
      this.emit('*', msg.method, msg.params || {}, sid);
    }
  }

  /** 发送一条 CDP 指令 */
  send(method, params = {}, sessionId) {
    if (this._closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = ++this._id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (e) {
      return Promise.reject(e);
    }
    return new Promise((resolve, reject) => {
      // 定时器必须清掉：每条指令漏一个 15s 的 timer，长跑的控制台会一直堆积
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error('CDP 指令超时：' + method));
        }
      }, 15000);
      if (typeof timer.unref === 'function') timer.unref();
      this._pending.set(id, { resolve, reject, timer });
    });
  }

  /** 发送并吞掉错误（用于可选指令） */
  async try_(method, params, sessionId) {
    try {
      return await this.send(method, params, sessionId);
    } catch {
      return null;
    }
  }

  close() {
    this._closed = true;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

module.exports = { CDP };
