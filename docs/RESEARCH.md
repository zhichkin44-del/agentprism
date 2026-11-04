# Research program

Started 2026-11-04. The direction is a technology nobody has, built on mathematics and algorithms. More
reports and counters are not the goal. Papers were opened and checked on 2026-11-04; most numbers come from
abstracts. A 2026 arXiv id may not be peer reviewed yet.

## What our data allows

Per model call we have exact tokens (input, output, cache read, cache write 5m / 1h), timestamps, and
idle gaps. We also have compactions and every tool call with its input and result hash. The full request
shape is logged too: the system prompt, every tool definition, cache breakpoints and TTLs, and message
blobs by hash (`LOG_FORMAT.md`). We have the git history of the repositories the agents worked in. Limits:
one user, 12 days, about 10K calls on this machine. A second machine holds about 400 MB more.

## What the literature leaves open

| Problem                                                                            | Evidence it is open                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cutting tokens ≠ cutting the bill.** With prompt caching, pruning can raise cost | In Claude Code, 38.4% fewer tool-output tokens gave a 6.8% higher bill. Token cut vs cost cut: r = 0.15 ([2607.12161], 2026-07)                                                                                                                                                                                                                                                                                                                   |
| **No cache-aware policy for when to compact or reset**                             | Compaction work optimizes tokens or accuracy: observation masking halves cost ([2508.21433], 2025-08); ACON −26–54% peak tokens ([2510.00615], 2025-10); CompactionRL learns summaries but has no trigger rule ([2607.05378], 2026-07). A rate–distortion framing exists, but it notes that repeated compaction is rarely measured ([2607.08032], 2026-07). The only cache-priced optimum we found is a blog with one user ([LangWatch], 2026-08) |
| **The price of forgetting is unmeasured**                                          | After compression, completion stays flat but retrieval calls triple ([2608.16370], 2026-08). Nobody measures the rework that follows a real compaction                                                                                                                                                                                                                                                                                            |
| **No cache-priced measure of "dead" context**                                      | Trajectories hold useless, redundant and expired content; removing it cuts 40–60% of tokens ([2509.23586], 2025-09); a skimmer cuts 23–54% ([2601.16746], 2026-01). Attribution methods work only for QA with open models ([2411.15102])                                                                                                                                                                                                          |
| **No causal before/after on field logs**                                           | Context-file studies disagree: +20% cost and no gain ([2602.11988], 2026-02) vs −28.6% runtime ([2601.20404], 2026-01). Single-run noise is 2–6 points ([2602.07150], 2026-02). We found no CUPED, synthetic-control or DiD work at session level for agents                                                                                                                                                                                      |
| **No validated label-free quality score**                                          | In 18k real sessions users push back in 50% of turns, and 59% of agent code survives into commits. Neither is calibrated as a quality measure ([2604.20779], 2026-04). Failure taxonomies need manual labels ([2503.13657], 2025-03)                                                                                                                                                                                                              |
| **Cost forecasting is weak on real sessions**                                      | Models' own predictions of their token use correlate with actuals at ≤ 0.39 ([2604.22750], 2026-04). TokenCast improves MAE, but only on benchmarks ([2609.35760], 2026-09)                                                                                                                                                                                                                                                                       |

## Candidates for "a technology nobody has"

### C1. Cache-aware context controller with a provable bound

- **Idea.** Treat "compact, reset, keep warm or carry on" as an online decision under cache prices. If
  the context grows by g per step, a compaction costs C (summary call + rewrite + rework ρ). If c_r is the
  cache-read price, the cycle is EOQ-like: N* ≈ √(2C / (c_r·g)). The remaining session length is unknown,
  which makes it ski-rental: compact when the accumulated excess read cost reaches C. That rule is
  2-competitive deterministically and e/(e−1) randomized. A predicted horizon makes it learning-augmented.
  An idle gap is a second ski-rental, between a 1-hour TTL and keep-alive pings and a rebuild.
- **Why nobody has it.** The literature optimizes tokens, not the cache-priced bill ([2607.12161]), and has
  no trigger rule. The blog curve is offline and fitted to one user.
