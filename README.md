# Cramameleon

B 分支已将固定脚本 Demo 替换为真实 DeepSeek 模型代理。React UI → 浏览器 Pi Core → Go 单次模型代理；工具仍在浏览器执行，Go 不运行 Agent 循环。

当前可用：内部访问口令、持久应用会话、多对话、教学 Skill 与学习进度、真实模型问答、资料改编题及本地反馈、SQLite 预算，以及本地文件导入、解析、选择、检索和引用闭环。模型未配置时禁用发送，仍可导入与查看本地资料。

## 配置和运行

要求 Node >=22.19、Go >=1.22。复制 `.env.internal.example` 为 `.env.internal`，填写：

- `APP_ACCESS_TOKEN`：至少 24 字符的随机内部访问口令，登录页面使用它。
- `DEEPSEEK_API_KEY`：真实密钥，仅存在服务器环境文件。
- `DEEPSEEK_MODEL`：默认 `deepseek-flash`，是服务端唯一允许的模型。
- `APP_DAILY_TOKEN_BUDGET`：默认 100000，按北京时间自然日计算全局输入+输出 token。
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

服务仅接受 `APP_ENV=internal` 和 loopback 监听；旧站授权尚未接入，因此不允许公开部署。应用会话有效 8 小时，SQLite 保存 token 哈希。更改开发者 ID 后旧身份会话失效，本地记录按新身份隔离。

服务器路径为 `/home/ubuntu/cramameleon`。通过 SSH 转发访问：
```sh
ssh -N -L 127.0.0.1:18085:127.0.0.1:18085 zzs
```
打开 http://127.0.0.1:18085 ，输入环境文件中的内部访问口令。更改密钥或预算后：
```sh
sh scripts/internal.sh stop
sh scripts/internal.sh start
```

此次服务器交付使用 `APP_STATIC_DIR=var/app-dist`，保留旧 `dist` 与旧 Demo 二进制以便回退；后续本机构建需把 dist 同步至这个配置目录，或调整 APP_STATIC_DIR。进程日志在 `var/log/internal.log`。脚本校验 PID 对应二进制后才停止进程。尚未配置 systemd，重启主机后需手动启动。

## 契约与行为

`src/contracts` 是 `app.v1` 的业务类型及模型事件校验，Go DTO 在 `server/model.go` 对齐。模型请求包含 requestId、turnId、sessionId、完整 messages 和白名单 tools；不接收客户端模型名、密钥、上游 URL 或费用限额。

- `AgentInput`：动作、当前会话有效历史、选中文档、偏好/进度和 AbortSignal。
- `AgentEvent`：文字、工具状态、题目、来源、资料候选、文档、学习状态、用量、错误和唯一终态。
- `PiAgentAdapter` 是唯一 Agent 实现；自动化测试通过注入可控模型响应验证同一套真实 Pi 调度、业务校验与事件协议。
- 仅将当前会话已完成或等待用户操作的有效问答对送入模型，保留最近完整对，默认历史最多 12000 字符/30 条消息。失败/中断回答不进入历史。
- 重试保留原用户消息、替换失败回答；本轮问题只发送一次。
- 会话偏好可修改并保存；用户当前指令优先。concept/review/exam 教学 Skill、课程/章节/进度、会话与单轮偏好已接入。简单问题直接回答，明确教学请求按需读取 Skill。
- 题目通过 `present_quiz` 工具完整返回并校验。支持自编题，以及有已读资料来源的改编题/原题；原题必须核对题干和选项。每轮最多一道题，最多修复一次，再失败退回讲解；作答或看答案不发模型请求。
- 默认每轮 6 次工具/120 秒，另外最多 7 次模型请求；取消、终止后丢弃迟到事件。
- 本机数据使用新的 `cramameleon` IndexedDB，按真实内部用户 ID 分区。旧 `cramameleon-demo` 数据保留但不自动混入真实学习历史。
- `search_context`、`cite_sources` 仅处理当前已选且已解析的文本块，引用只能使用本轮已读块。本地导入、解析、多份资料勾选和文本定位已接入；旧站资料搜索/读取仍未接入。

## API

