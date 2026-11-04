import type { Comparison, EffectEstimate, PeriodMetrics, Switchback } from "@agentprism/core";
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

export function printCompare(c: Comparison, effect?: EffectEstimate): void {
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
  out(
    dim(
      "  Descriptive only: per-session medians move with the mix of sessions (docs/RESEARCH.md, R3).",
    ),
  );
  if (effect) {
    out();
    printEffect(effect, ["before", "after"]);
  }
  out(dim("  Costs are API-equivalent estimates."));
  out();
}

const signed = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(0)}%`;

/** The adjusted estimate: the part of a comparison that can be trusted (docs/RESEARCH.md, R3). */
export function printEffect(e: EffectEstimate, sides: [string, string]): void {
  out(
    bold("Effect on cost per prompt") +
      dim("  adjusted for prompt size, model, origin, project and trend"),
  );
  if (e.verdict === "not-enough-data") {
    out(warn(`  → not enough data yet: ${e.reasons.join("; ")}`));
    out(
      dim(
        `  ${e.days.control} days / ${int(e.turns.control)} prompts ${sides[0]} · ${e.days.changed} days / ${int(e.turns.changed)} prompts ${sides[1]}`,
      ),
    );
    return;
  }
  out(
    `  ${bold(signed(e.effect))}  ${dim("95% interval")} ${signed(e.interval[0])} … ${signed(e.interval[1])}   ${dim("p =")} ${e.p.toFixed(2)}   ${dim("noise floor")} ±${(100 * e.noiseFloor).toFixed(0)}%`,
  );
  if (e.verdict === "cheaper")
    out(paint("green", "  → cheaper, beyond chance and this history's own noise"));
  else if (e.verdict === "costlier")
    out(paint("red", "  → costlier, beyond chance and this history's own noise"));
  else out(warn(`  → no clear change: ${e.reasons.join("; ")}`));
  out(
    dim(
      `  ${e.days.control} days / ${int(e.turns.control)} prompts ${sides[0]} · ${e.days.changed} days / ${int(e.turns.changed)} prompts ${sides[1]}`,
    ),
  );
}

export function printSwitchbackPlan(name: string, s: Switchback): void {
  const fmt = (d: string) => {
    const day = new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" });
    return `${d.slice(5)} ${day}`;
  };
  out();
  out(
    `${bold(`Switchback "${name}"`)} ${dim(`${s.on.length + s.off.length} days from ${s.start}, decided at random in advance`)}`,
  );
  out(`  ${paint("green", "ON ")}  ${s.on.map(fmt).join(" · ")}`);
  out(`  ${dim("OFF")}  ${s.off.map(fmt).join(" · ")}`);
  out();
  out(
    "  Work with the change on the ON days only and as before on the OFF days. Alternating at random",
  );
  out(
    "  cancels the drift that makes a plain before/after unreliable. Start a fresh session when the",
  );
  out("  day switches: a session that runs on into the next day still carries the old setting.");
  out(dim(`  When the days are over: agentprism compare --split "${name}"`));
  out();
}

export function printSwitchbackResult(name: string, s: Switchback, e: EffectEstimate): void {
  out();
  out(`${bold(`Switchback "${name}"`)} ${dim(`ON vs OFF days from ${s.start}`)}`);
  printEffect(e, ["OFF", "ON"]);
  out();
}
