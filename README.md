# ACP on AgentCore

Run [Agent Client Protocol (ACP)](https://agentclientprotocol.com) agents on
**Amazon Bedrock AgentCore Runtime**, fronted by a small Node/TypeScript
**ACP-WEB bridge** and authorized with **IAM (SigV4)**.

Three coding agents are packaged:

| Agent | ACP support | How it's wrapped |
| --- | --- | --- |
| **Kiro CLI** | native | spawned directly (`kiro-cli acp`) |
| **Codex CLI** | native (Zed adapter) | spawned directly (`codex acp`) |
| **Claude Code** | **not native** | wrapped with [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp), which exposes the Claude Agent SDK as an ACP agent over stdio |

## Why a bridge?

ACP agents speak **JSON-RPC 2.0 over newline-delimited stdio** — they are meant
to run as a subprocess of a desktop editor. AgentCore Runtime, on the other
hand, expects an **HTTP service** on `0.0.0.0:8080` exposing `POST /invocations`
and `GET /ping`.

The **ACP-WEB bridge** (`src/`) closes that gap. It is a single Node/TS program
that:

1. listens on `:8080` and implements the AgentCore HTTP contract;
2. **spawns the ACP agent as a subprocess** and acts as an **ACP client**;
3. runs the ACP lifecycle (`initialize` → `session/new` → `session/prompt`);
4. relays streamed `session/update` notifications back to the caller as
   **Server-Sent Events (SSE)**.

```
                 IAM / SigV4                  HTTP :8080                stdio (ACP JSON-RPC)
   caller  ───────────────────►  AgentCore  ───────────►  ACP-WEB   ───────────────────────►  ACP agent
 (signed request)                 Runtime    /invocations   bridge      initialize / session/*    subprocess
                                              /ping         (this repo)                          (kiro|codex|claude-acp)
   caller  ◄───────────────────────────────────────────────────────  SSE stream of session/update + stop
```

One bridge codebase → one base image → three thin agent images → three
independent AgentCore runtimes (`acp_kiro`, `acp_codex`, `acp_claude`), each
with its own IAM execution role scoping.

## Repository layout

```
src/
  agents.ts     Registry: how to spawn each ACP agent (env-driven)
  bridge.ts     ACP client: spawns subprocess, drives initialize/session/prompt
  server.ts     AgentCore HTTP contract: /invocations (SSE) + /ping
docker/
  Dockerfile.base     Builds the bridge (linux/arm64)
  Dockerfile.kiro     base + Kiro CLI
  Dockerfile.codex    base + Codex CLI
  Dockerfile.claude   base + claude-agent-acp adapter (Bedrock-backed)
iam/
  trust-policy.json           AgentCore assumes the execution role
  execution-role-policy.json  ECR pull, logs, Bedrock invoke (for Claude)
  caller-invoke-policy.json   What a caller needs to invoke the runtimes
deploy/
  setup-iam.sh        Create/update the shared execution role
  build-and-push.sh   buildx → ECR (arm64)
  deploy-runtime.sh   create/update the AgentCore runtime (IAM auth)
  invoke.sh           SigV4-signed test invocation
```

## Authorization: IAM / SigV4

This project uses **IAM authorization end to end** — no API keys, no OAuth.

- **Inbound (caller → runtime).** `deploy-runtime.sh` deliberately omits
  `--authorizer-configuration` when creating the runtime. Per the AgentCore
  contract, that makes the runtime enforce **SigV4-signed (IAM) requests** by
  default. Unsigned/unauthorized calls get `403 ACCESS_DENIED` *before* they
  ever reach the container — the bridge only sees pre-authorized traffic, so it
  contains no auth code. Callers need
  `bedrock-agentcore:InvokeAgentRuntime` (`iam/caller-invoke-policy.json`).
- **Runtime → AWS.** AgentCore assumes the **execution role**
  (`iam/trust-policy.json`) to pull the ECR image and write logs.
- **Claude → model.** The Claude adapter runs against **Amazon Bedrock**
  (`CLAUDE_CODE_USE_BEDROCK=1`), so model access is authorized by the execution
  role's `bedrock:InvokeModel*` permissions — again, pure IAM.

## Prerequisites

- Node.js ≥ 20, Docker with `buildx` (for arm64 builds)
- AWS CLI v2 with the `bedrock-agentcore` and `bedrock-agentcore-control` commands
- An ECR-enabled account and credentials with permission to create IAM roles,
  ECR repos, and AgentCore runtimes
- The agent CLIs available to the image builds:
  - **Codex**: installed from npm in `Dockerfile.codex`
  - **Claude**: the adapter is an npm dependency of the bridge
  - **Kiro**: `Dockerfile.kiro` downloads the official aarch64 Linux build
    (`kirocli-aarch64-linux.zip`); no npm package exists. Override the version
    with the `KIRO_DOWNLOAD_URL` build arg. **Note:** Kiro requires a one-time
    browser-based login — see the caveat below for headless auth.

## Local development

```bash
npm install
npm run build

# Smoke-test the bridge against any ACP agent. Example with Codex:
AGENT_ID=codex CODEX_BIN=codex node dist/server.js
# In another shell:
curl -s localhost:8080/ping
curl -N -X POST localhost:8080/invocations \
  -H 'content-type: application/json' \
  -d '{"prompt":"List the files in this repo"}'
```

`npm run dev` runs the bridge with live reload via `tsx`.

## Deploy (per agent)

```bash
export AWS_REGION=us-east-1
# AWS_ACCOUNT_ID is auto-detected from STS if unset.

# 1. One-time: shared execution role
./deploy/setup-iam.sh

# 2. Build + push the arm64 image to ECR
./deploy/build-and-push.sh codex
# Kiro pulls the official aarch64 build automatically; pin a version with:
#   KIRO_DOWNLOAD_URL=https://desktop-release.q.us-east-1.amazonaws.com/latest/kirocli-aarch64-linux.zip ./deploy/build-and-push.sh kiro

# 3. Create/update the AgentCore runtime (IAM/SigV4 auth)
./deploy/deploy-runtime.sh codex

# 4. Invoke it (SigV4-signed by your AWS credentials)
./deploy/invoke.sh codex "Refactor utils.py to add type hints"
```

Repeat steps 2–4 with `kiro` and `claude` to stand up all three runtimes.

## Request / response format

**Request** (`POST /invocations`, `application/json`):

```json
{ "prompt": "your instruction", "cwd": "/optional/abs/working/dir" }
```

`prompt` may also be a raw array of ACP content blocks
(`[{"type":"text","text":"..."}]`) for images/resources.

**Response** (`text/event-stream`): a stream of normalized ACP events, e.g.

```
data: {"type":"session_update","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"..."}}}
data: {"type":"session_update","update":{"sessionUpdate":"tool_call","toolCallId":"call_1","status":"pending","title":"Edit file"}}
data: {"type":"stop","stopReason":"end_turn"}
```

## Configuration (env vars)

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_ID` | `claude` | Which agent the bridge spawns (`kiro`/`codex`/`claude`) |
| `PORT` | `8080` | HTTP listen port (AgentCore requires 8080) |
| `ACP_PERMISSION_MODE` | `allow` | `allow` auto-approves tool permission requests; `reject` denies them |
| `KIRO_BIN` / `KIRO_ACP_ARGS` | `kiro-cli` / `acp` | Kiro launch command |
| `CODEX_BIN` / `CODEX_ACP_ARGS` | `codex` / `acp` | Codex launch command |
| `CLAUDE_ACP_BIN` / `CLAUDE_ACP_ARGS` | `claude-agent-acp` / `` | Claude adapter launch command |

## Notes & caveats

- **Permission handling.** Because AgentCore runs unattended, the bridge
  auto-approves tool-call permission requests (`ACP_PERMISSION_MODE=allow`).
  Set it to `reject` for a read-only posture, or extend `bridge.ts` to forward
  permission prompts to the caller.
- **Sessions.** Each `/invocations` call currently creates a fresh ACP session
  in a per-call working directory. To persist context across calls, key a
  long-lived `session/load` flow off the
  `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` header (already read in
  `server.ts`).
- **Kiro CLI auth.** Kiro requires a one-time **browser-based login**, which is
  not headless-friendly. For an unattended container you must supply credentials
  out-of-band — e.g. bake/mount Kiro's auth token (`~/.kiro` / `~/.aws/sso`
  cache) into the image or volume, or use a Kiro build that accepts a token via
  env var. The image installs `kiro-cli` and is wired for `kiro-cli acp`; the
  auth material is the only manual piece.
```
