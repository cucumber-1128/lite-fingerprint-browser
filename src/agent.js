'use strict';
/**
 * 面向 AI Agent 的无痕浏览器操控原语：
 *   - 绝不调用 Runtime.enable / Debugger.enable（防止被反爬与风控脚本检测 CDP）
 *   - @e1 / @e2 引用映射保存在 Node 内存，不在 window 或 DOM 树里留下任何属性 / Symbol
 *   - 所有点击与输入通过 CDP Input.dispatch* 派发，事件保持 isTrusted === true
 *   - 遇到人机验证组件仅做被动识别并拒绝自动化点击，引导人工接管完成
 */
const fs = require('node:fs');
const path = require('node:path');
const launcher = require('./launch');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHALLENGE_MSG =
  '检测到人机验证组件，禁止自动点击或绕过。请调用 focus 将窗口切到前台，交由用户手动完成验证后再继续。';

/** 公共 DOM 辅助片段（只跑在一次性 IIFE 里，不向 window 挂任何变量） */
const INPAGE_HELPERS = `
var CHALLENGE_RE = /challenges\\.cloudflare\\.com|turnstile|recaptcha|hcaptcha|arkoselabs|funcaptcha|geetest/i;
var CHALLENGE_SEL = '#cf-challenge-running, #challenge-running, .cf-turnstile, .g-recaptcha, .h-captcha, .geetest_panel, altcha-widget, #challenge-form';

function isVisible(el) {
  if (!el || el.nodeType !== 1) return false;
  var style;
  try { style = getComputedStyle(el); } catch (e) { return false; }
  if (!style || style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
  var r = el.getBoundingClientRect();
  return r.width > 1 && r.height > 1;
}

function isChallengeIframe(el) {
  if (!el || el.tagName !== 'IFRAME') return false;
  var src = String(el.getAttribute('src') || el.src || '');
  var title = String(el.getAttribute('title') || '');
  return CHALLENGE_RE.test(src) || CHALLENGE_RE.test(title);
}

function isChallengeNode(el) {
  var cur = el;
  while (cur) {
    if (cur.nodeType === 1) {
      if (isChallengeIframe(cur)) return true;
      if (cur.matches && cur.matches(CHALLENGE_SEL)) return true;
    }
    if (cur.parentElement) {
      cur = cur.parentElement;
    } else {
      var root = cur.getRootNode ? cur.getRootNode() : null;
      cur = root && root.host ? root.host : null;
    }
  }
  return false;
}

function detectChallenge() {
  var matched = [];
  function scanRoot(root) {
    if (!root || !root.querySelectorAll) return;
    var iframes = root.querySelectorAll('iframe');
    for (var i = 0; i < iframes.length; i++) {
      var f = iframes[i];
      if (isChallengeIframe(f) && isVisible(f)) {
        matched.push(String(f.getAttribute('src') || f.title || 'challenge-iframe').slice(0, 120));
      }
    }
    var widgets = root.querySelectorAll(CHALLENGE_SEL);
    for (var j = 0; j < widgets.length; j++) {
      var w = widgets[j];
      if (isVisible(w)) {
        matched.push((w.id ? '#' + w.id : '') || String(w.className || '').trim() || w.tagName.toLowerCase());
      }
    }
    var cfInput = root.querySelector('[name="cf-turnstile-response"]');
    if (cfInput) {
      var form = cfInput.closest('form');
      if (!form || isVisible(form)) matched.push('cf-turnstile-response');
    }
    var all = root.querySelectorAll('*');
    for (var k = 0; k < all.length; k++) {
      if (all[k].shadowRoot) scanRoot(all[k].shadowRoot);
    }
  }
  scanRoot(document);
  if (!matched.length) return null;
  return {
    type: matched[0],
    matches: matched.slice(0, 5),
    message: ${JSON.stringify(CHALLENGE_MSG)}
  };
}

function resolveLocator(loc) {
  if (!Array.isArray(loc) || !loc.length) return null;
  var node = document;
  for (var i = 0; i < loc.length; i++) {
    var sel = loc[i];
    var found = null;
    try { found = node.querySelector(sel); } catch (e) { return null; }
    if (!found) return null;
    if (i < loc.length - 1) {
      if (!found.shadowRoot) return null;
      node = found.shadowRoot;
    } else {
      node = found;
    }
  }
  return node;
}

function findBySelectorDeep(sel) {
  function search(root) {
    try {
      var direct = root.querySelector(sel);
      if (direct) return direct;
    } catch (e) {
      return { __selectorError: e && e.message ? e.message : String(e) };
    }
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      if (all[i].shadowRoot) {
        var sub = search(all[i].shadowRoot);
        if (sub) return sub;
      }
    }
    return null;
  }
  return search(document);
}

function accessibleName(el) {
  var a = el.getAttribute && el.getAttribute('aria-label');
  if (a && a.trim()) return a.trim();
  var lb = el.getAttribute && el.getAttribute('aria-labelledby');
  if (lb) {
    var parts = lb.trim().split(/\\s+/).map(function (id) {
      var r = el.getRootNode && el.getRootNode();
      var target = (r && r.getElementById ? r.getElementById(id) : null) || document.getElementById(id);
      return target ? String(target.innerText || target.textContent || '').trim() : '';
    }).filter(Boolean);
    if (parts.length) return parts.join(' ');
  }
  if ((el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') && el.id) {
    try {
      var root = el.getRootNode && el.getRootNode();
      var lbl = (root && root.querySelector ? root.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null) ||
        document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lbl) {
        var lt = String(lbl.innerText || lbl.textContent || '').trim();
        if (lt) return lt;
      }
    } catch (e) {}
  }
  if (el.closest) {
    var wrapLbl = el.closest('label');
    if (wrapLbl) {
      var wt = String(wrapLbl.innerText || wrapLbl.textContent || '').trim();
      if (wt) return wt;
    }
  }
  var ph = el.getAttribute && el.getAttribute('placeholder');
  if (ph && ph.trim()) return ph.trim();
  var ttl = el.getAttribute && el.getAttribute('title');
  if (ttl && ttl.trim()) return ttl.trim();
  var alt = el.getAttribute && el.getAttribute('alt');
  if (alt && alt.trim()) return alt.trim();
  if (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button' || el.type === 'reset')) {
    return String(el.value || '').trim();
  }
  if (el.tagName === 'SELECT') {
    var opt = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
    if (opt && opt.textContent) return opt.textContent.trim();
  }
  return String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
}

function isInteractive(el) {
  if (!el || el.nodeType !== 1) return false;
  var tag = el.tagName;
  if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'SUMMARY') return true;
  if (tag === 'A' && el.hasAttribute('href')) return true;
  if (tag === 'INPUT' && String(el.type || '').toLowerCase() !== 'hidden') return true;
  if (el.isContentEditable) return true;
  var role = String(el.getAttribute('role') || '').toLowerCase();
  if (/^(button|link|textbox|searchbox|checkbox|radio|combobox|menuitem|tab|switch|option)$/.test(role)) return true;
  var ti = el.getAttribute('tabindex');
  if (ti !== null && parseInt(ti, 10) >= 0 && tag !== 'BODY' && tag !== 'HTML') return true;
  return false;
}

function findByText(needle) {
  var q = String(needle || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  if (!q) return null;
  var exactInteractive = null;
  var partialInteractive = null;
  var exactAny = null;
  var partialAny = null;
  function walk(root) {
    if (!root || !root.querySelectorAll) return;
    var nodes = root.querySelectorAll('*');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (isVisible(el)) {
        var name = accessibleName(el).replace(/\\s+/g, ' ').trim().toLowerCase();
        var inter = isInteractive(el);
        if (name === q) {
          if (inter && !exactInteractive) exactInteractive = el;
          if (!exactAny) exactAny = el;
        } else if (name && name.indexOf(q) >= 0) {
          if (inter && !partialInteractive) partialInteractive = el;
          if (!partialAny) partialAny = el;
        }
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  }
  walk(document);
  return exactInteractive || exactAny || partialInteractive || partialAny;
}
`;

