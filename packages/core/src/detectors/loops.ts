import type { Detector, Finding } from "../plugin.js";
import { ROUTINE_TOOLS, severityFor, shorten, sumCalls } from "./util.js";

const MIN_REPEATS = 3;

/**
 * The same tool call, with byte-identical input, repeated within one turn and getting the same
 * result back. A repeat whose result changed (a screenshot after an edit, a reload) is the agent
 * watching the world change, not a loop.
 */
export const loops: Detector = {
  id: "loops",
  title: "Loops",
  description:
    "The agent repeats an identical tool call within one turn and gets the same result — usually it did not get the result it expected.",
  run({ store }) {
    const rows = store.db
      .prepare(
        `SELECT session_id AS sessionId, turn_id AS turnId, name, target, COUNT(*) AS n,
           json_group_array(json_array(call_id, result_hash) ORDER BY ts) AS calls
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
      // [model call id, result hash] in time order. A repeat counts when its result equals the
      // previous one (unknown hashes count as equal). The first call was legitimate, and parallel
      // repeats can share its model request, which then must not count as waste.
      const calls = JSON.parse(r.calls) as [string, string | null][];
      const first = calls[0]?.[0];
      const repeats = calls
        .filter(
          ([, hash], i) =>
            i > 0 && (hash === null || calls[i - 1]?.[1] == null || hash === calls[i - 1]?.[1]),
        )
        .map(([call]) => call)
        .filter((c) => c !== first);
      if (repeats.length < MIN_REPEATS - 1) continue;
      const waste = sumCalls(store, repeats);
      findings.push({
        detector: "loops",
        severity: severityFor(waste.usd),
        sessionId: r.sessionId,
        turnIds: r.turnId ? [r.turnId] : [],
        title: `Repeated the same ${r.name} call ${repeats.length + 1}× in one turn with the same result`,
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
