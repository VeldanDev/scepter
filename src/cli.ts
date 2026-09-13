#!/usr/bin/env node
import { parseArgs } from "node:util";
import { checkTarget } from "./index.js";
import { renderResult, renderScanLine, renderSessionReport } from "./report.js";
import { extractTargetsFromConfig } from "./config.js";
import { runWrap } from "./wrap.js";
import { runBadge } from "./badge.js";
import { readSessions } from "./session.js";
import type { CheckResult, SourceKind } from "./types.js";

const VERSION = "0.2.1";

const HELP = `
scepter ${VERSION}  -  is this MCP server alive, maintained, and safe to use?

Usage:
  scepter check <server> [options]       Check one MCP server
  scepter scan <config-file> [options]   Check every server in an MCP config
  scepter badge <server>                 Print a README health badge
  scepter wrap -- <command...>           Run a server through Scepter and record its calls
  scepter report [options]               Show what your wrapped servers actually did

Targets:
  a github repo   owner/repo  or  https://github.com/owner/repo
  an npm package  some-mcp-server  or  @scope/name

Options:
  --github        force the target to be read as a GitHub repo
  --npm           force the target to be read as an npm package
  --json          print machine-readable JSON instead of a report
  -h, --help      show this help
  -v, --version   show version

Examples:
  scepter check modelcontextprotocol/servers
  scepter badge acme/weather-mcp
  scepter wrap -- npx -y @scope/weather-mcp
  scepter report

Notes:
  Set GITHUB_TOKEN to raise the GitHub API rate limit.
  check/scan/badge read registry and repo metadata. wrap records real calls
  locally under ~/.scepter. Scepter never claims a server is proven safe, only
  what it can actually observe.
`;

async function main(): Promise<void> {
  const raw = process.argv.slice(2);

  // `wrap` is special: everything after it (or after `--`) is the child command,
  // with its own flags, so it must not go through parseArgs.
  if (raw[0] === "wrap") {
    const sep = raw.indexOf("--");
    const cmd = sep === -1 ? raw.slice(1) : raw.slice(sep + 1);
    runWrap(cmd);
    return;
  }

  const { values, positionals } = parseArgs({
    args: raw,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      github: { type: "boolean", default: false },
      npm: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });

  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const force: SourceKind | undefined = values.github ? "github" : values.npm ? "npm" : undefined;
  const [command, arg] = positionals;

  if (values.help || !command) {
    process.stdout.write(HELP);
    return;
  }

  if (command === "check") {
    if (!arg) return fail("check needs a target, e.g. scepter check owner/repo");
    const result = await checkTarget(arg, force);
    outputCheck([result], Boolean(values.json), false);
    process.exitCode = result.verdict === "risky" ? 1 : 0;
    return;
  }

  if (command === "scan") {
    if (!arg) return fail("scan needs a config file, e.g. scepter scan ./mcp.json");
    let targets: string[];
    try {
      targets = await extractTargetsFromConfig(arg);
    } catch (err) {
      return fail(`could not read config: ${(err as Error).message}`);
    }
    if (targets.length === 0) {
      process.stdout.write("\n  No MCP servers found in that config.\n\n");
      return;
    }
    const results = await Promise.all(targets.map((t) => checkTarget(t, force)));
    outputCheck(results, Boolean(values.json), true);
    process.exitCode = results.some((r) => r.verdict === "risky") ? 1 : 0;
    return;
  }

  if (command === "badge") {
    if (!arg) return fail("badge needs a target, e.g. scepter badge owner/repo");
    await runBadge(arg, force, Boolean(values.json));
    return;
  }

  if (command === "report") {
    const sessions = readSessions();
    if (values.json) {
      process.stdout.write(JSON.stringify(sessions, null, 2) + "\n");
    } else {
      process.stdout.write(renderSessionReport(sessions));
    }
    return;
  }

  fail(`unknown command "${command}". Try: scepter --help`);
}

function outputCheck(results: CheckResult[], json: boolean, scan: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(scan ? results : results[0], null, 2) + "\n");
    return;
  }
  if (scan) {
    process.stdout.write("\n");
    const order = { healthy: 0, caution: 1, risky: 2 } as const;
    for (const r of [...results].sort((a, b) => order[a.verdict] - order[b.verdict])) {
      process.stdout.write(renderScanLine(r) + "\n");
    }
    const h = results.filter((r) => r.verdict === "healthy").length;
    const cc = results.filter((r) => r.verdict === "caution").length;
    const rr = results.filter((r) => r.verdict === "risky").length;
    process.stdout.write(`\n  ${h} healthy   ${cc} caution   ${rr} risky\n\n`);
    return;
  }
  process.stdout.write(renderResult(results[0]));
}

function fail(msg: string): void {
  process.stderr.write(`scepter: ${msg}\n`);
  process.exitCode = 2;
}

main().catch((err) => {
  process.stderr.write(`scepter: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
