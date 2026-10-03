import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanupTempDir, makeTempDir, makeResult, makeSource } from "./helpers.js";
import type { SessionSummary } from "../src/session.js";

// report.ts decides on color at module load, so make it deterministic before importing.
process.env.NO_COLOR = "1";
const { renderResult, renderTrend, renderSparkline, renderScanLine, renderWatchLine, renderSessionReport } =
  await import("../src/report.js");

const tmp = makeTempDir();
after(() => cleanupTempDir(tmp));

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    file: "/tmp/session.jsonl",
    server: "weather-mcp",
    command: "npx -y weather-mcp",
    startedAt: "2026-10-03T00:00:00.000Z",
    calls: 5,
    errors: 0,
    avgMs: 120,
    slowestMs: 300,
    toolCounts: { forecast: 5 },
    crashed: false,
    ended: true,
    lastError: null,
    ...overrides,
  };
}

describe("renderResult", () => {
  it("renders the header, score line and signals", () => {
    const out = renderResult(makeResult());
    assert.match(out, /owner\/repo \(github\)/);
    assert.match(out, /SCORE 97\/100 · HEALTHY/);
    assert.match(out, /✓ Activity/);
    assert.match(out, /✓ Security/);
  });

  it("shows the description when present", () => {
    assert.match(renderResult(makeResult()), /A Model Context Protocol server/);
  });

  it("omits the description when absent", () => {
    const out = renderResult(makeResult({ source: makeSource({ description: null }) }));
    assert.match(out, /owner\/repo \(github\)/);
    assert.doesNotMatch(out, /Model Context Protocol server\n/);
  });

  it("renders reasons as dim bullets only when present", () => {
    const clean = renderResult(makeResult());
    assert.doesNotMatch(clean, /- /);

    const withReasons = renderResult(makeResult({ reasons: ["No license declared."] }));
    assert.match(withReasons, /- No license declared\./);
  });

  it("renders warnings as notes only when present", () => {
    const out = renderResult(
      makeResult({ source: makeSource({ warnings: ["could not reach npm registry"] }) }),
    );
    assert.match(out, /note: could not reach npm registry/);
  });

  it("renders a not-found result with a bad mark and RISKY score", () => {
    const out = renderResult(
      makeResult({
        score: 0,
        verdict: "risky",
        signals: [{ key: "exists", label: "Found", status: "bad", detail: "not found on github" }],
      }),
    );
    assert.match(out, /× Found/);
    assert.match(out, /SCORE 0\/100 · RISKY/);
  });

  it("uses the warn mark for warn signals", () => {
    const out = renderResult(
      makeResult({
        signals: [{ key: "security", label: "Security", status: "warn", detail: "could not check advisories" }],
      }),
    );
    assert.match(out, /! Security/);
  });
});

describe("renderTrend", () => {
  const current = makeResult();

  it("returns null for a first-ever check", () => {
    assert.equal(renderTrend(null, current), null);
  });

  it("renders an upward delta with the verdict flip", () => {
    const line = renderTrend({ t: Date.now() - 90_000, score: 50, verdict: "caution" }, current);
    assert.ok(line);
    assert.match(line, /▲ \+47 pts since last check \(2m ago, was 50\/100\)/);
    assert.match(line, /CAUTION → HEALTHY/);
  });

  it("renders a downward delta", () => {
    const line = renderTrend({ t: Date.now() - 3_600_000, score: 99, verdict: "healthy" }, current);
    assert.ok(line);
    assert.match(line, /▼ -2 pts/);
    assert.doesNotMatch(line, /→/);
  });

  it("reports 'no change' and no flip when identical", () => {
    const line = renderTrend({ t: Date.now() - 5_000, score: 97, verdict: "healthy" }, current);
    assert.ok(line);
    assert.match(line, /▬ no change since last check/);
    assert.doesNotMatch(line, /→/);
  });

  it("formats recency across scales", () => {
    const cases: Array<[number, RegExp]> = [
      [1_000, /just now/],
      [5_000, /5s ago/],
      [30_000, /30s ago/],
      [2 * 60_000, /2m ago/],
      [2 * 3_600_000, /2h ago/],
      [5 * 24 * 3_600_000, /5d ago/],
      [45 * 24 * 3_600_000, /2mo ago/],
      [400 * 24 * 3_600_000, /1\.1y ago/],
    ];
    for (const [ago, expected] of cases) {
      const line = renderTrend({ t: Date.now() - ago, score: 50, verdict: "caution" }, current);
      assert.ok(line);
      assert.match(line, expected, `expected ${expected} for ${ago}ms`);
    }
  });

  it("handles a future timestamp without going negative", () => {
    const line = renderTrend({ t: Date.now() + 60_000, score: 50, verdict: "caution" }, current);
    assert.ok(line);
    assert.match(line, /just now/);
  });
});

