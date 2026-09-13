#!/usr/bin/env node
import { parseArgs } from "node:util";
import { checkTarget } from "./index.js";
import { renderResult, renderScanLine } from "./report.js";
import { extractTargetsFromConfig } from "./config.js";
import type { CheckResult, SourceKind } from "./types.js";

const VERSION = "0.1.0";

const HELP = `
scepter ${VERSION}  -  is this MCP server alive, maintained, and safe to use?

Usage:
  scepter check <server> [options]     Check one MCP server
  scepter scan <config-file> [options] Check every server in an MCP config

Targets:
  a github repo   owner/repo  or  https://github.com/owner/repo
  an npm package  some-mcp-server  or  @scope/name

Options:
  --github        force the target to be read as a GitHub repo
  --npm           force the target to be read as an npm package
  --json          print machine-readable JSON instead of a report
  -h, --help      show this help
  -v, --version   show version

Notes:
  Set GITHUB_TOKEN to raise the GitHub API rate limit.
  v1 reads registry and repo metadata. Live handshake and permission checks
  are on the roadmap; this tool never claims a server is "undetectable" or
  proven safe, only what the metadata shows.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
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
  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return;
  }

  const force: SourceKind | undefined = values.github ? "github" : values.npm ? "npm" : undefined;
  const [command, arg] = positionals;

  if (command === "check") {
    if (!arg) fail("check needs a target, e.g. scepter check owner/repo");
    const result = await checkTarget(arg, force);
    output([result], Boolean(values.json), false);
    process.exitCode = result.verdict === "risky" ? 1 : 0;
    return;
  }

  if (command === "scan") {
    if (!arg) fail("scan needs a config file, e.g. scepter scan ./mcp.json");
    let targets: string[];
    try {
      targets = await extractTargetsFromConfig(arg);
    } catch (err) {
      fail(`could not read config: ${(err as Error).message}`);
      return;
    }
    if (targets.length === 0) {
      process.stdout.write("\n  No MCP servers found in that config.\n\n");
      return;
    }
    const results = await Promise.all(targets.map((t) => checkTarget(t, force)));
    output(results, Boolean(values.json), true);
    process.exitCode = results.some((r) => r.verdict === "risky") ? 1 : 0;
    return;
  }

  fail(`unknown command "${command}". Try: scepter --help`);
}

function output(results: CheckResult[], json: boolean, scan: boolean): void {
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
    const tally = summarize(results);
    process.stdout.write(`\n  ${tally}\n\n`);
    return;
  }
  process.stdout.write(renderResult(results[0]));
}

function summarize(results: CheckResult[]): string {
  const h = results.filter((r) => r.verdict === "healthy").length;
  const c = results.filter((r) => r.verdict === "caution").length;
  const r = results.filter((r) => r.verdict === "risky").length;
  return `${h} healthy   ${c} caution   ${r} risky`;
}

function fail(msg: string): void {
  process.stderr.write(`scepter: ${msg}\n`);
  process.exitCode = 2;
}

main().catch((err) => {
  process.stderr.write(`scepter: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
