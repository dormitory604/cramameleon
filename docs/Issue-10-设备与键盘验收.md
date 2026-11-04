# Issue #10 设备与键盘验收

对应 [Issue #10](https://github.com/dormitory604/cramameleon/issues/10)（规格 #4 用户故事 14、30–32）。范围限于 A 负责的界面布局、滚动、焦点和触达；未改动 Agent、公共契约或服务端，未调用付费模型。

## 验证方式

[device-keyboard.spec.ts](../tests/e2e/device-keyboard.spec.ts) 驱动真实页面 → 真实 PiAgentAdapter → 可控模型流（只替换 `/api/model` 的 HTTP 流，按需逐段推送文字、工具调用和终态）；资料文件经真实 Worker 解析，记录存于真实 IndexedDB。两组设备配置：

- 电脑：1280×800。
- 手机／触摸：375×667，`isMobile`、`hasTouch`，全部操作用 `tap()`。

| 场景 | 设备 | 覆盖内容 |
| --- | --- | --- |
| 长公式、代码和表格 | 电脑、手机 | 长块级公式、长代码行和宽表格在各自区域内横向滚动；长行内公式、长链接、题干中的长行内代码和长选项不产生页面、聊天区或题板的横向滚动；作答后仍无横向溢出 |
| 流式滚动 | 电脑、手机 | 停在底部时跟随新内容；用户上翻阅读历史时，后续流式内容不把视图拉回底部；回到底部后恢复跟随；用户发送新问题时总是回到底部 |
| 键盘主路径 | 电脑 | 仅用 Tab／Enter 进入输入框发送、选择题目选项、打开题板来源；弹窗初始焦点在“关闭来源”，Tab／Shift+Tab 不离开弹窗，Escape 关闭并把焦点还给来源按钮；从资料面板“查看文本”打开时同样恢复焦点；关闭来源后继续提问；会话删除按钮可经 Tab 到达。焦点元素有非空 outline 且不透明 |
| 触摸主路径 | 手机 | 导入两份资料后输入框和发送按钮在视口内、聊天区保留阅读高度；发送、作答、打开／关闭来源（关闭按钮在视口内）；打开侧边栏新建、切换会话；删除按钮无需 hover 即可见且至少 32×32；点遮罩关闭侧边栏 |

## 发现与处理

截图保存在仓库外的 `/private/tmp/cramameleon-spec-4/issue-10-shots/`，不作为运营证据提交。`before-*` 为修复前、无前缀或 `after-*` 为修复后。

| 问题 | 影响 | 修复前 | 处理 | 截图 |
| --- | --- | --- | --- | --- |
| 流式生成时强制滚到底部 | 生成期间无法阅读历史，上翻会被立刻拉回 | 每次消息变化都滚到底部；测试中上翻后 `scrollTop` 被重置 | 聊天区记录用户是否停在底部（48px 内），只在跟随状态下自动滚动；切换会话和发送新问题时恢复跟随 | 无（行为问题，由回归断言覆盖） |
| 题板长行内代码撑宽 | 题板和聊天区出现横向滚动，题干需左右拖动 | 电脑聊天区溢出 1161px，题板 1310px；手机溢出 1670px／1687px | `.quiz` 使用 `overflow-wrap: anywhere`，选项文字可收缩 | `before-desktop-long-content.png`、`before-mobile-long-content.png` → `desktop-long-content.png`、`mobile-long-content.png` |
| 表格数字被截断换行 | 宽表格在电脑上被压缩，数字从中间折行，难以读 | 表格不滚动（`scrollWidth = clientWidth`），单元格继承 `.msg-text` 的任意断行 | 表格单元格恢复正常断词，宽表格在 `.md-table` 内横向滚动 | 同上 |
| 手机上会话删除按钮不可见 | 触摸环境没有 hover，删除操作无法发现，且只有 22×22 | `opacity: 0`，22×22 | 在 `(hover: none)` 或窄屏下常显，32×32，标题留出空间 | `before-mobile-drawer.png` → `after-mobile-drawer.png`、`mobile-session-delete.png` |
| 关闭的侧边栏仍可聚焦 | 窄屏下侧边栏仅移出屏幕，Tab 和读屏会进入看不见的控件 | 关闭时“新对话”等按钮仍为可见状态 | 关闭时 `visibility: hidden`（过渡结束后），打开时恢复 | `before-mobile-drawer.png` |
| 手机资料面板挤压阅读区 | 375×667 导入两份资料后聊天区只剩 240px | 聊天区 240px | 窄屏资料面板最大高度 24vh（面板内部滚动），聊天区 293px | `before-mobile-materials.png` → `after-mobile-materials.png`、`mobile-materials-composer.png` |

修复前已满足、本次补充回归的行为：来源弹窗的初始焦点、焦点约束、Escape 关闭和焦点恢复；块级公式和代码块在自身区域横向滚动；主要按钮使用浏览器默认焦点环。

实现见 [App](../src/ui/App.tsx) 和 [styles.css](../src/ui/styles.css)。

## 当前验证

| 检查 | 实际结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 47 项：45 通过，0 失败，2 项 todo（B 负责的既有阻塞标记） |
| `npm run build` | 通过；保留既有超过 500 kB 的 chunk 提示 |
| 完整 Playwright 开发套件 | 83/83 通过（含本文件 6 项） |
| 完整 Playwright 生产产物套件（`vite preview`） | 83/83 通过 |

## 后续改进

不阻塞使用，暂不修复：

- 搜索框与偏好输入框使用 `outline: none`，聚焦只靠边框和底色变化，对比度偏弱；可统一 `:focus-visible` 样式。
- 手机打开侧边栏后焦点仍留在“打开侧边栏”按钮，侧边栏不支持 Escape 关闭；键盘用户需要多次 Tab 才进入列表。
- 输入框字号 14px，iOS Safari 聚焦时可能自动缩放页面（Chromium 模拟无法复现，未验证）。
- 聊天区整体为 `aria-live="polite"`，流式生成时读屏可能逐段播报，后续可只播报终态。
- 窄屏隐藏了“Enter 发送 · Shift+Enter 换行”提示，token 额度提示在手机上占一行，可考虑收起。
- 来源弹窗内的长原文 `pre` 不可单独获得焦点；纯键盘滚动长原文未单独验证。
