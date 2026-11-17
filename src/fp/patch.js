/**
 * 指纹注入脚本（在主世界 document-start 阶段以及 Worker 环境中执行）。
 *
 * 设计原则 —— 只改"真浏览器改不掉"的部分：
 *   UA / UA-CH / 语言 / 时区 / locale 由 CDP 在 Chromium 原生层覆盖（无 JS 痕迹）；
 *   这里只处理 CDP 覆盖不到、或原生层改不动的：CPU 核数、内存、屏幕、Canvas、WebGL、WebGPU、Audio、WebRTC。
 *   本文件被当作纯文本读取，配置占位符会被替换成 JSON 字面量，因此内部不要使用反引号。
 */
(function () {
  'use strict';

  var CFG = __CFG__;
  var G = typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : window;
  var IS_WINDOW = typeof window !== 'undefined' && typeof document !== 'undefined';
  // 幂等由 Node 侧保证（同一个 target 只挂一次脚本），页面里不留任何标记：
  // 任何 window[Symbol.for('fb.'+seed)] 这种守卫都能被
  // Object.getOwnPropertySymbols(window) 一行枚举出来，等于主动告诉站点"我被改过"。

  /* --------------------------- 让补丁看起来是原生的 --------------------------- */

  var rawToString = Function.prototype.toString;
  var maskMap = new WeakMap();
  function mask(fn, name) {
    try {
      maskMap.set(fn, name);
    } catch (e) {
      /* ignore */
    }
    return fn;
  }
  var patchedToString = ({
    toString() {
      var n = maskMap.get(this);
      return n ? 'function ' + n + '() { [native code] }' : rawToString.call(this);
    },
  }).toString;
  mask(patchedToString, 'toString');
  try {
    Function.prototype.toString = patchedToString;
  } catch (e) {
    /* ignore */
  }

  function hash32(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function makeGetter(prop, impl) {
    var g = Object.getOwnPropertyDescriptor(
      {
        get [prop]() {
          return impl.call(this);
        },
      },
      prop
    ).get;
    return mask(g, 'get ' + prop);
  }

  function makeMethod(name, len, impl) {
    var o;
    if (len === 1) {
      o = {
        [name](a) {
          return impl.apply(this, arguments);
        },
      };
    } else if (len === 2) {
      o = {
        [name](a, b) {
          return impl.apply(this, arguments);
        },
      };
    } else if (len === 3) {
      o = {
        [name](a, b, c) {
          return impl.apply(this, arguments);
        },
      };
    } else if (len === 4) {
      o = {
        [name](a, b, c, d) {
          return impl.apply(this, arguments);
        },
      };
    } else {
      o = {
        [name]() {
          return impl.apply(this, arguments);
        },
      };
    }
    return mask(o[name], name);
  }

  function defineGetters(obj, map) {
    if (!obj) return;
    for (var prop in map) {
      if (!Object.prototype.hasOwnProperty.call(map, prop)) continue;
      (function (p, v) {
        var prev = null;
        try {
          prev = Object.getOwnPropertyDescriptor(obj, p);
        } catch (e) {
          /* ignore */
        }
        var g = makeGetter(p, function () {
          return v;
        });
        try {
          Object.defineProperty(obj, p, {
            get: g,
            configurable: prev ? prev.configurable : true,
            enumerable: prev ? prev.enumerable : true,
          });
        } catch (e) {
          /* ignore */
        }
      })(prop, map[prop]);
    }
  }

  /* -------------------------------- navigator -------------------------------- */

  // webdriver 不动。启动时用固定调试端口，原生值就是 false。
  // 这里再 defineProperty，iframe 里的 Function#toString 能看到假 getter，Google 登录会拒。
  if (typeof Navigator !== 'undefined') {
    defineGetters(Navigator.prototype, {
      hardwareConcurrency: CFG.hardwareConcurrency,
      deviceMemory: CFG.deviceMemory,
      maxTouchPoints: CFG.maxTouchPoints,
    });
  }
  if (typeof WorkerNavigator !== 'undefined') {
    var workerNavMap = {
      hardwareConcurrency: CFG.hardwareConcurrency,
      deviceMemory: CFG.deviceMemory,
    };
    if ('maxTouchPoints' in WorkerNavigator.prototype) {
      workerNavMap.maxTouchPoints = CFG.maxTouchPoints;
    }
    defineGetters(WorkerNavigator.prototype, workerNavMap);
  }

  /* ---------------------------------- screen --------------------------------- */

  var S = CFG.screen || {};
  if (IS_WINDOW && typeof Screen !== 'undefined' && S.width) {
    defineGetters(Screen.prototype, {
      width: S.width,
      height: S.height,
      availWidth: S.width,
      availHeight: S.availHeight || S.height,
      colorDepth: S.colorDepth || 24,
      pixelDepth: S.colorDepth || 24,
    });
    // outerWidth / outerHeight 不要改：窗口是按 --window-size 开的真实尺寸，
    // 把它们钉成整屏尺寸会出现 "outer - inner = 237px" 这种真窗口不可能有的差，
    // 反而是一眼假的信号。devicePixelRatio 必须跟着屏幕走，且它在 Chrome 里
    // 本来就是 window 的自有属性，覆盖到实例上不露馅。
    defineGetters(window, {
      devicePixelRatio: S.pixelRatio || 1,
    });

    if (typeof window.matchMedia === 'function' && typeof MediaQueryList !== 'undefined') {
      var mqlOverrides = new WeakMap();
      var origMatchMedia = window.matchMedia;
      var mqlDesc = Object.getOwnPropertyDescriptor(MediaQueryList.prototype, 'matches');
      if (mqlDesc && mqlDesc.get) {
        var origMqlMatches = mqlDesc.get;
        try {
          Object.defineProperty(MediaQueryList.prototype, 'matches', {
            configurable: mqlDesc.configurable,
            enumerable: mqlDesc.enumerable,
            get: makeGetter('matches', function () {
              if (mqlOverrides.has(this)) return mqlOverrides.get(this);
              return origMqlMatches.call(this);
            }),
          });
        } catch (e) {
          /* ignore */
        }
      }

      function evalDeviceQuery(q) {
        var s = String(q || '').trim();
        var m = /^\(\s*(min-|max-)?device-(width|height)\s*:\s*(\d+(?:\.\d+)?)px\s*\)$/i.exec(s);
        if (m) {
          var prefix = m[1] ? m[1].toLowerCase() : '';
          var actual = m[2].toLowerCase() === 'width' ? S.width : S.height;
          var target = Number(m[3]);
          if (prefix === 'min-') return actual >= target;
          if (prefix === 'max-') return actual <= target;
          return actual === target;
        }
        m = /^\(\s*-webkit-(min-|max-)?device-pixel-ratio\s*:\s*(\d+(?:\.\d+)?)\s*\)$/i.exec(s);
        if (m) {
          var dprPrefix = m[1] ? m[1].toLowerCase() : '';
          var dpr = S.pixelRatio || 1;
          var targetDpr = Number(m[2]);
          if (dprPrefix === 'min-') return dpr >= targetDpr;
          if (dprPrefix === 'max-') return dpr <= targetDpr;
          return Math.abs(dpr - targetDpr) < 0.001;
        }
        m = /^\(\s*(min-|max-)?resolution\s*:\s*(\d+(?:\.\d+)?)(dppx|dpi)\s*\)$/i.exec(s);
        if (m) {
          var resPrefix = m[1] ? m[1].toLowerCase() : '';
          var curDpr = S.pixelRatio || 1;
          var actualRes = m[3].toLowerCase() === 'dpi' ? curDpr * 96 : curDpr;
          var targetRes = Number(m[2]);
          if (resPrefix === 'min-') return actualRes >= targetRes;
          if (resPrefix === 'max-') return actualRes <= targetRes;
          return Math.abs(actualRes - targetRes) < 0.01;
        }
        return null;
      }

      window.matchMedia = makeMethod('matchMedia', origMatchMedia.length, function () {
        var mql = origMatchMedia.apply(this, arguments);
        try {
          var overrideVal = evalDeviceQuery(arguments[0]);
          if (overrideVal !== null && mql) mqlOverrides.set(mql, overrideVal);
        } catch (e) {
          /* ignore */
        }
        return mql;
      });
    }
  }

  /* ---------------------------------- canvas --------------------------------- */

  if (CFG.canvasNoise) {
    var CAN_SEED = hash32(CFG.seed + ':canvas');

    function perturb(data) {
      if (!data || !data.length) return data;
      var total = (data.length / 4) | 0;
      if (!total) return data;
      var h = CAN_SEED;
      for (var k = 0; k < 16; k++) {
        h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
        var idx = (h % total) * 4 + ((h >>> 8) % 3);
        if (idx < data.length) data[idx] = data[idx] ^ 1;
      }
      return data;
    }

    function patch2DGetImageData(proto) {
      if (!proto || !proto.getImageData) return null;
      var orig = proto.getImageData;
      proto.getImageData = makeMethod('getImageData', orig.length, function () {
        var img = orig.apply(this, arguments);
        try {
          perturb(img.data);
        } catch (e) {
          /* ignore */
        }
        return img;
      });
      return orig;
    }

    var origGetImageData =
      typeof CanvasRenderingContext2D !== 'undefined'
        ? patch2DGetImageData(CanvasRenderingContext2D.prototype)
        : null;
    var origOCGetImageData =
      typeof OffscreenCanvasRenderingContext2D !== 'undefined'
        ? patch2DGetImageData(OffscreenCanvasRenderingContext2D.prototype)
        : null;

    if (IS_WINDOW && typeof HTMLCanvasElement !== 'undefined') {
      function noisyCopy(src) {
        var w = src.width || 0;
        var h = src.height || 0;
        if (!w || !h || w * h > 16777216) return null;
        var t = document.createElement('canvas');
        t.width = w;
        t.height = h;
        var ctx = t.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(src, 0, 0);
        var getImg = origGetImageData || ctx.getImageData;
        var img = getImg.call(ctx, 0, 0, w, h);
        perturb(img.data);
        ctx.putImageData(img, 0, 0);
        return t;
      }

      var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = makeMethod('toDataURL', origToDataURL.length, function () {
        var target = this;
        try {
          target = noisyCopy(this) || this;
        } catch (e) {
          target = this;
        }
        return origToDataURL.apply(target, arguments);
      });

      var origToBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = makeMethod('toBlob', origToBlob.length, function () {
        var target = this;
        try {
          target = noisyCopy(this) || this;
        } catch (e) {
          target = this;
        }
        return origToBlob.apply(target, arguments);
      });
    }

    if (typeof OffscreenCanvas !== 'undefined' && OffscreenCanvas.prototype.convertToBlob) {
      var origConvertToBlob = OffscreenCanvas.prototype.convertToBlob;
      OffscreenCanvas.prototype.convertToBlob = makeMethod('convertToBlob', origConvertToBlob.length, function () {
        var target = this;
        try {
          var w = this.width || 0;
          var h = this.height || 0;
          if (w && h && w * h <= 16777216) {
            var tmp = new OffscreenCanvas(w, h);
            var tctx = tmp.getContext('2d');
            if (tctx) {
              tctx.drawImage(this, 0, 0);
              var getImg = origOCGetImageData || tctx.getImageData;
              var img = getImg.call(tctx, 0, 0, w, h);
              perturb(img.data);
              tctx.putImageData(img, 0, 0);
              target = tmp;
            }
          }
        } catch (e) {
          target = this;
        }
        return origConvertToBlob.apply(target, arguments);
      });
    }
  }

  /* ---------------------------------- text ----------------------------------- */

  if (CFG.textNoise !== false) {
    var T_SEED = hash32(CFG.seed + ':text');
    var textWidthMap = new WeakMap();
    if (typeof TextMetrics !== 'undefined') {
      var twDesc = Object.getOwnPropertyDescriptor(TextMetrics.prototype, 'width');
      if (twDesc && twDesc.get) {
        var origTextWidth = twDesc.get;
        try {
          Object.defineProperty(TextMetrics.prototype, 'width', {
            configurable: twDesc.configurable,
            enumerable: twDesc.enumerable,
            get: makeGetter('width', function () {
              if (textWidthMap.has(this)) return textWidthMap.get(this);
              return origTextWidth.call(this);
            }),
          });
        } catch (e) {
          /* ignore */
        }
      }
    }

    function patchTextNoise(proto) {
      if (!proto || !proto.measureText) return;
      var orig = proto.measureText;
      proto.measureText = makeMethod('measureText', orig.length, function (txt) {
        var m = orig.apply(this, arguments);
        try {
          if (m && typeof m.width === 'number') {
            var h = hash32(T_SEED + '|' + String(txt));
            var delta = ((h % 2000) - 1000) / 100000;
            textWidthMap.set(m, m.width + delta);
          }
        } catch (e) {
          /* ignore */
        }
        return m;
      });
    }
    patchTextNoise(typeof CanvasRenderingContext2D !== 'undefined' ? CanvasRenderingContext2D.prototype : null);
    patchTextNoise(
      typeof OffscreenCanvasRenderingContext2D !== 'undefined' ? OffscreenCanvasRenderingContext2D.prototype : null
    );
  }

  /* ---------------------------------- 字体 ----------------------------------- */
  /**
   * 字体探测只有两条路：document.fonts.check() 和 measureText() 的宽度差。
   * 把"声明平台没有的字体"当成不存在：check 返回 false，measureText 按回退字体量，
   * 这样在 Windows 上跑 macOS 指纹时，不会露出 Microsoft YaHei / SimSun 这一套系统字体。
   */
  if (CFG.fontNoise !== false && typeof FontFaceSet !== 'undefined') {
    var FONT_LIST = CFG.fontWhitelist || [];
    var FALLBACK_FAMILY = CFG.platform === 'mac' ? 'Helvetica' : 'Arial';
    var GENERIC_FAMILIES = {
      serif: 1, 'sans-serif': 1, monospace: 1, cursive: 1, fantasy: 1,
      'system-ui': 1, 'ui-serif': 1, 'ui-sans-serif': 1, 'ui-monospace': 1, 'ui-rounded': 1,
      '-apple-system': 1, blinkmacsystemfont: 1, inherit: 1, initial: 1, unset: 1,
    };
    var allowedFonts = {};
    for (var fi = 0; fi < FONT_LIST.length; fi++) {
      allowedFonts[String(FONT_LIST[fi]).toLowerCase()] = 1;
    }

    function bareFamily(name) {
      return String(name || '').replace(/^["']|["']$/g, '').trim();
    }
    /**
     * 网页自己用 @font-face 声明的 webfont（Roboto、Noto Sans SC 之类）不能拦：
     * 很多站点靠 document.fonts.check() 判断字体加载完了没，误判会让它们一直等。
     */
    function isDeclaredFamily(name) {
      try {
        var fontSet = IS_WINDOW ? document.fonts : G.fonts;
        if (!fontSet || !fontSet.size) return false;
        var target = bareFamily(name).toLowerCase();
        var hit = false;
        fontSet.forEach(function (face) {
          if (hit || !face) return;
          if (bareFamily(face.family).toLowerCase() === target) hit = true;
        });
        return hit;
      } catch (e) {
        return false;
      }
    }
    function isAllowedFamily(name) {
      var key = bareFamily(name).toLowerCase();
      if (!key) return true;
      return !!GENERIC_FAMILIES[key] || !!allowedFonts[key] || isDeclaredFamily(key);
    }
    /** 从 font 简写里切出家族列表（保留字号/行高，只替换家族） */
    function splitFont(font) {
      var sizeMatch = /(\d*\.?\d+(?:px|pt|pc|em|rem|%))/.exec(font);
      if (!sizeMatch) return null;
      var cut = sizeMatch.index + sizeMatch[0].length;
      var head = font.slice(0, cut);
      var tail = font.slice(cut);
      var lh = '';
      var lhMatch = /^\s*\/\s*\S+/.exec(tail);
      if (lhMatch) {
        lh = lhMatch[0];
        tail = tail.slice(lhMatch[0].length);
      }
      var families = tail.split(',').map(function (s) {
        return s.trim();
      }).filter(Boolean);
      return { head: head + lh + ' ', families: families };
    }
    function filterFont(font) {
      if (!font || typeof font !== 'string') return font;
      var parts = splitFont(font);
      if (!parts || !parts.families.length) return font;
      var kept = parts.families.filter(isAllowedFamily);
      if (!kept.length) kept = ['"' + FALLBACK_FAMILY + '"'];
      return parts.head + kept.join(', ');
    }
    function firstFamily(font) {
      var parts = splitFont(font);
      if (!parts || !parts.families.length) return '';
      return bareFamily(parts.families[0]);
    }

    var origCheck = FontFaceSet.prototype.check;
    if (origCheck) {
      FontFaceSet.prototype.check = makeMethod('check', origCheck.length, function (font) {
        try {
          var fam = firstFamily(String(font || ''));
          if (fam && !isAllowedFamily(fam)) return false;
        } catch (e) {
          /* ignore */
        }
        return origCheck.apply(this, arguments);
      });
    }

    function patchMeasureText(proto) {
      if (!proto || !proto.measureText) return;
      var orig = proto.measureText;
      proto.measureText = makeMethod('measureText', orig.length, function () {
        var before = null;
        try {
          before = this.font;
          var after = filterFont(before);
          if (after !== before) this.font = after;
        } catch (e) {
          before = null;
        }
        try {
          return orig.apply(this, arguments);
        } finally {
          if (before !== null) {
            try {
              this.font = before;
            } catch (e) {
              /* ignore */
            }
          }
        }
      });
    }
    patchMeasureText(typeof CanvasRenderingContext2D !== 'undefined' ? CanvasRenderingContext2D.prototype : null);
    patchMeasureText(
      typeof OffscreenCanvasRenderingContext2D !== 'undefined' ? OffscreenCanvasRenderingContext2D.prototype : null
    );
  }

  /* ---------------------------------- WebGL ---------------------------------- */

  // 声明了哪家 GPU，下面这些"能力值"就得像那个档位；
  // 否则会出现"渲染器写着 RTX 4060，MAX_TEXTURE_SIZE 却是软渲染的 8192"。
  var GL_TIER = {
    NVIDIA: { tex: 16384, view: 32767, rb: 16384 },
    AMD: { tex: 16384, view: 32767, rb: 16384 },
    Intel: { tex: 16384, view: 32767, rb: 16384 },
    Apple: { tex: 16384, view: 32767, rb: 16384 },
  };
  var glTier = null;
  (function () {
    var decl = String(CFG.webglVendor || '');
    for (var key in GL_TIER) {
      if (Object.prototype.hasOwnProperty.call(GL_TIER, key) && decl.indexOf(key) >= 0) {
        glTier = GL_TIER[key];
        break;
      }
    }
  })();

  function patchGL(proto) {
    if (!proto || !proto.getParameter) return;
    var orig = proto.getParameter;
    proto.getParameter = makeMethod('getParameter', orig.length, function (p) {
      if (p === 37445) return CFG.webglVendor;
      if (p === 37446) return CFG.webglRenderer;
      if (p === 7936) return 'WebKit';
      if (p === 7937) return 'WebKit WebGL';
      if (glTier) {
        if (p === 0x0d33) return glTier.tex; // MAX_TEXTURE_SIZE
        if (p === 0x851c) return glTier.tex; // MAX_CUBE_MAP_TEXTURE_SIZE
        if (p === 0x84e8) return glTier.rb; // MAX_RENDERBUFFER_SIZE
        if (p === 0x0d3a) return new Int32Array([glTier.view, glTier.view]); // MAX_VIEWPORT_DIMS
      }
      return orig.apply(this, arguments);
    });

    var origExt = proto.getExtension;
    if (origExt) {
      proto.getExtension = makeMethod('getExtension', origExt.length, function (name) {
        var r = origExt.apply(this, arguments);
        if (!r && name === 'WEBGL_debug_renderer_info') {
          return { UNMASKED_VENDOR_WEBGL: 37445, UNMASKED_RENDERER_WEBGL: 37446 };
        }
        return r;
      });
    }
  }
  patchGL(typeof WebGLRenderingContext !== 'undefined' ? WebGLRenderingContext.prototype : null);
  patchGL(typeof WebGL2RenderingContext !== 'undefined' ? WebGL2RenderingContext.prototype : null);

  /* --------------------------------- WebGPU ---------------------------------- */
  // WebGPU 的 adapter.info 会直说真实 GPU 家族和架构，必须和 WebGL 声明的型号对齐。
  (function () {
    var declVendor = String(CFG.webglVendor || '');
    var declRenderer = String(CFG.webglRenderer || '');
    var fam = null;
    if (declVendor.indexOf('NVIDIA') >= 0) {
      var nvArch = 'ampere';
      if (/GTX\s*16|RTX\s*20/i.test(declRenderer)) nvArch = 'turing';
      else if (/RTX\s*40/i.test(declRenderer)) nvArch = 'lovelace';
      else if (/RTX\s*50/i.test(declRenderer)) nvArch = 'blackwell';
      fam = { vendor: 'nvidia', architecture: nvArch };
    } else if (declVendor.indexOf('Intel') >= 0) {
      var inArch = /UHD\s*Graphics\s*6\d\d|Iris.*Plus/i.test(declRenderer) ? 'gen-9' : 'gen-12lp';
      fam = { vendor: 'intel', architecture: inArch };
    } else if (declVendor.indexOf('AMD') >= 0) {
      var amdArch = 'gcn-5';
      if (/RX\s*7\d\d\d/i.test(declRenderer)) amdArch = 'rdna-3';
      else if (/RX\s*6\d\d\d/i.test(declRenderer)) amdArch = 'rdna-2';
      fam = { vendor: 'amd', architecture: amdArch };
    } else if (declVendor.indexOf('Apple') >= 0) {
      fam = { vendor: 'apple', architecture: 'metal-3' };
    } else if (declVendor.indexOf('Microsoft') >= 0) {
      fam = { vendor: 'microsoft', architecture: 'd3d12' };
    }
    if (!fam || typeof GPUAdapter === 'undefined') return;

    if (typeof GPUAdapterInfo !== 'undefined') {
      defineGetters(GPUAdapterInfo.prototype, {
        vendor: fam.vendor,
        architecture: fam.architecture,
        device: '',
        description: '',
      });
      if (GPUAdapter.prototype.requestAdapterInfo) {
        var origReqInfo = GPUAdapter.prototype.requestAdapterInfo;
        GPUAdapter.prototype.requestAdapterInfo = makeMethod('requestAdapterInfo', origReqInfo.length, function () {
          var selfAdapter = this;
          return Promise.resolve(origReqInfo.apply(this, arguments)).then(function (realInfo) {
            if (realInfo) return realInfo;
            return selfAdapter.info;
          });
        });
      }
      return;
    }

    var fallbackInfo = { vendor: fam.vendor, architecture: fam.architecture, device: '', description: '' };
    defineGetters(GPUAdapter.prototype, { info: fallbackInfo });
    if (GPUAdapter.prototype.requestAdapterInfo) {
      GPUAdapter.prototype.requestAdapterInfo = makeMethod('requestAdapterInfo', 0, function () {
        return Promise.resolve(fallbackInfo);
      });
    }

    var GPUProto = typeof GPU !== 'undefined' ? GPU.prototype : null;
    if (GPUProto && GPUProto.requestAdapter) {
      var origRequestAdapter = GPUProto.requestAdapter;
      GPUProto.requestAdapter = makeMethod('requestAdapter', origRequestAdapter.length, function () {
        return Promise.resolve(origRequestAdapter.apply(this, arguments)).then(function (a) {
          if (a) {
            try {
              Object.defineProperty(a, 'info', { value: fallbackInfo, configurable: true, enumerable: true });
            } catch (e) {
              /* ignore */
            }
          }
          return a;
        });
      });
    }
  })();

  /* ----------------------------- 语音合成设备 ------------------------------ */
  // Windows 暴露 "Microsoft Huihui / Kangkang / Yaoyao" 等中文 SAPI 语音；
  // 跨平台伪装、或者在中文宿主上运行美区/英区/日区 Windows 环境时，必须对齐语音列表。
  if (
    IS_WINDOW &&
    typeof SpeechSynthesis !== 'undefined' &&
    typeof speechSynthesis !== 'undefined' &&
    CFG.platform &&
    ((CFG.realPlatform && CFG.platform !== CFG.realPlatform) ||
      (CFG.platform === 'win' && !/^zh(-CN|-Hans)?$/i.test(String(CFG.locale || ''))))
  ) {
    var GOOGLE_VOICES = [
      ['Google US English', 'en-US'],
      ['Google UK English Female', 'en-GB'],
      ['Google UK English Male', 'en-GB'],
      ['Google 普通话（中国大陆）', 'zh-CN'],
      ['Google 粤語（香港）', 'zh-HK'],
      ['Google 國語（臺灣）', 'zh-TW'],
      ['Google 日本語', 'ja-JP'],
      ['Google Deutsch', 'de-DE'],
      ['Google français', 'fr-FR'],
      ['Google español', 'es-ES'],
    ];
    var WIN_VOICES_BY_LOCALE = {
      'en-GB': [
        ['Microsoft Hazel - English (Great Britain)', 'en-GB'],
        ['Microsoft Susan - English (Great Britain)', 'en-GB'],
        ['Microsoft George - English (Great Britain)', 'en-GB'],
      ],
      'de-DE': [
        ['Microsoft Hedda - German (Germany)', 'de-DE'],
        ['Microsoft Katja - German (Germany)', 'de-DE'],
        ['Microsoft Stefan - German (Germany)', 'de-DE'],
      ],
      'ja-JP': [
        ['Microsoft Haruka - Japanese (Japan)', 'ja-JP'],
        ['Microsoft Ayumi - Japanese (Japan)', 'ja-JP'],
        ['Microsoft Ichiro - Japanese (Japan)', 'ja-JP'],
      ],
      'zh-TW': [
        ['Microsoft Hanhan - Chinese (Traditional, Taiwan)', 'zh-TW'],
        ['Microsoft Yating - Chinese (Traditional, Taiwan)', 'zh-TW'],
        ['Microsoft Zhiwei - Chinese (Traditional, Taiwan)', 'zh-TW'],
      ],
      'zh-CN': [
        ['Microsoft Huihui - Chinese (Simplified, PRC)', 'zh-CN'],
        ['Microsoft Kangkang - Chinese (Simplified, PRC)', 'zh-CN'],
        ['Microsoft Yaoyao - Chinese (Simplified, PRC)', 'zh-CN'],
      ],
      'en-US': [
        ['Microsoft David - English (United States)', 'en-US'],
        ['Microsoft Zira - English (United States)', 'en-US'],
        ['Microsoft Mark - English (United States)', 'en-US'],
      ],
    };
    var MAC_VOICES = [
      ['Samantha', 'en-US'],
      ['Alex', 'en-US'],
      ['Victoria', 'en-US'],
      ['Fred', 'en-US'],
      ['Daniel', 'en-GB'],
      ['Karen', 'en-AU'],
      ['Meijia', 'zh-TW'],
      ['Ting-Ting', 'zh-CN'],
      ['Sin-ji', 'zh-HK'],
      ['Kyoko', 'ja-JP'],
      ['Anna', 'de-DE'],
      ['Thomas', 'fr-FR'],
    ];

    function pickWinVoices(loc) {
      var s = String(loc || '');
      if (/^en-GB/i.test(s)) return WIN_VOICES_BY_LOCALE['en-GB'];
      if (/^de/i.test(s)) return WIN_VOICES_BY_LOCALE['de-DE'];
      if (/^ja/i.test(s)) return WIN_VOICES_BY_LOCALE['ja-JP'];
      if (/^zh-(TW|HK|MO|Hant)/i.test(s)) return WIN_VOICES_BY_LOCALE['zh-TW'];
      if (/^zh/i.test(s)) return WIN_VOICES_BY_LOCALE['zh-CN'];
      return WIN_VOICES_BY_LOCALE['en-US'];
    }

    var extra =
      CFG.platform === 'win'
        ? pickWinVoices(CFG.locale)
        : CFG.platform === 'mac'
          ? MAC_VOICES
          : [];

    var voiceDataMap = new WeakMap();
    var HasVoiceProto = typeof SpeechSynthesisVoice !== 'undefined';
    if (HasVoiceProto) {
      var voiceProps = ['name', 'lang', 'voiceURI', 'localService', 'default'];
      for (var vi = 0; vi < voiceProps.length; vi++) {
        (function (vp) {
          var vd = Object.getOwnPropertyDescriptor(SpeechSynthesisVoice.prototype, vp);
          if (!vd || !vd.get) return;
          var origVGet = vd.get;
          try {
            Object.defineProperty(SpeechSynthesisVoice.prototype, vp, {
              configurable: vd.configurable,
              enumerable: vd.enumerable,
              get: makeGetter(vp, function () {
                var rec = voiceDataMap.get(this);
                if (rec) return rec[vp];
                return origVGet.call(this);
              }),
            });
          } catch (e) {
            /* ignore */
          }
        })(voiceProps[vi]);
      }
    }

    var fakeVoices = GOOGLE_VOICES.concat(extra).map(function (v, i) {
      var meta = {
        name: v[0],
        lang: v[1],
        voiceURI: v[0],
        localService: i >= GOOGLE_VOICES.length,
        default: v[0] === 'Google US English',
      };
      if (HasVoiceProto) {
        var o = Object.create(SpeechSynthesisVoice.prototype);
        voiceDataMap.set(o, meta);
        return o;
      }
      return meta;
    });
    try {
      Object.defineProperty(SpeechSynthesis.prototype, 'getVoices', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: makeMethod('getVoices', 0, function () {
          return fakeVoices.slice();
        }),
      });
    } catch (e) {
      /* ignore */
    }
  }

  /* ---------------------------------- Audio ---------------------------------- */

  if (CFG.audioNoise && typeof AudioBuffer !== 'undefined') {
    var AUD_SEED = hash32(CFG.seed + ':audio');
    var touched = new WeakSet();

    // 噪声按"采样序号"算，不是按读取顺序算 —— 这样 getChannelData 和
    // copyFromChannel 拿到的偏移完全一致，不会出现"换个 API 就读到干净数据"。
    function noiseAt(i) {
      var h = (AUD_SEED ^ Math.imul(i + 1, 2654435761)) >>> 0;
      h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
      return h & 1 ? 1e-7 : -1e-7;
    }
    function perturbAudio(d, start) {
      var s = start || 0;
      var first = (97 - (s % 97)) % 97;
      for (var i = first; i < d.length; i += 97) {
        d[i] = d[i] + noiseAt(s + i);
      }
    }

    var origGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = makeMethod('getChannelData', origGetChannelData.length, function () {
      var d = origGetChannelData.apply(this, arguments);
      try {
        if (!touched.has(this)) {
          touched.add(this);
          perturbAudio(d, 0);
        }
      } catch (e) {
        /* ignore */
      }
      return d;
    });

    var origCopyFromChannel = AudioBuffer.prototype.copyFromChannel;
    if (origCopyFromChannel) {
      AudioBuffer.prototype.copyFromChannel = makeMethod(
        'copyFromChannel',
        origCopyFromChannel.length,
        function (dest, channel, start) {
          origCopyFromChannel.apply(this, arguments);
          try {
            // 内部数据还没被 getChannelData 改过时，这里补上同一套偏移；
            // 已经改过就直接用（避免同一个 buffer 被加两次噪声）
            if (!touched.has(this) && dest && dest.length) perturbAudio(dest, Number(start) || 0);
          } catch (e) {
            /* ignore */
          }
        }
      );
    }

    if (typeof AnalyserNode !== 'undefined') {
      var origFloat = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = makeMethod(
        'getFloatFrequencyData',
        origFloat.length,
        function (arr) {
          origFloat.call(this, arr);
          try {
            var h = AUD_SEED;
            for (var i = 0; i < arr.length; i += 13) {
              h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
              if (arr[i] !== -Infinity) arr[i] = arr[i] + (h & 1 ? 1e-4 : -1e-4);
            }
          } catch (e) {
            /* ignore */
          }
        }
      );
    }
  }

  /* --------------------------------- WebRTC ---------------------------------- */

  if (IS_WINDOW && CFG.webrtc && CFG.webrtc !== 'real') {
    var FAKE_IP = CFG.fakeIp || '192.168.1.88';
    var DISABLED = CFG.webrtc === 'disabled';
    var IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

    // 只改 a=candidate 行。SDP 里 o= / c= 那两行真 Chrome 自己写的就是 127.0.0.1 / 0.0.0.0，
    // 一起替换反而制造出一个真机不会出现的本地地址。
    function cleanSdp(sdp) {
      if (!sdp || sdp.indexOf('candidate') < 0) return sdp;
      var out = sdp;
      if (DISABLED) {
        out = out
          .split('\r\n')
          .filter(function (line) {
            return line.indexOf('a=candidate') !== 0;
          })
          .join('\r\n');
      }
      try {
        out = out.replace(/a=candidate:[^\r\n]*/g, function (line) {
          return line.replace(IPV4, FAKE_IP);
        });
      } catch (e) {
        /* ignore */
      }
      return out;
    }

    function cleanCandidate(cand) {
      try {
        return String(cand == null ? '' : cand).replace(IPV4, FAKE_IP);
      } catch (e) {
        return cand;
      }
    }

    function patchRtcCtor(name, prop, clean) {
      var Ctor = window[name];
      if (!Ctor || !Ctor.prototype) return;
      var d = Object.getOwnPropertyDescriptor(Ctor.prototype, prop);
      if (d && d.get) {
        Object.defineProperty(Ctor.prototype, prop, {
          configurable: d.configurable,
          enumerable: d.enumerable,
          get: makeGetter(prop, function () {
            return clean(d.get.call(this));
          }),
        });
      }
      // toJSON 读的是内部槽，不经过上面的 getter —— 不补就是一个现成的绕过口
      var origJSON = Ctor.prototype.toJSON;
      if (typeof origJSON === 'function') {
        Ctor.prototype.toJSON = makeMethod('toJSON', origJSON.length, function () {
          var o = origJSON.apply(this, arguments);
          if (o && typeof o === 'object' && typeof o[prop] === 'string') {
            var copy = Object.assign({}, o);
            copy[prop] = clean(o[prop]);
            return copy;
          }
          return o;
        });
      }
    }
    patchRtcCtor('RTCSessionDescription', 'sdp', cleanSdp);
    patchRtcCtor('RTCIceCandidate', 'candidate', cleanCandidate);

    var RTCOrig = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (RTCOrig) {
      var Patched = function RTCPeerConnection(config, constraints) {
        if (DISABLED) {
          config = Object.assign({}, config || {}, { iceTransportPolicy: 'relay', iceServers: [] });
        }
        return new RTCOrig(config, constraints);
      };
      Patched.prototype = RTCOrig.prototype;
      try {
        Object.setPrototypeOf(Patched, RTCOrig);
      } catch (e) {
        /* ignore */
      }
      mask(Patched, 'RTCPeerConnection');
      window.RTCPeerConnection = Patched;
      if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Patched;
    }
  }

  /* -------------------------------- ClientRect -------------------------------- */

  if (IS_WINDOW && CFG.rectNoise && typeof Element !== 'undefined') {
    var R_SEED = hash32(CFG.seed + ':rect');
    var rectMap = new WeakMap();
    var counter = 0;
    var origRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = makeMethod('getBoundingClientRect', origRect.length, function () {
      var r = origRect.apply(this, arguments);
      try {
        var v = rectMap.get(this);
        if (!v) {
          var h = hash32(R_SEED + ':' + counter++);
          v = { dx: ((h % 40) - 20) / 1000, dy: (((h >>> 6) % 40) - 20) / 1000 };
          rectMap.set(this, v);
        }
        return new DOMRect(r.x + v.dx, r.y + v.dy, r.width, r.height);
      } catch (e) {
        return r;
      }
    });
  }
})();
