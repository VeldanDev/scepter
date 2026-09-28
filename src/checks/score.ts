import type { CheckResult, Signal, SourceInfo, Verdict } from "../types.js";

const MONTH = 1000 * 60 * 60 * 24 * 30;

/**
 * Turn gathered facts into signals, a 0-100 score, and a verdict.
 *
 * Weights: Activity 35, Maintained 20, Provenance 15, MCP fit 10, Security 20.
 * Security reads registry/repo metadata plus GitHub's advisory database --
 * "safe to use" now means checking for a known vulnerability directly, not
 * just inferring it from how active a project looks. Deep runtime checks
 * (live handshake, permission introspection, phone-home) are still roadmap
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

  // --- Liveness: last activity (weight 35) ---
  const now = Date.now();
  const age = source.lastActivity ? now - source.lastActivity.getTime() : null;
  if (age === null) {
    signals.push({ key: "alive", label: "Activity", status: "warn", detail: "no date available" });
    score += 12;
  } else {
    const months = age / MONTH;
    if (months <= 3) {
      signals.push({ key: "alive", label: "Activity", status: "ok", detail: `active (${fmtAgo(months)})` });
      score += 35;
    } else if (months <= 12) {
      signals.push({ key: "alive", label: "Activity", status: "warn", detail: `quiet (${fmtAgo(months)})` });
      score += 20;
      reasons.push(`No updates for ${fmtAgo(months)}.`);
    } else {
      signals.push({ key: "alive", label: "Activity", status: "bad", detail: `stale (${fmtAgo(months)})` });
      score += 3;
      reasons.push(`Looks abandoned: last activity ${fmtAgo(months)}.`);
    }
  }

  // --- Maintenance (weight 20) ---
  if (source.archived) {
    signals.push({ key: "archived", label: "Maintained", status: "bad", detail: "repository is archived" });
    reasons.push("Repository is archived by its author.");
  } else {
    let m = 0;
    if (source.license) m += 8;
    else reasons.push("No license declared.");
    if (source.hasReleases) m += 6;
    if (source.hasRepoLink) m += 6;
    else reasons.push("No link back to source code.");
    score += m;
    signals.push({
      key: "maintained",
      label: "Maintained",
      status: m >= 16 ? "ok" : m >= 8 ? "warn" : "bad",
      detail: [
        source.license ? `license ${source.license}` : "no license",
        source.hasReleases ? "has releases" : "no releases",
        source.hasRepoLink ? "linked source" : "no source link",
      ].join(", "),
    });
  }

  // --- Trust / provenance (weight 15) ---
  let t = 0;
  const trustBits: string[] = [];
  if (source.description) {
    t += 4;
    trustBits.push("described");
  } else {
    reasons.push("No description.");
  }
  if (source.stars !== null) {
    if (source.stars >= 50) t += 6;
    else if (source.stars >= 5) t += 4;
    else t += 1;
    trustBits.push(`${source.stars} stars`);
  } else if (source.maintainers !== null) {
    if (source.maintainers >= 2) t += 6;
    else t += 2;
    trustBits.push(`${source.maintainers} maintainer${source.maintainers === 1 ? "" : "s"}`);
  }
  if (source.openIssues !== null) {
    trustBits.push(`${source.openIssues} open issues`);
    if (source.openIssues > 200) reasons.push(`${source.openIssues} open issues piling up.`);
    else t += 5;
  } else {
    t += 2;
  }
  score += Math.min(t, 15);
  signals.push({
    key: "trust",
    label: "Provenance",
    status: t >= 11 ? "ok" : t >= 6 ? "warn" : "bad",
    detail: trustBits.length ? trustBits.join(", ") : "little public signal",
  });

  // --- MCP fit (weight 10) ---
  if (source.looksLikeMcp) {
    score += 10;
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

  // --- Security: known advisories (weight 20) ---
  const adv = source.advisories;
  if (adv === null) {
    score += 10; // couldn't check -- neutral, not a penalty for something we don't know
    signals.push({ key: "security", label: "Security", status: "warn", detail: "could not check advisories" });
  } else if (adv.total === 0) {
    score += 20;
    signals.push({ key: "security", label: "Security", status: "ok", detail: "no known advisories" });
  } else if (adv.critical > 0) {
    signals.push({
      key: "security",
      label: "Security",
      status: "bad",
      detail: `${adv.critical} critical advisor${adv.critical === 1 ? "y" : "ies"} (${adv.total} total)`,
    });
    reasons.push(`${adv.critical} CRITICAL security advisor${adv.critical === 1 ? "y" : "ies"} found.`);
  } else if (adv.high > 0) {
    score += 5;
    signals.push({
      key: "security",
      label: "Security",
      status: "bad",
      detail: `${adv.high} high-severity advisor${adv.high === 1 ? "y" : "ies"} (${adv.total} total)`,
    });
    reasons.push(`${adv.high} high-severity security advisor${adv.high === 1 ? "y" : "ies"} found.`);
  } else {
    score += 12;
    signals.push({
      key: "security",
      label: "Security",
      status: "warn",
      detail: `${adv.total} advisor${adv.total === 1 ? "y" : "ies"} (low/medium severity)`,
    });
    reasons.push(`${adv.total} lower-severity security advisor${adv.total === 1 ? "y" : "ies"} on record.`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const verdict = toVerdict(score, source);

  return { target, source, signals, score, verdict, reasons };
}

function toVerdict(score: number, source: SourceInfo): Verdict {
  if (source.archived) return "risky";
  if (source.advisories && source.advisories.critical > 0) return "risky"; // a critical CVE overrides an otherwise-good score
  if (score >= 75) return "healthy";
  if (score >= 45) return "caution";
  return "risky";
}

export function fmtAgo(months: number): string {
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
