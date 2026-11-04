import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRICES,
  callCost,
  coreDetectors,
  priceFor,
  runDetectors,
  type Detector,
  type Finding,
  type Store,
} from "../src/index.js";
import { at, session, storeWith } from "./helpers.js";

const opus = priceFor(DEFAULT_PRICES, "claude-opus-5-5");
const costOfCall = (cacheRead: number, output = 0) =>
  callCost(opus, { input: 0, output, cacheRead, cacheWrite5m: 0, cacheWrite1h: 0 });

async function findings(store: Store, id: string): Promise<Finding[]> {
  const detector = coreDetectors.detectors?.find((d) => d.id === id);
  if (!detector) throw new Error(`no detector ${id}`);
  const [run] = await runDetectors([detector], { store });
  return run?.findings ?? [];
}

describe("loops", () => {
  it("counts the repeats of an identical call, not the first one", async () => {
    const s = session("s1").turn("t1", at(0));
    for (const i of [1, 2, 3]) {
      const c = s.call(at(i * 10), { cacheRead: 10_000 * i });
      s.tool(c, at(i * 10 + 1), { name: "Bash", target: "npm test", hash: "same" });
    }
    const store = await storeWith(s.events);
    const [f] = await findings(store, "loops");
    expect(f?.title).toBe("Repeated the same Bash call 3× in one turn with the same result");
    expect(f?.wastedUsd).toBeCloseTo(costOfCall(20_000) + costOfCall(30_000));
    expect(f?.turnIds).toEqual(["t1"]);
  });

  it("does not count repeats whose result changed (watching the screen after edits)", async () => {
    const s = session("s1").turn("t1", at(0));
    for (const i of [1, 2, 3, 4]) {
      const c = s.call(at(i * 10), { cacheRead: 10_000 });
      s.tool(c, at(i * 10 + 1), {
        name: "mcp__browser__screenshot_page",
        hash: "same",
        result: `frame${i}`,
      });
    }
    expect(await findings(await storeWith(s.events), "loops")).toEqual([]);

    const same = session("s2").turn("t2", at(0));
    for (const i of [1, 2, 3]) {
      const c = same.call(at(i * 10), { cacheRead: 10_000 });
      same.tool(c, at(i * 10 + 1), { name: "Bash", hash: "status", result: "still running" });
    }
    expect(await findings(await storeWith(same.events), "loops")).toHaveLength(1);
  });

  it("ignores routine polling tools and parallel repeats in a single request", async () => {
    const s = session("s1").turn("t1", at(0));
    for (const i of [1, 2, 3]) {
      const c = s.call(at(i), { cacheRead: 1000 });
      s.tool(c, at(i), { name: "mcp__ccd_turn__update_plan", hash: "advance" });
    }
    const one = s.call(at(10), { cacheRead: 1000 });
    for (const i of [1, 2, 3]) s.tool(one, at(10 + i), { name: "Grep", hash: "parallel" });
    expect(await findings(await storeWith(s.events), "loops")).toEqual([]);
  });
});

describe("failing-tools", () => {
  it("flags an identical call that failed again", async () => {
    const s = session("s1").turn("t1", at(0));
    const c1 = s.call(at(1), { cacheRead: 1000 });
    s.tool(c1, at(2), { target: "pytest", hash: "h", error: true });
    const c2 = s.call(at(3), { cacheRead: 2000 });
    s.tool(c2, at(4), { target: "pytest", hash: "h", error: true });
    const [f] = await findings(await storeWith(s.events), "failing-tools");
    expect(f?.title).toBe("The same Bash call failed 2×");
    expect(f?.wastedUsd).toBeCloseTo(costOfCall(2000));
  });
});