function requireRunning(profileId) {
  const inst = launcher.getInstance(profileId);
  if (!inst || !inst.cdp) {
    throw new Error('环境未运行：' + profileId + '（请先执行 launch 启动环境）');
  }
  if (!inst.__agentRefs) inst.__agentRefs = new Map();
  if (!Array.isArray(inst.__tabOrder)) inst.__tabOrder = [];
  return inst;
}

function isUserPageTarget(t) {
  if (!t || t.type !== 'page') return false;
  const u = String(t.url || '');
  if (
    u.startsWith('devtools://') ||
    u.startsWith('chrome-extension://') ||
    u.startsWith('chrome-untrusted://') ||
    u.startsWith('chrome://omnibox') ||
    u.startsWith('chrome://top-chrome')
  ) {
    return false;
  }
  if (/^http:\/\/127\.0\.0\.1:\d+\/probe(?:\?|$)/.test(u)) return false;
  return true;
}

async function ensurePageSession(inst, targetId) {
  const cdp = inst.cdp;
  let sessionId = inst.sessions.get(targetId);
  if (!sessionId) {
    // Target.attachedToTarget 可能正在异步到达，稍等片刻再兜底手动 attach
    const t0 = Date.now();
    while (!sessionId && Date.now() - t0 < 250) {
      await sleep(25);
      sessionId = inst.sessions.get(targetId);
    }
  }
  if (!sessionId) {
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    sessionId = attached.sessionId;
    inst.sessions.set(targetId, sessionId);
  }
  await cdp.try_('Page.enable', {}, sessionId);
  if (inst.__uaOverride) await cdp.try_('Emulation.setUserAgentOverride', inst.__uaOverride, sessionId);
  if (inst.__tz) await cdp.try_('Emulation.setTimezoneOverride', { timezoneId: inst.__tz }, sessionId);
  if (inst.__locale) await cdp.try_('Emulation.setLocaleOverride', { locale: inst.__locale }, sessionId);
  if (inst.__geo) await cdp.try_('Emulation.setGeolocationOverride', inst.__geo, sessionId);

  if (targetId && !inst.scripted.has(targetId) && inst.__script) {
    // 若 Target.attachedToTarget 正在执行 applySession，给它一点时间避免重复 addScript
    const t1 = Date.now();
    while (!inst.scripted.has(targetId) && Date.now() - t1 < 200) {
      await sleep(25);
    }
    if (!inst.scripted.has(targetId)) {
      const added = await cdp.try_(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: inst.__script, runImmediately: true },
        sessionId
      );
      if (added !== null) inst.scripted.add(targetId);
    }
  }
  return sessionId;
}

async function getOrderedTabs(inst) {
  const { targetInfos } = await inst.cdp.send('Target.getTargets');
  const pages = (targetInfos || []).filter(isUserPageTarget);
  const byId = new Map(pages.map((t) => [t.targetId, t]));

  const nextOrder = [];
  for (const tid of inst.__tabOrder) {
    if (byId.has(tid) && !nextOrder.includes(tid)) nextOrder.push(tid);
  }
  for (const t of pages) {
    if (!nextOrder.includes(t.targetId)) nextOrder.push(t.targetId);
  }
  inst.__tabOrder = nextOrder;
  return nextOrder.map((tid) => byId.get(tid)).filter(Boolean);
}

async function createBlankTab(inst) {
  const cdp = inst.cdp;
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const t0 = Date.now();
  while ((!inst.sessions.get(targetId) || !inst.scripted.has(targetId)) && Date.now() - t0 < 1500) {
    await sleep(30);
  }
  const sessionId = await ensurePageSession(inst, targetId);
  if (!inst.__tabOrder.includes(targetId)) inst.__tabOrder.push(targetId);
  inst.__activeTargetId = targetId;
  await cdp.try_('Page.bringToFront', {}, sessionId);
  return { targetId, sessionId };
}

async function resolveTab(inst, tabSpec) {
  let ordered = await getOrderedTabs(inst);
  if (!ordered.length) {
    await createBlankTab(inst);
    ordered = await getOrderedTabs(inst);
  }

  let target = null;
  if (tabSpec !== undefined && tabSpec !== null && tabSpec !== '') {
    const s = String(tabSpec).trim();
    if (/^\d+$/.test(s)) {
      const idx = Number(s);
      if (idx < 0 || idx >= ordered.length) {
        throw new Error('标签页索引越界：' + s + '（当前共 ' + ordered.length + ' 个标签页）');
      }
      target = ordered[idx];
    } else {
      target =
        ordered.find((t) => t.targetId === s) ||
        ordered.find((t) => t.targetId.startsWith(s)) ||
        null;
      if (!target) throw new Error('找不到标签页：' + s);
    }
  } else {
    target =
      (inst.__activeTargetId && ordered.find((t) => t.targetId === inst.__activeTargetId)) ||
      ordered[ordered.length - 1];
  }

  inst.__activeTargetId = target.targetId;
  const sessionId = await ensurePageSession(inst, target.targetId);
  return { target, sessionId, tabs: ordered };
}

