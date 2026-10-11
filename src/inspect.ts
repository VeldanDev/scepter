import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { deriveServerName, spawnServer } from "./wrap.js";
import type { Verdict } from "./types.js";

// `scepter inspect -- <command>`: start the server for real, complete the MCP
// handshake, read its tool list, and audit what the agent would actually be
// handed: poisoned descriptions, unmarked destructive tools, context cost, and
// tools that changed since the last inspection (a "rug pull").

export interface Tool {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface Finding {
  tool: string;
  level: "bad" | "warn";
  kind: string;
  detail: string;
}

export interface InspectResult {
  server: string;
  protocolVersion: string | null;
  tools: number;
  annotated: number;
  contextTokens: number;
  findings: Finding[];
  changes: { added: string[]; removed: string[]; changed: string[] } | null;
  verdict: Verdict;
}

// Phrases that only make sense as instructions to the model, never as
// documentation for a human reading the tool list.
const POISON: [RegExp, string][] = [
  [/\b(do not|don'?t|never) (tell|inform|mention|show|reveal|notify)\b[^.]{0,40}\b(user|human)\b/i, "hides actions from the user"],
  [/\b(user|human) (should|must|does) not (see|know|be told)\b/i, "hides actions from the user"],
  [/\b(ignore|disregard|forget) (all |any )?(previous|prior|earlier|other) (instructions|rules|prompts)\b/i, "overrides prior instructions"],
  [/<\s*(important|system|instructions?|secret|hidden)\s*>/i, "embedded instruction tag"],
  [/\b(instead of|rather than) (using|calling) (the |any )?\w+ tool\b/i, "redirects other tools (shadowing)"],
  [/\b(before|after|whenever) (using|calling) (any|other|another) tools?\b/i, "hooks into other tools (shadowing)"],
  // Only real key material: config tools legitimately mention mcp.json or .env.
  [/(~\/\.ssh|\bid_rsa\b|\bid_ed25519\b|\.aws\/credentials)/i, "references secret key files"],
];
// Zero-width, bidi-override and Unicode tag characters: invisible to a human
// reviewing the description, still read by the model.
const INVISIBLE = /[​-‏‪-‮⁠-⁤﻿]|[\u{E0000}-\u{E007F}]/u;
const DESTRUCTIVE = /(^|_|-)(delete|remove|drop|destroy|truncate|purge|wipe|kill|exec|execute|shell|run_command|overwrite|force_push)(_|-|$)/i;

export function auditTools(tools: Tool[]): Finding[] {
  const out: Finding[] = [];
  for (const t of tools) {
    const text = [t.description ?? "", ...Object.values(t.inputSchema?.properties ?? {}).map((p) => JSON.stringify(p))].join("\n");
    for (const [re, detail] of POISON) {
      const m = text.match(re);
      if (m) out.push({ tool: t.name, level: "bad", kind: "poisoning", detail: `${detail}: "${m[0].slice(0, 60)}"` });
    }
    if (INVISIBLE.test(text)) out.push({ tool: t.name, level: "bad", kind: "poisoning", detail: "contains invisible characters" });
    const a = t.annotations ?? {};
    if (DESTRUCTIVE.test(t.name) && a.destructiveHint !== true && a.readOnlyHint !== true) {
      out.push({ tool: t.name, level: "warn", kind: "unmarked", detail: "looks destructive but has no destructiveHint, so clients won't ask before running it" });
    }
  }
  return out;
}

/** Rough token count of the tool list the client sends the model on every turn. */
export function contextTokens(tools: Tool[]): number {
  return Math.ceil(JSON.stringify(tools).length / 4);
}

export const PINS_DIR = join(homedir(), ".scepter", "pins");

function digest(t: Tool): string {
  return createHash("sha256").update(JSON.stringify([t.description ?? "", t.inputSchema ?? {}])).digest("hex");
}

/** Compare against the last pinned tool list, then pin the current one. Null on first inspection. */
export function pinAndDiff(server: string, tools: Tool[], dir = PINS_DIR): InspectResult["changes"] {
  const file = join(dir, `${server.replace(/[^a-zA-Z0-9.-]/g, "_")}.json`);
  const now = Object.fromEntries(tools.map((t) => [t.name, digest(t)]));
  const before: Record<string, string> | null = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(now, null, 2));
  } catch {
    // Pinning is best-effort; the audit itself still stands.
  }
  if (!before) return null;
  return {
    added: Object.keys(now).filter((n) => !(n in before)),
    removed: Object.keys(before).filter((n) => !(n in now)),
    changed: Object.keys(now).filter((n) => n in before && before[n] !== now[n]),
  };
}

export function judge(findings: Finding[], changes: InspectResult["changes"]): Verdict {
  if (findings.some((f) => f.level === "bad")) return "risky";
  if (findings.length || changes?.changed.length) return "caution";
  return "healthy";
}

/** Handshake + paginated tools/list against a spawned server. */
export function listTools(argv: string[], timeoutMs = 60_000): Promise<{ protocolVersion: string | null; tools: Tool[] }> {
  const [cmd, ...args] = argv;
  const child = spawnServer(cmd, args, "ignore");
  const waiting = new Map<number, (msg: any) => void>();
  let nextId = 1;
  const rpc = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message ?? "server error")) : resolve(msg.result)));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
    } catch {
      // Servers sometimes log to stdout; skip anything that isn't JSON-RPC.
    }
  });

  const work = (async () => {
    const init = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "scepter", version: "inspect" },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await rpc("tools/list", cursor ? { cursor } : {});
      tools.push(...(page?.tools ?? []));
      cursor = page?.nextCursor;
    } while (cursor);
    return { protocolVersion: init?.protocolVersion ?? null, tools };
  })();
  const failed = new Promise<never>((_, reject) => {
    child.on("error", (err) => reject(new Error(`failed to start server: ${err.message}`)));
    child.on("exit", (code) => reject(new Error(`server exited (code ${code}) before listing its tools`)));
    setTimeout(() => reject(new Error(`no tool list after ${timeoutMs / 1000}s`)), timeoutMs).unref();
  });
  return Promise.race([work, failed]).finally(() => child.kill());
}

export async function inspectServer(argv: string[]): Promise<InspectResult> {
  const server = deriveServerName(argv[0], argv.slice(1));
  const { protocolVersion, tools } = await listTools(argv);
  const findings = auditTools(tools);
  const changes = pinAndDiff(server, tools);
  return {
    server,
    protocolVersion,
    tools: tools.length,
    annotated: tools.filter((t) => t.annotations && Object.keys(t.annotations).length).length,
    contextTokens: contextTokens(tools),
    findings,
    changes,
    verdict: judge(findings, changes),
  };
}
