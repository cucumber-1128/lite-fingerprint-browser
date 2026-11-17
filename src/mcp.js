'use strict';
/**
 * 内置零依赖 MCP（Model Context Protocol）Stdio 服务端。
 * 让 Claude Code、Codex、Antigravity、Cursor 等支持 MCP 的 Agent 直接操控指纹浏览器。
 *
 * 传输兼容：
 *   - 换行分隔 JSON-RPC 2.0（MCP 2024-11-05 / 2025-03-26 标准 stdio）
 *   - Content-Length 帧头 JSON-RPC 2.0（部分 LSP/早期客户端）
 *   按收到首包时的格式原样回包；所有普通日志重定向到 stderr，绝不污染 stdout。
 */
const { getPreset, parseProxyLine } = require('./cliutil');

const TOOLS = [
  {
    name: 'fb_list_profiles',
    description: '列出所有浏览器环境及其运行状态（id、name、group、platform、timezone、running、pid、proxy 等）',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'fb_create_profile',
    description: '新建一个或多个指纹浏览器环境（建议优先传 preset 如 us-shop / us-west / jp-shop，一个代理对应一个环境）',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '环境名称' },
        preset: { type: 'string', description: '地区预设 key：us-shop / us-west / uk-shop / de-shop / jp-shop / tw-shop / cn-shop / mac-us' },
        group: { type: 'string', description: '分组名' },
        platform: { type: 'string', enum: ['win', 'mac', 'linux'], description: '操作系统平台' },
        timezone: { type: 'string', description: '时区，如 America/New_York' },
        locale: { type: 'string', description: 'Locale，如 en-US' },
        languages: { type: 'array', items: { type: 'string' }, description: 'Accept-Language 列表' },
        proxy: { type: 'string', description: '单个代理串，如 http://user:pass@1.2.3.4:8080 或 socks5://...' },
        proxiesText: { type: 'string', description: '批量代理文本（每行一条），配合 count 做多环境一对一创建' },
        count: { type: 'number', description: '批量创建数量' },
        autoGeo: { type: 'boolean', description: '启动时自动按代理出口同步地区与经纬度' },
        startUrl: { type: 'string', description: '启动默认页' },
        notes: { type: 'string', description: '备注' },
      },
    },
  },
  {
    name: 'fb_launch',
    description: '启动指定指纹环境（若已运行则返回当前实例信息；命令完成后再调用 fb_goto / fb_snapshot 操作页面）',
    inputSchema: {
      type: 'object',
      required: ['profileId'],
      properties: {
        profileId: { type: 'string', description: '环境 ID' },
        startUrl: { type: 'string', description: '可选启动 URL' },
        autoGeo: { type: 'boolean', description: '启动前按代理自动对齐时区/语言/经纬度' },
      },
    },
  },
  {
    name: 'fb_stop',
    description: '关闭运行中的指纹环境（保留 Cookie 与本地数据目录）',
    inputSchema: {
      type: 'object',
      required: ['profileId'],
      properties: {
        profileId: { type: 'string', description: '环境 ID' },
      },
    },
  },
  {
    name: 'fb_cookies',
    description: '导出或导入指定环境的 Cookie（支持运行中或已停止状态；导入支持 JSON 数组或 Netscape 文本）',
    inputSchema: {
      type: 'object',
      required: ['profileId', 'action'],
      properties: {
        profileId: { type: 'string', description: '环境 ID' },
        action: { type: 'string', enum: ['export', 'import'], description: 'export 导出 / import 导入' },
        cookiesText: { type: 'string', description: 'action=import 时传入 JSON 或 Netscape 格式文本' },
      },
    },
  },
  {
    name: 'fb_tabs',
    description: '管理运行中环境的标签页（list 列出、new 新建、switch 切换当前活动标签页、close 关闭）',
    inputSchema: {
      type: 'object',
      required: ['profileId'],
      properties: {
        profileId: { type: 'string', description: '环境 ID' },
        action: { type: 'string', enum: ['list', 'new', 'switch', 'close'], description: '默认 list' },
        tab: { type: 'string', description: '目标标签页索引（0,1,...）或 targetId' },
        url: { type: 'string', description: 'action=new 时要打开的 URL' },
      },
    },
  },
  {
    name: 'fb_goto',
    description: '在活动标签页中导航（打开 URL、前进、后退或刷新）并等待页面就绪',
    inputSchema: {
      type: 'object',
      required: ['profileId'],
      properties: {
        profileId: { type: 'string', description: '环境 ID' },
        url: { type: 'string', description: '目标 URL（action=goto 时必填）' },
        action: { type: 'string', enum: ['goto', 'back', 'forward', 'reload'], description: '默认 goto' },
        waitUntil: { type: 'string', enum: ['load', 'domcontentloaded'], description: '默认 load' },
        tab: { type: 'string', description: '可选目标标签页索引或 targetId' },
        timeoutMs: { type: 'number', description: '超时毫秒数，默认 20000' },
      },
    },
  },
  {
    name: 'fb_snapshot',
    description:
      '获取当前页面的可读文本与可交互元素引用（@e1, @e2...）。若 blockedByChallenge=true 表示遇到人机验证，必须调用 fb_focus 并请用户人工完成验证，严禁自动点击或绕过。',
    inputSchema: {
      type: 'object',
      required: ['profileId'],
      properties: {
        profileId: { type: 'string', description: '环境 ID' },
        tab: { type: 'string', description: '可选标签页索引或 targetId' },
        selector: { type: 'string', description: '可选 CSS 容器范围选择器' },
        maxText: { type: 'number', description: '最大提取正文字符数，默认 4000' },
        maxElements: { type: 'number', description: '最大返回可交互元素数，默认 200' },
      },
    },
  },
  {
    name: 'fb_click',
    description: '使用原生浏览器信任鼠标事件点击元素（传 @e1 引用、CSS 选择器、text=... 或坐标 x, y）',
    inputSchema: {
      type: 'object',
      required: ['profileId'],
      properties: {
        profileId: { type: 'string', description: '环境 ID' },
        target: { type: 'string', description: '@e1 / CSS 选择器 / text=按钮文案' },
        x: { type: 'number', description: '可选视口 X 坐标（未传 target 时使用）' },
        y: { type: 'number', description: '可选视口 Y 坐标（未传 target 时使用）' },
        button: { type: 'string', enum: ['left', 'right'], description: '默认 left' },
        clickCount: { type: 'number', enum: [1, 2], description: '1 单击，2 双击，默认 1' },
        tab: { type: 'string', description: '可选标签页索引或 targetId' },
      },
    },
  },
  {
    name: 'fb_fill',
    description: '点击聚焦输入框并写入完整文本（支持中英文/Unicode），可选清空原内容与回车提交',
    inputSchema: {
      type: 'object',
      required: ['profileId', 'target', 'value'],
      properties: {
        profileId: { type: 'string', description: '环境 ID' },
        target: { type: 'string', description: '@e1 / CSS 选择器 / text=标签文案' },
        value: { type: 'string', description: '要填入的文本' },
        clear: { type: 'boolean', description: '是否先清空已有文本，默认 true' },
        pressEnter: { type: 'boolean', description: '填入后是否按 Enter 提交，默认 false' },
        tab: { type: 'string', description: '可选标签页索引或 targetId' },
      },
    },
  },
  {
    name: 'fb_type',
    description: '逐字符模拟键盘敲击输入文本（适合触发实时按键校验或搜索建议的场景）',
    inputSchema: {
      type: 'object',
      required: ['profileId', 'text'],
      properties: {
        profileId: { type: 'string', description: '环境 ID' },
        text: { type: 'string', description: '要输入的文本' },
        target: { type: 'string', description: '可选，先点击聚焦目标元素' },
        delayMs: { type: 'number', description: '字符间隔毫秒数，默认 20' },
        tab: { type: 'string', description: '可选标签页索引或 targetId' },
      },
    },
  },
  {
    name: 'fb_press',
    description: '发送键盘按键或组合键（如 Enter、Tab、Escape、Backspace、ArrowDown、Control+a）',
    inputSchema: {
      type: 'object',
      required: ['profileId', 'key'],
      properties: {
        profileId: { type: 'string', description: '环境 ID' },
        key: { type: 'string', description: '按键名或组合键，如 Enter / Tab / Escape / Control+a' },
        target: { type: 'string', description: '可选，先点击目标元素再按键' },
        tab: { type: 'string', description: '可选标签页索引或 targetId' },
      },
    },
  },
  {
    name: 'fb_hover',
    description: '移动鼠标悬停到目标元素上方（触发下拉菜单或 Tooltip）',
    inputSchema: {
      type: 'object',
      required: ['profileId', 'target'],
      properties: {
        profileId: { type: 'string', description: '环境 ID' },
        target: { type: 'string', description: '@e1 / CSS 选择器 / text=...' },
        tab: { type: 'string', description: '可选标签页索引或 targetId' },
      },
    },
  },
  {
    name: 'fb_select',
    description: '选择 <select> 下拉框的选项（支持按 option value 或可见文本匹配）',
    inputSchema: {
      type: 'object',
      required: ['profileId', 'target', 'value'],
      properties: {
        profileId: { type: 'string', description: '环境 ID' },
        target: { type: 'string', description: '@e1 / CSS 选择器' },
        value: { type: 'string', description: '目标选项的 value 或显示文案' },
        tab: { type: 'string', description: '可选标签页索引或 targetId' },
      },
    },
  },
  {
    name: 'fb_scroll',
    description: '使用原生滚轮事件滚动页面或指定区域（deltaY > 0 向下滚动）',
    inputSchema: {
      type: 'object',
      required: ['profileId'],
      properties: {
        profileId: { type: 'string', description: '环境 ID' },
        deltaY: { type: 'number', description: '垂直滚动像素（正值向下，默认 500）' },
        deltaX: { type: 'number', description: '水平滚动像素，默认 0' },
        target: { type: 'string', description: '可选滚动目标容器/元素' },
        tab: { type: 'string', description: '可选标签页索引或 targetId' },
      },
    },
  },
  {
    name: 'fb_upload',
    description: '向 <input type="file"> 控件上传一个或多个本地文件',
    inputSchema: {
      type: 'object',
      required: ['profileId', 'target', 'files'],
      properties: {
        profileId: { type: 'string', description: '环境 ID' },
        target: { type: 'string', description: '@e1 / CSS 选择器（指向 <input type="file">）' },
        files: { type: 'array', items: { type: 'string' }, description: '本地文件路径数组' },
        tab: { type: 'string', description: '可选标签页索引或 targetId' },
      },
    },
  },
  {
    name: 'fb_wait',
    description: '等待页面元素出现、文本出现、URL 包含特定片段或固定毫秒数（检测到人机验证时会立即中止等待并返回提示）',
    inputSchema: {
      type: 'object',
      required: ['profileId'],
      properties: {
        profileId: { type: 'string', description: '环境 ID' },
        selector: { type: 'string', description: '等待可见的 CSS 选择器或 @eN' },
        target: { type: 'string', description: '同 selector' },
        text: { type: 'string', description: '等待页面正文中出现该文本' },
        urlIncludes: { type: 'string', description: '等待当前 URL 包含该子串' },
        ms: { type: 'number', description: '无条件等待毫秒数（无上述条件时生效）' },
        timeoutMs: { type: 'number', description: '条件等待超时毫秒数，默认 10000' },
        tab: { type: 'string', description: '可选标签页索引或 targetId' },
      },
    },
  },
  {
    name: 'fb_focus',
    description: '将该环境的活动标签页窗口置前聚焦（常用于在人工接管人机验证、2FA 或扫码登录时提醒用户操作）',
    inputSchema: {
      type: 'object',
      required: ['profileId'],
      properties: {
        profileId: { type: 'string', description: '环境 ID' },
        tab: { type: 'string', description: '可选标签页索引或 targetId' },
      },
    },
  },
  {
    name: 'fb_screenshot',
    description: '截取当前页面 PNG 截图（传 path 保存到文件，不传 path 则直接返回图片供多模态分析）',
    inputSchema: {
      type: 'object',
      required: ['profileId'],
      properties: {
        profileId: { type: 'string', description: '环境 ID' },
        path: { type: 'string', description: '可选保存文件路径（如 D:\\shot.png）' },
        fullPage: { type: 'boolean', description: '是否截取整页长图，默认 false' },
        tab: { type: 'string', description: '可选标签页索引或 targetId' },
      },
    },
  },
  {
    name: 'fb_eval',
    description: '在当前页面上下文执行只读/分析 JavaScript 表达式并返回值（支持 Promise）',
    inputSchema: {
      type: 'object',
      required: ['profileId', 'expression'],
      properties: {
        profileId: { type: 'string', description: '环境 ID' },
        expression: { type: 'string', description: 'JavaScript 表达式，如 (() => document.title)()' },
        tab: { type: 'string', description: '可选标签页索引或 targetId' },
      },
    },
  },
];