- **How to prove it.** For a recorded session the offline optimum is computable exactly: dynamic
  programming over compaction points, using measured g, measured post-compaction size, and measured rework.
  We then report each online policy's empirical competitive ratio against that optimum on real logs,
  alongside the theorem.
- **Risk.** The rework and quality term ρ dominates. The owner keeps long context on purpose, so the
  controller must be memory-first: decide _what_ to keep, not only _when_ to cut (see C2).
- **Testable now:** yes, from tokens per call, compactions and gaps.

### C2. Context value accounting (cache-priced dead weight)

- **Idea.** Every block of context b (tool result, file read, message) has a carrying cost
  r_b = c_r · s_b · m_b, where m_b is the number of later calls that re-read it. It has a value u_b,
  estimated from observable reuse: later tool inputs and edits that reference its file, symbols or
  identifiers, and overlap with later outputs. Choosing what to drop is a knapsack / rate–distortion
  problem: minimize carrying cost subject to bounded loss of value. A cache rule makes it non-trivial:
  dropping a block mid-history re-writes the whole suffix, so only boundary-aligned drops are cheap.
- **Why nobody has it.** Attribution needs model internals or open models. Pruning papers measure tokens.
  Nobody reports the share of the _bill_ spent carrying content that is never used again.
- **How to prove it.** Measure the dead-weight share on our logs. Validate the reuse-based value against
  leave-one-out replay on a small sample, then check that drops it picks do not raise rework.
- **Risk.** Reuse is a proxy for use. Replay costs API money (a small, budgeted sample).
- **Testable now:** yes. Message blobs, tool inputs and results are all in the logs. This is the basis
  of a memory system: what goes to memory, what is dropped, what stays.

### C3. Causal before/after for agent workflows

- **Idea.** Turn `mark` / `compare` into an estimator. Use cost per comparable unit of work, a CUPED
  adjustment by the pre-period, synthetic control built from projects and sessions not exposed to the
  change, and pre-trend and placebo checks. Report an effect with a confidence interval and the minimum
  detectable effect: "you need N more sessions to see a 10% change".
- **Why nobody has it.** No session-level causal method for coding agents turned up. The published
  studies are benchmark A/Bs that disagree with each other.
- **How to prove it.** Run placebo marks on our past logs: fake changes must show no effect at the
  nominal rate. Then check coverage on simulated effects injected into real data.
- **Risk.** A single user gives small samples. Task mix shifts over time.
- **Testable now:** yes, the placebo study needs no new data.

### C4. Label-free quality index calibrated on git

- **Idea.** Combine signals already in the logs: edits overwritten or reverted within the session,
  interrupts and pushback, failing commands after edits, denials. Calibrate the combination against
  whether the code survives into commits (the git history is local). This yields cost per _useful_
  change, not cost per token.
- **Why nobody has it.** Survival and pushback are reported descriptively ([2604.20779]), but nobody has
  calibrated them into a score.
- **How to prove it.** Predict commit survival on held-out sessions (AUROC), then check stability
  across projects.
- **Risk.** The signals are noisy, and there is one author.
- **Testable now:** yes, with logs plus the Studio repositories.

### C5. Calibrated cost forecast for a task in flight

- **Idea.** Model the remaining cost as cache-priced: the context-growth path plus a hazard model for
  the remaining steps. Conformal intervals give guaranteed coverage. Output: "this task will cost $X, 90%
  interval [$a, $b]", early enough to change course.
- **Why nobody has it.** Benchmark-only forecasters exist ([2609.35760]); nobody offers coverage guarantees
  on real human-in-the-loop sessions.
- **Risk.** Least unique of the five. Small n.
- **Testable now:** partly.

## Order of work (each step ends with numbers on our logs)

