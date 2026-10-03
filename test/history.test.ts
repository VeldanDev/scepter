import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, pointHomeAt } from "./helpers.js";

// history.ts resolves its storage dir from homedir() at import time, so the
// temp home must be in place BEFORE the first import. Every write in these
// tests therefore lands inside the temp dir.
const tmp = makeTempDir();
const home = pointHomeAt(tmp);
const { HISTORY_DIR, recordAndGetPrevious, lastEntry, readHistory } = await import(
  "../src/history.js"
);

after(() => {
  home.restore();
  cleanupTempDir(tmp);
});

describe("history", () => {
  it("stores data under the (temp) home directory", () => {
    assert.ok(HISTORY_DIR.startsWith(tmp), `HISTORY_DIR ${HISTORY_DIR} should be inside ${tmp}`);
    assert.ok(HISTORY_DIR.includes(".scepter"));
  });

  it("returns no previous entry on the first check and records it", () => {
    assert.equal(recordAndGetPrevious("owner/repo", 80, "healthy"), null);
    const latest = lastEntry("owner/repo");
    assert.ok(latest);
    assert.equal(latest.score, 80);
    assert.equal(latest.verdict, "healthy");
    assert.equal(typeof latest.t, "number");
  });

  it("returns the previous entry on the next check of the same target", () => {
    const prev = recordAndGetPrevious("owner/repo", 61, "caution");
    assert.ok(prev);
    assert.equal(prev.score, 80);
    assert.equal(prev.verdict, "healthy");
    assert.equal(lastEntry("owner/repo")?.score, 61);
  });

  it("reads full history oldest first", () => {
    const all = readHistory("owner/repo");
    assert.equal(all.length, 2);
    assert.deepEqual(
      all.map((e) => e.score),
      [80, 61],
    );
  });

  it("treats unknown targets as empty history", () => {
    assert.equal(lastEntry("never-checked"), null);
    assert.deepEqual(readHistory("never-checked"), []);
  });

  it("keeps different targets separate", () => {
    recordAndGetPrevious("other/repo", 40, "risky");
    assert.equal(readHistory("owner/repo").length, 2);
    assert.equal(readHistory("other/repo").length, 1);
  });

  it("sanitizes unsafe target names into filenames", () => {
    recordAndGetPrevious("@scope/name", 50, "caution");
    assert.equal(existsSync(join(HISTORY_DIR, "_scope_name.jsonl")), true);

    recordAndGetPrevious("https://github.com/o/r", 70, "healthy");
    assert.equal(existsSync(join(HISTORY_DIR, "https___github.com_o_r.jsonl")), true);

    // reading back through the original target works either way
    assert.equal(readHistory("@scope/name").length, 1);
    assert.equal(readHistory("https://github.com/o/r").length, 1);
  });

  it("degrades gracefully on corrupted files instead of throwing", () => {
    recordAndGetPrevious("corrupted", 90, "healthy");
    appendFileSync(join(HISTORY_DIR, "corrupted.jsonl"), "not-json\n{broken\n");
    assert.equal(lastEntry("corrupted"), null);
    assert.deepEqual(readHistory("corrupted"), []);
  });
});
