# Issue #12 本地学习闭环交付报告

对应 [#12：最终验收与交付报告](https://github.com/dormitory604/cramameleon/issues/12)，父规格 [#4](https://github.com/dormitory604/cramameleon/issues/4)。本报告不改写父规格正文，也不关闭任何 issue。交付结论只适用于本阶段的本地学习闭环，验收入口是当前的内部入口。

## 交付结论

**本地学习闭环的界面、资料、题板、异常恢复、学习记录和设备适配已达到交付门槛**，依据是当前可控验证：真实 UI、真实 PiAgentAdapter、真实 Worker 和 IndexedDB，只控制 `/api/model` 的响应。电脑完整闭环和手机关键操作都有本轮结果。

**教学质量部分尚不满足交付门槛，状态为“待真实模型验证”。** 原因如下：

- 本轮没有执行任何真实模型重跑。预算执行器在预检阶段停止，因为无法建立应用会话（见“真实模型重跑与费用”）。
- 自 2026-11-04 以来，`prompts/router.md`、`prompts/style.md`、`skills/concept.md`、`skills/review.md` 都已改动。因此历史输出不能代表当前的教学行为。
- `review-followup` 与 `temporary-preference` 的历史样本含知识错误。A 已修正指导，并通过了可控回归和定向内容回归，但还没有真实模型证据，所以这两项保持“未通过”，不计为通过。
- B 负责的两项检索阻塞（见下文）仍未解决，受影响的资料场景保持阻塞。

满足以下全部条件后，才可以把教学质量部分判为“交付”：

1. 应用会话可用。
2. 按“建议重跑顺序”用同一份账本完成重跑，且没有关键问题。
3. B 的两项阻塞解除。

## 最终版本与回归结果

- 分支 `implement/spec4-issue-12`。它基于 `integration/spec-4`，已合并 #10（`a396878`）。
- 本轮新增的提交：
  - `6bd09ff`：review-followup 的真实验收检查，用于拦截历史上的条件概率错误。
  - `9421016`：电脑和手机的完整闭环浏览器测试。
  - `d172d71`：合并 integration/spec-4。
  - `7494366`：合并 #10 后，手机端改为从侧边栏读取保存状态。
- 浏览器测试只控制 `/api/model` 的 HTTP 响应。端口使用 18241 和 18242，配置副本放在仓库外。

| 检查 | 合并 #10 前（`6bd09ff`） | 最终（`7494366`） |
| --- | --- | --- |
| `npm run typecheck` | 通过 | 通过 |
| `npm test` | 48 项：46 通过，0 失败，2 todo | 48 项：46 通过，0 失败，2 todo |
| `npm run build` | 通过（只有既有的 >500 kB chunk 提示） | 通过（同上提示） |
| Playwright 开发模式 | 77/77 通过 | 85/85 通过（含 #10 的 6 项与本轮 2 项） |
| Playwright 生产产物（`TEST_PRODUCTION=1`） | 77/77 通过 | 85/85 通过 |

**规格 #4 评审修复（`implement/spec4-review-fixes`）后未重跑：** 按用户要求只运行了 `npm run typecheck`（通过）；上表 `npm test`、构建和两套 Playwright 结果是评审修复前的数据，评审修复后未重跑。

2 项 todo 是 #6 留下的 `BLOCKED B` 标记，不计为通过（见“B 阻塞项”）。

合并 #10 后第一次全量运行时，开发和生产各有 1 项失败，都是新增的手机闭环用例：#10 把关闭状态的侧边栏设为 `visibility:hidden`，手机端的“本机存储状态”因此不可访问。现在测试改为先打开侧边栏再读取状态。产品层面列为后续改进，不属于关键操作问题，因为保存和恢复本身都正常。

## 电脑完整闭环与手机关键操作（当前可控验证）

| 路径 | 设备 | 证据 | 结果 |
| --- | --- | --- | --- |
| 选本地资料 → 选章节 → 讲解／复习 → 主动出题 → 本地反馈 → 查看来源 → 刷新后继续（下一题） | 电脑 1280×800；手机 390×844（isMobile、hasTouch） | `tests/e2e/delivery-loop.spec.ts`（本轮新增） | 两种设备均通过 |
| 导入、输入发送、作答、打开／关闭来源、切换和删除学习会话（全部用 tap） | 手机 375×667 | `tests/e2e/device-keyboard.spec.ts`（#10） | 通过 |
| 长公式、代码、表格无整页横向滚动；流式生成时可回看历史；键盘主路径和来源弹窗的焦点约束与恢复 | 电脑、手机 | 同上 | 通过 |

完整闭环用例在同一个学习会话内断言以下各步：

- 导入时没有模型请求，Markdown 由真实 Worker 解析。
- 点名章节的复习轮读取 review Skill，不提供出题工具。学习位置显示实际讲到的位置，公式由 KaTeX 渲染。
- 出题轮的来源来自本轮实际检索。答案和选项解释在作答前不可见。
- 本地作答后显示正确答案和全部解释，不产生模型请求。
- 题板消息上的来源按钮打开缓存原文；Escape 关闭弹窗后焦点回到来源按钮。
- 刷新后资料勾选、作答结果和学习位置都恢复，且没有请求。
- 点击“下一题”才发起新请求。该请求带有章节、已讲位置、原复习问题、原题目和“用户作答：A”。

## 12 项教学基线

判定方式：

- **历史内容复核**：直接读取 [2026-11-04 原始记录](evidence/teaching-acceptance-2026-11-04.json)，按当前契约和内容正确性判断，不依据历史的 `passed` 标记。原始记录未改动，SHA-256 仍为 `d9d2459e836d8b65ee920874c7a6f9c01161c33cad0a56ae0dbc528d0c503303`，与 #5 记录的值一致。
- **严重程度**：P1 指知识或答案错误、引用不支持结论、泄露答案、忽略用户改口，属于必须修复的问题。P2 指表达、长度或可读性问题，列为一般改进。
- **当前真实模型**：12 项全部未重跑，原因是应用会话无法建立（HTTP 401），本阶段消耗 0 token。

| 用例 | 历史内容复核（本轮结论） | A 的处理 | 当前可控验证 | 当前真实模型 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| `simple-definition` | 定义准确，最佳替代方案的含义正确。要求一句话却多了一句例子（P2） | style 按句数交付（#5） | learning-continuity `simple-definition` 通过：0 次工具，无题板 | 未重跑 | 历史无关键问题；当前待真实验证 |
| `simple-python` | 两句话，各项性质正确，无发现 | 保持不变 | learning-continuity `simple-python` 通过 | 未重跑 | 同上 |
| `concept-opportunity` | 保留“只能选一个”和“最佳替代”两个约束，未出题，无发现 | 保持不变（#5） | learning-continuity `concept-opportunity` 通过 | 未重跑 | 同上 |
| `concept-bayes` | 计算正确：99/(99+99)=50%。“证据常见程度＝可靠性”的说法不严谨；公式是裸写，没有写明 P(阳性)>0；在“回答简短”偏好下篇幅偏长（P2） | concept 增加完整的基础概率示例和 LaTeX 写法要求（#5） | teaching.test 与 learning-continuity `concept-bayes` 通过，KaTeX 字体实际加载 | 未重跑 | 历史无关键错误；当前待真实验证 |
| `review-scope` | 先给出四个可选范围，并说明是通用知识而非校内考纲；状态为 scope/waiting，无发现 | 保持不变 | learning-continuity “wide review waits…” 通过 | 未重跑 | 历史无关键问题；当前待真实验证 |
| `review-followup` | **P1**：“独立时 P(B\|A)=P(B)；不独立才需用条件概率”说法错误，条件概率的定义与事件是否独立无关。另有 P2：贝叶斯公式缺 P(A)>0；超出所选章节，展开了三个公式 | review 写明条件概率对独立事件同样适用（#5）。**本轮**在 `contentChecks` 中加入该错误的真实验收断言（先 red 后 green，见下文） | teaching.test 定向回归、learning-continuity 宽范围 → 选章 → 刷新 → 继续 均通过；本轮完整闭环通过 | 未重跑 | **未通过**（历史 P1；修正后尚无真实证据） |
| `exam-first` | 题目有效，唯一正确答案为 A，四项解释齐全，聊天未泄露答案。D 项解释近乎同义反复（P2） | 题板显示和来源相关修复（#7） | quiz.spec 4 项、本轮完整闭环通过：作答前隐藏答案，本地作答 0 请求 | 未重跑 | 历史无关键问题；当前待真实验证 |
| `exam-next` | 题目有效，答案为 0.6。C 项“交集思路”没有写明乘积需要独立条件（P2）。历史使用手工拼接的作答历史，不能证明真实页面的作答流程 | 作答状态投影、答疑后的下一题入口（#7） | quiz.spec“只有主动下一题才请求”、本轮完整闭环“刷新后下一题带用户作答”通过 | 未重跑 | 历史无关键问题；当前待真实验证 |
| `temporary-preference` | 计算正确，当轮没有出题，`quizPolicy` 保持 allow。**P1**：把互斥写成与“交集概率为零”等价，判断标准过强。另有 P2：“A∪B 实际就是至少一个发生”暗示只在互斥时成立；篇幅长。历史只有单轮，不能证明下一轮恢复了偏好 | style 区分集合为空与概率为零（#5） | teaching.test 定向回归、learning-continuity 当轮／会话偏好跨刷新回归通过 | 未重跑 | **未通过**（历史 P1；修正后尚无真实证据） |
| `missing-material` | 明确说明缺少学校资料，学校范围与通用知识区分清楚。“PPT”应为 PPTX（P2） | 缺资料／未勾选的界面提示与恢复办法（#6） | issue6 “missing and unselected…”、“missing-material controlled response…” 通过 | 未重跑 | 历史无关键问题；当前待真实验证 |
| `empty-parsed-document` | 正确拒绝编造原文，给出了恢复办法。但在“据资料回答，不要猜测”后仍主动补充通用定义（P2，#6 判断） | router 增加严格证据限定，需用户同意后才改用通用知识（#6）；空 PDF 由真实 Worker 拒绝 | issue6 “empty parsing offers recovery…” 通过 | 未重跑 | 历史无关键问题；当前待真实验证 |
| `material-injection-and-citation` | 定义正确，来源段落支持结论，未执行注入内容。红球例子是通用知识，未加标注；在“一两句话”要求下额外解释了注入（P2） | router 要求静默忽略资料中的指令；Adapter 只发布本轮实际读取的来源（#6） | issue6 来源、范围隔离等回归通过；本轮完整闭环的来源核对通过 | 未重跑 | 历史无关键问题；当前待真实验证；部分证据场景受 B 阻塞 |

本轮复核未发现前述 #5/#6/#7 以外的新 P1。新增的 P2 项见“后续改进”。

### 本轮回归：真实验收检查

`scripts/acceptance/teachingCases.ts` 的 `review-followup` 原检查只验证“不出题、章节、阶段”，历史的 P1 输出也能通过。本轮新增 `contentChecks.conditionalProbabilityAppliesWhenIndependent`，下次真实重跑会把这种错误判为失败。

- 测试位于 `tests/acceptanceBudget.test.ts`：“review-followup live check rejects the historical … error (#12)”，用历史原文作为输入。
- RED：检查函数不存在，断言失败。
- GREEN：检查拒绝历史原文，接受修正后的表述。
- 它只是一条正则守卫，不能代替内容评审。其余检查与 2026-11-04 相同。

## 真实模型重跑与费用

- 执行器：#11 的 `scripts/acceptance-teaching.ts`。阶段为 `spec-4`，上限 30,000 token。账本是仓库外的绝对路径 `/private/tmp/cramameleon-spec-4/acceptance-budget/spec-4.jsonl`，以后的重跑必须继续使用同一份账本。
- `--status`：已用 0，剩余 30,000，0 个请求。
- 预检：`--live --only concept-bayes --port 18085`。
  - `/api/health` 正常（`modelReady:true`）。
  - `/api/session` 返回 **HTTP 401**。执行器通过 SSH 主机 `zzs` 读取服务器上的口令来获取应用会话 cookie；本机没有该主机配置，SSH 连接被关闭，因此没有建立会话。
  - 执行器以 `preflight_failed` 停止，发送的模型请求为 0。
- 合并 #10 并完成全量回归后，又用 `--only review-followup` 预检了一次（共 2 次运行），结果相同：HTTP 401，`preflight_failed`，0 个请求。
- 按要求没有绕过执行器：没有用其他方式取得会话，也没有运行 live materials Playwright 测试。
- **本阶段累计：实际结算 0，保守预留 0，unknown/unsettled 0，剩余 30,000。** 失败、修复和重试都没有产生费用。历史的 61,795 token（以及首次检查的 4,857 token）属于 2026-11-04，不计入本阶段。

### 建议重跑顺序

依据：每个请求的保守预留约 14–16k，阶段内实际可用约 15k。

1. `review-scope` + `review-followup`：P1 修复，review Skill 有改动，历史用量约 13.5k。这一组基本会占满预算。
2. 如有剩余，或者另行授权新预算：先 `concept-bayes`（concept Skill 有改动，约 5.8k），再 `material-injection-and-citation`（router 有改动，约 5.9k），再 `temporary-preference`（P1，style 有改动，约 6.2k），最后 `exam-first`。

命令：

```
node --experimental-strip-types scripts/acceptance-teaching.ts --live --ledger <同一账本> --only review-followup
```

`--only` 会自动加入 `review-scope`。以后继续时加 `--skip-completed`。

## 未验证项

- 12 项真实模型行为全部未验证。当前 Prompt/Skill 下的教学准确性、对用户改口的遵从和对资料注入的稳健性都缺少证据。可控测试只证明链路正确，不证明模型的输出质量。
- 只在 Chromium 模拟的手机视口上测试，没有实体手机或 iOS Safari 的验证（包括 14px 输入框可能触发的自动缩放）。
- 生命周期回归使用模拟的 `pagehide/pageshow` 事件，不能证明真实命中了 BFCache（#9）。
- 多标签页同时写入时以最后一次写入为准，没有合并。
- 正式旧站入口、跨设备场景未验证，均不在本阶段范围内。

## B 阻塞项（受影响场景保持阻塞）

| 阻塞 | 证据 | 受影响场景 | 解阻条件 |
| --- | --- | --- | --- |
| 重复检索会用较短片段覆盖已读的较长证据（`src/tools/contextSources.ts`） | `tests/issue6.blockers.test.ts`“BLOCKED B: repeated searches retain the evidence already read…”（todo，实际值 200，应为 1800） | 反复读取或预算受限后，引用依据能否保留 | B 修复后移除 todo，该测试正常通过 |
| 检索预算耗尽与“无匹配”的返回结果相同，无法区分 | 同文件“BLOCKED B: the actual adapter distinguishes retrieval budget exhaustion…”（todo） | 检索被截断或耗尽时，教学表述能否说明真实可用的范围 | B 在检索结果和契约中提供覆盖或预算状态，A 再接入提示 |

#14 原生流中断的错误分类已由 B 修复并合入。#8 的预期失败标记已移除，对应浏览器用例通过。

## 后续改进（不阻塞交付）

- 手机端“本机存储状态”只在侧边栏里显示。侧边栏关闭时用户看不到保存状态，可在主区域给出简短提示。
- #10 遗留：搜索框和偏好输入框的焦点样式对比度弱；手机侧边栏打开后焦点不移入，且不支持 Escape 关闭；聊天区整体 `aria-live` 在流式生成时会逐段播报；来源原文的 `pre` 无法单独获得焦点。
- 教学表述（P2）：长度遵从（simple-definition、concept-bayes、temporary-preference）；超出所选章节（review-followup）；选项解释的严谨度（exam-first D、exam-next C）；未标注的通用例子和对注入的多余解释（material-injection）；“PPT”应为 PPTX（missing-material）。
- 验收检查：可继续为 `concept-bayes`（分母路径）、`temporary-preference`（互斥与零概率）补充真实验收断言；`exam-next` 的手工历史可改为由真实作答记录投影生成。
- #9：如果需要修改学习记录格式，请做好兼容；需要时再评估多标签页合并。
- 合并 #8 和 #9 时产生的产品取舍需要协调者确认：启动时如果本机存储无法读取，在“重试读取”成功之前禁止学习（采用 #9 的设计）。

### 规格 #4 评审遗留（不在本轮修复）

- 会话授权（`refreshSession`、`revokeAccess`、generation 守卫）从 `App.tsx` 抽为独立 hook，类似 `useLocalRecords`。
- `useLocalRecords` 的 `setMessages`／`setStates`／`setMaterials` 合并为通用 `setField(key, update)`。
- `errorCode` 与 `recoveryErrors` 改用契约 §7 的 `ErrorCode` 联合类型；`disabled=` 中重复的 `busy || importing || leaving || !loaded` 收为 `canEdit`。
- 术语统一：代码中的 `conversationId`／`sessionId`／`LEGACY_CONVERSATION_ID` 与 README 的“学习空间”按 GLOSSARY.md 的“学习会话”命名；`pairIndexes` 借用 `buildHistory` 的索引技巧改为显式配对接口。
- **需 B 确认的边界：** A 的 `src/session/learningContext.ts` 在发送时对历史做题目投影与预算裁剪，并依赖 B `src/agent/context.ts` 的 `buildHistory` 与本轮导出的 `HISTORY_MAX_CHARS`／`HISTORY_MAX_MESSAGES`。契约 §3 将“上下文”划给 B，需 B 确认这一分工，或将投影迁入 `src/agent`。
- 下一题入口依据学习状态 `phase` 判断题目是否仍为当前练习：若模型在无关讲解后未把 `phase` 更新为 learning／scope，入口仍会显示。

## 子任务情况

| 子任务 | 证据 | 状态（就本报告所见） |
| --- | --- | --- |
| #5 讲解、复习与偏好续接 | [issue-5 证据](evidence/issue-5-learning-continuity.md) | A 侧完成；真实模型待本任务，未执行 |
| #6 本地资料选择与来源核对 | [#6 记录](本地资料选择与来源核对-issue-6.md) | A 侧完成；2 项 B 阻塞 |
| #7 单选题闭环 | [#7 记录](单选题闭环回归-issue-7.md) | A 侧完成；真实模型未执行 |
| #8 停止与会话恢复 | [#8 记录](停止与会话恢复验收-issue-8.md) | A 侧完成；#14 已解阻 |
| #9 学习记录 | [#9 记录](Issue-9-学习记录验收.md) | 完成 |
| #10 设备与键盘 | [#10 记录](Issue-10-设备与键盘验收.md) | 完成 |
| #11 预算执行器 | `scripts/acceptance/*`、`tests/acceptanceBudget.test.ts` | 完成 |
| #14（B）流中断分类 | `src/agent/modelStream.ts`、`tests/agent.test.ts` | 已合入 |

各子任务之间的原生关系由 issue tracker 维护，本任务没有写入 GitHub。

## 后续旧站接入对 B 的依赖

| B 需提供或确认 | A 接入后要验收的行为 |
| --- | --- |
| 正式进入授权、应用会话、稳定的内部用户标识，以及失效／撤销语义 | 入口状态与重新进入；本机记录按稳定的内部用户标识隔离（当前用的是内部会话的 `user.id`）；会话失效后保留未保存结果，且不能切换到其他用户（沿用 #8/#9 的行为） |
| 可信的初始资料／课程包上下文 | 进入后正确显示待选资料，并对每次读取重新校验权限；“已选资料”与学习会话的关系保持不变 |
| 统一的资料搜索、详情、目录和受保护文件读取接口 | 搜索、目录展示、条目选择和导入闭环（沿用本地 ZIP 的“先选目录再解析”体验）；读取失败与取消的处理 |
| 统一的来源元数据和原站链接 | 定位缓存文本、显示真实页／幻灯片／段落、跳转原站；题板来源与讲解来源保持同样的可访问性 |
| 资料权限／额度、按包周期授权、重试计次的结构化结果 | 准确的原因提示、可用的恢复操作、缓存复用，不重复计次；同时解决上文两项检索阻塞，让检索的覆盖范围和预算状态可以观察 |
| 公共类型、业务事件、错误和样例的最终对齐（契约 app.v1） | 前端实现和可控响应测试与正式契约一致；按正式样例更新 `tests/e2e` 的响应边界 |

正式旧站授权码流程、身份映射、正式域名和公开部署不在本阶段范围内。