| Step | Question                                                                                  | Output                                                                 | Estimate |
| ---- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------- |
| R1   | How much of the bill is spent carrying dead context? (C2 measurement)                     | dead-weight share by block type, cache-priced                          | 2–3 days |
| R2   | What is the offline-optimal context schedule, and how close are simple online rules? (C1) | DP optimum, competitive ratios, measured rework after real compactions | 2–3 days |
| R3   | Can a before/after be trusted at our sample size? (C3)                                    | placebo false-positive rate, minimum detectable effect                 | 1–2 days |
| R4   | Does a label-free index predict commit survival? (C4)                                     | AUROC on held-out sessions                                             | 2–3 days |

R1 and R2 together are the core candidate: a context engine that knows both the carrying cost and the
value of every piece of context, and decides what to keep, what to move to memory and when to cut, with a
bound. R3 is the proof machine for any later change. Nothing ships until a step shows a real effect.

## R1 result — dead context (2026-11-04)

Scripts: `research/r1-calibrate.mjs`, `research/r1-dead-context.mjs` (they read local logs and print
aggregates). Data: 98 main-chain sessions, 12 days. Prompt carrying cost is $707, against $121 of output.

**How it is measured.**

1. _Sizes._ The growth of the prompt between two calls is measured exactly from usage. It is split between
   the blocks that entered it, by weights fitted on 9,204 intervals (R² = 0.97): visible output 1.04 and
   thinking 1.02 tokens per token; tool results 0.45 and prompts 0.40 tokens per character; attachment
   records 0.004; images ~1,100 tokens. All 14.6M tokens of growth are allocated, so the ledger adds up
   to the real prompt cost ($709 vs $707).
2. _Carrying cost._ A block costs its size × the exact price per prompt token of every later call that
   carried it, until the next compaction.
3. _Use._ A block is used at call j if an output of j (or a user prompt just before it) shares at least k
   identifiers that occur in no more than D blocks of the session, or targets the same file. The dead part
   is the carrying after max(first read, last use): what an oracle memory could drop.
4. _Validation._ Every Edit proves a use: its `old_string` had to be in context. On 212 such pairs
   (Edit ← the Read result holding its text), the liberal rule (k=1, D=20) finds 98% of the uses from
   identifiers alone. The middle rule finds 74%, the strict one 30%.

**Result (liberal rule, the only one with validated recall).**

| Part of prompt cost                               | $   | Share |
| ------------------------------------------------- | --- | ----- |
| Always needed: system + tools, summaries, prompts | 204 | 29%   |
| Content, carried while still used                 | 288 | 41%   |
| Content, carried **after its last use**           | 148 | 21%   |
| Thinking from earlier calls (use not observable)  | 80  | 11%   |

- Thinking stays in the context and is re-read on every call. Logs keep only its token count, so its use
  cannot be checked.
- Dead content splits into $67 never referenced after the first read and $81 carried after a last use.
- By source, Bash commands and their outputs carry the most: $89 dead of $228. MCP tool results are dead
  65% of the time.
- Stricter rules report 61–66% dead. They miss most known uses, so those numbers are rejected.

**Where it can lie.**

- (a) Recall was validated only on verbatim uses (Edit from Read). Use of a Bash output by meaning, without
  repeating an identifier, is invisible, which overstates dead.
- (b) A spurious shared identifier understates dead.
- (c) The oracle ignores the cache. Dropping a block in mid-history forces a re-write of everything after
  it at write price, so only drops at a compaction or reset are cheap. The $148 is an upper bound on what
  any memory policy can save, not a forecast.
- (d) Rewinds and branches in a session are not followed.

The definitive check needs replay: drop the block, re-ask the model and see whether the output changes.
That sends log content to the API, so it waits for the owner's decision.

