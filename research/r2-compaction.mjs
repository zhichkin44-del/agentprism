// R2: offline-optimal compaction schedule vs simple online rules, priced with the real cache bill.
//
// Part A measures what a compaction costs besides the summary: the rework after it. Rework is
// re-reading a file, or re-running a Bash command, that the agent already had before the compaction.
// It is measured as a rate per call in a window after each real compaction, minus the same rate in an
// equal window before it (agents re-read files without compactions too).
//
// Part B replays each session's main chain. A compaction before call m (run while the cache is warm,
// right after call m-1) costs: reading the old context once, writing the summary, re-writing the new
// prefix P instead of reading it, and the measured rework. After it, every later call carries
// (old context - P) fewer tokens, taken first from cache reads, then from writes (rebuilds after a
// break shrink too). Real compactions stay where they were (the simulation restarts at each). The
// offline optimum is exact dynamic programming over compaction points; online rules see only the past.
// Prints aggregates only.
import { loadSessions, PRICES } from "./lib.mjs";

const WINDOW = 60; // calls before / after a compaction for the rework rates
const SUMMARY_OUT = 20_000; // tokens written by a summary (observed postTokens: 17-26K)

const sessions = [...loadSessions().values()];

// ---------- Part A: rework after real compactions ---------------------------------------------
function callsAndTools(events) {
  const calls = [];
  const tools = []; // { at, key }
  const idx = new Map();
  const compactBefore = new Set();
  let pendingCompact = false;
  for (const e of events) {
    if (e.t === "compact") pendingCompact = true;
    else if (e.t === "call") {
      const prev = calls[calls.length - 1];
      if (pendingCompact || (prev && prev.ctx > 100_000 && e.ctx < prev.ctx * 0.5))
        compactBefore.add(calls.length);
      pendingCompact = false;
      idx.set(e.id, calls.length);
      calls.push(e);
    } else if (e.t === "block" && e.kind === "tool_use" && idx.has(e.by)) {
      const key =
        e.tool === "Read" && e.target
          ? `read:${e.target}`
          : e.tool === "Bash"
            ? `bash:${e.text}`
            : null;
      if (key) tools.push({ at: idx.get(e.by), key });
    }
  }
  return { calls, tools, compactBefore };
}

let repeatsAfter = 0,
  repeatsBefore = 0,
  callsAfter = 0,
  callsBefore = 0,
  reworkUsd = 0,
  compactions = 0;
const postCtx = [];
for (const events of sessions) {
  const { calls, tools, compactBefore } = callsAndTools(events);
  for (const m of compactBefore) {
    if (m < WINDOW * 2 || m + WINDOW > calls.length) continue; // need full windows
    compactions++;
    postCtx.push(calls[m].ctx);
    const segStart = Math.max(...[...compactBefore].filter((x) => x < m), 0);
    const seenBefore = new Set(
      tools.filter((t) => t.at >= segStart && t.at < m - WINDOW).map((t) => t.key),
    );
    const seenOld = new Set(tools.filter((t) => t.at >= segStart && t.at < m).map((t) => t.key));
    // Before: repeats in [m-W, m) of things seen earlier in the segment. After: repeats in [m, m+W).
    for (const t of tools) {
      if (t.at >= m - WINDOW && t.at < m && seenBefore.has(t.key)) repeatsBefore++;
      if (t.at >= m && t.at < m + WINDOW && seenOld.has(t.key)) {
        repeatsAfter++;
        const c = calls[t.at];
        reworkUsd += c.ctxUsd + c.outUsd;
      }
    }
    callsBefore += WINDOW;
    callsAfter += WINDOW;
  }
}
const excessRate = Math.max(0, repeatsAfter / callsAfter - repeatsBefore / callsBefore);
const avgReworkCallUsd = repeatsAfter ? reworkUsd / repeatsAfter : 0;
const RHO = excessRate * WINDOW * avgReworkCallUsd; // $ of rework per compaction
postCtx.sort((a, b) => a - b);
const P = postCtx[Math.floor(postCtx.length / 2)] ?? 60_000;
console.log(`A. real compactions with full windows: ${compactions}`);
console.log(
  `   repeats of earlier reads/commands per call: before ${(repeatsBefore / callsBefore).toFixed(3)}, after ${(repeatsAfter / callsAfter).toFixed(3)}`,
);
console.log(
  `   rework per compaction ≈ ${(excessRate * WINDOW).toFixed(1)} extra calls × $${avgReworkCallUsd.toFixed(2)} = $${RHO.toFixed(2)}`,
);
console.log(`   prompt size on the first call after a compaction: median ${Math.round(P / 1000)}K`);

