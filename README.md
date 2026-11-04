# Cramameleon 工程 Demo

项目架构以本地工作区的《项目架构与模块契约.md》为准。本目录提供可运行的最小实现，所有业务数据都是模拟载荷。

React 界面消费 `AgentEvent`；`PiAgentAdapter` 使用真实 Pi Core 执行浏览器工具；自定义 `streamFn` 访问 Go/Gin 的模拟 SSE 接口。一次成功演示产生两次模型请求和一次工具调用。Go 不执行 Agent 循环。

## 目录与接口

- `src/ui`：最小技术演示界面，由 A 后续接入正式 UI。
- `src/session`：当前浏览器 IndexedDB 记录、题板反馈和中断恢复。
- `src/agent`：Pi 适配、模型流解码、取消与终态。
- `src/tools`：可取消的固定资料工具，不读取文件。
- `src/contracts`：`demo.v1` 输入、业务事件、模型事件、题板和来源。
- `server`：Go/Gin、模拟会话、流式模型接口与静态前端服务。
- `prompts`、`skills`：保留 TODO，占位内容不加载。

| 接口 | 用途 |
|---|---|
| `GET /api/health` | 健康、模拟能力标记和进程内请求统计 |
| `POST /api/demo/session` | 仅 Demo 模式的模拟入口，签发 HttpOnly 会话 Cookie |
| `GET /api/session` | 验证应用会话 |
| `POST /api/logout` | 撤销当前模拟会话 |
| `POST /api/model` | 接收 Pi 上下文；返回 SSE 模型事件 |

模型事件为 `start/text_delta/tool_call/finish/error`。Pi 适配层输出 `text_delta/tool_status/quiz_ready/sources_ready/error/done`，业务事件包含 `sessionId` 和 `turnId`。界面按轮次丢弃迟到事件。停止中断 fetch 和工具，等待当前轮结束后允许发送。

## 构建与测试

要求 Node >=22.19、Go 1.22。依赖版本由 lock 文件固定。服务器构建顺序：

```sh
set -a
. ./.env.demo
set +a
npm ci --no-audit --no-fund
npm test
npm run build
cd server
go test ./...
go build -o bin/cramameleon-demo .
cd ..
./server/bin/cramameleon-demo
```

服务器配置是 `/home/ubuntu/cramameleon/.env.demo`；仅监听 `127.0.0.1:18085`。请勿公开模拟授权接口。服务启动必须显式设置 Demo 开关，真实模型、旧站、数据库开关均为 false。Node 堆上限 512MiB，Go 内存目标 256MiB，构建并发 1；Node 与 Go 构建串行执行。检查可用内存 >=768MiB、空闲磁盘 >=1GiB 后再构建。

本机访问：`ssh -N -L 127.0.0.1:18085:127.0.0.1:18085 zzs`，随后打开 http://127.0.0.1:18085 。停止转发会断开本机访问，不影响旧站。

## 运行边界与 TODO

- TODO(auth)：旧站一次性授权码、服务端交换、真实应用会话、撤销、HTTPS Cookie 和开发者白名单。
- TODO(model)：真实 DeepSeek 协议、预算预留与结算、用量及计费持久化；目前不调用上游、不产生模型费用。
- TODO(agent)：加载教学 Skill、上下文及会话偏好；当前每轮新建 Pi Agent，不将历史对话交给模型。
- TODO(tools)：真实资料选择、Worker 解析、受限 ZIP、检索与缓存文本块；模拟来源没有原文件和真实页码。
- TODO(arxiv)：核对旧站版本、入口、最小权限资料接口与幂等计次；目前未改动旧站。
- TODO(session/ui)：多会话、课程进度、资料状态、账号隔离迁移与正式 UI；当前只保存一个内部 Demo 会话。
- TODO(config)：正式环境将限制值统一注入契约；当前工具 6 次/120 秒、服务全局并发 2/同一模拟身份 1 固定在实现中。
- TODO(deploy)：正式域名、反代、进程托管、日志轮转、预算持久化。当前为项目内后台演示进程，未注册系统服务，重启服务器后需手动启动。

模拟授权有效期一小时，保存在服务内存中；重启后需要重新进入。本机记录不含授权 Cookie 或原文件。故障场景故意返回错误，重试同一场景仍会失败，切换正常场景即可恢复。

## 本次验证（2026-11-04）

前端类型检查、2 项契约测试、生产构建及 3 项 Go 测试通过。浏览器确认模拟授权、两次请求/一次 Pi 工具执行、题板作答与来源打开不增加模型请求、停止后无迟到文字且后端活动请求归零、故障重试及恢复、复制、刷新恢复和运行中刷新标中断。已检查桌面 1280px 与窄屏 390px 布局。未进行真实业务或教学效果验收。

交付时服务在项目内后台运行，通过本机 SSH 转发访问。当前进程信息、日志分别位于 `var/run/demo.pid` 和 `var/log/demo.log`；环境检查结果在 `.preflight/environment.json`。这些仅属于本项目，不修改系统进程托管或旧站配置。