[2607.12161]: https://arxiv.org/abs/2607.12161
[2508.21433]: https://arxiv.org/abs/2508.21433
[2510.00615]: https://arxiv.org/abs/2510.00615
[2607.05378]: https://arxiv.org/abs/2607.05378
[2607.08032]: https://arxiv.org/abs/2607.08032
[2608.16370]: https://arxiv.org/abs/2608.16370
[2509.23586]: https://arxiv.org/abs/2509.23586
[2601.16746]: https://arxiv.org/abs/2601.16746
[2411.15102]: https://arxiv.org/abs/2411.15102
[2602.11988]: https://arxiv.org/abs/2602.11988
[2601.20404]: https://arxiv.org/abs/2601.20404
[2602.07150]: https://arxiv.org/abs/2602.07150
[2604.20779]: https://arxiv.org/abs/2604.20779
[2503.13657]: https://arxiv.org/abs/2503.13657
[2604.22750]: https://arxiv.org/abs/2604.22750
[2609.35760]: https://arxiv.org/abs/2609.35760
[LangWatch]: https://langwatch.ai/blog/context-tax-when-to-compact

## R2 result — when to compact (2026-11-04)

Script: `research/r2-compaction.mjs`. Same data. The main chain cost $830 as recorded, which already
includes the owner's 15 compactions, most of them manual.

**How it is measured.**

- _Replay._ A simulated compaction runs right after a call, while the cache is warm. It costs:
  - reading the context once;
  - a 20K-token summary (observed `postTokens` were 17–26K);
  - re-writing the new prefix instead of reading it (P = 96K, the median first prompt after the 15 real
    compactions);
  - rework ρ.

  Every later call then carries (old context − P) fewer tokens: first fewer cache reads, then fewer
  writes, so rebuilds after breaks shrink too. Real compactions stay where they were.

- _Optimum._ The offline optimum is exact dynamic programming over compaction points, O(n²) per
  segment.
- _Online rules._ They see only the past.
- _Ski-rental._ After each call, add (context − P) × read price to a running "excess". Compact when
  the excess reaches the cost of one compaction (ρ included). In the simple model with linear growth
  this rule is at most 2× the optimum. The question is how it behaves on real sessions.

**Rework measured on the 15 real compactions.** It counts re-reads of files and re-runs of Bash commands
the agent already had: 0.011 per call in the 60 calls before a compaction and 0.010 after. That is no
measurable rework. The proxy sees only re-fetching, though, not lost quality, and 15 compactions are few.
So ρ is swept.

| Rework per compaction | Optimum | Recorded | Threshold 200K | Ski-rental | Ski-rental assuming ρ = 0 |
| --------------------- | ------- | -------- | -------------- | ---------- | ------------------------- |
| $0                    | $551    | 1.51×    | 1.04×          | 1.04×      | 1.04×                     |
| $2                    | $633    | 1.31×    | 1.21×          | 1.05×      | 1.14×                     |
| $5                    | $703    | 1.18×    | 1.50×          | 1.07×      | 1.35×                     |
| $10                   | $772    | 1.08×    | 2.00×          | 1.04×      | 1.71×                     |
| $20                   | $830    | 1.00×    | 3.03×          | 1.16×      | 2.49×                     |

The ratio columns are cost ÷ optimum. In the worst single segment ski-rental reaches 1.19–1.51× and
the 200K threshold up to 10×.

**What it says.**

1. **The ski-rental rule is robust.** It stays within 4–16% of the exact optimum across the whole range,
   with no tuning. It adapts on its own, from 75 compactions down to 10. Fixed thresholds are good for
   one value of ρ and fail badly for others.
2. **Long context pays off only if forgetting is expensive.** Against the optimum, the recorded schedule
   costs 51% more if compaction loses nothing, 18% more at $5 per compaction, and nothing at about $20.
   So the owner's choice is right exactly when a compaction destroys more than ~$20 of work or quality.
3. **The rule is only as good as its estimate of ρ.** Assume ρ = 0 when it is really $10–20, and it
   loses 1.7–2.5×. The price of forgetting is the missing measurement. Re-reads show ~0, and nobody
   measures lost quality ([2608.16370] sees retrieval calls triple). This is where R1 meets R2. A memory
   that keeps the blocks still in use (R1: 41% of the prompt cost is content still used) lowers ρ, and a
   lower ρ makes compaction cheap.

**Where it can lie.**

- (a) Rework and quality are not measured beyond re-fetching. That is why the result is a table over ρ,
  not one number.
