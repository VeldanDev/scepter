import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckResult, SourceInfo } from "../src/types.js";

// --- fetch stub -------------------------------------------------------------
// All network-touching code (npm registry, GitHub API, advisories) goes through
// global fetch, so replacing it keeps the suite fully offline. Any URL a stub
// was not taught to answer throws, which both fails the test and guarantees no
// real request can leak out.

export interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

export function jsonResponse(status: number, body: unknown): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

export interface FetchCall {
  url: string;
  init?: { headers?: Record<string, string> };
}

export type FetchHandler = (
  url: string,
  init?: RequestInit,
) => FakeResponse | Promise<FakeResponse> | undefined;

export interface FetchMock {
  calls: FetchCall[];
  restore(): void;
}

export function installFetchMock(handler: FetchHandler): FetchMock {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  const fake = ((url: unknown, init?: unknown) => {
    const strUrl = String(url);
    calls.push({ url: strUrl, init: init as FetchCall["init"] });
    return Promise.resolve(handler(strUrl, init as RequestInit | undefined)).then(
      (res) => {
        if (res) return res as unknown as Response;
        throw new Error(`test fetch stub got an unexpected URL: ${strUrl}`);
      },
    );
  }) as typeof fetch;
  globalThis.fetch = fake;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

// --- temp directories -------------------------------------------------------

export function makeTempDir(prefix = "scepter-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // best effort; a leftover temp dir must not fail the suite
  }
}

/** Point HOME/USERPROFILE at a temp dir so history/session writes land there. Must run before importing history.ts or session.ts (they resolve homedir() at module load). */
export function pointHomeAt(dir: string): { restore(): void } {
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return {
    restore() {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
    },
  };
}

// --- token env guard --------------------------------------------------------

const TOKEN_KEYS = ["GITHUB_TOKEN", "GH_TOKEN"] as const;

/** Save-and-clear GITHUB_TOKEN/GH_TOKEN so auth-dependent behavior is deterministic; call the returned fn in `after`/`teardown`. */
export function clearGitHubTokens(): () => void {
  const saved = TOKEN_KEYS.map((k) => [k, process.env[k]] as const);
  for (const k of TOKEN_KEYS) delete process.env[k];
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

// --- fixtures ---------------------------------------------------------------

/** A github SourceInfo in a state that scores a perfect 100/healthy. */
export function makeSource(overrides: Partial<SourceInfo> = {}): SourceInfo {
  return {
    kind: "github",
    name: "owner/repo",
    exists: true,
    lastActivity: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    archived: false,
    openIssues: 5,
    stars: 120,
    license: "MIT",
    description: "A Model Context Protocol server",
    latestVersion: null,
    maintainers: null,
    hasReleases: true,
    hasRepoLink: true,
    looksLikeMcp: true,
    advisories: { total: 0, critical: 0, high: 0 },
    warnings: [],
    ...overrides,
  };
}

export function makeResult(overrides: Partial<CheckResult> = {}): CheckResult {
  const source = overrides.source ?? makeSource();
  return {
    target: "owner/repo",
    source,
    signals: [
      { key: "alive", label: "Activity", status: "ok", detail: "active (10 days ago)" },
      { key: "security", label: "Security", status: "ok", detail: "no known advisories" },
    ],
    score: 97,
    verdict: "healthy",
    reasons: [],
    ...overrides,
  };
}
