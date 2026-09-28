import { checkTarget } from "./index.js";
import { recordAndGetPrevious } from "./history.js";
import { renderWatchLine } from "./report.js";
import type { SourceKind } from "./types.js";

// Turns a one-shot `check` into an ongoing monitor: re-checks a target on an
// interval, logs every tick to the same history file `check` reads its trend
// from, and calls out the moment a verdict actually flips instead of making
// you diff two reports by hand.

export async function runWatch(target: string, force: SourceKind | undefined, intervalMinutes: number): Promise<void> {
  process.stdout.write(`\n  Watching ${target} every ${intervalMinutes}m. Ctrl+C to stop.\n\n`);

  let stopped = false;
  process.on("SIGINT", () => {
    if (stopped) return;
    stopped = true;
    process.stdout.write("\n  Stopped.\n\n");
    process.exit(0);
  });

  while (!stopped) {
    try {
      const result = await checkTarget(target, force);
      const previous = recordAndGetPrevious(target, result.score, result.verdict);
      const changed = previous !== null && previous.verdict !== result.verdict;
      process.stdout.write(renderWatchLine(result, changed) + "\n");
      if (changed) {
        process.stdout.write(
          `    ${result.source.name} moved from ${previous!.verdict} to ${result.verdict} ` +
            `(${previous!.score} → ${result.score}/100).\n`,
        );
      }
    } catch (err) {
      process.stderr.write(`  scepter: check failed: ${(err as Error).message}\n`);
    }
    await sleep(intervalMinutes * 60_000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
