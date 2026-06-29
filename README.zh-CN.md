# ACP on AgentCore

[English](README.md) | **简体中文**

在 **Amazon Bedrock AgentCore Runtime** 上运行 [Agent Client Protocol (ACP)](https://agentclientprotocol.com)
智能体，前端由一个轻量的 Node/TypeScript **ACP-WEB 桥接层**承载，并使用
**IAM (SigV4)** 授权。

打包了三个编码智能体：

| 智能体 | ACP 支持 | 封装方式 |
| --- | --- | --- |
| **Kiro CLI** | 原生 | 直接 spawn（`kiro-cli acp`） |
| **Codex CLI** | 原生（Zed 适配器） | 直接 spawn（`codex acp`） |
| **Claude Code** | **非原生** | 用 [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) 封装，它把 Claude Agent SDK 通过 stdio 暴露成 ACP 智能体 |

## 为什么需要一个桥接层？

ACP 智能体使用 **基于换行分隔的 stdio 上的 JSON-RPC 2.0** 通信——它们本是作为
桌面编辑器的子进程运行的。而 AgentCore Runtime 期望的是一个监听
`0.0.0.0:8080`、暴露 `POST /invocations` 和 `GET /ping` 的 **HTTP 服务**。

**ACP-WEB 桥接层**（`src/`）弥合了这个差异。它是单个 Node/TS 程序，负责：

1. 监听 `:8080`，实现 AgentCore 的 HTTP 契约；
2. **将 ACP 智能体作为子进程 spawn**，并扮演 **ACP 客户端**；
3. 运行 ACP 生命周期（`initialize` → `session/new` → `session/prompt`）；
4. 把流式的 `session/update` 通知作为 **Server-Sent Events (SSE)** 转发回调用方。

```
                 IAM / SigV4                  HTTP :8080                stdio (ACP JSON-RPC)
   调用方  ───────────────────►  AgentCore  ───────────►  ACP-WEB   ───────────────────────►  ACP 智能体
 (签名请求)                       Runtime    /invocations   桥接层      initialize / session/*    子进程
                                              /ping        (本仓库)                            (kiro|codex|claude-acp)
   调用方  ◄───────────────────────────────────────────────────────  session/update + stop 的 SSE 流
```

一套桥接代码 → 三个轻量镜像 → 三个独立的 AgentCore runtime
（`acp_kiro`、`acp_codex`、`acp_claude`），各自拥有独立的 IAM 执行角色作用域。

## 仓库结构

```
src/
  agents.ts        注册表：如何 spawn 每个 ACP 智能体（环境变量驱动）
  bridge.ts        ACP 客户端：spawn 子进程，驱动 initialize/session/prompt
  server.ts        AgentCore HTTP 契约：/invocations (SSE) + /ping；逐 turn 编排
  config.ts        集中式环境配置（skills / 凭据 / 存储开关）
  skills.ts        构造注入给 Claude 的 _meta.claudeCode.options（plugins/skills）
  credentials.ts   通过 sts:AssumeRole + session policy 派生每用户 scoped 凭据（B 层）
  sessionstore.ts  每用户/会话工作区布局 + 可选归档/恢复
docker/
  Dockerfile.kiro     自包含桥接层 + Kiro CLI
  Dockerfile.codex    自包含桥接层 + Codex CLI
  Dockerfile.claude   自包含桥接层 + claude-agent-acp + AWS CLI + 数据分析 skills
iam/
  trust-policy.json                    AgentCore 担任执行角色
  execution-role-policy.json           ECR 拉取、日志、Bedrock 调用（Claude 用）
  skills-data-analytics-policy.json    最小权限 Athena/Glue/S3/S3Tables/S3Vectors（A 层）
  per-user-session-policy.template.json  每用户 STS session policy 参考（B 层）
  caller-invoke-policy.json            调用方调用 runtime 所需的权限
deploy/
  config.env.template     复制为 config.env；设置 AGENT、region、model、skills/存储开关
  00_setup_iam.sh         创建/更新共享执行角色（+ skills 策略）
  01_build_and_push.sh    buildx → ECR (arm64)
  02_deploy_agentcore.sh  创建/更新 AgentCore runtime（IAM 授权、会话存储）
  deploy_all.sh           对单个 agent 执行 00 → 01 → 02
  invoke.sh               SigV4 签名的测试调用
  cleanup.sh              删除 runtime（+ 可选 ECR/IAM）
docs/
  DESIGN.md               Skills + IAM + 会话持久化设计
examples/
  glue-semantic-search/   用 skills 做 Glue 语义搜索（已验证）
  concurrency-test/        多用户并发隔离测试（已验证）
```

编号脚本沿用 AWS
[`sample-claude-code-web-agent-on-bedrock-agentcore`](https://github.com/aws-samples/sample-claude-code-web-agent-on-bedrock-agentcore)
的部署约定（`config.env` + 有序步骤）。

## 授权：IAM / SigV4

本项目**端到端全程使用 IAM 授权**——没有 API key，没有 OAuth。

- **入站（调用方 → runtime）。** `02_deploy_agentcore.sh` 在创建 runtime 时
  故意省略 `--authorizer-configuration`。按 AgentCore 契约，这会让 runtime
  默认强制 **SigV4 签名（IAM）请求**。未签名/未授权的调用会在到达容器**之前**
  就收到 `403 ACCESS_DENIED`——桥接层只会看到已授权的流量，因此其中没有任何
  鉴权代码。调用方需要 `bedrock-agentcore:InvokeAgentRuntime`
  （`iam/caller-invoke-policy.json`）。
- **Runtime → AWS。** AgentCore 担任**执行角色**（`iam/trust-policy.json`）来
  拉取 ECR 镜像和写日志。
- **Claude → 模型。** Claude 适配器对接 **Amazon Bedrock**
  （`CLAUDE_CODE_USE_BEDROCK=1`），因此模型访问由执行角色的
  `bedrock:InvokeModel*` 权限授权——同样是纯 IAM。

## AWS 数据分析 skills（Claude）

Claude 镜像内置了 [`aws-data-analytics`](https://github.com/aws/agent-toolkit-for-aws/tree/main/plugins/aws-data-analytics)
插件——涵盖 Athena、Glue、S3、S3 Tables、S3 Vectors、OpenSearch 的 8 个 skill。
这些 skill 通过镜像内置的 **AWS CLI** 执行，因此默认无需额外的 MCP server。
桥接层通过注入 `_meta.claudeCode.options`（`plugins` + `skills`）按会话启用它们，
适配器会将其透传给 Claude Agent SDK。

- **权限（A 层，默认）。** `iam/skills-data-analytics-policy.json` 授予执行角色
  最小权限的 Athena/Glue/S3/S3Tables/S3Vectors。通过 `config.env` 占位符
  （`DATA_BUCKET`、`ATHENA_WORKGROUP`、`GLUE_DB_PREFIX`、`ATHENA_RESULTS_BUCKET`）
  将其收窄到你的桶/数据库/workgroup。
- **每用户 scoped（B 层，可选）。** 设置 `PER_USER_CREDS=true`。桥接层读取
  `X-Amzn-Bedrock-AgentCore-Runtime-User-Id` 头，并对执行角色调用
  `sts:AssumeRole`，附加运行时生成的、作用域锁定到 `users/<userId>/*` 的
  **session policy**——数据访问只会收窄、绝不放宽。assume-role 失败时回退到
  执行角色。
- **可选 aws-mcp。** `ENABLE_AWS_MCP=true` 会加入 `aws-mcp` server（并向镜像
  加装 `uv`）以提供沙箱化/审计化的 CLI 执行。默认关闭。

## 会话持久化与 checkpoint（Claude）

多用户会话使用 **AgentCore Managed Session Storage**（`ENABLE_SESSION_STORAGE=true`，
挂载于 `/mnt/workspace`）。每个 turn 桥接层会解析出一个每用户/会话的工作区：

```
/mnt/workspace/<userId>/<sessionId>/
  workspace/       Claude 的 cwd（可编辑、可 git）
  claude-config/   CLAUDE_CONFIG_DIR — 用于 session/load 续接的对话 .jsonl
  .acp-meta.json   上一次的 SDK session id（驱动跨 turn 续接）
```

- **Checkpoint = 用同一个 `runtime-session-id` 再次 invoke。** 文件、`.git`、
  已安装依赖在 stop/resume 间保留；对话通过 ACP `session/load` 续接。
- ⚠️ Managed Session Storage 是**服务托管、非长期持久**的：在**闲置 14 天**后
  或**runtime 版本更新**时会重置，且无客户可访问的备份。
- **可选长期归档。** 设置 `ARCHIVE_BUCKET=<你的桶>`，桥接层会在每个 turn 后
  把会话 `aws s3 sync` 到你自己的桶，并在托管存储为空时从中恢复。默认关闭。
  （见 `docs/DESIGN.md §3.6`。）

## 前置条件

- Node.js ≥ 20，带 `buildx` 的 Docker（用于 arm64 构建）
- AWS CLI v2，含 `bedrock-agentcore` 和 `bedrock-agentcore-control` 命令
- 一个启用了 ECR 的账户，且凭据有权限创建 IAM 角色、ECR 仓库和 AgentCore runtime
- 镜像构建所需的各 agent CLI：
  - **Codex**：在 `Dockerfile.codex` 中从 npm 安装
  - **Claude**：适配器是桥接层的 npm 依赖
  - **Kiro**：`Dockerfile.kiro` 下载官方 aarch64 Linux 构建包
    （`kirocli-aarch64-linux.zip`）；无 npm 包。可用 `KIRO_DOWNLOAD_URL`
    构建参数覆盖版本。**注意：** Kiro 需要一次性的浏览器登录——无头鉴权见下方
    注意事项。

## 本地开发

```bash
npm install
npm run build

# 用任意 ACP 智能体冒烟测试桥接层。以 Codex 为例：
AGENT_ID=codex CODEX_BIN=codex node dist/server.js
# 在另一个 shell 里：
curl -s localhost:8080/ping
curl -N -X POST localhost:8080/invocations \
  -H 'content-type: application/json' \
  -d '{"prompt":"List the files in this repo"}'
```

`npm run dev` 通过 `tsx` 以热重载方式运行桥接层。

## 部署（按 agent）

```bash
# 0. 配置
cp deploy/config.env.template deploy/config.env
# 编辑 deploy/config.env：设置 AGENT (kiro|codex|claude)、AWS_REGION、model。
# AWS_ACCOUNT_ID 留空则通过 STS 自动探测。

# 一键：IAM 角色 -> 构建/推送 arm64 镜像 -> 创建 runtime
./deploy/deploy_all.sh claude

# ……或逐步执行（agent 参数会覆盖 config.env 里的 AGENT）：
./deploy/00_setup_iam.sh                 # 一次性的共享执行角色
./deploy/01_build_and_push.sh claude     # buildx arm64 镜像 -> ECR
./deploy/02_deploy_agentcore.sh claude   # 创建/更新 runtime（IAM/SigV4）

# 调用（用你的 AWS 凭据做 SigV4 签名）
./deploy/invoke.sh claude "Explain what this repo does"

# 拆除
./deploy/cleanup.sh claude --ecr
```

对 `codex` 和 `kiro` 重复以上步骤即可拉起全部三个 runtime。

> **关于在本地构建 arm64。** AgentCore 要求 ARM64 镜像。在 x86_64 主机上你需要
> `docker buildx` 加 QEMU 模拟：
> `docker run --rm --privileged tonistiigi/binfmt --install arm64`。构建脚本会
> 自动创建一个 `docker-container` 的 buildx builder。

## 请求 / 响应格式

**请求**（`POST /invocations`，`application/json`）：

```json
{ "prompt": "你的指令", "cwd": "/可选/绝对/工作目录" }
```

`prompt` 也可以是原始的 ACP 内容块数组
（`[{"type":"text","text":"..."}]`），用于图片/资源。

**响应**（`text/event-stream`）：一串规范化的 ACP 事件，例如：

```
data: {"type":"session_update","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"..."}}}
data: {"type":"session_update","update":{"sessionUpdate":"tool_call","toolCallId":"call_1","status":"pending","title":"Edit file"}}
data: {"type":"stop","stopReason":"end_turn"}
```

## 配置（环境变量）

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `AGENT_ID` | `claude` | 桥接层 spawn 哪个 agent（`kiro`/`codex`/`claude`） |
| `PORT` | `8080` | HTTP 监听端口（AgentCore 要求 8080） |
| `ACP_PERMISSION_MODE` | `allow` | `allow` 自动批准工具权限请求；`reject` 拒绝 |
| `KIRO_BIN` / `KIRO_ACP_ARGS` | `kiro-cli` / `acp` | Kiro 启动命令 |
| `CODEX_BIN` / `CODEX_ACP_ARGS` | `codex` / `acp` | Codex 启动命令 |
| `CLAUDE_ACP_BIN` / `CLAUDE_ACP_ARGS` | `claude-agent-acp` / `` | Claude 适配器启动命令 |
| `ENABLE_AWS_DATA_SKILLS` | `true`（Claude 镜像内） | 是否注入数据分析 skills |
| `SKILL_SCOPE` | `all` | `all` 或逗号分隔的 skill 白名单 |
| `ENABLE_AWS_MCP` | `false` | 是否注入可选的 aws-mcp（需镜像装 uv） |
| `PER_USER_CREDS` | `false` | 是否按用户派生 scoped 凭据（B 层） |
| `ENABLE_SESSION_STORAGE` | `true` | 是否启用 AgentCore Managed Session Storage |
| `SESSION_STORAGE_MOUNT` | `/mnt/workspace` | 会话存储挂载路径 |
| `ARCHIVE_BUCKET` | （空） | 可选的长期归档桶（你自己的 S3） |

## 示例

- [`examples/glue-semantic-search/`](examples/glue-semantic-search/README.md) ——
  部署后的 Claude runtime 用 `aws-data-analytics` skills 对 Glue 数据目录做
  自然语言语义搜索（已在真实环境验证）。
- [`examples/concurrency-test/`](examples/concurrency-test/README.md) ——
  多用户并发隔离测试：并行发起多个不同 session-id 的调用，证明各自隔离、
  SSE 不串台（N=4、N=8 均已验证通过）。

## 注意事项

- **权限处理。** 由于 AgentCore 无人值守运行，桥接层默认自动批准工具调用的
  权限请求（`ACP_PERMISSION_MODE=allow`）。设为 `reject` 可获得只读姿态，或
  扩展 `bridge.ts` 把权限提示转发给调用方。
- **多用户隔离。** 跨用户隔离由 **AgentCore 保证**：每个 `runtime-session-id`
  会被路由到独立的 microVM（独立的算力/内存/文件系统，用完销毁并清零）。
  **但 AgentCore 不强制 session-to-user 映射——你的客户端后端必须为每个用户
  分配唯一的 session-id。** 同一 session-id 上的并发请求会进入同一 microVM，
  桥接层一次处理一个 turn（详见 `examples/concurrency-test/README.md`）。
- **Kiro CLI 鉴权。** Kiro 需要一次性的**浏览器登录**，对无头环境不友好。在
  无人值守容器中你必须带外提供凭据——例如把 Kiro 的 auth token
  （`~/.kiro` / `~/.aws/sso` 缓存）烤进镜像或挂载进去，或使用支持通过环境变量
  传 token 的 Kiro 构建。镜像已安装 `kiro-cli` 并接好 `kiro-cli acp`；唯一需要
  手动处理的就是鉴权材料。
```
