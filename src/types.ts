// Shared shapes for Scepter's checks and reporting.

export type SourceKind = "npm" | "github";

export type Verdict = "healthy" | "caution" | "risky";

/** Normalized facts gathered about one MCP server, from npm or GitHub. */
export interface SourceInfo {
  kind: SourceKind;
  /** Human-readable name, e.g. "owner/repo" or a package name. */
  name: string;
  /** Whether the package or repo was found at all. */
  exists: boolean;
  /** Last publish (npm) or last push (GitHub). */
  lastActivity: Date | null;
  archived: boolean;
  openIssues: number | null;
  stars: number | null;
  license: string | null;
  description: string | null;
  latestVersion: string | null;
  maintainers: number | null;
  hasReleases: boolean | null;
  /** Points back to source code (repository field / homepage). */
  hasRepoLink: boolean;
  /** Heuristic: does it look like an MCP server at all? */
  looksLikeMcp: boolean;
  /** Non-fatal problems while gathering (rate limit, missing token, etc.). */
  warnings: string[];
}

/** One scored signal that feeds the final verdict. */
export interface Signal {
  key: string;
  label: string;
  status: "ok" | "warn" | "bad";
  detail: string;
}

export interface CheckResult {
  target: string;
  source: SourceInfo;
  signals: Signal[];
  score: number;
  verdict: Verdict;
  reasons: string[];
}