async function evalRaw(cdp, sessionId, expression, returnByValue = true, timeoutMs = 15000) {
  const res = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue },
    sessionId,
    timeoutMs
  );
  if (res && res.exceptionDetails) {
    const ex = res.exceptionDetails;
    const msg =
      (ex.exception && (ex.exception.description || ex.exception.value)) || ex.text || '页面脚本执行异常';
    throw new Error(String(msg));
  }
  return res ? res.result : null;
}

async function evalJson(cdp, sessionId, expression, timeoutMs = 15000) {
  const result = await evalRaw(cdp, sessionId, expression, true, timeoutMs);
  if (!result || result.value === undefined) return null;
  return result.value;
}

function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) throw new Error('请提供 URL');
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return s;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(s)) return 'http://' + s;
  return 'https://' + s;
}

/* ------------------------------- 标签页管理 ------------------------------- */

async function listTabs(profileId) {
  const inst = requireRunning(profileId);
  const ordered = await getOrderedTabs(inst);
  if (ordered.length && (!inst.__activeTargetId || !ordered.some((t) => t.targetId === inst.__activeTargetId))) {
    inst.__activeTargetId = ordered[ordered.length - 1].targetId;
  }
  return {
    ok: true,
    profileId,
    activeTargetId: inst.__activeTargetId || null,
    tabs: ordered.map((t, index) => ({
      index,
      targetId: t.targetId,
      title: t.title || '',
      url: t.url || '',
      active: t.targetId === inst.__activeTargetId,
    })),
  };
}

async function newTab(profileId, url = 'about:blank') {
  const inst = requireRunning(profileId);
  const { targetId } = await createBlankTab(inst);
  const cleanUrl = url && String(url).trim() && String(url).trim() !== 'about:blank' ? String(url).trim() : '';
  if (cleanUrl) {
    const nav = await navigate(profileId, { url: cleanUrl, tab: targetId });
    const list = await listTabs(profileId);
    return { ...nav, tabs: list.tabs };
  }
  const list = await listTabs(profileId);
  return {
    ok: true,
    targetId,
    url: 'about:blank',
    title: '',
    blockedByChallenge: false,
    challenge: null,
    tabs: list.tabs,
  };
}

async function switchTab(profileId, tabSpec) {
  if (tabSpec === undefined || tabSpec === null || tabSpec === '') {
    throw new Error('请指定要切换的标签页索引或 targetId');
  }
  const inst = requireRunning(profileId);
  const { target, sessionId } = await resolveTab(inst, tabSpec);
  inst.__activeTargetId = target.targetId;
  await inst.cdp.try_('Page.bringToFront', {}, sessionId);
  const list = await listTabs(profileId);
  return {
    ok: true,
    targetId: target.targetId,
    tab: list.tabs.find((t) => t.targetId === target.targetId) || null,
    tabs: list.tabs,
  };
}

async function closeTab(profileId, tabSpec) {
  const inst = requireRunning(profileId);
  const { target } = await resolveTab(inst, tabSpec);
  await inst.cdp.send('Target.closeTarget', { targetId: target.targetId });
  inst.__agentRefs.delete(target.targetId);
  inst.__tabOrder = inst.__tabOrder.filter((id) => id !== target.targetId);
  inst.sessions.delete(target.targetId);
  inst.scripted.delete(target.targetId);
  if (inst.__activeTargetId === target.targetId) inst.__activeTargetId = null;
  const list = await listTabs(profileId);
  return {
    ok: true,
    closedTargetId: target.targetId,
    activeTargetId: list.activeTargetId,
    tabs: list.tabs,
  };
}

async function focus(profileId, opts = {}) {
  const inst = requireRunning(profileId);
  const { target, sessionId } = await resolveTab(inst, opts.tab);
  await inst.cdp.try_('Page.bringToFront', {}, sessionId);
  let info = null;
  try {
    info = await evalJson(inst.cdp, sessionId, '({ url: location.href, title: document.title })', 5000);
  } catch {
    info = null;
  }
  return {
    ok: true,
    targetId: target.targetId,
    url: (info && info.url) || target.url || '',
    title: (info && info.title) || target.title || '',
  };
}

/* ---------------------------------- 导航 ---------------------------------- */

async function waitForDocumentState(cdp, sessionId, waitUntil, timeoutMs, opts = {}) {
  let eventFired = false;
  let mainFrameNavigated = false;
  const eventName = waitUntil === 'domcontentloaded' ? 'Page.domContentEventFired' : 'Page.loadEventFired';
  const onEvent = (params, sid) => {
    if (sid === sessionId) eventFired = true;
  };
  const onNav = (params, sid) => {
    if (sid === sessionId && params && params.frame && !params.frame.parentId) {
      mainFrameNavigated = true;
    }
  };
  cdp.on(eventName, onEvent);
  if (opts.historyNav) cdp.on('Page.frameNavigated', onNav);
  const cleanup = () => {
    cdp.removeListener(eventName, onEvent);
    if (opts.historyNav) cdp.removeListener('Page.frameNavigated', onNav);
  };
  return {
    cleanup,
    async wait(needsLoad = true) {
      try {
        if (!needsLoad) {
          await sleep(80);
          return;
        }
        const deadline = Date.now() + timeoutMs;
        while (!eventFired && Date.now() < deadline) {
          await sleep(50);
          if (eventFired) break;
          // history back/forward（bfcache）不一定触发 loadEventFired，收到主框架导航且 readyState 就绪即可返回
          if (opts.historyNav && mainFrameNavigated) {
            try {
              const rs = await evalJson(cdp, sessionId, 'document.readyState', 1500);
              if (rs === 'complete' || (waitUntil === 'domcontentloaded' && rs === 'interactive')) break;
            } catch {
              /* ignore */
            }
          }
          if (waitUntil === 'domcontentloaded') {
            try {
              const rs = await evalJson(cdp, sessionId, 'document.readyState', 1500);
              if (rs === 'interactive' || rs === 'complete') break;
            } catch {
              /* 导航切换瞬间执行上下文可能重建 */
            }
          }
        }
        const checkDeadline = Math.min(Date.now() + 2000, deadline);
        while (Date.now() < checkDeadline) {
          try {
            const rs = await evalJson(cdp, sessionId, 'document.readyState', 1500);
            if (waitUntil === 'domcontentloaded' ? rs === 'interactive' || rs === 'complete' : rs === 'complete') {
              break;
            }
          } catch {
            /* ignore */
          }
          await sleep(50);
        }
        await sleep(80);
      } finally {
        cleanup();
      }
    },
  };
}

