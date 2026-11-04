import { callParts, priceFor, type ModelPrice } from "../pricing/prices.js";
import type { Store } from "../store/store.js";

/** Our price table against the cost the agent itself reported for the same tokens. */
export interface PriceCheck {
  model: string;
  records: number;
  reportedUsd: number;
  /** Our cost of the reported tokens: cache writes at the 5-minute rate, base tier. */
  lowUsd: number;
  /** Cache writes at the 1-hour rate, and the long-prompt tier where the model has one. */
  highUsd: number;
  /** "ok": the reported cost lies within [low, high] ± tolerance; "unknown": no price for the model. */
  status: "ok" | "mismatch" | "unknown";
}

/** Relative slack around [low, high]: rounding and per-call tier switches. */
const TOLERANCE = 0.03;
/** Below this, rounding dominates and a mismatch means nothing. */
const MIN_REPORTED_USD = 0.5;

const cost = (price: ModelPrice, r: Row, writeTtl: "5m" | "1h") => {
  const p = callParts(price, {
    input: r.input,
    output: r.output,
    cacheRead: r.cacheRead,
    cacheWrite5m: writeTtl === "5m" ? r.cacheWrite : 0,
    cacheWrite1h: writeTtl === "1h" ? r.cacheWrite : 0,
  });
  return p.input + p.output + p.cacheRead + p.cacheWrite;
};

interface Row {
  model: string;
  records: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reported: number;
}

/**
 * Prices the tokens the agent reported (Claude Code's cost-state) with our table and compares
 * the result with the agent's own cost. Tokens and cost come from the same record, so a
 * mismatch means a wrong price, not missing data. See docs/METRICS.md.
 */
export function priceCheck(store: Store): PriceCheck[] {
  const rows = store.db
    .prepare(
      `SELECT model, COUNT(*) AS records, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
         SUM(cache_read_tokens) AS cacheRead, SUM(cache_write_tokens) AS cacheWrite,
         SUM(cost_usd) AS reported
       FROM reported_usage GROUP BY model HAVING SUM(cost_usd) >= ? ORDER BY reported DESC`,
    )
    .all(MIN_REPORTED_USD) as unknown as Row[];

  return rows.map((r) => {
    const price = priceFor(store.prices, r.model);
    if (!price) {
      return {
        model: r.model,
        records: r.records,
        reportedUsd: r.reported,
        lowUsd: 0,
        highUsd: 0,
        status: "unknown",
      };
    }
    // Summed tokens would always land in the long-prompt tier, so price each bound at one tier.
    const { longContext, ...base } = price;
    const lowUsd = cost(base, r, "5m");
    const highUsd = cost(longContext?.price ?? base, r, "1h");
    const ok = r.reported >= lowUsd * (1 - TOLERANCE) && r.reported <= highUsd * (1 + TOLERANCE);
    return {
      model: r.model,
      records: r.records,
      reportedUsd: r.reported,
      lowUsd,
      highUsd,
      status: ok ? "ok" : "mismatch",
    };
  });
}
