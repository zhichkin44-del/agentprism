import type { Detector, Finding } from "../plugin.js";
import { severityFor } from "./util.js";

/** A cache write this large means the context was rebuilt, not extended. */
const MIN_REBUILD_TOKENS = 100_000;
/** What a fresh session with a good summary would have to write instead. */
const FRESH_CONTEXT = 50_000;
const ONE_HOUR = 3_600_000;

/**
 * When the prompt cache expires (idle longer than its TTL) or a long session is resumed, the
 * whole context is written to the cache again at 1.25–2× the input price, instead of read at ~0.05×.
 */
export const cacheRebuilds: Detector = {
  id: "cache-rebuilds",
  title: "Cache rebuilds",
  description:
    "A long context written to the cache again after a break or a resume — paid at the write price, not the read price.",
  run({ store }) {
    const rows = store.db
      .prepare(
        `SELECT session_id AS sessionId, turn_id AS turnId, written, gap,
           ap_cost_part('cache_write', model, input_tokens, output_tokens, cache_read_tokens,
             cache_write_5m_tokens, cache_write_1h_tokens) AS writeUsd
         FROM (
           SELECT *, cache_write_5m_tokens + cache_write_1h_tokens AS written,
             ts - LAG(ts) OVER (PARTITION BY session_id, COALESCE(subagent_id, '') ORDER BY ts) AS gap
           FROM api_calls)
         WHERE written >= ?
         ORDER BY session_id, ts`,
      )
      .all(MIN_REBUILD_TOKENS) as {
      sessionId: string;
      turnId: string | null;
      written: number;
      gap: number | null;
      writeUsd: number;
    }[];

    const bySession = new Map<string, typeof rows>();
    for (const r of rows) bySession.set(r.sessionId, [...(bySession.get(r.sessionId) ?? []), r]);

    const findings: Finding[] = [];
    for (const [sessionId, rebuilds] of bySession) {
      // Only the part beyond a fresh, summarized context was avoidable.
      let tokens = 0;
      let usd = 0;
      for (const r of rebuilds) {
        const avoidable = Math.max(0, r.written - FRESH_CONTEXT);
        tokens += avoidable;
        usd += r.writeUsd * (avoidable / r.written);
      }
      if (usd <= 0) continue;
      const afterIdle = rebuilds.filter((r) => r.gap !== null && r.gap > ONE_HOUR).length;
      const resumed = rebuilds.filter((r) => r.gap === null).length;
      const largest = Math.max(...rebuilds.map((r) => r.written));
      findings.push({
        detector: "cache-rebuilds",
        severity: severityFor(usd),
        sessionId,
        turnIds: [...new Set(rebuilds.map((r) => r.turnId).filter((t): t is string => !!t))],
        title: `The context was rewritten to the cache ${rebuilds.length}× (up to ${Math.round(largest / 1000)}K tokens each)`,
        evidence: [
          `${afterIdle} after a break of more than an hour`,
          ...(resumed ? [`${resumed} at the start of a resumed session`] : []),
          `${rebuilds.length - afterIdle - resumed} mid-session (context changed or cache expired)`,
        ],
        wastedTokens: tokens,
        wastedUsd: usd,
        suggestion:
          "After a long break, don't resume a huge session: start a fresh one from a short summary (or HANDOFF/CLAUDE.md). Rebuilding a long context costs 25–40× more per token than reading it.",
      });
    }
    return findings;
  },
};
