/**
 * 指纹注入脚本（在主世界 document-start 阶段执行）。
 *
 * 设计原则 —— 只改"真浏览器改不掉"的部分：
 *   UA / UA-CH / 语言 / 时区 / locale 由 CDP 在 Chromium 原生层覆盖（无 JS 痕迹）；
 *   这里只处理 CDP 覆盖不到、或原生层改不动的：CPU 核数、内存、屏幕、Canvas、WebGL、Audio、WebRTC。
 *   本文件被当作纯文本读取，配置占位符会被替换成 JSON 字面量，因此内部不要使用反引号。
 */
(function () {
  'use strict';

  var CFG = __CFG__;
  var GUARD = Symbol.for('fb.' + CFG.seed);
  try {
    if (window[GUARD]) return;
    Object.defineProperty(window, GUARD, { value: true, enumerable: false, configurable: false });
  } catch (e) {
    return;
  }

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
  var patchedToString = function toString() {
    var n = maskMap.get(this);
    return n ? 'function ' + n + '() { [native code] }' : rawToString.call(this);
  };
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

  function defineGetters(obj, map) {
    for (var prop in map) {
      if (!Object.prototype.hasOwnProperty.call(map, prop)) continue;
      (function (p, v) {
        var g = mask(function () {
          return v;
        }, 'get ' + p);
        try {
          Object.defineProperty(obj, p, { get: g, configurable: true, enumerable: true });
        } catch (e) {
          /* ignore */
        }
      })(prop, map[prop]);
    }
  }

  /* -------------------------------- navigator -------------------------------- */

  defineGetters(Navigator.prototype, {
    hardwareConcurrency: CFG.hardwareConcurrency,
    deviceMemory: CFG.deviceMemory,
    maxTouchPoints: CFG.maxTouchPoints,
    webdriver: false,
  });

  /* ---------------------------------- screen --------------------------------- */

  var S = CFG.screen || {};
  if (S.width) {
    defineGetters(Screen.prototype, {
      width: S.width,
      height: S.height,
      availWidth: S.width,
      availHeight: S.availHeight || S.height,
      colorDepth: S.colorDepth || 24,
      pixelDepth: S.colorDepth || 24,
    });
    defineGetters(window, {
      outerWidth: S.width,
      outerHeight: S.height,
      devicePixelRatio: S.pixelRatio || 1,
    });
  }

  /* ---------------------------------- canvas --------------------------------- */

  if (CFG.canvasNoise && typeof HTMLCanvasElement !== 'undefined') {
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

    var C2D = CanvasRenderingContext2D.prototype;
    var origGetImageData = C2D.getImageData;

    C2D.getImageData = mask(function getImageData() {
      var img = origGetImageData.apply(this, arguments);
      try {
        perturb(img.data);
      } catch (e) {
        /* ignore */
      }
      return img;
    }, 'getImageData');

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
      var img = origGetImageData.call(ctx, 0, 0, w, h);
      perturb(img.data);
      ctx.putImageData(img, 0, 0);
      return t;
    }

    var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = mask(function toDataURL() {
      var target = this;
      try {
        target = noisyCopy(this) || this;
      } catch (e) {
        target = this;
      }
      return origToDataURL.apply(target, arguments);
    }, 'toDataURL');

    var origToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = mask(function toBlob() {
      var target = this;
      try {
        target = noisyCopy(this) || this;
      } catch (e) {
        target = this;
      }
      return origToBlob.apply(target, arguments);
    }, 'toBlob');

    if (typeof OffscreenCanvas !== 'undefined' && OffscreenCanvas.prototype.convertToBlob) {
      var origConvertToBlob = OffscreenCanvas.prototype.convertToBlob;
      OffscreenCanvas.prototype.convertToBlob = mask(function convertToBlob() {
        try {
          var ctx = this.getContext('2d');
          if (ctx && this.width && this.height) {
            var img = origGetImageData.call(ctx, 0, 0, this.width, this.height);
            perturb(img.data);
            ctx.putImageData(img, 0, 0);
          }
        } catch (e) {
          /* ignore */
        }
        return origConvertToBlob.apply(this, arguments);
      }, 'convertToBlob');
    }
  }

  /* ---------------------------------- text ----------------------------------- */

  if (CFG.textNoise !== false && typeof CanvasRenderingContext2D !== 'undefined') {
    var T_SEED = hash32(CFG.seed + ':text');
    var origMeasureText = CanvasRenderingContext2D.prototype.measureText;
    CanvasRenderingContext2D.prototype.measureText = mask(function measureText(txt) {
      var m = origMeasureText.apply(this, arguments);
      try {
        var h = hash32(T_SEED + '|' + String(txt));
        var delta = ((h % 2000) - 1000) / 100000;
        Object.defineProperty(m, 'width', {
          value: m.width + delta,
          configurable: true,
          enumerable: true,
          writable: true,
        });
      } catch (e) {
        /* ignore */
      }
      return m;
    }, 'measureText');
  }

  /* ---------------------------------- WebGL ---------------------------------- */

  function patchGL(proto) {
    if (!proto || !proto.getParameter) return;
    var orig = proto.getParameter;
    proto.getParameter = mask(function getParameter(p) {
      if (p === 37445) return CFG.webglVendor;
      if (p === 37446) return CFG.webglRenderer;
      if (p === 7936) return 'WebKit';
      if (p === 7937) return 'WebKit WebGL';
      return orig.apply(this, arguments);
    }, 'getParameter');

    var origExt = proto.getExtension;
    if (origExt) {
      proto.getExtension = mask(function getExtension(name) {
        var r = origExt.apply(this, arguments);
        if (!r && name === 'WEBGL_debug_renderer_info') {
          return { UNMASKED_VENDOR_WEBGL: 37445, UNMASKED_RENDERER_WEBGL: 37446 };
        }
        return r;
      }, 'getExtension');
    }
  }
  patchGL(typeof WebGLRenderingContext !== 'undefined' ? WebGLRenderingContext.prototype : null);
  patchGL(typeof WebGL2RenderingContext !== 'undefined' ? WebGL2RenderingContext.prototype : null);

  /* --------------------------------- WebGPU ---------------------------------- */
  // WebGPU 的 adapter.info 会直说真实 GPU 家族（实测：声明 NVIDIA 的 WebGL 旁边
  // 站着 vendor:"intel"），是"设备级"标识里最硬的一个，必须和 WebGL 声明对齐。
  var GPU_FAMILY = {
    NVIDIA: { vendor: 'nvidia', architecture: 'ampere' },
    Intel: { vendor: 'intel', architecture: 'gen-12lp' },
    AMD: { vendor: 'amd', architecture: 'rdna-2' },
    Apple: { vendor: 'apple', architecture: 'metal-3' },
    Microsoft: { vendor: 'microsoft', architecture: 'd3d12' },
  };
  (function () {
    var decl = String(CFG.webglVendor || '');
    var fam = null;
    for (var k in GPU_FAMILY) {
      if (Object.prototype.hasOwnProperty.call(GPU_FAMILY, k) && decl.indexOf(k) >= 0) {
        fam = GPU_FAMILY[k];
        break;
      }
    }
    if (!fam || typeof GPUAdapter === 'undefined') return;
    var info = { vendor: fam.vendor, architecture: fam.architecture, device: '', description: '' };

    try {
      Object.defineProperty(GPUAdapter.prototype, 'info', {
        configurable: true,
        enumerable: true,
        get: mask(function () {
          return info;
        }, 'get info'),
      });
    } catch (e) {
      /* ignore */
    }
    if (GPUAdapter.prototype.requestAdapterInfo) {
      GPUAdapter.prototype.requestAdapterInfo = mask(function requestAdapterInfo() {
        return Promise.resolve(info);
      }, 'requestAdapterInfo');
    }

    // 有些版本把 info 做成实例属性，这里补一道：拦截 requestAdapter，在返回对象上钉住
    var GPUProto = typeof GPU !== 'undefined' ? GPU.prototype : null;
    if (GPUProto && GPUProto.requestAdapter) {
      var origRequestAdapter = GPUProto.requestAdapter;
      GPUProto.requestAdapter = mask(function requestAdapter() {
        return Promise.resolve(origRequestAdapter.apply(this, arguments)).then(function (a) {
          if (a) {
            try {
              Object.defineProperty(a, 'info', { value: info, configurable: true, enumerable: true });
            } catch (e) {
              /* ignore */
            }
          }
          return a;
        });
      }, 'requestAdapter');
    }
  })();

  /* ----------------------------- 语音合成设备 ------------------------------ */
  // 实测：Windows 暴露 "Microsoft Huihui / Kangkang / Yaoyao" 等 SAPI 语音，
  // macOS 是 Samantha / Ting-Ting 那一套。只在"声明的系统 ≠ 真实系统"时才改，
  // 这样绝大多数（Windows 上跑 Windows 指纹）用户完全不受影响。
  if (
    typeof SpeechSynthesis !== 'undefined' &&
    typeof speechSynthesis !== 'undefined' &&
    CFG.platform &&
    CFG.realPlatform &&
    CFG.platform !== CFG.realPlatform
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
    var WIN_VOICES = [
      ['Microsoft Huihui - Chinese (Simplified, PRC)', 'zh-CN'],
      ['Microsoft Kangkang - Chinese (Simplified, PRC)', 'zh-CN'],
      ['Microsoft Yaoyao - Chinese (Simplified, PRC)', 'zh-CN'],
      ['Microsoft Zira - English (United States)', 'en-US'],
      ['Microsoft David - English (United States)', 'en-US'],
      ['Microsoft Hazel - English (Great Britain)', 'en-GB'],
    ];
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
    var extra = CFG.platform === 'win' ? WIN_VOICES : CFG.platform === 'mac' ? MAC_VOICES : [];
    var fakeVoices = GOOGLE_VOICES.concat(extra).map(function (v, i) {
      var o = {
        name: v[0],
        lang: v[1],
        voiceURI: v[0],
        localService: i >= GOOGLE_VOICES.length,
        default: v[0] === 'Google US English',
      };
      try {
        Object.defineProperty(o, Symbol.toStringTag, { value: 'SpeechSynthesisVoice' });
      } catch (e) {
        /* ignore */
      }
      return o;
    });
    try {
      Object.defineProperty(SpeechSynthesis.prototype, 'getVoices', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: mask(function getVoices() {
          return fakeVoices;
        }, 'getVoices'),
      });
    } catch (e) {
      /* ignore */
    }
  }

  /* ---------------------------------- Audio ---------------------------------- */

  if (CFG.audioNoise && typeof AudioBuffer !== 'undefined') {
    var AUD_SEED = hash32(CFG.seed + ':audio');
    var touched = new WeakSet();
    var origGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = mask(function getChannelData() {
      var d = origGetChannelData.apply(this, arguments);
      try {
        if (!touched.has(this)) {
          touched.add(this);
          var h = AUD_SEED;
          for (var i = 0; i < d.length; i += 97) {
            h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
            d[i] = d[i] + (h & 1 ? 1e-7 : -1e-7);
          }
        }
      } catch (e) {
        /* ignore */
      }
      return d;
    }, 'getChannelData');

    if (typeof AnalyserNode !== 'undefined') {
      var origFloat = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = mask(function getFloatFrequencyData(arr) {
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
      }, 'getFloatFrequencyData');
    }
  }

  /* --------------------------------- WebRTC ---------------------------------- */

  if (CFG.webrtc && CFG.webrtc !== 'real') {
    var FAKE_IP = CFG.fakeIp || '192.168.1.88';
    var DISABLED = CFG.webrtc === 'disabled';
    var IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

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
        out = out.replace(IPV4, FAKE_IP);
      } catch (e) {
        /* ignore */
      }
      return out;
    }

    function patchDescCtor(name) {
      var Ctor = window[name];
      if (!Ctor || !Ctor.prototype) return;
      var d = Object.getOwnPropertyDescriptor(Ctor.prototype, 'sdp') || Object.getOwnPropertyDescriptor(Ctor.prototype, 'candidate');
      var prop = d ? (Object.getOwnPropertyDescriptor(Ctor.prototype, 'sdp') ? 'sdp' : 'candidate') : null;
      if (!prop || !d || !d.get) return;
      Object.defineProperty(Ctor.prototype, prop, {
        configurable: true,
        enumerable: true,
        get: mask(function () {
          return cleanSdp(d.get.call(this));
        }, 'get ' + prop),
      });
    }
    patchDescCtor('RTCSessionDescription');
    patchDescCtor('RTCIceCandidate');

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

  if (CFG.rectNoise && typeof Element !== 'undefined') {
    var R_SEED = hash32(CFG.seed + ':rect');
    var rectMap = new WeakMap();
    var counter = 0;
    var origRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = mask(function getBoundingClientRect() {
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
    }, 'getBoundingClientRect');
  }
})();
