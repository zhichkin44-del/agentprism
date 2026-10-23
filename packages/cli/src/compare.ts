import type { Comparison, PeriodMetrics } from "@agentprism/core";
import { bold, compact, date, dim, int, paint, table, usd, warn } from "./format.js";

const out = (line = "") => process.stdout.write(line + "\n");
const MIN_SESSIONS = 5;

type Row = [label: string, pick: (m: PeriodMetrics) => number, format: (n: number) => string];

const percent = (n: number) => `${(n * 100).toFixed(1)}%`;

/** Lower is better for every metric shown, so a drop is green. */
function change(before: number, after: number): string {
  if (!before) return dim("–");
  const delta = (after - before) / before;
  const text = `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(0)}%`;
  if (Math.abs(delta) < 0.05) return dim(text);
  return delta < 0 ? paint("green", text) : paint("red", text);
}

export function printCompare(c: Comparison): void {
  const rows: Row[] = [
    ["spend per active day", (m) => m.usdPerActiveDay, usd],
    ["median $ per session", (m) => m.medianUsdPerSession, usd],
    ["median $ per prompt", (m) => m.medianUsdPerPrompt, usd],
    ["median model calls per prompt", (m) => m.medianCallsPerPrompt, (n) => n.toFixed(1)],
    ["median context per call", (m) => m.medianAvgContext, (n) => `${compact(n)} tok`],
    ["tool error rate", (m) => m.toolErrorRate, percent],
    ["estimated waste share", (m) => m.wasteShare, percent],
  ];

  out();
  out(`${bold("Before vs after")}  "${c.splitLabel}" ${dim(`(${date(c.splitAt)})`)}`);
  const lines = table(
    [
      [dim("metric"), dim("before"), dim("after"), dim("change")],
      [
        "sessions · prompts",
        `${int(c.before.sessions)} · ${int(c.before.prompts)}`,
        `${int(c.after.sessions)} · ${int(c.after.prompts)}`,
        "",
      ],
      ["total spend", usd(c.before.usd), usd(c.after.usd), ""],
      ...rows.map(([label, pick, format]) => [
        label,
        format(pick(c.before)),
        format(pick(c.after)),
        change(pick(c.before), pick(c.after)),
      ]),
    ],
    ["l", "r", "r", "r"],
  );
  for (const l of lines) out("  " + l);
  if (c.after.sessions < MIN_SESSIONS || c.before.sessions < MIN_SESSIONS) {
    out();
    out(
      warn(
        `  Fewer than ${MIN_SESSIONS} sessions on one side — treat the change as a hint, not a result.`,
      ),
    );
  }
  out(dim("  Medians are per session. Costs are API-equivalent estimates."));
  out();
}
