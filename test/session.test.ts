import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, pointHomeAt } from "./helpers.js";

// session.ts resolves its storage dir from homedir() at import time, so the
// temp home must be in place BEFORE the first import.
const tmp = makeTempDir();
const home = pointHomeAt(tmp);
const { SESSION_DIR, createSession, readSessions } = await import("../src/session.js");
import type { SessionSummary } from "../src/session.js";

after(() => {
  home.restore();
  cleanupTempDir(tmp);
});

function writeSessionFile(name: string, lines: unknown[]): void {
  writeFileSync(
    join(SESSION_DIR, name),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf8",
  );
}

function findSession(sessions: SessionSummary[], server: string): SessionSummary {
  const s = sessions.find((x) => x.server === server);
  assert.ok(s, `expected a session for server ${server}`);
  return s;
}

describe("session storage", () => {
  it("stores data under the (temp) home directory", () => {
    assert.ok(SESSION_DIR.startsWith(tmp), `SESSION_DIR ${SESSION_DIR} should be inside ${tmp}`);
  });

  it("returns no sessions when nothing has been recorded", () => {
    assert.deepEqual(readSessions(), []);
  });

  it("writes a meta line, logged events and an end record", () => {
    const s = createSession("srv-a", "npx -y srv-a");
    assert.ok(s.file.startsWith(SESSION_DIR));
    assert.ok(s.file.endsWith(`${String(process.pid)}.jsonl`));

    s.log({ t: 1, dir: "client", method: "initialize", id: 1 });
    s.end(0);

    const lines = readFileSync(s.file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(lines.length, 3);
    assert.equal(lines[0].type, "meta");
    assert.equal(lines[0].server, "srv-a");
    assert.equal(lines[0].command, "npx -y srv-a");
    assert.equal(lines[1].method, "initialize");
    assert.equal(lines[2].type, "end");
    assert.equal(lines[2].exitCode, 0);
  });

  it("summarizes tool calls, errors and durations", () => {
    writeSessionFile("2026-01-01T00-00-00-000Z-101.jsonl", [
      { type: "meta", server: "crafted", command: "npx -y crafted", startedAt: "2026-01-01T00:00:00.000Z" },
      { t: 1, dir: "client", method: "tools/call", id: 1, tool: "forecast" },
      { t: 2, dir: "server", method: "tools/call", id: 1, tool: "forecast", ok: true, ms: 100 },
      { t: 3, dir: "client", method: "tools/call", id: 2, tool: "alerts" },
      { t: 4, dir: "server", method: "tools/call", id: 2, tool: "alerts", ok: true, ms: 300 },
      { t: 5, dir: "client", method: "tools/call", id: 3, tool: "forecast" },
      { t: 6, dir: "server", method: "tools/call", id: 3, tool: "forecast", ok: false, ms: 200, error: "boom" },
      // a server response that is not a tools/call must not count
      { t: 7, dir: "server", method: "tools/list", id: 4, ok: true, ms: 1 },
      // client-direction traffic never counts as a completed call
      { t: 8, dir: "client", method: "tools/call", id: 9, ok: true, ms: 5 },
      "not json at all",
      { type: "end", exitCode: 0, endedAt: "2026-01-01T01:00:00.000Z" },
    ]);

    const s = findSession(readSessions(), "crafted");
    assert.equal(s.calls, 3);
    assert.equal(s.errors, 1);
    assert.equal(s.avgMs, 200);
    assert.equal(s.slowestMs, 300);
    assert.deepEqual(s.toolCounts, { forecast: 2, alerts: 1 });
    assert.equal(s.lastError, "boom");
    assert.equal(s.ended, true);
    assert.equal(s.crashed, false);
    assert.equal(s.command, "npx -y crafted");
  });

  it("counts an unidentified tool under (unknown)", () => {
    writeSessionFile("2026-01-02T00-00-00-000Z-102.jsonl", [
      { type: "meta", server: "anonymous", command: "x" },
      { t: 1, dir: "server", method: "tools/call", id: 1, ok: true, ms: 10 },
      { type: "end", exitCode: 0 },
    ]);
    const s = findSession(readSessions(), "anonymous");
    assert.deepEqual(s.toolCounts, { "(unknown)": 1 });
  });

  it("treats a session with no end record as crashed", () => {
    writeSessionFile("2026-01-03T00-00-00-000Z-103.jsonl", [
      { type: "meta", server: "died-hard", command: "x" },
      { t: 1, dir: "server", method: "tools/call", id: 1, tool: "t", ok: true, ms: 5 },
    ]);
    const s = findSession(readSessions(), "died-hard");
    assert.equal(s.ended, false);
    assert.equal(s.crashed, true);
  });

  it("treats a non-zero exit code as crashed", () => {
    writeSessionFile("2026-01-04T00-00-00-000Z-104.jsonl", [
      { type: "meta", server: "exited-1", command: "x" },
      { type: "end", exitCode: 3 },
    ]);
    const s = findSession(readSessions(), "exited-1");
    assert.equal(s.ended, true);
    assert.equal(s.crashed, true);
  });

  it("summarizes a file with no meta line as an unknown server", () => {
    writeSessionFile("2026-01-05T00-00-00-000Z-105.jsonl", [
      "garbage line",
      { t: 1, dir: "server", method: "tools/call", id: 1, tool: "t", ok: true, ms: 5 },
      { type: "end", exitCode: 0 },
    ]);
    const s = findSession(readSessions(), "unknown");
    assert.equal(s.calls, 1);
  });

  it("returns newest first and honors the limit", () => {
    // stamps far enough in the future to sort after the real "now"-stamped
    // files that createSession writes in other tests
    writeSessionFile("2099-01-01T00-00-00-000Z-201.jsonl", [
      { type: "meta", server: "oldest", command: "x" },
    ]);
    writeSessionFile("2099-01-02T00-00-00-000Z-202.jsonl", [
      { type: "meta", server: "middle", command: "x" },
    ]);
    writeSessionFile("2099-01-03T00-00-00-000Z-203.jsonl", [
      { type: "meta", server: "newest", command: "x" },
    ]);

    const top2 = readSessions(2);
    assert.equal(top2.length, 2);
    assert.equal(top2[0].server, "newest");
    assert.equal(top2[1].server, "middle");
  });
});