describe("renderSparkline", () => {
  it("returns empty for fewer than two entries", () => {
    assert.equal(renderSparkline([]), "");
    assert.equal(renderSparkline([{ t: 1, score: 50, verdict: "caution" }]), "");
  });

  it("maps scores to blocks across the 0-100 range", () => {
    assert.equal(
      renderSparkline([
        { t: 1, score: 0, verdict: "risky" },
        { t: 2, score: 100, verdict: "healthy" },
      ]),
      " █",
    );
    assert.equal(
      renderSparkline([
        { t: 1, score: 50, verdict: "caution" },
        { t: 2, score: 50, verdict: "caution" },
      ]),
      "▄▄",
    );
  });

  it("caps the sparkline at the last 30 checks", () => {
    const history = Array.from({ length: 31 }, (_, i) => ({
      t: i,
      score: 50,
      verdict: "caution" as const,
    }));
    assert.equal(renderSparkline(history).length, 30);
  });
});

describe("renderScanLine", () => {
  it("shows verdict, score and name", () => {
    const line = renderScanLine(makeResult());
    assert.match(line, /HEALTHY/);
    assert.match(line, /97/);
    assert.match(line, /owner\/repo/);
  });

  it("shows risky verdicts", () => {
    const line = renderScanLine(makeResult({ verdict: "risky", score: 12 }));
    assert.match(line, /RISKY/);
    assert.match(line, / 12/);
  });
});

describe("renderWatchLine", () => {
  it("shows score and flags changes", () => {
    const changed = renderWatchLine(makeResult(), true);
    assert.match(changed, /\d\d:\d\d:\d\d/);
    assert.match(changed, / 97\/100/);
    assert.match(changed, /← changed/);

    const quiet = renderWatchLine(makeResult(), false);
    assert.doesNotMatch(quiet, /← changed/);
  });
});

describe("renderSessionReport", () => {
  it("has an actionable empty state", () => {
    const out = renderSessionReport([]);
    assert.match(out, /No sessions recorded yet\./);
    assert.match(out, /scepter wrap -- npx -y some-mcp-server/);
  });

  it("lists calls, errors and timings", () => {
    const out = renderSessionReport([session()]);
    assert.match(out, /Recent MCP sessions/);
    assert.match(out, /weather-mcp/);
    assert.match(out, /All wrapped servers ran clean\./);
  });

  it("alerts on failing servers and suggests a check", () => {
    const out = renderSessionReport(
      [session({ errors: 2, lastError: "boom" })],
    );
    assert.match(out, /Heads up/);
    assert.match(out, /weather-mcp failed 2 of 5 calls \(last: "boom"\)/);
    assert.match(out, /scepter check weather-mcp/);
    assert.doesNotMatch(out, /All wrapped servers ran clean\./);
  });

  it("mentions a crash even without tool errors", () => {
    const out = renderSessionReport([session({ crashed: true })]);
    assert.match(out, /exited unexpectedly this session\./);
  });

  it("truncates very long server names", () => {
    const out = renderSessionReport([session({ server: "x".repeat(40) })]);
    assert.match(out, /…/);
  });

  it("renders '-' for sessions without timing data", () => {
    const out = renderSessionReport([session({ avgMs: null, slowestMs: null })]);
    assert.match(out, /-/);
  });
});
