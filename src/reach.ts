import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runtime reach: which powerful Node built-ins a server actually loads while it
// starts and lists its tools. The tool list says what a server claims to do;
// this says what it brought along to do it with (spawning processes, opening
// sockets, touching the file system).
//
// A tiny probe is preloaded through NODE_OPTIONS. It snapshots the built-ins
// Node itself loaded before the server's code ran, then records the public
// ones loaded after. Every node process in the chain (npx, npm, the server)
// writes its own file; npm's own processes are dropped.

const PROBE = `
const fs = require("fs"), path = require("path");
const loaded = () => process.moduleLoadList.filter((m) => m.startsWith("NativeModule ")).map((m) => m.slice(13));
const before = new Set(loaded());
const file = path.join(process.env.SCEPTER_REACH_DIR, process.pid + ".json");
const dump = () => {
  try {
    const added = loaded().filter((m) => !before.has(m) && !m.startsWith("internal/"));
    fs.writeFileSync(file, JSON.stringify({ argv: process.argv.slice(1, 2), modules: added }));
  } catch {}
};
setInterval(dump, 300).unref();
process.on("exit", dump);
`;

export interface Reach {
  processes: boolean;
  network: boolean;
  files: boolean;
  modules: string[];
}

const GROUPS = {
  processes: ["child_process", "worker_threads", "cluster"],
  network: ["net", "http", "https", "http2", "dgram", "dns", "tls"],
  files: ["fs", "fs/promises"],
};

export function startReachProbe(baseNodeOptions = process.env.NODE_OPTIONS): { env: Record<string, string>; collect: () => Reach | null; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "scepter-reach-"));
  const probe = join(dir, "probe.cjs");
  writeFileSync(probe, PROBE);
  const out = join(dir, "out");
  mkdirSync(out);
  const quoted = probe.includes(" ") ? `"${probe}"` : probe;
  return {
    env: { NODE_OPTIONS: `${baseNodeOptions ?? ""} --require ${quoted}`.trim(), SCEPTER_REACH_DIR: out },
    collect: () => collectReach(out),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Merge the probe files, ignoring npm/npx's own processes. Null when nothing was recorded (not a Node server). */
export function collectReach(dir: string): Reach | null {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }
  const modules = new Set<string>();
  for (const f of files) {
    try {
      const rec = JSON.parse(readFileSync(join(dir, f), "utf8")) as { argv: string[]; modules: string[] };
      // npm's own CLI only; global packages also live under ".../npm/node_modules/<pkg>".
      if (/node_modules[\\/]npm[\\/]|npx-cli\.js|npm-cli\.js/.test(rec.argv[0] ?? "")) continue;
      rec.modules.forEach((m) => modules.add(m));
    } catch {
      // a half-written file from a process that was just killed
    }
  }
  if (!files.length) return null;
  const has = (g: string[]) => g.some((m) => modules.has(m));
  // child_process itself loads `net` and `dgram`, so those only count without it.
  const viaChild = ["net", "dgram"];
  const network = has(GROUPS.network.filter((m) => !viaChild.includes(m))) || (!modules.has("child_process") && has(viaChild));
  return { processes: has(GROUPS.processes), network, files: has(GROUPS.files), modules: [...modules].sort() };
}
