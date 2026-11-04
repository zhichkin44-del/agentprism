import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { claudeCodeAdapter } from "@agentprism/adapter-claude-code";
import { tracesAdapter } from "@agentprism/adapter-traces";
import {
  DEFAULT_PRICES,
  Registry,
  Store,
  coreDetectors,
  definePlugin,
  mergePrices,
  overview,
  runDetectors,
  compare,
  spend,
  type PriceTable,
} from "@agentprism/core";
import pkg from "../package.json" with { type: "json" };
import { printCompare } from "./compare.js";
import { analyseContext, pickSession, printContext } from "./context.js";
import { publicReport, renderContextHtml } from "./context-html.js";
import { printFindings } from "./findings.js";
import { printOverview, printScan, printSpend } from "./report.js";
import { scan } from "./scan.js";

const HELP = `
agentprism ${pkg.version} — devtools for AI coding agents

Usage
  agentprism [command] [options]

Commands
  (none)        Spend headline and the top findings
  report        Where the money went: projects, models, days, sessions, prompts
  findings      Waste detectors: what cost money for nothing, and how to fix it
  scan          Ingest logs and print what is in the database
  mark <name>   Remember "now" as the moment something changed (new CLAUDE.md, habit, model)
  compare       Before vs after a mark or date: is it actually cheaper and smoother?
  modules       List loaded plugins and their modules
  context [s]   Context economics of a session (id prefix or title; default: the latest):
                what the prompt carries after its last use, and when to compact. Advisory.

Options
  --root <dir>         Claude Code logs directory (default: ~/.claude/projects)
  --traces <dir>       SDK traces of your own apps (default: ~/.agentprism/traces)
  --db <file>          Database file (default: ~/.agentprism/agentprism.db)
  --plugin <spec>      Load a plugin (file path or package); repeatable
  --top <n>            Rows per table (default: 10)
  --split <mark|date>  compare: the mark name or YYYY-MM-DD to split at (default: latest mark)
  --note <text>        mark: what changed
  --full               Re-read all logs, not only new or changed ones
  --no-scan            Use the database as is, do not read logs first
  --rho <usd>          context: price of forgetting per compaction (default 0.5)
  --html <file>        context: also write an anonymized HTML report
  --json               Print machine-readable JSON
  -v, --version        Print the version
  -h, --help           Print this help

Costs are API-equivalent estimates from list prices; override them in ~/.agentprism/prices.json.
Everything runs locally. Your logs never leave this machine.
`;

const COMMANDS = new Set([
  "summary",
  "report",
  "findings",
  "scan",
  "mark",
  "compare",
  "modules",
  "context",
]);

/** A mark name, a date, or (by default) the latest mark. */
function resolveSplit(
  store: Store,
  split: string | undefined,
): { ts: number; label: string } | undefined {
  const marks = store.marks();
  if (!split) {
    const last = marks.at(-1);
    return last ? { ts: last.ts, label: last.name } : undefined;
  }
  const mark = marks.find((m) => m.name === split);
  if (mark) return { ts: mark.ts, label: mark.name };
  const ts = Date.parse(split);
  return Number.isFinite(ts) ? { ts, label: split } : undefined;
}

function home(): string {
  return process.env.AGENTPRISM_HOME ?? path.join(os.homedir(), ".agentprism");
}