async function navigate(profileId, opts = {}) {
  const inst = requireRunning(profileId);
  const cdp = inst.cdp;
  const { target, sessionId } = await resolveTab(inst, opts.tab);
  const action = String(opts.action || 'goto').toLowerCase();
  const waitUntil = opts.waitUntil === 'domcontentloaded' ? 'domcontentloaded' : 'load';
  const timeoutMs = Math.max(1000, Math.min(60000, Number(opts.timeoutMs) || 20000));

  const waiter = await waitForDocumentState(cdp, sessionId, waitUntil, timeoutMs, {
    historyNav: action === 'back' || action === 'forward',
  });
  let needsWait = true;
  try {
    if (action === 'goto') {
      const targetUrl = normalizeUrl(opts.url);
      const navRes = await cdp.send('Page.navigate', { url: targetUrl }, sessionId, timeoutMs);
      if (navRes && navRes.errorText) {
        throw new Error('页面导航失败：' + navRes.errorText);
      }
      if (navRes && !navRes.loaderId) needsWait = false;
    } else if (action === 'back' || action === 'forward') {
      const hist = await cdp.send('Page.getNavigationHistory', {}, sessionId);
      const delta = action === 'back' ? -1 : 1;
      const nextIdx = hist.currentIndex + delta;
      if (!hist.entries || nextIdx < 0 || nextIdx >= hist.entries.length) {
        throw new Error(action === 'back' ? '无法后退：已经在最早的历史记录' : '无法前进：已经在最新的历史记录');
      }
      await cdp.send('Page.navigateToHistoryEntry', { entryId: hist.entries[nextIdx].id }, sessionId);
    } else if (action === 'reload') {
      await cdp.send('Page.reload', { ignoreCache: !!opts.ignoreCache }, sessionId);
    } else {
      throw new Error('不支持的导航动作：' + action);
    }
    await waiter.wait(needsWait);
  } catch (e) {
    waiter.cleanup();
    throw e;
  }

  // 页面变更后清空旧 @eN 引用缓存，防止误点错位元素
  inst.__agentRefs.delete(target.targetId);

  const info = await evalJson(
    cdp,
    sessionId,
    `(() => {
      ${INPAGE_HELPERS}
      return {
        url: location.href,
        title: document.title,
        challenge: detectChallenge()
      };
    })()`,
    timeoutMs
  );

  return {
    ok: true,
    targetId: target.targetId,
    url: (info && info.url) || '',
    title: (info && info.title) || '',
    blockedByChallenge: !!(info && info.challenge),
    challenge: (info && info.challenge) || null,
  };
}

/* -------------------------------- 页面快照 -------------------------------- */

async function snapshot(profileId, opts = {}) {
  const inst = requireRunning(profileId);
  const { target, sessionId } = await resolveTab(inst, opts.tab);
  const maxText = Math.max(100, Math.min(50000, Number(opts.maxText) || 4000));
  const maxElements = Math.max(10, Math.min(1000, Number(opts.maxElements) || 200));
  const scopeSelector = opts.selector ? String(opts.selector) : '';

  const data = await evalJson(
    inst.cdp,
    sessionId,
    `((opts) => {
      ${INPAGE_HELPERS}

      function inferRole(el) {
        var explicit = el.getAttribute && el.getAttribute('role');
        if (explicit) return explicit;
        var tag = el.tagName;
        if (tag === 'A') return 'link';
        if (tag === 'BUTTON') return 'button';
        if (tag === 'SELECT') return 'combobox';
        if (tag === 'TEXTAREA') return 'textbox';
        if (tag === 'INPUT') {
          var t = String(el.type || 'text').toLowerCase();
          if (t === 'checkbox') return 'checkbox';
          if (t === 'radio') return 'radio';
          if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
          if (t === 'search') return 'searchbox';
          return 'textbox';
        }
        return tag.toLowerCase();
      }

      function pathInRoot(el, root) {
        if (el.id) {
          try {
            var qid = '#' + CSS.escape(el.id);
            var list = root.querySelectorAll(qid);
            if (list.length === 1 && list[0] === el) return qid;
          } catch (e) {}
        }
        var parts = [];
        var cur = el;
        while (cur && cur.nodeType === 1 && cur !== root) {
          var tag = cur.tagName.toLowerCase();
          var parent = cur.parentElement;
          if (!parent) {
            var topKids = root.children || [];
            var topIdx = 1;
            for (var i = 0; i < topKids.length; i++) {
              if (topKids[i] === cur) break;
              topIdx++;
            }
            parts.unshift(':scope > ' + tag + ':nth-child(' + topIdx + ')');
            break;
          }
          var kids = parent.children;
          var nth = 1;
          for (var j = 0; j < kids.length; j++) {
            if (kids[j] === cur) break;
            nth++;
          }
          parts.unshift(tag + ':nth-child(' + nth + ')');
          cur = parent;
        }
        return parts.join(' > ');
      }

      var scopeEl = document;
      if (opts.scopeSelector) {
        var foundScope = findBySelectorDeep(opts.scopeSelector);
        if (foundScope && foundScope.__selectorError) {
          return { error: '选择器语法错误：' + foundScope.__selectorError };
        }
        if (!foundScope) return { error: '找不到快照容器选择器：' + opts.scopeSelector };
        scopeEl = foundScope;
      }

      var challenge = detectChallenge();
      var items = [];
      var seq = 0;

      function walkDom(node, root, prefix) {
        if (items.length >= opts.maxElements) return;
        if (!node || node.nodeType !== 1) return;
        if (isChallengeNode(node)) return;

        if (isInteractive(node) && isVisible(node)) {
          var r = node.getBoundingClientRect();
          seq++;
          var tag = node.tagName.toLowerCase();
          var name = accessibleName(node);
          if (name.length > 120) name = name.slice(0, 117) + '...';
          var entry = {
            ref: '@e' + seq,
            role: inferRole(node),
            tag: tag,
            name: name,
            disabled: !!node.disabled || node.getAttribute('aria-disabled') === 'true',
            rect: {
              x: Math.round(r.left),
              y: Math.round(r.top),
              w: Math.round(r.width),
              h: Math.round(r.height)
            },
            _loc: prefix.concat([pathInRoot(node, root)])
          };
          if (tag === 'input') {
            var it = String(node.type || 'text').toLowerCase();
            entry.type = it;
            if (it === 'checkbox' || it === 'radio') {
              entry.checked = !!node.checked;
            } else if (it === 'password') {
              entry.value = node.value ? '***' : '';
            } else if (node.value) {
              entry.value = String(node.value).slice(0, 120);
            }
          } else if (tag === 'textarea') {
            if (node.value) entry.value = String(node.value).slice(0, 120);
          } else if (tag === 'select') {
            entry.value = String(node.value || '').slice(0, 120);
            if (node.options && node.options.length <= 20) {
              entry.options = [];
              for (var oi = 0; oi < node.options.length; oi++) {
                entry.options.push({
                  value: String(node.options[oi].value),
                  label: String(node.options[oi].textContent || '').trim()
                });
              }
            }
          }
          items.push(entry);
        }

        if (node.shadowRoot) {
          var nextPrefix = prefix.concat([pathInRoot(node, root)]);
          var sKids = node.shadowRoot.children;
          for (var si = 0; si < sKids.length; si++) {
            if (items.length >= opts.maxElements) break;
            walkDom(sKids[si], node.shadowRoot, nextPrefix);
          }
        }
        var kids = node.children;
        for (var ci = 0; ci < kids.length; ci++) {
          if (items.length >= opts.maxElements) break;
          walkDom(kids[ci], root, prefix);
        }
      }

      if (scopeEl === document) {
        if (document.documentElement) walkDom(document.documentElement, document, []);
      } else {
        var scopeRoot = scopeEl.getRootNode ? scopeEl.getRootNode() : document;
        var rootPrefix = [];
        var rCur = scopeRoot;
        while (rCur && rCur.host) {
          var hostParentRoot = rCur.host.getRootNode ? rCur.host.getRootNode() : document;
          rootPrefix.unshift(pathInRoot(rCur.host, hostParentRoot));
          rCur = hostParentRoot;
        }
        walkDom(scopeEl, scopeRoot, rootPrefix);
      }

      var rawTextSource = scopeEl === document ? (document.body || document.documentElement) : scopeEl;
      var text = rawTextSource ? String(rawTextSource.innerText || rawTextSource.textContent || '') : '';
      text = text.replace(/\\r\\n/g, '\\n').replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
      var truncated = text.length > opts.maxText;
      if (truncated) text = text.slice(0, opts.maxText) + '\\n... (truncated)';

      return {
        url: location.href,
        title: document.title,
        challenge: challenge,
        elements: items,
        text: text,
        textTruncated: truncated
      };
    })(${JSON.stringify({ scopeSelector, maxText, maxElements })})`
  );

  if (data && data.error) throw new Error(data.error);

  const refMap = new Map();
  const elements = [];
  for (const item of (data && data.elements) || []) {
    if (Array.isArray(item._loc) && item._loc.length) {
      refMap.set(item.ref, item._loc);
    }
    const clean = { ...item };
    delete clean._loc;
    elements.push(clean);
  }
  inst.__agentRefs.set(target.targetId, refMap);

  return {
    ok: true,
    targetId: target.targetId,
    url: (data && data.url) || '',
    title: (data && data.title) || '',
    blockedByChallenge: !!(data && data.challenge),
    challenge: (data && data.challenge) || null,
    elementCount: elements.length,
    elements,
    text: (data && data.text) || '',
    textTruncated: !!(data && data.textTruncated),
  };
}

