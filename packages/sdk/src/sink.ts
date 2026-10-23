import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TraceEvent } from "./format.js";

/** Where trace events go. Writing must never throw into the app. */
export interface TraceSink {
  write(event: TraceEvent): void;
}

/** `~/.agentprism/traces`, or `$AGENTPRISM_TRACES`, or `$AGENTPRISM_HOME/traces`. */
export function defaultTraceDir(): string {
  if (process.env.AGENTPRISM_TRACES) return process.env.AGENTPRISM_TRACES;
  const home = process.env.AGENTPRISM_HOME ?? path.join(os.homedir(), ".agentprism");
  return path.join(home, "traces");
}

const safeName = (name: string) => name.replace(/[^\w.-]+/g, "_").slice(0, 64) || "app";

/**
 * Appends JSONL to `<dir>/<app>/<YYYY-MM-DD>.jsonl` (UTC day). Synchronous appends keep events in
 * order and survive crashes; at one line per model call the cost is negligible next to the call.
 */
export class FileSink implements TraceSink {
  private readonly made = new Set<string>();
  private warned = false;

  constructor(private readonly dir: string = defaultTraceDir()) {}

  write(event: TraceEvent): void {
    try {
      const folder = path.join(this.dir, safeName(event.app));
      if (!this.made.has(folder)) {
        fs.mkdirSync(folder, { recursive: true });
        this.made.add(folder);
      }
      const day = new Date(event.ts).toISOString().slice(0, 10);
      fs.appendFileSync(path.join(folder, `${day}.jsonl`), JSON.stringify(event) + "\n");
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        process.emitWarning(`agentprism: could not write traces (${(err as Error).message})`);
      }
    }
  }
}

/** Keeps events in memory: tests, or forwarding them elsewhere. */
export class MemorySink implements TraceSink {
  readonly events: TraceEvent[] = [];
  write(event: TraceEvent): void {
    this.events.push(event);
  }
}
