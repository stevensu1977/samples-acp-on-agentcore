/**
 * Registry of the ACP agents this bridge knows how to launch.
 *
 * Each entry describes how to spawn an ACP-speaking agent as a subprocess.
 * The bridge talks JSON-RPC over the subprocess's stdio (per the ACP stdio
 * transport) and translates AgentCore HTTP/SSE <-> ACP for the outside world.
 *
 *  - kiro   : Kiro CLI speaks ACP natively.
 *  - codex  : Codex CLI speaks ACP natively (via Zed's adapter binary).
 *  - claude : Claude Code does NOT speak ACP natively, so we run the
 *             @agentclientprotocol/claude-agent-acp adapter, which presents
 *             the Claude Agent SDK as an ACP agent over stdio.
 *
 * The active agent is selected at container build/run time via the AGENT_ID
 * environment variable, so the same bridge image powers all three runtimes.
 */

export interface AgentSpec {
  /** Stable identifier, also the value of the AGENT_ID env var. */
  id: string;
  /** Human-readable name surfaced in /ping and logs. */
  displayName: string;
  /** Executable to spawn. */
  command: string;
  /** Arguments that make the executable speak ACP over stdio. */
  args: string[];
  /**
   * Whether this agent is ACP-native. Informational only; both native and
   * adapted agents are driven identically over stdio once spawned.
   */
  native: boolean;
}

export const AGENTS: Record<string, AgentSpec> = {
  kiro: {
    id: "kiro",
    displayName: "Kiro CLI",
    // Kiro CLI exposes an ACP stdio server. Adjust the subcommand here if your
    // installed Kiro build uses a different flag.
    command: process.env.KIRO_BIN ?? "kiro-cli",
    args: (process.env.KIRO_ACP_ARGS ?? "acp").split(" ").filter(Boolean),
    native: true,
  },
  codex: {
    id: "codex",
    displayName: "Codex CLI",
    // Codex CLI speaks ACP via Zed's adapter. `codex acp` launches the
    // newline-delimited JSON-RPC server on stdio.
    command: process.env.CODEX_BIN ?? "codex",
    args: (process.env.CODEX_ACP_ARGS ?? "acp").split(" ").filter(Boolean),
    native: true,
  },
  claude: {
    id: "claude",
    displayName: "Claude Code (via claude-agent-acp adapter)",
    // The adapter ships a `claude-agent-acp` bin that is an ACP agent over
    // stdio, wrapping the Claude Agent SDK.
    command: process.env.CLAUDE_ACP_BIN ?? "claude-agent-acp",
    args: (process.env.CLAUDE_ACP_ARGS ?? "").split(" ").filter(Boolean),
    native: false,
  },
};

export function resolveAgent(): AgentSpec {
  const id = process.env.AGENT_ID ?? "claude";
  const spec = AGENTS[id];
  if (!spec) {
    const known = Object.keys(AGENTS).join(", ");
    throw new Error(`Unknown AGENT_ID="${id}". Known agents: ${known}`);
  }
  return spec;
}
