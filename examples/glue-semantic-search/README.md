# Example: Glue semantic search via aws-data-analytics skills

**English** | [简体中文](README.zh-CN.md)

This example shows the deployed **Claude on AgentCore** runtime answering
natural-language data-discovery questions about an AWS Glue Data Catalog —
driven entirely by the bundled [`aws-data-analytics`](https://github.com/aws/agent-toolkit-for-aws/tree/main/plugins/aws-data-analytics)
skills, with **IAM/SigV4** auth end to end.

It is the skill-based equivalent of hand-writing Glue Discovery API scripts:
instead of teaching a script how to call `search-tables` / `get-asset`, you ask
in plain language ("which tables contain PII?") and the skill picks the APIs,
falls back when the experimental Discovery API is unavailable, and summarizes.

## Which skills

| Intent | Skill | Example prompt |
| --- | --- | --- |
| Find a *specific* asset (semantic/fuzzy) | `finding-data-lake-assets` | "which tables contain customer PII like email or phone?" |
| Inventory / audit the *whole* catalog | `exploring-data-catalog` | "give me an audit of the entire Glue catalog" |

Both call the Glue **Discovery API** (`search-assets` / `get-asset` /
`list-iterable-forms` / `batch-get-iterable-forms`) when available, and fall
back to the traditional `search-tables` / `get-tables` workflow otherwise.

## Prerequisites

1. Claude runtime deployed with skills enabled:
   `./deploy/00_setup_iam.sh && ./deploy/01_build_and_push.sh claude && ./deploy/02_deploy_agentcore.sh claude`
2. The execution role's skills policy includes Glue Discovery + catalog actions
   (`iam/skills-data-analytics-policy.json` — `SearchAssets`, `GetAsset`,
   `ListIterableForms`, `BatchGetIterableForms`, `GetCatalogs`, `CreateTable`,
   …). Re-run `00_setup_iam.sh` after editing the policy.
3. Your local identity can create Glue databases/tables (for demo data).

## Run

```bash
cd examples/glue-semantic-search

# 1. Create the demo catalog (1 db, 3 richly-described tables)
AWS_REGION=us-east-1 ./setup_demo_data.sh

# 2. Ask the deployed Claude runtime semantic-search questions
./run_test.sh pii      # -> finding-data-lake-assets
./run_test.sh audit    # -> exploring-data-catalog
./run_test.sh "which table stores order payment methods?"   # custom

# 3. Tear down the demo catalog
AWS_REGION=us-east-1 ./cleanup.sh
```

`run_test.sh` invokes the runtime over SigV4 (via `deploy/invoke.sh`) and parses
the SSE stream to print: the skill invoked, the AWS CLI commands the skill ran,
and the final answer.

## Verified result (us-east-1)

**`./run_test.sh pii`** →

- Skill: `aws-data-analytics:finding-data-lake-assets`
- Commands the skill ran:
  ```
  aws sts get-caller-identity --region us-east-1
  aws glue search-tables --region us-east-1 --search-text "email"
  aws glue search-tables --region us-east-1 --search-text "phone"
  aws glue get-databases --region us-east-1
  aws glue get-tables --region us-east-1 --database-name demo_ecommerce
  aws glue get-table  --region us-east-1 --database-name demo_ecommerce --name customers
  ```
- Answer: correctly identified `customers` as the PII table (email, phone, name),
  citing the `pii_columns` parameter and column comments.

**`./run_test.sh audit`** →

- Skill: `aws-data-analytics:exploring-data-catalog`
- Commands: `get-catalogs --recursive`, `get-databases`, `get-tables`,
  `s3tables list-table-buckets`.
- Answer: full inventory of the 1 database / 3 tables, with business domains,
  data owners, partitioning, and a column-level overview per table.

## Notes & caveats (observed)

- **Discovery API availability is CLI-version dependent.** The container's AWS
  CLI (2.35.11) *does* include `search-assets` / `get-asset`, but each skill
  first probes with `aws glue get-asset help`. On the slim image that `help`
  invocation fails (no man renderer), so the skills **gracefully fall back** to
  the traditional `search-tables` / `get-tables` path — which still produces
  correct results. To exercise the true Discovery `search-assets` semantic
  layer, ensure `aws glue get-asset help` succeeds in the image (e.g. install
  `groff`) or adjust the skill's probe.
- The demo tables have no S3 data behind them; this example exercises
  **catalog/metadata discovery**, not Athena query execution.
- Auth is IAM/SigV4 throughout; the skills' AWS calls use the AgentCore
  execution role (A layer). With `PER_USER_CREDS=true` they would use per-user
  scoped credentials instead.
