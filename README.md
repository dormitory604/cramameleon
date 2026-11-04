# Cramameleon

B 分支已将固定脚本 Demo 替换为真实 DeepSeek 模型代理。React UI → 浏览器 Pi Core → Go 单次模型代理；工具仍在浏览器执行，Go 不运行 Agent 循环。

当前可用：内部访问口令、持久应用会话、按用户隔离的多对话、有效历史与会话偏好、失败重试、取消、真实问答、自编单选题及本地反馈、SQLite 全局 token 预算。模型未配置时明确禁用发送。

## 配置和运行

要求 Node >=22.19、Go >=1.22。复制 `.env.internal.example` 为 `.env.internal`，填写：

- `APP_ACCESS_TOKEN`：至少 24 字符的随机内部访问口令，登录页面使用它。
- `DEEPSEEK_API_KEY`：真实密钥，仅存在服务器环境文件。
- `DEEPSEEK_MODEL`：默认 `deepseek-flash`，是服务端唯一允许的模型。
- `APP_DAILY_TOKEN_BUDGET`：默认 100000，按北京时间自然日计算全局输入+输出 token。
- `APP_MAX_OUTPUT_TOKENS`：默认 2048；`APP_MAX_INPUT_BYTES`：默认 64000。

本次交付另提供了已生成随机访问口令的实际 `.env.internal`；API 密钥仍为占位符。环境文件和 SQLite 不提交 Git。不得在前端设置 VITE 模型密钥。

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
- `FakeAgent`：独立、无需网络的脚本事件实现，仅供 A 显式导入联调；正式 UI 始终使用 PiAgentAdapter。
- 仅将当前会话已完成的问答对送入模型，保留最近完整对，默认历史最多 12000 字符/30 条消息。失败/中断回答不进入历史。
- 重试保留原用户消息、替换失败回答；本轮问题只发送一次。
- 会话偏好可在输入框上方修改并保存；用户当前指令优先。进度和资料事件已留契约，完整教学 Skill/资料流程属于后续工作。
- 题目通过 `present_quiz` 工具完整返回并校验。当前仅支持明确标记的自编题，不伪造来源。最多一次修复；作答或看答案不发模型请求。
- 默认每轮 6 次工具/120 秒，另外最多 7 次模型请求；取消、终止后丢弃迟到事件。
- 本机数据使用新的 `cramameleon` IndexedDB，按真实内部用户 ID 分区。旧 `cramameleon-demo` 数据保留但不自动混入真实学习历史。
- 资料读取与解析尚未实现，传入资料动作时明确返回 MATERIALS_NOT_READY，不能声称已读取。

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

也可通过 PLAYWRIGHT_CHROMIUM_EXECUTABLE 指定已有 Chrome 路径。浏览器测试使用测试上游，覆盖会话隔离、重试去重、题板反馈、恢复/删除和模型未配置；Go 测试验证协议转换、分片工具参数、权限、取消和持久预算。真实付费 API 验收需要填写实际密钥，本次未调用。

实现依据：[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) 与 [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)。
