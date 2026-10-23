import { priceFor, type ModelPrice } from "../pricing/prices.js";
import { costOf } from "../pricing/sql.js";
import type { Severity } from "../plugin.js";
import type { Store } from "../store/store.js";

export interface CallCost {
  usd: number;
  tokens: number;
  model: string;
}

const callCostCache = new WeakMap<Store, Map<string, CallCost>>();

/** Cost of every API call by id, computed once per store. */
export function callCosts(store: Store): Map<string, CallCost> {
  let map = callCostCache.get(store);
  if (!map) {
    map = new Map();
    const rows = store.db
      .prepare(
        `SELECT id, model, ${costOf()} AS usd,
           input_tokens + output_tokens + cache_read_tokens
             + cache_write_5m_tokens + cache_write_1h_tokens AS tokens
         FROM api_calls`,
      )
      .all() as { id: string; model: string; usd: number; tokens: number }[];
    for (const r of rows) map.set(r.id, { usd: r.usd, tokens: r.tokens, model: r.model });
    callCostCache.set(store, map);
  }
  return map;
}

/** Forget cached costs, e.g. after a re-scan. */
export function invalidateCallCosts(store: Store): void {
  callCostCache.delete(store);
}

/** Sum of tokens and USD over distinct call ids. */
export function sumCalls(store: Store, callIds: Iterable<string>): { tokens: number; usd: number } {
  const costs = callCosts(store);
  let tokens = 0;
  let usd = 0;
  for (const id of new Set(callIds)) {
    const c = costs.get(id);
    if (c) {
      tokens += c.tokens;
      usd += c.usd;
    }
  }
  return { tokens, usd };
}

/** Price of the model that made most calls in a session. */
export function sessionPrice(store: Store, sessionId: string): ModelPrice | undefined {
  const row = store.db
    .prepare(
      `SELECT model FROM api_calls WHERE session_id = ?
       GROUP BY model ORDER BY COUNT(*) DESC LIMIT 1`,
    )
    .get(sessionId) as { model: string } | undefined;
  return row ? priceFor(store.prices, row.model) : undefined;
}

/**
 * Tokens in a tool result, estimated from its JSON size (~4 characters per token).
 * Good enough for ranking; exact counts would need the model's tokenizer.
 */
export const approxTokens = (chars: number): number => Math.round(chars / 4);

/** Typical tokens per image after the API's downscaling (~1.15 megapixels / 750). */
export const IMAGE_TOKENS = 1_600;

/** Estimated tokens of a tool result: text plus images. */
export const resultTokens = (chars: number, images: number): number =>
  approxTokens(chars) + images * IMAGE_TOKENS;

/** Keeps the informative end of long paths: "…/src/audio/mixer.py". */
export function shortPath(target: string | null | undefined, max = 60): string {
  const t = (target ?? "").trim();
  if (t.length <= max || !/[\\/]/.test(t)) return shorten(t, max);
  const parts = t.split(/[\\/]+/);
  let tail = parts.pop() ?? "";
  while (parts.length && tail.length + (parts.at(-1)?.length ?? 0) + 2 < max) {
    tail = `${parts.pop()}/${tail}`;
  }
  return `…/${tail}`;
}

export function severityFor(usd: number): Severity {
  if (usd >= 1) return "high";
  if (usd >= 0.1) return "warn";
  return "info";
}

export const shorten = (text: string | null | undefined, max = 80): string => {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Tools that are expected to be called repeatedly with the same input (polling, progress). */
export const ROUTINE_TOOLS =
  /update_plan|wrap_up|TaskOutput|TaskStop|Monitor|ReadNotifications|ScheduleWakeup|screenshot/i;
