import path from "node:path";
import {
  compactionPlan,
  contextLedger,
  type Adapter,
  type CompactionPlan,
  type ContextLedger,
  type SourceFile,
  type Store,
} from "@agentprism/core";
import { accent, bar, bold, compact, dim, int, pct, table, usd, warn } from "./format.js";

const out = (line = "") => process.stdout.write(line + "\n");
const indent = (lines: string[]) => lines.forEach((l) => out("  " + l));

/** A block counts as idle "now" when no call has used it for this many calls. */
export const IDLE_CALLS = 50;

export interface ContextResult {
  sessionId: string;
  title: string | null;
  ledger: ContextLedger;
  plan: CompactionPlan;
}

/** Picks a session by id prefix or title text; by default the one with the latest model call. */
export function pickSession(
  store: Store,
  selector?: string,
): { id: string; title: string | null; agent: string } | undefined {
  const rows = store.db
    .prepare(
      `SELECT s.id, s.title, s.agent, MAX(a.ts) AS last, COUNT(a.id) AS calls
       FROM sessions s JOIN api_calls a ON a.session_id = s.id AND a.subagent_id IS NULL
       GROUP BY s.id HAVING calls >= 2 ORDER BY last DESC`,
    )
    .all() as { id: string; title: string | null; agent: string; last: number; calls: number }[];
  if (!selector) return rows[0];
  const s = selector.toLowerCase();
  return (
    rows.find((r) => r.id.startsWith(s)) ?? rows.find((r) => r.title?.toLowerCase().includes(s))
  );
}

export async function analyseContext(
  store: Store,
  adapters: Adapter[],
  session: { id: string; title: string | null; agent: string },
  options: { rho?: number },
): Promise<ContextResult | string> {
  const adapter = adapters.find((a) => a.id === session.agent);
  if (!adapter?.timeline) return `The ${session.agent} adapter cannot read session content.`;
  const files = store.db
    .prepare(
      `SELECT path, agent, size, mtime_ms AS mtimeMs FROM sources
       WHERE path IN (SELECT DISTINCT source FROM api_calls WHERE session_id = ?
                      UNION SELECT DISTINCT source FROM turns WHERE session_id = ?)`,
    )
    .all(session.id, session.id) as unknown as SourceFile[];
  const timeline = await adapter.timeline(files, session.id);
  const ledger = contextLedger(timeline, store.prices);
  if (ledger.calls.length < 2) return "Not enough model calls in this session.";
  const plan = compactionPlan(ledger.calls, store.prices, { rho: options.rho });
  return { sessionId: session.id, title: session.title, ledger, plan };
}

/** Blocks still in the prompt at the last call that no call has used for IDLE_CALLS calls. */
export function idleNow(ledger: ContextLedger) {
  const last = ledger.calls.length - 1;
  const lastCall = ledger.calls[last];
  const perToken = lastCall && lastCall.ctx ? lastCall.promptUsd / lastCall.ctx : 0;
  // Thinking is left out: its use is not visible in the logs.
  const idle = ledger.blocks.filter(
    (b) =>
      !b.always &&
      b.type !== "thinking" &&
      b.end === last &&
      Math.max(b.birth, b.lastUse) < last - IDLE_CALLS,
  );
  const tokens = idle.reduce((s, b) => s + b.size, 0);
  return { idle, tokens, usdPerCall: tokens * perToken, perToken };
}

