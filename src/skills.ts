/**
 * Builds the `_meta.claudeCode.options` payload that the claude-agent-acp
 * adapter passes straight through to the Claude Agent SDK (DESIGN §1, R2/R3).
 *
 * Only meaningful for the Claude agent; other agents ignore _meta.
 */

import type { AppConfig } from "./config.js";

export interface ClaudeSessionOptions {
  plugins?: Array<{ type: "local"; path: string }>;
  skills?: string[] | "all";
  mcpServers?: Record<string, { command: string; args: string[] }>;
  additionalDirectories?: string[];
  env?: Record<string, string>;
}

/**
 * Assemble the SDK options for a Claude session. `extraEnv` carries per-user
 * scoped credentials (B layer) and the per-session CLAUDE_CONFIG_DIR.
 */
export function buildClaudeOptions(
  cfg: AppConfig,
  extraEnv: Record<string, string>,
): ClaudeSessionOptions | undefined {
  const opts: ClaudeSessionOptions = {};

  if (cfg.enableAwsDataSkills) {
    opts.plugins = [{ type: "local", path: cfg.awsDataAnalyticsPlugin }];
    opts.skills = cfg.skillScope; // 'all' or explicit list
    opts.additionalDirectories = [cfg.awsDataAnalyticsPlugin];
    // aws-mcp is optional; skills work via the AWS CLI without it (R9).
    if (cfg.enableAwsMcp) {
      opts.mcpServers = { "aws-mcp": { command: "uvx", args: ["aws-mcp"] } };
    }
  }

  if (Object.keys(extraEnv).length > 0) {
    opts.env = extraEnv;
  }

  // Nothing to inject -> return undefined so the bridge omits _meta entirely.
  return Object.keys(opts).length > 0 ? opts : undefined;
}

/** Wrap session options in the adapter's expected _meta envelope. */
export function toSessionMeta(opts: ClaudeSessionOptions | undefined): Record<string, unknown> | undefined {
  if (!opts) return undefined;
  return { claudeCode: { options: opts } };
}