async function executeTool(name, args, { ensureDaemon, consoleApi }) {
  const a = args && typeof args === 'object' ? args : {};
  const live = await ensureDaemon();
  const enc = (id) => encodeURIComponent(String(id || ''));

  switch (name) {
    case 'fb_list_profiles': {
      const st = await consoleApi(live, 'GET', '/api/state');
      const profiles = (st.profiles || []).map((p) => {
        const { instance, ...rest } = p;
        return { ...rest, pid: instance ? instance.pid : null };
      });
      return { ok: true, count: profiles.length, profiles };
    }

    case 'fb_create_profile': {
      if ((a.count && Number(a.count) > 1) || a.proxiesText) {
        return await consoleApi(live, 'POST', '/api/profiles/batch', {
          preset: a.preset || '',
          name: a.name || '',
          group: a.group || '',
          count: a.count ? Number(a.count) : 0,
          proxiesText: a.proxiesText || '',
          autoGeo: a.autoGeo === true,
        });
      }
      const body = {};
      if (a.preset) {
        const preset = getPreset(a.preset);
        body.platform = preset.platform;
        body.locale = preset.locale;
        body.languages = preset.languages;
        body.timezone = preset.timezone;
        body.group = preset.label;
      }
      if (a.name) body.name = a.name;
      if (a.group) body.group = a.group;
      if (a.platform) body.platform = a.platform;
      if (a.timezone) body.timezone = a.timezone;
      if (a.locale) body.locale = a.locale;
      if (Array.isArray(a.languages)) body.languages = a.languages;
      if (a.startUrl) body.startUrl = a.startUrl;
      if (a.notes) body.notes = a.notes;
      if (a.autoGeo !== undefined) body.autoGeo = !!a.autoGeo;
      if (a.proxy) {
        body.proxy = typeof a.proxy === 'string' ? parseProxyLine(a.proxy) : a.proxy;
      }
      if (!body.name) body.name = '新环境';
      const created = await consoleApi(live, 'POST', '/api/profiles', body);
      return { ok: true, profile: created };
    }

    case 'fb_launch': {
      if (!a.profileId) throw new Error('缺少 profileId');
      const info = await consoleApi(
        live,
        'POST',
        '/api/profiles/' + enc(a.profileId) + '/launch',
        { startUrl: a.startUrl, autoGeo: !!a.autoGeo },
        35000
      );
      return { ok: true, ...info };
    }

    case 'fb_stop': {
      if (!a.profileId) throw new Error('缺少 profileId');
      return await consoleApi(live, 'POST', '/api/profiles/' + enc(a.profileId) + '/stop', {}, 15000);
    }

    case 'fb_cookies': {
      if (!a.profileId) throw new Error('缺少 profileId');
      if (a.action === 'import') {
        return await consoleApi(
          live,
          'POST',
          '/api/profiles/' + enc(a.profileId) + '/cookies',
          { text: String(a.cookiesText || '') },
          25000
        );
      }
      return await consoleApi(live, 'GET', '/api/profiles/' + enc(a.profileId) + '/cookies', undefined, 25000);
    }

    case 'fb_tabs': {
      if (!a.profileId) throw new Error('缺少 profileId');
      const actName = a.action || 'list';
      if (actName === 'list') {
        return await consoleApi(live, 'GET', '/api/profiles/' + enc(a.profileId) + '/tabs');
      }
      return await consoleApi(live, 'POST', '/api/profiles/' + enc(a.profileId) + '/tabs', {
        action: actName,
        tab: a.tab,
        url: a.url,
      });
    }

    case 'fb_goto': {
      if (!a.profileId) throw new Error('缺少 profileId');
      return await consoleApi(
        live,
        'POST',
        '/api/profiles/' + enc(a.profileId) + '/goto',
        {
          action: a.action || 'goto',
          url: a.url,
          waitUntil: a.waitUntil,
          tab: a.tab,
          timeoutMs: a.timeoutMs,
        },
        Math.max(25000, (Number(a.timeoutMs) || 20000) + 5000)
      );
    }

    case 'fb_snapshot': {
      if (!a.profileId) throw new Error('缺少 profileId');
      return await consoleApi(
        live,
        'POST',
        '/api/profiles/' + enc(a.profileId) + '/snapshot',
        {
          tab: a.tab,
          selector: a.selector,
          maxText: a.maxText,
          maxElements: a.maxElements,
        },
        20000
      );
    }

    case 'fb_click': {
      if (!a.profileId) throw new Error('缺少 profileId');
      const actType = a.button === 'right' ? 'rightclick' : Number(a.clickCount) === 2 ? 'dblclick' : 'click';
      return await consoleApi(live, 'POST', '/api/profiles/' + enc(a.profileId) + '/act', {
        action: actType,
        target: a.target,
        x: a.x,
        y: a.y,
        tab: a.tab,
      });
    }

    case 'fb_fill': {
      if (!a.profileId) throw new Error('缺少 profileId');
      return await consoleApi(live, 'POST', '/api/profiles/' + enc(a.profileId) + '/act', {
        action: 'fill',
        target: a.target,
        value: a.value,
        clear: a.clear !== false,
        pressEnter: !!a.pressEnter,
        tab: a.tab,
      });
    }

    case 'fb_type': {
      if (!a.profileId) throw new Error('缺少 profileId');
      return await consoleApi(
        live,
        'POST',
        '/api/profiles/' + enc(a.profileId) + '/act',
        {
          action: 'type',
          target: a.target,
          text: a.text,
          delayMs: a.delayMs,
          tab: a.tab,
        },
        30000
      );
    }

    case 'fb_press': {
      if (!a.profileId) throw new Error('缺少 profileId');
      return await consoleApi(live, 'POST', '/api/profiles/' + enc(a.profileId) + '/act', {
        action: 'press',
        key: a.key,
        target: a.target,
        tab: a.tab,
      });
    }

    case 'fb_hover': {
      if (!a.profileId) throw new Error('缺少 profileId');
      return await consoleApi(live, 'POST', '/api/profiles/' + enc(a.profileId) + '/act', {
        action: 'hover',
        target: a.target,
        tab: a.tab,
      });
    }

    case 'fb_select': {
      if (!a.profileId) throw new Error('缺少 profileId');
      return await consoleApi(live, 'POST', '/api/profiles/' + enc(a.profileId) + '/act', {
        action: 'select',
        target: a.target,
        value: a.value,
        tab: a.tab,
      });
    }

    case 'fb_scroll': {
      if (!a.profileId) throw new Error('缺少 profileId');
      return await consoleApi(live, 'POST', '/api/profiles/' + enc(a.profileId) + '/act', {
        action: 'scroll',
        target: a.target,
        deltaX: a.deltaX,
        deltaY: a.deltaY,
        tab: a.tab,
      });
    }

    case 'fb_upload': {
      if (!a.profileId) throw new Error('缺少 profileId');
      return await consoleApi(live, 'POST', '/api/profiles/' + enc(a.profileId) + '/act', {
        action: 'upload',
        target: a.target,
        files: a.files,
        tab: a.tab,
      });
    }

    case 'fb_wait': {
      if (!a.profileId) throw new Error('缺少 profileId');
      const timeoutMs = Number(a.timeoutMs) || 10000;
      return await consoleApi(
        live,
        'POST',
        '/api/profiles/' + enc(a.profileId) + '/act',
        {
          action: 'wait',
          selector: a.selector,
          target: a.target,
          text: a.text,
          urlIncludes: a.urlIncludes,
          ms: a.ms,
          timeoutMs,
          tab: a.tab,
        },
        Math.max(20000, timeoutMs + 5000)
      );
    }

    case 'fb_focus': {
      if (!a.profileId) throw new Error('缺少 profileId');
      return await consoleApi(live, 'POST', '/api/profiles/' + enc(a.profileId) + '/focus', {
        tab: a.tab,
      });
    }

    case 'fb_screenshot': {
      if (!a.profileId) throw new Error('缺少 profileId');
      return await consoleApi(
        live,
        'POST',
        '/api/profiles/' + enc(a.profileId) + '/screenshot',
        {
          path: a.path,
          fullPage: !!a.fullPage,
          tab: a.tab,
        },
        25000
      );
    }

    case 'fb_eval': {
      if (!a.profileId) throw new Error('缺少 profileId');
      return await consoleApi(live, 'POST', '/api/profiles/' + enc(a.profileId) + '/eval', {
        expression: a.expression,
        tab: a.tab,
      });
    }

    default:
      throw new Error('未知工具：' + name);
  }
}

