/**
 * Central config, read once from the environment. Mirrors the variables
 * documented in deploy/config.env.template and docs/DESIGN.md.
 */

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v == null || v === "") return dflt;
  return /^(1|true|yes|on)$/i.test(v);
}

export interface AppConfig {
  // --- aws-data-analytics skills ---
  enableAwsDataSkills: boolean;
  /** 'all' or an explicit list of skill names. */
  skillScope: "all" | string[];
  awsDataAnalyticsPlugin: string;
  enableAwsMcp: boolean;

  // --- per-user scoped credentials (B layer) ---
  perUserCreds: boolean;
  /** ARN whose session is scoped per user; defaults to the current exec role. */
  perUserRoleArn: string | undefined;

  // --- session storage / persistence ---
  enableSessionStorage: boolean;
  sessionStorageMount: string;
  /** Optional customer-owned S3 bucket for long-term archive (default off). */
  archiveBucket: string | undefined;

  awsRegion: string;
}

export function loadConfig(): AppConfig {
  const scopeRaw = process.env.SKILL_SCOPE ?? "all";
  const skillScope: "all" | string[] =
    scopeRaw.trim() === "all"
      ? "all"
      : scopeRaw.split(",").map((s) => s.trim()).filter(Boolean);

  return {
    enableAwsDataSkills: bool(process.env.ENABLE_AWS_DATA_SKILLS, true),
    skillScope,
    awsDataAnalyticsPlugin:
      process.env.AWS_DATA_ANALYTICS_PLUGIN ?? "/opt/aws-plugins/aws-data-analytics",
    enableAwsMcp: bool(process.env.ENABLE_AWS_MCP, false),

    perUserCreds: bool(process.env.PER_USER_CREDS, false),
    perUserRoleArn: process.env.PER_USER_ROLE_ARN || undefined,

    enableSessionStorage: bool(process.env.ENABLE_SESSION_STORAGE, false),
    sessionStorageMount: process.env.SESSION_STORAGE_MOUNT ?? "/mnt/workspace",
    archiveBucket: process.env.ARCHIVE_BUCKET || undefined,

    awsRegion: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
  };
}
