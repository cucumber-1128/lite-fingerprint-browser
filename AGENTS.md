# 给 agent 的操作说明

这是一个零依赖的本地指纹浏览器。所有操作都能用 CLI 完成，**全部支持 `--json`**：

- `--json` 时 stdout 只有一段 JSON，退出码 `0` 成功 / `1` 失败；
- 失败时结构是 `{"ok":false,"error":"..."}`，成功时至少带 `"ok":true`；
- 不弹任何交互式提示，不需要 TTY。

入口：

```bash
node src/index.js <命令> [选项] --json
```

打包成客户端后，把 `node src/index.js` 换成 `LiteFingerprint.exe` 即可（同一个 CLI）。

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
| `launch <id>... \| --group <g> \| --all` | 启动，进程 detach，命令立即返回 |
| `stop <id>... \| --group <g> \| --all` | 关闭 |
| `probe <id>` | 在环境里读一次真实指纹（需要已启动） |
| `proxy-test <id>` | 经该环境的代理取出口 IP，并和直连 IP 对比 |
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
