import type { Finding } from "../plugin.js";
import type { Store } from "../store/store.js";
import { sessionSpend, type SessionSpend } from "./spend.js";

/** Per-period metrics. Medians are per session, so a few huge sessions don't dominate. */
export interface PeriodMetrics {
  sessions: number;
  prompts: number;
  usd: number;
  activeDays: number;
  usdPerActiveDay: number;
  medianUsdPerSession: number;
  medianUsdPerPrompt: number;
  medianCallsPerPrompt: number;
  medianAvgContext: number;
  toolErrorRate: number;
  /** Estimated waste (capped per session at its cost) divided by spend. */
  wasteShare: number;
}

export interface Comparison {
  splitAt: number;
  splitLabel: string;
  before: PeriodMetrics;
  after: PeriodMetrics;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

function metrics(
  store: Store,
  sessions: SessionSpend[],
  wasteBySession: Map<string, number>,
): PeriodMetrics {
  const withPrompts = sessions.filter((s) => s.prompts > 0);
  const ids = sessions.map((s) => s.sessionId);
  const usd = sessions.reduce((t, s) => t + s.usd, 0);
  const waste = sessions.reduce(
    (t, s) => t + Math.min(wasteBySession.get(s.sessionId) ?? 0, s.usd),
    0,
  );

  let activeDays = 0;
  let errorRate = 0;
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(", ");
    activeDays = (
      store.db
        .prepare(
          `SELECT COUNT(DISTINCT strftime('%Y-%m-%d', ts / 1000, 'unixepoch')) AS n
           FROM api_calls WHERE session_id IN (${placeholders})`,
        )
        .get(...ids) as { n: number }
    ).n;
    const tools = store.db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(is_error = 1 AND denial IS NULL), 0) AS errors
         FROM tool_calls WHERE session_id IN (${placeholders})`,
      )
      .get(...ids) as { total: number; errors: number };
    errorRate = tools.total ? tools.errors / tools.total : 0;
  }

  return {
    sessions: sessions.length,
    prompts: sessions.reduce((t, s) => t + s.prompts, 0),
    usd,
    activeDays,
    usdPerActiveDay: activeDays ? usd / activeDays : 0,
    medianUsdPerSession: median(sessions.map((s) => s.usd)),
    medianUsdPerPrompt: median(withPrompts.map((s) => s.usd / s.prompts)),
    medianCallsPerPrompt: median(withPrompts.map((s) => s.calls / s.prompts)),
    medianAvgContext: median(sessions.filter((s) => s.calls > 0).map((s) => s.avgContext)),
    toolErrorRate: errorRate,
    wasteShare: usd ? waste / usd : 0,
  };
}

/**
 * Splits sessions by start time and compares the two periods. Pass the findings of all
 * detectors so the waste share can be compared too.
 */
export function compare(
  store: Store,
  splitAt: number,
  splitLabel: string,
  findings: Finding[],
): Comparison {
  const wasteBySession = new Map<string, number>();
  for (const f of findings) {
    wasteBySession.set(f.sessionId, (wasteBySession.get(f.sessionId) ?? 0) + f.wastedUsd);
  }
  const all = sessionSpend(store).filter((s) => s.startedAt !== null && s.calls > 0);
  return {
    splitAt,
    splitLabel,
    before: metrics(
      store,
      all.filter((s) => (s.startedAt ?? 0) < splitAt),
      wasteBySession,
    ),
    after: metrics(
      store,
      all.filter((s) => (s.startedAt ?? 0) >= splitAt),
      wasteBySession,
    ),
  };
}
