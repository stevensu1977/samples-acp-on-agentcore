#!/usr/bin/env node
/**
 * AgentCore Runtime HTTP entrypoint.
 *
 * Implements the AgentCore HTTP protocol contract:
 *   - GET  /ping         -> health, returns {"status":"Healthy"|"HealthyBusy"}
 *   - POST /invocations  -> JSON body in, SSE (text/event-stream) out
 *
 * Listens on 0.0.0.0:8080 (the contract's required host/port). Authorization
 * is enforced by AgentCore itself via IAM/SigV4 *before* requests reach this
 * process, so there is no app-level auth code here — the container only ever
 * sees already-authorized traffic.
 *
 * Request body shape (flexible):
 *   { "prompt": "string" }                              // simple
 *   { "prompt": [ {"type":"text","text":"..."} ] }      // raw ACP content blocks
 *   { "prompt": "...", "cwd": "/abs/path" }              // optional working dir
 *
 * Response: an SSE stream of ACP session updates, ending with a `stop` event.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock } from "@zed-industries/agent-client-protocol";
import { resolveAgent } from "./agents.js";
import { AcpBridge, type BridgeEvent } from "./bridge.js";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = "0.0.0.0";

const spec = resolveAgent();
const bridge = new AcpBridge(spec);

/** Count of in-flight prompt turns, used to report HealthyBusy. */
let inFlight = 0;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

/** Normalize the incoming body into ACP content blocks. */
function toContentBlocks(body: Record<string, unknown>): ContentBlock[] {
  const p = body.prompt ?? body.input ?? body.message;
  if (typeof p === "string") {
    return [{ type: "text", text: p }];
  }
  if (Array.isArray(p)) {
    // Assume already-shaped ACP content blocks; pass through.
    return p as ContentBlock[];
  }
  throw new Error('Body must include "prompt" as a string or an array of ACP content blocks');
}

function handlePing(res: ServerResponse): void {
  // HealthyBusy keeps the runtime session alive while a turn is streaming.
  sendJson(res, 200, { status: inFlight > 0 ? "HealthyBusy" : "Healthy" });
}

async function handleInvocations(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  let prompt: ContentBlock[];
  try {
    body = (await readBody(req)) as Record<string, unknown>;
    prompt = toContentBlocks(body);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }

  // Per-session working directory. AgentCore passes a session id header we can
  // reuse for stable scoping; otherwise we mint a temp dir.
  const sessionId =
    (req.headers["x-amzn-bedrock-agentcore-runtime-session-id"] as string | undefined) ??
    undefined;
  const cwd =
    (typeof body.cwd === "string" && body.cwd) ||
    (await mkdtemp(join(tmpdir(), `acp-${spec.id}-`)));

  // Open the SSE stream.
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const write = (event: BridgeEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const ac = new AbortController();
  req.on("close", () => ac.abort());

  inFlight++;
  try {
    await bridge.runPrompt({
      prompt,
      cwd,
      signal: ac.signal,
      onEvent: write,
    });
  } catch (err) {
    // runPrompt already emitted an `error` event; just log here.
    console.error(`[server] prompt turn failed (session=${sessionId}):`, err);
  } finally {
    inFlight--;
    res.end();
  }
}

const server = createServer((req, res) => {
  const url = req.url ?? "/";
  if (req.method === "GET" && (url === "/ping" || url.startsWith("/ping?"))) {
    handlePing(res);
    return;
  }
  if (req.method === "POST" && (url === "/invocations" || url.startsWith("/invocations?"))) {
    void handleInvocations(req, res);
    return;
  }
  sendJson(res, 404, { error: `No route for ${req.method} ${url}` });
});

server.listen(PORT, HOST, () => {
  console.log(
    `[acp-on-agentcore] agent="${spec.displayName}" (id=${spec.id}, native=${spec.native}) ` +
      `listening on http://${HOST}:${PORT}`,
  );
  // Warm the subprocess so the first /invocations is fast. Failures here are
  // non-fatal; runPrompt will retry start().
  bridge.start().catch((err) => console.error("[server] warm start failed:", err));
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[server] received ${sig}, shutting down`);
    void bridge.stop();
    server.close(() => process.exit(0));
  });
}
