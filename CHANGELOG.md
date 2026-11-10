# Changelog

## 0.2.3

- feat: 屏幕活动指示灯 `bin/indicator.ps1` —— 置顶、点击穿透、不抢焦点的小条；AI 操作时显示 "AI is operating this PC"，暂停时变灰，5 秒无动作自动隐藏；设 `PC_INDICATOR=0` 可关闭
- feat: 指示灯支持**任务标签**（`%DSH_HOME%/cua.task`）—— 长任务（生图、下载）期间常亮并显示当前步骤，最长 30 分钟
- feat: `pc_app` 的 `resize` 新增可选 `x`/`y`，可把目标窗口摆到指定位置（分屏作业）
- chore: 删除未被引用的 `lib/cua/engine.js` 与 `safety.js`（约 22 KB 死代码，注释仍描述已放弃的 dryRun/confirm 与多步宏）
- docs: `lib/core.js` 全部导出函数补齐 JSDoc，把 ref 过期、windowId 两种形式、`headed` 策略、DPI 等踩坑点写进代码注释
- docs: README 新增「使用备注」一节，汇总 10 条实战注意事项

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
