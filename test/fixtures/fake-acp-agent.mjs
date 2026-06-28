#!/usr/bin/env node
/**
 * Configurable fake ACP agent over stdio, used as a stand-in for the real
 * CLIs (kiro/codex/claude) in contract tests. It speaks newline-delimited
 * JSON-RPC 2.0 exactly like a real ACP agent.
 *
 * Behavior is controlled via env vars so a single fixture covers many cases:
 *   FAKE_MODE = "text"        (default) one message chunk then end_turn
 *             | "tools"       emit a tool_call + tool_call_update, then text
 *             | "permission"  request permission, echo the granted option
 *             | "error"       fail session/prompt with a JSON-RPC error
 *             | "crash"       exit the process on session/prompt
 *   FAKE_DELAY_MS             delay (ms) before responding to session/prompt
 *   FAKE_TEXT                 the agent_message_chunk text (default "ok")
 */
import { createInterface } from "node:readline";

const MODE = process.env.FAKE_MODE ?? "text";
const DELAY_MS = Number(process.env.FAKE_DELAY_MS ?? 0);
const TEXT = process.env.FAKE_TEXT ?? "ok";

const rl = createInterface({ input: process.stdin });
let pendingPermission = null; // { resolve } when awaiting a permission response

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function update(sessionId, update) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handlePrompt(id, params) {
  const sid = params.sessionId;
  if (DELAY_MS > 0) await sleep(DELAY_MS);

  if (MODE === "crash") {
    process.exit(7);
  }
  if (MODE === "error") {
    send({ jsonrpc: "2.0", id, error: { code: -32000, message: "synthetic agent failure" } });
    return;
  }

  if (MODE === "tools") {
    update(sid, { sessionUpdate: "tool_call", toolCallId: "call_1", title: "Run thing", kind: "other", status: "pending" });
    update(sid, { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed", content: [{ type: "content", content: { type: "text", text: "tool done" } }] });
  }

  if (MODE === "permission") {
    // Ask the client (bridge) for permission and wait for its decision.
    const reqId = 9001;
    const decision = await new Promise((resolve) => {
      pendingPermission = resolve;
      send({
        jsonrpc: "2.0",
        id: reqId,
        method: "session/request_permission",
        params: {
          sessionId: sid,
          toolCall: { toolCallId: "call_perm", title: "Sensitive op", status: "pending" },
          options: [
            { optionId: "yes", name: "Allow", kind: "allow_once" },
            { optionId: "no", name: "Reject", kind: "reject_once" },
          ],
        },
      });
    });
    update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `permission=${JSON.stringify(decision)}` } });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }

  update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: TEXT } });
  send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params, result } = msg;

  // A response from the client (e.g. to our permission request).
  if (method === undefined && id != null && pendingPermission) {
    const resolve = pendingPermission;
    pendingPermission = null;
    resolve(result?.outcome ?? result);
    return;
  }

  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  } else if (method === "session/new") {
    send({ jsonrpc: "2.0", id, result: { sessionId: "sess_fake_1" } });
  } else if (method === "session/prompt") {
    void handlePrompt(id, params);
  } else if (method === "session/cancel") {
    // notification; nothing to ack
  } else if (id != null) {
    send({ jsonrpc: "2.0", id, result: {} });
  }
});
