import type { Detector, Finding } from "../plugin.js";
import { severityFor, shorten, sumCalls } from "./util.js";

const MIN_EVENTS = 3;

/**
 * Denied tool calls and interrupted turns. A denial is the user's protection working, so it is
 * friction, not waste; only asking again for exactly what was already denied is counted as waste.
 */
export const permissionFriction: Detector = {
  id: "permission-friction",
  title: "Permission friction",
  description:
    "Tool calls the user denied and turns they interrupted; the agent re-asking for an identical denied call is counted as waste.",
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
      `SELECT name, denial, target, call_id AS callId, turn_id AS turnId, input_hash AS inputHash
       FROM tool_calls WHERE session_id = ? AND denial IS NOT NULL ORDER BY ts`,
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
        inputHash: string;
      }[];
      const seen = new Set<string>();
      const retried = calls.filter((c) => {
        const key = `${c.name}\0${c.inputHash}`;
        if (seen.has(key)) return true;
        seen.add(key);
        return false;
      });
      const waste = sumCalls(
        store,
        retried.map((c) => c.callId),
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
          ...(retried.length
            ? [`${retried.length} identical call(s) asked again after a denial`]
            : []),
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
