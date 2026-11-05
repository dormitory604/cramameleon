# Cramameleon

面向课程学习的 AI 助手，支持概念讲解、系统复习、单题练习，以及基于课程资料的阅读和引用。正式入口通过破壁计划旧站账号授权；本仓库包含独立的 React 前端、浏览器 Agent 和 Go 后端。

## 当前功能

- 流式问答，支持 Markdown、代码、表格和 LaTeX 公式；可停止生成、重试未完成回答、切换和删除对话。
- 用户消息可复制、编辑并重新发送；Agent 回复可复制。桌面端悬停或键盘聚焦时显示操作，触屏直接显示。编辑从该条消息之前重新回答，原对话保留为“编辑前版本”，输入框草稿保留。
- 默认浅色，支持手动切换深色；选择保存在当前浏览器。
- concept、review、exam 三种教学 Skill；按当前请求组织讲解、复习和练习，保存会话偏好、课程、章节和学习位置。
- 单选题支持自编、基于已读资料改编，以及经原文核对的真题；作答和查看解析在本地完成，不调用模型。
- 本地文件导入与旧站课程资料导入，共用资料选择与引用。用户上传由浏览器解析，旧站资料由服务端解析。旧站支持单份资料、课程包分页目录、免费在线预览、待读清单批量确认及按条目读取；读取失败的资料保留供重试。
- 消息、作答、资料缓存、勾选和学习状态按账号保存在当前浏览器；支持刷新恢复、保存状态提示和存储失败重试。

当前能力与限制以本 README、[架构与模块契约](项目架构与模块契约.md) 和代码为准。日期命名的交付报告是历史记录，索引见 [文档目录](docs/README.md)。

## 运行结构

~~~text
React UI → PiAgentAdapter → Pi Agent Core → /api/model → Go/Gin → DeepSeek
                 ↕
      教学 Skill / 学习状态 / 已选文本阅读与引用 / 单选题
                 ↓
             UI / IndexedDB

课程资料 UI → Go 旧站适配器 → 旧站授权与资料 API
                         ↓
                    服务端解析与短时缓存 → 模型证据
~~~

Agent 循环和工具在浏览器执行，Go 转发单次模型请求，并负责身份、旧站接入、预算与并发。模型密钥和旧站受限凭据留在服务端。聊天和文件全文不存入服务端数据库；模型只收到有效历史、已选资料元数据及本轮实际读取的片段。

| 路径 | 用途 |
|---|---|
| src/ui | 聊天、消息操作、题板、资料目录、来源和主题 |
| src/session | 历史上下文、编辑版本、本机持久化与恢复 |
| src/agent | Pi 调度、模型流、取消和轮次限制 |
| src/tools | Worker 解析、资料读取、Skill、引用与题目校验 |
| src/contracts | app.v1 业务类型、模型事件与校验 |
| prompts、skills | 系统提示与白名单教学内容的源文件 |
| server | Go/Gin API、旧站适配与 SQLite 记账 |
| scripts/acceptance | 有预算账本的真实模型验收 |
| tests | 单元测试和浏览器回归 |

## 本地开发

需要 Node.js >=22.19、npm 和 Go >=1.22。以下命令在项目根目录执行。

~~~sh
npm ci --no-audit --no-fund
cp .env.internal.example .env.internal
~~~

编辑 .env.internal，设置至少 24 字符的随机 APP_ACCESS_TOKEN；需要真实问答时填写 DEEPSEEK_API_KEY。环境文件不会自动由 Go 加载，需要注入进程。Bash 中启动后端：

~~~sh
set -a
. ./.env.internal
set +a
(cd server && go run .)
~~~

另开终端启动前端：

~~~sh
npm run dev
~~~

访问 Vite 输出的本地地址，/api 代理到 127.0.0.1:18085。在输入区用内部口令建立应用会话。PowerShell 可用 $env:变量名 设置同一组进程环境变量，再进入 server 执行 go run .。

模型未配置时仍可导入、查看资料和恢复记录，发送及重试会禁用；配置后可用“重新检查模型状态”恢复。APP_ALLOW_GUEST=1 仅用于 internal 模式的免口令访问，不能绕过 old-site 模式的账号准入。

