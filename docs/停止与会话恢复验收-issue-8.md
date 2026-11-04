# #8 停止、重试与应用会话恢复验收

范围：仅 #8，父规格 #4 提供验收规则。初始基线 `73cd696defd170b5bc0de02bccf29e45365130cb`；本次评审修复从集成提交 `daf9934b880a867c979584da698fdd0e01f5b28e` 继续。**A 的评审修复已完成。** 更新：B 的 [#14](https://github.com/dormitory604/cramameleon/issues/14) 分类修复（`6e0a83a`）已合入集成分支，`f4cf0a1` 移除了下文所述的 `test.fail` 标记，#8 不再受 #14 阻塞；下文“B 阻塞 #14”一节保留为当时的记录。

## 最终行为与证据

测试边界沿用已批准的真实浏览器 UI → 真实 PiAgentAdapter / Pi Core / 工具 → 可控 HTTP fetch / SSE 响应，使用真实 IndexedDB。存储故障只在浏览器存储 API 边界注入；没有替换 AgentRunner 或派发伪业务事件。已有资料场景使用真实 Worker。

| 验收项 | 行为与证据范围 |
| --- | --- |
| 停止与迟到事件 | 立即断开活动轮次再 abort，保留部分结果并释放输入；旧流不结束也可发下一问，迟到输出不污染两轮，刷新后保留停止状态。本次定向回归通过 |
| 同用户失效恢复、写入失败 | 先成功保存，再注入写入失败；失效后同用户授权仍恢复访问，当前部分结果与失败终态保留，明确显示未保存与刷新风险，恢复存储后可重试。本次通过 |
| 初始存储不可用 | 读取失败后仍给内存记录绑定原用户；同用户可恢复访问并看到风险提示，不因重新进入重载并丢失内存结果。未成功读取前不写回，避免覆盖未知旧数据。本次通过 |
| 身份隔离 | 上述两种存储故障下，另一身份授权成功也不能越过原用户保存失败：保留原记录、留在入口、提示暂不能切换，再以原用户进入可恢复结果。本次通过；正常存储下的切换与过期响应隔离属于早先提交证据 |
| 模型就绪恢复 | 未配置禁用业务请求，提示联系维护者并提供“重新检查模型状态”。按钮只 GET /api/session；未就绪继续禁用，401 返回入口，同用户重新进入并检查就绪后再重试一次原问题，没有新增用户消息或重复历史。本次通过；请求继续复用原有 generation / 身份校验，拒绝过期响应 |
| 题板、来源、重试与错误 | 题板/来源在停止与超时后保留，replyTo 重试关联、完成历史去重、输出上限、结构化错误提示、HTTP/SSE AUTH_REQUIRED、轮后 401、手机恢复等，已有早先提交的浏览器证据。本次未重跑这些完整回归 |
| B 原生流异常分类 | 可见文字后的 controller.error(new TypeError(...)) 显示网络失败，而非要求的传输中断提示；本次浏览器预期失败，保持阻塞，详见下节 |

自动保存和显式 flush 共用一处快照写入；调用方保留各自的失败处理。同用户授权不以保存成功为前提，风险提示独立于会被新请求清除的一般通知。停止与访问失效共用 detach/abort，先清除活动轮次，再取消请求，分别设置 cancelled / failed。测试口令进入步骤共用 enterWithToken。

初始读取失败后，本次不增加存储重读、合并或自动重试机制；记录仅留在当前页面，风险提示持续可见。写入失败但读取已成功时，后续正常保存成功会清除警告。更广的存储恢复设计属于 #9。

## B 阻塞 #14（已解除，历史记录）

复现：实际 UI 发送问题，真实 PiAgentAdapter 消费受控 HTTP ReadableStream，先发 start 与 text_delta，等待文字已显示，再调用 controller.error(new TypeError('simulated connection reset'))。已有独立真实 Adapter 探针原始失败日志在任务目录 `b-stream-error-repro.log`，本次未重复该模块探针。

