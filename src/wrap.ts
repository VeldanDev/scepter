import { spawn } from "node:child_process";
import { createSession, type SessionEvent } from "./session.js";

// Transparent stdio proxy. Scepter sits between an MCP client (the agent) and
// the real server: it forwards every byte unchanged in both directions, so the
// agent behaves exactly as before, while teeing a copy of the JSON-RPC traffic
// to a session log. That log is what `scepter report` reads back.

interface Pending {
  method: string;
  tool?: string;
  t: number;
}

export function runWrap(argv: string[]): void {
  if (argv.length === 0) {
    process.stderr.write("scepter: wrap needs a command, e.g. scepter wrap -- npx -y some-mcp-server\n");
    process.exitCode = 2;
    return;
  }

  const [cmd, ...args] = argv;
  const server = deriveServerName(cmd, args);
  const session = createSession(server, argv.join(" "));

  // On Windows, npx/npm and friends are .cmd shims that can only be spawned
  // through a shell. Everything else (node, direct binaries, absolute paths)
  // is spawned without a shell, which is safer and avoids Node's shell-args
  // deprecation warning.
  const winCmdRunner =
    process.platform === "win32" && /^(npx|npm|pnpm|yarn|bunx|corepack)$/i.test(cmd);
  const child = spawn(cmd, args, {
    stdio: ["pipe", "pipe", "inherit"],
    shell: winCmdRunner,
    windowsHide: true,
  });

  // Raw forwarding: exact bytes, no re-serialization.
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);

  // Tee a copy for parsing. Requests come from the client (our stdin); their
  // matching responses come back from the server (child stdout).
  const pending = new Map<string | number, Pending>();
  teeParse(process.stdin, (msg) => onClientMessage(msg, pending, session.log));
  teeParse(child.stdout, (msg) => onServerMessage(msg, pending, session.log));

  const finish = (code: number) => {
    session.end(code);
    process.exit(code);
  };
  child.on("exit", (code) => finish(code ?? 0));
  child.on("error", (err) => {
    process.stderr.write(`scepter: failed to start server: ${err.message}\n`);
    finish(1);
  });
}

function onClientMessage(
  msg: Record<string, unknown>,
  pending: Map<string | number, Pending>,
  log: (e: SessionEvent) => void,
): void {
  const method = typeof msg.method === "string" ? msg.method : undefined;
  const id = msg.id as string | number | undefined;
  if (method && id !== undefined) {
    const tool =
      method === "tools/call" && isRecord(msg.params) && typeof msg.params.name === "string"
        ? msg.params.name
        : undefined;
    pending.set(id, { method, tool, t: Date.now() });
    log({ t: Date.now(), dir: "client", method, id, tool });
  } else if (method) {
    log({ t: Date.now(), dir: "client", method });
  }
}

function onServerMessage(
  msg: Record<string, unknown>,
  pending: Map<string | number, Pending>,
  log: (e: SessionEvent) => void,
): void {
  const id = msg.id as string | number | undefined;
  if (id !== undefined && (("result" in msg) || ("error" in msg))) {
    const req = pending.get(id);
    if (req) pending.delete(id);
    const ok = !("error" in msg) || msg.error == null;
    const error =
      isRecord(msg.error) && typeof msg.error.message === "string" ? msg.error.message : undefined;
    log({
      t: Date.now(),
      dir: "server",
      method: req?.method,
      id,
      tool: req?.tool,
      ok,
      ms: req ? Date.now() - req.t : undefined,
      error,
    });
  } else if (typeof msg.method === "string") {
    log({ t: Date.now(), dir: "server", method: msg.method });
  }
}

/** Attach a line-buffered JSON parser without consuming the stream. */
function teeParse(stream: NodeJS.ReadableStream, onMsg: (msg: Record<string, unknown>) => void): void {
  let buf = "";
  stream.on("data", (chunk: Buffer | string) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (isRecord(obj)) onMsg(obj);
      } catch {
        // Not a complete/valid JSON line: ignore for logging, bytes still flow.
      }
    }
    if (buf.length > 1_000_000) buf = ""; // guard against unbounded growth
  });
}

function deriveServerName(cmd: string, args: string[]): string {
  const runner = /^(npx|npm|bunx|pnpm|yarn|deno)(\.cmd)?$/i.test(cmd);
  if (runner) {
    for (const a of args) {
      if (a.startsWith("-")) continue;
      if (["dlx", "exec", "run", "-y", "add"].includes(a)) continue;
      return a.startsWith("@") ? a.split("@").slice(0, 2).join("@").replace(/@$/, "") : a.split("@")[0];
    }
  }
  return cmd.replace(/\\/g, "/").split("/").pop() || cmd;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
