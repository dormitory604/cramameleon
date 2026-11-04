# #5 讲解、章节复习与偏好续接：当前证据

本报告仅覆盖 #5 的七个历史基线及对应浏览器回归，不代表父规格 #4 或其他子任务完成。实施基线为 `73cd696defd170b5bc0de02bccf29e45365130cb`。历史记录仍保留原先的通过标记；下列复核依据当前正确性要求，独立于旧标记。

## 证据边界

- **历史内容复核**：直接完整读取 [原始 JSON](teaching-acceptance-2026-11-04.json) 的输入、输出、工具、状态与终态，并读取 [原始验收说明](../Agent教学执行验收-2026-11-04.md)。已对照父 Agent 提供的七例审计，下面的结论均可在原始记录中核对。
- **当前可控验证**：真实浏览器操作 → 生产 UI → 实际 PiAgentAdapter / Pi 循环 → 实际 `read_skill`、`update_learning_state` → 可控 HTTP SSE 模型边界；保存、刷新及恢复使用真实浏览器 IndexedDB。没有注入伪造业务事件，也没有修改 Agent 或工具调度来适配测试。
- **当前真实模型**：七例全部未重跑，统一交 #12 按预算验收；本任务付费调用 0 次，消耗 0 token。

可控测试证明输入、历史、状态和教学内容传递，工具权限、事件处理、界面渲染与本机恢复正常；受控文本由测试提供，**不能证明真实模型会遵守指令，也不能证明未来教学输出的准确性或教学质量**。教学内容断言只守住已知关键关系与必要条件，不使用完整回答快照。

严重程度：P1 为样本中的事实或关键行为错误，需修正 A 的教学指导并留下回归；P2 为表达、可读性或长度遵从问题；无发现表示本次范围内未发现内容错误。表中“已修正”指已发布的 A-owned 指导或 UI，真实模型表现仍待 #12。

## 七例逐项复核

下表的测试位于 [浏览器回归](../../tests/e2e/learning-continuity.spec.ts) 和 [教学内容定向回归](../../tests/teaching.test.ts)。

