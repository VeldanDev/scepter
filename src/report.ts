import type { CheckResult, Verdict } from "./types.js";
import type { SessionSummary } from "./session.js";
import type { HistoryEntry } from "./history.js";

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
