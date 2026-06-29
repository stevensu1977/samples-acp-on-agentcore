# Example: multi-user concurrency / isolation test

**English** | [简体中文](README.zh-CN.md)

Proves that concurrent users with **distinct session ids** are fully isolated
on the deployed Claude runtime — no shared filesystem, no SSE cross-talk.

## How it proves isolation

`run_concurrency_test.sh` fires **N invocations in parallel**, each with:

- a **distinct `runtime-session-id`** (→ AgentCore routes each to its own
  microVM via session affinity), and
- a **distinct `runtime-user-id`**, and
- a **unique marker string** (`MARKER_<runtag>_user<i>`).

Each prompt tells Claude to write its marker to a file in the workspace, then
list and read every `.txt` file it can see. Isolation holds iff, for every
session, the response contains **only its own marker** and **none of the other
sessions' markers**. A shared workspace or a crossed SSE stream would surface a
foreign marker and fail the run.

## Run

```bash
cd examples/concurrency-test
N=4 AWS_REGION=us-east-1 ./run_concurrency_test.sh   # default N=4
N=8 ./run_concurrency_test.sh                        # heavier
```

Requires the `acp_claude` runtime deployed with `ENABLE_SESSION_STORAGE=true`.

## Verified result

```
N=4 → RESULT: PASS — all 4 sessions isolated, no cross-talk.
N=8 → RESULT: PASS — all 8 sessions isolated, no cross-talk.
```

Inspecting the raw SSE per session showed exactly one marker each — its own:

```
resp_1.sse  markers seen: ['MARKER_..._user1']
resp_2.sse  markers seen: ['MARKER_..._user2']
resp_3.sse  markers seen: ['MARKER_..._user3']
resp_4.sse  markers seen: ['MARKER_..._user4']
```

## Why this works (and its boundaries)

- **Cross-session isolation is guaranteed by AgentCore**, not by the bridge:
  each `runtime-session-id` gets a dedicated microVM with isolated compute /
  memory / filesystem, terminated and sanitized after the session. Different
  users → different session ids → different microVMs → different bridge
  processes. The bridge's single-subprocess design is therefore never shared
  across users.
- **Caller responsibility:** AgentCore does *not* enforce a session-to-user
  mapping. Your client backend must assign each user a unique session id. Two
  users sharing one session id would share one microVM (by design).
- **Same-session concurrency:** parallel requests to the *same* session id are
  routed to the *same* microVM, where the bridge processes one prompt turn at a
  time (single `activeSink`). Normal use (serial turns within a conversation)
  is unaffected; if your frontend issues concurrent requests on one session id,
  serialize them client-side or add a queue in the bridge.