| 基线 ID | 历史内容结论与严重程度 | A 的处理结果 | 当前可控验证 | 当前真实模型 |
| --- | --- | --- | --- | --- |
| `simple-definition` | 最佳被放弃替代方案的定义和例子正确；要求一句话却另加例子句，P2 长度遵从。 | style 明确一句话／两句话按句数交付，不追加例子、收尾。 | `simple-definition: direct controlled answer without teaching tools` 通过：原句进入当前请求、简洁定义呈现、0 次工具、无题板或无关学习位置；确认新句数指导进入运行时提示。 | 未重跑，交 #12。 |
| `simple-python` | 有序、可变、从 0 索引、可混合类型、两句话均正确，无发现。 | 保留简单问题直接回答规则。 | `simple-python: direct controlled answer without teaching tools` 通过：关键性质、内联代码可见，0 次工具，无无关位置。 | 未重跑，交 #12。 |
| `concept-opportunity` | 一天只能选一个方案的约束明确；听讲座放弃最佳替代收益 200 元，不把多个替代收益相加；未出题，位置不冒称掌握，无发现。 | 保留 concept 的时间约束、最佳可行替代与不相加示例。 | `concept-opportunity: necessary example constraint and best alternative reach the browser` 通过：真实读取 concept，模型边界收到关键约束；受控输出的 200 元、只能选一个与不相加可见，不出题，实际活动写入位置。 | 未重跑，交 #12。 |
| `concept-bayes` | **原计算正确**：10000 人中 100 名患者→99 真阳性，9900 名健康者→99 误报，99/(99+99)=50%，不是灵敏度 99%。将证据常见程度笼统称为“可靠性”不严谨；裸公式缺少可读定界与显式正分母条件，P2。 | concept 增加完整贝叶斯示例，标明先验、灵敏度、误报率和事件；两条完整互斥分母路径、P(阳性)>0、99/198=50% 和 LaTeX 定界。 | `concept publishes a worked Bayes base-rate example with both positive paths`、`concept-bayes: published conditions and controlled base-rate arithmetic render as math` 通过：读取发布内容，独立核对人数／分母／结果；公式渲染无 KaTeX 错误且字体实际加载。 | 未重跑，交 #12。 |
| `review-scope` | 四个选项、通用知识而非校内考纲说明、空 chapter、scope 状态和 waiting 终态正确；未先展开课程，无发现。 | 保留先选范围再讲解规则。修复位置条命名，避免用进度暗示掌握。 | `wide review waits for a choice, then continues from the actual saved location` 通过：等待选择、无继续按钮；刷新仍等待且零新增请求；scope 下“继续”的当前请求仍带 scope，受控模型重申等待；选择后才进入条件概率。 | 未重跑，交 #12。 |
| `review-followup` | 3/6 而非 3/10 的分母关系正确；“不独立才需用条件概率”错误，P1；裸公式与 Unicode 下标可读性 P2。 | review 明确条件概率对独立与否均适用，前提 P(B)>0；给出 P(A∩B)=P(A)P(B) 与正分母下 P(A\|B)=P(A)，以及独立硬币例子；公式全部定界。 | 定向 `review teaches conditional probability for independent events too, with readable conditions` 通过；浏览器宽范围→已选章→刷新→继续路径通过，真实 Skill 内容到达模型，旧讲解和实际位置进入继续请求，独立性公式可读；不出题，不称掌握。已点名章在 1280 / 390 宽度直接进入讲解。 | 未重跑，交 #12。 |
| `temporary-preference` | 骰子算术正确：1 或 2 为 1/3；偶数或大于 3 为 3/6+3/6−2/6=4/6。当轮未出题且保留 quizPolicy=allow、instructions=[]；原记录只有此轮，**未证明下一轮恢复**。互斥与零概率交集被写成等价，末尾同时发生的判断也过强，P1；直接讲清却展开多节，P2。 | style 区分“交集为空⇒交集概率为零”与错误逆命题，给出一般加法公式和连续分布反例；简单骰子解释保持简短。保留既有偏好作用域，不新增 UI 偏好解析器。 | 定向 `base guidance distinguishes disjoint events from zero-probability overlap` 通过；浏览器 `one-turn preferences expire after reload while session preferences persist and remain editable` 通过：持久详细偏好不被“这次简单点”覆盖，当轮禁题，下轮刷新后恢复 allow；后续“以后别出题”跨刷新保留 avoid；新学习会话隔离。当前请求含修正后的零概率指导。 | 未重跑，交 #12。 |

## UI 与完整路径

[src/ui/App.tsx](../../src/ui/App.tsx) 将实际位置条的可访问名称改为“学习位置”，并在只有 chapter 时也显示。没有重写历史位置或推断用户已掌握内容；本机数据格式和既有记录保持兼容。

新增 14 项浏览器测试覆盖七例和相邻交互，既有 5 项浏览器测试继续通过。其中：

- `chapter-only learning location is visible and restored without claiming mastery`：通过真实状态工具得到仅 chapter 的位置，刷新后仍可见。
- 宽范围等待→选择→实际位置→刷新→继续：继续请求带原章节、真实已讲位置、有效历史和不出题偏好；展示新的已讲位置，无掌握声明。
- 已点名章节在桌面 1280×800、手机 390×844 直接进入内容，无等待目录；位置条位于视口范围内，公式及字体可用。
- 五项 `latest request reaches the current turn` 分别验证“简单点、直接给答案、别出题、跳过、换章节”原句成为最新用户输入，保留此前上下文，受控响应呈现相应内容／章节／实际位置；明确不出题时题板工具不可用。该组不声称真实模型一定遵从这些请求。
- 会话偏好、当轮要求、后续恢复和新学习会话隔离均从 UI 建立，并通过刷新后的 UI 与下一轮模型请求验证。

## Red / green 与完成检查

过程记录另存于工作树外的 `implementation-notes.md`，未提交临时日志。

