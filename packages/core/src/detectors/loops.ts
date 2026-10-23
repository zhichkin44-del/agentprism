import type { Detector, Finding } from "../plugin.js";
import { ROUTINE_TOOLS, severityFor, shorten, sumCalls } from "./util.js";

const MIN_REPEATS = 3;

/** The same tool call, with byte-identical input, repeated within one turn. */
export const loops: Detector = {
  id: "loops",
  title: "Loops",
  description:
    "The agent repeats an identical tool call within one turn — usually it did not get the result it expected.",
  run({ store }) {
    const rows = store.db
      .prepare(
        `SELECT session_id AS sessionId, turn_id AS turnId, name, target, COUNT(*) AS n,
           json_group_array(call_id ORDER BY ts) AS calls
         FROM tool_calls
         GROUP BY session_id, COALESCE(turn_id, 'sub:' || subagent_id), input_hash
         HAVING n >= ?`,
      )
      .all(MIN_REPEATS) as {
      sessionId: string;
      turnId: string | null;
      name: string;
      target: string | null;
      n: number;
      calls: string;
    }[];

    const findings: Finding[] = [];
    for (const r of rows) {
      if (ROUTINE_TOOLS.test(r.name)) continue;
      // The first call was legitimate; the repeats are the waste. Parallel repeats can share
      // the first call's model request, which then must not count as waste.
      const calls = JSON.parse(r.calls) as string[];
      const repeats = calls.filter((c) => c !== calls[0]);
      if (repeats.length === 0) continue;
      const waste = sumCalls(store, repeats);
      findings.push({
        detector: "loops",
        severity: severityFor(waste.usd),
        sessionId: r.sessionId,
        turnIds: r.turnId ? [r.turnId] : [],
        title: `Repeated the same ${r.name} call ${r.n}× in one turn`,
        evidence: [`${r.name}: ${shorten(r.target) || "(same input)"}`],
        wastedTokens: waste.tokens,
        wastedUsd: waste.usd,
        suggestion:
          r.name === "Bash" || r.name === "PowerShell"
            ? "If this was waiting for something, tell the agent the exact condition to wait for; if it was a retry, put the working command in CLAUDE.md."
            : "Identical repeats mean the first result was not what the agent expected: check it and add the missing fact (path, command, expected output) to CLAUDE.md.",
      });
    }
    return findings;
  },
};
