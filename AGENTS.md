# 给 agent 的操作说明

用户丢过来的通常是安装目录里的 exe，不是这份源码。先按下面做，不要去翻二进制、解包、读 `store.js` 再手写 `profiles.json`。

安装目录：

```text
LiteFingerprint.exe   窗口。不接受 create/list，传参数也不会转给后台
fb.exe                CLI，就是打包后的这个程序
AGENTS.md             本文件。安装目录里也放一份
 data/                 环境数据。跟 fb.exe 走，不要另设 FB_DATA
```

在安装目录里执行（源码仓库里把 `fb.exe` 换成 `node src/index.js`）：

```text
fb.exe doctor --json
fb.exe presets --json
fb.exe create --preset us-west --count 3 --name 美西 --json
fb.exe list --json
```

用户给了一个 IP，要求「按这个 IP 建环境」：

1. `fb.exe presets --json` 已经带时区，不要读源码里的预设表。
2. 用 IP 的公开地理位置对时区，选预设：美西 `us-west`，美东 `us-shop`，英国 `uk-shop`，德国 `de-shop`，日本 `jp-shop`，台湾 `tw-shop`，中国 `cn-shop`。
3. 用户没给代理，就不要加 `--proxy`。出口就是本机。屏幕、CPU、显卡不用填。

不要做：

- 不要对 `LiteFingerprint.exe` 传 CLI 参数。它只拉窗口，参数会被丢掉。
- 不要在源码仓库里跑 `node src/index.js create` 再把结果拷贝安装目录。那会写进仓库自己的 `data/`。
- 不要解包 `fb.exe`。命令就是上面那些。

所有命令都支持 `--json`：stdout 只有一段 JSON，退出码 `0` 成功 / `1` 失败；失败是 `{"ok":false,"error":"..."}`；不弹交互提示。`fb.exe help` 和 `fb.exe --help` 都只打帮助，不会把控制台又起一个。

---

## 常用一句话 → 命令

| 用户会说 | 你执行 |
|---|---|
| 「建 5 个美国店铺，代理在 proxies.txt」 | `node src/index.js create --preset us-shop --name 美国店铺 --proxies proxies.txt --json` |
| 「再来 3 个日本的」 | `node src/index.js create --preset jp-shop --count 3 --name 日本店铺 --json` |
| 「这个环境用这个代理」 | `node src/index.js create --name 店铺A --preset us-shop --proxy 'http://u:p@host:8080' --json` |
| 「美国组全开起来」 | `node src/index.js launch --group 美国店铺 --json` |
| 「看看现在有哪些在跑」 | `node src/index.js list --json` |
| 「读一下这个环境的真实指纹」 | `node src/index.js probe <id> --json` |
| 「测一下它的代理出口」 | `node src/index.js proxy-test <id> --json` |
| 「美国组全关掉」 | `node src/index.js stop --group 美国店铺 --json` |
| 「复制一份改个名」 | `node src/index.js clone <id> --name 店铺B --json` |
| 「把配置导出来备份」 | `node src/index.js export backup.json --json` |
| 「在新机器上恢复」 | `node src/index.js import backup.json --json` |
| 「按我这个 IP 建 3 个」 | 先 `fb.exe presets --json` 对时区，再 `fb.exe create --preset us-west --count 3 --name 美西 --json`（美西才是 us-west；没给代理就不要加 --proxy） |
| 「环境不对劲，先自检」 | `node src/index.js doctor --json` |

---

## 命令

| 命令 | 说明 |
|---|---|
| `serve [--port N] [--no-open]` | 启动网页控制台（人不一定需要，agent 一般用不到） |
| `list` | 列出环境，含 `running` / `pid` |
| `create` | 新建一个或多个环境 |
| `clone <id> [--name 名]` | 克隆：配置照抄，但换新 seed（画布/音频噪声、WebRTC 假 IP 都变），Cookie 不复制 |
| `rm <id>... \| --group <g>` | 删除（运行中会先关掉） |
| `launch <id>... \| --group <g> \| --all [--auto-geo]` | 启动，进程 detach，命令立即返回；加 `--auto-geo` 按代理出口对齐地区与经纬度 |
| `stop <id>... \| --group <g> \| --all` | 关闭 |
| `probe <id>` | 在环境里读一次真实指纹（需要已启动） |
| `proxy-test <id>` | 经该环境的代理取出口 IP，并和直连 IP 对比 |
| `cookie-export <id> [文件.json]` | 导出环境 Cookie（明文 JSON，可跨机迁移，不给文件打到 stdout） |
| `cookie-import <id> <文件>` | 导入 Cookie（支持 EditThisCookie JSON 或 Netscape 格式，传 `@-` 读 stdin） |
| `export [文件]` | 导出 JSON（**不含代理密码**）；不给文件就打到 stdout |
| `import <文件>` | 导入，全部当新环境（新 id、密码清空） |
| `presets` | 列出内置地区预设 |
| `doctor` | 自检：内核、数据目录可写、控制台、环境数、运行数 |