/* -------------------------------- 元素定位与键鼠原语 -------------------------------- */

function parseRefTarget(inst, targetId, targetSpec) {
  const s = String(targetSpec || '').trim();
  if (!s) throw new Error('请提供目标元素（@e1、CSS 选择器或 text=...）');
  const m = /^@?e(\d+)$/i.exec(s);
  if (m) {
    const key = '@e' + m[1];
    const refMap = inst.__agentRefs && inst.__agentRefs.get(targetId);
    const loc = refMap && refMap.get(key);
    if (!loc) {
      throw new Error('未找到元素引用 ' + key + '（页面可能已刷新或未执行过 snapshot，请先执行 snapshot）');
    }
    return { kind: 'locator', loc, display: key };
  }
  const tm = /^text[:=](.+)$/i.exec(s);
  if (tm) {
    return { kind: 'text', query: tm[1].trim(), display: s };
  }
  return { kind: 'selector', selector: s, display: s };
}

function buildLookupSnippet(parsed) {
  return `
    function lookupElement() {
      var spec = ${JSON.stringify(parsed)};
      if (spec.kind === 'locator') return resolveLocator(spec.loc);
      if (spec.kind === 'text') return findByText(spec.query);
      return findBySelectorDeep(spec.selector);
    }
  `;
}

async function locateTarget(inst, sessionId, targetId, targetSpec, opts = {}) {
  const parsed = parseRefTarget(inst, targetId, targetSpec);
  const info = await evalJson(
    inst.cdp,
    sessionId,
    `(() => {
      ${INPAGE_HELPERS}
      ${buildLookupSnippet(parsed)}
      var el = lookupElement();
      if (!el) return { missing: true };
      if (el.__selectorError) return { selectorError: el.__selectorError };
      if (isChallengeNode(el)) return { blocked: true };
      try {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      } catch (e) {
        try { el.scrollIntoView(true); } catch (e2) {}
      }
      var style = getComputedStyle(el);
      var r = el.getBoundingClientRect();
      if (${opts.allowHidden ? 'false' : 'true'}) {
        if (!style || style.display === 'none' || style.visibility === 'hidden' || r.width <= 0 || r.height <= 0) {
          return { hidden: true };
        }
      }
      return {
        ok: true,
        tag: el.tagName.toLowerCase(),
        type: el.tagName === 'INPUT' ? String(el.type || 'text').toLowerCase() : '',
        disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
        isContentEditable: !!el.isContentEditable,
        value: typeof el.value === 'string' ? el.value : String(el.textContent || ''),
        rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
      };
    })()`
  );

  if (!info || info.missing) throw new Error('找不到目标元素：' + parsed.display);
  if (info.selectorError) throw new Error('选择器语法错误：' + info.selectorError);
  if (info.blocked) throw new Error(CHALLENGE_MSG);
  if (info.hidden) throw new Error('目标元素当前不可见（宽/高为 0 或被隐藏）：' + parsed.display);

  const r = info.rect;
  const maxJx = Math.min(4, Math.max(0, r.width * 0.12));
  const maxJy = Math.min(4, Math.max(0, r.height * 0.12));
  const jx = (Math.random() * 2 - 1) * maxJx;
  const jy = (Math.random() * 2 - 1) * maxJy;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const cx = r.width > 2 ? clamp(r.left + r.width / 2 + jx, r.left + 1, r.right - 1) : r.left + r.width / 2;
  const cy = r.height > 2 ? clamp(r.top + r.height / 2 + jy, r.top + 1, r.bottom - 1) : r.top + r.height / 2;

  return {
    parsed,
    tag: info.tag,
    type: info.type,
    disabled: info.disabled,
    isContentEditable: info.isContentEditable,
    value: info.value,
    rect: r,
    x: Math.round(cx * 10) / 10,
    y: Math.round(cy * 10) / 10,
  };
}

