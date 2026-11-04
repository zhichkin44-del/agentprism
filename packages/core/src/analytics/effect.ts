import { costOf } from "../pricing/sql.js";
import type { Store } from "../store/store.js";

/**
 * Did a change make agent work cheaper? Method and evidence: docs/RESEARCH.md (R3).
 *
 * Unit: a turn (a prompt and the calls it caused); outcome: log cost of the turn. The regression
 * adjusts for what is known before the turn starts: log prompt size at its first call, model, who
 * started it (human or automation) and whether it is in the busiest project, plus a linear trend over
 * days, so steady drift is not mistaken for a change. The effect is the
 * coefficient of the "changed" indicator, reported as a relative change in cost per turn.
 *
 * Whole days are the unit of time. A day-level permutation gives the p-value, a day-level bootstrap
 * gives the interval, and the noise floor is the size of change that fake splits produce on this
 * user's own history. A per-session median comparison failed that placebo test badly (an apparent
 * change of ~13x where nothing changed), which is why this exists.
 */

export type Arm = "control" | "changed";

export interface EffectEstimate {
  /** Relative change in cost per turn, changed vs control (−0.2 = 20% cheaper). */
  effect: number;
  /** 95% interval of the same, from a day-level bootstrap. */
  interval: [number, number];
  /** Day-level permutation p-value (two-sided). */
  p: number;
  /** Changes smaller than this are within this history's own noise and drift. */
  noiseFloor: number;
  turns: Record<Arm, number>;
  days: Record<Arm, number>;
  verdict: "cheaper" | "costlier" | "no-clear-change" | "not-enough-data";
  /** Plain-language reasons behind a "not enough data" or "no clear change" verdict. */
  reasons: string[];
}

export interface EffectOptions {
  /** Permutation rounds and bootstrap resamples; lower in tests. */
  rounds?: number;
  /** Seed for the shuffles, so a report is reproducible. */
  seed?: number;
  /** Fake splits inside the control period add drift to the noise floor (before/after only). */
  placebo?: boolean;
}

interface TurnRow {
  day: string;
  y: number;
  x: number[];
}

export const MIN_DAYS = 3;
export const MIN_TURNS = 20;

/** Local calendar day of a timestamp, YYYY-MM-DD. */
export const dayOf = (ts: number) => new Date(ts).toLocaleDateString("sv-SE");

/** Turns with their adjusted covariates. */
export function turnRows(store: Store): TurnRow[] {
  const rows = store.db
    .prepare(
      `WITH c AS (
         SELECT turn_id, model, ${costOf()} AS usd,
           input_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens AS ctx,
           ROW_NUMBER() OVER (PARTITION BY turn_id ORDER BY ts) AS rn
         FROM api_calls WHERE turn_id IS NOT NULL)
       SELECT t.ts, t.origin, s.project_path AS project, SUM(c.usd) AS usd,
         MAX(CASE WHEN c.rn = 1 THEN c.ctx END) AS ctx0,
         MAX(CASE WHEN c.rn = 1 THEN c.model END) AS model
       FROM turns t JOIN c ON c.turn_id = t.id JOIN sessions s ON s.id = t.session_id
       GROUP BY t.id HAVING usd > 0`,
    )
    .all() as {
    ts: number;
    origin: string;
    project: string | null;
    usd: number;
    ctx0: number | null;
    model: string | null;
  }[];
  const count = new Map<string, number>();
  for (const r of rows) count.set(r.project ?? "", (count.get(r.project ?? "") ?? 0) + 1);
  const main = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
  return rows.map((r) => ({
    day: dayOf(r.ts),
    y: Math.log(r.usd),
    x: [
      1,
      Math.log(Math.max(1, r.ctx0 ?? 1)),
      r.model?.includes("sonnet") ? 1 : 0,
      r.model?.includes("haiku") ? 1 : 0,
      r.origin === "human" ? 0 : 1,
      r.project === main ? 1 : 0,
    ],
  }));
}

/**
 * Least-squares coefficient of the indicator. A tiny ridge term keeps the system solvable when a
 * covariate does not vary or repeats another (one model, one project); it does not move real estimates.
 */
