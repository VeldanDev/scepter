import type { SourceKind } from "./types.js";

export interface ResolvedTarget {
  kind: SourceKind;
  /** For github: "owner/repo". For npm: the package name. */
  id: string;
}

/**
 * Work out whether a target string points at a GitHub repo or an npm package.
 *
 * Rules, in order:
 *  - a github.com URL              -> github "owner/repo"
 *  - a starting "@"                -> npm (scoped package, e.g. @scope/name)
 *  - "owner/repo" (one slash)      -> github
 *  - anything else (single token)  -> npm
 *
 * `force` lets the CLI override the guess with --github / --npm.
 */
export function resolveTarget(input: string, force?: SourceKind): ResolvedTarget {
  const raw = input.trim();

  const ghUrl = raw.match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  if (ghUrl) {
    const owner = ghUrl[1];
    const repo = ghUrl[2].replace(/\.git$/i, "");
    return { kind: force ?? "github", id: `${owner}/${repo}` };
  }

  if (force) {
    return { kind: force, id: normalizeId(raw, force) };
  }

  if (raw.startsWith("@")) {
    return { kind: "npm", id: raw };
  }

  const slashParts = raw.split("/").filter(Boolean);
  if (slashParts.length === 2 && !raw.startsWith("@")) {
    return { kind: "github", id: `${slashParts[0]}/${slashParts[1]}` };
  }

  return { kind: "npm", id: raw };
}

function normalizeId(raw: string, kind: SourceKind): string {
  if (kind === "github") {
    const parts = raw.split("/").filter(Boolean);
    if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1].replace(/\.git$/i, "")}`;
  }
  return raw;
}
