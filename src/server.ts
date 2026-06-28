#!/usr/bin/env node
/**
 * AgentCore Runtime HTTP entrypoint.
 *
 * Implements the AgentCore HTTP protocol contract:
 *   - GET  /ping         -> health, returns {"status":"Healthy"|"HealthyBusy"}
 *   - POST /invocations  -> JSON body in, SSE (text/event-stream) out
 *
 * Listens on 0.0.0.0:8080. Authorization is enforced by AgentCore (IAM/SigV4)
 * before requests reach this process.
 *
 * Per DESIGN: on each /invocations we resolve a per-user, per-session workspace
 * under the managed session-storage mount, optionally restore from an archive
 * bucket, inject aws-data-analytics skills + per-user scoped credentials into
 * the Claude session, run the prompt, then persist session continuity (and
 * optionally archive).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock } from "@zed-industries/agent-client-protocol";
import { resolveAgent } from "./agents.js";
import { AcpBridge, type BridgeEvent } from "./bridge.js";
import { loadConfig } from "./config.js";
import { buildClaudeOptions, toSessionMeta } from "./skills.js";
import { deriveScopedCreds, sanitizeUserId } from "./credentials.js";
import {
  sessionPaths,
  ensureDirs,
  readMeta,
  writeMeta,
  restoreFromArchive,
  archiveToBucket,
  type SessionPaths,
} from "./sessionstore.js";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = "0.0.0.0";

const cfg = loadConfig();
const spec = resolveAgent();
const bridge = new AcpBridge(spec);
const isClaude = spec.id === "claude";

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
  if (typeof p === "string") return [{ type: "text", text: p }];
  if (Array.isArray(p)) return p as ContentBlock[];
  throw new Error('Body must include "prompt" as a string or an array of ACP content blocks');
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function handlePing(res: ServerResponse): void {
  sendJson(res, 200, { status: inFlight > 0 ? "HealthyBusy" : "Healthy" });
}

/**
 * Resolve where this turn's workspace lives and what to inject. When session
 * storage is enabled we use a per-user/per-session dir under the mount;
 * otherwise a throwaway temp dir.
 */
async function resolveWorkspace(
  req: IncomingMessage,
  body: Record<string, unknown>,
): Promise<{
  cwd: string;
  paths?: SessionPaths;
  userId: string;
  sessionId: string;
  configDir?: string;
}> {
  const userId = sanitizeUserId(
    header(req, "X-Amzn-Bedrock-AgentCore-Runtime-User-Id") ?? "default",
  );
  const sessionId =
    header(req, "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id") ??
    `sess-${userId}`;

  if (typeof body.cwd === "string" && body.cwd) {
    return { cwd: body.cwd, userId, sessionId };
  }

  if (cfg.enableSessionStorage) {
    const paths = sessionPaths(cfg.sessionStorageMount, userId, sessionId);
    // Restore from archive if the managed storage was reset (DESIGN §3.6).
    await restoreFromArchive({
      archiveBucket: cfg.archiveBucket,
      paths,
      userId,
      sessionId,
      region: cfg.awsRegion,
    });
    await ensureDirs(paths);
    return { cwd: paths.cwd, paths, userId, sessionId, configDir: paths.configDir };
  }

  const cwd = await mkdtemp(join(tmpdir(), `acp-${spec.id}-`));
  return { cwd, userId, sessionId };
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

  const ws = await resolveWorkspace(req, body);

  // Build Claude-only injection: skills + per-session config dir + per-user creds.
  let meta: Record<string, unknown> | undefined;
  let resumeSessionId: string | undefined;
  if (isClaude) {
    const extraEnv: Record<string, string> = {};
    if (ws.configDir) extraEnv.CLAUDE_CONFIG_DIR = ws.configDir;

    if (cfg.perUserCreds) {
      const roleArn = cfg.perUserRoleArn ?? (await currentRoleArn());
      if (roleArn) {
        const creds = await deriveScopedCreds({
          roleArn,
          userId: ws.userId,
          region: cfg.awsRegion,
          dataBucket: process.env.DATA_BUCKET,
          archiveBucket: cfg.archiveBucket,
        });
        if (creds) Object.assign(extraEnv, creds);
      }
    }

    meta = toSessionMeta(buildClaudeOptions(cfg, extraEnv));

    if (ws.paths) {
      const stored = await readMeta(ws.paths);
      resumeSessionId = stored.lastSdkSessionId;
    }
  }

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

  let sdkSessionId: string | undefined;
  inFlight++;
  try {
    await bridge.runPrompt({
      prompt,
      cwd: ws.cwd,
      signal: ac.signal,
      onEvent: write,
      meta,
      resumeSessionId,
      onSessionId: (id) => {
        sdkSessionId = id;
      },
    });
  } catch (err) {
    console.error(`[server] prompt turn failed (session=${ws.sessionId}):`, err);
  } finally {
    inFlight--;
    // Persist session continuity + optional archive (best-effort, post-stream).
    if (ws.paths) {
      if (sdkSessionId) await writeMeta(ws.paths, { lastSdkSessionId: sdkSessionId });
      await archiveToBucket({
        archiveBucket: cfg.archiveBucket,
        paths: ws.paths,
        userId: ws.userId,
        sessionId: ws.sessionId,
        region: cfg.awsRegion,
      });
    }
    res.end();
  }
}

/** Discover the execution role ARN via STS (cached after first call). */
let cachedRoleArn: string | undefined | null = null;
async function currentRoleArn(): Promise<string | undefined> {
  if (cachedRoleArn !== null) return cachedRoleArn ?? undefined;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)("aws", [
      "sts", "get-caller-identity", "--query", "Arn", "--output", "text",
      "--region", cfg.awsRegion,
    ]);
    // assumed-role ARN -> role ARN
    const arn = stdout.trim();
    const m = arn.match(/^arn:aws:sts::(\d+):assumed-role\/([^/]+)\//);
    cachedRoleArn = m ? `arn:aws:iam::${m[1]}:role/${m[2]}` : undefined;
  } catch (err) {
    console.error("[server] could not resolve role ARN:", err);
    cachedRoleArn = undefined;
  }
  return cachedRoleArn ?? undefined;
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
      `listening on http://${HOST}:${PORT} | skills=${cfg.enableAwsDataSkills && isClaude} ` +
      `sessionStorage=${cfg.enableSessionStorage} perUserCreds=${cfg.perUserCreds} archive=${!!cfg.archiveBucket}`,
  );
  bridge.start().catch((err) => console.error("[server] warm start failed:", err));
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[server] received ${sig}, shutting down`);
    void bridge.stop();
    server.close(() => process.exit(0));
  });
}
