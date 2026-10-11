import { createInterface } from "node:readline";
import { checkTarget } from "./index.js";
import { extractTargetsFromConfig, readServerSpecs } from "./config.js";
import { auditConfig, inspectServer } from "./inspect.js";
import type { SourceKind } from "./types.js";

// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0), so agents can
// call Scepter directly. Hand-rolled to keep Scepter free of runtime dependencies.

const INSTRUCTIONS =
  "Use check_server before adding an MCP server you don't know, inspect_server to audit what a server actually exposes, and audit_config to review a whole MCP setup for poisoned tools and toxic flows. Scepter reports what it can observe; it never certifies a server as safe.";

const sourceProp = {
  type: "string",
  enum: ["npm", "github"],
  description: "Force how the target is read. Omit to auto-detect.",
};

const verdictProp = { type: "string", enum: ["healthy", "caution", "risky"] };

// readOnlyHint: none of these tools change anything. openWorldHint: they reach
// npm, GitHub, or the server under test. inspect_server and audit_config start
// the servers they inspect, so they are not marked read-only: clients should
// ask before letting an agent launch an arbitrary command.
const TOOLS = [
  {
    name: "check_server",
    title: "Check an MCP server's health",
    description:
      "Check whether one MCP server is alive, maintained, and safe to use, from its npm package or GitHub repo. Returns a 0-100 score, a verdict (healthy, caution, risky), and the signals behind it.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "GitHub repo (owner/repo or URL) or npm package name" },
        source: sourceProp,
      },
      required: ["target"],
    },
    outputSchema: { type: "object", properties: { score: { type: "number" }, verdict: verdictProp, reasons: { type: "array" } }, required: ["score", "verdict"] },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "scan_config",
    title: "Check every server in a config",
    description: "Run check_server on every npm-launched MCP server listed in an MCP config file (for example mcp.json).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the MCP config file" },
        source: sourceProp,
      },
      required: ["path"],
    },
    outputSchema: { type: "object", properties: { results: { type: "array" } }, required: ["results"] },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "inspect_server",
    title: "Audit a live MCP server",
    description:
      "Start an MCP server (stdio command, or a Streamable HTTP url), read its tool list, and audit it: poisoned tool descriptions, destructive tools without a destructiveHint, context cost in tokens, and tools that changed since the last inspection.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Executable for a stdio server, e.g. npx" },
        args: { type: "array", items: { type: "string" }, description: "Arguments, e.g. [\"-y\", \"some-mcp-server\"]" },
        url: { type: "string", description: "Streamable HTTP endpoint, instead of command" },
      },
    },
    outputSchema: {
      type: "object",
      properties: { server: { type: "string" }, tools: { type: "number" }, contextTokens: { type: "number" }, findings: { type: "array" }, verdict: verdictProp },
      required: ["server", "verdict"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "audit_config",
    title: "Audit a whole MCP setup",
    description:
      "Start every server in an MCP config file, audit each one like inspect_server, and report toxic flows: combinations of tools that read untrusted content, read private data, and send data out.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Path to the MCP config file" } },
      required: ["path"],
    },
    outputSchema: { type: "object", properties: { servers: { type: "array" }, flow: { type: ["object", "null"] }, verdict: verdictProp }, required: ["servers", "verdict"] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
];

type Json = Record<string, any>;

function send(msg: Json): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
}

async function callTool(name: string, args: Json): Promise<Json> {
  const force = args.source as SourceKind | undefined;
  if (name === "check_server") {
    if (typeof args.target !== "string" || !args.target) throw new Error("target is required");
    return checkTarget(args.target, force) as Promise<Json>;
  }
  if (name === "scan_config") {
    if (typeof args.path !== "string" || !args.path) throw new Error("path is required");
    const targets = await extractTargetsFromConfig(args.path);
    return { results: await Promise.all(targets.map((t) => checkTarget(t, force))) };
  }
  if (name === "inspect_server") {
    if (typeof args.url !== "string" && typeof args.command !== "string") throw new Error("command or url is required");
    const target = typeof args.url === "string" ? { url: args.url } : { command: args.command as string, args: (args.args ?? []) as string[] };
    const { toolList, ...result } = await inspectServer(target);
    return result;
  }
  if (name === "audit_config") {
    if (typeof args.path !== "string" || !args.path) throw new Error("path is required");
    return auditConfig(await readServerSpecs(args.path)) as Promise<Json>;
  }
  throw new Error(`unknown tool "${name}"`);
}

async function handle(req: Json, version: string): Promise<void> {
  const { id, method, params = {} } = req;
  if (id === undefined) return; // notifications (e.g. notifications/initialized) need no reply

  switch (method) {
    case "initialize":
      return send({
        id,
        result: {
          protocolVersion: params.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "scepter", title: "Scepter", version },
          instructions: INSTRUCTIONS,
        },
      });
    case "ping":
      return send({ id, result: {} });
    case "tools/list":
      return send({ id, result: { tools: TOOLS } });
    case "tools/call":
      try {
        const out = await callTool(params.name, params.arguments ?? {});
        return send({ id, result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out } });
      } catch (err) {
        // Tool failures go back as results so the agent can read and react to them.
        return send({ id, result: { content: [{ type: "text", text: (err as Error).message }], isError: true } });
      }
    default:
      return send({ id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

export function runServe(version: string): void {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let req: Json;
    try {
      req = JSON.parse(line);
    } catch {
      return send({ id: null, error: { code: -32700, message: "parse error" } });
    }
    handle(req, version).catch((err) =>
      send({ id: req.id ?? null, error: { code: -32603, message: (err as Error).message } }),
    );
  });
}
