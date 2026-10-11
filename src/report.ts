import type { CheckResult, Verdict } from "./types.js";
import type { SessionSummary } from "./session.js";
import type { HistoryEntry } from "./history.js";
import type { AuditResult, InspectResult } from "./inspect.js";

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

/** "since last check" line: score delta and, if it flipped, the verdict change. Null when this is the first-ever check. */
export function renderTrend(previous: HistoryEntry | null, current: CheckResult): string | null {
  if (!previous) return null;
  const delta = current.score - previous.score;
  const arrow = delta > 0 ? c.green("▲") : delta < 0 ? c.red("▼") : c.dim("▬");
  const deltaStr = delta === 0 ? "no change" : `${delta > 0 ? "+" : ""}${delta} pts`;
  const since = fmtRecency(Date.now() - previous.t);
  let line = `  ${arrow} ${deltaStr} since last check (${since}, was ${previous.score}/100)`;
  if (previous.verdict !== current.verdict) {
    line += `  ${c.bold(paintVerdict(current.verdict, `${VERDICT_LABEL[previous.verdict]} → ${VERDICT_LABEL[current.verdict]}`))}`;
  }
  return line;
}

/** Fine-grained "time ago" for the trend line -- unlike score.ts's fmtAgo
 * (built for months-scale activity dates), this handles seconds through
 * years, since successive `check`/`watch` calls can be minutes apart. */
function fmtRecency(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return sec <= 1 ? "just now" : `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const month = Math.round(day / 30);
  if (month < 12) return `${month}mo ago`;
  const year = (day / 365).toFixed(1).replace(/\.0$/, "");
  return `${year}y ago`;
}

/** Tiny ASCII sparkline of score history, oldest to newest. */
export function renderSparkline(history: HistoryEntry[]): string {
  if (history.length < 2) return "";
  const blocks = " ▁▂▃▄▅▆▇█";
  const points = history
    .slice(-30)
    .map((h) => blocks[Math.max(0, Math.min(blocks.length - 1, Math.round((h.score / 100) * (blocks.length - 1))))]);
  return points.join("");
}

/** Human-readable report for one result. `previous` (from history.ts) adds a trend line when available. */
export function renderResult(r: CheckResult, previous?: HistoryEntry | null): string {
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

  const trend = renderTrend(previous ?? null, r);
  if (trend) lines.push(trend);

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

/** One line per tick in `watch` mode: timestamp, verdict, score, and whether it just changed. */
export function renderWatchLine(r: CheckResult, changed: boolean): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const tag = paintVerdict(r.verdict, VERDICT_LABEL[r.verdict].padEnd(7));
  const flag = changed ? `  ${c.bold(c.yellow("← changed"))}` : "";
  return `  ${c.dim(time)}  ${tag} ${String(r.score).padStart(3)}/100${flag}`;
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

/** Report for `scepter inspect`: what the live server actually hands the agent. */
export function renderInspect(r: InspectResult): string {
  const lines = ["", `  ${c.bold(r.server)} ${c.dim(`(live, MCP ${r.protocolVersion ?? "unknown"})`)}`, ""];
  const cost = r.contextTokens >= 10_000 ? MARK.warn : MARK.ok;
  lines.push(`  ${MARK.ok} ${"Tools".padEnd(12)} ${c.dim(`${r.tools} tools, ${r.annotated} with safety annotations`)}`);
  lines.push(`  ${cost} ${"Context".padEnd(12)} ${c.dim(`~${r.contextTokens.toLocaleString("en-US")} tokens of tool definitions on every turn`)}`);
  if (!r.changes) {
    lines.push(`  ${MARK.ok} ${"Pinned".padEnd(12)} ${c.dim("first inspection, tool list pinned for next time")}`);
  } else {
    const { added, removed, changed } = r.changes;
    const mark = changed.length ? MARK.warn : MARK.ok;
    const parts = [changed.length && `${changed.length} changed`, added.length && `${added.length} added`, removed.length && `${removed.length} removed`].filter(Boolean);
    lines.push(`  ${mark} ${"Pinned".padEnd(12)} ${c.dim(parts.length ? parts.join(", ") + " since last inspection" : "no tool changes since last inspection")}`);
    for (const n of changed) lines.push(`    ${c.yellow("changed:")} ${n}`);
  }
  const bad = r.findings.filter((f) => f.level === "bad").length;
  lines.push(`  ${r.findings.length ? (bad ? MARK.bad : MARK.warn) : MARK.ok} ${"Tool audit".padEnd(12)} ${c.dim(r.findings.length ? `${r.findings.length} finding(s)` : "no poisoned or unmarked destructive tools")}`);
  for (const f of r.findings) lines.push(`    ${f.level === "bad" ? c.red(f.tool) : c.yellow(f.tool)} ${c.dim(f.detail)}`);
  lines.push("", `  ${paintVerdict(r.verdict, VERDICT_LABEL[r.verdict])}`, "");
  return lines.join("\n");
}

/** Report for `scepter audit`: one line per server, then any toxic flow across them. */
export function renderAudit(r: AuditResult): string {
  const lines = [""];
  for (const s of r.servers) {
    if ("error" in s) {
      lines.push(`  ${c.dim("SKIPPED")} ${s.server}  ${c.dim(s.error)}`);
      continue;
    }
    const tag = paintVerdict(s.verdict, VERDICT_LABEL[s.verdict].padEnd(7));
    lines.push(`  ${tag} ${s.server}  ${c.dim(`${s.tools} tools, ~${s.contextTokens.toLocaleString("en-US")} tokens`)}`);
    for (const f of s.findings) lines.push(`    ${f.level === "bad" ? c.red(f.tool) : c.yellow(f.tool)} ${c.dim(f.detail)}`);
    for (const n of s.changes?.changed ?? []) lines.push(`    ${c.yellow(n)} ${c.dim("changed since last audit")}`);
  }
  const live = r.servers.filter((s): s is InspectResult => !("error" in s));
  const total = live.reduce((n, s) => n + s.contextTokens, 0);
  lines.push("", `  ${c.dim(`Together: ${live.reduce((n, s) => n + s.tools, 0)} tools, ~${total.toLocaleString("en-US")} tokens of context on every turn`)}`);
  if (r.flow) {
    const show = (xs: string[]) => xs.slice(0, 3).join(", ") + (xs.length > 3 ? ` +${xs.length - 3}` : "");
    lines.push(
      "",
      `  ${MARK.warn} ${c.yellow("Toxic flow")}  ${c.dim("content from outside can steer the agent to read private data and send it out")}`,
      `    ${c.dim("reads untrusted content:")} ${show(r.flow.untrusted)}`,
      `    ${c.dim("reads private data:     ")} ${show(r.flow.private)}`,
      `    ${c.dim("can send it out:        ")} ${show(r.flow.outbound)}`,
    );
  }
  lines.push("", `  ${paintVerdict(r.verdict, VERDICT_LABEL[r.verdict])}`, "");
  return lines.join("\n");
}
