// R3: can a before/after comparison be trusted at our sample size?
//
// Placebo: the logs hold no deliberate change, so every split point is a fake "mark". We move a fake
// split across the history and record what `compare` (the shipped function) reports as the change in
// median cost per prompt and per session. Whatever it reports is noise plus the natural drift of the
// work: the noise floor a real change has to beat.
//
// Then we test a session-level permutation test (labels shuffled, group sizes kept) on the same fake
// splits. Its false-positive rate should be about 5% if it can be trusted. Finally we inject a known
// effect (after-sessions made δ cheaper) to measure the smallest effect it detects 80% of the time.
// Run: npx tsx research/r3-placebo.mts <db>. Prints aggregates only.
import { Store, compare, median, sessionSpend } from "../packages/core/src/index.ts";

const db = process.argv[2];
// Reproducible runs: ignore everything after AGENTPRISM_UNTIL (ISO time), as the .mjs scripts do.
const UNTIL = process.env.AGENTPRISM_UNTIL
  ? Date.parse(process.env.AGENTPRISM_UNTIL)
  : Number.MAX_SAFE_INTEGER;
if (!db) throw new Error("usage: tsx research/r3-placebo.mts <db>");
const store = Store.open(db);
const sessions = sessionSpend(store)
  .filter((s) => s.startedAt !== null && s.calls > 0 && s.prompts > 0)
  .filter((s) => (s.startedAt ?? 0) <= UNTIL)
  .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
const big = sessions.filter((s) => s.prompts >= 3);

let seed = 11;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const perPrompt = (s: (typeof sessions)[number], factor = 1) => (s.usd * factor) / s.prompts;
const rel = (b: number, a: number) => (b > 0 ? a / b - 1 : 0);

/** Two-sided permutation test on the ratio of medians of cost per prompt. */
function permutationP(before: number[], after: number[], rounds = 400): number {
  const observed = Math.abs(Math.log(median(after) / median(before)));
  const pool = [...before, ...after];
  let extreme = 0;
  for (let r = 0; r < rounds; r++) {
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [pool[i], pool[j]] = [pool[j] as number, pool[i] as number];
    }
    const b = pool.slice(0, before.length),
      a = pool.slice(before.length);
    if (Math.abs(Math.log(median(a) / median(b))) >= observed - 1e-12) extreme++;
  }
  return (extreme + 1) / (rounds + 1);
}

function study(name: string, pool: typeof sessions) {
  // Fake splits between the 20th and 80th percentile of session starts, so both sides have data.
  const starts = pool.map((s) => s.startedAt ?? 0);
  const splits: number[] = [];
  for (let q = 0.2; q <= 0.8 + 1e-9; q += 0.6 / 29)
    splits.push(starts[Math.floor(q * (starts.length - 1))] ?? 0);
  const effects: number[] = [],
    sessionEffects: number[] = [];
  let falsePositives = 0;
  for (const t of splits) {
    const before = pool.filter((s) => (s.startedAt ?? 0) < t),
      after = pool.filter((s) => (s.startedAt ?? 0) >= t);
    const b = before.map((s) => perPrompt(s)),
      a = after.map((s) => perPrompt(s));
    effects.push(rel(median(b), median(a)));
    sessionEffects.push(rel(median(before.map((s) => s.usd)), median(after.map((s) => s.usd))));
    if (permutationP(b, a) < 0.05) falsePositives++;
  }
  const abs = effects.map(Math.abs).sort((x, y) => x - y);
  const absS = sessionEffects.map(Math.abs).sort((x, y) => x - y);
  const q = (xs: number[], p: number) =>
    xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] ?? 0;
  const pct = (x: number) => (100 * x).toFixed(0) + "%";
  console.log(`\n${name}: ${pool.length} sessions, ${splits.length} fake splits`);
  console.log(
    `  apparent change in median cost per prompt: median ${pct(q(abs, 0.5))}, 90th pct ${pct(q(abs, 0.9))}, max ${pct(abs.at(-1) ?? 0)}`,
  );
  console.log(
    `  apparent change in median cost per session: median ${pct(q(absS, 0.5))}, 90th pct ${pct(q(absS, 0.9))}`,
  );
  console.log(
    `  permutation test p<0.05 on fake splits: ${falsePositives}/${splits.length} (should be ~5%)`,
  );

  // Power: make the after-sessions δ cheaper, at the middle split, and see how often p < 0.05.
  const mid = splits[Math.floor(splits.length / 2)] ?? 0;
  for (const delta of [0.1, 0.2, 0.3, 0.5]) {
    let hits = 0;
    const trials = 30;
    for (let k = 0; k < trials; k++) {
      // Different random halves of the history around the middle keep the trials apart.
      const jitter = splits[Math.floor(rnd() * splits.length)] ?? mid;
      const before = pool.filter((s) => (s.startedAt ?? 0) < jitter),
        after = pool.filter((s) => (s.startedAt ?? 0) >= jitter);
      const p = permutationP(
        before.map((s) => perPrompt(s)),
        after.map((s) => perPrompt(s, 1 - delta)),
        200,
      );
      if (p < 0.05) hits++;
    }
    console.log(`  injected ${pct(delta)} cheaper after the split: detected ${hits}/${trials}`);
  }
}

// The shipped function on one fake split, to make sure the numbers above are what users would see.
const t = sessions[Math.floor(sessions.length / 2)]?.startedAt ?? 0;
const c = compare(store, t, "placebo", []);
console.log(
  `compare() at the middle fake split: median $/prompt ${c.before.medianUsdPerPrompt.toFixed(3)} → ${c.after.medianUsdPerPrompt.toFixed(3)} (${((100 * c.after.medianUsdPerPrompt) / c.before.medianUsdPerPrompt - 100).toFixed(0)}%), sessions ${c.before.sessions} / ${c.after.sessions}`,
);

study("all sessions", sessions);
study("sessions with ≥ 3 prompts", big);
store.close();
