import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { inspectGithub } from "../src/checks/github.js";
import { clearGitHubTokens, installFetchMock, jsonResponse } from "./helpers.js";

const PUSHED_AT = "2025-09-20T10:00:00.000Z";

function repo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    full_name: "owner/repo",
    description: "MCP server for weather",
    archived: false,
    pushed_at: PUSHED_AT,
    open_issues_count: 12,
    stargazers_count: 42,
    license: { spdx_id: "MIT", name: "MIT License" },
    topics: ["mcp", "weather"],
    ...overrides,
  };
}

function stubGithub(repoResult: unknown | Error, overrides: {
  releases?: unknown;
  releasesOk?: boolean;
  advisories?: unknown;
  advisoriesStatus?: number;
} = {}) {
  return installFetchMock((url) => {
    if (/^https:\/\/api\.github\.com\/repos\/[\w.-]+\/[\w.-]+$/.test(url)) {
      return repoResult instanceof Error ? Promise.reject(repoResult) : jsonResponse(200, repoResult);
    }
    if (url.includes("/releases")) {
      return jsonResponse(overrides.releasesOk === false ? 500 : 200, overrides.releases ?? [{}]);
    }
    if (url.includes("/security-advisories")) {
      return jsonResponse(overrides.advisoriesStatus ?? 200, overrides.advisories ?? []);
    }
    return undefined;
  });
}

