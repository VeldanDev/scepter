import type { SourceInfo } from "../types.js";
import { detectMcp } from "../mcp-detect.js";

const REGISTRY = "https://registry.npmjs.org";

interface NpmPackument {
  name?: string;
  description?: string;
  "dist-tags"?: Record<string, string>;
  time?: Record<string, string>;
  versions?: Record<string, unknown>;
  maintainers?: unknown[];
  license?: string | { type?: string };
  keywords?: string[];
  repository?: { url?: string } | string;
  homepage?: string;
}

/** Fetch and normalize npm registry metadata for a package. */
export async function inspectNpm(pkg: string): Promise<SourceInfo> {
  const warnings: string[] = [];
  const url = `${REGISTRY}/${encodeURIComponent(pkg).replace("%40", "@")}`;

  let data: NpmPackument | null = null;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.status === 404) {
      return notFound(pkg);
    }
    if (!res.ok) {
      warnings.push(`registry responded ${res.status}`);
    } else {
      data = (await res.json()) as NpmPackument;
    }
  } catch (err) {
    warnings.push(`could not reach npm registry: ${(err as Error).message}`);
  }

  if (!data) {
    return { ...notFound(pkg), warnings, exists: false };
  }

  const latest = data["dist-tags"]?.latest ?? null;
  const publishTime = latest && data.time?.[latest] ? new Date(data.time[latest]) : null;
  const modified = data.time?.modified ? new Date(data.time.modified) : null;
  const lastActivity = publishTime ?? modified;

  const keywords = (data.keywords ?? []).map((k) => k.toLowerCase());
  const desc = data.description ?? null;
  const looksLikeMcp = detectMcp(data.name ?? pkg, desc, keywords);

  const repoUrl =
    typeof data.repository === "string" ? data.repository : data.repository?.url;

  return {
    kind: "npm",
    name: data.name ?? pkg,
    exists: true,
    lastActivity,
    archived: false, // npm has no archived flag
    openIssues: null,
    stars: null,
    license: normalizeLicense(data.license),
    description: desc,
    latestVersion: latest,
    maintainers: Array.isArray(data.maintainers) ? data.maintainers.length : null,
    hasReleases: data.versions ? Object.keys(data.versions).length > 1 : null,
    hasRepoLink: Boolean(repoUrl || data.homepage),
    looksLikeMcp,
    warnings,
  };
}

function normalizeLicense(lic: NpmPackument["license"]): string | null {
  if (!lic) return null;
  if (typeof lic === "string") return lic;
  return lic.type ?? null;
}

function notFound(pkg: string): SourceInfo {
  return {
    kind: "npm",
    name: pkg,
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
    looksLikeMcp: pkg.toLowerCase().includes("mcp"),
    warnings: [],
  };
}
