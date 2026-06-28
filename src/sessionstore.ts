/**
 * Per-user / per-session workspace layout on top of AgentCore Managed Session
 * Storage (DESIGN §3). Also implements the optional ARCHIVE_BUCKET long-term
 * archive/restore (DESIGN §3.6).
 *
 * Layout (under the session-storage mount, e.g. /mnt/workspace):
 *   <userId>/<sessionId>/
 *     workspace/        -> Claude's cwd (editable, git-capable)
 *     claude-config/    -> CLAUDE_CONFIG_DIR (projects/<proj>/<sdkSessionId>.jsonl)
 *     .acp-meta.json    -> { lastSdkSessionId }
 */

import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sanitizeUserId } from "./credentials.js";

const execFileAsync = promisify(execFile);

export interface SessionPaths {
  base: string;
  cwd: string;
  configDir: string;
  metaPath: string;
}

export interface SessionMeta {
  lastSdkSessionId?: string;
}

/** Compute the directory layout for a (user, session) pair under `mountRoot`. */
export function sessionPaths(mountRoot: string, userId: string, sessionId: string): SessionPaths {
  const u = sanitizeUserId(userId);
  const s = sanitizeUserId(sessionId);
  const base = join(mountRoot, u, s);
  return {
    base,
    cwd: join(base, "workspace"),
    configDir: join(base, "claude-config"),
    metaPath: join(base, ".acp-meta.json"),
  };
}

/** Ensure the working directories exist. */
export async function ensureDirs(p: SessionPaths): Promise<void> {
  await mkdir(p.cwd, { recursive: true });
  await mkdir(p.configDir, { recursive: true });
}

export async function readMeta(p: SessionPaths): Promise<SessionMeta> {
  try {
    return JSON.parse(await readFile(p.metaPath, "utf8")) as SessionMeta;
  } catch {
    return {};
  }
}

export async function writeMeta(p: SessionPaths, meta: SessionMeta): Promise<void> {
  try {
    await writeFile(p.metaPath, JSON.stringify(meta, null, 2), "utf8");
  } catch (err) {
    console.error("[sessionstore] failed to write meta:", err);
  }
}

async function isEmptyDir(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch {
    return true;
  }
}

/**
 * Restore a session's files from ARCHIVE_BUCKET when the managed storage is
 * empty (e.g. after 14-day idle reset or a version update). No-op if archiving
 * is disabled or the local dir already has data.
 */
export async function restoreFromArchive(params: {
  archiveBucket?: string;
  paths: SessionPaths;
  userId: string;
  sessionId: string;
  region: string;
}): Promise<boolean> {
  if (!params.archiveBucket) return false;
  if (!(await isEmptyDir(params.paths.base))) return false;
  const key = `${sanitizeUserId(params.userId)}/${sanitizeUserId(params.sessionId)}`;
  const s3uri = `s3://${params.archiveBucket}/${key}/`;
  try {
    await execFileAsync(
      "aws",
      ["s3", "sync", s3uri, params.paths.base, "--region", params.region],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    console.log(`[sessionstore] restored from ${s3uri}`);
    return true;
  } catch (err) {
    console.error("[sessionstore] restore failed (continuing fresh):", err);
    return false;
  }
}

/** Archive a session's files to ARCHIVE_BUCKET. No-op if archiving disabled. */
export async function archiveToBucket(params: {
  archiveBucket?: string;
  paths: SessionPaths;
  userId: string;
  sessionId: string;
  region: string;
}): Promise<void> {
  if (!params.archiveBucket) return;
  const key = `${sanitizeUserId(params.userId)}/${sanitizeUserId(params.sessionId)}`;
  const s3uri = `s3://${params.archiveBucket}/${key}/`;
  try {
    await execFileAsync(
      "aws",
      ["s3", "sync", params.paths.base, s3uri, "--region", params.region, "--delete"],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    console.log(`[sessionstore] archived to ${s3uri}`);
  } catch (err) {
    console.error("[sessionstore] archive failed:", err);
  }
}
