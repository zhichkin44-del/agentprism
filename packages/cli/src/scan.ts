import { newReadStats, type Adapter, type ReadStats, type Store } from "@agentprism/core";

export interface ScanResult {
  files: number;
  changed: number;
  events: number;
  durationMs: number;
  stats: ReadStats;
}

export interface ScanOptions {
  /** Re-read every file even if it has not changed since the last scan. */
  full?: boolean;
  onProgress?: (done: number, total: number, file: string) => void;
}

/** Ingests every new or changed log file of every adapter into the store. */
export async function scan(
  store: Store,
  adapters: Adapter[],
  options: ScanOptions = {},
): Promise<ScanResult> {
  const started = performance.now();
  const stats = newReadStats();
  let files = 0;
  let changed = 0;
  let events = 0;

  for (const adapter of adapters) {
    const sources = await adapter.discover();
    files += sources.length;
    const todo = sources.filter((f) => {
      if (options.full) return true;
      const known = store.sourceState(f.path);
      return !known || known.size !== f.size || known.mtimeMs !== f.mtimeMs;
    });
    // Main session files first, so sessions get their project before subagent files arrive.
    todo.sort((a, b) => a.path.length - b.path.length);

    for (const [i, file] of todo.entries()) {
      options.onProgress?.(i, todo.length, file.path);
      events += await store.ingest(file, adapter.read(file, stats));
      changed++;
    }
  }

  if (changed > 0) store.finalize();
  return { files, changed, events, durationMs: performance.now() - started, stats };
}
