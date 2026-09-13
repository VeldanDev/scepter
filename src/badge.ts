import { checkTarget } from "./index.js";
import type { SourceKind, Verdict } from "./types.js";

// A shareable README badge. Devs love a badge, and every repo that adds one
// quietly advertises Scepter. Uses shields.io static badges (just an image URL,
// no service to run).

const COLOR: Record<Verdict, string> = {
  healthy: "brightgreen",
  caution: "yellow",
  risky: "red",
};

/** shields.io escaping: dash -> "--", underscore -> "__", space -> "_". */
function shield(s: string): string {
  return s.replace(/-/g, "--").replace(/_/g, "__").replace(/ /g, "_").replace(/\//g, "%2F");
}

export async function runBadge(target: string, force: SourceKind | undefined, json: boolean): Promise<void> {
  const r = await checkTarget(target, force);
  const message = `${r.score}/100 ${r.verdict}`;
  const url = `https://img.shields.io/badge/${shield("MCP health")}-${shield(message)}-${COLOR[r.verdict]}`;
  const link = r.source.kind === "github" ? `https://github.com/${r.source.name}` : `https://www.npmjs.com/package/${r.source.name}`;
  const markdown = `[![MCP health](${url})](${link})`;

  if (json) {
    process.stdout.write(JSON.stringify({ target, score: r.score, verdict: r.verdict, badgeUrl: url, markdown }, null, 2) + "\n");
    return;
  }
  process.stdout.write("\n  Copy this into your README:\n\n");
  process.stdout.write(`  ${markdown}\n\n`);
  process.exitCode = r.verdict === "risky" ? 1 : 0;
}