function loadPrices(): PriceTable {
  const file = path.join(home(), "prices.json");
  if (!fs.existsSync(file)) return DEFAULT_PRICES;
  return mergePrices(DEFAULT_PRICES, JSON.parse(fs.readFileSync(file, "utf8")));
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      root: { type: "string" },
      traces: { type: "string" },
      db: { type: "string" },
      plugin: { type: "string", multiple: true, default: [] },
      top: { type: "string", default: "10" },
      split: { type: "string" },
      note: { type: "string" },
      full: { type: "boolean", default: false },
      scan: { type: "boolean", default: true },
      json: { type: "boolean", default: false },
      rho: { type: "string" },
      html: { type: "string" },
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  const command = positionals[0] ?? "summary";
  if (!COMMANDS.has(command)) {
    process.stderr.write(`Unknown command: ${command}\n${HELP}`);
    return 2;
  }
  const top = Math.max(1, Number.parseInt(values.top, 10) || 10);

  // Built-ins are plugins like any other; nothing below names a specific adapter or detector.
  const registry = new Registry()
    .use(
      definePlugin({ name: "claude-code", adapters: [claudeCodeAdapter({ root: values.root })] }),
    )
    .use(definePlugin({ name: "sdk-traces", adapters: [tracesAdapter({ dir: values.traces })] }))
    .use(coreDetectors);
  for (const spec of values.plugin) await registry.load(spec);

  if (command === "modules") {
    for (const p of registry.plugins) {
      process.stdout.write(`${p.name}\n`);
      for (const a of p.adapters ?? []) process.stdout.write(`  adapter   ${a.id}\n`);
      for (const d of p.detectors ?? [])
        process.stdout.write(`  detector  ${d.id} — ${d.description}\n`);
      for (const f of p.fixes ?? []) process.stdout.write(`  fix       ${f.id}\n`);
    }
    return 0;
  }

  const store = Store.open(values.db ?? path.join(home(), "agentprism.db"), loadPrices());
  try {
    const showProgress = !values.json && process.stderr.isTTY;
    const scanResult =
      values.scan || command === "scan"
        ? await scan(store, registry.adapters, {
            full: values.full,
            onProgress: showProgress
              ? (done, total) => process.stderr.write(`\rReading logs… ${done + 1}/${total}`)
              : undefined,
          })
        : undefined;
    if (showProgress) process.stderr.write("\r\x1b[2K");

    const out: Record<string, unknown> = {};
    if (scanResult) {
      out.scan = {
        ...scanResult,
        stats: {
          ...scanResult.stats,
          unknownTypes: Object.fromEntries(scanResult.stats.unknownTypes),
        },
      };
      if (!values.json) printScan(scanResult);
    }

    if (command === "scan") {
      const o = overview(store);
      out.overview = o;
      if (!values.json) printOverview(o);
    }
    if (command === "report" || command === "summary") {
      const s = spend(store, { top: command === "summary" ? 5 : top });
      out.spend = s;
      if (!values.json) printSpend(s, { brief: command === "summary" });
    }
    if (command === "findings" || command === "summary") {
      const runs = await runDetectors(registry.detectors, { store });
      out.findings = runs.map((r) => ({
        detector: r.detector.id,
        durationMs: r.durationMs,
        error: r.error,
        findings: r.findings,
      }));
      if (!values.json) printFindings(store, runs, { top: command === "summary" ? 5 : top });
    }
    if (command === "mark") {
      const name = positionals[1];
      if (!name) {
        process.stderr.write("Usage: agentprism mark <name> [--note <text>]\n");
        return 2;
      }
      store.mark(name, Date.now(), values.note);
      out.mark = { name, ts: Date.now() };
      if (!values.json) {
        process.stdout.write(
          `\nMarked "${name}". Work as usual, then run: agentprism compare --split "${name}"\n\n`,
        );
      }
    }
    if (command === "context") {
      const session = pickSession(store, positionals[1]);
      if (!session) {
        process.stderr.write("No matching session with model calls.\n");
        return 2;
      }
      const rho = values.rho === undefined ? undefined : Number(values.rho);
      if (rho !== undefined && !(rho >= 0)) {
        process.stderr.write("--rho must be a number of dollars, 0 or more.\n");
        return 2;
      }
      const r = await analyseContext(store, registry.adapters, session, { rho });
      if (typeof r === "string") {
        process.stderr.write(r + "\n");
        return 2;
      }
      const report = publicReport(r, pkg.version);
      out.context = report;
      if (values.html) fs.writeFileSync(values.html, renderContextHtml(report));
      if (!values.json) printContext(r, values.html);
    }
    if (command === "compare") {
      const split = resolveSplit(store, values.split);
      if (!split) {
        process.stderr.write(
          'Nothing to compare against. Run `agentprism mark "<what changed>"` first, or pass --split <YYYY-MM-DD>.\n',
        );
        return 2;
      }
      const runs = await runDetectors(registry.detectors, { store });
      const c = compare(
        store,
        split.ts,
        split.label,
        runs.flatMap((r) => r.findings),
      );
      out.compare = c;
      if (!values.json) printCompare(c);
    }

    if (values.json) process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return 0;
  } finally {
    store.close();
  }
}
