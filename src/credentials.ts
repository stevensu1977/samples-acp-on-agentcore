/**
 * Per-user scoped AWS credentials (B layer, DESIGN §2.2, method 1).
 *
 * Calls sts:AssumeRole on the *same* execution role with a runtime-generated
 * session policy that narrows access to the calling user's prefix. The derived
 * temporary credentials are returned as env vars to inject into the skill
 * subprocess. No pre-provisioned per-tenant roles are required.
 *
 * Uses the AWS CLI (already in the Claude image) rather than an SDK dependency,
 * so the bridge stays dependency-light. The bridge process itself runs with the
 * execution role via the container credential endpoint.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ScopedCreds {
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_SESSION_TOKEN: string;
}

/** Sanitize a user id into something safe for ARNs, prefixes, and policies. */
export function sanitizeUserId(userId: string): string {
  const cleaned = userId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
  return cleaned || "default";
}

/**
 * Build a session policy that scopes S3 + Athena to the user's space. The
 * effective permissions are the intersection of the role's policy and this one,
 * so this can only ever *narrow* access.
 */
export function buildSessionPolicy(userId: string, opts: { dataBucket?: string; archiveBucket?: string }): string {
  const u = sanitizeUserId(userId);
  const buckets = [opts.dataBucket, opts.archiveBucket].filter(Boolean) as string[];
  const statements: unknown[] = [
    {
      Sid: "ScopedS3",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
      Resource: buckets.flatMap((b) => [
        `arn:aws:s3:::${b}`,
        `arn:aws:s3:::${b}/users/${u}/*`,
      ]),
      ...(buckets.length
        ? { Condition: { StringLike: { "s3:prefix": [`users/${u}/*`, `users/${u}`] } } }
        : {}),
    },
    {
      Sid: "ReadOnlyCatalogAndAthena",
      Effect: "Allow",
      Action: [
        "glue:Get*", "glue:Search*",
        "athena:StartQueryExecution", "athena:GetQueryExecution",
        "athena:GetQueryResults", "athena:StopQueryExecution",
        "athena:GetWorkGroup", "athena:ListWorkGroups",
      ],
      Resource: "*",
    },
  ];
  // If there are no buckets, drop the (now resource-less) S3 statement.
  const filtered = buckets.length ? statements : statements.slice(1);
  return JSON.stringify({ Version: "2012-10-17", Statement: filtered });
}

/**
 * Derive per-user temporary credentials. Returns null if disabled or on any
 * failure (caller falls back to the execution role).
 */
export async function deriveScopedCreds(params: {
  roleArn: string;
  userId: string;
  region: string;
  dataBucket?: string;
  archiveBucket?: string;
}): Promise<ScopedCreds | null> {
  const sessionName = `acp-${sanitizeUserId(params.userId)}`.slice(0, 64);
  const policy = buildSessionPolicy(params.userId, {
    dataBucket: params.dataBucket,
    archiveBucket: params.archiveBucket,
  });
  try {
    const { stdout } = await execFileAsync(
      "aws",
      [
        "sts", "assume-role",
        "--role-arn", params.roleArn,
        "--role-session-name", sessionName,
        "--policy", policy,
        "--duration-seconds", "3600",
        "--region", params.region,
        "--output", "json",
      ],
      { maxBuffer: 1024 * 1024 },
    );
    const creds = JSON.parse(stdout).Credentials;
    return {
      AWS_ACCESS_KEY_ID: creds.AccessKeyId,
      AWS_SECRET_ACCESS_KEY: creds.SecretAccessKey,
      AWS_SESSION_TOKEN: creds.SessionToken,
    };
  } catch (err) {
    console.error("[creds] assume-role failed, falling back to execution role:", err);
    return null;
  }
}