async function startMcpServer({ ensureDaemon, consoleApi }) {
  const writeOut = (chunk) => process.stdout.write(chunk);
  // 防止任何第三方或内部日志意外写进 stdout 破坏 JSON-RPC 帧
  const toStderr = (...args) => process.stderr.write(args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;

  let framing = 'line';
  let buf = Buffer.alloc(0);
  let inFlight = 0;
  let stdinEnded = false;
  let resolved = false;
  let resolveDone = null;

  function maybeDone() {
    if (!resolved && stdinEnded && inFlight === 0 && resolveDone) {
      resolved = true;
      resolveDone();
    }
  }

  function dispatch(msg) {
    inFlight++;
    Promise.resolve(handleMessage(msg))
      .catch(() => {})
      .finally(() => {
        inFlight--;
        maybeDone();
      });
  }

  function sendJson(obj) {
    const raw = JSON.stringify(obj);
    if (framing === 'lsp') {
      writeOut('Content-Length: ' + Buffer.byteLength(raw, 'utf8') + '\r\n\r\n' + raw);
    } else {
      writeOut(raw + '\n');
    }
  }

  function sendResult(id, result) {
    sendJson({ jsonrpc: '2.0', id, result });
  }

  function sendError(id, code, message) {
    sendJson({ jsonrpc: '2.0', id, error: { code, message: String(message || 'Internal error') } });
  }

  async function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    const hasId = msg.id !== undefined && msg.id !== null;
    const method = msg.method;
    const params = msg.params || {};

    if (!method) return;
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;

    try {
      if (method === 'initialize') {
        return sendResult(msg.id, {
          protocolVersion: params.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'lite-fingerprint', version: '1.0.0' },
          instructions:
            'LiteFingerprint 指纹浏览器 MCP 服务。流程：fb_list_profiles -> fb_launch -> fb_goto -> fb_snapshot 获取 @e1/@e2 元素引用 -> fb_fill / fb_click 等操控。遇到 blockedByChallenge=true（人机验证/2FA）时必须停止自动化，调用 fb_focus 并请用户手动在浏览器窗口中完成。',
        });
      }

      if (method === 'ping') {
        return sendResult(msg.id, {});
      }
      if (method === 'resources/list') {
        return sendResult(msg.id, { resources: [] });
      }
      if (method === 'prompts/list') {
        return sendResult(msg.id, { prompts: [] });
      }
      if (method === 'tools/list') {
        return sendResult(msg.id, { tools: TOOLS });
      }

      if (method === 'tools/call') {
        const toolName = params.name;
        const toolArgs = params.arguments || {};
        try {
          const res = await executeTool(toolName, toolArgs, { ensureDaemon, consoleApi });
          if (toolName === 'fb_screenshot' && res && res.data && !toolArgs.path) {
            return sendResult(msg.id, {
              content: [
                { type: 'image', data: res.data, mimeType: res.mimeType || 'image/png' },
                { type: 'text', text: JSON.stringify({ ok: true, targetId: res.targetId, bytes: res.bytes }) },
              ],
            });
          }
          return sendResult(msg.id, {
            content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
          });
        } catch (err) {
          return sendResult(msg.id, {
            content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }) }],
            isError: true,
          });
        }
      }

      if (hasId) {
        return sendError(msg.id, -32601, 'Method not found: ' + method);
      }
    } catch (err) {
      if (hasId) {
        sendError(msg.id, -32603, err && err.message ? err.message : String(err));
      }
    }
  }

  function drainBuffer() {
    while (buf.length > 0) {
      while (buf.length > 0 && (buf[0] === 0x0d || buf[0] === 0x0a || buf[0] === 0x20 || buf[0] === 0x09)) {
        buf = buf.subarray(1);
      }
      if (buf.length === 0) break;

      const probe = buf.subarray(0, Math.min(buf.length, 32)).toString('ascii');
      if (/^content-length\s*:/i.test(probe)) {
        let sepIdx = buf.indexOf('\r\n\r\n');
        let sepLen = 4;
        if (sepIdx < 0) {
          sepIdx = buf.indexOf('\n\n');
          sepLen = 2;
        }
        if (sepIdx < 0) break;
        const header = buf.subarray(0, sepIdx).toString('ascii');
        const m = /content-length\s*:\s*(\d+)/i.exec(header);
        if (!m) {
          buf = buf.subarray(sepIdx + sepLen);
          continue;
        }
        const len = parseInt(m[1], 10);
        if (buf.length < sepIdx + sepLen + len) break;
        const payload = buf.subarray(sepIdx + sepLen, sepIdx + sepLen + len).toString('utf8');
        buf = buf.subarray(sepIdx + sepLen + len);
        framing = 'lsp';
        try {
          dispatch(JSON.parse(payload));
        } catch (err) {
          process.stderr.write('[mcp] invalid JSON payload: ' + err.message + '\n');
        }
        continue;
      }

      const nl = buf.indexOf(0x0a);
      if (nl < 0) break;
      const line = buf.subarray(0, nl).toString('utf8').trim();
      buf = buf.subarray(nl + 1);
      if (!line) continue;
      framing = 'line';
      try {
        dispatch(JSON.parse(line));
      } catch (err) {
        process.stderr.write('[mcp] invalid JSON line: ' + err.message + '\n');
      }
    }
  }

  return await new Promise((resolve) => {
    resolveDone = resolve;
    process.stdin.on('data', (chunk) => {
      buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')]);
      drainBuffer();
    });
    const finish = () => {
      if (stdinEnded) return;
      stdinEnded = true;
      const tail = buf.toString('utf8').trim();
      buf = Buffer.alloc(0);
      if (tail && tail.startsWith('{')) {
        try {
          dispatch(JSON.parse(tail));
        } catch {
          /* ignore */
        }
      }
      maybeDone();
    };
    process.stdin.on('end', finish);
    process.stdin.on('close', finish);
    process.stdin.resume();
  });
}

module.exports = { startMcpServer, TOOLS };
