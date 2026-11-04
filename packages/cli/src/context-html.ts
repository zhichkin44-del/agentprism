import { deadByLabel, idleNow, IDLE_CALLS, type ContextResult } from "./context.js";

/**
 * What the HTML report may contain: numbers, dates, model names and block kinds. No message text,
 * no file paths, no session title or id. Built separately so a test can check it.
 */
export interface PublicContextReport {
  generated: string;
  version: string;
  from: string;
  to: string;
  calls: number;
  models: string[];
  totals: {
    prompt: number;
    output: number;
    always: number;
    used: number;
    dead: number;
    thinking: number;
  };
  deadByKind: { kind: string; dead: number; carry: number }[];
  /** Down-sampled per-call series. */
  series: {
    call: number;
    always: number;
    used: number;
    dead: number;
    thinking: number;
    recorded: number;
    rule: number;
  }[];
  recordedCompactions: number[];
  ruleCompactions: number[];
  plan: {
    rho: number;
    post: number;
    recorded: number;
    rule: number;
    optimum: number;
    recordedN: number;
    ruleN: number;
    optimumN: number;
  };
  now: { ctx: number; idleTokens: number; idleUsdPerCall: number; advice: string };
}

const SAFE_KIND = /^[A-Za-z_]+(:[A-Za-z_]+)?$/;

export function publicReport(
  r: ContextResult,
  version: string,
  maxPoints = 360,
): PublicContextReport {
  const l = r.ledger;
  const n = l.calls.length;
  const step = Math.max(1, Math.ceil(n / maxPoints));
  const series: PublicContextReport["series"] = [];
  for (let i = 0; i < n; i += step) {
    // The largest prompt in each bucket, so peaks survive down-sampling.
    let j = i;
    for (let x = i; x < Math.min(n, i + step); x++)
      if ((l.calls[x]?.ctx ?? 0) > (l.calls[j]?.ctx ?? 0)) j = x;
    series.push({
      call: j,
      always: l.composition.always[j] ?? 0,
      used: l.composition.used[j] ?? 0,
      dead: l.composition.dead[j] ?? 0,
      thinking: l.composition.thinking[j] ?? 0,
      recorded: r.plan.recordedCum[j] ?? 0,
      rule: r.plan.ruleCum[j] ?? 0,
    });
  }
  const idle = idleNow(l);
  const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
  return {
    generated: day(Date.now()),
    version,
    from: day(l.calls[0]?.ts ?? 0),
    to: day(l.calls.at(-1)?.ts ?? 0),
    calls: n,
    models: [...new Set(l.calls.map((c) => c.model))],
    totals: {
      prompt: l.totals.promptUsd,
      output: l.totals.outputUsd,
      always: l.totals.alwaysUsd,
      used: l.totals.usedUsd,
      dead: l.totals.deadUsd,
      thinking: l.totals.thinkingUsd,
    },
    deadByKind: deadByLabel(l)
      .slice(0, 8)
      .map((g) => ({
        kind: SAFE_KIND.test(g.label) ? g.label : "other",
        dead: g.deadUsd,
        carry: g.carryUsd,
      })),
    series,
    recordedCompactions: l.calls.filter((c) => c.compactedBefore).map((c) => c.index),
    ruleCompactions: r.plan.ruleCompactions,
    plan: {
      rho: r.plan.rho,
      post: r.plan.postTokens,
      recorded: r.plan.recordedUsd,
      rule: r.plan.ruleUsd,
      optimum: r.plan.optimumUsd,
      recordedN: r.plan.recordedCompactions,
      ruleN: r.plan.ruleCompactions.length,
      optimumN: r.plan.optimumCompactions,
    },
    now: {
      ctx: r.plan.now.ctx,
      idleTokens: idle.tokens,
      idleUsdPerCall: idle.usdPerCall,
      advice: r.plan.now.advice,
    },
  };
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
const money = (x: number) =>
  "$" + (x >= 100 ? Math.round(x).toLocaleString("en-US") : x.toFixed(2));
const tok = (x: number) =>
  x >= 1e6
    ? (x / 1e6).toFixed(2) + "M"
    : x >= 1e3
      ? Math.round(x / 1e3) + "K"
      : String(Math.round(x));
const share = (a: number, b: number) => (b > 0 ? Math.round((100 * a) / b) + "%" : "–");

function stackedArea(d: PublicContextReport): string {
  const W = 880,
    H = 260,
    L = 48,
    B = 24,
    T = 10;
  const pts = d.series;
  const maxCall = Math.max(1, d.calls - 1);
  const maxY = Math.max(1, ...pts.map((p) => p.always + p.used + p.dead + p.thinking));
  const x = (c: number) => L + ((W - L - 8) * c) / maxCall;
  const y = (v: number) => T + (H - T - B) * (1 - v / maxY);
  const layers: [keyof PublicContextReport["series"][number], string][] = [
    ["always", "var(--c-always)"],
    ["used", "var(--c-used)"],
    ["thinking", "var(--c-thinking)"],
    ["dead", "var(--c-dead)"],
  ];
  const base = pts.map(() => 0);
  const paths = layers.map(([key, color]) => {
    const top = pts.map((p, i) => (base[i] ?? 0) + (p[key] as number));
    const up = pts.map((p, i) => `${x(p.call).toFixed(1)},${y(top[i] ?? 0).toFixed(1)}`);
    const down = pts
      .map((p, i) => `${x(p.call).toFixed(1)},${y(base[i] ?? 0).toFixed(1)}`)
      .reverse();
    top.forEach((v, i) => (base[i] = v));
    return `<polygon points="${[...up, ...down].join(" ")}" fill="${color}"/>`;
  });
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = maxY * f;
    return `<line x1="${L}" x2="${W - 8}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">${tok(v)}</text>`;
  });
  const rec = d.recordedCompactions.map(
    (c) => `<line x1="${x(c)}" x2="${x(c)}" y1="${T}" y2="${H - B}" class="mark-rec"/>`,
  );
  const rule = d.ruleCompactions.map(
    (c) => `<path d="M${x(c) - 4},${H - B + 10} l4,-7 l4,7 z" class="mark-rule"/>`,
  );
  return `<svg viewBox="0 0 ${W} ${H + 8}" role="img" aria-label="Prompt size per call, by status">${ticks.join("")}${paths.join("")}${rec.join("")}${rule.join("")}<text x="${W - 8}" y="${H + 6}" class="axis" text-anchor="end">model calls →</text></svg>`;
}

