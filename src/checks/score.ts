import type { CheckResult, Signal, SourceInfo, Verdict } from "../types.js";

const MONTH = 1000 * 60 * 60 * 24 * 30;

/**
 * Turn gathered facts into signals, a 0-100 score, and a verdict.
 *
 * v1 answers the headline question honestly: is this MCP server dead or alive,
 * and is it worth trusting? It reads registry/repo metadata only. Deep runtime
 * checks (live handshake, permission introspection, phone-home) are roadmap
 * (v2), and the report says so rather than pretending.
 */
export function scoreSource(target: string, source: SourceInfo): CheckResult {
  const signals: Signal[] = [];
  const reasons: string[] = [];

  if (!source.exists) {
    signals.push({
      key: "exists",
      label: "Found",
      status: "bad",
      detail: `not found on ${source.kind}`,
    });
    return {
      target,
      source,
      signals,
      score: 0,
      verdict: "risky",
      reasons: [`Nothing published at this ${source.kind} location.`],
    };
  }

  let score = 0;

  // --- Liveness: last activity (weight 40) ---
  const now = Date.now();
  const age = source.lastActivity ? now - source.lastActivity.getTime() : null;
  if (age === null) {
    signals.push({ key: "alive", label: "Activity", status: "warn", detail: "no date available" });
    score += 15;
  } else {
    const months = age / MONTH;
    if (months <= 3) {
      signals.push({ key: "alive", label: "Activity", status: "ok", detail: `active (${fmtAgo(months)})` });
      score += 40;
    } else if (months <= 12) {
      signals.push({ key: "alive", label: "Activity", status: "warn", detail: `quiet (${fmtAgo(months)})` });
      score += 24;
      reasons.push(`No updates for ${fmtAgo(months)}.`);
    } else {
      signals.push({ key: "alive", label: "Activity", status: "bad", detail: `stale (${fmtAgo(months)})` });
      score += 4;
      reasons.push(`Looks abandoned: last activity ${fmtAgo(months)}.`);
    }
  }

  // --- Maintenance (weight 25) ---
  if (source.archived) {
    signals.push({ key: "archived", label: "Maintained", status: "bad", detail: "repository is archived" });
    reasons.push("Repository is archived by its author.");
  } else {
    let m = 0;
    if (source.license) m += 10;
    else reasons.push("No license declared.");
    if (source.hasReleases) m += 8;
    if (source.hasRepoLink) m += 7;
    else reasons.push("No link back to source code.");
    score += m;
    signals.push({
      key: "maintained",
      label: "Maintained",
      status: m >= 17 ? "ok" : m >= 8 ? "warn" : "bad",
      detail: [
        source.license ? `license ${source.license}` : "no license",
        source.hasReleases ? "has releases" : "no releases",
        source.hasRepoLink ? "linked source" : "no source link",
      ].join(", "),
    });
  }

  // --- Trust / provenance (weight 20) ---
  let t = 0;
  const trustBits: string[] = [];
  if (source.description) {
    t += 6;
    trustBits.push("described");
  } else {
    reasons.push("No description.");
  }
  if (source.stars !== null) {
    if (source.stars >= 50) t += 8;
    else if (source.stars >= 5) t += 5;
    else t += 1;
    trustBits.push(`${source.stars} stars`);
  } else if (source.maintainers !== null) {
    if (source.maintainers >= 2) t += 8;
    else t += 3;
    trustBits.push(`${source.maintainers} maintainer${source.maintainers === 1 ? "" : "s"}`);
  }
  if (source.openIssues !== null) {
    trustBits.push(`${source.openIssues} open issues`);
    if (source.openIssues > 200) reasons.push(`${source.openIssues} open issues piling up.`);
    else t += 6;
  } else {
    t += 3;
  }
  score += Math.min(t, 20);
  signals.push({
    key: "trust",
    label: "Provenance",
    status: t >= 14 ? "ok" : t >= 7 ? "warn" : "bad",
    detail: trustBits.length ? trustBits.join(", ") : "little public signal",
  });

  // --- MCP fit (weight 15) ---
  if (source.looksLikeMcp) {
    score += 15;
    signals.push({ key: "mcp", label: "MCP fit", status: "ok", detail: "declares itself an MCP server" });
  } else {
    signals.push({
      key: "mcp",
      label: "MCP fit",
      status: "warn",
      detail: "no clear MCP signal (keyword/topic/description)",
    });
    reasons.push("Could not confirm this is an MCP server from its metadata.");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const verdict = toVerdict(score, source);

  return { target, source, signals, score, verdict, reasons };
}

function toVerdict(score: number, source: SourceInfo): Verdict {
  if (source.archived) return "risky";
  if (score >= 75) return "healthy";
  if (score >= 45) return "caution";
  return "risky";
}

function fmtAgo(months: number): string {
  if (months < 1) {
    const days = Math.max(1, Math.round(months * 30));
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }
  if (months < 12) {
    const m = Math.round(months);
    return `${m} month${m === 1 ? "" : "s"} ago`;
  }
  const years = (months / 12).toFixed(1).replace(/\.0$/, "");
  return `${years} year${years === "1" ? "" : "s"} ago`;
}