生产前端构建使用 npm run build；Go 直接服务静态产物时，默认 APP_STATIC_DIR=dist。构建会生成教学内容模块并复制 PDF.js 本地资源，部署必须包含完整 dist 及同级 material-parser 目录。

## 旧站授权与配置

正式模式使用 [.env.old-site.example](.env.old-site.example)，将变量注入后端进程；本地内部模式使用 [.env.internal.example](.env.internal.example)。两种模式的会话入口不同，旧站模式不开放内部口令登录接口。

| 配置 | 含义 |
|---|---|
| APP_ENV | internal 或 old-site，默认 internal |
| APP_BIND | 仅允许 loopback，默认 127.0.0.1:18085 |
| APP_STATIC_DIR、APP_DATABASE_PATH | 静态目录、SQLite 路径，默认 dist、var/app.sqlite |
| APP_PUBLIC_URL、OLD_SITE_URL | 新站公网 origin、固定旧站地址；old-site 模式必填 |
| OLD_SITE_CLIENT_ID、OLD_SITE_CLIENT_SECRET | 两个后端专用集成身份与秘密 |
| APP_CREDENTIAL_KEY | 旧站凭据加密密钥，32 字节，配置为 64 位十六进制 |
| APP_OLD_SITE_ACCESS_MODE | public：所有正常授权的旧站用户；beta：仅内测名单。未配置时默认 beta |
| APP_ALLOWED_OLD_USER_IDS | 内测名单中的旧站数字用户 ID，逗号分隔；beta 时不能为空，public 时保留供切回使用 |
| APP_ACCESS_TOKEN、APP_DEVELOPER_ID | 内部模式口令与本机记录对应身份 |
| DEEPSEEK_API_KEY、DEEPSEEK_MODEL | 服务端模型密钥和唯一允许模型名，模型默认 deepseek-flash |
| APP_DAILY_TOKEN_BUDGET | 全局每日输入、输出 token 合计上限；代码默认 1,000,000，部署模板可覆盖 |
| APP_MAX_OUTPUT_TOKENS、APP_MAX_INPUT_BYTES | 单次模型输出 token 上限、请求体字节上限，默认 393216（模型最大长度）、64000 |

旧站流程使用单次授权码、浏览器绑定 state、S256 PKCE 和固定回调，服务端兑换后建立 8 小时应用会话。public 允许正常授权的旧站用户进入，beta 按每次请求重新核对名单；两种模式都要求有效的旧站账号授权。资料凭据失效与应用会话失效分别处理；旧站暂不可用时，有效应用会话仍可使用本地与缓存资料。

名单、密钥和部署环境文件由服务器私有配置管理，修改后重启进程。不要把邮箱、昵称或前端参数当作可信身份，也不要设置 VITE 模型密钥。详细接入与下载规则见 [旧站身份与课程资料接入](docs/旧站身份与资料接入-2026-11-05.md)。

切换开放范围时，在服务器私有 .env.old-site 中设置 APP_OLD_SITE_ACCESS_MODE=public 或 beta，然后执行 pm2 restart cramameleon。保留原 APP_ALLOWED_OLD_USER_IDS；切回 beta 后名单外用户的已有会话也会受限。GET /api/health 和 /api/auth/config 的 oldSiteAccessMode 可确认已加载的模式，不返回名单。仅修改此配置无需重新构建。

## 资料阅读与引用

从「添加」可上传本地文件或搜索课程资料。旧站资料直接进入时，在输入框附近显示导入进度；超出对话容量时可手动打开课程包目录。旧站资料在服务端读取和解析，浏览器只保存资料标识和来源元数据。Cramameleon 读取不消耗破壁计划下载额度。

已授权会话可让 Agent 搜索破壁计划，每轮最多两次搜索及两次远程读取。解析缓存按应用会话隔离，15 分钟到期；本轮模型证据绑定应用会话、轮次和工具调用，4 分钟到期。进程内缓存最多 32 MiB，解析最多两项并发，单次最多 90 秒。

导入并勾选后，Agent 可使用：

