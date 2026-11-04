# Cramameleon

B 分支已将固定脚本 Demo 替换为真实 DeepSeek 模型代理。React UI → 浏览器 Pi Core → Go 单次模型代理；工具仍在浏览器执行，Go 不运行 Agent 循环。

当前可用：内部访问口令、持久应用会话、多对话、教学 Skill 与学习进度、真实模型问答、资料改编题及本地反馈、SQLite 预算，以及本地文件导入、解析、选择、检索和引用闭环。模型未配置时禁用发送，仍可导入与查看本地资料。

## 配置和运行

要求 Node >=22.19、Go >=1.22。复制 `.env.internal.example` 为 `.env.internal`，填写：

- `APP_ALLOW_GUEST`：设为 `1` 时直接进入聊天。默认 `0`，通过聊天输入区的内部口令表单验证。
- `APP_ACCESS_TOKEN`：内部模式使用的随机访问口令，至少 24 字符。
- `DEEPSEEK_API_KEY`：真实密钥，仅存在服务器环境文件。
- `DEEPSEEK_MODEL`：默认 `deepseek-flash`，是服务端唯一允许的模型。
- `APP_DAILY_TOKEN_BUDGET`：默认 1,000,000，按北京时间自然日计算全局输入+输出 token。
- `APP_MAX_OUTPUT_TOKENS`：默认 2048；`APP_MAX_INPUT_BYTES`：默认 64000。

内部访问口令与真实 API 密钥在目标服务器 `.env.internal` 中配置，修改后重启内测服务。本地环境文件不代表服务器当前配置。环境文件和 SQLite 不提交 Git。不得在前端设置 VITE 模型密钥。

```sh
npm ci --no-audit --no-fund
npm test
npm run build
cd server
GOMAXPROCS=1 GOMEMLIMIT=256MiB go test ./...
GOMAXPROCS=1 GOMEMLIMIT=256MiB go build -p 1 -o bin/cramameleon .
cd ..
sh scripts/internal.sh start
```

Go 服务使用 `APP_ENV=internal` 并监听 loopback。访客模式可经同机反向代理开放，代理需保留 Host，并写入可信的 X-Forwarded-For。访客记录保存在当前浏览器的独立记录区。内部模式的应用会话有效 8 小时，SQLite 保存 token 哈希。更改开发者 ID 后旧身份会话失效，本地记录按新身份隔离。

服务器路径为 `/home/ubuntu/cramameleon`。通过 SSH 转发访问：
```sh
ssh -N -L 127.0.0.1:18085:127.0.0.1:18085 zzs
```
打开 http://127.0.0.1:18085 。内部模式下需输入环境文件中的访问口令。更改密钥或预算后：
```sh
sh scripts/internal.sh stop
sh scripts/internal.sh start
```

此次服务器交付使用 `APP_STATIC_DIR=var/app-dist`，保留旧 `dist` 与旧 Demo 二进制以便回退；后续本机构建需把 dist 同步至这个配置目录，或调整 APP_STATIC_DIR。进程日志在 `var/log/internal.log`。脚本校验 PID 对应二进制后才停止进程。尚未配置 systemd，重启主机后需手动启动。

### 线上自动部署

线上部署跟随 `main`。每次推送后，GitHub Actions 用仓库的短期只读令牌触发腾讯云上的 `~/.local/bin/cramameleon-deploy-main`。服务器拉取 `main`，在独立目录构建，通过健康检查后保留新版本。切换失败时恢复上一版。只有后端代码变动时才重启 PM2 进程。

- 在 GitHub Actions 的 **Deploy main** 查看日志，也可以从那里手动触发。
- 仓库保存三个 Actions secrets，分别用于 SSH 目标、仅允许执行部署命令的密钥，以及服务器主机公钥。服务器用现有 PM2 配置运行应用。
- 如果服务器访问 GitHub 需要代理，可在服务端启动部署脚本时设置 `CRAMAMELEON_GIT_PROXY`。该设置只作用于 Git 拉取。
- 修改 [部署脚本](scripts/deploy-main.sh) 后，需要同步更新服务器上的安装副本。

