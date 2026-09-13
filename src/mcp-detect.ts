// One shared heuristic for "does this look like an MCP server?", used by both
// the npm and GitHub checks so they stay consistent.

const NEEDLES = ["mcp", "model-context", "model context", "modelcontextprotocol"];

export function detectMcp(
  name: string,
  description: string | null,
  tags: string[] = [],
): boolean {
  const hay = [name, description ?? "", ...tags].join(" ").toLowerCase();
  return NEEDLES.some((n) => hay.includes(n));
}
