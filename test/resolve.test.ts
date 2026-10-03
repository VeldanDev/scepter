import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveTarget } from "../src/resolve.js";

describe("resolveTarget", () => {
  it("reads a bare package name as npm", () => {
    assert.deepEqual(resolveTarget("some-mcp-server"), {
      kind: "npm",
      id: "some-mcp-server",
    });
  });

  it("reads a scoped package as npm", () => {
    assert.deepEqual(resolveTarget("@scope/name"), { kind: "npm", id: "@scope/name" });
  });

  it("reads owner/repo as a github repo", () => {
    assert.deepEqual(resolveTarget("owner/repo"), { kind: "github", id: "owner/repo" });
  });

  it("trims surrounding whitespace", () => {
    assert.deepEqual(resolveTarget("  owner/repo \n"), { kind: "github", id: "owner/repo" });
    assert.deepEqual(resolveTarget(" some-mcp "), { kind: "npm", id: "some-mcp" });
  });

  describe("github URLs", () => {
    it("parses a plain URL", () => {
      assert.deepEqual(resolveTarget("https://github.com/owner/repo"), {
        kind: "github",
        id: "owner/repo",
      });
    });

    it("parses http and www variants", () => {
      assert.deepEqual(resolveTarget("http://www.github.com/owner/repo"), {
        kind: "github",
        id: "owner/repo",
      });
    });

    it("strips a .git suffix", () => {
      assert.deepEqual(resolveTarget("https://github.com/owner/repo.git"), {
        kind: "github",
        id: "owner/repo",
      });
    });

    it("strips a trailing slash, query string and hash", () => {
      for (const url of [
        "https://github.com/owner/repo/",
        "https://github.com/owner/repo?tab=readme",
        "https://github.com/owner/repo#readme",
        "https://github.com/owner/repo/tree/main",
        "https://github.com/owner/repo/issues/12",
      ]) {
        assert.deepEqual(resolveTarget(url), { kind: "github", id: "owner/repo" }, url);
      }
    });

    it("matches without a protocol", () => {
      assert.deepEqual(resolveTarget("github.com/owner/repo"), {
        kind: "github",
        id: "owner/repo",
      });
    });

    it("preserves the original case of owner and repo", () => {
      assert.deepEqual(resolveTarget("https://github.com/Org/Repo"), {
        kind: "github",
        id: "Org/Repo",
      });
    });
  });

  describe("fallbacks for malformed shapes", () => {
    it("treats a three-part path as npm (not a repo)", () => {
      assert.deepEqual(resolveTarget("owner/repo/extra"), {
        kind: "npm",
        id: "owner/repo/extra",
      });
    });

    it("treats a bare @ as npm", () => {
      assert.deepEqual(resolveTarget("@scope"), { kind: "npm", id: "@scope" });
    });

    it("returns an empty npm target for empty input", () => {
      assert.deepEqual(resolveTarget(""), { kind: "npm", id: "" });
    });

    it("collapses double slashes into a repo", () => {
      assert.deepEqual(resolveTarget("owner//repo"), { kind: "github", id: "owner/repo" });
    });
  });

  describe("forced kind (--github / --npm)", () => {
    it("forces a bare name to github and keeps the id", () => {
      assert.deepEqual(resolveTarget("some-mcp-server", "github"), {
        kind: "github",
        id: "some-mcp-server",
      });
    });

    it("forces a repo-looking name to npm", () => {
      assert.deepEqual(resolveTarget("owner/repo", "npm"), { kind: "npm", id: "owner/repo" });
    });

    it("keeps URL normalization when forcing github on a URL", () => {
      assert.deepEqual(resolveTarget("https://github.com/owner/repo.git", "github"), {
        kind: "github",
        id: "owner/repo",
      });
    });

    it("rewrites a github URL to npm but keeps the extracted owner/repo id", () => {
      assert.deepEqual(resolveTarget("https://github.com/owner/repo", "npm"), {
        kind: "npm",
        id: "owner/repo",
      });
    });

    it("forces a scoped package to github as-is", () => {
      assert.deepEqual(resolveTarget("@scope/name", "github"), {
        kind: "github",
        id: "@scope/name",
      });
    });
  });
});