export function printContext(r: ContextResult, htmlPath?: string): void {
  const { ledger: l, plan } = r;
  const t = l.totals;
  const first = l.calls[0];
  const last = l.calls.at(-1);
  const models = [...new Set(l.calls.map((c) => c.model.replace(/^claude-/, "")))].join(", ");
  out();
  out(
    `${bold(accent("◆ AgentPrism"))}  ${bold("context economics")}  ${dim("advisory: changes nothing")}`,
  );
  out(
    dim(
      `${r.title ?? r.sessionId.slice(0, 8)} · ${new Date(first?.ts ?? 0).toISOString().slice(0, 16).replace("T", " ")} → ${new Date(
        last?.ts ?? 0,
      )
        .toISOString()
        .slice(0, 16)
        .replace("T", " ")} · ${int(l.calls.length)} calls · ${models}`,
    ),
  );
  const total = t.promptUsd + t.outputUsd;
  out();
  out(
    `${bold(`Re-reading the prompt  ${usd(t.promptUsd)}`)} ${dim(`${pct(t.promptUsd, total)} of ${usd(total)} (main chain)`)}`,
  );
  indent(
    table(
      [
        [
          "always needed",
          usd(t.alwaysUsd),
          pct(t.alwaysUsd, t.promptUsd),
          bar(t.alwaysUsd, t.promptUsd),
          dim("system, tools, summaries, your prompts"),
        ],
        [
          "content in use",
          usd(t.usedUsd),
          pct(t.usedUsd, t.promptUsd),
          bar(t.usedUsd, t.promptUsd),
          "",
        ],
        [
          "after its last use",
          usd(t.deadUsd),
          pct(t.deadUsd, t.promptUsd),
          bar(t.deadUsd, t.promptUsd),
          dim("upper bound: an oracle could drop it"),
        ],
        [
          "earlier thinking",
          usd(t.thinkingUsd),
          pct(t.thinkingUsd, t.promptUsd),
          bar(t.thinkingUsd, t.promptUsd),
          dim("use not visible in logs"),
        ],
      ],
      ["l", "r", "r", "l", "l"],
    ),
  );

  const byLabel = deadByLabel(l).slice(0, 6);
  if (byLabel.length) {
    out();
    out(bold("Where the dead weight is"));
    indent(
      table(
        byLabel.map((g) => [
          g.label,
          usd(g.deadUsd),
          dim(`${pct(g.deadUsd, g.carryUsd)} of its carrying`),
        ]),
        ["l", "r", "l"],
      ),
    );
  }

  const now = idleNow(l);
  out();
  out(bold("Now") + dim(` (last call ${ago(last?.ts ?? 0)})`));
  out(
    `  prompt ${compact(plan.now.ctx)} tokens; ${compact(now.tokens)} of them unused for ${IDLE_CALLS}+ calls, costing ${usd(now.usdPerCall)} per call`,
  );
  const kinds = new Map<string, { tokens: number; n: number }>();
  for (const b of now.idle) {
    const k = kinds.get(b.label) ?? kinds.set(b.label, { tokens: 0, n: 0 }).get(b.label);
    if (k) {
      k.tokens += b.size;
      k.n++;
    }
  }
  for (const [label, k] of [...kinds].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 4)) {
    out(dim(`  · ${label}  ${compact(k.tokens)} tokens in ${int(k.n)} blocks`));
  }
  const biggest = [...now.idle].sort((a, b) => b.size - a.size)[0];
  if (biggest && biggest.size >= 2000) {
    const used =
      biggest.lastUse < 0
        ? "never used after the first read"
        : `last used ${int(l.calls.length - 1 - biggest.lastUse)} calls ago`;
    out(
      dim(
        `  · largest: ${biggest.label}${biggest.target ? " " + path.basename(biggest.target) : ""}, ${compact(biggest.size)} tokens, ${used}`,
      ),
    );
  }

  out();
  out(
    bold("When to compact") +
      dim(
        ` (ski-rental rule; price of forgetting ${usd(plan.rho)} per compaction, --rho to change)`,
      ),
  );
  indent(
    table(
      [
        ["as recorded", usd(plan.recordedUsd), `${plan.recordedCompactions} compactions`],
        ["with the rule", usd(plan.ruleUsd), `${plan.ruleCompactions.length} compactions`],
        [
          "exact optimum (hindsight)",
          usd(plan.optimumUsd),
          `${plan.optimumCompactions} compactions`,
        ],
      ],
      ["l", "r", "l"],
    ),
  );
  const n = plan.now;
  const advice =
    n.advice === "compact-now"
      ? warn(
          `  → compact now: re-reading since the last compaction (${usd(n.excessUsd)}) has passed what one compaction costs (${usd(n.thresholdUsd)})`,
        )
      : n.advice === "not-yet"
        ? `  → not yet: ${usd(n.excessUsd)} of ${usd(n.thresholdUsd)}${n.callsUntil ? `, about ${int(n.callsUntil)} more calls at this size` : ""}`
        : dim("  → the prompt is small; compaction would not pay off");
  out(advice);
  out(
    dim(
      `  Estimates: prompt after a compaction ${compact(plan.postTokens)} tokens; lost quality is priced by --rho, not measured.`,
    ),
  );
  if (htmlPath) {
    out();
    out(`HTML report: ${htmlPath} ${dim("(anonymized: no message texts, no paths, no titles)")}`);
  }
  out();
}

export function deadByLabel(l: ContextLedger) {
  const g = new Map<string, { label: string; deadUsd: number; carryUsd: number }>();
  for (const b of l.blocks) {
    if (b.always || b.type === "thinking") continue;
    const x =
      g.get(b.label) ?? g.set(b.label, { label: b.label, deadUsd: 0, carryUsd: 0 }).get(b.label);
    if (!x) continue;
    x.deadUsd += b.deadUsd;
    x.carryUsd += b.carryUsd;
  }
  return [...g.values()].filter((x) => x.deadUsd > 0).sort((a, b) => b.deadUsd - a.deadUsd);
}

function ago(ts: number): string {
  const min = Math.round((Date.now() - ts) / 60_000);
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} days ago`;
}
