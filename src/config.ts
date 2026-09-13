import { readFile } from "node:fs/promises";

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