| 命令 | 实际结果 |
| --- | --- |
| `npm run test:e2e -- tests/e2e/learning-continuity.spec.ts`（首个位置用例） | RED：1 失败，找不到“学习位置”；修复可见条件与名称后 GREEN：1 通过。 |
| `npm test -- --test-name-pattern='review teaches conditional probability'` | RED：Node 因过滤参数放在文件名后运行全部 23 项；22 通过，新 review 内容用例 1 失败。随后改用正确参数顺序。 |
| `npm run pretest && node --experimental-strip-types --test --test-name-pattern='review teaches conditional probability' tests/teaching.test.ts` | GREEN：1 通过。 |
| `node --experimental-strip-types --test --test-name-pattern='concept publishes a worked Bayes' tests/teaching.test.ts` | RED：1 失败（缺少贝叶斯示例）；更新后加 `npm run pretest &&` 重跑，GREEN：1 通过。 |
| `node --experimental-strip-types --test --test-name-pattern='base guidance distinguishes disjoint' tests/teaching.test.ts` | RED：1 失败（缺少区分指导）；更新后加 `npm run pretest &&` 重跑，GREEN：1 通过。 |
| `TEST_PRODUCTION=1 npm run test:e2e -- tests/e2e/learning-continuity.spec.ts` | 14 通过，真实浏览器／真实适配器／受控 SSE。 |
| `npm test`（完成检查） | 全部 25 通过。 |
| `npm run typecheck` | 通过。 |
| `npm run build` | 通过；prebuild 通过项目脚本重建 teachingContent 和 PDF 资源。存在 >500 kB 产物提示，不阻塞构建。 |
| `TEST_PRODUCTION=1 npm run test:e2e`（完整浏览器检查） | 全部 19 通过，包含既有聊天和真实 Worker 资料解析回归；无付费／live 测试。 |

开发服务器在此 worktree 下因预置的外部 node_modules 符号链接阻止部分 KaTeX 字体路径。使用仓库现有的 `TEST_PRODUCTION=1` 预览配置验证正式构建资产，桌面、手机及贝叶斯测试显式等待实际字体加载；没有放宽测试或改动生产配置。Playwright 管理的服务器随命令退出。

## 评审修复：最新保存完成信号

针对评审发现的固定等待与旧保存标签问题，UI 现在通过消息、学习状态、资料的引用判断当前数据是否等于已完成写入的快照；写入调用时捕获快照，写入期间的新修改保持待保存并触发后续保存。读取完成时将已加载快照标记为已保存，不在每次渲染时序列化资料内容，原有保存失败提示保留。可访问的“本机存储状态”在数据变更后显示“正在保存到当前浏览器”，仅在当前快照写入成功后显示“已保存到当前浏览器”。`reloadSaved` 等待该公开完成信号后刷新，已移除固定延时。

评审修复另增 `storage status tracks the latest edit before reload and deletion`：只观察公开状态文字的变化，通过真实 IndexedDB 验证连续偏好编辑与删除后的刷新结果。加入公开状态名称后、修复保存逻辑前，`TEST_PRODUCTION=1 npm run test:e2e -- tests/e2e/learning-continuity.spec.ts -g 'storage status tracks'` 为 RED：仅观察到旧保存标签，未出现保存中状态。修复后 `TEST_PRODUCTION=1 npm run test:e2e -- tests/e2e/learning-continuity.spec.ts` 全部 15 通过，`npm test` 全部 25 通过，`npm run typecheck`、`npm run build` 通过，`TEST_PRODUCTION=1 npm run test:e2e` 全部 20 通过。构建仍有既有的 >500 kB 产物提示。未运行付费／live 测试，本任务仍为 0 次付费调用、0 live token；上述历史内容结论与真实模型验证边界保持不变。

## 所有权与历史保留

没有修改 `src/agent`、`src/contracts`、服务端或 B-owned 工具实现；`src/tools/teachingContent.generated.ts` 仅通过 npm 脚本从 A-owned Markdown 生成并一致提交。本次已验证路径未发现需要 B 修改才能完成的具体阻塞。真实模型是否遵从新内容仍待 #12，不能记为本次通过。

原始 JSON 和原始验收说明已与实施基线按字节比较一致，SHA-256：

- `docs/evidence/teaching-acceptance-2026-11-04.json`：`d9d2459e836d8b65ee920874c7a6f9c01161c33cad0a56ae0dbc528d0c503303`
- `docs/Agent教学执行验收-2026-11-04.md`：`f7fa7481200bfc5f9f01ac7428a5ed9f5bdbc6ffe443d2dc8c6bf3839f912869`
