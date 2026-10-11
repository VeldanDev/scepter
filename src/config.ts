import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerSpec } from "./inspect.js";

/**
 * Pull candidate MCP server identifiers out of a config file.
 *
 * Understands the common shape used by MCP clients:
 *   { "mcpServers": { "<name>": { "command": "npx", "args": ["-y", "some-mcp"] } } }
 *
 * For stdio servers launched via npx/npm, the package name in `args` is the
 * thing worth checking. Flags (starting with "-") and the runner itself are
 * skipped. Returns a de-duplicated list of package names.
 */
export async function extractTargetsFromConfig(path: string): Promise<string[]> {
  const text = await readFile(path, "utf8");
  const json = JSON.parse(text) as {
    mcpServers?: Record<string, { command?: string; args?: string[] }>;
    servers?: Record<string, { command?: string; args?: string[] }>;
  };

  const servers = json.mcpServers ?? json.servers ?? {};
  const targets = new Set<string>();

  for (const entry of Object.values(servers)) {
    const cmd = (entry.command ?? "").toLowerCase();
    const args = entry.args ?? [];

    if (cmd.includes("npx") || cmd.includes("npm") || cmd.includes("bunx") || cmd.includes("pnpm")) {
      const pkg = firstPackageArg(args);
      if (pkg) targets.add(pkg);
    }
  }

  return [...targets];
}

/**
 * Every server in a config as something `inspect` can connect to: stdio
 * entries keep their command, args and env; remote entries their URL and
 * headers (`url` or `serverUrl`, as written by different clients).
 */
export async function readServerSpecs(path: string): Promise<ServerSpec[]> {
  const json = JSON.parse(await readFile(path, "utf8"));
  const servers: Record<string, any> = json.mcpServers ?? json.servers ?? {};
  const specs: ServerSpec[] = [];
  for (const [name, e] of Object.entries(servers)) {
    if (e?.disabled) continue;
    const url = e?.url ?? e?.serverUrl;
    if (typeof url === "string") specs.push({ name, url, headers: e.headers });
    else if (typeof e?.command === "string") specs.push({ name, command: e.command, args: e.args ?? [], env: e.env });
  }
  return specs;
}

/**
 * MCP config files that exist on this machine, for `scepter audit` with no
 * path. Locations per client and OS, as the clients themselves document them.
 */
export function discoverConfigs(home = homedir(), cwd = process.cwd()): { client: string; path: string }[] {
  const appData = join(home, "AppData", "Roaming"); // %APPDATA% default; derived from home so tests stay isolated
  const appSupport =
    process.platform === "win32" ? appData : process.platform === "darwin" ? join(home, "Library", "Application Support") : join(home, ".config");
  const candidates: [string, string][] = [
    ["claude-code", join(home, ".claude.json")],
    ["claude-desktop", join(appSupport, "Claude", "claude_desktop_config.json")],
    ["cursor", join(home, ".cursor", "mcp.json")],
    ["windsurf", join(home, ".codeium", "windsurf", "mcp_config.json")],
    ["vscode", join(appSupport, "Code", "User", "mcp.json")],
    ["gemini", join(home, ".gemini", "settings.json")],
    ["project", join(cwd, ".mcp.json")],
    ["project", join(cwd, ".cursor", "mcp.json")],
    ["project", join(cwd, ".vscode", "mcp.json")],
  ];
  return candidates.filter(([, p]) => existsSync(p)).map(([client, path]) => ({ client, path }));
}

/** Every server across the discovered configs, named "<client>/<server>", duplicates dropped. */
export async function discoverServerSpecs(): Promise<{ configs: string[]; specs: ServerSpec[] }> {
  const seen = new Set<string>();
  const specs: ServerSpec[] = [];
  const configs: string[] = [];
  for (const { client, path } of discoverConfigs()) {
    let found: ServerSpec[];
    try {
      found = await readServerSpecs(path);
    } catch {
      continue; // a malformed config in one client shouldn't stop the audit of the others
    }
    if (found.length) configs.push(path);
    for (const s of found) {
      const key = JSON.stringify("url" in s ? [s.url] : [s.command, s.args]);
      if (seen.has(key)) continue;
      seen.add(key);
      specs.push({ ...s, name: `${client}/${s.name}` });
    }
  }
  return { configs, specs };
}

function firstPackageArg(args: string[]): string | null {
  for (const a of args) {
    if (a.startsWith("-")) continue; // flags like -y, --yes
    if (a === "dlx" || a === "exec" || a === "run") continue; // pnpm/bun subcommands
    // strip a trailing @version, but keep scoped @scope/name
    if (a.startsWith("@")) {
      const at = a.indexOf("@", 1);
      return at === -1 ? a : a.slice(0, at);
    }
    return a.split("@")[0];
  }
  return null;
}
