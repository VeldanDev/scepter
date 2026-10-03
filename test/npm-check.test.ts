import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { inspectNpm } from "../src/checks/npm.js";
import { clearGitHubTokens, installFetchMock, jsonResponse } from "./helpers.js";

const PUBLISHED_AT = "2025-09-15T12:00:00.000Z";
const MODIFIED_AT = "2025-10-01T00:00:00.000Z";

function packument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "some-mcp",
    description: "An MCP server for weather",
    "dist-tags": { latest: "1.2.0" },
    time: {
      "1.0.0": "2024-01-01T00:00:00.000Z",
      "1.1.0": "2024-06-01T00:00:00.000Z",
      "1.2.0": PUBLISHED_AT,
      modified: MODIFIED_AT,
    },
    versions: { "1.0.0": {}, "1.1.0": {}, "1.2.0": {} },
    maintainers: [{ name: "a" }, { name: "b" }, { name: "c" }],
    license: "MIT",
    keywords: ["mcp", "weather"],
    repository: { url: "git+https://github.com/owner/some-mcp.git" },
    homepage: "https://example.com",
    ...overrides,
  };
}

function stubRegistry(data: unknown | Error, advisories: unknown = []) {
  return installFetchMock((url) => {
    if (url.startsWith("https://registry.npmjs.org/")) {
      return data instanceof Error ? Promise.reject(data) : jsonResponse(200, data);
    }
    if (url.startsWith("https://api.github.com/advisories")) {
      return jsonResponse(200, advisories);
    }
    return undefined;
  });
}