| 工具 | 行为 |
|---|---|
| search_context | 按关键词搜索当前已选且已解析的文本 |
| read_context | 从指定文本块顺序阅读；省略 startChunk 时从开头读，按 nextChunk 续读 |
| cite_sources | 引用本轮实际读到的块，位置和原站链接取自缓存元数据 |
| read_skill | 读取 concept、review、exam 中的已发布教学方法 |
| update_learning_state | 记录实际学习位置与用户偏好 |
| present_quiz | 校验并展示一道完整单选题 |

标题和目录不等于已读正文。两种读取工具共用每轮 8000 字符预算，单次至多 6000；预算耗尽会返回 budgetExhausted。Agent 工具不下载旧站文件、不扣下载次数、不访问任意网页。取消勾选或移除资料后，涉及该资料的旧问答不再进入本轮模型历史，但界面记录仍保留。

来源窗口区分“本轮读取片段”和缓存原文，可查看真实页码、幻灯片或段落。PDF/PPTX 可以保留实际页/张号；DOCX 不推测页码。没有足够证据时应说明缺口，不能从文件名猜题目或考试范围。

## 限制与恢复

- 支持 TXT、Markdown、文本 PDF、DOCX、PPTX；本地 ZIP 先选目录条目再解析。单文件 20 MiB；ZIP 展开最多 100 MiB、200 条，拒绝嵌套、加密、多卷和 ZIP64。
- 每对话最多 20 份资料；每份最多 200 万字符、1000 文本块，PDF/PPTX 最多 1000 页/张。旧站 PDF 对空白或不足 40 个非空白字符的页面自动尝试 OCR（每文件最多 16 页、35 秒）；本地导入仍仅提取文本层。图片、公式对象和复杂布局可能缺失；按界面解析警告核对原文。
- 默认每轮 6 次工具调用、最多 7 次模型请求、120 秒；一次可提交 1—10 道单选题，逐题校验；前端一次显示一道，查看解析后点“下一道”切换，并保存当前位置，未通过的题可合并修复一次。
- 历史最多 12000 字符、30 条消息，按完整问答对裁剪并保留当前题目的必要记录；失败和中断回答不进入模型历史。
- 模型全局并发 2，单用户或访客 IP 并发 1；相同 requestId 不会重复请求上游，传输中断、临时网络或上游错误在尚未返回题目或工具调用时，整轮最多自动重试两次，计入原有请求与时间上限；重试可能产生额外模型用量。全站累计 token 上限为 100,000,000。
- 预算按请求开始时的北京时间自然日归属。发起前保守预留，有可信 usage 后结算；中断而无可信用量时保留预留，SQLite 跨重启保留记账。
- 停止会保留已有文字、题目与来源；刷新后未完成轮次标为中断，可重试。旧轮次迟到结果不能修改新轮次。
- 本机记录按用户隔离，读写失败提供重试；读取成功前不覆盖旧记录。正常退出等待保存，刷新/离开时尽量写入恢复副本。强制关闭或忽略保存失败提示仍可能丢失未保存内容。
- 当前不提供本地文件 OCR、旧 DOC/PPT 转换、跨设备同步、多标签并发编辑冲突合并、错题库、后台学习任务或开放网页搜索。

## API

| 接口 | 用途 |
|---|---|
| GET /api/health | 运行状态、契约版本、模型就绪状态 |
| GET /api/auth/config | 当前进入方式和旧站入口 |
| GET /api/auth/old-site/start、callback | 旧站模式授权发起、回调 |
| POST /api/auth/old-site/start | 破壁计划资料页提交导入意图并发起授权 |
| POST /api/internal/session | 内部模式口令授权 |
| GET /api/session、POST /api/logout | 查询、撤销本应用会话 |
| POST /api/model | 单次模型流转发，POST fetch 消费 SSE |
| GET /api/old-site/quota | 旧站下载权益 |
| GET /api/old-site/materials、packages | 搜索；在资源 ID 后查询详情、课程包 items 目录 |
| POST /api/old-site/materials/:id/access、packages/:id/access | 资料读取授权与幂等回执 |
| GET /api/old-site/…/parsed、…/evidence | 旧站资料的引用元数据及本轮证据标识 |