| 接口 | 行为 |
|---|---|
| GET /api/health | 运行状态、契约版本、模型配置就绪状态 |
| POST /api/internal/session | 校验内部访问口令，建立 HttpOnly 应用会话 |
| GET /api/session | 身份、模型就绪状态、限制、今日全局用量 |
| POST /api/logout | 撤销应用会话 |
| POST /api/model | 单次模型转发，POST fetch 消费 SSE |

旧 `/api/demo/session` 已删除。主要错误码：AUTH_REQUIRED、MODEL_NOT_CONFIGURED、BUDGET_EXCEEDED、CONCURRENCY_LIMIT、DUPLICATE_REQUEST、CONTEXT_TOO_LARGE、MODEL_AUTH_FAILED、MODEL_BALANCE、MODEL_RATE_LIMIT、MODEL_TIMEOUT、MODEL_STREAM_INTERRUPTED、MODEL_OUTPUT_LIMIT、STORAGE_FAILED。

预算在请求上游前，以请求 UTF-8 字节数+4096协议开销+输出上限保守预留；成功后按官方 usage 结算。断开/超时/崩溃而无可信 usage 时保留全部预留，不把未知消费当零。记录跨重启持久；每日额度按请求开始日归属。全局并发 2、单用户 1。相同 requestId 不会重复请求上游，手动重试必须使用新 ID。服务只记录请求 ID、状态、耗时和 token 数，不记录聊天、课件或密钥。不自动重试付费请求。

## 验证

```sh
npm test
npm run build
cd server && go test ./... && go vet ./...
# 在项目根目录：
npx playwright install chromium
npx playwright test
```

也可通过 PLAYWRIGHT_CHROMIUM_EXECUTABLE 指定已有 Chrome 路径。浏览器测试使用测试上游，覆盖会话隔离、重试去重、题板反馈、恢复/删除和模型未配置；Go 测试验证协议转换、分片工具参数、权限、取消和持久预算。新阶段真实模型验收已通过 12 个用例，覆盖简单问答、教学 Skill、复习范围与续接、出题、临时偏好及已解析资料的引用与注入防护，详见 [教学执行验收](docs/Agent教学执行验收-2026-11-04.md)。第 4 部分的六种格式、ZIP 目录选择、取消/错误、缓存隔离与真实模型闭环结果见 [本地资料闭环验收](docs/本地资料闭环验收-2026-11-04.md)。

实现依据：[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) 与 [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)。

教学提示词与 Skill 参考 DeepTutor v1.7.1 的源码，按本项目的工具、资料引用和单题交互契约重新编写。实际参考文件、固定提交链接及适配说明见 [DeepTutor 教学提示词参考](docs/DeepTutor教学提示词参考.md)。

## 本地资料使用与验收

在当前对话的“本地资料”中导入 TXT、Markdown、文本 PDF、DOCX、PPTX；ZIP 先勾选目录条目，再解析。文件仅在浏览器 Worker 中处理，缓存文本与元数据，不保存原始文件。导入不调用模型；发送问题后仅检索选中资料并提交必要片段。点来源按钮可查看真实页码、幻灯片或段落，并切换缓存文本块。

单文件 20MB；ZIP 展开最多 100MB、200 条，禁止嵌套压缩包，不支持加密、多卷和 ZIP64。每会话最多 20 份资料；每份最多 200 万字、1000 文本块，PDF/PPTX 最多 1000 页/张。DOCX 不推测页码，扫描件不做 OCR；公式对象、图表与复杂布局可能无法完整提取，界面会展示解析警告。导入超时两分钟可重新选择或拆分文件，停止导入会终止 Worker。

生产构建会复制 PDF.js 的本地 CMap 和标准字体；部署时须同步完整 dist（包括 assets 和 pdfjs）。首次使用需加载解析资源，已导入的文本可离线查看。

生产产物回归：先 npm run build，再设置 TEST_PRODUCTION=1 并运行 npm run test:e2e。真实付费资料闭环验收需已有 18085 SSH 转发和本地 .env.internal 内部访问口令，设置 RUN_LIVE_MATERIALS=1，执行 npx playwright test --config playwright.live.config.ts。该验收使用自编材料和独立浏览器上下文，结果在 .preflight/materials-live.json。
