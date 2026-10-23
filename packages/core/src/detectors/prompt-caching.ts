import type { Detector, Finding } from "../plugin.js";
import { costOf } from "../pricing/sql.js";
import { severityFor } from "./util.js";

/*
 * Detectors for apps traced with the SDK: they need the request hashes that only SDK traces carry
 * (`prefix_hash`, `prompt_hash`), so on coding-agent logs they find nothing by design.
 */

/** Below this many input tokens providers do not cache anyway (model-dependent, 512–4096). */
const MIN_CACHEABLE = 2_048;
const MIN_REPEATS = 3;

const latestSession = `SELECT id FROM sessions WHERE project_path IS ? ORDER BY ended_at DESC LIMIT 1`;

/** The same large prefix sent again and again with no prompt caching at all. */
export const uncachedPrompts: Detector = {
  id: "uncached-prompts",
  title: "Uncached prompts",
  description:
    "The same large system prompt and tools are sent on every call without prompt caching — paid at full input price each time.",
  run({ store }) {
    const rows = store.db
      .prepare(
        `SELECT s.project_path AS app, a.model, a.prefix_hash AS prefix, COUNT(*) AS n,
           MIN(a.input_tokens) AS shared,
           ap_price(a.model, 'input') AS inPrice, ap_price(a.model, 'cache_read') AS readPrice,
           ap_price(a.model, 'cache_write_5m') AS writePrice
         FROM api_calls a JOIN sessions s ON s.id = a.session_id
         WHERE a.prefix_hash IS NOT NULL AND a.cache_read_tokens = 0
           AND a.cache_write_5m_tokens + a.cache_write_1h_tokens = 0 AND a.input_tokens >= ?
         GROUP BY s.project_path, a.model, a.prefix_hash HAVING n >= ?
         ORDER BY n DESC`,
      )
      .all(MIN_CACHEABLE, MIN_REPEATS) as {
      app: string | null;
      model: string;
      prefix: string;
      n: number;
      shared: number;
      inPrice: number;
      readPrice: number;
      writePrice: number;
    }[];

    const findings: Finding[] = [];
    const latest = store.db.prepare(latestSession);
    for (const r of rows) {
      // Conservative: only the smallest prompt of the group counts as the shared prefix; the
      // first call would pay the cache write premium, every later one reads instead of paying input.
      const saved =
        (r.n - 1) * r.shared * (r.inPrice - r.readPrice) - r.shared * (r.writePrice - r.inPrice);
      const usd = saved / 1e6;
      if (usd <= 0) continue;
      const sessionId = (latest.get(r.app) as { id: string } | undefined)?.id;
      if (!sessionId) continue;
      findings.push({
        detector: "uncached-prompts",
        severity: severityFor(usd),
        sessionId,
        turnIds: [],
        title: `${r.n} calls to ${r.model} resent a ~${Math.round(r.shared / 1000)}K-token prefix without caching`,
        evidence: [`app ${r.app ?? "(unknown)"} · prefix ${r.prefix}`],
        wastedTokens: (r.n - 1) * r.shared,
        wastedUsd: usd,
        suggestion:
          "Mark the stable part (tools, system prompt) with cache_control, or turn on automatic caching; keep timestamps, user ids and other changing text after it.",
      });
    }
    return findings;
  },
};

