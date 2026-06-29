# 示例：多用户并发 / 隔离测试

[English](README.md) | **简体中文**

证明在部署后的 Claude runtime 上，使用**不同 session id** 的并发用户彼此完全隔离
——不共享文件系统，SSE 流不串台。

## 如何证明隔离

`run_concurrency_test.sh` **并行发起 N 个调用**，每个带有：

- 一个**唯一的 `runtime-session-id`**（→ AgentCore 通过 session 亲和性把每个请求
  路由到各自独立的 microVM），
- 一个**唯一的 `runtime-user-id`**，
- 一个**唯一的 marker 字符串**（`MARKER_<runtag>_user<i>`）。

每个 prompt 让 Claude 把自己的 marker 写入工作区的一个文件，然后列出并读取它能看到
的所有 `.txt` 文件。隔离成立当且仅当：对每个 session，其响应**只包含自己的 marker**、
**不包含任何其他 session 的 marker**。共享工作区或串流的 SSE 会暴露出外来 marker，
从而导致该轮测试失败。

## 运行

```bash
cd examples/concurrency-test
N=4 AWS_REGION=us-east-1 ./run_concurrency_test.sh   # 默认 N=4
N=8 ./run_concurrency_test.sh                        # 更大并发
```

要求 `acp_claude` runtime 已部署且 `ENABLE_SESSION_STORAGE=true`。

## 已验证结果

```
N=4 → RESULT: PASS — all 4 sessions isolated, no cross-talk.
N=8 → RESULT: PASS — all 8 sessions isolated, no cross-talk.
```

逐个检查每个 session 的原始 SSE，每个都恰好只有一个 marker——它自己的：

```
resp_1.sse  markers seen: ['MARKER_..._user1']
resp_2.sse  markers seen: ['MARKER_..._user2']
resp_3.sse  markers seen: ['MARKER_..._user3']
resp_4.sse  markers seen: ['MARKER_..._user4']
```

## 原理（及其边界）

- **跨 session 隔离由 AgentCore 保证**，而非桥接层：每个 `runtime-session-id`
  获得一个专属 microVM，拥有独立的算力/内存/文件系统，session 结束后销毁并清零。
  不同用户 → 不同 session id → 不同 microVM → 不同的桥接进程。因此桥接层的
  "单子进程"设计永远不会被跨用户共享。
- **调用方责任：** AgentCore *不*强制 session-to-user 映射。你的客户端后端必须为
  每个用户分配唯一的 session id。两个用户共用同一个 session id 会共享同一个
  microVM（设计如此）。
- **同一 session 内的并发：** 对*同一个* session id 的并行请求会被路由到*同一个*
  microVM，桥接层在那里一次处理一个 prompt turn（单个 `activeSink`）。正常使用
  （一个会话内的串行多 turn）不受影响；如果你的前端会对同一 session id 发起并发
  请求，请在客户端串行化，或在桥接层加队列。
