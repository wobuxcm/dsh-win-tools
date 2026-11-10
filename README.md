# @wobuxcm/dsh-win-tools

Windows 桌面控制插件（DeepSeek Harness 宿主插件）。自带全部运行时：没有其它插件依赖。

## 工具（15 个 `pc_*`）

| 工具 | 作用 |
|---|---|
| `pc_status` | 无障碍桥接健康、平台、权限、CLI 版本 |
| `pc_snapshot` | 读无障碍树，返回 `@ref`；支持 `surface` / `waitFor` / `root` / `includeBounds` |
| `pc_find` | 按 role/name/value/text 直接搜索元素（比全量快照轻） |
| `pc_read` | 按 `@ref` 读单个属性或状态（text/value/bounds/visible…） |
| `pc_act` | 按 `ref` 执行无障碍动作，或按坐标注入鼠标/键盘（自绘界面） |
| `pc_key` | 按键组合（SendInput，Unicode 安全） |
| `pc_screen` | GDI 截图，返回 PNG 路径并作为图片附件返回；`annotate: true` 叠无障碍框与编号 |
| `pc_display` | 显示器布局（物理像素）与 DPI |
| `pc_window` | 列举/聚焦窗口 |
| `pc_browser` | 浏览器 DOM 操作：title/text/table/links/click/type/shot |
| `pc_wait` | 进程内轮询：窗口标题 / 像素 / 区域比例 / 画面变化，可附带动作 |
| `pc_app` | 应用列举/启动/关闭/缩放/最小化/最大化/还原 |
| `pc_clipboard` | 读写文本剪贴板 |
| `pc_notify` | 托盘气泡通知 |
| `pc_pause` | 操作员急停开关（pause/resume/status） |

## 安全

- **急停（唯一开关）**：全局热键 `Ctrl+Alt+Shift+F12` 切换 `%DSH_HOME%/cua.stop`；文件存在时所有写操作（`pc_act`/`pc_key`/`pc_window` focus/`pc_app`/`pc_wait`）返回 `PAUSED_BY_USER`
- **黑名单**：点击/按键前检查目标点与前台窗口标题，命中「支付/充值/购买/授权/扫码/付款/收银/转账/下单/结算/微信支付/支付宝」直接返回 `BLOCKED_KEYWORD`
- **日志**：`%DSH_HOME%/win-tools.log`（JSONL）

## 安装

作为 npm 包安装到 DSH profile：

```powershell
npm i @wobuxcm/dsh-win-tools
# 源码开发时可以 link 本地目录：
# "@wobuxcm/dsh-win-tools": "link:<插件源码目录>"
```

然后在 profile 的 `package.json` 里把插件加入 `dsh.profile.bundles`：

```json
"dsh": { "profile": { "bundles": ["@wobuxcm/dsh-win-tools"] } }
```

开发时用 junction 指向源码目录：

```powershell
New-Item -ItemType Junction -Path "<profile>\node_modules\@wobuxcm\dsh-win-tools" -Target "<插件源码目录>"
```

## 环境变量覆盖

`PC_AGENT_BIN`（无障碍二进制）、`PC_CUA_DIR`（cua 库目录）、`PC_BROWSER_JS`（web.js）、`PC_NODE_BIN`（跑 web.js 的 node）。

## 打包

```powershell
npm pack --dry-run   # 清单预演
npm pack             # 生成 wobuxcm-dsh-win-tools-<version>.tgz
```

清单：`index.js`、`lib/`、`bin/`、`LICENSES/`、`THIRD-PARTY-NOTICES.md`、`cordis.patch.yml`、`README.md`、`package.json`。

## 许可与第三方

- 本插件自身代码（`index.js`、`lib/core.js`、`lib/cua/*`、`bin/web.js`）: **MIT**，见根目录 `LICENSE`（Copyright (c) 2026 cjl15）
- `bin/agent-desktop-win32-x64.exe`: **Apache-2.0**，来自 [vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop)，**未修改**（与上游 `agent-desktop@1.2.0` 内的同名产物 SHA-256 一致），以独立进程调用；许可证全文见 `LICENSES/Apache-2.0.txt`
- npm 依赖：`koffi`（MIT）、`pngjs`（MIT）、`playwright-core`（Apache-2.0，可选）
- 本项目与 Vercel Labs 无隶属或背书关系；不使用其名称作为项目名

完整声明见 `THIRD-PARTY-NOTICES.md`。

## 限制

- 仅 Windows x64（二进制与 SendInput/GDI 均为 Windows 实现）
- `pc_browser` 需要 `playwright-core`（可选依赖）与本机 Edge/Chrome
- `pc_wait` 的 `image_changed` 需要显式 `rect`，整屏轮询开销大
