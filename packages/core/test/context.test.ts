import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRICES,
  compactionPlan,
  contextLedger,
  emptyUsage,
  type Timeline,
  type TimelineEvent,
} from "../src/index.js";

const T0 = Date.parse("2026-10-01T10:00:00Z");
const call = (
  id: string,
  i: number,
  cacheRead: number,
  cacheWrite: number,
  output = 500,
): TimelineEvent => ({
  kind: "call",
  id,
  ts: T0 + i * 60_000,
  model: "claude-opus-5-5",
  usage: {
    ...emptyUsage(),
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWrite1hTokens: cacheWrite,
  },
});
const block = (
  type: "tool_result" | "assistant_text" | "tool_use",
  text: string,
  extra = {},
): TimelineEvent => ({
  kind: "block",
  type,
  ts: T0,
  text,
  images: 0,
  ...extra,
});

/** Call 1 reads a file and runs a command; later calls use the file's identifier, never the output. */
function scenario(): Timeline {
  return {
    sessionId: "s1",
    events: [
      call("c1", 0, 0, 40_000),
      block("tool_use", '{"file_path":"/w/app.ts"}', {
        tool: "Read",
        target: "/w/app.ts",
        byCall: "c1",
      }),
      block("tool_use", '{"command":"ls"}', { tool: "Bash", byCall: "c1" }),
      block("tool_result", "export function computeInvoiceTotal() {}", {
        tool: "Read",
        target: "/w/app.ts",
      }),
      block("tool_result", "orphanBuildArtifact.log ".repeat(200), { tool: "Bash" }),
      call("c2", 1, 40_000, 3_000),
      block("assistant_text", "I will change computeInvoiceTotal now.", { byCall: "c2" }),
      call("c3", 2, 43_000, 500),
      block("assistant_text", "Tests for computeInvoiceTotal pass.", { byCall: "c3" }),
      call("c4", 3, 43_500, 100),
      call("c5", 4, 43_600, 100),
    ],
  };
}

describe("contextLedger", () => {
  it("adds up to the real prompt cost and splits growth between the blocks", () => {
    const l = contextLedger(scenario(), DEFAULT_PRICES);
    const t = l.totals;
    expect(t.alwaysUsd + t.usedUsd + t.deadUsd + t.thinkingUsd).toBeCloseTo(t.promptUsd, 6);
    // Growth from c1 to c2 (3,000 tokens) is split between what entered in between.
    const enteredAtC2 = l.blocks.filter((b) => b.birth === 1).reduce((s, b) => s + b.size, 0);
    expect(enteredAtC2).toBeCloseTo(3_000, 6);
  });

  it("keeps a block alive while later outputs use it, and counts the rest as dead", () => {
    const l = contextLedger(scenario(), DEFAULT_PRICES);
    const read = l.blocks.find((b) => b.label === "tool_result:Read");
    const bash = l.blocks.find((b) => b.label === "tool_result:Bash");
    expect(read?.lastUse).toBe(2); // used by c2 and again by c3
    expect(bash?.lastUse).toBe(-1); // never referenced
    expect(bash?.deadUsd ?? 0).toBeGreaterThan(0);
    const deadShare = (b: typeof read) => (b ? b.deadUsd / b.carryUsd : 0);
    expect(deadShare(bash)).toBeGreaterThan(deadShare(read));
  });
});

describe("compactionPlan", () => {
  // One long session growing 2K tokens per call up to ~600K, no compaction.
  const growing = (): Timeline => {
    const events: TimelineEvent[] = [];
    for (let i = 0; i < 300; i++)
      events.push(
        call(`c${i}`, i, i === 0 ? 0 : 40_000 + 2_000 * (i - 1), i === 0 ? 40_000 : 2_000),
      );
    return { sessionId: "s2", events };
  };

  it("the rule costs no more than recorded and stays within 2× of the exact optimum", () => {
    const l = contextLedger(growing(), DEFAULT_PRICES);
    const p = compactionPlan(l.calls, DEFAULT_PRICES, { rho: 0.5, postTokens: 60_000 });
    expect(p.ruleCompactions.length).toBeGreaterThan(0);
    expect(p.optimumUsd).toBeLessThanOrEqual(p.ruleUsd + 1e-9);
    expect(p.ruleUsd).toBeLessThan(p.recordedUsd);
    expect(p.ruleUsd).toBeLessThanOrEqual(2 * p.optimumUsd);
    expect(p.ruleCum.at(-1)).toBeCloseTo(p.ruleUsd, 6);
  });

  it("does not compact when forgetting is very expensive, and says why", () => {
    const l = contextLedger(growing(), DEFAULT_PRICES);
    const p = compactionPlan(l.calls, DEFAULT_PRICES, { rho: 10_000, postTokens: 60_000 });
    expect(p.ruleCompactions).toEqual([]);
    expect(p.optimumCompactions).toBe(0);
    expect(p.now.advice).toBe("not-yet");
  });
});