describe("oversized-outputs", () => {
  it("charges a large output for every later call that carried it, until compaction", async () => {
    const s = session("s1").turn("t1", at(0));
    const c0 = s.call(at(1), { cacheRead: 100_000 });
    // 40,000 chars ≈ 10,000 tokens, of which 500 would have been worth keeping.
    s.tool(c0, at(2), { name: "Read", target: "/work/app/big.log", chars: 40_000 });
    s.call(at(10), { cacheRead: 100_000 });
    s.call(at(11), { cacheRead: 100_000 });
    s.marker("compaction", at(20));
    s.call(at(30), { cacheRead: 100_000 });
    const [f] = await findings(await storeWith(s.events), "oversized-outputs");
    expect(f?.wastedTokens).toBe(9_500 * 2);
    expect(f?.wastedUsd).toBeCloseTo((9_500 * 2 * 0.2) / 1e6);
  });
});

describe("context-growth", () => {
  it("prices the history re-read beyond the working size", async () => {
    const s = session("s1").turn("t1", at(0));
    for (let i = 0; i < 10; i++) s.call(at(i), { cacheRead: 300_000 });
    const [f] = await findings(await storeWith(s.events), "context-growth");
    expect(f?.wastedTokens).toBe(10 * 200_000);
    expect(f?.wastedUsd).toBeCloseTo((10 * 200_000 * 0.2) / 1e6);
    expect(f?.title).toContain("10 calls ran with over 200K tokens");
  });

  it("stays quiet for sessions with a normal context", async () => {
    const s = session("s1").turn("t1", at(0));
    for (let i = 0; i < 20; i++) s.call(at(i), { cacheRead: 150_000 });
    expect(await findings(await storeWith(s.events), "context-growth")).toEqual([]);
  });
});

describe("permission-friction", () => {
  it("reports denials as friction and charges only identical calls asked again", async () => {
    const s = session("s1").turn("t1", at(0));
    const c1 = s.call(at(1), { cacheRead: 5000 });
    s.tool(c1, at(2), {
      name: "Bash",
      target: "rm -rf build",
      hash: "rm",
      denial: "user-rejected",
      error: true,
    });
    const c2 = s.call(at(3), { cacheRead: 6000 });
    s.tool(c2, at(4), {
      name: "Bash",
      target: "git push",
      hash: "push",
      denial: "user-rejected",
      error: true,
    });
    s.marker("interrupt", at(5));
    const [f] = await findings(await storeWith(s.events), "permission-friction");
    expect(f?.title).toBe("2 denied tool calls and 1 interrupted turns");
    expect(f?.wastedUsd).toBe(0);

    const c3 = s.call(at(6), { cacheRead: 7000 });
    s.tool(c3, at(7), {
      name: "Bash",
      target: "rm -rf build",
      hash: "rm",
      denial: "user-rejected",
      error: true,
    });
    const [g] = await findings(await storeWith(s.events), "permission-friction");
    expect(g?.wastedUsd).toBeCloseTo(costOfCall(7000));
  });
});

describe("runDetectors", () => {
  it("keeps going when one module throws, and filters by session", async () => {
    const broken: Detector = {
      id: "broken",
      title: "Broken",
      description: "always throws",
      run: () => {
        throw new Error("boom");
      },
    };
    const s = session("s1").turn("t1", at(0));
    for (let i = 0; i < 10; i++) s.call(at(i), { cacheRead: 300_000 });
    const store = await storeWith(s.events);
    const runs = await runDetectors([broken, ...(coreDetectors.detectors ?? [])], {
      store,
      sessionIds: ["other"],
    });
    expect(runs[0]?.error).toBe("boom");
    expect(runs.flatMap((r) => r.findings)).toEqual([]);
  });
});

describe("cache-rebuilds", () => {
  it("prices the avoidable part of rewriting a long context after a break", async () => {
    const s = session("s1").turn("t1", at(0));
    s.call(at(0), { cacheWrite1h: 20_000 });
    s.call(at(10), { cacheRead: 20_000 });
    // Two hours later the cache has expired: 300K tokens are written again.
    s.call(at(7_210), { cacheWrite1h: 300_000 });
    const [f] = await findings(await storeWith(s.events), "cache-rebuilds");
    expect(f?.wastedTokens).toBe(250_000);
    expect(f?.wastedUsd).toBeCloseTo((250_000 * 8) / 1e6);
    expect(f?.evidence[0]).toBe("1 after a break of more than an hour");
  });
});