describe("inspectNpm", () => {
  let restoreTokens: () => void;
  beforeEach(() => {
    restoreTokens = clearGitHubTokens();
  });
  afterEach(() => {
    restoreTokens();
  });

  it("normalizes a healthy packument", async () => {
    const mock = stubRegistry(packument());
    try {
      const info = await inspectNpm("some-mcp");
      assert.equal(info.kind, "npm");
      assert.equal(info.name, "some-mcp");
      assert.equal(info.exists, true);
      assert.equal(info.latestVersion, "1.2.0");
      // last activity is the latest version's publish time, not the registry's `modified`
      assert.equal((info.lastActivity as Date).getTime(), new Date(PUBLISHED_AT).getTime());
      assert.equal(info.maintainers, 3);
      assert.equal(info.license, "MIT");
      assert.equal(info.hasReleases, true);
      assert.equal(info.hasRepoLink, true);
      assert.equal(info.looksLikeMcp, true);
      assert.deepEqual(info.advisories, { total: 0, critical: 0, high: 0 });
      assert.deepEqual(info.warnings, []);
      assert.equal(info.archived, false);
      assert.equal(info.stars, null);
      assert.equal(info.openIssues, null);
    } finally {
      mock.restore();
    }
  });

  it("fetches the registry URL with @ unescaped for scoped packages", async () => {
    const mock = stubRegistry(packument({ name: "@scope/name" }));
    try {
      await inspectNpm("@scope/name");
      // %40 is decoded back to @, the slash stays encoded (%2F); the registry accepts both
      assert.equal(mock.calls[0].url, "https://registry.npmjs.org/@scope%2Fname");
    } finally {
      mock.restore();
    }
  });

  it("falls back to the modified time when latest is missing from time", async () => {
    const mock = stubRegistry(packument({ time: { modified: MODIFIED_AT } }));
    try {
      const info = await inspectNpm("some-mcp");
      assert.equal((info.lastActivity as Date).getTime(), new Date(MODIFIED_AT).getTime());
    } finally {
      mock.restore();
    }
  });

  it("reports null activity when no time data exists", async () => {
    const mock = stubRegistry(packument({ time: undefined }));
    try {
      const info = await inspectNpm("some-mcp");
      assert.equal(info.lastActivity, null);
    } finally {
      mock.restore();
    }
  });

  it("marks a single-version package as having no releases", async () => {
    const mock = stubRegistry(
      packument({ versions: { "1.0.0": {} }, "dist-tags": { latest: "1.0.0" } }),
    );
    try {
      const info = await inspectNpm("some-mcp");
      assert.equal(info.hasReleases, false);
    } finally {
      mock.restore();
    }
  });

  it("reports unknown releases when the versions map is missing", async () => {
    const mock = stubRegistry(packument({ versions: undefined }));
    try {
      const info = await inspectNpm("some-mcp");
      assert.equal(info.hasReleases, null);
    } finally {
      mock.restore();
    }
  });

  it("accepts an object license and a string repository", async () => {
    const mock = stubRegistry(
      packument({
        license: { type: "Apache-2.0" },
        repository: "https://github.com/owner/some-mcp",
      }),
    );
    try {
      const info = await inspectNpm("some-mcp");
      assert.equal(info.license, "Apache-2.0");
      assert.equal(info.hasRepoLink, true);
    } finally {
      mock.restore();
    }
  });

  it("counts the homepage as a repo link when repository is absent", async () => {
    const mock = stubRegistry(packument({ repository: undefined, homepage: "https://example.com" }));
    try {
      assert.equal((await inspectNpm("some-mcp")).hasRepoLink, true);
    } finally {
      mock.restore();
    }
  });

  it("reports no repo link when neither repository nor homepage exist", async () => {
    const mock = stubRegistry(packument({ repository: undefined, homepage: undefined }));
    try {
      assert.equal((await inspectNpm("some-mcp")).hasRepoLink, false);
    } finally {
      mock.restore();
    }
  });

  describe("missing / broken registry responses", () => {
    it("returns a not-found source for a 404, guessing MCP-ness from the name", async () => {
      const mock = installFetchMock((url) => {
        if (url.startsWith("https://registry.npmjs.org/")) return jsonResponse(404, {});
        return undefined;
      });
      try {
        const gone = await inspectNpm("ghost-pkg");
        assert.equal(gone.exists, false);
        assert.equal(gone.looksLikeMcp, false);
        assert.equal(gone.lastActivity, null);
        assert.deepEqual(gone.warnings, []);

        const goneMcp = await inspectNpm("ghost-mcp");
        assert.equal(goneMcp.exists, false);
        assert.equal(goneMcp.looksLikeMcp, true);
      } finally {
        mock.restore();
      }
    });

    it("records a warning for a 5xx registry response", async () => {
      const mock = installFetchMock((url) => {
        if (url.startsWith("https://registry.npmjs.org/")) return jsonResponse(503, {});
        return undefined;
      });
      try {
        const info = await inspectNpm("some-mcp");
        assert.equal(info.exists, false);
        assert.ok(info.warnings.includes("registry responded 503"));
      } finally {
        mock.restore();
      }
    });

    it("records a warning when the registry is unreachable", async () => {
      const mock = installFetchMock((url) => {
        if (url.startsWith("https://registry.npmjs.org/")) {
          return Promise.reject(new Error("ENOTFOUND"));
        }
        return undefined;
      });
      try {
        const info = await inspectNpm("some-mcp");
        assert.equal(info.exists, false);
        assert.ok(info.warnings.some((w) => w.startsWith("could not reach npm registry")));
      } finally {
        mock.restore();
      }
    });

    it("warns instead of crashing when the advisory lookup fails", async () => {
      const mock = installFetchMock((url) => {
        if (url.startsWith("https://registry.npmjs.org/")) return jsonResponse(200, packument());
        if (url.startsWith("https://api.github.com/advisories")) return jsonResponse(500, {});
        return undefined;
      });
      try {
        const info = await inspectNpm("some-mcp");
        assert.equal(info.advisories, null);
        assert.ok(info.warnings.includes("could not check security advisories"));
      } finally {
        mock.restore();
      }
    });
  });

  describe("malformed packuments", () => {
    it("tolerates keywords as a string instead of an array", async () => {
      const mock = stubRegistry(packument({ keywords: "mcp" }));
      try {
        const info = await inspectNpm("some-mcp");
        assert.equal(info.exists, true);
        // the string keywords are dropped; MCP-ness falls back to name/description
        assert.equal(info.looksLikeMcp, true); // description says "MCP server"
      } finally {
        mock.restore();
      }
    });

    it("tolerates maintainers as a non-array", async () => {
      const mock = stubRegistry(packument({ maintainers: "someone" }));
      try {
        const info = await inspectNpm("some-mcp");
        assert.equal(info.maintainers, null);
      } finally {
        mock.restore();
      }
    });
  });
});
