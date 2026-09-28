import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Verdict } from "./types.js";

// Every `check` (and each tick of `watch`) appends one line here, so a health
// score isn't just a snapshot -- it's a trend. One file per target, newline-
// delimited JSON, same storage pattern as session.ts.
export const HISTORY_DIR = join(homedir(), ".scepter", "history");

export interface HistoryEntry {
  t: number;
  score: number;
  verdict: Verdict;
}

function fileFor(target: string): string {
  // Targets are things like "owner/repo" or "@scope/name" -- neither is a
  // safe filename, so collapse anything that isn't alnum/dot/dash to "_".
  const safe = target.replace(/[^a-zA-Z0-9.-]/g, "_");
  return join(HISTORY_DIR, `${safe}.jsonl`);
}

/** Appends today's result and returns the entry recorded just before it, if any. */
export function recordAndGetPrevious(target: string, score: number, verdict: Verdict): HistoryEntry | null {
  const file = fileFor(target);
  const previous = lastEntry(target);
  try {
    mkdirSync(HISTORY_DIR, { recursive: true });
    appendFileSync(file, JSON.stringify({ t: Date.now(), score, verdict } satisfies HistoryEntry) + "\n");
  } catch {
    // History is a nice-to-have; never let a write failure break the check itself.
  }
  return previous;
}

/** Last recorded entry for a target, or null if it's never been checked before. */
export function lastEntry(target: string): HistoryEntry | null {
  const file = fileFor(target);
  if (!existsSync(file)) return null;
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
    if (lines.length === 0) return null;
    return JSON.parse(lines[lines.length - 1]) as HistoryEntry;
  } catch {
    return null;
  }
}

/** Full history for a target, oldest first. */
export function readHistory(target: string): HistoryEntry[] {
  const file = fileFor(target);
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as HistoryEntry);
  } catch {
    return [];
  }
}
