import { COST_ARGS, costOf } from "../pricing/sql.js";
import type { Store } from "../store/store.js";
import { priceCheck, type PriceCheck } from "./price-check.js";

export interface SpendTotals {
  usd: number;
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
  /** What the same traffic would cost if nothing had been cached. */
  withoutCacheUsd: number;
  calls: number;
  prompts: number;
}

export interface SessionSpend {
  sessionId: string;
  title: string | null;
  project: string | null;
  startedAt: number | null;
  prompts: number;
  calls: number;
  usd: number;
  /** Largest prompt (input + cache) of any single call, in tokens. */
  peakContext: number;
  /** Average prompt size per call, in tokens. */
  avgContext: number;
  compactions: number;
}

export interface TurnSpend {
  turnId: string;
  sessionId: string;
  title: string | null;
  project: string | null;
  index: number;
  ts: number;
  calls: number;
  usd: number;
}

export interface Spend {
  priceSource: string;
  totals: SpendTotals;
  byProject: { project: string; sessions: number; prompts: number; usd: number }[];
  byModel: { model: string; calls: number; usd: number; known: boolean }[];
  /** Last days with activity, oldest first (UTC dates). */
  byDay: { day: string; usd: number; calls: number }[];
  topSessions: SessionSpend[];
  topTurns: TurnSpend[];
  /** Apps traced with the SDK and their agents; empty for coding-agent logs only. */
  byAgent: AgentSpend[];
  /** Our prices against the agent's own cost records; empty when the logs have none. */
  priceChecks: PriceCheck[];
}

export interface AgentSpend {
  app: string;
  agent: string;
  calls: number;
  usd: number;
  avgMs: number | null;
  cacheReadShare: number;
}

const PROMPT_TOKENS =
  "input_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens";

/** Session-level spend for every session, most expensive first. Shared with detectors. */
export function sessionSpend(store: Store, limit = -1): SessionSpend[] {
  return store.db
    .prepare(
      `SELECT s.id AS sessionId, s.title, s.project_path AS project, s.started_at AS startedAt,
         (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) AS prompts,
         (SELECT COUNT(*) FROM markers m WHERE m.session_id = s.id AND m.type = 'compaction')
           AS compactions,
         COUNT(a.id) AS calls,
         COALESCE(SUM(${costOf("a")}), 0) AS usd,
         COALESCE(MAX(${PROMPT_TOKENS.replace(/(\w+_tokens)/g, "a.$1")}), 0) AS peakContext,
         COALESCE(AVG(${PROMPT_TOKENS.replace(/(\w+_tokens)/g, "a.$1")}), 0) AS avgContext
       FROM sessions s LEFT JOIN api_calls a ON a.session_id = s.id
       GROUP BY s.id ORDER BY usd DESC LIMIT ?`,
    )
    .all(limit) as unknown as SessionSpend[];
}

/** Where the money went. All amounts are API-equivalent USD from `store.prices`. */
export function spend(store: Store, options: { top?: number; days?: number } = {}): Spend {
  const top = options.top ?? 10;
  const days = options.days ?? 14;
  const db = store.db;
  const part = (p: string) => `COALESCE(SUM(ap_cost_part('${p}', ${COST_ARGS})), 0)`;

  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(${costOf()}), 0) AS usd,
         ${part("input")} AS inputUsd, ${part("output")} AS outputUsd,
         ${part("cache_read")} AS cacheReadUsd, ${part("cache_write")} AS cacheWriteUsd,
         COALESCE(SUM(ap_cost(model, ${PROMPT_TOKENS}, output_tokens, 0, 0, 0)), 0)
           AS withoutCacheUsd,
         COUNT(*) AS calls,
         (SELECT COUNT(*) FROM turns) AS prompts
       FROM api_calls`,
    )
    .get() as unknown as SpendTotals;

  const byProject = db
    .prepare(
      `SELECT COALESCE(s.project_path, '(unknown)') AS project, COUNT(DISTINCT s.id) AS sessions,
         (SELECT COUNT(*) FROM turns t JOIN sessions s2 ON s2.id = t.session_id
           WHERE COALESCE(s2.project_path, '(unknown)') = COALESCE(s.project_path, '(unknown)'))
           AS prompts,
         COALESCE(SUM(${costOf("a")}), 0) AS usd
       FROM sessions s LEFT JOIN api_calls a ON a.session_id = s.id
       GROUP BY project ORDER BY usd DESC`,
    )
    .all() as unknown as Spend["byProject"];

  const byModel = (
    db
      .prepare(
        `SELECT model, COUNT(*) AS calls, SUM(${costOf()}) AS usd, ap_known_model(model) AS known
         FROM api_calls GROUP BY model ORDER BY usd DESC`,
      )
      .all() as { model: string; calls: number; usd: number; known: number }[]
  ).map((m) => ({ ...m, known: m.known === 1 }));

  const byDay = (
    db
      .prepare(
        `SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS day,
           SUM(${costOf()}) AS usd, COUNT(*) AS calls
         FROM api_calls GROUP BY day ORDER BY day DESC LIMIT ?`,
      )
      .all(days) as Spend["byDay"]
  ).reverse();

  const topTurns = db
    .prepare(
      `SELECT t.id AS turnId, t.session_id AS sessionId, s.title, s.project_path AS project,
         t.idx AS "index", t.ts, COUNT(a.id) AS calls, SUM(${costOf("a")}) AS usd
       FROM turns t
       JOIN api_calls a ON a.turn_id = t.id
       JOIN sessions s ON s.id = t.session_id
       GROUP BY t.id ORDER BY usd DESC LIMIT ?`,
    )
    .all(top) as unknown as TurnSpend[];

  const byAgent = db
    .prepare(
      `SELECT COALESCE(s.project_path, '(unknown)') AS app, COALESCE(a.agent, '(main)') AS agent,
         COUNT(*) AS calls, SUM(${costOf("a")}) AS usd, AVG(a.duration_ms) AS avgMs,
         COALESCE(SUM(a.cache_read_tokens) * 1.0 / NULLIF(SUM(${PROMPT_TOKENS.replace(/(\w+_tokens)/g, "a.$1")}), 0), 0)
           AS cacheReadShare
       FROM api_calls a JOIN sessions s ON s.id = a.session_id
       WHERE s.entrypoint = 'sdk' OR a.agent IS NOT NULL
       GROUP BY 1, 2 ORDER BY usd DESC LIMIT ?`,
    )
    .all(top) as unknown as AgentSpend[];

  return {
    priceSource: store.prices.source,
    byAgent,
    totals,
    byProject,
    byModel,
    byDay,
    topSessions: sessionSpend(store, top),
    topTurns,
    priceChecks: priceCheck(store),
  };
}
