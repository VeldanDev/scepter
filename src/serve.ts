import { createInterface } from "node:readline";
import { checkTarget } from "./index.js";
import { extractTargetsFromConfig } from "./config.js";
import type { SourceKind } from "./types.js";

// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0), so agents can
// call Scepter directly. Hand-rolled to keep Scepter free of runtime dependencies.

const sourceProp = {
  type: "string",
  enum: ["npm", "github"],
  description: "Force how the target is read. Omit to auto-detect.",
};

const TOOLS = [
  {
    name: "check_server",
    description:
      "Check whether one MCP server is alive, maintained, and safe to use. Returns a 0-100 score, a verdict (healthy, caution, risky), and the signals behind it.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "GitHub repo (owner/repo or URL) or npm package name" },
        source: sourceProp,
      },
      required: ["target"],
    },
  },
  {
    name: "scan_config",
    description: "Check every MCP server listed in an MCP config file (for example mcp.json).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the MCP config file" },
        source: sourceProp,
      },
      required: ["path"],
    },
  },
];

type Json = Record<string, any>;

function send(msg: Json): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
}

async function callTool(name: string, args: Json): Promise<unknown> {
  const force = args.source as SourceKind | undefined;
  if (name === "check_server") {
    if (typeof args.target !== "string" || !args.target) throw new Error("target is required");
    return checkTarget(args.target, force);
  }
  if (name === "scan_config") {
    if (typeof args.path !== "string" || !args.path) throw new Error("path is required");
    const targets = await extractTargetsFromConfig(args.path);
    return Promise.all(targets.map((t) => checkTarget(t, force)));
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
          serverInfo: { name: "scepter", version },
        },
      });
    case "ping":
      return send({ id, result: {} });
    case "tools/list":
      return send({ id, result: { tools: TOOLS } });
    case "tools/call":
      try {
        const out = await callTool(params.name, params.arguments ?? {});
        return send({ id, result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] } });
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
