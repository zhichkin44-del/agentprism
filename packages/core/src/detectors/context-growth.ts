import type { Detector, Finding } from "../plugin.js";
import { severityFor } from "./util.js";

/** Calls with a prompt above this size are flagged. */
const LARGE_CONTEXT = 200_000;
/** A focused session rarely needs more than this; the rest is history being re-read. */
const WORKING_CONTEXT = 100_000;
const MIN_LARGE_CALLS = 10;

const PROMPT = "input_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens";

/**
 * Long sessions re-read their whole history on every call. Cache reads are cheap per token,
 * but at hundreds of thousands of tokens per call they dominate the bill.
 */
export const contextGrowth: Detector = {
  id: "context-growth",
  title: "Context growth",
  description:
    "Sessions that keep running with a huge context re-read their whole history on every call.",
  run({ store }) {
    const rows = store.db
      .prepare(
        `SELECT session_id AS sessionId, COUNT(*) AS calls, MAX(${PROMPT}) AS peak,
           SUM(MAX(0, (${PROMPT}) - ?) * ap_cache_read_price(model)) / 1e6 AS usd,
           SUM(MAX(0, (${PROMPT}) - ?)) AS tokens,
           json_group_array(DISTINCT turn_id) AS turns
         FROM api_calls
         WHERE subagent_id IS NULL AND (${PROMPT}) > ?
         GROUP BY session_id HAVING calls >= ?`,
      )
      .all(WORKING_CONTEXT, WORKING_CONTEXT, LARGE_CONTEXT, MIN_LARGE_CALLS) as {
      sessionId: string;
      calls: number;
      peak: number;
      usd: number;
      tokens: number;
      turns: string;
    }[];

    const compactions = store.db.prepare(
      `SELECT COUNT(*) AS n FROM markers WHERE session_id = ? AND type = 'compaction'`,
    );
    const findings: Finding[] = [];
    for (const r of rows) {
      const n = (compactions.get(r.sessionId) as { n: number }).n;
      findings.push({
        detector: "context-growth",
        severity: severityFor(r.usd),
        sessionId: r.sessionId,
        turnIds: (JSON.parse(r.turns) as (string | null)[]).filter((t): t is string => !!t),
        title: `${r.calls} calls ran with over ${LARGE_CONTEXT / 1000}K tokens of context (peak ${Math.round(r.peak / 1000)}K)`,
        evidence: [
          `re-reading history beyond ${WORKING_CONTEXT / 1000}K cost ~${r.tokens.toLocaleString("en-US")} cache-read tokens`,
          n ? `${n} compaction${n > 1 ? "s" : ""} in this session` : "never compacted",
        ],
        wastedTokens: r.tokens,
        wastedUsd: r.usd,
        suggestion:
          "One task per session: start fresh (or /compact) when a task is done, and keep durable knowledge in CLAUDE.md instead of the chat history.",
      });
    }
    return findings;
  },
};
