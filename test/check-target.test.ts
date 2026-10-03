import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { checkTarget } from "../src/index.js";
import { clearGitHubTokens, installFetchMock, jsonResponse } from "./helpers.js";

const DAY = 24 * 60 * 60 * 1000;

const PERFECT_PACKUMENT = {
  name: "some-mcp",
  description: "An MCP server for weather",
  "dist-tags": { latest: "1.2.0" },
  time: { "1.2.0": new Date(Date.now() - 3 * DAY).toISOString() },
  versions: { "1.0.0": {}, "1.1.0": {}, "1.2.0": {} },
  maintainers: [{}, {}, {}],
  license: "MIT",
  keywords: ["mcp"],
  repository: { url: "git+https://github.com/owner/some-mcp.git" },
};

describe("checkTarget (integration over resolve + checks + score)", () => {
  let restoreTokens: () => void;
  beforeEach(() => {
    restoreTokens = clearGitHubTokens();
  });
  afterEach(() => {
    restoreTokens();
  });

  it("checks an npm package end-to-end", async () => {
    const mock = installFetchMock((url) => {
      if (url.startsWith("https://registry.npmjs.org/")) return jsonResponse(200, PERFECT_PACKUMENT);
      if (url.startsWith("https://api.github.com/advisories")) return jsonResponse(200, []);
      return undefined;
    });
    try {
      const r = await checkTarget("some-mcp");
      assert.equal(r.target, "some-mcp");
      assert.equal(r.source.kind, "npm");
      assert.equal(r.score, 97);
      assert.equal(r.verdict, "healthy");
    } finally {
      mock.restore();
    }
  });

  it("routes github targets to the GitHub API", async () => {
    const mock = installFetchMock((url) => {
      if (/\/repos\/[\w.-]+\/[\w.-]+$/.test(url)) {
        return jsonResponse(200, {
          full_name: "owner/repo",
          description: "An MCP server for weather",
          pushed_at: new Date(Date.now() - 3 * DAY).toISOString(),
          stargazers_count: 80,
          open_issues_count: 3,
          license: { spdx_id: "MIT" },
          topics: ["mcp"],
        });
      }
      if (url.includes("/releases")) return jsonResponse(200, [{}]);
      if (url.includes("/security-advisories")) return jsonResponse(200, []);
      return undefined;
    });
    try {
      const r = await checkTarget("owner/repo");
      assert.equal(r.source.kind, "github");
      assert.equal(mock.calls[0].url, "https://api.github.com/repos/owner/repo");
      assert.equal(r.score, 100);
    } finally {
      mock.restore();
    }
  });

  it("routes scoped package names to npm", async () => {
    const mock = installFetchMock((url) => {
      if (url === "https://registry.npmjs.org/@scope/name") return jsonResponse(404, {});
      return undefined;
    });
    try {
      const r = await checkTarget("@scope/name");
      assert.equal(r.source.kind, "npm");
      assert.equal(r.source.exists, false);
      assert.equal(r.verdict, "risky");
    } finally {
      mock.restore();
    }
  });

  it("honors a forced kind for ambiguous targets", async () => {
    const mock = installFetchMock((url) => {
      if (url === "https://registry.npmjs.org/owner%2Frepo") return jsonResponse(404, {});
      return undefined;
    });
    try {
      const r = await checkTarget("owner/repo", "npm");
      assert.equal(r.source.kind, "npm");
      assert.equal(r.verdict, "risky");
    } finally {
      mock.restore();
    }
  });

  it("turns a missing repo into a risky zero-score result", async () => {
    const mock = installFetchMock((url) => {
      if (/\/repos\/[\w.-]+\/[\w.-]+$/.test(url)) return jsonResponse(404, { message: "Not Found" });
      return undefined;
    });
    try {
      const r = await checkTarget("ghost/repo");
      assert.equal(r.score, 0);
      assert.equal(r.verdict, "risky");
      assert.equal(r.source.exists, false);
    } finally {
      mock.restore();
    }
  });
});