## 契约与行为

`src/contracts` 是 `app.v1` 的业务类型及模型事件校验，Go DTO 在 `server/model.go` 对齐。模型请求包含 requestId、turnId、sessionId、完整 messages 和白名单 tools；不接收客户端模型名、密钥、上游 URL 或费用限额。

- `AgentInput`：动作、当前会话有效历史、选中文档、偏好/进度和 AbortSignal。
- `AgentEvent`：文字、工具状态、题目、来源、资料候选、文档、学习状态、用量、错误和唯一终态。
- `PiAgentAdapter` 是唯一 Agent 实现；自动化测试通过注入可控模型响应验证同一套真实 Pi 调度、业务校验与事件协议。
- 仅将当前会话已完成或等待用户操作的有效问答对送入模型，保留最近完整对，默认历史最多 12000 字符/30 条消息。失败/中断回答不进入历史。
- 重试通过回答的 `replyTo` 关联原问题（兼容旧记录的相邻消息），保留原用户消息、替换未完成回答；失败、停止、中断和达到上限的回答不进入模型历史，本轮问题只发送一次。
- 停止立即保留已有文字、题目和来源并释放界面；旧轮次的迟到事件和清理不再改变记录或后续轮次。刷新时保存中的轮次显示为已中断，可重试。
- 模型返回 `AUTH_REQUIRED` 或应用会话检查返回 401 时，返回内部口令入口，有效访问恢复前不能发送业务请求。本机记录仍尝试保存；同用户授权成功后沿用当前内存记录，即使保存失败也恢复访问，并明确提示未保存与刷新风险。切换用户前必须保存原身份记录；保存失败时保留原记录、说明授权成功但暂不能切换，并引导原用户重新进入。各用户分别读取自己的学习会话，旧应用会话查询结果不能恢复已撤销的访问或切换当前身份。首次读取存储失败时不写回，避免覆盖未读到的旧记录。
- 网络失败、回答传输中断、今日模型额度不足和请求并发限制分别给出恢复提示；输出上限显示“达到上限”并保留部分结果。额度不足请等北京时间次日恢复，并发限制请稍后重试；模型未配置时发送及重试均禁用。联系维护者配置模型后，点击“重新检查模型状态”查询现有应用会话，不调用模型；就绪后再点击“重试”提交一次原问题。检查中的 401 和过期响应沿用应用会话恢复保护。
- 可见输出后的原生流读取异常由 `modelStream.ts` 归为 `MODEL_STREAM_INTERRUPTED`（B [#14](https://github.com/dormitory604/cramameleon/issues/14) 的修复 `6e0a83a` 已合入集成分支），界面显示传输中断并保留已收到的内容；对应浏览器回归不再带 `test.fail` 标记，#8 不再受 #14 阻塞。
- 可在聊天中说明会话偏好，用户当前指令优先。concept/review/exam 教学 Skill、课程/章节/进度、会话与单轮偏好已接入。简单问题直接回答，明确教学请求按需读取 Skill。
- 题目通过 `present_quiz` 工具完整返回并校验。支持自编题，以及有已读资料来源的改编题/原题；原题必须核对题干和选项。每轮最多一道题，最多修复一次，再失败退回讲解；作答或看答案不发模型请求。
- 默认每轮 6 次工具/120 秒，另外最多 7 次模型请求；取消、终止后丢弃迟到事件。
- 本机数据使用 `cramameleon` IndexedDB，按真实内部用户 ID 分区，保存消息、题目/作答、资料文本与勾选、偏好、学习位置和当前学习会话。界面区分保存中、已保存和失败；读写失败可重试，读取成功前禁用修改。若恢复副本可读但回写失败，会展示“已恢复、尚未保存”的内容，仍可移除资料、删除对话并重试保存。旧 `cramameleon-demo` 数据保留但不自动混入真实学习历史。
- 正常退出等待最新记录提交，等待时锁定编辑；保存失败会保留学习空间，并提供“仍然退出（可能丢失修改）”。主动选择后会尽量保留当前用户的本机恢复副本，撤销应用会话并清空界面，其他用户进入不会混入这些记录。
- 刷新/离开前尝试将未提交记录写入同用户的 localStorage 恢复副本；副本不可写（例如配额已满）时，触发浏览器原生离开确认，取消后可继续编辑保存。实际 pagehide 会中断、取消当前轮次并丢弃迟到结果，返回后可以重试。请等到“已保存”再离开；强制关闭、浏览器未触发生命周期事件或忽略确认继续离开仍可能丢失未提交修改。尚不支持多个标签页并发编辑的冲突合并。当前回归与限制（含受控生命周期事件验证，未声称实际 BFCache 命中）见 [Issue #9 学习记录验收](docs/Issue-9-学习记录验收.md)。
- `search_context`、`cite_sources` 仅处理当前已选且已解析的文本块，引用只能使用本轮已读块。本地导入、解析、多份资料勾选和文本定位已接入；旧站资料搜索/读取仍未接入。

## API

| 接口 | 行为 |
|---|---|
| GET /api/health | 运行状态、契约版本、模型配置就绪状态 |
| POST /api/internal/session | 校验内部访问口令，建立 HttpOnly 应用会话 |
| GET /api/session | 访客或内部会话信息、模型就绪状态、限制、今日全局用量 |
| POST /api/logout | 撤销应用会话 |
| POST /api/model | 单次模型转发，POST fetch 消费 SSE |

旧 `/api/demo/session` 已删除。主要错误码：AUTH_REQUIRED、MODEL_NOT_CONFIGURED、BUDGET_EXCEEDED、TOTAL_BUDGET_EXCEEDED、CONCURRENCY_LIMIT、DUPLICATE_REQUEST、CONTEXT_TOO_LARGE、MODEL_AUTH_FAILED、MODEL_BALANCE、MODEL_RATE_LIMIT、MODEL_TIMEOUT、MODEL_STREAM_INTERRUPTED、MODEL_OUTPUT_LIMIT、STORAGE_FAILED。

预算在请求上游前，以请求 UTF-8 字节数+4096协议开销+输出上限保守预留；成功后按官方 usage 结算。断开/超时/崩溃而无可信 usage 时保留全部预留，不把未知消费当零。每日额度按请求开始日归属。全站累计上限为 1 亿 token，历史用量与未结算预留均计入，预算记录跨重启保存在同一 SQLite 数据库。全局并发为 2，内部模式每用户最多 1 个并行请求，访客模式每客户端 IP 最多 1 个。相同 requestId 不会重复请求上游，手动重试必须使用新 ID。服务只记录请求 ID、状态、耗时和 token 数，不记录聊天、课件或密钥。不自动重试付费请求。

## 验证

```sh
npm test
npm run build
cd server && go test ./... && go vet ./...
# 在项目根目录：
npx playwright install chromium
npx playwright test
TEST_PRODUCTION=1 npx playwright test
```

浏览器测试默认使用端口 18086。本次 Issue #9 评审修复在隔离配置中把服务器和 baseURL 统一到 18111，并使用 `--strictPort`，避开其他任务；标准命令可在独立检出目录直接运行，不依赖临时工作树。最终结果为 24 项模块测试、22 项开发浏览器测试、22 项生产浏览器测试全部通过，构建通过。临时端口配置的可移植示例及验证边界见 [Issue #9 学习记录验收](docs/Issue-9-学习记录验收.md)。

也可通过 PLAYWRIGHT_CHROMIUM_EXECUTABLE 指定已有 Chrome 路径。浏览器测试使用可控模型响应，覆盖访客入口、流式 Markdown 和公式、会话隔离、重试去重、题板反馈、恢复/删除和模型未配置；`tests/e2e/recovery.spec.ts` 另覆盖真实 PiAgentAdapter 的停止与迟到流、失败/中断/上限重试、错误恢复、应用会话失效与同用户/跨用户重新进入，以及手机关键恢复操作。Go 测试验证协议转换、分片工具参数、权限、取消和持久预算。新阶段真实模型验收已通过 12 个用例，覆盖简单问答、教学 Skill、复习范围与续接、出题、临时偏好及已解析资料的引用与注入防护，详见 [教学执行验收](docs/Agent教学执行验收-2026-11-04.md)。第 4 部分的六种格式、ZIP 目录选择、取消/错误、缓存隔离与真实模型闭环结果见 [本地资料闭环验收](docs/本地资料闭环验收-2026-11-04.md)。

#8 的存储写入失败、初始存储不可用、模型就绪恢复、停止后的迟到流及可见输出后的流中断均由 `tests/e2e/recovery.spec.ts` 覆盖；#14 合入后已移除预期失败标记。最新全量结果见 [本地学习闭环交付报告](docs/Issue-12-本地学习闭环交付报告.md)，其中注明了规格 #4 评审修复后尚未重跑。详见 [#8 停止与会话恢复验收](docs/停止与会话恢复验收-issue-8.md)。

实现依据：[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) 与 [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)。

教学提示词与 Skill 参考 DeepTutor v1.7.1 的源码，按本项目的工具、资料引用和单题交互契约重新编写。实际参考文件、固定提交链接及适配说明见 [DeepTutor 教学提示词参考](docs/DeepTutor教学提示词参考.md)。

## 本地资料使用与验收

在当前对话的“本地资料”中导入 TXT、Markdown、文本 PDF、DOCX、PPTX；ZIP 先勾选目录条目，再解析。文件仅在浏览器 Worker 中处理，缓存文本与元数据，不保存原始文件。导入不调用模型；发送问题后仅检索选中资料并提交必要片段。点来源按钮可查看真实页码、幻灯片或段落，并切换缓存文本块。

单文件 20MB；ZIP 展开最多 100MB、200 条，禁止嵌套压缩包，不支持加密、多卷和 ZIP64。每会话最多 20 份资料；每份最多 200 万字、1000 文本块，PDF/PPTX 最多 1000 页/张。DOCX 不推测页码，扫描件不做 OCR；公式对象、图表与复杂布局可能无法完整提取，界面会展示解析警告。导入超时两分钟可重新选择或拆分文件，停止导入会终止 Worker。

生产构建会复制 PDF.js 的本地 CMap 和标准字体；部署时须同步完整 dist（包括 assets 和 pdfjs）。首次使用需加载解析资源，已导入的文本可离线查看。

生产产物回归：先 npm run build，再设置 TEST_PRODUCTION=1 并运行 npm run test:e2e。真实付费资料闭环验收需已有 18085 SSH 转发和本地 .env.internal 内部访问口令，设置 RUN_LIVE_MATERIALS=1，执行 npx playwright test --config playwright.live.config.ts。该验收使用自编材料和独立浏览器上下文，结果在 .preflight/materials-live.json。

教学验收（预算受控）：`node --experimental-strip-types scripts/acceptance-teaching.ts --live` 运行 12 项教学用例（用例标识与 docs/evidence/teaching-acceptance-2026-11-04.json 一致）。本阶段默认 `--phase spec-4 --limit 30000`，累计记录在只追加账本 `.preflight/acceptance-budget/spec-4.jsonl`，本次报告在 `.preflight/teaching-acceptance-spec-4.json`；可用 `--ledger`、`--report` 指定其他路径。每次 /api/model 请求发出前按“请求体 UTF-8 字节数 + 512”输入上界加服务端输出上限预留，收到可信用量后结算；流中断、取消、5xx 或进程被杀时保留预留并在报告中标注。剩余额度或服务端当日额度不足以覆盖下一次预留时在请求发出前停止。中断后用同一账本再次执行即继续累计，`--skip-completed` 跳过上次已通过的用例，`--only a,b` 只跑指定用例（自动补上前置用例），`--status` 不联网查看账本累计值。上方真实资料闭环验收不经过该预算守卫。
