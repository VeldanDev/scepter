import { resolveTarget } from "./resolve.js";
import { inspectNpm } from "./checks/npm.js";
import { inspectGithub } from "./checks/github.js";
import { scoreSource } from "./checks/score.js";
import type { CheckResult, SourceKind } from "./types.js";

export type { CheckResult, SourceInfo, Signal, Verdict } from "./types.js";

/**
 * Check one MCP server (npm package or GitHub repo) and return a scored result.
 * `force` overrides the npm-vs-github guess.
 */
export async function checkTarget(target: string, force?: SourceKind): Promise<CheckResult> {
  const resolved = resolveTarget(target, force);
  const source =
    resolved.kind === "npm"
      ? await inspectNpm(resolved.id)
      : await inspectGithub(resolved.id);
  return scoreSource(target, source);
}
