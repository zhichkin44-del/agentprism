import type { Detector, Finding } from "../plugin.js";
import { resultTokens, severityFor, shortPath } from "./util.js";

/** A result this large is worth trimming. */
const MIN_RESULT_TOKENS = 5_000;
/** What a trimmed result would reasonably keep. */
const TRIMMED_TOKENS = 500;
const FAR_FUTURE = 8.64e15;

/**
 * Large tool outputs are not paid once: they stay in the context and are re-read (as cache reads)
 * by every following model call until the session ends or compacts.
 */
export const oversizedOutputs: Detector = {
  id: "oversized-outputs",
  title: "Oversized tool outputs",
  description:
    "Huge tool outputs stay in context and are paid again on every following model call.",
  run({ store }) {
    const big = (
      store.db
        .prepare(
          `SELECT id, session_id AS sessionId, turn_id AS turnId, name, target,
             COALESCE(result_chars, 0) AS chars, COALESCE(result_images, 0) AS images,
             result_ts AS ts, subagent_id AS subagentId
           FROM tool_calls WHERE result_ts IS NOT NULL ORDER BY session_id, ts`,
        )
        .all() as {
        id: string;
        sessionId: string;
        turnId: string | null;
        name: string;
        target: string | null;
        chars: number;
        images: number;
        ts: number;
        subagentId: string | null;
      }[]
    )
      .map((r) => ({ ...r, tokens: resultTokens(r.chars, r.images) }))
      .filter((r) => r.tokens >= MIN_RESULT_TOKENS);

    const nextCompaction = store.db.prepare(
      `SELECT MIN(ts) AS ts FROM markers WHERE session_id = ? AND type = 'compaction' AND ts > ?`,
    );
    // Calls that carried the output: same session, same context (main chain or one subagent).
    const carriers = store.db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(ap_cache_read_price(model)), 0) AS priceSum
       FROM api_calls
       WHERE session_id = ? AND subagent_id IS ? AND ts > ? AND ts < ?`,
    );
    // Upper bound: the carrying can never cost more than all cache reads of the session.
    const cacheReadSpend = store.db.prepare(
      `SELECT COALESCE(SUM(ap_cost_part('cache_read', model, input_tokens, output_tokens,
         cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens)), 0) AS usd,
         COALESCE(SUM(cache_read_tokens), 0) AS tokens
       FROM api_calls WHERE session_id = ?`,
    );

    const bySession = new Map<
      string,
      { items: typeof big; tokens: number; usd: number; carried: number }
    >();
    for (const r of big) {
      const until = r.subagentId
        ? FAR_FUTURE
        : ((nextCompaction.get(r.sessionId, r.ts) as { ts: number | null }).ts ?? FAR_FUTURE);
      const c = carriers.get(r.sessionId, r.subagentId, r.ts, until) as {
        n: number;
        priceSum: number;
      };
      const avoidable = Math.max(0, r.tokens - TRIMMED_TOKENS);
      const entry = bySession.get(r.sessionId) ?? { items: [], tokens: 0, usd: 0, carried: 0 };
      entry.items.push(r);
      entry.tokens += avoidable * c.n;
      entry.usd += (avoidable * c.priceSum) / 1e6;
      entry.carried += c.n;
      bySession.set(r.sessionId, entry);
    }

    const findings: Finding[] = [];
    for (const [sessionId, e] of bySession) {
      const cap = cacheReadSpend.get(sessionId) as { usd: number; tokens: number };
      const usd = Math.min(e.usd, cap.usd);
      const tokens = Math.min(e.tokens, cap.tokens);
      if (usd <= 0) continue;
      const largest = [...e.items].sort((a, b) => b.tokens - a.tokens).slice(0, 3);
      const avgCarry = Math.round(e.carried / e.items.length);
      const reads = e.items.filter((i) => i.name === "Read").length;
      const imageHeavy = e.items.filter((i) => i.images > 0).length > e.items.length / 2;
      findings.push({
        detector: "oversized-outputs",
        severity: severityFor(usd),
        sessionId,
        turnIds: [...new Set(e.items.map((i) => i.turnId).filter((t): t is string => !!t))],
        title: `${e.items.length} large tool outputs were carried through ~${avgCarry} later calls each`,
        evidence: largest.map(
          (i) =>
            `${i.name} ${shortPath(i.target, 56)} — ~${i.tokens.toLocaleString("en-US")} tokens${
              i.images ? ` (${i.images} image${i.images > 1 ? "s" : ""})` : ""
            }`,
        ),
        wastedTokens: tokens,
        wastedUsd: usd,
        suggestion: imageHeavy
          ? "Screenshots and images stay in context: take them only when needed, crop or downscale them, and start a fresh session after visual checks."
          : reads > e.items.length / 2
            ? "Read large files by range (offset/limit) or Grep for what you need; summarize big files in CLAUDE.md."
            : "Trim command output (`| tail -n 50`, `--quiet`, grep the lines you need). Add to CLAUDE.md: keep command output short.",
      });
    }
    return findings;
  },
};
