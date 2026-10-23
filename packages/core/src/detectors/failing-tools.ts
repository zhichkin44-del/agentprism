import type { Detector, Finding } from "../plugin.js";
import { severityFor, shorten, sumCalls } from "./util.js";

const MIN_SAME_FAILURES = 2;
const MIN_SESSION_ERRORS = 10;
const MIN_SESSION_ERROR_RATE = 0.15;

/** Tool calls that fail again and again: the same failing call, or a session full of errors. */
export const failingTools: Detector = {
  id: "failing-tools",
  title: "Failing tools",
  description:
    "Tool calls that keep failing — each failure costs a model call to read the error and try again.",
  run({ store }) {
    const findings: Finding[] = [];

    // 1. The same input failing more than once: the agent retried without changing anything.
    const repeated = store.db
      .prepare(
        `SELECT session_id AS sessionId, name, target, COUNT(*) AS n,
           json_group_array(call_id ORDER BY ts) AS calls, json_group_array(DISTINCT turn_id) AS turns
         FROM tool_calls
         WHERE is_error = 1 AND denial IS NULL
         GROUP BY session_id, input_hash HAVING n >= ?`,
      )
      .all(MIN_SAME_FAILURES) as {
      sessionId: string;
      name: string;
      target: string | null;
      n: number;
      calls: string;
      turns: string;
    }[];

    for (const r of repeated) {
      const calls = JSON.parse(r.calls) as string[];
      if (calls.every((c) => c === calls[0])) continue;
      const waste = sumCalls(
        store,
        calls.filter((c) => c !== calls[0]),
      );
      findings.push({
        detector: "failing-tools",
        severity: severityFor(waste.usd),
        sessionId: r.sessionId,
        turnIds: (JSON.parse(r.turns) as (string | null)[]).filter((t): t is string => !!t),
        title: `The same ${r.name} call failed ${r.n}×`,
        evidence: [`${r.name}: ${shorten(r.target) || "(same input)"}`],
        wastedTokens: waste.tokens,
        wastedUsd: waste.usd,
        suggestion:
          r.name === "Bash" || r.name === "PowerShell"
            ? "Write the correct way to run this (command, flags, working directory, required env) into CLAUDE.md."
            : "The agent retried an identical failing call; tell it why it fails or how to do it instead.",
      });
    }

    // 2. Sessions where a large share of all tool calls failed.
    const sessions = store.db
      .prepare(
        `SELECT session_id AS sessionId, COUNT(*) AS total, SUM(is_error = 1) AS errors,
           json_group_array(CASE WHEN is_error = 1 THEN call_id END) AS calls
         FROM tool_calls WHERE denial IS NULL
         GROUP BY session_id HAVING errors >= ? AND errors * 1.0 / total >= ?`,
      )
      .all(MIN_SESSION_ERRORS, MIN_SESSION_ERROR_RATE) as {
      sessionId: string;
      total: number;
      errors: number;
      calls: string;
    }[];

    const topFailures = store.db.prepare(
      `SELECT name, COUNT(*) AS n FROM tool_calls
       WHERE session_id = ? AND is_error = 1 AND denial IS NULL
       GROUP BY name ORDER BY n DESC LIMIT 3`,
    );
    for (const s of sessions) {
      const waste = sumCalls(
        store,
        (JSON.parse(s.calls) as (string | null)[]).filter((c): c is string => !!c),
      );
      const top = topFailures.all(s.sessionId) as { name: string; n: number }[];
      findings.push({
        detector: "failing-tools",
        severity: severityFor(waste.usd),
        sessionId: s.sessionId,
        turnIds: [],
        title: `${s.errors} of ${s.total} tool calls failed in this session`,
        evidence: top.map((t) => `${t.name}: ${t.n} failures`),
        wastedTokens: waste.tokens,
        wastedUsd: waste.usd,
        suggestion:
          "A high failure rate usually means the environment is not what the agent assumes (OS, shell, paths, tool versions). Describe it in CLAUDE.md.",
      });
    }
    return findings;
  },
};
