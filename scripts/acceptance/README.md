# 真实模型教学验收

普通单元和浏览器回归不调用真实模型。需要检查教学内容时，使用项目根目录的 scripts/acceptance-teaching.ts；它执行真实 PiAgentAdapter，并在每次模型请求前经过累计预算守卫。旧的独立 live Playwright 入口已移除，文件解析与资料选择的浏览器行为由 tests/e2e/materials.spec.ts、material-scope.spec.ts 和 old-site-materials.spec.ts 覆盖。

## 准备

先运行 npm run build，更新发布的 prompt 和 Skill。启动或通过自行建立的 SSH 转发访问待验收服务，地址由 --base-url 或 CRAMAMELEON_BASE_URL 指定，默认 http://127.0.0.1:18085；远程直连必须使用 HTTPS。通过本地转发访问旧站模式时，另用 --origin 或 CRAMAMELEON_PUBLIC_ORIGIN 指定服务的 APP_PUBLIC_URL，满足后端固定来源校验。脚本不会登录 SSH、读取服务器私有环境文件或修改服务器配置。

可用会话来自以下方式之一：

- 旧站模式：先走正常旧站授权，通过私有进程环境变量 `CRAMAMELEON_SESSION_COOKIE` 提供 `cram_session=<value>`。只提供应用 Cookie，不提供旧站登录凭据或模型密钥；脚本不会撤销这个调用者提供的会话。
- 内部模式：在进程环境设置 APP_ACCESS_TOKEN，脚本仅在服务声明为 internal 时建立临时会话，结束后退出。
- 访客模式：待验收的内部服务已允许访客时，无需额外凭据。

凭据不写入命令参数、报告或仓库。验收使用自编文本，不搜索或下载真实旧站课程文件。

## 执行

~~~sh
# 只看累计账本；不联网、不调用模型
node --experimental-strip-types scripts/acceptance-teaching.ts --status

# 明确启用真实付费调用
node --experimental-strip-types scripts/acceptance-teaching.ts --live

# 只跑指定用例，自动加入必要前置用例
node --experimental-strip-types scripts/acceptance-teaching.ts --live --only concept-opportunity,concept-bayes

# 使用同一账本继续，跳过此前已通过且不再被前置依赖的用例
node --experimental-strip-types scripts/acceptance-teaching.ts --live --skip-completed
~~~

用例 ID 见 teachingCases.ts。`--phase` 是账本标识，保留默认 `spec-4` 以继续此前的累计记录，不代表当前开发阶段；默认 `--limit 30000`。账本为 `.preflight/acceptance-budget/<phase>.jsonl`，报告为 `.preflight/teaching-acceptance-<phase>.json`，可通过 `--ledger`、`--report` 指定路径。同一账本的标识和额度必须一致，不要删除或更换账本来重置已用预算。

请求发出前按输入 UTF-8 字节上界与服务端输出上限保守预留，收到可信 usage 后结算；取消、流中断或异常退出保留未结算预留。累计预算或服务端日预算不足以覆盖下次请求时停止，不自动重试付费请求。报告注明实际运行、跳过、未运行的用例与停止原因，不能把未运行算作通过。

预算与报告器的可控响应回归保留在 tests/acceptanceBudget.test.ts。
