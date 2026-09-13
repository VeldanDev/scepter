import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Sessions live under the user's home so they survive across runs and are easy
// to find. One file per wrapped server process, newline-delimited JSON.
export const SESSION_DIR = join(homedir(), ".scepter", "sessions");

export interface SessionEvent {
  t: number;
  dir: "client" | "server";
  method?: string;
  id?: string | number;
  tool?: string;
  ok?: boolean;
  ms?: number;
  error?: string;
}

export interface SessionWriter {
  file: string;
  log(event: SessionEvent): void;
  end(exitCode: number): void;
}

export function createSession(server: string, command: string): SessionWriter {
  mkdirSync(SESSION_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(SESSION_DIR, `${stamp}-${process.pid}.jsonl`);
  write(file, { type: "meta", server, command, startedAt: new Date().toISOString() });
  return {
    file,
    log: (event) => write(file, event),
    end: (exitCode) => write(file, { type: "end", exitCode, endedAt: new Date().toISOString() }),
  };
}

function write(file: string, obj: unknown): void {
  try {
    appendFileSync(file, JSON.stringify(obj) + "\n");
  } catch {
    // A logging failure must never break the wrapped server.
  }
}

export interface SessionSummary {
  file: string;
  server: string;
  command: string;
  startedAt: string;
  calls: number;
  errors: number;
  avgMs: number | null;
  slowestMs: number | null;
  toolCounts: Record<string, number>;
  crashed: boolean;
  ended: boolean;
  lastError: string | null;
}

/** Read and summarize recent sessions, newest first. */
export function readSessions(limit = 25): SessionSummary[] {
  if (!existsSync(SESSION_DIR)) return [];
  const files = readdirSync(SESSION_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .reverse()
    .slice(0, limit);
  return files.map((f) => summarize(join(SESSION_DIR, f))).filter((s): s is SessionSummary => s !== null);
}

function summarize(file: string): SessionSummary | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }

  let server = "unknown";
  let command = "";
  let startedAt = "";
  let ended = false;
  let crashed = false;
  let calls = 0;
  let errors = 0;
  const durations: number[] = [];
  const toolCounts: Record<string, number> = {};
  let lastError: string | null = null;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === "meta") {
      server = String(obj.server ?? "unknown");
      command = String(obj.command ?? "");
      startedAt = String(obj.startedAt ?? "");
      continue;
    }
    if (obj.type === "end") {
      ended = true;
      if (typeof obj.exitCode === "number" && obj.exitCode !== 0) crashed = true;
      continue;
    }
    // A completed tool call is a server-direction response to a tools/call.
    if (obj.dir === "server" && obj.method === "tools/call") {
      calls += 1;
      const tool = typeof obj.tool === "string" ? obj.tool : "(unknown)";
      toolCounts[tool] = (toolCounts[tool] ?? 0) + 1;
      if (typeof obj.ms === "number") durations.push(obj.ms);
      if (obj.ok === false) {
        errors += 1;
        if (typeof obj.error === "string") lastError = obj.error;
      }
    }
  }

  if (!ended) crashed = true; // never wrote an end record: process died hard

  const avgMs = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
  const slowestMs = durations.length ? Math.max(...durations) : null;

  return {
    file,
    server,
    command,
    startedAt,
    calls,
    errors,
    avgMs,
    slowestMs,
    toolCounts,
    crashed,
    ended,
    lastError,
  };
}
