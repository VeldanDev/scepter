import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Runs the real `scepter serve` process and talks JSON-RPC to it over stdio.
const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve"], { stdio: ["pipe", "pipe", "inherit"] });
after(() => child.kill());

const pending = new Map<number, (msg: any) => void>();
createInterface({ input: child.stdout! }).on("line", (line) => {
  const msg = JSON.parse(line);
  pending.get(msg.id)?.(msg);
});

let nextId = 1;
function rpc(method: string, params?: unknown): Promise<any> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

describe("scepter serve", () => {
  it("answers initialize with tool capabilities", async () => {
    const res = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert.equal(res.result.serverInfo.name, "scepter");
    assert.ok(res.result.capabilities.tools);
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  });

  it("lists check_server and scan_config", async () => {
    const res = await rpc("tools/list");
    assert.deepEqual(res.result.tools.map((t: any) => t.name), ["check_server", "scan_config"]);
  });

  it("returns tool errors as isError results, not protocol errors", async () => {
    const res = await rpc("tools/call", { name: "check_server", arguments: {} });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /target is required/);
  });

  it("rejects unknown methods with -32601", async () => {
    const res = await rpc("resources/list");
    assert.equal(res.error.code, -32601);
  });
});
