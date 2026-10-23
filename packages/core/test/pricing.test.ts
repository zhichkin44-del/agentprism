import { describe, expect, it } from "vitest";
import { DEFAULT_PRICES, callCost, callParts, mergePrices, priceFor, spend } from "../src/index.js";
import { at, session, storeWith } from "./helpers.js";

const tokens = (t: Partial<Parameters<typeof callCost>[1]>) => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  ...t,
});

describe("prices", () => {
  it("resolves models by longest prefix, including dated ids", () => {
    expect(priceFor(DEFAULT_PRICES, "claude-opus-5-5")?.input).toBe(4);
    expect(priceFor(DEFAULT_PRICES, "claude-opus-5")?.input).toBe(5);
    expect(priceFor(DEFAULT_PRICES, "claude-haiku-4-5-20251001")?.input).toBe(1);
    expect(priceFor(DEFAULT_PRICES, "gpt-5")).toBeUndefined();
  });

  it("prices every token kind", () => {
    // Opus 5.5: $4 in, $20 out, $0.20 cache read, $5 / $8 cache writes (5m / 1h).
    const price = priceFor(DEFAULT_PRICES, "claude-opus-5-5");
    const cost = callCost(
      price,
      tokens({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 }),
    );
    expect(cost).toBeCloseTo(4 + 20 + 0.2 + 5 + 8);
  });

  it("switches Haiku 5.5 to the long-prompt tier above 100K prompt tokens", () => {
    const price = priceFor(DEFAULT_PRICES, "claude-haiku-5-5");
    expect(callCost(price, tokens({ input: 100_000 }))).toBeCloseTo(0.01);
    expect(callCost(price, tokens({ input: 50_000, cacheRead: 60_000, output: 1e6 }))).toBeCloseTo(
      0.025 + 0.003 + 2.5,
    );
  });

  it("splits cost into parts that add up to the total", () => {
    const price = priceFor(DEFAULT_PRICES, "claude-haiku-5-5");
    const t = tokens({ input: 90_000, cacheRead: 20_000, output: 5_000, cacheWrite1h: 1_000 });
    const p = callParts(price, t);
    expect(p.input + p.output + p.cacheRead + p.cacheWrite).toBeCloseTo(callCost(price, t));
  });

  it("lets local overrides replace or add models", () => {
    const merged = mergePrices(DEFAULT_PRICES, {
      models: {
        "my-model": { input: 1, output: 2, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      },
    });
    expect(priceFor(merged, "my-model-v2")?.output).toBe(2);
    expect(priceFor(merged, "claude-opus-5-5")?.input).toBe(4);
  });
});

describe("spend", () => {
  it("aggregates the same numbers in SQL as callCost does in code", async () => {
    const s = session("s1").turn("t1", at(0));
    s.call(at(1), { input: 1000, output: 2000, cacheRead: 500_000, cacheWrite1h: 10_000 });
    s.call(at(2), { input: 10, output: 300, cacheRead: 510_000 });
    const store = await storeWith(s.events);

    const result = spend(store);
    const price = priceFor(DEFAULT_PRICES, "claude-opus-5-5");
    const expected =
      callCost(
        price,
        tokens({ input: 1000, output: 2000, cacheRead: 500_000, cacheWrite1h: 10_000 }),
      ) + callCost(price, tokens({ input: 10, output: 300, cacheRead: 510_000 }));

    expect(result.totals.usd).toBeCloseTo(expected);
    expect(
      result.totals.inputUsd +
        result.totals.outputUsd +
        result.totals.cacheReadUsd +
        result.totals.cacheWriteUsd,
    ).toBeCloseTo(expected);
    // Without caching every cached token would have been billed as fresh input.
    expect(result.totals.withoutCacheUsd).toBeCloseTo(
      ((1000 + 500_000 + 10_000 + 10 + 510_000) * 4 + (2000 + 300) * 20) / 1e6,
    );
    expect(result.topSessions[0]).toMatchObject({ sessionId: "s1", prompts: 1, calls: 2 });
    expect(result.topSessions[0]?.peakContext).toBe(1000 + 500_000 + 10_000);
    store.close();
  });
});

describe("compare", () => {
  it("splits sessions by start time and compares per-session medians", async () => {
    const { compare, median } = await import("../src/index.js");
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);

    const early = session("early").turn("e1", at(0));
    early.call(at(1), { cacheRead: 1_000_000 });
    const late = session("late").turn("l1", at(100_000));
    late.call(at(100_001), { cacheRead: 100_000 });
    const store = await storeWith([...early.events, ...late.events]);
    store.mark("new CLAUDE.md", at(50_000));
    expect(store.marks().map((m) => m.name)).toEqual(["new CLAUDE.md"]);

    const c = compare(store, at(50_000), "new CLAUDE.md", []);
    expect(c.before.sessions).toBe(1);
    expect(c.after.sessions).toBe(1);
    expect(c.before.medianUsdPerPrompt).toBeCloseTo(0.2);
    expect(c.after.medianUsdPerPrompt).toBeCloseTo(0.02);
    store.close();
  });
});