- (b) P is fixed at the median 96K.
- (c) The summary call is estimated, not logged.
- (d) After a simulated compaction, growth is assumed to follow the recorded calls. In reality the
  conversation would diverge.
- (e) Latency and the user's time are ignored.

## Q1 result — the price of forgetting, measured by quality (2026-11-04)

Scripts: `research/q1-forgetting.mjs` and `research/q1-review-sample.mjs`. The dataset format is in
`CORRECTIONS_FORMAT.md`; the dataset itself stays local.

**How it is measured.** There are 801 owner messages; messages from other sessions, notifications and
command output are excluded. Each one is paired with the agent turn before it. A message is classified
as a correction by cues in Russian and English, in two variants:

- _broad_: any cue anywhere in the message;
- _strict_: the cue sits in the first 160 characters, and generic "не нужно / don't / stop" do not count.

Then the correction rates of the 10 owner messages before and after each compaction are compared, 28
compaction points in all (overlapping windows counted once). Rates are also compared by prompt size.

| Measure                                            | Broad                | Strict                 |
| -------------------------------------------------- | -------------------- | ---------------------- |
| Corrections among owner messages                   | 14.5% (116)          | 3.0% (24)              |
| Before → after a compaction                        | 11.4% → 13.9%        | 0.9% → 3.2%            |
| Difference, 95% CI                                 | [−5.4, +10.5] points | [−0.9, +5.5] points    |
| "You forgot" cues before → after                   | 0 → 3                |                        |
| By prompt size <100K / 100–300K / 300–600K / >600K | 30 / 19 / 16 / 12%   | 2.5 / 5.5 / 3.0 / 2.3% |

The mean cost of a corrected agent turn is $0.74 (median $0.16).

**What it says.**

1. **Compaction may raise corrections a little.** Both variants and the "you forgot" cues point the same
   way, but no interval excludes zero. The upper bound is about +1 correction per compaction. In tokens
   that is ρ ≈ $0.2 (point) to $0.8 (upper bound) per compaction. That is far below the ~$20 at which,
   per R2, a long context pays for itself.
2. **No sign that very long context causes more corrections.** The rate does not rise with prompt size.
   Under the broad variant it even falls, most likely because long sessions are orchestration sessions
   with a different style of message.
3. **The real trade-off is the owner's attention, not tokens.** At ρ ≈ $0.5 the ski-rental rule makes
   about 58 compactions in 12 days. It saves ~$250 API-equivalent at the cost of about 15 extra owner
   corrections (upper bound ~60). Whether that is worth it is the owner's call; the measurement makes the
   price visible.

**Where it can lie.**

- (a) The classifier is not validated. Broad and strict differ 5×, and structural signals are too rare to
  check it (2 interrupts, 0 denials with feedback, 3 exact undos). The labeling sheet (60 pairs, local)
  closes this once the owner marks it.
- (b) There are only 28 compaction points, and some are prompt drops from resumed sessions, not
  `/compact`.
- (c) A correction 5 messages after a compaction may be unrelated to it.
- (d) A correction's cost in owner time is not measured.

## R4 result — can logs predict whether code survives? (2026-11-04)

Script: `research/r4-survival.mjs`. Of 2,290 agent edits, 682 were outside git (notes, scratch files)
and 32 failed or were denied. That leaves 1,566 edits in 22 sessions, in 14 Studio repositories.

**How it is measured.**

- _An edit survives_ if at least half of its significant lines (trimmed, ≥ 12 characters) are in the
  first later commit that touches the file (any branch).
- _Durability:_ the same test against the current HEAD, for the 907 edits older than two days.
- _Signals from logs:_
  - exact undo;
  - re-editing the same lines in the session;
  - a failed shell command within the next 5 tool calls;
  - the owner's next message is a correction (Q1, broad and strict);
  - an interrupt;
  - prompt size;
  - subagent or main agent;
  - Write or Edit.
- _Scoring:_ AUROC of each signal and of a logistic model, with whole sessions held out (5 folds) and a
  session-level bootstrap.

