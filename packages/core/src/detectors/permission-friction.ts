import type { Detector, Finding } from "../plugin.js";
import { severityFor, shorten, sumCalls } from "./util.js";

const MIN_EVENTS = 3;

/** Denied tool calls and interrupted turns: work the agent did that the user then stopped. */
export const permissionFriction: Detector = {
  id: "permission-friction",
  title: "Permission friction",
  description:
    "Tool calls the user denied and turns they interrupted — work that was paid for and thrown away.",
  run({ store }) {
    const rows = store.db
      .prepare(
        `SELECT s.id AS sessionId,
           (SELECT COUNT(*) FROM tool_calls t WHERE t.session_id = s.id AND t.denial IS NOT NULL)
             AS denials,
           (SELECT COUNT(*) FROM markers m WHERE m.session_id = s.id AND m.type = 'interrupt')
             AS interrupts
         FROM sessions s`,
      )
      .all() as { sessionId: string; denials: number; interrupts: number }[];

    const denied = store.db.prepare(
      `SELECT name, denial, target, call_id AS callId, turn_id AS turnId
       FROM tool_calls WHERE session_id = ? AND denial IS NOT NULL`,
    );
    const findings: Finding[] = [];
    for (const r of rows) {
      if (r.denials + r.interrupts < MIN_EVENTS) continue;
      const calls = denied.all(r.sessionId) as {
        name: string;
        denial: string;
        target: string | null;
        callId: string;
        turnId: string | null;
      }[];
      const waste = sumCalls(
        store,
        calls.map((c) => c.callId),
      );
      const byTool = new Map<string, number>();
      for (const c of calls) byTool.set(c.name, (byTool.get(c.name) ?? 0) + 1);
      const ruleDenials = calls.filter((c) => c.denial === "permission-rule").length;
      findings.push({
        detector: "permission-friction",
        severity: severityFor(waste.usd),
        sessionId: r.sessionId,
        turnIds: [...new Set(calls.map((c) => c.turnId).filter((t): t is string => !!t))],
        title: `${r.denials} denied tool calls and ${r.interrupts} interrupted turns`,
        evidence: [
          ...[...byTool]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([name, n]) => `${name}: denied ${n}×`),
          ...calls.slice(0, 1).map((c) => `e.g. ${shorten(c.target, 60)}`),
        ],
        wastedTokens: waste.tokens,
        wastedUsd: waste.usd,
        suggestion:
          ruleDenials > calls.length / 2
            ? "Most denials came from permission rules: the agent does not know them. List what is not allowed in CLAUDE.md."
            : "If you approve the same safe tools repeatedly, add allow rules; if you keep rejecting an approach, say upfront what you want instead.",
      });
    }
    return findings;
  },
};