/** Caching is on, but the prefix changes between calls, so the cache is rewritten instead of read. */
export const unstablePrefix: Detector = {
  id: "unstable-prefix",
  title: "Unstable prompt prefix",
  description:
    "The system prompt or tool list changes from call to call, so the prompt cache is rewritten instead of read.",
  run({ store }) {
    const rows = store.db
      .prepare(
        `SELECT app, agent, COUNT(*) AS changes, MAX(sessionId) AS sessionId,
           SUM(written * (writePrice - readPrice)) / 1e6 AS usd, SUM(written) AS tokens
         FROM (
           SELECT s.project_path AS app, COALESCE(a.agent, '') AS agent, a.session_id AS sessionId,
             a.cache_write_5m_tokens + a.cache_write_1h_tokens AS written,
             a.prefix_hash AS prefix,
             LAG(a.prefix_hash) OVER (PARTITION BY s.project_path, COALESCE(a.agent, ''), a.model
               ORDER BY a.ts) AS previous,
             ap_price(a.model, CASE WHEN a.cache_write_1h_tokens > 0 THEN 'cache_write_1h'
               ELSE 'cache_write_5m' END) AS writePrice,
             ap_price(a.model, 'cache_read') AS readPrice
           FROM api_calls a JOIN sessions s ON s.id = a.session_id
           WHERE a.prefix_hash IS NOT NULL)
         WHERE previous IS NOT NULL AND prefix <> previous AND written > 0
         GROUP BY app, agent HAVING changes >= ?`,
      )
      .all(MIN_REPEATS) as {
      app: string | null;
      agent: string;
      changes: number;
      sessionId: string;
      usd: number;
      tokens: number;
    }[];

    return rows
      .filter((r) => r.usd > 0)
      .map((r) => ({
        detector: "unstable-prefix",
        severity: severityFor(r.usd),
        sessionId: r.sessionId,
        turnIds: [],
        title: `The prompt prefix changed ${r.changes}× between calls, rewriting the cache each time`,
        evidence: [`app ${r.app ?? "(unknown)"}${r.agent ? ` · agent ${r.agent}` : ""}`],
        wastedTokens: r.tokens,
        wastedUsd: r.usd,
        suggestion:
          "Find what varies at the start of the request (a date, a user name, a shuffled tool list, unsorted JSON) and move it after the cached part.",
      }));
  },
};

/** Byte-identical requests answered again: what an exact-match cache would have saved. */
export const duplicateRequests: Detector = {
  id: "duplicate-requests",
  title: "Duplicate requests",
  description:
    "Identical requests sent to the model more than once — an exact-match response cache would answer the repeats for free.",
  run({ store }) {
    const rows = store.db
      .prepare(
        `SELECT app, COUNT(*) AS groups, SUM(n - 1) AS repeats, SUM(repeatUsd) AS usd,
           SUM(repeatTokens) AS tokens, MAX(n) AS most
         FROM (
           SELECT s.project_path AS app, a.prompt_hash, COUNT(*) AS n,
             (SUM(${costOf("a")}) * (COUNT(*) - 1)) / COUNT(*) AS repeatUsd,
             (SUM(a.input_tokens + a.output_tokens + a.cache_read_tokens + a.cache_write_5m_tokens
               + a.cache_write_1h_tokens) * (COUNT(*) - 1)) / COUNT(*) AS repeatTokens
           FROM api_calls a JOIN sessions s ON s.id = a.session_id
           WHERE a.prompt_hash IS NOT NULL
           GROUP BY s.project_path, a.prompt_hash HAVING n >= 2)
         GROUP BY app`,
      )
      .all() as {
      app: string | null;
      groups: number;
      repeats: number;
      usd: number;
      tokens: number;
      most: number;
    }[];

    const latest = store.db.prepare(latestSession);
    const findings: Finding[] = [];
    for (const r of rows) {
      const sessionId = (latest.get(r.app) as { id: string } | undefined)?.id;
      if (!sessionId || r.usd <= 0) continue;
      findings.push({
        detector: "duplicate-requests",
        severity: severityFor(r.usd),
        sessionId,
        turnIds: [],
        title: `${r.repeats} repeats of ${r.groups} identical requests were sent to the model again`,
        evidence: [`app ${r.app ?? "(unknown)"} · the most repeated request was sent ${r.most}×`],
        wastedTokens: Math.round(r.tokens),
        wastedUsd: r.usd,
        suggestion:
          "Answer identical requests from an exact-match cache (keyed by the request hash, with a TTL); if answers must vary, make that explicit.",
      });
    }
    return findings;
  },
};
