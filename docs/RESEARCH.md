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
