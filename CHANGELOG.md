# Changelog

## 0.2.2

- fix: `pc_clipboard` 读取非 ASCII 文本（中文、emoji）不再乱码
- fix: `pc_snapshot` / `pc_find` 的 `windowId` 可直接使用 `pc_window` 返回的 HWND（数字形式），也接受 CLI 的 `w-<hwnd>` 形式
- feat: `pc_window` 每项新增 `cliId` 字段
- docs: README 精简；工具描述补充 `windowId` 取值说明与 `pc_act.headed` 的用途

## 0.2.1

- docs: 整理安装、打包与第三方许可段落

## 0.2.0

- 首个公开版本：15 个 `pc_*` 工具，覆盖无障碍快照/查找/读取/操作、按键、截图（含无障碍框标注）、显示器信息、窗口管理、浏览器 DOM、进程内等待、应用管理、剪贴板、通知与急停开关
- 自包含分发：内置 cua 库、agent-desktop 二进制（Apache-2.0，未修改）与浏览器 CLI
