#!/usr/bin/env node

// node:sqlite prints an ExperimentalWarning on load on some Node versions. It is noise for
// users of a CLI, so it is filtered before the store is imported; other warnings still show.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (/SQLite/i.test(text)) return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

export {};

const { main } = await import("./main.js");
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`agentprism: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
