import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreSource, fmtAgo } from "../src/checks/score.js";
import { makeSource } from "./helpers.js";

const DAY = 24 * 60 * 60 * 1000;

describe("scoreSource", () => {
  it("scores a healthy github repo 100 with no reasons", () => {
    const r = scoreSource("owner/repo", makeSource());
    assert.equal(r.score, 100);
    assert.equal(r.verdict, "healthy");
    assert.deepEqual(r.reasons, []);
    assert.deepEqual(
      r.signals.map((s) => s.key),
      ["alive", "maintained", "trust", "mcp", "security"],
    );
  });

  describe("missing repo", () => {
    it("scores 0 and is risky when the source does not exist", () => {
      const r = scoreSource("ghost/repo", makeSource({ exists: false }));
      assert.equal(r.score, 0);
      assert.equal(r.verdict, "risky");
      assert.equal(r.signals.length, 1);
      assert.equal(r.signals[0].key, "exists");
      assert.equal(r.signals[0].status, "bad");
      assert.deepEqual(r.reasons, ["Nothing published at this github location."]);
    });

    it("names the kind in the reason for npm", () => {
      const r = scoreSource("ghost-pkg", makeSource({ exists: false, kind: "npm" }));
      assert.deepEqual(r.reasons, ["Nothing published at this npm location."]);
    });
  });

  describe("liveness", () => {
    it("is ok when active within 3 months", () => {
      const r = scoreSource("t", makeSource({ lastActivity: new Date(Date.now() - 10 * DAY) }));
      const alive = r.signals.find((s) => s.key === "alive")!;
      assert.equal(alive.status, "ok");
      assert.match(alive.detail, /active \(10 days ago\)/);
    });

    it("warns and explains when quiet for months", () => {
      const r = scoreSource("t", makeSource({ lastActivity: new Date(Date.now() - 150 * DAY) }));
      const alive = r.signals.find((s) => s.key === "alive")!;
      assert.equal(alive.status, "warn");
      assert.match(alive.detail, /quiet \(5 months ago\)/);
      assert.ok(r.reasons.some((x) => x.includes("No updates for")));
      assert.equal(r.score, 85); // 20 alive instead of 35
    });

    it("is bad and calls the repo abandoned when stale for years", () => {
      const r = scoreSource("t", makeSource({ lastActivity: new Date(Date.now() - 730 * DAY) }));
      const alive = r.signals.find((s) => s.key === "alive")!;
      assert.equal(alive.status, "bad");
      assert.match(alive.detail, /stale \(2 years ago\)/);
      assert.ok(r.reasons.some((x) => x.includes("Looks abandoned")));
      assert.equal(r.score, 68); // 3 alive instead of 35
    });

    it("warns but still gives partial credit when no date is available", () => {
      const r = scoreSource("t", makeSource({ lastActivity: null }));
      const alive = r.signals.find((s) => s.key === "alive")!;
      assert.equal(alive.status, "warn");
      assert.equal(alive.detail, "no date available");
      assert.equal(r.score, 77); // 12 alive instead of 35
    });
  });

  describe("maintenance", () => {
    it("flags an archived repo as risky regardless of score", () => {
      const r = scoreSource("t", makeSource({ archived: true }));
      // 35 + 0 maintained + 15 trust + 10 mcp + 20 security = 80
      assert.equal(r.score, 80);
      assert.equal(r.verdict, "risky");
      const maintained = r.signals.find((s) => s.key === "archived")!;
      assert.equal(maintained.label, "Maintained");
      assert.equal(maintained.status, "bad");
      assert.equal(maintained.detail, "repository is archived");
      assert.ok(r.reasons.includes("Repository is archived by its author."));
    });

    it("penalizes a missing license", () => {
      const r = scoreSource("t", makeSource({ license: null }));
      assert.ok(r.reasons.includes("No license declared."));
      assert.equal(r.score, 92);
      const maintained = r.signals.find((s) => s.key === "maintained")!;
      assert.equal(maintained.status, "warn");
      assert.match(maintained.detail, /no license/);
    });

    it("treats false and unknown (null) hasReleases the same", () => {
      for (const hasReleases of [false, null]) {
        const r = scoreSource("t", makeSource({ hasReleases }));
        assert.equal(r.score, 94);
        const maintained = r.signals.find((s) => s.key === "maintained")!;
        assert.match(maintained.detail, /no releases/);
      }
    });

    it("penalizes a missing repo link", () => {
      const r = scoreSource("t", makeSource({ hasRepoLink: false }));
      assert.ok(r.reasons.includes("No link back to source code."));
      assert.equal(r.score, 94);
    });
  });

  describe("provenance / trust", () => {
    it("caps the trust contribution at 15", () => {
      const r = scoreSource("t", makeSource({ stars: 5000, openIssues: 2 }));
      const trust = r.signals.find((s) => s.key === "trust")!;
      assert.equal(trust.status, "ok");
      assert.equal(r.score, 100); // nothing to add past the cap
    });

    it("scores 0 stars minimally", () => {
      const r = scoreSource("t", makeSource({ stars: 0 }));
      const trust = r.signals.find((s) => s.key === "trust")!;
      assert.match(trust.detail, /0 stars/);
      assert.equal(r.score, 95);
    });

    it("uses maintainers when stars are unknown (npm), singular for 1", () => {
      const one = scoreSource("t", makeSource({ kind: "npm", stars: null, maintainers: 1, openIssues: null }));
      const trustOne = one.signals.find((s) => s.key === "trust")!;
      assert.match(trustOne.detail, /1 maintainer(?!s)/);
      assert.equal(one.score, 93); // 4 described + 2 maintainer + 2 no-issues

      const two = scoreSource("t", makeSource({ kind: "npm", stars: null, maintainers: 2, openIssues: null }));
      assert.match(two.signals.find((s) => s.key === "trust")!.detail, /2 maintainers/);
      assert.equal(two.score, 97);
    });

    it("flags a backlog of open issues instead of rewarding them", () => {
      const r = scoreSource("t", makeSource({ openIssues: 300 }));
      assert.ok(r.reasons.includes("300 open issues piling up."));
      assert.equal(r.score, 95); // missing the usual +5
    });

    it("gives a small credit when open issues are unknown", () => {
      const r = scoreSource("t", makeSource({ openIssues: null }));
      assert.equal(r.score, 97);
    });

    it("penalizes a missing description", () => {
      const r = scoreSource("t", makeSource({ description: null }));
      assert.ok(r.reasons.includes("No description."));
      assert.equal(r.score, 96);
    });

    it("falls back to 'little public signal' when trust bits are empty", () => {
      const r = scoreSource(
        "t",
        makeSource({
          description: null,
          stars: null,
          maintainers: null,
          openIssues: null,
        }),
      );
      const trust = r.signals.find((s) => s.key === "trust")!;
      assert.equal(trust.detail, "little public signal");
    });
  });

  describe("MCP fit", () => {
    it("warns and explains when the target does not look like an MCP server", () => {
      const r = scoreSource("t", makeSource({ looksLikeMcp: false }));
      const mcp = r.signals.find((s) => s.key === "mcp")!;
      assert.equal(mcp.status, "warn");
      assert.ok(r.reasons.includes("Could not confirm this is an MCP server from its metadata."));
      assert.equal(r.score, 90);
    });
  });

  describe("security advisories", () => {
    it("rewards a clean advisory record", () => {
      const r = scoreSource("t", makeSource({ advisories: { total: 0, critical: 0, high: 0 } }));
      const sec = r.signals.find((s) => s.key === "security")!;
      assert.equal(sec.status, "ok");
      assert.equal(sec.detail, "no known advisories");
    });

    it("treats a critical advisory as an overriding red flag", () => {
      const r = scoreSource("t", makeSource({ advisories: { total: 2, critical: 1, high: 1 } }));
      const sec = r.signals.find((s) => s.key === "security")!;
      assert.equal(sec.status, "bad");
      assert.match(sec.detail, /1 critical advisory \(2 total\)/);
      assert.ok(r.reasons.includes("1 CRITICAL security advisory found."));
      assert.equal(r.score, 80); // no security points at all
      assert.equal(r.verdict, "risky"); // override despite the good score
    });

    it("penalizes high-severity advisories with correct pluralization", () => {
      const r = scoreSource("t", makeSource({ advisories: { total: 3, critical: 0, high: 2 } }));
      const sec = r.signals.find((s) => s.key === "security")!;
      assert.equal(sec.status, "bad");
      assert.match(sec.detail, /2 high-severity advisories \(3 total\)/);
      assert.ok(r.reasons.includes("2 high-severity security advisories found."));
      // 85: only a critical advisory overrides the verdict, so an otherwise
      // perfect repo stays healthy by score while the signal stays bad
      assert.equal(r.score, 85);
      assert.equal(r.verdict, "healthy");
    });

    it("warns on lower-severity advisories with correct pluralization", () => {
      const r = scoreSource("t", makeSource({ advisories: { total: 2, critical: 0, high: 0 } }));
      const sec = r.signals.find((s) => s.key === "security")!;
      assert.equal(sec.status, "warn");
      assert.match(sec.detail, /2 advisories \(low\/medium severity\)/);
      assert.ok(r.reasons.includes("2 lower-severity security advisories on record."));
      assert.equal(r.score, 92);
    });

    it("uses singular wording for a single lower-severity advisory", () => {
      const r = scoreSource("t", makeSource({ advisories: { total: 1, critical: 0, high: 0 } }));
      assert.match(r.signals.find((s) => s.key === "security")!.detail, /^1 advisory \(low\/medium severity\)$/);
      assert.ok(r.reasons.includes("1 lower-severity security advisory on record."));
    });

    it("stays neutral when advisories could not be checked", () => {
      const r = scoreSource("t", makeSource({ advisories: null }));
      const sec = r.signals.find((s) => s.key === "security")!;
      assert.equal(sec.status, "warn");
      assert.equal(sec.detail, "could not check advisories");
      assert.equal(r.score, 90); // +10 neutral, not a penalty
      assert.equal(r.verdict, "healthy");
    });

    it("does not let a single high advisory keep a mediocre server healthy", () => {
      const r = scoreSource(
        "t",
        makeSource({
          lastActivity: new Date(Date.now() - 150 * DAY), // quiet: +20
          stars: 10, // trust: 4 + 4 + 5 = 13
          advisories: { total: 1, critical: 0, high: 1 },
        }),
      );
      assert.equal(r.score, 68);
      assert.equal(r.verdict, "caution");
    });
  });

  describe("verdict boundaries", () => {
    it("scores exactly 75 as healthy (quiet repo, unknown advisories)", () => {
      const r = scoreSource(
        "t",
        makeSource({
          lastActivity: new Date(Date.now() - 150 * DAY), // +20
          stars: 100, // trust 4+6+5 = 15
          advisories: null, // +10
        }),
      );
      assert.equal(r.score, 75);
      assert.equal(r.verdict, "healthy");
    });

    it("scores just under 75 as caution (same repo, no MCP signal)", () => {
      const r = scoreSource(
        "t",
        makeSource({
          lastActivity: new Date(Date.now() - 150 * DAY),
          stars: 100,
          advisories: null,
          looksLikeMcp: false,
        }),
      );
      assert.equal(r.score, 65);
      assert.equal(r.verdict, "caution");
    });

    it("scores a neglected, unverifiable server as risky", () => {
      const r = scoreSource(
        "t",
        makeSource({
          lastActivity: new Date(Date.now() - 400 * DAY), // +3
          license: "MIT", // maintained +8 only
          hasReleases: false,
          hasRepoLink: false,
          description: null,
          stars: null,
          maintainers: null,
          openIssues: null, // trust +2
          looksLikeMcp: false,
          advisories: { total: 1, critical: 0, high: 0 }, // +12
        }),
      );
      assert.equal(r.score, 25);
      assert.equal(r.verdict, "risky");
    });
  });
});

describe("fmtAgo", () => {
  it("formats sub-month ages in days", () => {
    assert.equal(fmtAgo(0.5), "15 days ago");
    assert.equal(fmtAgo(10 / 30), "10 days ago");
  });

  it("never reports less than one day", () => {
    assert.equal(fmtAgo(0.0001), "1 day ago");
  });

  it("uses singular for exactly one day/month", () => {
    assert.equal(fmtAgo(1 / 30), "1 day ago");
    assert.equal(fmtAgo(1), "1 month ago");
  });

  it("formats months", () => {
    assert.equal(fmtAgo(5), "5 months ago");
    assert.equal(fmtAgo(11.6), "12 months ago");
  });

  it("formats years, dropping a trailing .0", () => {
    assert.equal(fmtAgo(12), "1 year ago");
    assert.equal(fmtAgo(24), "2 years ago");
    assert.equal(fmtAgo(30), "2.5 years ago");
  });
});
