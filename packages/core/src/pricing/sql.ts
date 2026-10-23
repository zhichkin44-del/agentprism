import type { DatabaseSync } from "node:sqlite";
import { callCost, callParts, priceFor, type ModelPrice, type PriceTable } from "./prices.js";

/** Column list matching `ap_cost(...)`, for use in queries over `api_calls`. */
export const COST_ARGS =
  "model, input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens";

/** SQL expression: USD cost of an `api_calls` row (optionally table-qualified). */
export const costOf = (alias = "") => {
  const a = alias ? `${alias}.` : "";
  return `ap_cost(${COST_ARGS.split(", ")
    .map((c) => a + c)
    .join(", ")})`;
};

/**
 * Registers `ap_cost(...)` and `ap_known_model(model)` on the connection, so any query can
 * aggregate money directly: `SELECT SUM(ap_cost(model, ...)) FROM api_calls`.
 */
export function installPricing(db: DatabaseSync, table: PriceTable): void {
  const cache = new Map<string, ModelPrice | undefined>();
  const lookup = (model: string) => {
    if (!cache.has(model)) cache.set(model, priceFor(table, model));
    return cache.get(model);
  };
  const n = (x: unknown) => (typeof x === "number" ? x : Number(x ?? 0));

  db.function(
    "ap_cost",
    { deterministic: true },
    (model, input, output, cacheRead, cacheWrite5m, cacheWrite1h) =>
      callCost(lookup(String(model)), {
        input: n(input),
        output: n(output),
        cacheRead: n(cacheRead),
        cacheWrite5m: n(cacheWrite5m),
        cacheWrite1h: n(cacheWrite1h),
      }),
  );
  // One component of a call's cost ("input", "output", "cache_read", "cache_write").
  // callParts prices every part at the tier of the whole prompt, so parts add up to ap_cost.
  db.function(
    "ap_cost_part",
    { deterministic: true },
    (part, model, input, output, cacheRead, cacheWrite5m, cacheWrite1h) => {
      const parts = callParts(lookup(String(model)), {
        input: n(input),
        output: n(output),
        cacheRead: n(cacheRead),
        cacheWrite5m: n(cacheWrite5m),
        cacheWrite1h: n(cacheWrite1h),
      });
      switch (String(part)) {
        case "input":
          return parts.input;
        case "output":
          return parts.output;
        case "cache_read":
          return parts.cacheRead;
        case "cache_write":
          return parts.cacheWrite;
        default:
          return 0;
      }
    },
  );
  db.function("ap_known_model", { deterministic: true }, (model) =>
    lookup(String(model)) ? 1 : 0,
  );
  // Per-million price of one token kind: input, output, cache_read, cache_write_5m, cache_write_1h.
  db.function("ap_price", { deterministic: true }, (model, kind) => {
    const p = lookup(String(model));
    if (!p) return 0;
    switch (String(kind)) {
      case "input":
        return p.input;
      case "output":
        return p.output;
      case "cache_read":
        return p.cacheRead;
      case "cache_write_5m":
        return p.cacheWrite5m;
      case "cache_write_1h":
        return p.cacheWrite1h;
      default:
        return 0;
    }
  });
  db.function("ap_cache_read_price", { deterministic: true }, (model) => {
    return lookup(String(model))?.cacheRead ?? 0;
  });
}