// ---------- Part B: replay ------------------------------------------------------------------
const price = (c) => PRICES[c.model];
function callCost(c, R) {
  const u = c.usage,
    p = price(c);
  let cut = R;
  const take = (x) => {
    const d = Math.min(x, cut);
    cut -= d;
    return x - d;
  };
  const cr = take(u.cr),
    w1 = take(u.w1),
    w5 = take(u.w5);
  return (u.in * p[0] + u.out * p[1] + cr * p[2] + w5 * p[3] + w1 * p[4]) / 1e6;
}
// Compaction right after call m-1: read its context once, write the summary, re-write P, rework.
const compactCost = (prev, rho) => {
  const p = price(prev);
  return (prev.ctx * p[2] + SUMMARY_OUT * p[1] + P * (p[4] - p[2])) / 1e6 + rho;
};

function segments(events) {
  const { calls, compactBefore } = callsAndTools(events);
  const segs = [];
  let cur = [];
  calls.forEach((c, i) => {
    if (compactBefore.has(i) && cur.length) {
      segs.push(cur);
      cur = [];
    }
    cur.push(c);
  });
  if (cur.length) segs.push(cur);
  return segs;
}

/** Exact offline optimum for one segment: f[m] = cheapest cost of calls before m with a compaction at m. */
function optimum(seg, rho) {
  const n = seg.length;
  const f = new Float64Array(n + 1).fill(Infinity);
  f[0] = 0;
  let best = Infinity,
    count = new Int32Array(n + 1),
    bestCount = 0;
  for (let k = 0; k < n; k++) {
    if (!Number.isFinite(f[k])) continue;
    const R = k === 0 ? 0 : Math.max(0, seg[k - 1].ctx - P);
    let acc = f[k];
    for (let j = k; j < n; j++) {
      acc += callCost(seg[j], R);
      const m = j + 1;
      if (m < n && seg[j].ctx > P * 1.5) {
        const v = acc + compactCost(seg[j], rho);
        if (v < f[m]) {
          f[m] = v;
          count[m] = count[k] + 1;
        }
      }
    }
    if (acc < best) {
      best = acc;
      bestCount = count[k];
    }
  }
  return { usd: best, compactions: bestCount };
}

/** Online rule: walks forward, decides after each call whether to compact before the next. */
function online(seg, rho, decide) {
  let usd = 0,
    R = 0,
    excess = 0,
    n = 0;
  for (let j = 0; j < seg.length; j++) {
    const c = seg[j];
    usd += callCost(c, R);
    const ctx = c.ctx - R;
    excess += (Math.max(0, ctx - P) * price(c)[2]) / 1e6;
    const next = seg[j + 1];
    if (
      next &&
      ctx > P * 1.5 &&
      decide({ ctx, excess, gapMin: (next.ts - c.ts) / 60000, cost: compactCost(c, rho), rho })
    ) {
      usd += compactCost({ ...c, ctx }, rho);
      R = c.ctx - P;
      excess = 0;
      n++;
    }
  }
  return { usd, compactions: n };
}

const rules = {
  "never (as recorded)": () => false,
  "threshold 200K": (s) => s.ctx > 200_000,
  "threshold 400K": (s) => s.ctx > 400_000,
  "ski-rental (excess reads ≥ compaction cost)": (s) => s.excess >= s.cost,
  "ski-rental that assumes rework is free": (s) => s.excess >= s.cost - s.rho,
  "ski-rental + compact before a break > 55 min": (s) =>
    s.excess >= s.cost || (s.gapMin > 55 && s.ctx > 2 * P),
};

// Measured rework is ~0 (few compactions, and it sees only re-reads, not lost quality), so sweep it.
for (const rho of [RHO, 0.5, 2, 5, 10, 20]) {
  let opt = 0,
    optN = 0;
  const tot = Object.fromEntries(Object.keys(rules).map((k) => [k, { usd: 0, n: 0, worst: 1 }]));
  for (const events of sessions) {
    for (const seg of segments(events)) {
      const o = optimum(seg, rho);
      opt += o.usd;
      optN += o.compactions;
      for (const [name, rule] of Object.entries(rules)) {
        const r = online(seg, rho, rule);
        tot[name].usd += r.usd;
        tot[name].n += r.compactions;
        if (o.usd > 1) tot[name].worst = Math.max(tot[name].worst, r.usd / o.usd);
      }
    }
  }
  console.log(`\nB. rework $${rho.toFixed(2)} per compaction, P = ${Math.round(P / 1000)}K`);
  console.log(
    `   offline optimum                                   $${opt.toFixed(0).padStart(4)}  compactions ${optN}`,
  );
  for (const [name, t] of Object.entries(tot)) {
    console.log(
      `   ${name.padEnd(48)}  $${t.usd.toFixed(0).padStart(4)}  compactions ${String(t.n).padStart(3)}  ratio ${(t.usd / opt).toFixed(2)}  worst segment ${t.worst.toFixed(2)}`,
    );
  }
}