业务接口要求有效应用会话；旧站资料请求绑定当前用户，后端只转发固定旧站和白名单路径。常见错误包括 AUTH_REQUIRED、ENTRY_NOT_ALLOWED、MATERIAL_AUTH_EXPIRED、QUOTA_EXCEEDED、MODEL_NOT_CONFIGURED、BUDGET_EXCEEDED、TOTAL_BUDGET_EXCEEDED、CONCURRENCY_LIMIT、MODEL_STREAM_INTERRUPTED、MODEL_OUTPUT_LIMIT 和 STORAGE_FAILED。

## 验证

~~~sh
npm test
npm run typecheck
npm run build
(cd server && go test ./... && go vet ./...)
npx playwright install chromium
npm run test:e2e
TEST_PRODUCTION=1 npm run test:e2e
~~~

浏览器测试使用真实界面、Pi 调度、工具、Worker 和 IndexedDB，在模型及旧站 HTTP 边界使用可控响应，不消耗真实模型或下载额度。默认端口 18086；生产产物测试需先构建。可用 PLAYWRIGHT_CHROMIUM_EXECUTABLE 指定已有 Chrome 路径；PowerShell 用 $env:TEST_PRODUCTION='1' 设置生产测试模式。

tests 中保留协议、教学、资料解析/范围/引用、预算、会话恢复、旧站入口、消息编辑、主题和设备键盘等回归。真实模型验收统一使用有累计预算账本的入口，参见 [验收说明](scripts/acceptance/README.md)；普通回归不会发起真实付费调用。

## 部署

[Deploy main](.github/workflows/deploy-main.yml) 在 main 推送或手动触发时通过受限 SSH 命令执行 [deploy-main.sh](scripts/deploy-main.sh)。脚本拉取 main、独立构建、切换发布目录并检查服务与静态首页；失败恢复上一版本，仅后端变化时重启 PM2。B 分支推送不会触发此工作流。

部署需要事先配置 PM2、发布目录、私有环境文件和工作流使用的 SSH secrets。脚本默认项目目录为服务器用户的 ~/cramameleon，可用 CRAMAMELEON_ROOT 覆盖；修改仓库脚本后也需同步服务器安装副本。服务端 Git 代理可用 CRAMAMELEON_GIT_PROXY 配置。

保留服务端 SQLite 和当前私有配置，回滚程序不能回滚新产生的用量与下载记录。scripts/internal.sh 是 Linux 内部联调的启动辅助工具，通过 CRAM_ENV_FILE 选择环境文件；正式部署流程使用上述 PM2 发布脚本。

### 旧站 PDF 自动公式 OCR

部署前运行 `bash scripts/ocr/install.sh /absolute/app/root/var/ocr`。使用固定版本的 ONNX Runtime、RapidOCR 和 Pix2Text 的公式检测/识别模型；模型版本和 SHA-256 见 `scripts/ocr/models.json`，安装时校验，处理请求时不下载模型。网络受限时安装命令可设置 `HF_ENDPOINT=https://hf-mirror.com`，仍按相同哈希校验。默认运行环境是发布目录的 `ocr-runtime` 链接，也可通过 `APP_OCR_PYTHON`、`APP_OCR_MODELS` 指定绝对路径。自动部署会检查运行环境并链接 `var/ocr`。

先提取文本层，再自动识别空白或不足 40 个非空白字符的页面。公式区域使用 Pix2Text-MFD/MFR 1.5 转为 LaTeX，其他文字使用 RapidOCR，按位置合并。保留原文本和页码，新增内容标为 OCR。每文件最多 16 页、35 秒，图像最长边 1600 像素；每公式最多 256 token，未完整生成的公式不返回。服务端一次只解析一个文件，取消时终止整个解析进程组并清理临时文件。识别失败时保留原文本并提示换资料。

OCR 可能误识别公式、文字和选项，不能保证逐字准确；OCR 页可用于阅读或改编，不能只凭字符匹配通过原题校验。本地导入仍只提取文本层。模型来源与许可证见 `scripts/ocr/NOTICE.md`。
