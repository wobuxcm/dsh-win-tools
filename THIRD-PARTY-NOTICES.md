# 第三方组件声明（Third-Party Notices）

本插件（dsh-win-tools）自身代码采用 MIT 许可，见根目录 `LICENSE`。
下列第三方组件按各自许可分发，本插件不改变其许可条款。

## 1. agent-desktop（Vercel Labs）— Apache-2.0

- **来源**：https://github.com/vercel-labs/agent-desktop
- **分发形式**：`bin/agent-desktop-win32-x64.exe`（官方 npm 包 `agent-desktop@1.2.0` 内的 Windows x64 产物）
- **修改情况**：**未修改**。以独立进程调用（`child_process.spawn`），不链接、不静态嵌入、不改写二进制。
- **许可证全文**：`LICENSES/Apache-2.0.txt`
- **上游 NOTICE**：npm 包内未提供 NOTICE 文件，本仓库不附带。
- **商标**：agent-desktop 及其名称归其作者所有；本项目为独立社区实现，**与 Vercel Labs 无隶属、合作或背书关系**，不使用其名称作为本项目名称或宣传语。

## 2. 内嵌 Windows 原生库（lib/cua/）

- **作者**：本项目作者（cjl15），2026 年原创编写
- **许可**：随本插件以 MIT 分发（见根目录 `LICENSE`）
- **内容**：`lib/cua/native.js`、`input.js`、`screen.js`
- **依赖**：运行时通过 npm 依赖 `koffi`（MIT）调用 Win32 API

## 3. 浏览器 CLI（bin/web.js）

- **作者**：本项目作者（cjl15）
- **许可**：随本插件以 MIT 分发
- **依赖**：`playwright-core`（Apache-2.0），作为 **可选依赖**，不随本包分发

## 4. npm 依赖

| 包 | 许可 | 用途 |
|---|---|---|
| koffi | MIT | Win32 API FFI |
| pngjs | MIT | PNG 解码（截图/像素） |
| playwright-core（可选） | Apache-2.0 | 浏览器自动化 |

这些依赖由使用者在安装时获取，各自保留其许可与版权声明。