async function assertPointNotChallenge(cdp, sessionId, x, y) {
  const blocked = await evalJson(
    cdp,
    sessionId,
    `(() => {
      ${INPAGE_HELPERS}
      var list = document.elementsFromPoint ? document.elementsFromPoint(${Number(x)}, ${Number(y)}) : [document.elementFromPoint(${Number(x)}, ${Number(y)})];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && isChallengeNode(list[i])) return true;
      }
      return false;
    })()`
  );
  if (blocked) throw new Error(CHALLENGE_MSG);
}

async function dispatchMouseClick(cdp, sessionId, x, y, opts = {}) {
  const button = opts.button || 'left';
  const buttons = button === 'right' ? 2 : 1;
  const clickCount = opts.clickCount || 1;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'mouse' }, sessionId);
  await sleep(16);
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x, y, button, buttons, clickCount: 1, pointerType: 'mouse' },
    sessionId
  );
  await sleep(22);
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1, pointerType: 'mouse' },
    sessionId
  );
  if (clickCount >= 2) {
    await sleep(30);
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button, buttons, clickCount: 2, pointerType: 'mouse' },
      sessionId
    );
    await sleep(20);
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 2, pointerType: 'mouse' },
      sessionId
    );
  }
}

const KEY_DEFS = {
  enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  del: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  up: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  right: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  down: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  end: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
};

const MOD_DEFS = {
  alt: { bit: 1, key: 'Alt', code: 'AltLeft', vk: 18 },
  control: { bit: 2, key: 'Control', code: 'ControlLeft', vk: 17 },
  ctrl: { bit: 2, key: 'Control', code: 'ControlLeft', vk: 17 },
  meta: { bit: 4, key: 'Meta', code: 'MetaLeft', vk: 91 },
  cmd: { bit: 4, key: 'Meta', code: 'MetaLeft', vk: 91 },
  command: { bit: 4, key: 'Meta', code: 'MetaLeft', vk: 91 },
  shift: { bit: 8, key: 'Shift', code: 'ShiftLeft', vk: 16 },
};

function resolveKeySpec(token) {
  const lower = String(token || '').toLowerCase();
  if (KEY_DEFS[lower]) return KEY_DEFS[lower];
  if (token.length === 1) {
    const code = token.charCodeAt(0);
    const upper = token.toUpperCase();
    let codeName = '';
    if (upper >= 'A' && upper <= 'Z') codeName = 'Key' + upper;
    else if (token >= '0' && token <= '9') codeName = 'Digit' + token;
    return {
      key: token,
      code: codeName || undefined,
      windowsVirtualKeyCode: upper.charCodeAt(0) || code,
      text: token,
    };
  }
  return { key: token, windowsVirtualKeyCode: 0 };
}

async function dispatchKeyChord(cdp, sessionId, chord) {
  const parts = String(chord || '')
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error('请指定按键名');

  const mods = [];
  let mainToken = parts[parts.length - 1];
  for (let i = 0; i < parts.length - 1; i++) {
    const m = MOD_DEFS[parts[i].toLowerCase()];
    if (!m) throw new Error('不支持的修饰键：' + parts[i]);
    mods.push(m);
  }
  let modifiers = 0;
  for (const m of mods) {
    modifiers |= m.bit;
    await cdp.send(
      'Input.dispatchKeyEvent',
      { type: 'keyDown', key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, modifiers },
      sessionId
    );
  }

  const def = resolveKeySpec(mainToken);
  const hasCmdMod = !!(modifiers & (1 | 2 | 4));
  const keyDownParams = {
    type: 'keyDown',
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.windowsVirtualKeyCode,
    modifiers,
  };
  if (def.text && !hasCmdMod) {
    keyDownParams.text = def.text;
    keyDownParams.unmodifiedText = def.text;
  }
  await cdp.send('Input.dispatchKeyEvent', keyDownParams, sessionId);
  await sleep(16);
  await cdp.send(
    'Input.dispatchKeyEvent',
    {
      type: 'keyUp',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.windowsVirtualKeyCode,
      modifiers,
    },
    sessionId
  );

  for (let i = mods.length - 1; i >= 0; i--) {
    const m = mods[i];
    modifiers &= ~m.bit;
    await cdp.send(
      'Input.dispatchKeyEvent',
      { type: 'keyUp', key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, modifiers },
      sessionId
    );
  }
}

/* -------------------------------- 交互动作 -------------------------------- */

