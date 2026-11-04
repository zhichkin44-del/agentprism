// R3, part 2: a before/after estimator that survives the placebo test.
//
// Unit: a turn (one prompt and the calls it caused). Outcome: log cost of the turn. Adjusted for what
// is known before the turn starts: log prompt size at its first call, the model, who started it
// (human or a task notification) and whether the project is the main one. The effect of a split is the
// coefficient of an "after" indicator in that regression (OLS).
//
// Significance: whole days are the unit of time, so a test permutes which days count as "after"
// (keeping their number). Placebo: fake splits at every day boundary; a trustworthy test flags about
// 5% of them. Power: injected effects. Run: npx tsx research/r3-adjusted.mts <db>. Aggregates only.
import { Store } from "../packages/core/src/index.ts";
import { costOf } from "../packages/core/src/pricing/sql.ts";

const db = process.argv[2];
// Reproducible runs: ignore everything after AGENTPRISM_UNTIL (ISO time), as the .mjs scripts do.
const UNTIL = process.env.AGENTPRISM_UNTIL
  ? Date.parse(process.env.AGENTPRISM_UNTIL)
  : Number.MAX_SAFE_INTEGER;
if (!db) throw new Error("usage: tsx research/r3-adjusted.mts <db>");
const store = Store.open(db);
type Turn = { day: string; y: number; x: number[] };
const rows = store.db
  .prepare(
    `SELECT t.ts, t.origin, s.project_path AS project,
       SUM(${costOf("a")}) AS usd,
       (SELECT a2.input_tokens + a2.cache_read_tokens + a2.cache_write_5m_tokens + a2.cache_write_1h_tokens
          FROM api_calls a2 WHERE a2.turn_id = t.id ORDER BY a2.ts LIMIT 1) AS ctx0,
       (SELECT a3.model FROM api_calls a3 WHERE a3.turn_id = t.id ORDER BY a3.ts LIMIT 1) AS model
     FROM turns t JOIN api_calls a ON a.turn_id = t.id JOIN sessions s ON s.id = t.session_id
     WHERE t.ts <= ${UNTIL}
     GROUP BY t.id HAVING usd > 0`,
  )
  .all() as {
  ts: number;
  origin: string;
  project: string | null;
  usd: number;
  ctx0: number;
  model: string;
}[];
const mainProject = (() => {
  const n = new Map<string, number>();
  for (const r of rows) n.set(r.project ?? "", (n.get(r.project ?? "") ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0];
})();
const turns: Turn[] = rows.map((r) => ({
  day: new Date(r.ts).toISOString().slice(0, 10),
  y: Math.log(r.usd),
  x: [
    1,
    Math.log(Math.max(1, r.ctx0)),
    r.model.includes("sonnet") ? 1 : 0,
    r.model.includes("haiku") ? 1 : 0,
    r.origin === "human" ? 0 : 1,
    r.project === mainProject ? 1 : 0,
  ],
}));
const days = [...new Set(turns.map((t) => t.day))].sort();

/** OLS coefficient of the "after" indicator, given which days count as after. */
function effect(after: Set<string>, shift = 0): number {
  const X = turns.map((t) => [...t.x, after.has(t.day) ? 1 : 0]);
  const y = turns.map((t) => t.y + (after.has(t.day) ? shift : 0));
  const k = X[0]?.length ?? 0;
  const A = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) => X.reduce((s, x) => s + (x[i] ?? 0) * (x[j] ?? 0), 0)),
  );
  const b = Array.from({ length: k }, (_, i) =>
    X.reduce((s, x, n) => s + (x[i] ?? 0) * (y[n] ?? 0), 0),
  );
  for (let i = 0; i < k; i++) {
    let p = i;
    for (let r = i + 1; r < k; r++) if (Math.abs(A[r]![i]!) > Math.abs(A[p]![i]!)) p = r;
    [A[i], A[p]] = [A[p]!, A[i]!];
    [b[i], b[p]] = [b[p]!, b[i]!];
    if (Math.abs(A[i]![i]!) < 1e-12) continue;
    for (let r = i + 1; r < k; r++) {
      const f = A[r]![i]! / A[i]![i]!;
      for (let j = i; j < k; j++) A[r]![j]! -= f * A[i]![j]!;
      b[r]! -= f * b[i]!;
    }
  }
  const w = new Array(k).fill(0);
  for (let i = k - 1; i >= 0; i--) {
    let s = b[i]!;
    for (let j = i + 1; j < k; j++) s -= A[i]![j]! * w[j];
    w[i] = Math.abs(A[i]![i]!) < 1e-12 ? 0 : s / A[i]![i]!;
  }
  return w[k - 1];
}

let seed = 5;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
/** Day-permutation p-value for the effect of a contiguous split at day index d. */
function pValue(d: number, shift = 0): number {
  const observed = Math.abs(effect(new Set(days.slice(d)), shift));
  let extreme = 0;
  const rounds = 300;
  for (let r = 0; r < rounds; r++) {
    const shuffled = [...days].sort(() => rnd() - 0.5);
    const after = new Set(shuffled.slice(0, days.length - d));
    if (Math.abs(effect(after, shift)) >= observed - 1e-12) extreme++;
  }
  return (extreme + 1) / (rounds + 1);
}

const pct = (x: number) => (100 * (Math.exp(x) - 1)).toFixed(0) + "%";
console.log(
  `turns ${turns.length}, days ${days.length}, main project share ${((100 * turns.filter((t) => t.x[5]).length) / turns.length).toFixed(0)}%`,
);
const splitDays = days.map((_, i) => i).filter((i) => i >= 2 && i <= days.length - 2);
let fp = 0;
const effects: number[] = [];
for (const d of splitDays) {
  const e = effect(new Set(days.slice(d)));
  effects.push(Math.abs(e));
  const p = pValue(d);
  if (p < 0.05) fp++;
  console.log(
    `  fake split before day ${d + 1}/${days.length}: adjusted change ${pct(e)}, p = ${p.toFixed(2)}`,
  );
}
effects.sort((a, b) => a - b);
console.log(
  `placebo: median |change| ${pct(effects[Math.floor(effects.length / 2)] ?? 0)}, max ${pct(effects.at(-1) ?? 0)}; p<0.05 on ${fp}/${splitDays.length} fake splits`,
);
const mid = Math.floor(days.length / 2);
for (const delta of [0.2, 0.3, 0.5]) {
  const shift = Math.log(1 - delta);
  const p = pValue(mid, shift);
  console.log(
    `injected ${(100 * delta).toFixed(0)}% cheaper from day ${mid + 1}: estimated ${pct(effect(new Set(days.slice(mid)), shift))}, p = ${p.toFixed(2)}`,
  );
}
store.close();