function coefficient(turns: TurnRow[], changed: (day: string) => boolean): number {
  const k = (turns[0]?.x.length ?? 0) + 1;
  const A = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b = new Array<number>(k).fill(0);
  for (const t of turns) {
    const x = [...t.x, changed(t.day) ? 1 : 0];
    for (let i = 0; i < k; i++) {
      b[i] = (b[i] ?? 0) + (x[i] ?? 0) * t.y;
      const Ai = A[i] as number[];
      for (let j = 0; j < k; j++) Ai[j] = (Ai[j] ?? 0) + (x[i] ?? 0) * (x[j] ?? 0);
    }
  }
  const ridge = 1e-6 * Math.max(1, turns.length);
  for (let i = 1; i < k; i++) (A[i] as number[])[i] = ((A[i] as number[])[i] ?? 0) + ridge;
  // Gaussian elimination with partial pivoting.
  const at = (i: number, j: number) => (A[i] as number[])[j] ?? 0;
  for (let i = 0; i < k; i++) {
    let p = i;
    for (let r = i + 1; r < k; r++) if (Math.abs(at(r, i)) > Math.abs(at(p, i))) p = r;
    [A[i], A[p]] = [A[p] as number[], A[i] as number[]];
    [b[i], b[p]] = [b[p] ?? 0, b[i] ?? 0];
    if (Math.abs(at(i, i)) < 1e-12) continue;
    for (let r = i + 1; r < k; r++) {
      const f = at(r, i) / at(i, i);
      if (!f) continue;
      const Ar = A[r] as number[];
      for (let j = i; j < k; j++) Ar[j] = at(r, j) - f * at(i, j);
      b[r] = (b[r] ?? 0) - f * (b[i] ?? 0);
    }
  }
  const w = new Array<number>(k).fill(0);
  for (let i = k - 1; i >= 0; i--) {
    if (Math.abs(at(i, i)) < 1e-9) continue;
    let s = b[i] ?? 0;
    for (let j = i + 1; j < k; j++) s -= at(i, j) * (w[j] ?? 0);
    w[i] = s / at(i, i);
  }
  return w[k - 1] ?? 0;
}

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))] ?? 0;
};

/**
 * Estimates the effect for any assignment of days to arms (null = day not used).
 * `turns` defaults to every turn in the store.
 */
