import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "./helpers.js";
import { readServerSpecs } from "../src/config.js";
import { auditConfig, capabilities, listTools, toxicFlow, type Tool } from "../src/inspect.js";

const tmp = mkdtempSync(join(tmpdir(), "scepter-audit-test-"));

// A Streamable HTTP MCP server: answers initialize as JSON and tools/list as an
// SSE event, and requires the session id it handed out, like real servers do.
const HTTP_TOOLS: Tool[] = [
  { name: "fetch_url", description: "Fetches a web page." },
  { name: "send_email", description: "Sends an email." },
];
let http: Server;
let url = "";
before(async () => {
  http = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body || "{}");
      if (msg.id === undefined) return void res.writeHead(202).end();
      if (msg.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" });
        return void res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } }));
      }
      if (req.headers["mcp-session-id"] !== "s1") return void res.writeHead(400).end();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: HTTP_TOOLS } })}\n\n`);
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(http.address() as any).port}/mcp`;
});
after(() => {
  http.close();
  cleanupTempDir(tmp);
});

describe("capabilities and toxicFlow", () => {
  it("classifies tools by what they can reach", () => {
    assert.deepEqual(capabilities({ name: "fetch_url" }), ["untrusted"]);
    assert.deepEqual(capabilities({ name: "read_file" }), ["private"]);
    assert.deepEqual(capabilities({ name: "send_message" }), ["outbound"]);
    assert.deepEqual(capabilities({ name: "send_message", annotations: { readOnlyHint: true } }), []);
  });

  it("needs all three legs, possibly spread over several servers", () => {
    const web = { server: "web", tools: [{ name: "fetch_url" }] };
    const fs = { server: "fs", tools: [{ name: "read_file" }] };
    const mail = { server: "mail", tools: [{ name: "send_email" }] };
    assert.equal(toxicFlow([web, fs]), null);
    assert.deepEqual(toxicFlow([web, fs, mail]), { untrusted: ["web/fetch_url"], private: ["fs/read_file"], outbound: ["mail/send_email"] });
  });
});

describe("readServerSpecs", () => {
  it("keeps command, args and env for stdio, url and headers for remote, skips disabled", async () => {
    const file = join(tmp, "mcp.json");
    writeFileSync(file, JSON.stringify({
      mcpServers: {
        local: { command: "npx", args: ["-y", "x"], env: { TOKEN: "t" } },
        remote: { url: "https://example.com/mcp", headers: { Authorization: "Bearer a" } },
        windsurf: { serverUrl: "https://example.org/mcp" },
        off: { command: "node", disabled: true },
      },
    }));
    assert.deepEqual(await readServerSpecs(file), [
      { name: "local", command: "npx", args: ["-y", "x"], env: { TOKEN: "t" } },
      { name: "remote", url: "https://example.com/mcp", headers: { Authorization: "Bearer a" } },
      { name: "windsurf", url: "https://example.org/mcp", headers: undefined },
    ]);
  });
});

describe("Streamable HTTP transport", () => {
  it("handshakes, keeps the session id and reads an SSE tools/list", async () => {
    const { protocolVersion, tools } = await listTools({ url });
    assert.equal(protocolVersion, "2025-06-18");
    assert.deepEqual(tools.map((t) => t.name), ["fetch_url", "send_email"]);
  });
});

describe("auditConfig", () => {
  it("audits stdio and HTTP servers together and finds the cross-server toxic flow", async () => {
    const r = await auditConfig([
      { name: "poisoned", command: process.execPath, args: ["test/fixtures/poisoned-server.mjs"] },
      { name: "web", url },
      { name: "broken", command: process.execPath, args: ["-e", "process.exit(1)"] },
    ]);
    assert.equal(r.verdict, "risky");
    assert.ok(r.servers.some((s) => s.server === "broken" && "error" in s));
    assert.deepEqual(r.flow, { untrusted: ["web/fetch_url"], private: ["poisoned/read_file"], outbound: ["web/send_email"] });
  });
});
