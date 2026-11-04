# Issue #9 学习记录验收

对应 [Issue #9](https://github.com/dormitory604/cramameleon/issues/9)，范围为 A 负责的本机学习记录与界面，复用真实 PiAgentAdapter、Worker 和浏览器 IndexedDB。未改动 Agent、公共契约或服务端；未调用付费模型。

## 交付与修复

- 记录按用户归属和修改版本管理；旧用户异步结果不能更新新用户记录或保存状态。读取失败显示重试入口，成功前不覆盖已有记录；来源弹窗只在当前用户记录已载入时展示。
- 保存消息、题目/本地作答、资料文本和勾选、偏好、学习位置及当前学习会话；仅有偏好的学习会话也可恢复访问。正常退出等待最新快照提交，并在等待时禁用修改；保存失败先保留界面，用户明确选择“仍然退出（可能丢失修改）”后才尝试保留同用户恢复副本、请求 `/api/logout` 撤销应用会话并清空界面，允许其他用户进入。
- 刷新前同步写入用户隔离的恢复副本，IndexedDB 提交后清理；即使恢复副本清理失败，也不会把后续已提交记录回滚。读取成功、但恢复副本回写持续失败时，展示可读内容并明确提示“尚未保存”，允许重试、移除资料或删除对话。公共 `loadData` 在这一情形返回可选 `recoveryUnsaved: true`，保存和恢复副本均不持久化此元数据，v2 数据字段保持兼容。
- 恢复的未完成轮标为中断，重试保留原问题。实际 pagehide 在记录中断的同时通知 App 作废当前轮次并取消请求、清除忙碌状态；返回后可重试。事件、外层 catch 和 finally 都受轮次归属保护，旧轮迟到结果不能改写中断记录或新轮。
- 删除正在生成或解析的学习会话会取消其任务，清除消息、学习状态和资料范围；同页迟到结果与先前排队保存不能使记录复活。
- 原生 localStorage 配额耗尽或被禁用时，恢复副本失败本身不显示“保存失败”：界面状态只由 IndexedDB 写入结果决定，写入成功即显示“已保存”。仅当仍有未提交修改时，刷新才触发原生离开确认；没有未保存修改时不提示。取消导航不设置退出标记，因此后续编辑和保存继续工作。
- 恢复副本（localStorage 同步快照及记录中的 `checkpointId`）超出 #9 字面要求，属于 #9 评审时接受的崩溃恢复设计：IndexedDB 在页面卸载时可能来不及提交。代价是副本包含资料文本，大资料可能超过 localStorage 配额，此时仅失去这层保护（见上条）。
- v2 旧消息缺少学习会话 ID 时，在存储读取/恢复边界补为 `legacy`；重试会保留此前已完成问答，当前问题只发送一次，兼容缺少资料字段的旧记录。
- 存储阶段使用小型类型联合统一映射中文提示，读取失败、写入失败、恢复未保存等操作入口由阶段决定；不再用显示句子判断失败。浏览器测试的四处原生事务保活逻辑统一为共享控制对象，各测试继续明确控制释放/中止时机。

实现见 [useLocalRecords](../src/session/useLocalRecords.ts)、[appStore](../src/session/appStore.ts)、[App](../src/ui/App.tsx) 和 [Materials](../src/ui/Materials.tsx)。

## 当前验证

| 检查 | 实际结果 |
| --- | --- |
| `npm test` | 24/24 通过，包括保存后立即读取、读取事务中止后恢复两项新增存储回归 |
| `npm run build` | 通过；保留既有超过 500 kB 的 chunk 提示 |
| 完整 Playwright 开发套件 | 22/22 通过，22.1 秒 |
| 完整 Playwright 生产产物套件 | 22/22 通过，19.6 秒 |

浏览器验证为实际 UI → PiAgentAdapter → 可控模型响应；文件由真实 Worker 处理，存储为原生 IndexedDB。只在模型、HTTP 和存储边界控制错误/延迟，成功读写仍用真实事务。[records.spec.ts](../tests/e2e/records.spec.ts) 共 17 个场景，包含原有 14 项以及本次新增的持续回写失败恢复、明确选择退出与用户隔离、受控页面生命周期中断三项回归；原有 [聊天](../tests/e2e/chat.spec.ts) 与 [资料](../tests/e2e/materials.spec.ts) 5 项全部通过。[模块回归](../tests/session.test.ts) 验证公共 saveData/loadData 边界。

生命周期验证在真实 Chromium 页面派发 `PageTransitionEvent('pagehide'/'pageshow', { persisted: true })`，是确定性的受控生命周期边界测试，**不是实际导航返回的 BFCache 命中证明**。测试在模型传输边界延迟取消效果，分别释放旧成功响应（文字、学习状态工具调用、终态）和错误响应，验证中断状态保留、重试可用及新轮忙碌状态不被旧轮清除；最后刷新确认重试结果持久化。

独立检出目录的标准复现命令：

```sh
npm test
npm run build
npx playwright test
TEST_PRODUCTION=1 npx playwright test
```

本次端口 18086 被其他任务使用，所有浏览器命令均通过临时配置，把服务器、生产预览和 baseURL 统一为独占端口 18111（`--strictPort`）；仓库默认配置未修改。实际命令为 `npx playwright test --config /private/tmp/cramameleon-issue-9-fqcb1_vc/playwright.review-fixes.config.ts`，生产验证在同一命令前添加 `TEST_PRODUCTION=1`。临时工作树删除后仍可使用上面的标准命令；若需避开端口冲突，可在项目根目录创建临时 `playwright.port.config.ts`：

```ts
import original from './playwright.config.ts';
const url = 'http://127.0.0.1:18111';
export default {
  ...original,
  use: { ...original.use, baseURL: url },
  webServer: {
    command: process.env.TEST_PRODUCTION === '1'
      ? 'npx vite preview --host 127.0.0.1 --port 18111 --strictPort'
      : 'npm run dev -- --port 18111 --strictPort',
    url, reuseExistingServer: false,
  },
};
```

然后运行 `npx playwright test --config playwright.port.config.ts` 和 `TEST_PRODUCTION=1 npx playwright test --config playwright.port.config.ts`。本次完整验证日志保存在外部目录 `/private/tmp/cramameleon-issue-9-fqcb1_vc/`，前缀为 `review-fixes-final-`。

三项评审修复均有先红后绿证据：恢复回写失败时原先刷新后资料消失；持续保存失败时原先没有明确退出按钮、不会撤销应用会话；页面生命周期中断后原先仍显示“停止”、重试禁用。各用例修复后通过，并纳入开发与生产完整套件。此前原生配额与 legacy 历史问题的回归仍通过：取消刷新后保留最新偏好且可继续保存；旧版重试请求包含先前完整问答和一次当前问题。

## 边界与剩余限制

恢复副本是尽力保护；强制终止进程、系统关闭、浏览器不触发生命周期事件，或用户在原生确认中选择继续离开，仍可能丢失尚未提交的修改。应以最新版本的“已保存”状态判断是否已提交。取消原生离开确认已在 Chromium 实测，未声称覆盖所有浏览器的导航策略。

保存队列与删除保护覆盖当前页面；多个标签页同时编辑同一用户记录仍可能互相覆盖，尚无跨标签页冲突合并或删除墓碑。一笔永久挂起的原生事务也可能阻塞本页后续保存，界面保持未保存状态，不能视作已持久化。未进行真实模型教学质量重跑、跨设备同步或正式旧站授权验收。
