/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** Higher rates for prompts above `thresholdTokens` (e.g. Haiku 5.5 beyond 100K). */
  longContext?: { thresholdTokens: number; price: Omit<ModelPrice, "longContext"> };
}

export interface PriceTable {
  /** Where the numbers come from, shown next to every cost. */
  source: string;
  /** Keyed by model id prefix; the longest matching prefix wins (so dated ids resolve). */
  models: Record<string, ModelPrice>;
}

/**
 * Standard multipliers where a model has no published cache price of its own:
 * cache read 0.1× input, cache write 1.25× (5-minute TTL) and 2× (1-hour TTL).
 */
function standard(input: number, output: number, cacheRead = input * 0.1): ModelPrice {
  return { input, output, cacheRead, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2 };
}

/** Anthropic first-party API prices as of 2026-10-06. See docs/DECISIONS.md D18. */
export const DEFAULT_PRICES: PriceTable = {
  source: "Anthropic API list prices, 2026-10-06",
  models: {
    "claude-fable-5-1": standard(10, 50, 0.25),
    "claude-mythos-5-1": standard(10, 50, 0.25),
    "claude-fable-5": standard(10, 50, 1),
    "claude-mythos-5": standard(10, 50, 1),
    "claude-opus-5-5": standard(4, 20, 0.2),
    "claude-opus-5": standard(5, 25),
    "claude-opus-4-8": standard(5, 25),
    "claude-opus-4-7": standard(5, 25),
    "claude-opus-4-6": standard(5, 25),
    "claude-opus-4-5": standard(5, 25),
    "claude-opus-4-1": standard(15, 75),
    // Cache read $0.10, not $0.20: Claude Code's own cost-state matches to the cent only at $0.10.
    "claude-sonnet-5-5": standard(2, 10, 0.1),
    "claude-sonnet-5": standard(2, 10),
    "claude-sonnet-4-6": standard(3, 15),
    "claude-sonnet-4-5": standard(3, 15),
    "claude-haiku-5-5": {
      ...standard(0.1, 0.5),
      longContext: { thresholdTokens: 100_000, price: standard(0.5, 2.5) },
    },
    "claude-haiku-4-5": standard(1, 5),
  },
};

/** Finds the price for a model id by longest prefix, or undefined if unknown. */
export function priceFor(table: PriceTable, model: string): ModelPrice | undefined {
  let best: string | undefined;
  for (const key of Object.keys(table.models)) {
    if (model.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? table.models[best] : undefined;
}

export interface CallTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface CostParts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * USD cost of one model call, split by component. Every part is priced at the tier the whole
 * prompt falls into. Unknown models cost 0 and are reported separately by the caller.
 */
export function callParts(price: ModelPrice | undefined, t: CallTokens): CostParts {
  if (!price) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const prompt = t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
  const p =
    price.longContext && prompt > price.longContext.thresholdTokens
      ? price.longContext.price
      : price;
  return {
    input: (t.input * p.input) / 1e6,
    output: (t.output * p.output) / 1e6,
    cacheRead: (t.cacheRead * p.cacheRead) / 1e6,
    cacheWrite: (t.cacheWrite5m * p.cacheWrite5m + t.cacheWrite1h * p.cacheWrite1h) / 1e6,
  };
}

export function callCost(price: ModelPrice | undefined, t: CallTokens): number {
  const p = callParts(price, t);
  return p.input + p.output + p.cacheRead + p.cacheWrite;
}

/** Merges user overrides (same shape, partial) over the defaults. */
export function mergePrices(
  base: PriceTable,
  override: Partial<PriceTable> | undefined,
): PriceTable {
  if (!override) return base;
  return {
    source: override.source ?? `${base.source} + local overrides`,
    models: { ...base.models, ...override.models },
  };
}
