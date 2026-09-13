import type { SourceInfo } from "../types.js";
import { detectMcp } from "../mcp-detect.js";

const API = "https://api.github.com";

interface GhRepo {
  full_name?: string;
  description?: string | null;
  archived?: boolean;
  pushed_at?: string;
  open_issues_count?: number;
  stargazers_count?: number;
  license?: { spdx_id?: string; name?: string } | null;
  homepage?: string | null;
  topics?: string[];
  message?: string; // present on error payloads
}

/**
 * Fetch and normalize GitHub repo metadata. Uses GITHUB_TOKEN if present to
 * lift the unauthenticated rate limit, but works without one.
 */
export async function inspectGithub(id: string): Promise<SourceInfo> {
  const warnings: string[] = [];
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "scepter-mcp",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  else warnings.push("no GITHUB_TOKEN set: GitHub calls are rate-limited");

  let repo: GhRepo | null = null;
  let hasReleases: boolean | null = null;
  try {
    const res = await fetch(`${API}/repos/${id}`, { headers });
    if (res.status === 404) {
      return notFound(id);
    }
    if (res.status === 403) {
      warnings.push("GitHub rate limit hit: set GITHUB_TOKEN to raise it");
    }
    if (res.ok) {
      repo = (await res.json()) as GhRepo;
    } else if (res.status !== 403) {
      warnings.push(`GitHub responded ${res.status}`);
    }
  } catch (err) {
    warnings.push(`could not reach GitHub: ${(err as Error).message}`);
  }

  if (!repo) {
    return { ...notFound(id), warnings, exists: false };
  }

  // A single lightweight follow-up: does it cut releases?
  try {
    const rel = await fetch(`${API}/repos/${id}/releases?per_page=1`, { headers });
    if (rel.ok) {
      const arr = (await rel.json()) as unknown[];
      hasReleases = Array.isArray(arr) && arr.length > 0;
    }
  } catch {
    // best-effort; leave null
  }

  const topics = (repo.topics ?? []).map((t) => t.toLowerCase());
  const desc = repo.description ?? null;
  const looksLikeMcp = detectMcp(id, desc, topics);

  return {
    kind: "github",
    name: repo.full_name ?? id,
    exists: true,
    lastActivity: repo.pushed_at ? new Date(repo.pushed_at) : null,
    archived: Boolean(repo.archived),
    openIssues: typeof repo.open_issues_count === "number" ? repo.open_issues_count : null,
    stars: typeof repo.stargazers_count === "number" ? repo.stargazers_count : null,
    license: repo.license?.spdx_id && repo.license.spdx_id !== "NOASSERTION"
      ? repo.license.spdx_id
      : repo.license?.name ?? null,
    description: desc,
    latestVersion: null,
    maintainers: null,
    hasReleases,
    hasRepoLink: true,
    looksLikeMcp,
    warnings,
  };
}

function notFound(id: string): SourceInfo {
  return {
    kind: "github",
    name: id,
    exists: false,
    lastActivity: null,
    archived: false,
    openIssues: null,
    stars: null,
    license: null,
    description: null,
    latestVersion: null,
    maintainers: null,
    hasReleases: null,
    hasRepoLink: false,
    looksLikeMcp: id.toLowerCase().includes("mcp"),
    warnings: [],
  };
}