### create 选项

| 选项 | 说明 |
|---|---|
| `--preset <key>` | 地区预设（`us-shop` `us-west` `uk-shop` `de-shop` `jp-shop` `tw-shop` `cn-shop` `mac-us`） |
| `--count N` | 批量；给了 `--proxies` 且没给 `--count` 时，数量默认等于代理条数 |
| `--proxies <文件>` | 一行一个代理，`#` 开头是注释 |
| `--proxy <串>` | 单个代理 |
| `--group <名>` | 分组（默认用预设的中文名） |
| `--name <名>` | 名称；`--count > 1` 时自动加 `-1` `-2` 后缀 |
| `--auto-geo` | 启动时自动按代理出口 IP 同步时区、语言与经纬度 |
| `--spec '<json>'` 或 `--spec @file.json` | 直接给完整字段，优先级最高（字段见下） |

代理支持的写法（任选其一，一行一个）：

```
http://user:pass@1.2.3.4:8080
https://1.2.3.4:8080
socks5://user:pass@1.2.3.4:1080
1.2.3.4:8080
1.2.3.4:8080:user:pass
socks5:1.2.3.4:1080:user:pass
```

**代理和环境是一对一的**：`--count` 大于代理条数会直接报错，不会重复使用同一个出口 IP。

### --spec 的完整字段

```json
{
  "name": "店铺A",
  "group": "美国店铺",
  "platform": "win",
  "locale": "en-US",
  "languages": ["en-US", "en"],
  "timezone": "America/New_York",
  "screen": { "width": 1920, "height": 1080, "availHeight": 1040, "colorDepth": 24, "pixelRatio": 1 },
  "hardwareConcurrency": 8,
  "deviceMemory": 8,
  "webglVendor": "Google Inc. (NVIDIA)",
  "webglRenderer": "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  "webrtc": "proxy",
  "canvasNoise": true,
  "audioNoise": true,
  "textNoise": true,
  "fontNoise": true,
  "rectNoise": false,
  "proxy": { "type": "http", "host": "1.2.3.4", "port": "8080", "username": "u", "password": "p" }
}
```

没给的字段会按预设 + 随机指纹补全，**所以只给 `name` + `preset` 就够了**。

---

## 返回结构

`list --json`：

```json
{ "ok": true, "count": 2, "profiles": [ { "id": "…", "name": "…", "group": "…", "platform": "win",
  "timezone": "America/New_York", "running": true, "pid": 1234, "proxy": { "host": "…", "hasPassword": true } } ] }
```

`create --json`：

```json
{ "ok": true, "count": 3, "created": [ { "id": "…", "name": "美国店铺-1", "…": "…" } ] }
```

`probe --json`：`{ "ok": true, "report": { "userAgent", "platform", "timezone", "hardwareConcurrency", "screen", "webglRenderer", "canvasHash", "audioHash", "injected", … } }`

`proxy-test --json`：`{ "ok": true, "result": { "ip", "country", "city", "isp", "ms", "directIp", "leaked" } }`（`leaked: true` 表示出口和直连一样，代理没生效）

---

## 注意事项

1. **先 `doctor`**：没找到 Chrome/Edge 时 `create` 能成功，但 `launch` 会失败。
2. `launch` 是 detach 的，命令返回不代表浏览器已经加载完页面；需要读指纹就接着调 `probe`（它会等页面就绪）。
3. `probe` / `proxy-test` 要求环境**正在运行**。
4. 代理密码**只写不读**：`list`、导出都看不到密码；导入后需要重新填。
5. 同一台机器上的多个环境共用出口网卡，真正隔离要靠一个环境一个代理 IP；时区/语言要和代理地区一致（预设已经帮你对齐）。
6. 删环境会连 `data/profiles/<id>/` 一起删，Cookie 登录态没了，删之前确认。
