import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "./helpers.js";
import { extractTargetsFromConfig } from "../src/config.js";

const tmp = mkdtempSync(join(tmpdir(), "scepter-config-test-"));
after(() => cleanupTempDir(tmp));

async function targets(config: unknown): Promise<string[]> {
  const file = join(tmp, `mcp-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, typeof config === "string" ? config : JSON.stringify(config), "utf8");
  return extractTargetsFromConfig(file);
}

describe("extractTargetsFromConfig", () => {
  it("pulls package names from npx/npm/bunx/pnpm entries", async () => {
    const result = await targets({
      mcpServers: {
        a: { command: "npx", args: ["-y", "pkg-a"] },
        b: { command: "npm", args: ["exec", "pkg-b"] },
        c: { command: "bunx", args: ["pkg-c"] },
        d: { command: "pnpm", args: ["dlx", "pkg-d"] },
      },
    });
    assert.deepEqual(result, ["pkg-a", "pkg-b", "pkg-c", "pkg-d"]);
  });

  it("matches runner commands case-insensitively and with .cmd shims", async () => {
    const result = await targets({
      mcpServers: {
        win: { command: "NPX.CMD", args: ["-y", "pkg-win"] },
        caps: { command: "Bunx", args: ["pkg-caps"] },
      },
    });
    assert.deepEqual(result, ["pkg-win", "pkg-caps"]);
  });

  it("ignores commands that are not package runners", async () => {
    const result = await targets({
      mcpServers: {
        node: { command: "node", args: ["server.js"] },
        python: { command: "/usr/local/bin/python", args: ["-m", "server"] },
      },
    });
    assert.deepEqual(result, []);
  });

  it("skips flags and runner subcommands", async () => {
    const result = await targets({
      mcpServers: {
        flags: { command: "npx", args: ["--yes", "-y", "pkg-flags"] },
        dlx: { command: "pnpm", args: ["dlx", "run", "pkg-dlx"] },
      },
    });
    assert.deepEqual(result, ["pkg-flags", "pkg-dlx"]);
  });

  it("strips @version suffixes but keeps scoped names intact", async () => {
    const result = await targets({
      mcpServers: {
        plain: { command: "npx", args: ["-y", "pkg@1.2.3"] },
        scopedVersion: { command: "npx", args: ["-y", "@scope/name@2.0.0"] },
        scoped: { command: "npx", args: ["-y", "@scope/name"] },
        trailingAt: { command: "npx", args: ["-y", "pkg@"] },
      },
    });
    // Set de-duplication: "pkg" appears three times, "@scope/name" twice
    assert.deepEqual(result, ["pkg", "@scope/name"]);
  });

  it("de-duplicates repeated packages", async () => {
    const result = await targets({
      mcpServers: {
        one: { command: "npx", args: ["-y", "pkg-a"] },
        two: { command: "bunx", args: ["pkg-a"] },
        three: { command: "npx", args: ["-y", "pkg-b"] },
      },
    });
    assert.deepEqual(result, ["pkg-a", "pkg-b"]);
  });

  it("falls back to the `servers` key and prefers `mcpServers`", async () => {
    const fallback = await targets({
      servers: { a: { command: "npx", args: ["-y", "pkg-servers"] } },
    });
    assert.deepEqual(fallback, ["pkg-servers"]);

    const both = await targets({
      mcpServers: { a: { command: "npx", args: ["-y", "pkg-mcp"] } },
      servers: { b: { command: "npx", args: ["-y", "pkg-servers"] } },
    });
    assert.deepEqual(both, ["pkg-mcp"]);
  });

  it("skips runner entries without a package argument", async () => {
    const result = await targets({
      mcpServers: {
        noArgs: { command: "npx" },
        onlyFlags: { command: "npx", args: ["-y", "--yes"] },
        noArgsKey: { command: "bunx", args: [] },
      },
    });
    assert.deepEqual(result, []);
  });

  it("treats malformed JSON as an error, not an empty list", async () => {
    await assert.rejects(targets("{ not json"), SyntaxError);
  });

  it("rejects when the file does not exist", async () => {
    await assert.rejects(extractTargetsFromConfig(join(tmp, "does-not-exist.json")));
  });
});