精确原因：B 所有的 `src/agent/modelStream.ts:78` 中 reader.read() 拒绝后进入 `:91` 的 catch，非 AppError 一律包装为 NETWORK_ERROR；只有正常 EOF 且缺少 finish 时，`:85` 才产生 MODEL_STREAM_INTERRUPTED。真实 Adapter 已输出 text_delta，随后却发出 NETWORK_ERROR / done failed。A 界面据实显示“网络连接失败，请检查网络或 SSH 转发后重试。”，要求则为“回答传输中断，已保留收到的内容。请重试。”。

`tests/e2e/recovery.spec.ts` 的 “B #14 native stream error after visible output requires interruption guidance” 在确认真实部分内容、失败状态和重试可用后，才对要求的中断提示使用带 #14 原因的 test.fail。它没有伪造错误事件或用 UI 猜测分类，B 的 Agent / transport / contracts / server 均未修改。

解阻条件：B 修正原生 reader 错误的分类，使可见输出后的中断通过真实 Adapter 得到 MODEL_STREAM_INTERRUPTED，保留初始网络失败与取消语义；随后移除 test.fail 并确认该浏览器断言正常通过。现有 clean EOF、显式结构化中断错误的早先通过不能代替此路径。#8 blocked by #14 的原生依赖已由协调者记录，本实现未修改 tracker。

## TDD 与最终定向验证

存储 red 已由前一过程确认，任务目录 `review-fix-red-storage.log` 有两项实际失败：写失败使重新进入后无输入框；初始不可用时缺少明确的未保存风险 alert。本次保留测试、补上跨用户隔离断言，不重复 red。

就绪恢复 red：缺少“重新检查模型状态”指导，1 项失败，见 `review-fix-red-readiness.log`；随后加入显式检查与指导并通过。首次启动命令在进入测试前超时且无用例结果；端口曾被相邻任务使用，清理本工作树遗留进程后，使用仓库外 `review-fix-playwright.config.mjs` 改到 18108。未改仓库 Playwright 配置或其他工作树。

最终只运行以下检查，日志均在仓库外任务目录，使用 review-fix-* 前缀：

```sh
node node_modules/@playwright/test/cli.js test --config ../review-fix-playwright.config.mjs recovery.spec.ts --grep 'same-user expiry recovery preserves unsaved results|model readiness recovery|B #14 native stream error|stop preserves partial output and releases'
npm run typecheck
```

- 浏览器：5 项被执行，**4 项实际通过、1 项 #14 预期失败、0 项意外失败**，8.8 秒；`review-fix-targeted-browser.log` 保存实际/要求的 UI 提示与预期失败，`review-fix-b-stream-error-context.md` 保存原始断言失败、页面快照与测试源码。该 Playwright 版本末尾显示 “5 passed”，包含了预期失败；本报告只计 4 项验收通过。
- TypeScript：通过，`review-fix-typecheck.log`。
- 本次没有重新安装依赖，没有运行完整模块测试、完整浏览器测试、生产浏览器或生产构建。既有 chat.spec.ts 的未配置提示断言已对齐新指导与检查按钮，未额外执行该用例。

## 早先版本与边界

以下属于 `99f0968c64b6228897324b68f624ee1f00960e0f`（集成为 daf9934）的证据，**不作为最终评审修复已运行全套的证明**：npm test 22/22 模块通过；npm run build（含 TypeScript）通过；开发浏览器 24/24、生产浏览器 24/24 通过。原始日志及初始 red/green 在任务目录 implementation-report.md 及其引用日志中。本次新增 4 个浏览器用例，但未重新运行整套，也不推算整套通过数。

本次没有真实付费模型请求，消耗 0 token；正式旧站授权、真实模型教学补测以及其他 #4 子任务不在范围内。历史教学验收材料保持不变。任务目录 review-fix-report.md 记录最终提交、合并、命令与未解阻项。