async function act(profileId, opts = {}) {
  const inst = requireRunning(profileId);
  const cdp = inst.cdp;
  const { target, sessionId } = await resolveTab(inst, opts.tab);
  const targetId = target.targetId;
  const action = String(opts.action || '').toLowerCase();
  const targetSpec = opts.target !== undefined ? opts.target : opts.selector;

  if (!action) throw new Error('缺少 action 参数');

  if (action === 'click' || action === 'dblclick' || action === 'rightclick') {
    let x = opts.x;
    let y = opts.y;
    let meta = null;
    if (targetSpec !== undefined && targetSpec !== null && targetSpec !== '') {
      const loc = await locateTarget(inst, sessionId, targetId, targetSpec);
      if (loc.disabled) throw new Error('目标元素处于禁用状态：' + targetSpec);
      x = loc.x;
      y = loc.y;
      meta = { tag: loc.tag, target: String(targetSpec) };
    } else if (typeof x === 'number' && typeof y === 'number') {
      await assertPointNotChallenge(cdp, sessionId, x, y);
    } else {
      throw new Error('click 需要提供 target（@e1 / 选择器 / text=...）或坐标 x, y');
    }

    await dispatchMouseClick(cdp, sessionId, x, y, {
      button: action === 'rightclick' ? 'right' : 'left',
      clickCount: action === 'dblclick' ? 2 : 1,
    });
    return { ok: true, targetId, action, x, y, ...(meta || {}) };
  }

  if (action === 'hover') {
    const loc = await locateTarget(inst, sessionId, targetId, targetSpec);
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: loc.x, y: loc.y, pointerType: 'mouse' },
      sessionId
    );
    return { ok: true, targetId, action, x: loc.x, y: loc.y, tag: loc.tag };
  }

  if (action === 'fill') {
    const loc = await locateTarget(inst, sessionId, targetId, targetSpec);
    if (loc.disabled) throw new Error('输入框处于禁用状态：' + targetSpec);
    if (loc.tag === 'select') throw new Error('下拉框 <select> 请使用 select 命令而非 fill');
    await dispatchMouseClick(cdp, sessionId, loc.x, loc.y);
    await sleep(25);

    if (opts.clear !== false) {
      const hadContent = await evalJson(
        cdp,
        sessionId,
        `(() => {
          ${INPAGE_HELPERS}
          ${buildLookupSnippet(loc.parsed)}
          var el = lookupElement();
          if (!el) return false;
          try { el.focus(); } catch (e) {}
          if (typeof el.select === 'function') {
            el.select();
            return String(el.value || '').length > 0;
          }
          if (el.isContentEditable) {
            var s = window.getSelection();
            var r = document.createRange();
            r.selectNodeContents(el);
            s.removeAllRanges();
            s.addRange(r);
            return String(el.textContent || '').length > 0;
          }
          return false;
        })()`
      );
      if (hadContent) {
        await dispatchKeyChord(cdp, sessionId, 'Backspace');
        await sleep(20);
      }
    }

    const val = String(opts.value !== undefined ? opts.value : opts.text !== undefined ? opts.text : '');
    if (val) {
      await cdp.send('Input.insertText', { text: val }, sessionId);
    }
    if (opts.pressEnter) {
      await sleep(30);
      await dispatchKeyChord(cdp, sessionId, 'Enter');
    }
    return { ok: true, targetId, action, target: String(targetSpec), length: val.length };
  }

  if (action === 'type') {
    if (targetSpec !== undefined && targetSpec !== null && targetSpec !== '') {
      const loc = await locateTarget(inst, sessionId, targetId, targetSpec);
      if (loc.disabled) throw new Error('目标元素处于禁用状态：' + targetSpec);
      await dispatchMouseClick(cdp, sessionId, loc.x, loc.y);
      await sleep(25);
    }
    const text = String(opts.text !== undefined ? opts.text : opts.value !== undefined ? opts.value : '');
    const delayMs = opts.delayMs !== undefined ? Math.max(0, Math.min(500, Number(opts.delayMs) || 0)) : 20;
    for (const ch of Array.from(text)) {
      if (ch === '\n') {
        await dispatchKeyChord(cdp, sessionId, 'Enter');
      } else {
        const code = ch.charCodeAt(0);
        if (code >= 0x20 && code <= 0x7e) {
          const upper = ch.toUpperCase();
          await cdp.send(
            'Input.dispatchKeyEvent',
            {
              type: 'keyDown',
              key: ch,
              text: ch,
              unmodifiedText: ch,
              windowsVirtualKeyCode: upper.charCodeAt(0),
            },
            sessionId
          );
          await cdp.send(
            'Input.dispatchKeyEvent',
            {
              type: 'keyUp',
              key: ch,
              windowsVirtualKeyCode: upper.charCodeAt(0),
            },
            sessionId
          );
        } else {
          await cdp.send('Input.insertText', { text: ch }, sessionId);
        }
      }
      if (delayMs > 0) await sleep(delayMs);
    }
    return { ok: true, targetId, action, length: text.length };
  }

  if (action === 'press') {
    if (targetSpec !== undefined && targetSpec !== null && targetSpec !== '') {
      const loc = await locateTarget(inst, sessionId, targetId, targetSpec);
      await dispatchMouseClick(cdp, sessionId, loc.x, loc.y);
      await sleep(20);
    }
    const key = String(opts.key || '').trim();
    if (!key) throw new Error('press 需要提供 key 参数');
    await dispatchKeyChord(cdp, sessionId, key);
    return { ok: true, targetId, action, key };
  }

  if (action === 'select') {
    const loc = await locateTarget(inst, sessionId, targetId, targetSpec);
    if (loc.tag !== 'select') throw new Error('select 只能用于 <select> 元素，当前元素是 <' + loc.tag + '>');
    const desired = String(opts.value !== undefined ? opts.value : opts.label !== undefined ? opts.label : '');
    const res = await evalJson(
      cdp,
      sessionId,
      `((desired) => {
        ${INPAGE_HELPERS}
        ${buildLookupSnippet(loc.parsed)}
        var el = lookupElement();
        if (!el || el.tagName !== 'SELECT') return { error: '找不到 <select> 元素' };
        var opts = el.options || [];
        var chosen = null;
        for (var i = 0; i < opts.length; i++) {
          if (opts[i].value === desired) { chosen = opts[i]; break; }
        }
        if (!chosen) {
          for (var j = 0; j < opts.length; j++) {
            var lbl = String(opts[j].textContent || opts[j].label || '').trim();
            if (lbl === desired) { chosen = opts[j]; break; }
          }
        }
        if (!chosen) {
          var list = [];
          for (var k = 0; k < opts.length; k++) list.push(opts[k].value + ' (' + String(opts[k].textContent || '').trim() + ')');
          return { error: '找不到选项 "' + desired + '"，可选：' + list.slice(0, 12).join(', ') };
        }
        el.value = chosen.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: el.value, label: String(chosen.textContent || '').trim() };
      })(${JSON.stringify(desired)})`
    );
    if (!res || res.error) throw new Error((res && res.error) || '选择失败');
    return { ok: true, targetId, action, value: res.value, label: res.label };
  }

  if (action === 'scroll') {
    let x = 200;
    let y = 200;
    if (targetSpec !== undefined && targetSpec !== null && targetSpec !== '') {
      const loc = await locateTarget(inst, sessionId, targetId, targetSpec);
      x = loc.x;
      y = loc.y;
    } else {
      const vp = await evalJson(cdp, sessionId, '({ w: window.innerWidth || 800, h: window.innerHeight || 600 })');
      if (vp) {
        x = Math.round(vp.w / 2);
        y = Math.round(vp.h / 2);
      }
    }
    const deltaX = Number(opts.deltaX) || 0;
    const deltaY = opts.deltaY !== undefined ? Number(opts.deltaY) : 500;
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseWheel', x, y, deltaX, deltaY },
      sessionId
    );
    await sleep(60);
    return { ok: true, targetId, action, deltaX, deltaY };
  }

  if (action === 'upload') {
    const rawFiles = Array.isArray(opts.files) ? opts.files : opts.file ? [opts.file] : [];
    if (!rawFiles.length) throw new Error('upload 需要提供 files 文件路径数组');
    const absFiles = rawFiles.map((f) => path.resolve(String(f)));
    for (const f of absFiles) {
      if (!fs.existsSync(f)) throw new Error('上传文件不存在：' + f);
    }

    const loc = await locateTarget(inst, sessionId, targetId, targetSpec, { allowHidden: true });
    if (loc.tag !== 'input' || loc.type !== 'file') {
      throw new Error('upload 目标必须是 <input type="file">，当前是 <' + loc.tag + '>');
    }

    const remote = await evalRaw(
      cdp,
      sessionId,
      `(() => {
        ${INPAGE_HELPERS}
        ${buildLookupSnippet(loc.parsed)}
        return lookupElement();
      })()`,
      false
    );
    const objectId = remote && remote.objectId;
    if (!objectId) throw new Error('无法获取文件输入框对象句柄');
    try {
      try {
        await cdp.send('DOM.setFileInputFiles', { files: absFiles, objectId }, sessionId);
      } catch {
        // 个别 Chromium 版本要求先描述节点再传 backendNodeId
        await cdp.try_('DOM.enable', {}, sessionId);
        try {
          const desc = await cdp.send('DOM.describeNode', { objectId }, sessionId);
          const backendNodeId = desc && desc.node && desc.node.backendNodeId;
          if (!backendNodeId) throw new Error('无法解析文件输入框节点');
          await cdp.send('DOM.setFileInputFiles', { files: absFiles, backendNodeId }, sessionId);
        } finally {
          await cdp.try_('DOM.disable', {}, sessionId);
        }
      }
    } finally {
      await cdp.try_('Runtime.releaseObject', { objectId }, sessionId);
    }
    return { ok: true, targetId, action, files: absFiles };
  }

  if (action === 'wait') {
    const condSel = opts.selector !== undefined ? opts.selector : opts.target;
    const condText = opts.text;
    const condUrl = opts.urlIncludes || opts.url;
    const hasCondition =
      (condSel !== undefined && condSel !== null && condSel !== '') ||
      (condText !== undefined && condText !== null && condText !== '') ||
      (condUrl !== undefined && condUrl !== null && condUrl !== '');

    if (!hasCondition) {
      const waitMs = Math.max(0, Math.min(30000, Number(opts.ms) || 1000));
      const ch = await evalJson(cdp, sessionId, `(() => { ${INPAGE_HELPERS} return detectChallenge(); })()`);
      if (ch) {
        return { ok: false, targetId, blockedByChallenge: true, challenge: ch, error: ch.message };
      }
      await sleep(waitMs);
      return { ok: true, targetId, action, elapsedMs: waitMs };
    }

    const timeoutMs = Math.max(200, Math.min(60000, Number(opts.timeoutMs || opts.timeout) || 10000));
    const started = Date.now();
    let selSpec = null;
    if (condSel !== undefined && condSel !== null && condSel !== '') {
      selSpec = parseRefTarget(inst, targetId, condSel);
    }

    while (Date.now() - started <= timeoutMs) {
      let state = null;
      try {
        state = await evalJson(
          cdp,
          sessionId,
          `((args) => {
            ${INPAGE_HELPERS}
            var ch = detectChallenge();
            if (ch) return { blockedByChallenge: true, challenge: ch };
            var okSel = true;
            if (args.selSpec) {
              var el = null;
              if (args.selSpec.kind === 'locator') el = resolveLocator(args.selSpec.loc);
              else if (args.selSpec.kind === 'text') el = findByText(args.selSpec.query);
              else el = findBySelectorDeep(args.selSpec.selector);
              if (el && el.__selectorError) return { selectorError: el.__selectorError };
              okSel = !!(el && !isChallengeNode(el) && isVisible(el));
            }
            var okText = true;
            if (args.condText) {
              var bodyText = document.body ? String(document.body.innerText || '') : '';
              okText = bodyText.indexOf(args.condText) >= 0;
            }
            var okUrl = true;
            if (args.condUrl) {
              okUrl = String(location.href).indexOf(args.condUrl) >= 0;
            }
            return {
              matched: okSel && okText && okUrl,
              url: location.href,
              title: document.title
            };
          })(${JSON.stringify({ selSpec, condText: condText || '', condUrl: condUrl || '' })})`,
          3000
        );
      } catch {
        state = null;
      }

      if (state && state.selectorError) throw new Error('选择器语法错误：' + state.selectorError);
      if (state && state.blockedByChallenge) {
        return {
          ok: false,
          targetId,
          blockedByChallenge: true,
          challenge: state.challenge,
          error: state.challenge.message,
        };
      }
      if (state && state.matched) {
        return {
          ok: true,
          targetId,
          action,
          elapsedMs: Date.now() - started,
          url: state.url,
          title: state.title,
        };
      }
      await sleep(200);
    }
    throw new Error('等待条件超时（' + timeoutMs + 'ms）');
  }

  throw new Error('不支持的操作动作：' + action);
}

