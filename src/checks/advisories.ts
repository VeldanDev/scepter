// Known security advisories, via GitHub's advisory database -- the one real
// safety signal the original scoring model was missing. A server can be
// active, licensed, and well-starred and still ship a known vulnerability;
// "safe to use" should mean checking for that directly, not just inferring
// it from maintenance activity.

export interface AdvisorySummary {
  total: number;
  critical: number;
  high: number;
}

const GH_API = "https://api.github.com";

interface RawAdvisory {
  severity?: string;
}

function summarize(list: RawAdvisory[]): AdvisorySummary {
  return {
    total: list.length,
    critical: list.filter((a) => a.severity === "critical").length,
    high: list.filter((a) => a.severity === "high").length,
  };
}

/** Known advisories affecting an npm package, from GitHub's global advisory database. Null = couldn't check (not "zero found"). */
export async function advisoriesForNpm(pkgName: string): Promise<AdvisorySummary | null> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "scepter-mcp",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;

  try {
    const res = await fetch(
      `${GH_API}/advisories?ecosystem=npm&affects=${encodeURIComponent(pkgName)}&per_page=25`,
      { headers },
    );
    if (!res.ok) return null;
    return summarize((await res.json()) as RawAdvisory[]);
  } catch {
    return null;
  }
}

/** Advisories published against a specific GitHub repository. Null = couldn't check (private feature, no access, rate limit, etc.), never treated as "zero". */
export async function advisoriesForGithub(id: string, headers: Record<string, string>): Promise<AdvisorySummary | null> {
  try {
    const res = await fetch(`${GH_API}/repos/${id}/security-advisories?per_page=25`, { headers });
    if (!res.ok) return null;
    return summarize((await res.json()) as RawAdvisory[]);
  } catch {
    return null;
  }
}
