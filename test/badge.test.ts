import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runBadge } from "../src/badge.js";
import { installFetchMock, jsonResponse } from "./helpers.js";

const DAY = 24 * 60 * 60 * 1000;

const REPO = {
  full_name: "owner/repo",
  description: "MCP server for weather",
  archived: false,
  pushed_at: new Date(Date.now() - 5 * DAY).toISOString(),
  open_issues_count: 3,
  stargazers_count: 80,
  license: { spdx_id: "MIT", name: "MIT License" },
  topics: ["mcp"],
};

function npmPackumentCaution(): Record<string, unknown> {
  // quiet publish + 1 maintainer + no description => score 74 (caution)
  return {
    name: "some-mcp",
    "dist-tags": { latest: "1.1.0" },
    time: {
      "1.0.0": new Date(Date.now() - 300 * DAY).toISOString(),
      "1.1.0": new Date(Date.now() - 200 * DAY).toISOString(),
      modified: new Date(Date.now() - 200 * DAY).toISOString(),
    },
    versions: { "1.0.0": {}, "1.1.0": {} },
    maintainers: [{ name: "a" }],
    license: "MIT",
    keywords: ["mcp"],
    repository: { url: "git+https://github.com/owner/some-mcp.git" },
  };
}

function stubGithubHealthy() {
  return installFetchMock((url) => {
    if (/\/repos\/[\w.-]+\/[\w.-]+$/.test(url)) return jsonResponse(200, REPO);
    if (url.includes("/releases")) return jsonResponse(200, [{}]);
    if (url.includes("/security-advisories")) return jsonResponse(200, []);
    return undefined;
  });
}

function stubNpm(packument: Record<string, unknown>) {
  return installFetchMock((url) => {
    if (url.startsWith("https://registry.npmjs.org/")) return jsonResponse(200, packument);
    if (url.startsWith("https://api.github.com/advisories")) return jsonResponse(200, []);
    return undefined;
  });
}

function captureStdout(): { output(): string; restore(): void } {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    output: () => chunks.join(""),
    restore() {
      process.stdout.write = original;
    },
  };
}

describe("runBadge", () => {
  it("prints a shields.io markdown badge for a healthy github repo", async () => {
    const mock = stubGithubHealthy();
    const cap = captureStdout();
    const prevExit = process.exitCode;
    try {
      await runBadge("https://github.com/owner/repo", undefined, false);
      const out = cap.output();
      const expectedBadge =
        "[![MCP health](https://img.shields.io/badge/MCP_health-100%2F100_healthy-brightgreen)](https://github.com/owner/repo)";
      assert.match(out, /Copy this into your README/);
      assert.match(out, new RegExp(expectedBadge.replace(/[[\]()]/g, "\\$&")));
      assert.equal(process.exitCode, prevExit ?? 0);
    } finally {
      mock.restore();
      cap.restore();
      process.exitCode = prevExit;
    }
  });

  it("uses the yellow badge and npmjs link for a caution package", async () => {
    const mock = stubNpm(npmPackumentCaution());
    const cap = captureStdout();
    try {
      await runBadge("some-mcp", undefined, false);
      const out = cap.output();
      assert.match(out, /74%2F100_caution-yellow/);
      assert.match(out, /https:\/\/www\.npmjs\.com\/package\/some-mcp/);
    } finally {
      mock.restore();
      cap.restore();
    }
  });

  it("marks risky targets red and sets exit code 1", async () => {
    const mock = installFetchMock((url) => {
      if (url.startsWith("https://registry.npmjs.org/")) return jsonResponse(404, {});
      return undefined;
    });
    const cap = captureStdout();
    try {
      await runBadge("ghost-pkg", undefined, false);
      const out = cap.output();
      assert.match(out, /0%2F100_risky-red/);
      assert.equal(process.exitCode, 1);
    } finally {
      mock.restore();
      cap.restore();
      process.exitCode = 0;
    }
  });

  it("emits machine-readable JSON in --json mode without touching exit code", async () => {
    const mock = stubGithubHealthy();
    const cap = captureStdout();
    const prevExit = process.exitCode;
    try {
      await runBadge("owner/repo", "github", true);
      const parsed = JSON.parse(cap.output()) as {
        target: string;
        score: number;
        verdict: string;
        badgeUrl: string;
        markdown: string;
      };
      assert.equal(parsed.target, "owner/repo");
      assert.equal(parsed.score, 100);
      assert.equal(parsed.verdict, "healthy");
      assert.match(parsed.badgeUrl, /^https:\/\/img\.shields\.io\/badge\//);
      assert.match(parsed.markdown, /^\[!\[MCP health\]\(/);
      assert.equal(process.exitCode, prevExit ?? 0);
    } finally {
      mock.restore();
      cap.restore();
      process.exitCode = prevExit;
    }
  });

  it("escapes shields.io special characters in the message", async () => {
    const mock = stubNpm(npmPackumentCaution());
    const cap = captureStdout();
    try {
      await runBadge("some-mcp", undefined, false);
      assert.match(cap.output(), /badge\/MCP_health-74%2F100_caution-yellow/);
    } finally {
      mock.restore();
      cap.restore();
    }
  });
});
