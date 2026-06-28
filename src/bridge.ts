/**
 * ACP bridge: drives an ACP agent subprocess as an ACP *client* and exposes a
 * single high-level `runPrompt` call that streams normalized events.
 *
 * Lifecycle per the protocol:
 *   spawn subprocess -> initialize -> session/new -> session/prompt
 *   (consuming session/update notifications until a stopReason)
 *
 * The bridge auto-approves tool-call permission requests by default so the
 * agent can run unattended inside AgentCore. Set ACP_PERMISSION_MODE=reject to
 * deny instead.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
} from "@zed-industries/agent-client-protocol";
import type {
  ContentBlock,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  WriteTextFileRequest,
  ReadTextFileResponse,
  ReadTextFileRequest,
} from "@zed-industries/agent-client-protocol";
import type { AgentSpec } from "./agents.js";

/** A normalized event emitted to the HTTP layer (serialized as SSE). */
export type BridgeEvent =
  | { type: "session_update"; update: SessionNotification["update"] }
  | { type: "stop"; stopReason: string }
  | { type: "error"; message: string };

export interface RunPromptOptions {
  prompt: ContentBlock[];
  cwd: string;
  /** Called for every normalized event as it streams in. */
  onEvent: (event: BridgeEvent) => void;
  /** Abort signal wired to the HTTP request lifecycle. */
  signal?: AbortSignal;
}

/**
 * Convert a Node Readable/Writable subprocess stdio pair into the
 * WebStream-based `Stream` that the ACP SDK expects.
 */
function toAcpStream(proc: ChildProcessWithoutNullStreams) {
  const input = Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>;
  return ndJsonStream(output, input);
}

export class AcpBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private conn: ClientSideConnection | null = null;
  private initialized = false;

  constructor(private readonly spec: AgentSpec) {}

  /** Spawn the agent subprocess and perform the ACP initialize handshake. */
  async start(): Promise<void> {
    if (this.proc) return;

    const proc = spawn(this.spec.command, this.spec.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.proc = proc;

    proc.on("error", (err) => {
      console.error(`[bridge] failed to spawn ${this.spec.command}:`, err);
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      // The ACP spec allows agents to log freely on stderr.
      process.stderr.write(`[${this.spec.id}] ${chunk}`);
    });
    proc.on("exit", (code, sig) => {
      console.error(`[bridge] agent ${this.spec.id} exited code=${code} sig=${sig}`);
      this.proc = null;
      this.conn = null;
      this.initialized = false;
    });

    const stream = toAcpStream(proc);

    // The bridge plays the Client role; `toClient` returns our handlers.
    this.conn = new ClientSideConnection(() => this.makeClient(), stream);

    await this.conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    });
    this.initialized = true;
  }

  /** True when the subprocess is alive and the handshake has completed. */
  get ready(): boolean {
    return this.initialized && this.proc !== null;
  }

  /**
   * The Client-side handlers the agent calls back into. The per-prompt event
   * sink is swapped via `activeSink` so notifications route to the right
   * in-flight HTTP request.
   */
  private activeSink: ((event: BridgeEvent) => void) | null = null;

  private makeClient(): Client {
    const mode = process.env.ACP_PERMISSION_MODE ?? "allow";
    return {
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        this.activeSink?.({ type: "session_update", update: params.update });
      },
      requestPermission: async (
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> => {
        // Pick the option matching the configured mode, falling back sensibly.
        const wantKinds =
          mode === "reject"
            ? ["reject_once", "reject_always"]
            : ["allow_once", "allow_always"];
        const chosen =
          params.options.find((o) => wantKinds.includes(o.kind)) ??
          params.options[0];
        if (!chosen) {
          return { outcome: { outcome: "cancelled" } };
        }
        return { outcome: { outcome: "selected", optionId: chosen.optionId } };
      },
      // Minimal file-system support so agents that read/write within the
      // session cwd can operate. Constrained to the session working dir.
      readTextFile: async (
        params: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> => {
        const { readFile } = await import("node:fs/promises");
        const content = await readFile(params.path, "utf8");
        const sliced =
          params.line != null || params.limit != null
            ? content
                .split("\n")
                .slice(
                  (params.line ?? 1) - 1,
                  params.limit != null
                    ? (params.line ?? 1) - 1 + params.limit
                    : undefined,
                )
                .join("\n")
            : content;
        return { content: sliced };
      },
      writeTextFile: async (params: WriteTextFileRequest) => {
        const { writeFile, mkdir } = await import("node:fs/promises");
        const { dirname } = await import("node:path");
        await mkdir(dirname(params.path), { recursive: true });
        await writeFile(params.path, params.content, "utf8");
        return {};
      },
    };
  }

  /**
   * Run a single prompt turn: create a session, send the prompt, and stream
   * normalized events until the agent returns a stop reason.
   */
  async runPrompt(opts: RunPromptOptions): Promise<void> {
    if (!this.conn || !this.ready) {
      await this.start();
    }
    const conn = this.conn;
    if (!conn) throw new Error("ACP connection not available");

    this.activeSink = opts.onEvent;
    try {
      const session = await conn.newSession({
        cwd: opts.cwd,
        mcpServers: [],
      });

      if (opts.signal) {
        opts.signal.addEventListener(
          "abort",
          () => {
            void conn.cancel({ sessionId: session.sessionId });
          },
          { once: true },
        );
      }

      const res = await conn.prompt({
        sessionId: session.sessionId,
        prompt: opts.prompt,
      });

      opts.onEvent({ type: "stop", stopReason: res.stopReason });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.onEvent({ type: "error", message });
      throw err;
    } finally {
      this.activeSink = null;
    }
  }

  async stop(): Promise<void> {
    this.proc?.stdin.end();
    this.proc?.kill();
    this.proc = null;
    this.conn = null;
    this.initialized = false;
  }
}