/* ------------------------------- 截图与 JS 执行 ------------------------------- */

async function screenshot(profileId, opts = {}) {
  const inst = requireRunning(profileId);
  const cdp = inst.cdp;
  const { target, sessionId } = await resolveTab(inst, opts.tab);
  const params = { format: 'png' };
  if (opts.fullPage) {
    const metrics = await cdp.try_('Page.getLayoutMetrics', {}, sessionId);
    const size = metrics && (metrics.cssContentSize || metrics.contentSize);
    if (size && size.width > 0 && size.height > 0) {
      params.clip = {
        x: 0,
        y: 0,
        width: Math.ceil(size.width),
        height: Math.ceil(size.height),
        scale: 1,
      };
      params.captureBeyondViewport = true;
    }
  }
  const shot = await cdp.send('Page.captureScreenshot', params, sessionId, 20000);
  if (!shot || !shot.data) throw new Error('截图失败');

  if (opts.path) {
    const absPath = path.resolve(String(opts.path));
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    const buf = Buffer.from(shot.data, 'base64');
    fs.writeFileSync(absPath, buf);
    return {
      ok: true,
      targetId: target.targetId,
      path: absPath,
      bytes: buf.length,
    };
  }
  const buf = Buffer.from(shot.data, 'base64');
  return {
    ok: true,
    targetId: target.targetId,
    mimeType: 'image/png',
    bytes: buf.length,
    data: shot.data,
  };
}

async function evaluate(profileId, opts = {}) {
  const expr = String(opts.expression || '').trim();
  if (!expr) throw new Error('eval 需要提供 expression 参数');
  const inst = requireRunning(profileId);
  const { target, sessionId } = await resolveTab(inst, opts.tab);
  const result = await evalRaw(inst.cdp, sessionId, expr, true, Number(opts.timeoutMs) || 15000);
  return {
    ok: true,
    targetId: target.targetId,
    type: result ? result.type : 'undefined',
    value: result ? result.value : undefined,
  };
}

module.exports = {
  listTabs,
  newTab,
  switchTab,
  closeTab,
  focus,
  navigate,
  snapshot,
  act,
  screenshot,
  evaluate,
};
