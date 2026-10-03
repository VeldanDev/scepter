import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  advisoriesForNpm,
  advisoriesForGithub,
} from "../src/checks/advisories.js";
import { clearGitHubTokens, installFetchMock, jsonResponse } from "./helpers.js";

describe("advisoriesForNpm", () => {
  it("summarizes severities from the global advisory database", async () => {
    const restoreTokens = clearGitHubTokens();
    const mock = installFetchMock((url) => {
      if (url.startsWith("https://api.github.com/advisories")) {
        return jsonResponse(200, [
          { severity: "critical" },
          { severity: "high" },
          { severity: "high" },
          { severity: "medium" },
          { severity: "low" },
        ]);
      }
      return undefined;
    });
    try {
      const summary = await advisoriesForNpm("some-mcp");
      assert.deepEqual(summary, { total: 5, critical: 1, high: 2 });
      assert.equal(
        mock.calls[0].url,
        "https://api.github.com/advisories?ecosystem=npm&affects=some-mcp&per_page=25",
      );
    } finally {
      mock.restore();
      restoreTokens();
    }
  });

  it("URL-encodes scoped package names in the affects parameter", async () => {
    const restoreTokens = clearGitHubTokens();
    const mock = installFetchMock(() => jsonResponse(200, []));
    try {
      await advisoriesForNpm("@scope/name");
      assert.match(mock.calls[0].url, /affects=%40scope%2Fname&/);
    } finally {
      mock.restore();
      restoreTokens();
    }
  });

  it("sends the GitHub token when one is set", async () => {
    process.env.GITHUB_TOKEN = "tok-123";
    const mock = installFetchMock(() => jsonResponse(200, []));
    try {
      await advisoriesForNpm("some-mcp");
      const headers = mock.calls[0].init?.headers as Record<string, string>;
      assert.equal(headers.authorization, "Bearer tok-123");
    } finally {
      mock.restore();
      delete process.env.GITHUB_TOKEN;
    }
  });

  it("sends no authorization header without a token", async () => {
    const restoreTokens = clearGitHubTokens();
    const mock = installFetchMock(() => jsonResponse(200, []));
    try {
      await advisoriesForNpm("some-mcp");
      const headers = mock.calls[0].init?.headers as Record<string, string>;
      assert.equal(headers.authorization, undefined);
    } finally {
      mock.restore();
      restoreTokens();
    }
  });

  it("returns null (not zero) when the lookup fails", async () => {
    for (const behave of [
      () => jsonResponse(403, { message: "rate limited" }),
      () => {
        throw new Error("offline");
      },
    ]) {
      const mock = installFetchMock(behave);
      try {
        const summary = await advisoriesForNpm("some-mcp");
        assert.equal(summary, null);
      } finally {
        mock.restore();
      }
    }
  });
});

describe("advisoriesForGithub", () => {
  it("summarizes advisories from the repo security-advisories endpoint", async () => {
    const mock = installFetchMock((url) => {
      if (url === "https://api.github.com/repos/owner/repo/security-advisories?per_page=25") {
        return jsonResponse(200, [{ severity: "high" }, { severity: "low" }]);
      }
      return undefined;
    });
    try {
      const summary = await advisoriesForGithub("owner/repo", {
        accept: "application/vnd.github+json",
      });
      assert.deepEqual(summary, { total: 2, critical: 0, high: 1 });
      const headers = mock.calls[0].init?.headers as Record<string, string>;
      assert.equal(headers.accept, "application/vnd.github+json");
    } finally {
      mock.restore();
    }
  });

  it("passes caller headers through (e.g. auth)", async () => {
    const mock = installFetchMock(() => jsonResponse(200, []));
    try {
      await advisoriesForGithub("owner/repo", { authorization: "Bearer xyz" });
      const headers = mock.calls[0].init?.headers as Record<string, string>;
      assert.equal(headers.authorization, "Bearer xyz");
    } finally {
      mock.restore();
    }
  });

  it("returns null on failure without throwing", async () => {
    for (const behave of [
      () => jsonResponse(404, { message: "Not Found" }),
      () => {
        throw new Error("offline");
      },
    ]) {
      const mock = installFetchMock(behave);
      try {
        assert.equal(await advisoriesForGithub("owner/repo", {}), null);
      } finally {
        mock.restore();
      }
    }
  });
});