describe("inspectGithub", () => {
  let restoreTokens: () => void;
  beforeEach(() => {
    restoreTokens = clearGitHubTokens();
  });
  afterEach(() => {
    restoreTokens();
  });

  it("normalizes a healthy repo", async () => {
    const mock = stubGithub(repo(), { advisories: [{ severity: "critical" }, { severity: "high" }] });
    try {
      const info = await inspectGithub("owner/repo");
      assert.equal(info.kind, "github");
      assert.equal(info.name, "owner/repo");
      assert.equal(info.exists, true);
      assert.equal((info.lastActivity as Date).getTime(), new Date(PUSHED_AT).getTime());
      assert.equal(info.archived, false);
      assert.equal(info.openIssues, 12);
      assert.equal(info.stars, 42);
      assert.equal(info.license, "MIT");
      assert.equal(info.description, "MCP server for weather");
      assert.equal(info.hasReleases, true);
      assert.equal(info.hasRepoLink, true);
      assert.equal(info.looksLikeMcp, true);
      assert.deepEqual(info.advisories, { total: 2, critical: 1, high: 1 });
      assert.equal(info.latestVersion, null);
      assert.equal(info.maintainers, null);
    } finally {
      mock.restore();
    }
  });

  it("sets hasReleases from the releases endpoint", async () => {
    const none = stubGithub(repo(), { releases: [] });
    try {
      assert.equal((await inspectGithub("owner/repo")).hasReleases, false);
    } finally {
      none.restore();
    }

    const failed = stubGithub(repo(), { releasesOk: false });
    try {
      assert.equal((await inspectGithub("owner/repo")).hasReleases, null);
    } finally {
      failed.restore();
    }
  });

  it("does not warn when the repo advisory endpoint 404s (common for clean repos)", async () => {
    const mock = stubGithub(repo(), { advisoriesStatus: 404 });
    try {
      const info = await inspectGithub("owner/repo");
      assert.equal(info.advisories, null);
      // the only warning is the missing-token note; no advisory-specific warning
      assert.deepEqual(info.warnings, ["no GITHUB_TOKEN set: GitHub calls are rate-limited"]);
    } finally {
      mock.restore();
    }
  });

  it("falls back to the license name when spdx_id is NOASSERTION", async () => {
    const mock = stubGithub(repo({ license: { spdx_id: "NOASSERTION", name: "Other" } }));
    try {
      assert.equal((await inspectGithub("owner/repo")).license, "Other");
    } finally {
      mock.restore();
    }
  });

  it("reports null license when none is set", async () => {
    const mock = stubGithub(repo({ license: null }));
    try {
      assert.equal((await inspectGithub("owner/repo")).license, null);
    } finally {
      mock.restore();
    }
  });

  it("detects MCP-ness from name or description when topics are absent", async () => {
    const fromName = stubGithub(repo({ topics: undefined, full_name: "owner/mcp-weather" }));
    try {
      assert.equal((await inspectGithub("owner/mcp-weather")).looksLikeMcp, true);
    } finally {
      fromName.restore();
    }

    const none = stubGithub(
      repo({ topics: undefined, description: "Weather forecasts", full_name: "owner/repo" }),
    );
    try {
      assert.equal((await inspectGithub("owner/repo")).looksLikeMcp, false);
    } finally {
      none.restore();
    }
  });

  it("marks archived repos", async () => {
    const mock = stubGithub(repo({ archived: true }));
    try {
      assert.equal((await inspectGithub("owner/repo")).archived, true);
    } finally {
      mock.restore();
    }
  });

  it("reports null activity when pushed_at is missing", async () => {
    const mock = stubGithub(repo({ pushed_at: undefined }));
    try {
      assert.equal((await inspectGithub("owner/repo")).lastActivity, null);
    } finally {
      mock.restore();
    }
  });

  it("warns about the missing token and sends no auth header", async () => {
    const mock = stubGithub(repo());
    try {
      const info = await inspectGithub("owner/repo");
      assert.ok(info.warnings.includes("no GITHUB_TOKEN set: GitHub calls are rate-limited"));
      const headers = mock.calls[0].init?.headers as Record<string, string>;
      assert.equal(headers.authorization, undefined);
    } finally {
      mock.restore();
    }
  });

  it("sends a Bearer token when GITHUB_TOKEN is set and stays quiet about it", async () => {
    process.env.GITHUB_TOKEN = "tok-1";
    const mock = stubGithub(repo());
    try {
      const info = await inspectGithub("owner/repo");
      assert.equal(info.warnings.includes("no GITHUB_TOKEN set: GitHub calls are rate-limited"), false);
      const headers = mock.calls[0].init?.headers as Record<string, string>;
      assert.equal(headers.authorization, "Bearer tok-1");
    } finally {
      mock.restore();
      delete process.env.GITHUB_TOKEN;
    }
  });

  describe("missing / broken repo responses", () => {
    it("returns a not-found source for a 404", async () => {
      const mock = installFetchMock((url) => {
        if (/\/repos\/[\w.-]+\/[\w.-]+$/.test(url)) return jsonResponse(404, { message: "Not Found" });
        return undefined;
      });
      try {
        const info = await inspectGithub("ghost/repo");
        assert.equal(info.exists, false);
        assert.equal(info.lastActivity, null);
        assert.equal(info.hasRepoLink, false);
        assert.deepEqual(info.warnings, []);
        assert.equal(info.looksLikeMcp, false);
      } finally {
        mock.restore();
      }
    });

    it("guesses MCP-ness of a missing repo from the name", async () => {
      const mock = installFetchMock((url) => {
        if (/\/repos\/[\w.-]+\/[\w.-]+$/.test(url)) return jsonResponse(404, { message: "Not Found" });
        return undefined;
      });
      try {
        const info = await inspectGithub("ghost/Weather-MCP");
        assert.equal(info.exists, false);
        assert.equal(info.looksLikeMcp, true);
      } finally {
        mock.restore();
      }
    });

    it("warns on a rate-limit 403", async () => {
      const mock = installFetchMock((url) => {
        if (/\/repos\/[\w.-]+\/[\w.-]+$/.test(url)) return jsonResponse(403, { message: "rate limit" });
        return undefined;
      });
      try {
        const info = await inspectGithub("owner/repo");
        assert.equal(info.exists, false);
        assert.ok(info.warnings.includes("GitHub rate limit hit: set GITHUB_TOKEN to raise it"));
      } finally {
        mock.restore();
      }
    });

    it("warns on other non-ok statuses", async () => {
      const mock = installFetchMock((url) => {
        if (/\/repos\/[\w.-]+\/[\w.-]+$/.test(url)) return jsonResponse(500, {});
        return undefined;
      });
      try {
        const info = await inspectGithub("owner/repo");
        assert.equal(info.exists, false);
        assert.ok(info.warnings.includes("GitHub responded 500"));
      } finally {
        mock.restore();
      }
    });

    it("warns when GitHub is unreachable", async () => {
      const mock = installFetchMock((url) => {
        if (/\/repos\/[\w.-]+\/[\w.-]+$/.test(url)) return Promise.reject(new Error("ECONNREFUSED"));
        return undefined;
      });
      try {
        const info = await inspectGithub("owner/repo");
        assert.equal(info.exists, false);
        assert.ok(info.warnings.some((w) => w.startsWith("could not reach GitHub")));
      } finally {
        mock.restore();
      }
    });
  });

  describe("malformed repo payloads", () => {
    it("tolerates topics as a string instead of an array", async () => {
      const mock = stubGithub(repo({ topics: "mcp" }));
      try {
        const info = await inspectGithub("owner/repo");
        assert.equal(info.exists, true);
        // the string topics are dropped; MCP-ness falls back to name/description
        assert.equal(info.looksLikeMcp, true); // description says "MCP server"
      } finally {
        mock.restore();
      }
    });
  });
});
