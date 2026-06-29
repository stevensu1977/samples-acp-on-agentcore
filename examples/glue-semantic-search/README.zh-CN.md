# 示例：通过 aws-data-analytics skills 实现 Glue 语义搜索

[English](README.md) | **简体中文**

本示例演示部署后的 **Claude on AgentCore** runtime 回答关于 AWS Glue 数据目录的
自然语言数据发现问题——完全由内置的 [`aws-data-analytics`](https://github.com/aws/agent-toolkit-for-aws/tree/main/plugins/aws-data-analytics)
skills 驱动，全程 **IAM/SigV4** 鉴权。

它相当于手写 Glue Discovery API 脚本的 skill 化版本：你不再去教脚本如何调用
`search-tables` / `get-asset`，而是用自然语言提问（"哪些表包含 PII？"），由 skill
自己选择 API、在实验性 Discovery API 不可用时降级，并汇总结果。

## 用到哪些 skill

| 意图 | Skill | 示例 prompt |
| --- | --- | --- |
| 查找*特定*资产（语义/模糊） | `finding-data-lake-assets` | "哪些表包含客户 PII，比如 email 或 phone？" |
| 盘点/审计*整个*目录 | `exploring-data-catalog` | "给我整个 Glue 目录的审计报告" |

两者在可用时都会调用 Glue **Discovery API**（`search-assets` / `get-asset` /
`list-iterable-forms` / `batch-get-iterable-forms`），否则降级到传统的
`search-tables` / `get-tables` 工作流。

## 前置条件

1. 已部署并启用 skills 的 Claude runtime：
   `./deploy/00_setup_iam.sh && ./deploy/01_build_and_push.sh claude && ./deploy/02_deploy_agentcore.sh claude`
2. 执行角色的 skills 策略包含 Glue Discovery + 目录相关 action
   （`iam/skills-data-analytics-policy.json` —— `SearchAssets`、`GetAsset`、
   `ListIterableForms`、`BatchGetIterableForms`、`GetCatalogs`、`CreateTable`
   等）。编辑策略后重新执行 `00_setup_iam.sh`。
3. 你的本地身份有权限创建 Glue 数据库/表（用于建演示数据）。

## 运行

```bash
cd examples/glue-semantic-search

# 1. 创建演示目录（1 个库、3 张带丰富描述的表）
AWS_REGION=us-east-1 ./setup_demo_data.sh

# 2. 向部署后的 Claude runtime 提语义搜索问题
./run_test.sh pii      # -> finding-data-lake-assets
./run_test.sh audit    # -> exploring-data-catalog
./run_test.sh "which table stores order payment methods?"   # 自定义

# 3. 清理演示目录
AWS_REGION=us-east-1 ./cleanup.sh
```

`run_test.sh` 通过 SigV4（经由 `deploy/invoke.sh`）调用 runtime，并解析 SSE 流，
打印：调用了哪个 skill、skill 跑了哪些 AWS CLI 命令、最终答案。

## 已验证结果（us-east-1）

**`./run_test.sh pii`** →

- Skill：`aws-data-analytics:finding-data-lake-assets`
- skill 执行的命令：
  ```
  aws sts get-caller-identity --region us-east-1
  aws glue search-tables --region us-east-1 --search-text "email"
  aws glue search-tables --region us-east-1 --search-text "phone"
  aws glue get-databases --region us-east-1
  aws glue get-tables --region us-east-1 --database-name demo_ecommerce
  aws glue get-table  --region us-east-1 --database-name demo_ecommerce --name customers
  ```
- 答案：正确识别出 `customers` 是 PII 表（email、phone、name），并引用了
  `pii_columns` 参数和列注释。

**`./run_test.sh audit`** →

- Skill：`aws-data-analytics:exploring-data-catalog`
- 命令：`get-catalogs --recursive`、`get-databases`、`get-tables`、
  `s3tables list-table-buckets`。
- 答案：完整盘点 1 个数据库 / 3 张表，含业务域、数据所有者、分区，以及每张表的
  列级概览。

## 注意事项（实测观察）

- **Discovery API 是否可用取决于 CLI 版本。** 容器的 AWS CLI（2.35.11）*确实*
  包含 `search-assets` / `get-asset`，但每个 skill 会先用 `aws glue get-asset help`
  探测。在 slim 镜像上该 `help` 调用会失败（缺 man 渲染器），于是 skill
  **优雅降级**到传统的 `search-tables` / `get-tables` 路径——结果依然正确。若要
  真正用上 Discovery `search-assets` 语义层，需确保镜像里 `aws glue get-asset help`
  能成功（例如安装 `groff`）或调整 skill 的探测方式。
- 演示表背后没有 S3 数据；本示例验证的是**目录/元数据发现**，而非 Athena 查询执行。
- 全程 IAM/SigV4 鉴权；skill 的 AWS 调用使用 AgentCore 执行角色（A 层）。当
  `PER_USER_CREDS=true` 时则改用每用户 scoped 凭据。