function costLines(d: PublicContextReport): string {
  const W = 880,
    H = 200,
    L = 48,
    B = 24,
    T = 10;
  const pts = d.series;
  const maxCall = Math.max(1, d.calls - 1);
  const maxY = Math.max(1, ...pts.map((p) => Math.max(p.recorded, p.rule)));
  const x = (c: number) => L + ((W - L - 8) * c) / maxCall;
  const y = (v: number) => T + (H - T - B) * (1 - v / maxY);
  const line = (key: "recorded" | "rule", cls: string) =>
    `<polyline points="${pts.map((p) => `${x(p.call).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ")}" class="${cls}"/>`;
  const ticks = [0, 0.5, 1].map(
    (f) =>
      `<line x1="${L}" x2="${W - 8}" y1="${y(maxY * f)}" y2="${y(maxY * f)}" class="grid"/><text x="${L - 6}" y="${y(maxY * f) + 4}" class="axis" text-anchor="end">${money(maxY * f)}</text>`,
  );
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative cost as recorded and with the rule">${ticks.join("")}${line("recorded", "l-rec")}${line("rule", "l-rule")}</svg>`;
}

export function renderContextHtml(d: PublicContextReport): string {
  const t = d.totals;
  const adviceText =
    d.now.advice === "compact-now"
      ? "Compact now: re-reading has passed the cost of one compaction."
      : d.now.advice === "not-yet"
        ? "Not yet: a compaction would not pay off yet."
        : "The prompt is small; compaction would not pay off.";
  const rows = d.deadByKind
    .map(
      (g) =>
        `<tr><td>${esc(g.kind)}</td><td class="num">${money(g.dead)}</td><td class="num">${share(g.dead, g.carry)}</td></tr>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Context economics</title>
<style>
:root{--bg:#fbfaf8;--fg:#1d1b18;--muted:#6b665e;--line:#e4e0d8;--card:#ffffff;
--c-always:#b9b3a8;--c-used:#3d7bd9;--c-thinking:#9a7fd1;--c-dead:#e0703a;--c-rule:#1f9e74}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151412;--fg:#ece8e1;--muted:#a19b91;--line:#2c2a26;--card:#1d1c19;
--c-always:#5d5850;--c-used:#5b95ea;--c-thinking:#a993dd;--c-dead:#ef8a55;--c-rule:#38c08f}}
:root[data-theme="dark"]{--bg:#151412;--fg:#ece8e1;--muted:#a19b91;--line:#2c2a26;--card:#1d1c19;
--c-always:#5d5850;--c-used:#5b95ea;--c-thinking:#a993dd;--c-dead:#ef8a55;--c-rule:#38c08f}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:940px;margin:0 auto;padding:32px 16px 48px}
h1{font-size:26px;margin:0 0 4px;letter-spacing:-.01em}h2{font-size:17px;margin:32px 0 8px}
.sub{color:var(--muted);margin:0 0 24px}.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
.kpi b{display:block;font-size:22px;font-variant-numeric:tabular-nums}.kpi span{color:var(--muted);font-size:13px}
svg{width:100%;height:auto;display:block}.grid{stroke:var(--line)}.axis{fill:var(--muted);font-size:11px}
.mark-rec{stroke:var(--fg);stroke-dasharray:3 3;opacity:.5}.mark-rule{fill:var(--c-rule)}
.l-rec{fill:none;stroke:var(--fg);stroke-width:2;opacity:.7}.l-rule{fill:none;stroke:var(--c-rule);stroke-width:2}
.legend{display:flex;flex-wrap:wrap;gap:14px;color:var(--muted);font-size:13px;margin:6px 0}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
table{border-collapse:collapse;width:100%}td,th{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left}.num{text-align:right;font-variant-numeric:tabular-nums}
.note{color:var(--muted);font-size:13px}.advice{background:var(--card);border-left:3px solid var(--c-rule);padding:10px 14px;border-radius:6px}
</style>
</head>
<body><main>
<h1>Context economics</h1>
<p class="sub">One coding-agent session, ${esc(d.from)} → ${esc(d.to)} · ${d.calls.toLocaleString("en-US")} model calls · ${d.models.map(esc).join(", ")}. Costs are API-equivalent estimates at list prices. Generated by AgentPrism ${esc(d.version)} on ${esc(d.generated)}; anonymized: no messages, paths or titles.</p>
<div class="kpis">
<div class="kpi"><b>${share(t.prompt, t.prompt + t.output)}</b><span>of the cost is re-reading the prompt (${money(t.prompt)})</span></div>
<div class="kpi"><b>${money(t.dead)}</b><span>carried after its last use (${share(t.dead, t.prompt)} of prompt cost, upper bound)</span></div>
<div class="kpi"><b>${money(d.plan.recorded - d.plan.rule)}</b><span>saved by the compaction rule at ${money(d.plan.rho)} per compaction</span></div>
<div class="kpi"><b>${(d.plan.rule / Math.max(d.plan.optimum, 1e-9)).toFixed(2)}×</b><span>rule cost vs the exact optimum in hindsight</span></div>
</div>
<h2>What the prompt is made of, call by call</h2>
<div class="legend"><span><i style="background:var(--c-always)"></i>always needed</span><span><i style="background:var(--c-used)"></i>content in use</span><span><i style="background:var(--c-thinking)"></i>earlier thinking</span><span><i style="background:var(--c-dead)"></i>after its last use</span><span>┆ compaction as recorded</span><span><i style="background:var(--c-rule)"></i>compaction by the rule</span></div>
${stackedArea(d)}
<h2>Cumulative cost: as recorded vs the ski-rental rule</h2>
<div class="legend"><span><i style="background:var(--fg);opacity:.7"></i>as recorded (${money(d.plan.recorded)}, ${d.plan.recordedN} compactions)</span><span><i style="background:var(--c-rule)"></i>with the rule (${money(d.plan.rule)}, ${d.plan.ruleN} compactions)</span><span>exact optimum ${money(d.plan.optimum)}, ${d.plan.optimumN} compactions</span></div>
${costLines(d)}
<h2>Where the dead weight is</h2>
<table><thead><tr><th>Kind of content</th><th class="num">After last use</th><th class="num">Share of its carrying</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Now</h2>
<p class="advice">Prompt ${tok(d.now.ctx)} tokens; ${tok(d.now.idleTokens)} of them unused for ${IDLE_CALLS}+ calls, costing ${money(d.now.idleUsdPerCall)} per call. ${adviceText}</p>
<h2>How this is measured</h2>
<p class="note">The prompt cost of every call is exact. It is split between blocks of content by the measured growth of the prompt (a fit that explains 97% of the growth on real logs). A block is "in use" while later outputs share its rare identifiers or work on its file; on known uses this finds 98%. Use by meaning without a shared identifier is invisible, so the dead share is an upper bound. The rule compacts when the excess re-reading reaches the cost of one compaction: reading, summary, re-writing the new prefix, plus a price of forgetting (here ${money(d.plan.rho)}) that is chosen, not measured. Prompt after a compaction: ${tok(d.plan.post)} tokens. Advisory: AgentPrism changes nothing.</p>
</main></body></html>
`;
}
