import type { CheckResult, Verdict } from "./types.js";
import type { SessionSummary } from "./session.js";

// Minimal ANSI helpers. No dependency; colors auto-disable when not a TTY or
// when NO_COLOR is set (https://no-color.org).
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  dim: wrap("2"),
  bold: wrap("1"),
  green: wrap("32"),
  yellow: wrap("33"),
  red: wrap("31"),
  brass: wrap("38;5;179"),
};

const MARK = { ok: c.green("✓"), warn: c.yellow("!"), bad: c.red("×") };

const VERDICT_LABEL: Record<Verdict, string> = {
  healthy: "HEALTHY",
  caution: "CAUTION",
  risky: "RISKY",
};

function paintVerdict(v: Verdict, text: string): string {
  if (v === "healthy") return c.green(text);
  if (v === "caution") return c.yellow(text);
  return c.red(text);
}

/** Human-readable report for one result. */
export function renderResult(r: CheckResult): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  ${c.bold(r.source.name)} ${c.dim(`(${r.source.kind})`)}`);
  if (r.source.description) lines.push(`  ${c.dim(r.source.description)}`);
  lines.push("");

  for (const s of r.signals) {
    const mark = MARK[s.status];
    lines.push(`  ${mark} ${s.label.padEnd(12)} ${c.dim(s.detail)}`);
  }

  lines.push("");
  const scoreStr = `${r.score}/100`;
  lines.push(`  ${paintVerdict(r.verdict, `SCORE ${scoreStr} · ${VERDICT_LABEL[r.verdict]}`)}`);

  if (r.reasons.length) {
    for (const reason of r.reasons) lines.push(`  ${c.dim("- " + reason)}`);
  }
  if (r.source.warnings.length) {
    lines.push("");
    for (const w of r.source.warnings) lines.push(`  ${c.dim("note: " + w)}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Compact one-line summary, used by scan. */
export function renderScanLine(r: CheckResult): string {
  const tag = paintVerdict(r.verdict, VERDICT_LABEL[r.verdict].padEnd(7));
  return `  ${tag} ${String(r.score).padStart(3)}  ${r.source.name}`;
}

/** Report of recorded wrap sessions: what the agent actually called. */
export function renderSessionReport(sessions: SessionSummary[]): string {
  if (sessions.length === 0) {
    return [
      "",
      "  No sessions recorded yet.",
      "",
      "  Wrap a server to record what your agent calls:",
      `    ${c.brass("scepter wrap -- npx -y some-mcp-server")}`,
      "",
      "  Put that in front of the real command in your MCP client config,",
      "  then use your agent as normal and come back here.",
      "",
    ].join("\n");
  }

  const lines: string[] = ["", `  ${c.bold("Recent MCP sessions")}   ${c.dim(`(${sessions.length})`)}`, ""];
  lines.push(c.dim("  SERVER".padEnd(32) + "CALLS   ERR    AVG    SLOW"));

  const alerts: string[] = [];
  for (const s of sessions) {
    const name = s.server.length > 28 ? s.server.slice(0, 27) + "…" : s.server;
    const errStr = s.errors > 0 ? c.red(String(s.errors).padStart(3)) : c.dim("  0");
    const avg = s.avgMs !== null ? `${s.avgMs}ms` : "-";
    const slow = s.slowestMs !== null ? `${s.slowestMs}ms` : "-";
    const crash = s.crashed ? "  " + c.red("crashed") : "";
    lines.push(
      "  " +
        name.padEnd(30) +
        String(s.calls).padStart(4) +
        "   " +
        errStr +
        "   " +
        avg.padStart(6) +
        "  " +
        slow.padStart(6) +
        crash,
    );

    if (s.errors > 0) {
      const tail = s.lastError ? ` (last: "${s.lastError}")` : "";
      alerts.push(
        `  - ${c.bold(s.server)} failed ${s.errors} of ${s.calls} calls${tail}. Check it: ${c.brass("scepter check " + s.server)}`,
      );
    } else if (s.crashed) {
      alerts.push(`  - ${c.bold(s.server)} exited unexpectedly this session.`);
    }
  }

  if (alerts.length) {
    lines.push("", `  ${c.yellow("Heads up")}`);
    lines.push(...alerts);
  } else {
    lines.push("", c.green("  All wrapped servers ran clean."));
  }
  lines.push("");
  return lines.join("\n");
}