export function estimateEffect(
  store: Store,
  assign: (day: string) => Arm | null,
  options: EffectOptions = {},
  turns: TurnRow[] = turnRows(store),
): EffectEstimate {
  const rounds = options.rounds ?? 400;
  const rand = rng(options.seed ?? 7);
  // A linear trend over days separates a jump at the change from steady drift (an interrupted
  // time series); without it, drift alone passed as an effect in tests.
  const first = Math.min(...turns.map((t) => Date.parse(t.day)));
  const used = turns
    .filter((t) => assign(t.day) !== null)
    .map((t) => ({ ...t, x: [...t.x, (Date.parse(t.day) - first) / 86_400_000] }));
  const dayArm = new Map<string, Arm>();
  for (const t of used) dayArm.set(t.day, assign(t.day) as Arm);
  const days = { control: 0, changed: 0 };
  for (const a of dayArm.values()) days[a]++;
  const turnsBy = { control: 0, changed: 0 };
  for (const t of used) turnsBy[dayArm.get(t.day) as Arm]++;

  const reasons: string[] = [];
  if (days.control < MIN_DAYS || days.changed < MIN_DAYS)
    reasons.push(
      `at least ${MIN_DAYS} active days on each side are needed (have ${days.control} and ${days.changed})`,
    );
  if (turnsBy.control < MIN_TURNS || turnsBy.changed < MIN_TURNS)
    reasons.push(
      `at least ${MIN_TURNS} prompts on each side are needed (have ${turnsBy.control} and ${turnsBy.changed})`,
    );
  const empty: EffectEstimate = {
    effect: 0,
    interval: [0, 0],
    p: 1,
    noiseFloor: 0,
    turns: turnsBy,
    days,
    verdict: "not-enough-data",
    reasons,
  };
  if (reasons.length) return empty;

  const isChanged = (day: string) => dayArm.get(day) === "changed";
  const tau = coefficient(used, isChanged);

  // Permutation of whole days between the arms.
  const allDays = [...dayArm.keys()];
  const permuted: number[] = [];
  for (let r = 0; r < rounds; r++) {
    const shuffled = [...allDays];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j] as string, shuffled[i] as string];
    }
    const fake = new Set(shuffled.slice(0, days.changed));
    permuted.push(Math.abs(coefficient(used, (d) => fake.has(d))));
  }
  const p = (permuted.filter((v) => v >= Math.abs(tau) - 1e-12).length + 1) / (rounds + 1);

  // Bootstrap of whole days within each arm.
  const byDay = new Map<string, TurnRow[]>();
  for (const t of used) (byDay.get(t.day) ?? byDay.set(t.day, []).get(t.day))?.push(t);
  const control = allDays.filter((d) => !isChanged(d));
  const changed = allDays.filter(isChanged);
  const boot: number[] = [];
  for (let r = 0; r < rounds; r++) {
    const sample: TurnRow[] = [];
    const mark = new Set<string>();
    for (const [arm, pool] of [
      ["control", control],
      ["changed", changed],
    ] as const) {
      for (let i = 0; i < pool.length; i++) {
        const d = pool[Math.floor(rand() * pool.length)] as string;
        const key = `${arm}:${i}`;
        if (arm === "changed") mark.add(key);
        for (const t of byDay.get(d) ?? []) sample.push({ ...t, day: key });
      }
    }
    boot.push(coefficient(sample, (d) => mark.has(d)));
  }

  // Noise floor: what day-shuffling produces, and (before/after) what fake splits inside the
  // control period produce, which also catches drift over time.
  let floor = quantile(permuted, 0.95);
  if (options.placebo) {
    const pre = [...control].sort();
    const fakes: number[] = [];
    for (let i = MIN_DAYS; i <= pre.length - MIN_DAYS; i++) {
      const later = new Set(pre.slice(i));
      fakes.push(
        Math.abs(
          coefficient(
            used.filter((t) => !isChanged(t.day)),
            (d) => later.has(d),
          ),
        ),
      );
    }
    if (fakes.length) floor = Math.max(floor, quantile(fakes, 0.9));
    else
      reasons.push(
        `no room for a placebo check inside the "before" period (needs ${2 * MIN_DAYS}+ days)`,
      );
  }

  const rel = (x: number) => Math.exp(x) - 1;
  const [lo, hi] = [quantile(boot, 0.025), quantile(boot, 0.975)];
  const excludesZero = lo > 0 || hi < 0;
  const significant = p < 0.05 && Math.abs(tau) > floor && excludesZero;
  if (!significant) {
    if (p >= 0.05) reasons.push(`a change this size happens by chance (p = ${p.toFixed(2)})`);
    if (Math.abs(tau) <= floor)
      reasons.push(`it is within this history's own noise (±${(100 * rel(floor)).toFixed(0)}%)`);
    if (!excludesZero) reasons.push("the interval includes no change at all");
  }
  return {
    effect: rel(tau),
    interval: [rel(lo), rel(hi)],
    p,
    noiseFloor: rel(floor),
    turns: turnsBy,
    days,
    verdict: significant ? (tau < 0 ? "cheaper" : "costlier") : "no-clear-change",
    reasons,
  };
}

/** Before/after a moment in time. */
export function beforeAfterEffect(store: Store, splitAt: number, options: EffectOptions = {}) {
  const split = dayOf(splitAt);
  // The day of the change itself is mixed, so it is left out.
  return estimateEffect(store, (d) => (d < split ? "control" : d > split ? "changed" : null), {
    placebo: true,
    ...options,
  });
}

/** A switchback schedule: which days have the change on, decided in advance at random. */
export interface Switchback {
  kind: "switchback";
  start: string;
  on: string[];
  off: string[];
}

/**
 * Random switchback schedule for `days` consecutive days from `start`: each pair of days gets one
 * "on" and one "off" in random order, so the arms stay balanced and drift cancels out.
 */
export function switchbackSchedule(start: number, days: number, seed = Date.now()): Switchback {
  const rand = rng(seed % 2 ** 31);
  const list: string[] = [];
  const d = new Date(start);
  d.setHours(12, 0, 0, 0);
  for (let i = 0; i < days; i++) {
    list.push(dayOf(d.getTime()));
    d.setDate(d.getDate() + 1);
  }
  const on: string[] = [],
    off: string[] = [];
  for (let i = 0; i < list.length; i += 2) {
    const pair = list.slice(i, i + 2);
    const first = rand() < 0.5;
    pair.forEach((day, j) => ((j === 0) === first ? on : off).push(day));
  }
  return { kind: "switchback", start: list[0] ?? dayOf(start), on, off };
}

export function switchbackEffect(store: Store, s: Switchback, options: EffectOptions = {}) {
  const on = new Set(s.on),
    off = new Set(s.off);
  return estimateEffect(
    store,
    (d) => (on.has(d) ? "changed" : off.has(d) ? "control" : null),
    options,
  );
}