| Outcome                      | Base rate | Best single signal                    | Combined model, held-out sessions |
| ---------------------------- | --------- | ------------------------------------- | --------------------------------- |
| In the next commit           | 91.5%     | none above 0.51 in the risk direction | 0.72, CI [0.55, 0.78]             |
| Still in HEAD after ≥ 2 days | 71.3%     | none above 0.52                       | 0.54–0.57, CI lower bound ≈ 0.51  |

**What it says.**

- **A negative result.** No quality signal in the logs predicts whether code lasts. That covers owner
  corrections, failed commands, interrupts and undo. The combined "next commit" score owes its 0.72 to
  structure, not quality: new files written whole almost always survive, and edits in long sessions survive
  slightly more. Edits followed by an owner correction survive at least as often as others.
- **Why.** Studio agents commit their own work right away, so "in the next commit" is nearly automatic.
  Code that dies later dies mostly because the product moves on, not because it was a mistake.
- **C4 is not supported on this data.** Commit survival is not a usable quality label here, and the cheap
  signals are not a quality index. The owner's labels from Q1 are the better route to a quality measure.

**Where it can lie.**

- (a) There are only 18–22 sessions, dominated by a few long ones, so intervals are wide.
- (b) Some signals are almost absent (0 interrupts, 1 exact undo, 15 strict corrections).
- (c) Line matching misses survival under reformatting.
- (d) Survival mixes mistakes with normal evolution, and these logs cannot separate the two.

## R3 result — can a before/after comparison be trusted? (2026-11-04)

Scripts: `research/r3-placebo.mts` (the shipped `compare`) and `research/r3-adjusted.mts` (a fix). Run
them with `npx tsx <script> <db>`. Data: 99 sessions, 1,005 turns, 12 days.

**How it is measured.** The logs contain no deliberate change, so every split point is a fake "mark": a
placebo. Anything a comparison reports at a fake mark is noise plus the natural drift of the work, and
that is the floor a real change must beat. A trustworthy test flags about 5% of fake marks. Power is
measured by injecting a known effect: the "after" side is made 10–50% cheaper.

| Method                                                                 | Apparent change at fake marks | Test flags fake marks          | Detects an injected 50% saving      |
| ---------------------------------------------------------------------- | ----------------------------- | ------------------------------ | ----------------------------------- |
| Shipped `compare`: median cost per prompt by session                   | median ~13×, up to 230×       | 16 of 30 (session permutation) | no better than the false-alarm rate |
| Turns, adjusted for prompt size, model, origin, project; days permuted | −7% to −35%                   | 1 of 9                         | p ≈ 0.08 (not significant)          |

**What it says.**

1. **The shipped `compare` must not be trusted on a mixed history.** Short automated crew sessions and
   long interactive ones shift in proportion over time. The median per session then swings by an order
   of magnitude with no change at all, and a permutation test that assumes exchangeable sessions raises
   false alarms half the time.
2. **Adjusting for what is known before a turn removes most of the mix effect.** Those covariates are
   prompt size at the start, model, who started it, and project. Testing by whole days then gives about
   the right false-alarm rate. The natural drift stays at 20–35% over 12 days: the work itself got
   cheaper per turn.
3. **Twelve days cannot prove a change.** Even a true 50% saving does not reach significance with 12
   days of day-level variation. A before/after on one person's logs needs weeks, or a better design.
4. **The better design is a switchback.** Turn the change on and off on alternate days (or half-days) at
   random, then compare on-days with off-days with the adjusted estimator. Randomizing in time cancels
   drift, which is exactly what sank the placebo test. This is standard for marketplaces; we found no use
   of it for coding agents.

**Where it can lie.** (a) 9–30 fake marks on one history are not independent. (b) Twelve days give a
coarse day-permutation distribution (p cannot go much below 0.003 and is noisy). (c) The covariates do
not capture the kind of task. (d) The injected effect is uniform; real changes hit some turns more than
others.

**Consequence for the product.** `compare` should use the adjusted turn-level estimator, report an
interval and the noise floor, say when the data cannot support a conclusion, and offer a switchback
schedule for a change the user wants to prove.
