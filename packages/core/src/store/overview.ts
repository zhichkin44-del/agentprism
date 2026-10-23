import type { Store } from "./store.js";

export interface TokenTotals {
  input: number;
  output: number;
  thinking: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface Overview {
  sessions: number;
  projects: number;
  turns: number;
  apiCalls: number;
  subagentCalls: number;
  toolCalls: number;
  toolErrors: number;
  toolDenials: number;
  compactions: number;
  interrupts: number;
  firstAt: number | null;
  lastAt: number | null;
  tokens: TokenTotals;
  reportedCostUsd: number;
  byModel: { model: string; calls: number; tokens: number }[];
  byProject: { project: string; sessions: number; tokens: number }[];
  topTools: { name: string; calls: number; errors: number }[];
}

const TOKEN_SUM = `input_tokens + output_tokens + cache_read_tokens
  + cache_write_5m_tokens + cache_write_1h_tokens`;

/** One-screen summary of everything in the store. */
export function overview(store: Store): Overview {
  const one = <T>(sql: string): T => store.db.prepare(sql).get() as T;
  const all = <T>(sql: string): T[] => store.db.prepare(sql).all() as T[];

  const counts = one<{
    sessions: number;
    projects: number;
    turns: number;
    firstAt: number | null;
    lastAt: number | null;
    reportedCostUsd: number | null;
  }>(`SELECT
        (SELECT COUNT(*) FROM sessions) AS sessions,
        (SELECT COUNT(DISTINCT project_path) FROM sessions) AS projects,
        (SELECT COUNT(*) FROM turns) AS turns,
        (SELECT MIN(started_at) FROM sessions) AS firstAt,
        (SELECT MAX(ended_at) FROM sessions) AS lastAt,
        (SELECT SUM(reported_cost_usd) FROM sessions) AS reportedCostUsd`);

  const calls = one<{
    apiCalls: number;
    subagentCalls: number;
    input: number;
    output: number;
    thinking: number;
    cacheRead: number;
    cacheWrite: number;
  }>(`SELECT COUNT(*) AS apiCalls,
        COUNT(subagent_id) AS subagentCalls,
        COALESCE(SUM(input_tokens), 0) AS input,
        COALESCE(SUM(output_tokens), 0) AS output,
        COALESCE(SUM(thinking_tokens), 0) AS thinking,
        COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
        COALESCE(SUM(cache_write_5m_tokens + cache_write_1h_tokens), 0) AS cacheWrite
      FROM api_calls`);

  const tools = one<{ toolCalls: number; toolErrors: number; toolDenials: number }>(
    `SELECT COUNT(*) AS toolCalls,
       COALESCE(SUM(is_error), 0) AS toolErrors,
       COUNT(denial) AS toolDenials
     FROM tool_calls`,
  );

  const markers = one<{ compactions: number; interrupts: number }>(
    `SELECT COALESCE(SUM(type = 'compaction'), 0) AS compactions,
       COALESCE(SUM(type = 'interrupt'), 0) AS interrupts
     FROM markers`,
  );

  return {
    sessions: counts.sessions,
    projects: counts.projects,
    turns: counts.turns,
    firstAt: counts.firstAt,
    lastAt: counts.lastAt,
    reportedCostUsd: counts.reportedCostUsd ?? 0,
    apiCalls: calls.apiCalls,
    subagentCalls: calls.subagentCalls,
    ...tools,
    ...markers,
    tokens: {
      input: calls.input,
      output: calls.output,
      thinking: calls.thinking,
      cacheRead: calls.cacheRead,
      cacheWrite: calls.cacheWrite,
      total: calls.input + calls.output + calls.cacheRead + calls.cacheWrite,
    },
    byModel: all(
      `SELECT model, COUNT(*) AS calls, SUM(${TOKEN_SUM}) AS tokens
       FROM api_calls GROUP BY model ORDER BY tokens DESC`,
    ),
    byProject: all(
      `SELECT COALESCE(s.project_path, '(unknown)') AS project,
         COUNT(DISTINCT s.id) AS sessions, COALESCE(SUM(${TOKEN_SUM}), 0) AS tokens
       FROM sessions s LEFT JOIN api_calls a ON a.session_id = s.id
       GROUP BY project ORDER BY tokens DESC`,
    ),
    topTools: all(
      `SELECT name, COUNT(*) AS calls, COALESCE(SUM(is_error), 0) AS errors
       FROM tool_calls GROUP BY name ORDER BY calls DESC LIMIT 10`,
    ),
  };
}
