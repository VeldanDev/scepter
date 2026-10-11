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

/** How to reach a server: a stdio command, or a Streamable HTTP endpoint. */
export type ServerSpec =
  | { name?: string; command: string; args?: string[]; env?: Record<string, string> }
  | { name?: string; url: string; headers?: Record<string, string> };

type Rpc = { call: (method: string, params?: unknown) => Promise<any>; notify: (method: string) => Promise<void>; close: () => void; died: Promise<never> };

function stdioRpc(spec: { command: string; args?: string[]; env?: Record<string, string> }): Rpc {
  const child = spawnServer(spec.command, spec.args ?? [], "ignore", spec.env);
  const waiting = new Map<number, (msg: any) => void>();
  let nextId = 1;
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
    } catch {
      // Servers sometimes log to stdout; skip anything that isn't JSON-RPC.
    }
  });
  const send = (msg: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  return {
    call: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        waiting.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message ?? "server error")) : resolve(msg.result)));
        send({ id, method, params });
      }),
    notify: async (method) => void send({ method }),
    close: () => child.kill(),
    died: new Promise<never>((_, reject) => {
      child.on("error", (err) => reject(new Error(`failed to start server: ${err.message}`)));
      child.on("exit", (code) => reject(new Error(`server exited (code ${code}) before listing its tools`)));
    }),
  };
}

function httpRpc(spec: { url: string; headers?: Record<string, string> }): Rpc {
  let session: string | null = null;
  let version: string | null = null;
  let nextId = 1;
  const post = async (body: object) => {
    const res = await fetch(spec.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
        ...(version ? { "mcp-protocol-version": version } : {}),
        ...spec.headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${spec.url}`);
    session = res.headers.get("mcp-session-id") ?? session;
    return res;
  };
  return {
    call: async (method, params = {}) => {
      const id = nextId++;
      const res = await post({ id, method, params });
      const text = await res.text();
      // A JSON body, or an SSE stream whose `data:` lines carry the response.
      const msgs = (res.headers.get("content-type") ?? "").includes("text/event-stream")
        ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)))
        : [JSON.parse(text)];
      const msg = msgs.find((m) => m.id === id);
      if (!msg) throw new Error(`no response to ${method}`);
      if (msg.error) throw new Error(msg.error.message ?? "server error");
      if (method === "initialize") version = msg.result?.protocolVersion ?? null;
      return msg.result;
    },
    notify: async (method) => void (await post({ method })),
    close: () => {
      if (session) fetch(spec.url, { method: "DELETE", headers: { "mcp-session-id": session, ...spec.headers } }).catch(() => {});
    },
    died: new Promise<never>(() => {}),
  };
}

/** Handshake + paginated tools/list. Accepts a spec, or a bare stdio argv. */
export function listTools(target: ServerSpec | string[], timeoutMs = 60_000): Promise<{ protocolVersion: string | null; tools: Tool[] }> {
  const spec: ServerSpec = Array.isArray(target) ? { command: target[0], args: target.slice(1) } : target;
  const rpc = "url" in spec ? httpRpc(spec) : stdioRpc(spec);
  const work = (async () => {
    const init = await rpc.call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "scepter", version: "inspect" },
    });
    await rpc.notify("notifications/initialized");
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await rpc.call("tools/list", cursor ? { cursor } : {});
      tools.push(...(page?.tools ?? []));
      cursor = page?.nextCursor;
    } while (cursor);
    return { protocolVersion: init?.protocolVersion ?? null, tools };
  })();
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no tool list after ${timeoutMs / 1000}s`)), timeoutMs).unref());
  return Promise.race([work, rpc.died, timeout]).finally(() => rpc.close());
}

export function specName(spec: ServerSpec): string {
  if (spec.name) return spec.name;
  return "url" in spec ? new URL(spec.url).host : deriveServerName(spec.command, spec.args ?? []);
}

export async function inspectServer(target: ServerSpec | string[]): Promise<InspectResult & { toolList: Tool[] }> {
  const spec: ServerSpec = Array.isArray(target) ? { command: target[0], args: target.slice(1) } : target;
  const server = specName(spec);
  const { protocolVersion, tools } = await listTools(spec);
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
    toolList: tools,
  };
}

// Toxic flows: no single tool is dangerous, the combination is. An agent that can
// read untrusted content (a web page, an issue, an email) can be told by that
// content to fetch private data and send it out through a third tool.
export type Capability = "untrusted" | "private" | "outbound";

// Matched against whole words of the tool name (browser_navigate -> browser,
// navigate), so "browser_close" or a local "search_files" isn't mistaken for
// reading the web.
const CAPS: [Capability, Set<string>, RegExp?][] = [
  ["untrusted", new Set(["fetch", "navigate", "scrape", "crawl", "download", "url", "web", "webpage", "rss", "inbox", "browse"]),
    /(get|read|list)_(issue|comment|pull_request|discussion|email|mail|message)s?\b/],
  ["private", new Set(["file", "files", "directory", "dir", "sql", "database", "db", "secret", "secrets", "credential",
    "credentials", "password", "calendar", "contacts", "drive", "document", "documents", "email", "mail", "repo", "repository"])],
  ["outbound", new Set(["send", "post", "publish", "tweet", "comment", "reply", "upload", "webhook", "push", "share", "forward",
    "slack", "discord", "telegram"]), /create_(issue|pull_request|gist)/],
];

export function capabilities(t: Tool): Capability[] {
  const name = t.name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  const words = name.split(/[_\-.\s]+/);
  const caps = CAPS.filter(([, set, re]) => words.some((w) => set.has(w)) || re?.test(name)).map(([c]) => c);
  // write_file, move_file, send_email touch private things but don't read them out.
  const writes = words.some((w) => WRITE_VERBS.has(w));
  // A read-only tool cannot be the step that sends data out.
  return caps.filter((c) => !(c === "private" && writes) && !(c === "outbound" && t.annotations?.readOnlyHint));
}

const WRITE_VERBS = new Set(["write", "create", "edit", "move", "rename", "delete", "remove", "upload", "set", "update", "send", "post", "publish"]);

export interface ToxicFlow {
  untrusted: string[];
  private: string[];
  outbound: string[];
}

/** All three legs present across the given servers' tools, or null. Entries are "server/tool". */
export function toxicFlow(servers: { server: string; tools: Tool[] }[]): ToxicFlow | null {
  const legs: ToxicFlow = { untrusted: [], private: [], outbound: [] };
  for (const s of servers) for (const t of s.tools) for (const c of capabilities(t)) legs[c].push(`${s.server}/${t.name}`);
  return legs.untrusted.length && legs.private.length && legs.outbound.length ? legs : null;
}

export interface AuditResult {
  servers: (InspectResult | { server: string; error: string })[];
  flow: ToxicFlow | null;
  verdict: Verdict;
}

/** Inspect every server in a config, then look for toxic flows across all of them. */
export async function auditConfig(specs: ServerSpec[]): Promise<AuditResult> {
  const done = await Promise.all(
    specs.map((s) =>
      inspectServer(s).catch((err: Error) => ({ server: specName(s), error: err.message })),
    ),
  );
  const live = done.filter((d): d is InspectResult & { toolList: Tool[] } => "toolList" in d);
  const flow = toxicFlow(live.map((d) => ({ server: d.server, tools: d.toolList })));
  const verdicts = live.map((d) => d.verdict);
  const verdict: Verdict = verdicts.includes("risky") ? "risky" : verdicts.includes("caution") || flow ? "caution" : "healthy";
  return { servers: done.map((d) => ("toolList" in d ? (({ toolList, ...rest }) => rest)(d) : d)), flow, verdict };
}
