import { callParts, priceFor, type PriceTable } from "../pricing/prices.js";
import type { LedgerCall } from "./ledger.js";

/**
 * When to compact: the ski-rental rule, priced with the real cache bill. Method and evidence:
 * docs/RESEARCH.md (R2). After each call, the context beyond what a compaction would leave (P) adds
 * its cache-read cost to a running "excess". Once the excess reaches the cost of one compaction
 * (read the context once, write a summary, re-write P instead of reading it, plus the price of
 * forgetting ρ), compact. On real sessions this stayed within 4–16% of the exact optimum for any ρ.
 * Advisory only: nothing here changes a setting.
 */
export interface AdvisorOptions {
  /** Price of forgetting per compaction, USD: rework and lost quality. Default $0.50. */
  rho?: number;
  /** Prompt tokens right after a compaction. Default: this session's median, else 96K. */
  postTokens?: number;
  /** Output tokens of a summary. Default 20K (observed 17–26K). */
  summaryTokens?: number;
}

export interface CompactionPlan {
  rho: number;
  postTokens: number;
  recordedUsd: number;
  ruleUsd: number;
  optimumUsd: number;
  recordedCompactions: number;
  /** Calls before which the rule would have compacted. */
  ruleCompactions: number[];
  optimumCompactions: number;
  /** Cumulative cost per call: as recorded and under the rule. */
  recordedCum: number[];
  ruleCum: number[];
  now: {
    ctx: number;
    /** Excess re-reading since the last real compaction, and what one compaction costs now. */
    excessUsd: number;
    thresholdUsd: number;
    advice: "compact-now" | "not-yet" | "too-small";
    /** At the current growth, calls until the rule says compact (not-yet only). */
    callsUntil?: number;
  };
}

export const DEFAULT_POST_COMPACTION_TOKENS = 96_000;

export function compactionPlan(
  calls: LedgerCall[],
  prices: PriceTable,
  options: AdvisorOptions = {},
): CompactionPlan {
  const rho = options.rho ?? 0.5;
  const summary = options.summaryTokens ?? 20_000;
  const after = calls
    .filter((c) => c.compactedBefore)
    .map((c) => c.ctx)
    .sort((a, b) => a - b);
  const P =
    options.postTokens ?? after[Math.floor(after.length / 2)] ?? DEFAULT_POST_COMPACTION_TOKENS;

  const rate = (c: LedgerCall) => {
    const p = priceFor(prices, c.model);
    return p
      ? { read: p.cacheRead, write: p.cacheWrite1h, out: p.output }
      : { read: 0, write: 0, out: 0 };
  };
  // Cost of a call with R tokens removed from its prompt: fewer cache reads first, then writes.
  const costWith = (c: LedgerCall, R: number) => {
    let cut = R;
    const take = (x: number) => {
      const d = Math.min(x, cut);
      cut -= d;
      return x - d;
    };
    const u = c.usage;
    const cacheRead = take(u.cacheReadTokens);
    const cacheWrite1h = take(u.cacheWrite1hTokens);
    const cacheWrite5m = take(u.cacheWrite5mTokens);
    const p = callParts(priceFor(prices, c.model), {
      input: u.inputTokens,
      output: u.outputTokens,
      cacheRead,
      cacheWrite5m,
      cacheWrite1h,
    });
    return p.input + p.output + p.cacheRead + p.cacheWrite;
  };
  const compactCost = (c: LedgerCall, ctx: number) => {
    const r = rate(c);
    return (ctx * r.read + summary * r.out + P * (r.write - r.read)) / 1e6 + rho;
  };

  // Segments between real compactions are independent.
  const segments: LedgerCall[][] = [];
  for (const c of calls) {
    if (c.compactedBefore || !segments.length) segments.push([]);
    segments.at(-1)?.push(c);
  }

  let recordedUsd = 0,
    ruleUsd = 0,
    optimumUsd = 0,
    optimumCompactions = 0;
  const ruleCompactions: number[] = [];
  const recordedCum: number[] = [];
  const ruleCum: number[] = [];
  for (const seg of segments) {
    // Online rule.
    let R = 0,
      excess = 0;
    for (let j = 0; j < seg.length; j++) {
      const c = seg[j] as LedgerCall;
      recordedUsd += costWith(c, 0);
      ruleUsd += costWith(c, R);
      const ctx = c.ctx - R;
      excess += (Math.max(0, ctx - P) * rate(c).read) / 1e6;
      if (j + 1 < seg.length && ctx > 1.5 * P && excess >= compactCost(c, ctx)) {
        ruleUsd += compactCost(c, ctx);
        ruleCompactions.push(c.index + 1);
        R = c.ctx - P;
        excess = 0;
      }
      recordedCum.push(recordedUsd);
      ruleCum.push(ruleUsd);
    }
    // Exact offline optimum: f[m] = cheapest cost of the calls before m with a compaction at m.
    const n = seg.length;
    const f = new Float64Array(n + 1).fill(Infinity);
    const count = new Int32Array(n + 1);
    f[0] = 0;
    let best = Infinity,
      bestCount = 0;
    for (let k = 0; k < n; k++) {
      const fk = f[k] ?? Infinity;
      if (!Number.isFinite(fk)) continue;
      const Rk = k === 0 ? 0 : Math.max(0, (seg[k - 1] as LedgerCall).ctx - P);
      let acc = fk;
      for (let j = k; j < n; j++) {
        const c = seg[j] as LedgerCall;
        acc += costWith(c, Rk);
        if (j + 1 < n && c.ctx - Rk > 1.5 * P) {
          const v = acc + compactCost(c, c.ctx - Rk);
          if (v < (f[j + 1] ?? Infinity)) {
            f[j + 1] = v;
            count[j + 1] = (count[k] ?? 0) + 1;
          }
        }
      }
      if (acc < best) {
        best = acc;
        bestCount = count[k] ?? 0;
      }
    }
    optimumUsd += best;
    optimumCompactions += bestCount;
  }

  // Now: the real trajectory since the last real compaction.
  const last = calls.at(-1);
  const current = segments.at(-1) ?? [];
  let excess = 0;
  for (const c of current) excess += (Math.max(0, c.ctx - P) * rate(c).read) / 1e6;
  const now: CompactionPlan["now"] = {
    ctx: last?.ctx ?? 0,
    excessUsd: excess,
    thresholdUsd: 0,
    advice: "too-small",
  };
  if (last) {
    now.thresholdUsd = compactCost(last, last.ctx);
    if (last.ctx <= 1.5 * P) now.advice = "too-small";
    else if (excess >= now.thresholdUsd) now.advice = "compact-now";
    else {
      now.advice = "not-yet";
      const perCall = (Math.max(0, last.ctx - P) * rate(last).read) / 1e6;
      if (perCall > 0) now.callsUntil = Math.ceil((now.thresholdUsd - excess) / perCall);
    }
  }

  return {
    rho,
    postTokens: P,
    recordedUsd,
    ruleUsd,
    optimumUsd,
    recordedCompactions: calls.filter((c) => c.compactedBefore).length,
    ruleCompactions,
    optimumCompactions,
    recordedCum,
    ruleCum,
    now,
  };
}
