import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRICES,
  compactionPlan,
  contextLedger,
  emptyUsage,
  type TimelineEvent,
} from "@agentprism/core";
import { publicReport, renderContextHtml } from "../src/context-html.js";

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
