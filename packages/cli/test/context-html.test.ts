import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRICES,
  compactionPlan,
  contextLedger,
  emptyUsage,
  type TimelineEvent,
} from "@agentprism/core";
import { publicReport, renderContextHtml } from "../src/context-html.js";
import { watchUpdate } from "../src/context.js";

const SECRET_TEXT = "the owner's private plan for Zorblax";
const SECRET_PATH = "C:/Users/someone/secret-project/notes.md";

describe("HTML context report", () => {
  it("contains no message text, no path and no title", () => {
    const events: TimelineEvent[] = [];
    for (let i = 0; i < 40; i++) {
      events.push({
        kind: "call",
        id: `c${i}`,
        ts: Date.parse("2026-10-01T10:00:00Z") + i * 60_000,
        model: "claude-opus-5-5",
        usage: {
          ...emptyUsage(),
          outputTokens: 300,
          cacheReadTokens: 40_000 + 5_000 * i,
          cacheWrite1hTokens: 5_000,
        },
      });
      events.push({ kind: "block", type: "user_prompt", ts: 0, text: SECRET_TEXT, images: 0 });
      events.push({
        kind: "block",
        type: "tool_result",
        ts: 0,
        tool: "mcp__secret_server__read",
        target: SECRET_PATH,
        text: SECRET_TEXT,
        images: 0,
      });
    }
    const ledger = contextLedger({ sessionId: "secret-session-id", events }, DEFAULT_PRICES);
    const plan = compactionPlan(ledger.calls, DEFAULT_PRICES);
    const report = publicReport(
      { sessionId: "secret-session-id", title: "Secret title", ledger, plan },
      "0.0.0-test",
    );
    const html = renderContextHtml(report);
    for (const leak of [SECRET_TEXT, "Zorblax", SECRET_PATH, "secret", "Secret title"]) {
      expect(JSON.stringify(report)).not.toContain(leak);
      expect(html).not.toContain(leak);
    }
    expect(html).toContain("Context economics");
  });
});

describe("watch mode", () => {
  const session = (calls: number, growth: number) => {
    const events: TimelineEvent[] = [];
    for (let i = 0; i < calls; i++) {
      events.push({
        kind: "call",
        id: `c${i}`,
        ts: Date.parse("2026-10-01T10:00:00Z") + i * 60_000,
        model: "claude-opus-5-5",
        usage: {
          ...emptyUsage(),
          outputTokens: 300,
          cacheReadTokens: i === 0 ? 0 : 40_000 + growth * (i - 1),
          cacheWrite1hTokens: i === 0 ? 40_000 : growth,
        },
      });
    }
    const ledger = contextLedger({ sessionId: "s", events }, DEFAULT_PRICES);
    return {
      sessionId: "s",
      title: null,
      ledger,
      plan: compactionPlan(ledger.calls, DEFAULT_PRICES, { postTokens: 60_000 }),
    };
  };

  it("prints on the first look, then only after enough new calls or a change of advice", () => {
    const first = watchUpdate(session(30, 1_000), undefined, 20);
    expect(first?.lines.length).toBeGreaterThan(0);
    expect(watchUpdate(session(35, 1_000), first?.state, 20)).toBeNull();
    expect(watchUpdate(session(50, 1_000), first?.state, 20)).not.toBeNull();
    // A fast-growing session crosses into "compact now": that is printed at once.
    const grown = session(36, 20_000);
    expect(grown.plan.now.advice).toBe("compact-now");
    expect(watchUpdate(grown, first?.state, 20)?.state.advice).toBe("compact-now");
  });
});
