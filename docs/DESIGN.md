# 设计评审稿：为 Claude Code 增加 aws-data-analytics skills、权限与多用户持久化

状态：**草案（待评审）**
范围：仅 `claude` 这一路 agent（Kiro/Codex 不在本设计内，但持久化与权限机制可复用）。

本文回应三个需求：

1. 给 Claude Code 接入 [`aws/agent-toolkit-for-aws` 的 `aws-data-analytics`](https://github.com/aws/agent-toolkit-for-aws/tree/main/plugins/aws-data-analytics) 全部 8 个 skill。
2. 为这些 skill 配置合适的 AWS 权限（共享执行角色打底 + 每用户 scoped 凭据可选）。
3. 多用户 session / checkpoint 持久化（采用 **AgentCore 原生 Managed Session Storage**，不使用 FUSE / S3 Mountpoint）。

---

## 0. 关键调研结论（决定设计取舍）

| # | 结论 | 来源 |
|---|---|---|
| R1 | `aws-data-analytics` 含 8 个 skill + 1 个 `aws-mcp` MCP server（依赖 `uv`）。涉及 AWS namespace：`athena`、`glue`、`s3`、`s3tables`、`s3vectors`、`opensearch`。 | 插件 README |
| R2 | `claude-agent-acp` 适配器运行 SDK 时固定设 `settingSources:["user","project","local"]`，并把 `_meta.claudeCode.options` **整体 spread** 进 SDK options。`cwd`/`mcpServers`/`env`/`tools`/`disallowedTools` 会被适配器**显式覆盖**，但 `plugins`/`skills`/`additionalDirectories` 等字段**原样透传**。 | 读源码 `acp-agent.js:2407-2522` |
| R3 | 底层 `@anthropic-ai/claude-agent-sdk` 原生支持 `skills: string[]\|'all'` 与本地 `plugins:[{type:'local',path}]`。 | `sdk.d.ts:1682,1857` |
| R4 | 适配器声明 `loadSession:true`，`session/new` 携带 `resume: params.sessionId` 可续接 SDK 会话；对话记录存于 `CLAUDE_CONFIG_DIR/projects/<proj>/<sdkSessionId>.jsonl`。 | `acp-agent.js:414,438,2278` |
| R5 | 容器内 boto3/CLI 自动通过容器凭据端点取得**执行角色**临时凭据；skill 的 AWS 调用默认即用该身份。 | AgentCore 运行时 |
| R6 | **AgentCore 原生 Managed Session Storage**：`--filesystem-configurations '[{"sessionStorage":{"mountPath":"/mnt/workspace"}}]'`，挂载点完整 POSIX（read/write/rename/mkdir/symlink/git/npm/pip 均可），同一 `runtime-session-id` resume 时文件原样恢复。**无需 VPC、无需额外 IAM、无需挂载代码。** | [filesystem-configurations 文档](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-filesystem-configurations.html) |
| R7 | S3 Mountpoint（FUSE）在 AgentCore 托管容器内**不可行**（拿不到 FUSE 特权），且不支持随机写/rename，与 Claude 工作目录不兼容。已被 R6 取代。 | Mountpoint README + R6 |
| R8 | Managed Session Storage 约束：挂载路径须 `/mnt/` 下恰好一级；**挂载仅在 invoke 时可用，初始化阶段不可用**；14 天闲置过期、版本更新重置；每 runtime 最多 1 个 sessionStorage、5 个挂载总数。**它是 AgentCore 服务托管的存储（存于 AgentCore 自有 S3 `acr-storage-*`，客户不可直接访问）；一旦因闲置/版本更新被重置，数据无法恢复、无客户可访问的备份。** | filesystem 文档 |
| R9 | skill 主要通过 **AWS CLI** 调用（如 `aws athena start-query-execution`、`aws sts get-caller-identity`），不用 boto3 脚本。`aws-mcp` 是**可选**封装（其工具 `aws___call_aws(command="aws ...")` 本质就是把同样的 CLI 命令包一层做沙箱/审计/成本追踪）；SKILL.md 明确"MCP 不可用时同样的 CLI 命令直接可用"，且 `.claude-plugin/plugin.json` **未声明任何 mcpServers**。 | 实测 `querying-data-lake/SKILL.md` + `plugin.json` |

> R8 的"挂载仅在 invoke 时可用"是硬约束：bridge **不能**在容器启动（warm start）时就把工作目录定位到 `/mnt/workspace`，必须在收到 `/invocations` 时再创建/定位会话目录。

---

## 1. 需求一：接入 aws-data-analytics skills

### 1.1 方案：构建期 baked-in，运行期全量启用

镜像内固定路径预装插件，运行期通过 `_meta` 注入启用。理由：符合 AgentCore 不可变部署模型、启动快、可复现（对比"运行期从 S3 拉取 skill"——镜像小但每次启动有延迟且引入额外依赖）。

### 1.2 镜像改动（`docker/Dockerfile.claude`）

```dockerfile
# 1) 安装 AWS CLI（skill 的核心依赖，R9）+ git。
#    uv/python 仅在开启可选 aws-mcp 时需要 —— 默认 MVP 不装。
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip git ca-certificates \
    && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscliv2.zip /var/lib/apt/lists/* \
    && aws --version

# 2) 预装插件到固定路径
ARG AWS_TOOLKIT_REF=main
RUN git clone --depth 1 --branch "${AWS_TOOLKIT_REF}" \
      https://github.com/aws/agent-toolkit-for-aws /tmp/toolkit \
    && mkdir -p /opt/aws-plugins \
    && cp -r /tmp/toolkit/plugins/aws-data-analytics /opt/aws-plugins/aws-data-analytics \
    && rm -rf /tmp/toolkit

ENV AWS_DATA_ANALYTICS_PLUGIN=/opt/aws-plugins/aws-data-analytics
```

> 插件含标准 `.claude-plugin/plugin.json`（已实测），故用 `plugins:[{type:'local',path}]` 注册即可。
> **aws-mcp 为可选**（`ENABLE_AWS_MCP=true` 时才在镜像里加装 `uv` 并注入该 MCP server）；默认仅靠 AWS CLI，skill 即可工作（R9）。

### 1.3 bridge 注入（`src/bridge.ts` 的 `newSession`）

当前 `runPrompt` 调用 `conn.newSession({cwd, mcpServers:[]})`。改为：

```ts
const session = await conn.newSession({
  cwd,
  mcpServers: [],
  _meta: {
    claudeCode: {
      options: {
        // R2/R3：plugins、skills 原样透传给 SDK
        plugins: enablePlugins
          ? [{ type: "local", path: process.env.AWS_DATA_ANALYTICS_PLUGIN }]
          : [],
        skills: skillScope,            // 'all' | string[]（见 config）
        // aws-mcp 可选：仅当 ENABLE_AWS_MCP=true 才注入；否则 skill 走 AWS CLI（R9）
        ...(enableAwsMcp ? { mcpServers: { "aws-mcp": { command: "uvx", args: ["aws-mcp"] } } } : {}),
        additionalDirectories: [process.env.AWS_DATA_ANALYTICS_PLUGIN],
      },
    },
  },
});
```

配置项（`config.env` / 环境变量）：

| 变量 | 默认 | 含义 |
|---|---|---|
| `ENABLE_AWS_DATA_SKILLS` | `true`（claude 镜像内） | 是否注入插件 |
| `SKILL_SCOPE` | `all` | `all` 或逗号分隔白名单（如 `querying-data-lake,exploring-data-catalog`） |
| `AWS_DATA_ANALYTICS_PLUGIN` | `/opt/aws-plugins/aws-data-analytics` | 插件路径 |
| `ENABLE_AWS_MCP` | `false` | 是否注入可选 aws-mcp（需镜像装 uv）；默认仅用 AWS CLI |

本需求确认：**启用全部 8 个**（`SKILL_SCOPE=all`）。白名单能力保留以便将来收窄。

---

## 2. 需求二：权限（A 打底 + B 可选开关）

### 2.1 A 层：共享执行角色最小权限（默认开启）

给 `AcpOnAgentCoreExecutionRole` 追加 inline policy `iam/skills-data-analytics-policy.json`。所有用户共享此身份，适合单租户/内部团队。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AthenaQuery",
      "Effect": "Allow",
      "Action": [
        "athena:StartQueryExecution", "athena:GetQueryExecution",
        "athena:GetQueryResults", "athena:StopQueryExecution",
        "athena:GetWorkGroup", "athena:ListWorkGroups",
        "athena:GetDataCatalog", "athena:ListDataCatalogs"
      ],
      "Resource": [
        "arn:aws:athena:${REGION}:${ACCOUNT}:workgroup/${ATHENA_WORKGROUP}",
        "arn:aws:athena:${REGION}:${ACCOUNT}:datacatalog/*"
      ]
    },
    {
      "Sid": "GlueCatalogRead",
      "Effect": "Allow",
      "Action": [
        "glue:GetDatabase", "glue:GetDatabases", "glue:GetTable",
        "glue:GetTables", "glue:GetPartition", "glue:GetPartitions",
        "glue:SearchTables", "glue:GetConnection", "glue:GetConnections"
      ],
      "Resource": [
        "arn:aws:glue:${REGION}:${ACCOUNT}:catalog",
        "arn:aws:glue:${REGION}:${ACCOUNT}:database/${GLUE_DB_PREFIX}*",
        "arn:aws:glue:${REGION}:${ACCOUNT}:table/${GLUE_DB_PREFIX}*/*",
        "arn:aws:glue:${REGION}:${ACCOUNT}:connection/*"
      ]
    },
    {
      "Sid": "S3DataAndAthenaResults",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:ListBucket", "s3:PutObject"],
      "Resource": [
        "arn:aws:s3:::${DATA_BUCKET}", "arn:aws:s3:::${DATA_BUCKET}/*",
        "arn:aws:s3:::${ATHENA_RESULTS_BUCKET}", "arn:aws:s3:::${ATHENA_RESULTS_BUCKET}/*"
      ]
    },
    {
      "Sid": "S3TablesAndVectors",
      "Effect": "Allow",
      "Action": ["s3tables:*", "s3vectors:*"],
      "Resource": "*",
      "Condition": { "StringEquals": { "aws:ResourceAccount": "${ACCOUNT}" } }
    }
  ]
}
```

> `s3tables`/`s3vectors` 资源级 ARN 形态较新，先用账号条件兜底，实现期按需收窄。OpenSearch 权限按需追加（默认不开 `amazon-opensearch-service` 写操作）。占位符由 `config.env` 渲染。

### 2.2 B 层：每用户 scoped 临时凭据（可选开关）

**已定：采用方式一 —— 同一执行角色 + STS session policy 动态收窄**（零预建，加新用户无需任何 IAM 操作；权限 = 执行角色 ∩ session policy 的交集）。不采用"每租户独立角色"（强边界但需预建 N 个角色、受账号角色数上限约束）；待出现强合规/审计或 per-tenant 差异化权限需求时再升级，B 层接口设计为可切换以免返工。

`config.env` 设 `PER_USER_CREDS=true` 时启用。多租户场景用于防止 prompt 注入越界到他人数据。

机制（bridge 在驱动 skill 前）：

1. 从 HTTP 头读 `X-Amzn-Bedrock-AgentCore-Runtime-User-Id`（调用方经 `--runtime-user-id` 传入）。
2. bridge 用执行角色凭据调用 `sts:AssumeRole`（目标=**同一执行角色**），附加运行时生成的 **session policy**（按 `userId` 拼前缀）把权限收窄：
   - `s3:prefix` / 对象 ARN 锁到 `users/<userId>/*`；
   - Athena workgroup 限定到共享只读 workgroup（或 `wg-<userId>`）；
   - Glue 只读。
3. 把派生出的 `AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN` 通过 `_meta.claudeCode.options.env` 注入 SDK 子进程（R2 确认 `env` 会与 `process.env` 合并）。
4. 凭据随 turn 生命周期，过期即弃。

> 执行角色信任策略需允许自我 AssumeRole（`Principal` 含角色自身 ARN），且执行角色需有 `sts:AssumeRole` 权限。

关闭时（默认）：不 AssumeRole，skill 直接用执行角色（A 层）。

新增 `iam/per-user-session-policy.template.json` 提供 session policy 模板（按 `userId` 渲染）。

---

## 3. 需求三：多用户 session / checkpoint（Managed Session Storage）

### 3.1 方案：AgentCore 原生 Managed Session Storage（不用 FUSE/Mountpoint，不手动同步 S3）

依据 R6/R7/R8。这是文档为"coding agent 持久工作区"和"长跑分析 + checkpoint"明确推荐的配置。

### 3.2 部署改动（`deploy/02_deploy_agentcore.sh`）

`create-agent-runtime`/`update-agent-runtime` 增加：

```bash
--filesystem-configurations '[{"sessionStorage":{"mountPath":"/mnt/workspace"}}]'
```

无需 VPC、无需额外 IAM（R6）。`config.env` 增 `SESSION_STORAGE_MOUNT=/mnt/workspace`、`ENABLE_SESSION_STORAGE=true`。

### 3.3 运行期目录布局与 bridge 行为

```
/mnt/workspace/                         ← AgentCore 按 runtime-session-id 隔离 + 持久化
  <userId>/<sessionId>/
    workspace/                          ← Claude 的 cwd（可编辑、可 git）
    claude-config/                      ← CLAUDE_CONFIG_DIR：projects/<proj>/<sdkSessionId>.jsonl
    .acp-meta.json                      ← 记录上次 sdkSessionId，用于 session/load 续接
```

bridge 在收到 `/invocations` 时（**不能在 warm start 时做**，R8）：

```
userId    = header[X-Amzn-...-Runtime-User-Id]  ?? "default"
sessionId = header[X-Amzn-...-Runtime-Session-Id] ?? <mint>
base      = /mnt/workspace/<userId>/<sessionId>
cwd       = base/workspace            (mkdir -p)
CLAUDE_CONFIG_DIR = base/claude-config (mkdir -p；通过 _meta.env 或进程环境传入)

读 base/.acp-meta.json：
  若存在 lastSdkSessionId → newSession 携带该 id（适配器 resume，R4）续接上下文
  否则 → 全新 session
跑 prompt → 流式 SSE
turn 结束：把本次 sdkSessionId 写回 .acp-meta.json
（无需手动 sync：AgentCore 异步复制到 durable storage；stop/resume 自动恢复，R6）
```

要点：
- **checkpoint = 用同一 `runtime-session-id` 再次 invoke**。文件、`.git`、已装依赖原样还在（R6 示例验证）。
- 工作目录支持完整 POSIX，git/npm/pip 正常（R6）。
- bridge 的 warm-start `start()` 仍可预热 ACP 子进程，但**会话目录的定位推迟到首个 `/invocations`**。

### 3.4 跨用户共享数据（可选，后续）

若 skill 要查询大体积共享数据集，可叠加 **S3 Files 访问点**（`/mnt/datasets`，只读）。需 `networkMode=VPC` + 子网/SG/access-point + 执行角色 `s3files:ClientMount/GetAccessPoint`。本期不实现，列为后续；会单独提供 VPC/SG/access-point 脚本。

### 3.5 生命周期注意（重要）

- Managed Session Storage 是 **AgentCore 服务托管存储**（存于 AgentCore 自有 S3，客户不可直接访问，R8）。
- **一旦因 14 天闲置过期或 runtime 版本更新被重置，数据无法恢复，无客户可访问的备份**（R8）。它是"会话级临时持久化"，**不是长期归档**。
- 日常 stop/resume 续接由它无缝处理，无需我们做任何同步。

### 3.6 可选长期归档（ARCHIVE_BUCKET，默认关闭）

仅当确有"产出需留存超过 14 天"或"会频繁更新镜像导致存储被重置"的需求时启用。它是**你自己账号里的独立 S3 桶**，与 §3.5 的托管存储是两套东西。

`config.env` 设 `ARCHIVE_BUCKET=my-bucket` 时，bridge 增加两段逻辑：

```
turn 结束（归档）：
  aws s3 sync /mnt/workspace/<userId>/<sessionId>/  s3://${ARCHIVE_BUCKET}/<userId>/<sessionId>/
  （含 workspace/ 与 claude-config/ 的 jsonl）

/invocations 开始时（恢复）：
  若 /mnt/workspace/<userId>/<sessionId>/ 为空（被重置）但归档存在：
    aws s3 sync s3://${ARCHIVE_BUCKET}/<userId>/<sessionId>/  /mnt/workspace/<userId>/<sessionId>/
    → 重建工作目录后照常 session/load 续接
```

权衡与限制（务必知晓）：
- **能加载回来，但要靠 bridge 自己实现归档/恢复**，不是 AgentCore 自动的（本质是我们用你的 S3 桶补了一层长期持久化）。
- 文件（代码、`.git`、数据）能完整恢复；对话 jsonl 同样归档，跨长时间/跨镜像版本的 `session/load` 续接存兼容风险，稳妥按"恢复工作目录，对话可重新开始但能看到历史文件"对待。
- 每个 turn 多一次 S3 同步的延迟与成本。
- 执行角色需对 `ARCHIVE_BUCKET` 有 `s3:GetObject/PutObject/ListBucket/DeleteObject`。
- 替代方案：叠加 BYO 的 S3 Files/EFS（永久、需 VPC，见 §3.4）。

---

## 4. 改动清单（实现时）

| 文件 | 改动 |
|---|---|
| `docker/Dockerfile.claude` | 装 **AWS CLI**(aarch64)+git；clone 插件到 `/opt/aws-plugins`；设相关 ENV（uv 仅在 `ENABLE_AWS_MCP` 时装） |
| `src/server.ts` | 读 `X-Amzn-...-Runtime-User-Id` 头并下传；会话目录定位推迟到 `/invocations` |
| `src/bridge.ts` | `newSession` 注入 `_meta.claudeCode.options`（plugins/skills/可选 mcpServers/additionalDirectories/env）；per-user cwd & `CLAUDE_CONFIG_DIR`；读写 `.acp-meta.json` 实现 `session/load` 续接；B 层 STS 派生凭据；可选 ARCHIVE 归档/恢复 |
| `src/agents.ts` / `config.env.template` | 新增 `ENABLE_AWS_DATA_SKILLS`/`SKILL_SCOPE`/`ENABLE_AWS_MCP`/`PER_USER_CREDS`/`ENABLE_SESSION_STORAGE`/`SESSION_STORAGE_MOUNT`/`ARCHIVE_BUCKET` 等 |
| `deploy/02_deploy_agentcore.sh` | 增 `--filesystem-configurations`（sessionStorage） |
| `deploy/00_setup_iam.sh` | 附加 `iam/skills-data-analytics-policy.json`；（可选）渲染 ARCHIVE_BUCKET 权限 |
| `iam/skills-data-analytics-policy.json` | 新增（A 层） |
| `iam/per-user-session-policy.template.json` | 新增（B 层，可选） |
| `README.md` / 本文 | 文档同步 |

---

## 5. 评审决议（已拍板）

1. **插件目录形态** ✅ 已实测含标准 `.claude-plugin/plugin.json` → 用 `plugins:[{type:'local',path}]` 注册。
2. **aws-mcp** ✅ skill 主用 AWS CLI（R9），aws-mcp 降级为可选（`ENABLE_AWS_MCP`，默认关）。镜像默认只装 AWS CLI。
3. **会话目录键** ✅ 纳入 `userId`：`/mnt/workspace/<userId>/<sessionId>/`。
4. **B 层目标角色** ✅ 方式一：同执行角色 + STS session policy 动态收窄（零预建）；接口可切换以便将来升级到 per-tenant 角色。
5. **归档策略** ✅ `ARCHIVE_BUCKET` 默认关闭、做成可选开关（§3.6）；并在 §3.5 写明原生托管存储被重置后不可恢复。

> 实现期仅剩待核对项：插件内 skill 目录名与 `SKILL.md` 的 `name` 字段（用于 `SKILL_SCOPE` 白名单）、aws-mcp 的确切启动命令（仅在开启时需要）。

---

## 6. 安全性小结

- 入站仍是 **IAM/SigV4**（未签名请求 403，已验证）。
- skill 的 AWS 访问：A 层最小权限执行角色；B 层每用户 session policy 收窄数据边界。
- 持久化：Managed Session Storage 按 session 隔离（文档保证"每 session 只能访问自己的存储"）。
- 不引入 FUSE/特权容器（R7）。
